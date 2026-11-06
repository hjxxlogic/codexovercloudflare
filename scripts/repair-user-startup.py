#!/usr/bin/env python3
"""Explicit repair of inspected, empty legacy project catalogs for x0/1/2/3/7/8."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import tempfile


USERS = ('x0', 'x1', 'x2', 'x3', 'x7', 'x8')


def converted_catalog(data, host):
    expected = {'hostId', 'projects', 'receipts', 'revision', 'version'}
    if (not isinstance(data, dict) or set(data) != expected or data['version'] != 1 or
            data['revision'] != 0 or data['receipts'] != [] or data['hostId'] != host or
            not isinstance(data['projects'], list) or not data['projects']):
        raise ValueError('catalog differs from inspected empty legacy format; manual review required')
    result = dict(data)
    del result['receipts']
    result['journal'] = {'version': 2, 'keys': {}, 'tail': []}
    result['retiredIds'] = []
    return result


def load(path, evidence, uid):
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('symbolic link in source path')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != uid:
            raise ValueError('source must be a regular file owned by target user')
        original = stream.read(4 * 1024 * 1024 + 1)
    if hashlib.sha256(original).hexdigest() != evidence['sha256']:
        raise ValueError('source changed since collection; collect diagnostics again')
    return json.loads(original), original, metadata


def replace(path, data, original, metadata):
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        # Match save_private's directory lock. Reads see either complete version.
        fcntl.flock(directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if path.read_bytes() != original:
            raise ValueError('source changed before replacement')
        backup_fd, backup = tempfile.mkstemp(prefix=path.name + '.before-startup-repair-', dir=path.parent)
        with os.fdopen(backup_fd, 'wb') as stream:
            stream.write(original)
            stream.flush()
            os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(metadata.st_mode))
            os.fsync(stream.fileno())
        fd, temporary = tempfile.mkstemp(prefix=path.name + '.startup-repair-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write((json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode())
                stream.flush()
                os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
                os.fchmod(stream.fileno(), stat.S_IMODE(metadata.st_mode))
                os.fsync(stream.fileno())
            os.replace(temporary, path)
            os.fsync(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print(f'UPDATED {path}; backup={backup}', flush=True)
    finally:
        os.close(directory)


def repair(user, snapshot, apply, proxy_settings=None):
    account = pwd.getpwnam(user)
    home = Path(account.pw_dir)
    report = json.loads((snapshot / user / 'report.json').read_text())
    evidence = {f['source']: f for f in report['files']}
    config_path = home / '.config/coc-agent/agent.json'
    catalog_path = home / '.local/share/coc/projects.json'
    config, config_raw, config_stat = load(config_path, evidence[str(config_path)], account.pw_uid)
    if config.get('dataDir') != str(catalog_path.parent):
        raise ValueError('unexpected dataDir')
    catalog_plan = None
    if user in USERS:
        catalog, original, metadata = load(catalog_path, evidence[str(catalog_path)], account.pw_uid)
        catalog_plan = (converted_catalog(catalog, config.get('hostId')), original, metadata)
    if user in ('x1', 'x2'):
        if config.get('codexUseProxy') is not False or config.get('codexProxyMode') != 'inherit':
            raise ValueError('proxy configuration differs from inspected values')
        del config['codexUseProxy']
    client_plan = None
    if proxy_settings is not None:
        config.update(proxy_settings)
        config.pop('codexUseProxy', None)
        client_path = home / '.config/coc-client/credentials.json'
        client, client_raw, client_stat = load(client_path, evidence[str(client_path)], account.pw_uid)
        client_before = dict(client)
        client['proxy'] = proxy_settings['proxy']
        if client != client_before:
            client_plan = (client_path, client, client_raw, client_stat)
    config_changed = config != json.loads(config_raw)
    if not apply:
        print(f'PREVIEW {user}: catalog={catalog_plan is not None}; '
              f'agent config={config_changed}; client config={client_plan is not None}')
        return
    if catalog_plan:
        replace(catalog_path, *catalog_plan)
    if config_changed:
        replace(config_path, config, config_raw, config_stat)
    if client_plan:
        replace(*client_plan)
    print(f'OK {user}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True, help='diagnostic collection directory')
    parser.add_argument('--apply', action='store_true', help='write changes; default is preview')
    parser.add_argument('--sync-proxy-from', type=Path, metavar='AGENT_JSON',
                        help='also synchronize x0-x9 Agent / CLI proxy settings from this Agent config')
    args = parser.parse_args()
    proxy_settings = None
    users = USERS
    if args.sync_proxy_from:
        reference = json.loads(args.sync_proxy_from.read_text())
        proxy_settings = {'proxy': reference.get('proxy', ''),
                          'codexProxyMode': reference.get('codexProxyMode', 'inherit')}
        if (not isinstance(proxy_settings['proxy'], str) or
                proxy_settings['codexProxyMode'] not in ('inherit', 'direct', 'agent')):
            parser.error('invalid reference proxy settings')
        users = tuple(f'x{i}' for i in range(10))
    failures = 0
    for user in users:
        try:
            repair(user, args.snapshot, args.apply, proxy_settings)
        except (OSError, ValueError, KeyError) as error:
            # Do not print JSON parser snippets or credential values.
            detail = str(error) if type(error) is ValueError else type(error).__name__
            print(f'SKIPPED {user}: {detail}; continuing', flush=True)
            failures += 1
    print(f'Finished: {len(users) - failures} succeeded, {failures} skipped. No services restarted.')
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
