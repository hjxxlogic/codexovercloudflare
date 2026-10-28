"""Remote helper for deploy-agent.py; run over SSH stdin, never read Agent credentials."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import time


def execute(args):
    return subprocess.check_output(args, text=True, timeout=40).strip()


def service(action, name):
    return execute(['systemctl', '--user', action, name])


def status(binary, name):
    pid = int(execute(['systemctl', '--user', 'show', name, '--property=MainPID', '--value']))
    if not pid or service('is-active', name) != 'active':
        raise RuntimeError('Target Agent user service is not running')
    executable = pathlib.Path('/proc') / str(pid) / 'exe'
    running_path = os.readlink(executable)
    if running_path.endswith(' (deleted)'):
        running_path = running_path[:-10]
    if running_path != str(binary):
        raise RuntimeError('Service MainPID is not running the requested binary path')
    build = json.loads(execute([str(executable), '--version']))
    logs = execute(['journalctl', '--user', '-u', name, '_PID=' + str(pid),
                    '--since=-2 minutes', '--no-pager', '-o', 'cat'])
    metrics = None
    for line in logs.splitlines():
        try:
            value = json.loads(line)
            if value.get('event') == 'agent_metrics':
                metrics = value
        except (ValueError, AttributeError):
            pass
    idle = bool(metrics and 0 <= time.time() * 1000 - metrics['time'] < 90000 and
                all(metrics.get(key, -1) == 0 for key in
                    ['runtimes', 'archiveReaders', 'approvals', 'queuedCommands', 'fileRequests',
                     'fileQueueBytes', 'bufferedEvents', 'storageIngressBytes', 'relayEgressBytes']))
    return {'pid': pid, 'build': build, 'idle': idle, 'metrics': metrics}


def identity(build, args):
    if (build.get('commit') != args.commit or build.get('sourceDigest') != args.source_digest
            or build.get('dirty') is not False or build.get('protocol') != 1
            or build.get('target') != 'linux-x86_64'):
        raise RuntimeError('Candidate build identity does not match the verified Actions artifact')


def install(args):
    binary = pathlib.Path(args.binary)
    candidate = pathlib.Path(args.candidate)
    if binary.is_symlink() or candidate.is_symlink() or not binary.is_file() or not candidate.is_file():
        raise RuntimeError('Existing binary and candidate must be regular files, not symlinks')
    if candidate.parent != binary.parent:
        raise RuntimeError('Candidate must be on the same directory/filesystem as the existing binary')
    if hashlib.sha256(candidate.read_bytes()).hexdigest() != args.sha256:
        raise RuntimeError('Uploaded binary SHA256 mismatch')
    candidate.chmod(0o700)
    identity(json.loads(execute([str(candidate), '--version'])), args)
    descriptor = os.open(str(binary) + '.deploy.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w'):
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = status(binary, args.service)
        if not before['idle'] and not args.allow_restart_active:
            raise RuntimeError('Agent became busy; candidate staged but service was not stopped')
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        backup = pathlib.Path(str(binary) + '.backup-' + stamp)
        # Preserve the executable actually running, even if an auto-update replaced its disk path.
        shutil.copy2('/proc/' + str(before['pid']) + '/exe', backup)
        backup.chmod(0o700)
        stopped = False
        try:
            stopped = True
            service('stop', args.service)
            candidate.replace(binary)
            service('start', args.service)
            pid = int(execute(['systemctl', '--user', 'show', args.service, '--property=MainPID', '--value']))
            if not pid:
                raise RuntimeError('New Agent service has no MainPID')
            identity(json.loads(execute(['/proc/' + str(pid) + '/exe', '--version'])), args)
            until = time.monotonic() + args.verify_seconds
            connected = False
            while time.monotonic() < until:
                if service('is-active', args.service) != 'active':
                    raise RuntimeError('New Agent service stopped during verification')
                current = execute(['systemctl', '--user', 'show', args.service, '--property=MainPID', '--value'])
                if current != str(pid):
                    raise RuntimeError('Agent unexpectedly restarted during verification')
                logs = execute(['journalctl', '--user', '-u', args.service, '_PID=' + str(pid),
                                '--no-pager', '-o', 'cat'])
                connected = connected or 'Agent connected:' in logs
                if 'Pong timeout' in logs or 'Reconnect budget exhausted' in logs:
                    raise RuntimeError('New Agent lost the relay connection during verification')
                time.sleep(min(5, max(0, until - time.monotonic())))
            if not connected:
                raise RuntimeError('New Agent did not complete the relay handshake')
            after = status(binary, args.service)
            identity(after['build'], args)
            return {'before': before, 'after': after, 'backup': str(backup),
                    'verifiedSeconds': args.verify_seconds, 'connected': connected}
        except Exception as error:
            if stopped:
                try:
                    service('stop', args.service)
                    rollback = pathlib.Path(str(binary) + '.rollback-' + stamp)
                    shutil.copy2(backup, rollback)
                    rollback.replace(binary)
                    service('start', args.service)
                except Exception as rollback_error:
                    raise RuntimeError('Install failed: ' + str(error) + '; rollback failed: ' +
                                       str(rollback_error) + '; backup: ' + str(backup)) from error
            raise RuntimeError('Install failed: ' + str(error) + '; restored backup: ' + str(backup)) from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['status', 'install'])
    for name in ['binary', 'service', 'commit', 'candidate', 'sha256', 'source-digest']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--verify-seconds', type=int, required=True)
    parser.add_argument('--allow-restart-active', action='store_true')
    args = parser.parse_args()
    if args.operation == 'status':
        result = status(pathlib.Path(args.binary), args.service)
    else:
        result = install(args)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error)}), flush=True)
        raise SystemExit(1)
