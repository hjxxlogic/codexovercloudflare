"""Combine CI artifacts only when every package matches the tagged source identity."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--artifacts', type=Path, required=True)
parser.add_argument('--tag', required=True)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('metadata', 'scripts/build-metadata.py')
metadata = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)
identity = metadata.identity()
if identity['dirty'] or args.tag != 'v' + identity['version']:
    parser.error('Release requires clean source and its matching version tag')
version = identity['version']
selected = []
source = f'codex-over-cloudflare-{version}-source.tar.gz'
for platform in ('ubuntu20.04', 'debian12', 'musl', 'windows-x64'):
    root = args.artifacts / ('windows-x64' if platform == 'windows-x64' else 'linux-' + platform)
    manifest = json.loads((root / 'index.json').read_text())
    for field in ('version', 'commit', 'sourceDigest', 'protocol'):
        if manifest.get(field) != identity[field]:
            parser.error(f'{platform} {field} does not match tagged source')
    package = (f'coc-{version}-windows-x64.zip' if platform == 'windows-x64'
               else f'coc-{version}-linux-x86_64-{platform}.tar.gz')
    hashes = dict(line.split('  ', 1)[::-1] for line in (root / 'SHA256SUMS').read_text().splitlines())
    for name in (package, source):
        if name not in manifest.get('files', []) or name not in hashes:
            parser.error(f'{platform} is missing {name}')
        path = root / name
        if hashlib.sha256(path.read_bytes()).hexdigest() != hashes[name]:
            parser.error(f'{platform} checksum mismatch for {name}')
    selected.append(root / package)
    if platform == 'ubuntu20.04':
        selected.append(root / source)

output = Path('dist/web')
if output.exists():
    parser.error('Output must be absent before assembling a release')
shutil.copytree(args.artifacts / 'verified-web', output)
downloads = output / 'downloads'
downloads.mkdir(exist_ok=True)
for existing in downloads.iterdir():
    if existing.name != 'USER_GUIDE.md' or existing.read_bytes() != Path('docs/USER_GUIDE.md').read_bytes():
        parser.error('Verified web artifact must not contain unverified downloads')
for path in selected:
    shutil.copy2(path, downloads / path.name)
shutil.copy2('docs/USER_GUIDE.md', downloads / 'USER_GUIDE.md')
archives = sorted(selected, key=lambda p: p.name)
(downloads / 'SHA256SUMS').write_text(''.join(
    hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in archives))
(downloads / 'index.json').write_text(json.dumps({
    **{key: identity[key] for key in ('version', 'commit', 'sourceDigest', 'protocol')},
    'files': [p.name for p in archives], 'checksums': 'SHA256SUMS', 'manual': 'USER_GUIDE.md',
}, indent=2) + '\n')
links = ''.join(f'<li><a href="{p.name}">{p.name}</a></li>' for p in archives)
(downloads / 'index.html').write_text(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex Downloads</title>'
    f'<h1>Codex over Cloudflare {version}</h1><p>Linux x86_64 / Windows x64</p><ul>{links}'
    '<li><a href="SHA256SUMS">SHA256SUMS</a></li>'
    '<li><a href="USER_GUIDE.md">用户手册</a></li></ul></html>', encoding='utf-8')
print('Verified release:', version, identity['commit'], ', '.join(p.name for p in archives))
