#!/usr/bin/env python3
"""Collect redacted, read-only CoC diagnostics for local users x0-x9."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import tempfile


def redact(value):
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            normalized = re.sub('[^a-z]', '', key.lower())
            sensitive = any(word in normalized for word in
                            ('token', 'secret', 'password', 'credential', 'authorization',
                             'cookie', 'apikey', 'privatekey'))
            result[key] = '<REDACTED>' if sensitive else redact(item)
        return result
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        # URL passwords, query strings and fragments can carry credentials.
        value = re.sub(r'(https?|socks5h?)://[^/@\s]+@', r'\1://<REDACTED>@', value)
        value = re.sub(r'((?:https?|socks5h?)://[^\s?#]+)[?#][^\s]*',
                       r'\1?<REDACTED>', value)
    return value


def read_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4 * 1024 * 1024:
            raise ValueError('not a regular JSON file within 4 MiB')
        data = source.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('JSON file exceeds 4 MiB')
        return json.loads(data), metadata, hashlib.sha256(data).hexdigest()


def processes(uid):
    found = []
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit():
            continue
        try:
            if directory.stat().st_uid != uid:
                continue
            args = (directory / 'cmdline').read_bytes().decode().rstrip('\0').split('\0')
            if not args or Path(args[0]).name != 'coc-agent':
                continue
            config = None
            if '--config' in args:
                config = args[args.index('--config') + 1]
                if not Path(config).is_absolute():
                    config = str((directory / 'cwd').resolve() / config)
            found.append({'pid': int(directory.name), 'executable': os.readlink(directory / 'exe'),
                          'config': config})
        except (OSError, UnicodeError, IndexError):
            continue
    return found


def collect_user(user, output):
    account = pwd.getpwnam(user)
    folder = output / user
    folder.mkdir(mode=0o700)
    report = {'uid': account.pw_uid, 'home': account.pw_dir,
              'processes': processes(account.pw_uid), 'files': [], 'errors': []}

    def snapshot(path, name):
        try:
            data, metadata, digest = read_json(path)
            target = folder / name
            target.write_text(json.dumps(redact(data), ensure_ascii=False, indent=2) + '\n')
            report['files'].append({'source': str(path), 'copy': name,
                                    'uid': metadata.st_uid, 'gid': metadata.st_gid,
                                    'mode': oct(stat.S_IMODE(metadata.st_mode)),
                                    'mtime_ns': metadata.st_mtime_ns, 'sha256': digest})
            return data
        except (OSError, ValueError) as error:
            # Parser messages can include original text; never copy malformed raw files.
            report['errors'].append({'source': str(path), 'error': type(error).__name__,
                                     'errno': getattr(error, 'errno', None)})
            return None

    configs = {str(Path(account.pw_dir) / '.config/coc-agent/agent.json')}
    configs.update(p['config'] for p in report['processes'] if p['config'])
    for index, config in enumerate(sorted(configs)):
        data = snapshot(Path(config), f'agent-{index}.redacted.json')
        if isinstance(data, dict) and isinstance(data.get('dataDir'), str):
            directory = Path(data['dataDir'])
            if directory.is_absolute():
                snapshot(directory / 'projects.json', f'projects-{index}.redacted.json')
            else:
                report['errors'].append({'source': config, 'error': 'relative dataDir; not guessed'})
    snapshot(Path(account.pw_dir) / '.config/coc-client/credentials.json',
             'client.redacted.json')

    result = subprocess.run(['journalctl', '--since=-20 minutes', '--no-pager', '-o', 'json',
                             '_UID=' + str(account.pw_uid), '_COMM=coc-agent', '-n', '500'],
                            capture_output=True, text=True, timeout=30)
    diagnostics = []
    for line in result.stdout.splitlines():
        try:
            row = json.loads(line)
            message = row.get('MESSAGE', '')
            item = {'time_us': row.get('__REALTIME_TIMESTAMP'), 'pid': row.get('_PID')}
            if message.startswith('Agent connected:'):
                item['event'] = 'connected'
            else:
                value = json.loads(message)
                if not isinstance(value, dict):
                    continue
                if value.get('code'):
                    item['code'] = value['code']
                    known = ('codexUseProxy is unsupported; use codexProxyMode',
                             'autoUpdate.intervalHours is unsupported',
                             'Unsupported project catalog; automatic migration is disabled')
                    item['message'] = value.get('message') if value.get('message') in known else '<omitted>'
                elif value.get('event') == 'agent_metrics':
                    item.update({key: value.get(key) for key in
                                 ('event', 'runtimes', 'approvals', 'queuedCommands')})
                else:
                    continue
            diagnostics.append(item)
        except (ValueError, TypeError):
            continue
    (folder / 'journal.filtered.json').write_text(json.dumps(diagnostics, indent=2) + '\n')
    report['journal_returncode'] = result.returncode
    (folder / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    return len(report['errors'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--owner', help='owner of the collected copies; defaults to sudo caller')
    args = parser.parse_args()
    owner = pwd.getpwnam(args.owner) if args.owner else pwd.getpwuid(int(os.environ.get('SUDO_UID', os.getuid())))
    os.umask(0o077)
    output = Path(tempfile.mkdtemp(prefix='coc-user-diagnostics-', dir='/tmp'))
    try:
        for index in range(10):
            user = f'x{index}'
            try:
                errors = collect_user(user, output)
                print(f'{user}: collected; missing/unreadable files: {errors}', flush=True)
            except (KeyError, OSError, ValueError, subprocess.SubprocessError) as error:
                print(f'{user}: skipped ({type(error).__name__}); continuing', flush=True)
    finally:
        # Keep the directory root-owned until every write is complete.
        for path in sorted(output.rglob('*'), reverse=True):
            path.chmod(0o700 if path.is_dir() else 0o600)
            os.chown(path, owner.pw_uid, owner.pw_gid)
        os.chown(output, owner.pw_uid, owner.pw_gid)
    print(f'OUTPUT={output}')
    print('Redacted inspection copies only; not suitable for restoring credentials.')


if __name__ == '__main__':
    main()
