"""Exercise release gates in a disposable repository; artifacts are synthetic."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import struct
import sys
import tarfile
import tempfile

source = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='coc-release-test-') as directory:
    root = pathlib.Path(directory)
    for path in ['scripts/package-release.py', 'scripts/build-metadata.py', 'scripts/assemble-release.py']:
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / path, root / path)
    for path in ['examples/agent.example.json', 'examples/coc-agent.service', 'docs/USER_GUIDE.md']:
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text('synthetic test input\n')
    (root / 'package.json').write_text('{"version":"0.5.0"}')
    (root / '.gitignore').write_text('build/\ndist/\n.local/\n__pycache__/\n')
    def run(*args, check=True):
        return subprocess.run(args, cwd=root, text=True, capture_output=True, check=check)
    def commit():
        run('git', 'add', '.')
        run('git', '-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture')
    run('git', 'init', '-q')
    commit()
    env = dict(os.environ)
    env.pop('COC_TEST_BUILD_METADATA', None)
    metadata = json.loads(subprocess.check_output([sys.executable, 'scripts/build-metadata.py'], cwd=root, env=env))
    (root / 'build').mkdir()
    for name in ['coc-client', 'coc-agent']:
        executable = root / 'build' / name
        executable.write_text('#!' + sys.executable + '\nprint(' + repr(json.dumps(metadata)) + ')\n')
        executable.chmod(0o700)
    command = [sys.executable, 'scripts/package-release.py', '--platform', 'synthetic']
    clean = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
    assert clean.returncode == 0, clean.stderr
    manifest = json.loads((root / 'dist/web/downloads/index.json').read_text())
    assert manifest['sourceDigest'] == metadata['sourceDigest']
    if sys.platform != 'win32':
        wrong_target = subprocess.run(command[:-1] + ['windows-x64'], cwd=root, env=env, text=True, capture_output=True)
        assert wrong_target.returncode != 0 and 'Windows x64' in wrong_target.stderr
    sums = (root / 'dist/web/downloads/SHA256SUMS').read_bytes()
    assert b'\r' not in sums, 'Checksums must remain compatible with Linux update parsing'
    if sys.platform == 'linux':
        musl = command[:-1] + ['musl']
        invalid = run(*musl, check=False)
        assert invalid.returncode and 'static Linux x86_64 ELF' in invalid.stderr
        fixture = '#include <stdio.h>\nint main(void) { puts(' + json.dumps(json.dumps(metadata)) + '); }\n'
        def compile_fixture(static, pie=False):
            compiler = ['cc', '-x', 'c', '-', '-o', str(root / 'build/coc-client')]
            if static:
                compiler.append('-static-pie' if pie else '-static')
            subprocess.run(compiler, input=fixture, text=True, check=True)
            shutil.copy2(root / 'build/coc-client', root / 'build/coc-agent')
        compile_fixture(False)
        dynamic = run(*musl, check=False)
        assert dynamic.returncode and 'fully static' in dynamic.stderr
        # Removing PT_INTERP must not hide the remaining DT_NEEDED libraries.
        executable = root / 'build/coc-client'
        data = bytearray(executable.read_bytes())
        offset = struct.unpack_from('<Q', data, 32)[0]
        size, count = struct.unpack_from('<HH', data, 54)
        for index in range(count):
            header = offset + index * size
            if struct.unpack_from('<I', data, header)[0] == 3:
                struct.pack_into('<I', data, header, 0)
        executable.write_bytes(data)
        needed = run(*musl, check=False)
        assert needed.returncode and 'shared library dependencies' in needed.stderr
        compile_fixture(True)
        run(*musl)
        compile_fixture(True, pie=True)
        run(*musl)
        output = root / 'dist/web/downloads'
        with tarfile.open(output / 'coc-0.5.0-linux-x86_64-musl.tar.gz') as archive:
            readme = archive.extractfile('coc-0.5.0-linux-x86_64-musl/README.txt').read().decode()
            assert 'Fully static musl' in readme and 'Dynamically linked' not in readme
        # Synthetic archives exercise assembly gates; they are not actual platform builds.
        artifacts = root / '.local/artifacts'
        for platform in ('ubuntu20.04', 'debian12', 'musl', 'windows-x64'):
            target = artifacts / ('windows-x64' if platform == 'windows-x64' else 'linux-' + platform)
            shutil.copytree(output, target)
            manifest = json.loads((target / 'index.json').read_text())
            package = ('coc-0.5.0-windows-x64.zip' if platform == 'windows-x64'
                       else f'coc-0.5.0-linux-x86_64-{platform}.tar.gz')
            if platform != 'musl':
                shutil.copy2(target / 'coc-0.5.0-linux-x86_64-musl.tar.gz', target / package)
            manifest['files'] = [package, 'codex-over-cloudflare-0.5.0-source.tar.gz']
            (target / 'index.json').write_text(json.dumps(manifest))
            (target / 'SHA256SUMS').write_text(''.join(
                hashlib.sha256((target / name).read_bytes()).hexdigest() + '  ' + name + '\n'
                for name in manifest['files']))
        (artifacts / 'verified-web').mkdir()
        shutil.rmtree(root / 'dist/web')
        assemble = [sys.executable, 'scripts/assemble-release.py', '--artifacts', str(artifacts), '--tag', 'v0.5.0']
        musl_manifest = artifacts / 'linux-musl/index.json'
        original = musl_manifest.read_text()
        musl_manifest.write_text(original.replace(metadata['sourceDigest'], '0' * 64))
        mismatch = run(*assemble, check=False)
        assert mismatch.returncode and 'musl sourceDigest' in mismatch.stderr
        musl_manifest.write_text(original)
        musl_package = artifacts / 'linux-musl/coc-0.5.0-linux-x86_64-musl.tar.gz'
        archive_bytes = musl_package.read_bytes()
        musl_package.write_bytes(b'corrupted archive')
        corrupt = run(*assemble, check=False)
        assert corrupt.returncode and 'musl checksum mismatch' in corrupt.stderr
        musl_package.write_bytes(archive_bytes)
        run(*assemble)
        assert 'coc-0.5.0-linux-x86_64-musl.tar.gz' in json.loads((root / 'dist/web/downloads/index.json').read_text())['files']
    (root / 'untracked-input').write_text('new build input')
    dirty = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
    assert dirty.returncode != 0 and 'clean' in dirty.stderr
    commit()
    stale = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
    assert stale.returncode != 0 and 'identity' in stale.stderr
print('PASS: release identity, dirty/stale rejection, static ELF guards and four-platform assembly (synthetic artifacts)')
