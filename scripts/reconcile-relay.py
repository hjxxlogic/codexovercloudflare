"""Back up and retire reviewed legacy leases for an idle, stopped local Agent."""
import argparse
import json
import pathlib
import sqlite3
import subprocess
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=pathlib.Path, required=True)
    parser.add_argument('--idle-evidence', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--service', default='coc-agent.service')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    evidence = json.loads(args.idle_evidence.read_text())
    if evidence.get('before', {}).get('idle') is not True:
        raise RuntimeError('Original idle preflight is required')
    pid = subprocess.check_output(['systemctl', '--user', 'show', args.service,
                                   '--property=MainPID', '--value'], text=True).strip()
    if pid != '0':
        raise RuntimeError('Stop the idle service before reconciliation')
    config = json.loads(args.config.read_text())
    db_path = pathlib.Path(config['dataDir']) / 'agent.db'
    with sqlite3.connect('file:' + str(db_path) + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Database integrity check failed')
        sessions = [json.loads(row[0]) for row in db.execute('SELECT value FROM sessions')]
        if any(s.get('state') not in ('closed', 'failed') for s in sessions):
            raise RuntimeError('Potentially active local sessions must be reconciled first')
    access = json.loads(pathlib.Path(config['cloudflareAccessFile']).read_text())
    headers = {'Authorization': 'Bearer ' + config['token'], 'User-Agent': 'coc-agent/0.6.14',
               'CF-Access-Client-Id': access['clientId'],
               'CF-Access-Client-Secret': access['clientSecret'], 'Content-Type': 'application/json'}
    url = config['relayUrl'].replace('wss://', 'https://').replace('ws://', 'http://').split('/ws/')[0].rstrip('/') + '/api/v1/agent/relay-migration'
    def request(data=None):
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers, data=data), timeout=60) as response:
            return json.load(response)
    snapshot = request()
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Exclusive creation prevents a repeated invocation from replacing the original snapshot.
    with args.output.open('x', opener=lambda p, f: __import__('os').open(p, f, 0o600)) as output:
        json.dump(snapshot, output)
    entries = snapshot['entries']
    if any(k.startswith('permission-operation:') and v.get('state') != 'completed' for k, v in entries):
        raise RuntimeError('Unresolved permission operations require separate reconciliation')
    leases = [(k, v) for k, v in entries if k.startswith('lease:') and (v.get('active') or v.get('pending'))]
    if any(not k.startswith('lease:' + config['hostId'] + '~') for k, _ in leases):
        raise RuntimeError('Unexpected host lease')
    print(json.dumps({'sessions': len(sessions), 'reviewedLeases': len(leases), 'apply': args.apply}))
    if args.apply and leases:
        request(json.dumps({'entries': leases}).encode())
        print('Legacy leases retired; original records retained in the snapshot and DO reconciliation journal')


if __name__ == '__main__':
    main()
