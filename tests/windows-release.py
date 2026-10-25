"""Exercise Windows ZIP packaging with real synthetic PE binaries in a disposable repo."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

if sys.platform != 'win32':
    raise SystemExit('This test requires Windows x64 and MSVC')
source = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='coc-windows-release-') as directory:
    root = pathlib.Path(directory)
    for name in ['scripts/package-release.py', 'scripts/build-metadata.py']:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
    for name in ['examples/agent.example.json', 'docs/USER_GUIDE.md', 'deps/share/openssl/copyright']:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text('Synthetic packaging fixture\n', encoding='utf-8')
    (root / 'package.json').write_text('{"version":"0.5.0"}', encoding='utf-8')
    (root / '.gitignore').write_text('build/\ndist/\n__pycache__/\n', encoding='utf-8')
    (root / 'fixture.cpp').write_text(
        '#include <iostream>\n#include "build/identity.hpp"\n'
        'int main() { std::cout << FIXTURE_METADATA << std::endl; }\n', encoding='utf-8')
    (root / 'CMakeLists.txt').write_text(
        'cmake_minimum_required(VERSION 3.16)\n'
        'cmake_policy(SET CMP0091 NEW)\nproject(fixture LANGUAGES CXX)\n'
        'set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")\n'
        'add_executable(coc-client fixture.cpp)\nadd_executable(coc-agent fixture.cpp)\n', encoding='utf-8')
    env = dict(os.environ)
    env.pop('COC_TEST_BUILD_METADATA', None)
    def run(*args, check=True):
        return subprocess.run(args, cwd=root, env=env, text=True, encoding='utf-8', errors='replace', capture_output=True, check=check)
    def commit():
        run('git', 'add', '.')
        run('git', '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture')
    run('git', 'init', '-q')
    commit()
    metadata = json.loads(run(sys.executable, 'scripts/build-metadata.py').stdout)
    assert metadata['target'] == 'windows-x86_64'
    (root / 'build').mkdir()
    (root / 'build/identity.hpp').write_text('#define FIXTURE_METADATA ' + json.dumps(json.dumps(metadata)) + '\n', encoding='utf-8')
    run('cmake', '-S', '.', '-B', 'build', '-A', 'x64')
    run('cmake', '--build', 'build', '--config', 'Release', '--parallel', '2')
    command = [sys.executable, 'scripts/package-release.py', '--build-dir', 'build/Release',
               '--platform', 'windows-x64', '--dependency-dir', 'deps']
    result = run(*command)
    output = root / 'dist/web/downloads'
    archive = output / 'coc-0.5.0-windows-x64.zip'
    with zipfile.ZipFile(archive) as package:
        names = package.namelist()
        for name in ['coc-agent.exe', 'coc-client.exe', 'agent.example.json', 'USER_GUIDE.md', 'licenses/openssl.txt']:
            assert 'coc-0.5.0-windows-x64/' + name in names
        assert not any(name.endswith('.service') for name in names)
    sums = (output / 'SHA256SUMS').read_bytes()
    assert b'\r' not in sums
    assert (hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name).encode() in sums
    assert archive.name in json.loads((output / 'index.json').read_text())['files']
    wrong = run(sys.executable, 'scripts/package-release.py', '--platform', 'ubuntu20.04', check=False)
    assert wrong.returncode and 'Linux x86_64' in wrong.stderr
    (root / 'untracked-input').write_text('new source', encoding='utf-8')
    dirty = run(*command, check=False)
    assert dirty.returncode and 'clean' in dirty.stderr
    commit()
    stale = run(*command, check=False)
    assert stale.returncode and 'identity' in stale.stderr
print('PASS: Windows PE identity, ZIP contents, license notices, checksums, platform, dirty and stale rejection (synthetic binaries)')
