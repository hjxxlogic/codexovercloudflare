"""Build and bind host-only review artifacts to one clean source identity. Never publishes."""
import argparse
import hashlib
import json
import pathlib
import platform
import shutil
import subprocess
import sys
import tarfile

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()
output = args.output.resolve()
if output.exists():
    parser.error('Output must not already exist')


def run(command):
    subprocess.run(command, cwd=ROOT, check=True)


def identity():
    return json.loads(subprocess.check_output([sys.executable, 'scripts/build-metadata.py'], cwd=ROOT))


build = identity()
if build['dirty'] or build['target'] != 'linux-x86_64':
    parser.error('Requires a clean local Linux x86_64 source tree')
# This label deliberately cannot masquerade as another distribution's release.
label = 'local-' + platform.freedesktop_os_release()['ID'] + platform.freedesktop_os_release()['VERSION_ID']
run(['npm', 'run', 'build'])  # Includes Worker dry-run only.
if identity() != build:
    parser.error('Source changed while building; artifacts cannot be certified')
for program in ('coc-agent', 'coc-client'):
    actual = json.loads(subprocess.check_output([ROOT / 'build' / program, '--version']))
    if actual != build:
        parser.error(program + ' identity differs from the clean source')
run([sys.executable, 'scripts/package-release.py', '--platform', label])
downloads = ROOT / 'dist/web/downloads'
manifest = json.loads((downloads / 'index.json').read_text())
for key in ('version', 'commit', 'sourceDigest', 'protocol'):
    if manifest[key] != build[key]:
        parser.error('Download manifest identity mismatch: ' + key)
# Verify the source archive from actual archived bytes, including symlinks.
source = downloads / f"codex-over-cloudflare-{build['version']}-source.tar.gz"
prefix = f"codex-over-cloudflare-{build['version']}/"
entries = {}
with tarfile.open(source) as archive:
    for member in archive.getmembers():
        if member.isdir():
            continue
        if not member.name.startswith(prefix):
            parser.error('Unexpected source archive prefix')
        name = member.name[len(prefix):]
        if member.issym():
            entries[name.encode()] = member.linkname.encode()
        elif member.isfile():
            entries[name.encode()] = archive.extractfile(member).read()
source_digest = hashlib.sha256()
for name, body in sorted(entries.items()):
    source_digest.update(name + b'\0' + body + b'\0')
if source_digest.hexdigest() != build['sourceDigest']:
    parser.error('Source archive bytes do not reproduce the source digest')
native_package = 'coc-' + build['version'] + '-linux-x86_64-' + label
with tarfile.open(downloads / (native_package + '.tar.gz')) as archive:
    for program in ('coc-agent', 'coc-client'):
        packaged = archive.extractfile(native_package + '/' + program).read()
        if hashlib.sha256(packaged).digest() != hashlib.sha256((ROOT / 'build' / program).read_bytes()).digest():
            parser.error('Packaged executable differs from the verified native build')
for line in (downloads / 'SHA256SUMS').read_text().splitlines():
    digest, name = line.split('  ', 1)
    if pathlib.Path(name).name != name or hashlib.sha256((downloads / name).read_bytes()).hexdigest() != digest:
        parser.error('Archive checksum mismatch')
output.mkdir(parents=True, mode=0o700)
shutil.copytree(ROOT / 'dist/web', output / 'web')
shutil.copytree(ROOT / 'dist/worker', output / 'worker')
files = {}
for path in sorted(output.rglob('*')):
    if path.is_file():
        files[path.relative_to(output).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
(output / 'SHA256SUMS').write_text(''.join(f'{digest}  {name}\n' for name, digest in files.items()))
(output / 'build.json').write_text(json.dumps({
    'build': build, 'scope': 'host-only-local-review', 'platform': label,
    'published': False, 'githubActions': False, 'otherPlatformsVerified': False,
    'files': files,
}, indent=2) + '\n')
if identity() != build:
    parser.error('Source changed while packaging; do not use this candidate')
print(json.dumps({'candidate': str(output), 'build': build, 'files': len(files), 'localOnly': True}))
