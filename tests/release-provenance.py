"""Exercise release gates in a disposable repository; artifacts are synthetic."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

source = pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='coc-release-test-') as directory:
    root = pathlib.Path(directory)
    for path in ['scripts/package-release.py', 'scripts/build-metadata.py']:
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / path, root / path)
    for path in ['examples/agent.example.json', 'examples/coc-agent.service', 'docs/USER_GUIDE.md']:
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text('synthetic test input\n')
    (root / 'package.json').write_text('{"version":"0.5.0"}')
    (root / '.gitignore').write_text('build/\ndist/\n__pycache__/\n')
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
    (root / 'untracked-input').write_text('new build input')
    dirty = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
    assert dirty.returncode != 0 and 'clean' in dirty.stderr
    commit()
    stale = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
    assert stale.returncode != 0 and 'identity' in stale.stderr
print('PASS: matching build identity, untracked dirty-tree rejection and stale-binary rejection (synthetic artifacts)')
