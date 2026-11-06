"""Connect a private journal copy to r2 using a restored host ID and fresh authorization."""
import argparse
import json
import os
import pathlib
import shutil
import sqlite3
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['source-config', 'snapshot', 'output', 'access-config', 'owner-secret-file']:
        parser.add_argument('--' + name, type=pathlib.Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if not args.apply:
        parser.error('Explicit --apply is required to create independent r2 authorization')
    os.umask(0o077)
    for path in [args.source_config, args.access_config, args.owner_secret_file]:
        if path.stat().st_mode & 0o077 or path.stat().st_uid != os.getuid():
            parser.error('Configuration and credentials must be private and owned by this user')
    config = json.loads(args.source_config.read_text())
    access = json.loads(args.access_config.read_text())
    if access['origins'] != ['https://r2.xlogic.cc']:
        parser.error('Independent r2-only Access configuration is required')
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    data = args.output.resolve() / 'data'
    data.mkdir(mode=0o700)
    # Online backups supplied by state-backup.py are immutable inputs. Copy with
    # SQLite too, so committed WAL is included even if a supplied snapshot has WAL.
    with sqlite3.connect(args.snapshot.resolve().as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(data / 'agent.db') as target:
            source.backup(target)
            assert target.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    catalog = pathlib.Path(config['dataDir']) / 'projects.json'
    if catalog.exists():
        shutil.copyfile(catalog, data / 'projects.json')
    headers = {'Content-Type': 'application/json', 'Origin': 'https://r2.xlogic.cc',
               'User-Agent': 'coc-agent-database-test/0.6.14',
               'CF-Access-Client-Id': access['clientId'],
               'CF-Access-Client-Secret': access['clientSecret']}

    def request(path, body, token=None):
        req = urllib.request.Request('https://r2.xlogic.cc/guest/api/v1' + path,
                                     data=json.dumps(body).encode(),
                                     headers={**headers, **({'Authorization': 'Bearer ' + token} if token else {})})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    owner = request('/auth/login', {'kind': 'cli', 'secret': args.owner_secret_file.read_text().strip()})['token']
    grant = request('/admin/hosts/restore', {'hostId': config['hostId'],
                                          'name': 'r2-real-database-0.6.14'}, owner)
    config.update(relayUrl='https://r2.xlogic.cc', token=grant['token'], dataDir=str(data),
                  displayName=grant['name'], cloudflareAccessFile=str(args.access_config.resolve()),
                  autoUpdate=False, terminal={'enabled': False})
    config['externalSessions'] = {'allowQueue': False, 'allowApprovals': False,
                                  'approvalEndpoint': '', 'approvalTokenFile': ''}
    config.pop('wakeUrl', None)
    # Startup repair is disabled by the launcher. No control endpoint is copied;
    # the new Agent allocates its own port and token inside this data directory.
    (args.output / 'agent.json').write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
    print('Prepared independent r2 config and copied journal; original host ID preserved, fresh token issued')


if __name__ == '__main__':
    main()
