"""Wait for GitHub Actions, verify its musl artifact, and deploy a Linux user-service Agent."""
import argparse
import hashlib
import io
import json
import pathlib
import re
import shlex
import subprocess
import sys
import tarfile
import time
import uuid
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
REQUIRED_JOBS = {'regression', 'sanitizers', 'windows-x64', 'linux-musl',
                 'linux-release (debian12, debian:12)', 'linux-release (ubuntu20.04, ubuntu:20.04)'}


def log(message):
    print(message, flush=True)


def curl(url, output=None):
    args = ['curl', '--fail', '--silent', '--show-error', '--location', '--retry', '3',
            '--retry-delay', '2', '--connect-timeout', '15', '--max-time', '300',
            '--max-filesize', str(512 * 1024 * 1024), '--user-agent', 'coc-deploy-agent/1', url]
    if output:
        args += ['--continue-at', '-', '--output', str(output)]
    # Older supported Ubuntu curl lacks --retry-all-errors. Resume interrupted downloads ourselves.
    for attempt in range(3 if output else 1):
        result = subprocess.run(args, capture_output=True)
        if result.returncode == 0:
            return result.stdout
        if output and result.returncode == 33:
            pathlib.Path(output).unlink(missing_ok=True)  # Server did not support Range.
        if attempt < (2 if output else 0):
            log('Download interrupted; retrying verified artifact download')
            time.sleep(2)
    if result.stderr:
        log(result.stderr.decode(errors='replace').strip())
    raise subprocess.CalledProcessError(result.returncode, args)


def api(repository, path):
    return json.loads(curl('https://api.github.com/repos/' + repository + '/actions/' + path))


def check_run(run, commit):
    if run['head_sha'] != commit or run['path'] != '.github/workflows/checks.yml':
        raise RuntimeError('Actions run does not match the requested commit and checks workflow')
    if run['event'] not in ('push', 'workflow_dispatch'):
        raise RuntimeError('Only push or workflow_dispatch builds may be deployed')
    if run['status'] == 'completed' and run['conclusion'] != 'success':
        raise RuntimeError('Actions failed: ' + str(run['conclusion']) + ' ' + run['html_url'])
    return run['status'] == 'completed'


def check_jobs(jobs):
    by_name = {job['name']: job for job in jobs}
    if not REQUIRED_JOBS <= by_name.keys():
        raise RuntimeError('Actions is missing required platform or regression jobs')
    for name in REQUIRED_JOBS:
        if by_name[name]['conclusion'] != 'success':
            raise RuntimeError('Required Actions job did not pass: ' + name)


def wait_run(repository, commit, run_id, timeout):
    deadline = time.monotonic() + timeout
    previous = None
    while time.monotonic() < deadline:
        if run_id is None:
            runs = api(repository, 'workflows/checks.yml/runs?head_sha=' + commit + '&per_page=20')
            candidates = [r for r in runs['workflow_runs'] if r['event'] in ('push', 'workflow_dispatch')]
            if candidates:
                run_id = candidates[0]['id']
        if run_id is not None:
            run = api(repository, 'runs/' + str(run_id))
            complete = check_run(run, commit)
            jobs = api(repository, 'runs/' + str(run_id) + '/jobs?per_page=100')['jobs']
            summary = ', '.join(j['name'] + ':' + (j['conclusion'] or j['status']) for j in jobs)
            if summary != previous:
                log(run['html_url'] + '\n' + summary)
                previous = summary
            if complete:
                check_jobs(jobs)
                return run, jobs
        time.sleep(20)
    raise RuntimeError('Timed out waiting for matching successful GitHub Actions')


