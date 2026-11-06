"""Rehearse Store migration on a private snapshot without starting an Agent or Codex."""
import argparse
import hashlib
import json
import pathlib
import shutil
import sqlite3
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]


def contents(path):
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        tables = {}
        for name, in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            rows = sorted(hashlib.sha256(repr(row).encode()).digest()
                          for row in db.execute('SELECT * FROM ' + quoted))
            tables[name] = dict(rows=len(rows), sha256=hashlib.sha256(b''.join(rows)).hexdigest())
        return dict(version=db.execute('PRAGMA user_version').fetchone()[0], tables=tables)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--probe', type=pathlib.Path, default=ROOT / 'build/coc-database-upgrade')
    args = parser.parse_args()
    # Require a fresh directory; never open or migrate the supplied snapshot in place.
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    original = contents(args.snapshot)
    digest = hashlib.sha256(args.snapshot.read_bytes()).hexdigest()
    journal = args.output / 'agent.db'
    shutil.copyfile(args.snapshot, journal)
    journal.chmod(0o600)
    for attempt in range(2):
        subprocess.run([str(args.probe.resolve()), str(args.output.resolve())], check=True)
        upgraded = contents(journal)
        assert upgraded['version'] == 2, 'Journal version was not upgraded'
        for name, value in original['tables'].items():
            assert upgraded['tables'].get(name) == value, 'Original table changed: ' + name
    assert hashlib.sha256(args.snapshot.read_bytes()).hexdigest() == digest
    if original['version'] < 2:
        assert contents(args.output / 'agent.db.pre-opaque-v2') == original
    report = dict(snapshotSha256=digest, originalVersion=original['version'], upgradedVersion=2,
                  originalTables=original['tables'], repeatedOpenPassed=True,
                  allOriginalRowsPreserved=True, snapshotUnchanged=True,
                  agentStarted=False, relayConnected=False, modelCalled=False)
    (args.output / 'verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print('PASS: copied user journal upgraded twice; every original table row and backup preserved')


if __name__ == '__main__':
    main()
