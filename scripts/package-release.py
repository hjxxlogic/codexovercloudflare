"""Package a compiled Linux target for the website downloads directory."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import sys

sys.dont_write_bytecode = True

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build-dir', default='build')
parser.add_argument('--platform', required=True, help='Distribution identifier, e.g. ubuntu20.04')
args = parser.parse_args()
if not re.fullmatch(r'[a-zA-Z0-9._-]+', args.platform):
    parser.error('Invalid platform identifier')
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location('build_metadata', 'scripts/build-metadata.py')
metadata_module = module_from_spec(spec)
spec.loader.exec_module(metadata_module)
metadata = metadata_module.identity()
if metadata['dirty']:
    parser.error('Release requires a clean tracked working tree')
version = metadata['version']
for executable in ('coc-client', 'coc-agent'):
    built = json.loads(subprocess.check_output([str(pathlib.Path(args.build_dir).resolve() / executable), '--version'], text=True))
    if any(built.get(key) != metadata[key] for key in ('version', 'commit', 'sourceDigest', 'protocol', 'dirty', 'target')):
        parser.error(f'{executable} build identity does not match the clean source tree')
output = pathlib.Path('dist/web/downloads')
output.mkdir(parents=True, exist_ok=True)
name = f'coc-{version}-linux-x86_64-{args.platform}'
with tempfile.TemporaryDirectory(prefix='coc-release-') as temporary:
    root = pathlib.Path(temporary) / name
    root.mkdir()
    for executable in ('coc-client', 'coc-agent'):
        shutil.copy2(pathlib.Path(args.build_dir) / executable, root / executable)
    shutil.copy2('examples/agent.example.json', root / 'agent.example.json')
    shutil.copy2('examples/coc-agent.service', root / 'coc-agent.service')
    (root / 'README.txt').write_text(
        f'Codex over Cloudflare {version}\nTarget: Linux x86_64 / {args.platform}\n'
        'Dynamically linked binaries: install compatible OpenSSL, Boost.System, SQLite3, '
        'libstdc++ and CA certificates. Check dependencies with ldd. Codex 0.164.0 is required '
        'for the Agent and native TUI. No Node.js runtime is required.\n'
        'Install: sudo install -m 0755 coc-client coc-agent /usr/local/bin/\n'
        'Configure Codex under the Agent user before agent login.\n'
        'Login: coc-client login --relay https://r.xlogic.cc --host <A-ID>\n'
        'Manual: https://r.xlogic.cc/downloads/USER_GUIDE.md\n'
        'Source and checksums: https://r.xlogic.cc/downloads/\n', encoding='utf-8')
    with tarfile.open(output / (name + '.tar.gz'), 'w:gz') as archive:
        archive.add(root, arcname=name)
source_name = f'codex-over-cloudflare-{version}-source.tar.gz'
subprocess.run(['git', 'archive', '--format=tar.gz', f'--prefix=codex-over-cloudflare-{version}/',
                '-o', str(output / source_name), 'HEAD'], check=True)
shutil.copy2('docs/USER_GUIDE.md', output / 'USER_GUIDE.md')
archives = sorted(output.glob('*.tar.gz'))
(output / 'SHA256SUMS').write_text(''.join(
    hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in archives))
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
(output / 'index.json').write_text(json.dumps({
    'version': version, 'commit': commit, 'sourceDigest': metadata['sourceDigest'], 'protocol': metadata['protocol'], 'files': [path.name for path in archives],
    'checksums': 'SHA256SUMS', 'manual': 'USER_GUIDE.md',
}, indent=2) + '\n')
links = ''.join(f'<li><a href="{path.name}">{path.name}</a></li>' for path in archives)
(output / 'index.html').write_text(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex Downloads</title>'
    f'<h1>Codex over Cloudflare {version}</h1><p>Linux x86_64；按发行版选择动态链接包。</p>'
    f'<ul>{links}<li><a href="SHA256SUMS">SHA256SUMS</a></li>'
    '<li><a href="USER_GUIDE.md">用户手册</a></li></ul></html>', encoding='utf-8')
print('Release files prepared:', ', '.join(path.name for path in archives))
