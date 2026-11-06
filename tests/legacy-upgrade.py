#!/usr/bin/env python3
"""Build the fixture writer from the exact pre-merge Store and verify one-way upgrade."""
import argparse
import json
import os
import resource
import signal
import time
import pathlib
import shutil
import sqlite3
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--legacy-source', required=True)
parser.add_argument('--agent', help='Optional CI Agent binary to rehearse isolated startup with old state')
args = parser.parse_args()
source = pathlib.Path(args.legacy_source).resolve()
current = pathlib.Path(__file__).resolve().parents[1]
fixture = current / 'native/tests/legacy_upgrade.cpp'
if source == current:
    raise SystemExit('Legacy source must be an isolated pre-merge checkout')
shutil.copyfile(fixture, source / 'native/tests/legacy_upgrade.cpp')
if 'add_executable(coc-legacy-upgrade ' not in (source / 'CMakeLists.txt').read_text():
  with (source / 'CMakeLists.txt').open('a') as output:
    output.write('\nadd_executable(coc-legacy-upgrade native/tests/legacy_upgrade.cpp)\ntarget_link_libraries(coc-legacy-upgrade PRIVATE coc_core)\n')
subprocess.run(['cmake', '-S', str(source), '-B', str(source / 'build'), '-DCMAKE_BUILD_TYPE=Release'], check=True)
subprocess.run(['cmake', '--build', str(source / 'build'), '--target', 'coc-legacy-upgrade', '-j', '2'], check=True)
old = source / 'build/coc-legacy-upgrade'
new = current / 'build/coc-legacy-upgrade'
for version in (0, 1):
    with tempfile.TemporaryDirectory(prefix='coc-legacy-upgrade-') as directory:
        subprocess.run([str(old), 'seed', directory], check=True)
        with sqlite3.connect(str(pathlib.Path(directory) / 'agent.db')) as db:
            db.execute(f'PRAGMA user_version={version}')
        # A real filesystem write limit makes SQLite backup fail partway through
        # creation, without exhausting the host disk or touching live state.
        def no_disk_space():
            signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
            resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))

        failed = subprocess.run([str(new), 'verify', directory], preexec_fn=no_disk_space, capture_output=True)
        assert failed.returncode != 0, 'Migration must reject incomplete backup writes'
        with sqlite3.connect(str(pathlib.Path(directory) / 'agent.db')) as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == version
        subprocess.run([str(old), 'verify', directory], check=True)
        # Retry past the backup stage, then interrupt actual migration writes.
        # A completed pre-upgrade backup must remain reusable, and SQLite must
        # roll back the schema/version transaction when its WAL cannot grow.
        original = sqlite3.connect(str(pathlib.Path(directory) / 'agent.db'))
        backup_path = pathlib.Path(directory) / 'agent.db.pre-opaque-v2'
        backup = sqlite3.connect(str(backup_path))
        try:
            original.backup(backup)
        finally:
            backup.close()
            original.close()
        backup_path.chmod(0o600)
        failed = subprocess.run([str(new), 'verify', directory], preexec_fn=no_disk_space, capture_output=True)
        assert failed.returncode != 0, 'Migration transaction must reject failed WAL writes'
        with sqlite3.connect(str(pathlib.Path(directory) / 'agent.db')) as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == version
        subprocess.run([str(old), 'verify', directory], check=True)
        if args.agent:
            project = pathlib.Path(directory) / 'project'
            project.mkdir()
            config = pathlib.Path(directory) / 'agent.json'
            config.write_text(json.dumps(dict(relayUrl='http://127.0.0.1:9', hostId='legacy-host', token='x' * 32, dataDir=directory, autoUpdate=False, codexPath=sys.executable, codexArgs=['-c', "print('codex-cli test')"], projects=[dict(id='original-project', name='Original', path=str(project))])))
            config.chmod(0o600)
            original_config = config.read_bytes()
            original_projects = (pathlib.Path(directory) / 'projects.json').read_bytes()
            for attempt in range(2):
                with (pathlib.Path(directory) / f'startup-{attempt}.log').open('w') as log:
                    agent = subprocess.Popen([str(pathlib.Path(args.agent).resolve()), 'run', '--config', str(config)], stdout=log, stderr=log, env=dict(os.environ, COC_NO_STARTUP_REPAIR='1'))
                    try:
                        deadline = time.monotonic() + 20
                        while True:
                            with sqlite3.connect(str(pathlib.Path(directory) / 'agent.db')) as db:
                                upgraded = db.execute('PRAGMA user_version').fetchone()[0] == 2
                            if upgraded and (pathlib.Path(directory) / 'projects.json').exists(): break
                            if agent.poll() is not None or time.monotonic() > deadline:
                                raise RuntimeError('Agent did not recover old state: ' + (pathlib.Path(directory) / f'startup-{attempt}.log').read_text())
                            time.sleep(0.05)
                    finally:
                        agent.terminate()
                        try: agent.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            agent.kill()
                            agent.wait()
                assert config.read_bytes() == original_config, 'Upgrade must preserve configuration and credentials'
                registered = json.loads((pathlib.Path(directory) / 'projects.json').read_text())
                assert registered['projects'][0]['id'] == 'original-project'
                assert registered['projects'][0]['path'] == directory
                assert (pathlib.Path(directory) / 'projects.json').read_bytes() == original_projects
        for _ in range(2):
            subprocess.run([str(new), 'verify', directory], check=True)
        assert subprocess.run([str(old), 'verify', directory], capture_output=True).returncode != 0
        with sqlite3.connect(str(pathlib.Path(directory) / 'agent.db.pre-opaque-v2')) as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == version
print('PASS: exact pre-merge Store creates SQLite 0/1; upgrade, repeated startup and downgrade rejection preserve state')