def checked_member(name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        raise RuntimeError('Unsafe path in build artifact')


def unpack_artifact(archive, digest, commit, output):
    if digest != 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest():
        raise RuntimeError('Artifact SHA256 does not match GitHub metadata')
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        if len(set(names)) != len(names):
            raise RuntimeError('Duplicate artifact members')
        for name in names:
            checked_member(name)
        if sum(info.file_size for info in bundle.infolist()) > 512 * 1024 * 1024:
            raise RuntimeError('Artifact contents exceed size limit')
        manifest = json.loads(bundle.read('index.json'))
        if manifest['commit'] != commit or manifest['protocol'] != 1:
            raise RuntimeError('Artifact manifest has the wrong source commit or protocol')
        name = 'coc-' + manifest['version'] + '-linux-x86_64-musl.tar.gz'
        checked_member(name)
        if name not in manifest['files']:
            raise RuntimeError('Musl package missing from manifest')
        hashes = dict(line.split('  ', 1)[::-1] for line in
                      bundle.read('SHA256SUMS').decode().splitlines())
        package = bundle.read(name)
        if hashlib.sha256(package).hexdigest() != hashes.get(name):
            raise RuntimeError('Package SHA256 mismatch')
    with tarfile.open(fileobj=io.BytesIO(package), mode='r:gz') as bundle:
        members = bundle.getmembers()
        for member in members:
            checked_member(member.name)
            if not (member.isfile() or member.isdir()):
                raise RuntimeError('Links and special files are not allowed in Agent packages')
        agents = [m for m in members if pathlib.PurePosixPath(m.name).name == 'coc-agent']
        if len(agents) != 1 or not agents[0].isfile() or agents[0].size > 256 * 1024 * 1024:
            raise RuntimeError('Expected exactly one bounded Agent executable')
        binary = output / 'coc-agent'
        binary.write_bytes(bundle.extractfile(agents[0]).read())
        binary.chmod(0o700)
    return manifest, binary


def remote(host, operation, args, candidate='', sha256='', source_digest=''):
    command = ['python3', '-', operation, '--binary', args.binary, '--service', args.service,
               '--commit', args.commit, '--candidate', candidate, '--sha256', sha256,
               '--source-digest', source_digest, '--verify-seconds', str(args.verify_seconds)]
    if args.allow_restart_active:
        command += ['--allow-restart-active']
    result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                             '-o', 'ServerAliveInterval=15', host, shlex.join(command)],
                            input=(ROOT / 'scripts/deploy-agent-remote.py').read_text(),
                            text=True, capture_output=True, timeout=args.verify_seconds + 180)
    if result.stderr:
        log(result.stderr.strip())
    if result.returncode:
        raise RuntimeError('Remote ' + operation + ' failed: ' + result.stdout.strip())
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', default='hjxxlogic/codexovercloudflare')
    parser.add_argument('--commit', help='Git revision; defaults to HEAD')
    parser.add_argument('--run-id', type=int)
    parser.add_argument('--ssh', required=True, help='SSH alias or user@host')
    parser.add_argument('--binary', required=True, help='Absolute path of the existing remote Agent')
    parser.add_argument('--service', default='coc-agent.service', help='Existing systemd user service')
    parser.add_argument('--timeout', type=int, default=2400, help='Seconds to wait for CI')
    parser.add_argument('--idle-timeout', type=int, default=1800)
    parser.add_argument('--verify-seconds', type=int, default=120)
    parser.add_argument('--allow-restart-active', action='store_true',
                        help='Explicitly allow stopping running sessions during installation')
    parser.add_argument('--apply', action='store_true', help='Install; otherwise only prepare and inspect')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / '.local/deploy-agent')
    args = parser.parse_args()
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', args.repository):
        parser.error('Invalid repository')
    if not re.fullmatch(r'[\w][\w.@-]*', args.ssh):
        parser.error('Invalid SSH target')
    if not re.fullmatch(r'/[\w./-]+', args.binary) or '..' in pathlib.PurePosixPath(args.binary).parts:
        parser.error('Use a plain absolute binary path without traversal or shell syntax')
    if not re.fullmatch(r'[\w][\w.-]*\.service', args.service):
        parser.error('Invalid user service name')
    if min(args.timeout, args.idle_timeout, args.verify_seconds) <= 0:
        parser.error('Timeouts must be positive')
    args.commit = subprocess.check_output(['git', 'rev-parse', '--verify', '--end-of-options',
                                           (args.commit or 'HEAD') + '^{commit}'], cwd=ROOT, text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', args.commit):
        parser.error('Expected a full source commit')
    run, jobs = wait_run(args.repository, args.commit, args.run_id, args.timeout)
    output = args.output.resolve() / str(run['id'])
    output.mkdir(parents=True, exist_ok=True)
    artifacts = api(args.repository, 'runs/' + str(run['id']) + '/artifacts?per_page=100')['artifacts']
    matches = [a for a in artifacts if a['name'] == 'linux-musl' and not a['expired']]
    if len(matches) != 1 or not re.fullmatch(r'sha256:[0-9a-f]{64}', matches[0].get('digest') or ''):
        raise RuntimeError('Expected exactly one unexpired musl artifact with a GitHub SHA256 digest')
    artifact = matches[0]
    archive = output / 'linux-musl.zip'
    if not archive.exists() or 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest() != artifact['digest']:
        temporary = archive.with_suffix('.part')
        # Public artifact resolver; the downloaded bytes must match GitHub's independent digest.
        curl('https://nightly.link/' + args.repository + '/actions/artifacts/' + str(artifact['id']) + '.zip', temporary)
        if 'sha256:' + hashlib.sha256(temporary.read_bytes()).hexdigest() != artifact['digest']:
            raise RuntimeError('Downloaded artifact SHA256 mismatch')
        temporary.replace(archive)
    manifest, binary = unpack_artifact(archive, artifact['digest'], args.commit, output)
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    evidence = {'run': run, 'jobs': jobs, 'artifact': artifact, 'manifest': manifest,
                'binarySha256': binary_hash, 'ssh': args.ssh, 'binary': args.binary, 'applied': False}

    def save():
        (output / 'deployment.json').write_text(json.dumps(evidence, indent=2) + '\n')

    save()
    status = remote(args.ssh, 'status', args)
    evidence['before'] = status
    save()
    log('Verified CI artifact. Target: ' + json.dumps(status))
    if not args.apply:
        log('Prepared only; use --apply to install. Evidence: ' + str(output / 'deployment.json'))
        return
    deadline = time.monotonic() + args.idle_timeout
    while not status['idle'] and not args.allow_restart_active:
        if time.monotonic() >= deadline:
            raise RuntimeError('Agent still has active or unconfirmed work; nothing installed')
        log('Waiting for Agent sessions/readers/requests to finish; no restart performed')
        time.sleep(20)
        status = remote(args.ssh, 'status', args)
    candidate = args.binary + '.candidate-' + args.commit[:12] + '-' + uuid.uuid4().hex[:8]
    subprocess.run(['scp', '-q', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                    str(binary), args.ssh + ':' + candidate], check=True)
    log('Installing verified candidate; checking the new service for ' + str(args.verify_seconds) + ' seconds')
    try:
        evidence['installation'] = remote(args.ssh, 'install', args, candidate, binary_hash, manifest['sourceDigest'])
        evidence['applied'] = True
    except Exception as error:
        evidence['error'] = str(error)
        raise
    finally:
        save()
    log('Deployment verified. Evidence: ' + str(output / 'deployment.json'))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.SubprocessError, OSError, ValueError, KeyError,
            zipfile.BadZipFile, tarfile.TarError) as error:
        sys.exit('Deploy failed: ' + str(error))
