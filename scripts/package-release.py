"""Package a compiled Linux x86_64 or Windows x64 target for the website downloads directory."""
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
import zipfile

sys.dont_write_bytecode = True

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--build-dir', default='build')
parser.add_argument('--dependency-dir', help='Windows vcpkg installed triplet directory (for license notices)')
parser.add_argument('--platform', required=True, help='Distribution identifier: ubuntu20.04, debian12 or windows-x64')
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
windows = args.platform == 'windows-x64'
suffix = '.exe' if windows else ''
if windows and metadata['target'] != 'windows-x86_64':
    parser.error('Windows releases must be packaged and validated on Windows x64')
if not windows and metadata['target'] != 'linux-x86_64':
    parser.error('Linux releases must be packaged and validated on Linux x86_64')
for executable in ('coc-client', 'coc-agent'):
    built = json.loads(subprocess.check_output([str(pathlib.Path(args.build_dir).resolve() / (executable + suffix)), '--version'], text=True))
    if any(built.get(key) != metadata[key] for key in ('version', 'commit', 'sourceDigest', 'protocol', 'dirty', 'target')):
        parser.error(f'{executable} build identity does not match the clean source tree')
output = pathlib.Path('dist/web/downloads')
output.mkdir(parents=True, exist_ok=True)
name = f'coc-{version}-windows-x64' if windows else f'coc-{version}-linux-x86_64-{args.platform}'
with tempfile.TemporaryDirectory(prefix='coc-release-') as temporary:
    root = pathlib.Path(temporary) / name
    root.mkdir()
    for executable in ('coc-client', 'coc-agent'):
        shutil.copy2(pathlib.Path(args.build_dir) / (executable + suffix), root / (executable + suffix))
    shutil.copy2('examples/agent.example.json', root / 'agent.example.json')
    if not windows:
        shutil.copy2('examples/coc-agent.service', root / 'coc-agent.service')
    if windows:
        dlls = list(pathlib.Path(args.build_dir).glob('*.dll'))
        if dlls:
            parser.error('Windows release requires the static vcpkg triplet and static MSVC runtime')
        (root / 'README.txt').write_text(
            f'Codex over Cloudflare {version} / Windows x64\n'
            'Requires Windows 10/11 x64 or Windows Server 2019+. Extract the entire ZIP.\n'
            'Native executables use statically linked third-party libraries and CRT.\n'
            'Install native Codex 0.164.0; put codex.exe on PATH or set COC_CODEX_PATH.\n'
            'Do not use the npm codex.cmd launcher. No Node.js required for these binaries.\n'
            'Credentials: %LOCALAPPDATA%/coc-client/credentials.json or coc-agent/agent.json.\n'
            'Windows upgrades are manual: stop Agent, verify SHA256SUMS, replace the whole ZIP.\n'
            'Manual: USER_GUIDE.md or https://r.xlogic.cc/downloads/USER_GUIDE.md\n', encoding='utf-8')
        shutil.copy2('docs/USER_GUIDE.md', root / 'USER_GUIDE.md')
        dependencies = pathlib.Path(args.dependency_dir) if args.dependency_dir else pathlib.Path(args.build_dir).parent / 'vcpkg_installed/x64-windows-static'
        notices = sorted((dependencies / 'share').glob('*/copyright'))
        if not notices:
            parser.error('Windows static distribution requires dependency license notices; set --dependency-dir')
        licenses = root / 'licenses'
        licenses.mkdir()
        for notice in notices:
            shutil.copy2(notice, licenses / (notice.parent.name + '.txt'))
        with zipfile.ZipFile(output / (name + '.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(root.rglob('*')):
                if path.is_file():
                    archive.write(path, f'{name}/{path.relative_to(root).as_posix()}')
    else:
        (root / 'README.txt').write_text(
            f'Codex over Cloudflare {version}\nTarget: Linux x86_64 / {args.platform}\n'
            'Dynamically linked binaries: install compatible OpenSSL, Boost.System, SQLite3, '
            'libstdc++ and CA certificates. Check dependencies with ldd. Codex 0.164.0 is required '
            'for the Agent and native TUI. No Node.js runtime is required.\n'
            'Install: mkdir -p ~/.local/bin && install -m 0755 coc-client coc-agent ~/.local/bin/\n'
            'Auto-update: enabled by default; set autoUpdate: false in the configuration to disable.\n'
            'Configure Codex under the Agent user before agent login.\n'
            'Login: coc-client login --relay https://r.xlogic.cc --message "Please grant development server access"\n'
            'Manual: https://r.xlogic.cc/downloads/USER_GUIDE.md\n'
            'Source and checksums: https://r.xlogic.cc/downloads/\n', encoding='utf-8')
        with tarfile.open(output / (name + '.tar.gz'), 'w:gz') as archive:
            archive.add(root, arcname=name)
source_name = f'codex-over-cloudflare-{version}-source.tar.gz'
subprocess.run(['git', 'archive', '--format=tar.gz', f'--prefix=codex-over-cloudflare-{version}/',
                '-o', str(output / source_name), 'HEAD'], check=True)
shutil.copy2('docs/USER_GUIDE.md', output / 'USER_GUIDE.md')
archives = sorted([*output.glob('*.tar.gz'), *output.glob('*.zip')])
(output / 'SHA256SUMS').write_bytes(''.join(
    hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n' for path in archives).encode('utf-8'))
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
(output / 'index.json').write_text(json.dumps({
    'version': version, 'commit': commit, 'sourceDigest': metadata['sourceDigest'], 'protocol': metadata['protocol'], 'files': [path.name for path in archives],
    'checksums': 'SHA256SUMS', 'manual': 'USER_GUIDE.md',
}, indent=2) + '\n')
links = ''.join(f'<li><a href="{path.name}">{path.name}</a></li>' for path in archives)
(output / 'index.html').write_text(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex Downloads</title>'
    f'<h1>Codex over Cloudflare {version}</h1><p>Linux x86_64 / Windows x64；按系统选择安装包。</p>'
    f'<ul>{links}<li><a href="SHA256SUMS">SHA256SUMS</a></li>'
    '<li><a href="USER_GUIDE.md">用户手册</a></li></ul></html>', encoding='utf-8')
print('Release files prepared:', ', '.join(path.name for path in archives))
