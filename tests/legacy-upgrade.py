#!/usr/bin/env python3
"""Build the fixture writer from the exact pre-merge Store and verify one-way upgrade."""
import argparse
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--legacy-source', required=True)
args = parser.parse_args()
source = pathlib.Path(args.legacy_source).resolve()
current = pathlib.Path(__file__).resolve().parents[1]
fixture = current / 'native/tests/legacy_upgrade.cpp'
shutil.copyfile(fixture, source / 'native/tests/legacy_upgrade.cpp')
if source == current:
    raise SystemExit('Legacy source must be an isolated pre-merge checkout')
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
        for _ in range(2):
            subprocess.run([str(new), 'verify', directory], check=True)
        assert subprocess.run([str(old), 'verify', directory], capture_output=True).returncode != 0
        with sqlite3.connect(str(pathlib.Path(directory) / 'agent.db.pre-opaque-v2')) as db:
            assert db.execute('PRAGMA user_version').fetchone()[0] == version
print('PASS: exact pre-merge Store creates SQLite 0/1; upgrade, repeated startup and downgrade rejection preserve state')
