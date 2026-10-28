"""Deploy digest-verified Actions Worker/web artifacts, preserving published downloads."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import stat
import subprocess
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('agent_deploy', ROOT / 'scripts/deploy-agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


def unpack(archive, digest, commit, output):
    if digest != 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest():
        raise RuntimeError('Artifact SHA256 mismatch')
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        if len(set(names)) != len(names):
            raise RuntimeError('Duplicate artifact paths')
        if sum(i.file_size for i in bundle.infolist()) > 512 * 1024 * 1024:
            raise RuntimeError('Artifact exceeds extraction limit')
        for info in bundle.infolist():
            agent.checked_member(info.filename)
            if '\\' in info.filename or stat.S_ISLNK(info.external_attr >> 16):
                raise RuntimeError('Unsafe artifact member')
        identity = json.loads(bundle.read('deploy-source.json'))
        if identity['commit'] != commit or identity['dirty'] or identity['protocol'] != 1:
            raise RuntimeError('Artifact source identity mismatch')
        bundle.extractall(output)
    return identity


def preserve_downloads(base, site, cache):
    target = site / 'downloads'
    target.mkdir(exist_ok=True)
    manifest_bytes = agent.curl(base + '/downloads/index.json')
    manifest = json.loads(manifest_bytes)
    sums_bytes = agent.curl(base + '/downloads/SHA256SUMS')
    sums = dict(line.split('  ', 1)[::-1] for line in sums_bytes.decode().splitlines())
    for name in manifest['files']:
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]+', name):
            raise RuntimeError('Unsafe published download filename')
        expected = sums.get(name)
        if not expected or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise RuntimeError('Missing published package checksum')
        cached = cache / name
        if not cached.exists() or hashlib.sha256(cached.read_bytes()).hexdigest() != expected:
            agent.curl(base + '/downloads/' + name, cached)
        if hashlib.sha256(cached.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Published package checksum mismatch: ' + name)
        shutil.copyfile(cached, target / name)
    (target / 'index.json').write_bytes(manifest_bytes)
    (target / 'SHA256SUMS').write_bytes(sums_bytes)
    (target / 'index.html').write_bytes(agent.curl(base + '/downloads/'))
    return manifest



def publish_downloads(bundles, identity, site):
    """Publish only digest-verified, same-source packages from all four CI platforms."""
    expected = {'linux-ubuntu20.04', 'linux-debian12', 'linux-musl', 'windows-x64'}
    if set(bundles) != expected:
        raise RuntimeError('All four verified native platforms are required')
    version = identity['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise RuntimeError('Invalid release version')
    source = 'codex-over-cloudflare-' + version + '-source.tar.gz'
    checked = {}
    for platform, (archive, digest) in bundles.items():
        if digest != 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest():
            raise RuntimeError('Native artifact SHA256 mismatch')
        with zipfile.ZipFile(archive) as bundle:
            names = bundle.namelist()
            if len(names) != len(set(names)) or sum(info.file_size for info in bundle.infolist()) > 512 * 1024 * 1024:
                raise RuntimeError('Invalid native artifact entries')
            for info in bundle.infolist():
                agent.checked_member(info.filename)
                if '\\' in info.filename or stat.S_ISLNK(info.external_attr >> 16):
                    raise RuntimeError('Unsafe native artifact member')
            manifest = json.loads(bundle.read('index.json'))
            for field in ('version', 'commit', 'sourceDigest', 'protocol'):
                if manifest.get(field) != identity[field]:
                    raise RuntimeError('Native artifact source mismatch: ' + platform + ' ' + field)
            package = ('coc-' + version + '-windows-x64.zip' if platform == 'windows-x64'
                       else 'coc-' + version + '-linux-x86_64-' + platform[len('linux-'):] + '.tar.gz')
            sums = dict(line.split('  ', 1)[::-1] for line in bundle.read('SHA256SUMS').decode().splitlines())
            for name in (package, source):
                if name not in manifest.get('files', []) or name not in sums:
                    raise RuntimeError('Missing native release input: ' + name)
                data = bundle.read(name)
                if hashlib.sha256(data).hexdigest() != sums[name]:
                    raise RuntimeError('Native package SHA256 mismatch')
                if name in checked and checked[name] != data:
                    raise RuntimeError('Platform source archives differ')
                checked[name] = data
    target = site / 'downloads'
    target.mkdir(exist_ok=True)
    for name, data in checked.items():
        if (target / name).exists() and (target / name).read_bytes() != data:
            raise RuntimeError('A different archive already exists for this version: ' + name)
    for name, data in checked.items():
        (target / name).write_bytes(data)
    manifest = {key: identity[key] for key in ('version', 'commit', 'sourceDigest', 'protocol')}
    manifest.update(files=sorted(checked), checksums='SHA256SUMS', manual='USER_GUIDE.md')
    (target / 'index.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (target / 'SHA256SUMS').write_text(''.join(hashlib.sha256(checked[name]).hexdigest() + '  ' + name + '\n' for name in sorted(checked)))
    links = ''.join('<li><a href="' + name + '">' + name + '</a></li>' for name in sorted(checked))
    (target / 'index.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex Downloads</title><h1>Codex over Cloudflare ' + version + '</h1><p>Linux x86_64 / Windows x64</p><ul>' + links + '<li><a href="SHA256SUMS">SHA256SUMS</a></li><li><a href="USER_GUIDE.md">用户手册</a></li></ul></html>', encoding='utf-8')
    return manifest

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', default='hjxxlogic/codexovercloudflare')
    parser.add_argument('--commit', default='HEAD')
    parser.add_argument('--run-id', type=int)
    parser.add_argument('--timeout', type=int, default=2400)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--publish-downloads', action='store_true', help='Publish all four native platforms from this same verified Actions run')
    args = parser.parse_args()
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', args.repository):
        parser.error('Invalid repository')
    commit = subprocess.check_output(['git', 'rev-parse', '--verify', '--end-of-options',
                                      args.commit + '^{commit}'], cwd=ROOT, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT):
        raise RuntimeError('Deployment requires a clean working tree')
    if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip() != commit:
        raise RuntimeError('Checkout the requested commit before deployment')
    run, jobs = agent.wait_run(args.repository, commit, args.run_id, args.timeout)
    output = ROOT / '.local/deploy-cloud' / str(run['id'])
    output.mkdir(parents=True, exist_ok=True)
    artifacts = agent.api(args.repository, 'runs/' + str(run['id']) + '/artifacts?per_page=100')['artifacts']
    identities = []
    selected = []
    for name, folder in [('verified-web', 'site'), ('verified-worker', 'worker')]:
        matches = [a for a in artifacts if a['name'] == name and not a['expired']]
        if len(matches) != 1:
            raise RuntimeError('Expected exactly one ' + name + ' artifact')
        artifact = matches[0]
        archive = output / (name + '.zip')
        agent.curl('https://nightly.link/' + args.repository + '/actions/artifacts/' + str(artifact['id']) + '.zip', archive)
        destination = output / folder
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir()
        identities.append(unpack(archive, artifact['digest'], commit, destination))
        selected.append({'name': name, 'id': artifact['id'], 'digest': artifact['digest']})
    if identities[0]['sourceDigest'] != identities[1]['sourceDigest']:
        raise RuntimeError('Worker and web source digests differ')
    config = json.loads(re.sub(r',(\s*[}\]])', r'\1',
                               (output / 'worker/deploy-config.jsonc').read_text()))
    # The deployment configuration is archived by CI along with the Worker.
    config['main'] = str(output / 'worker/index.js')
    config['assets']['directory'] = str(output / 'site')
    routes = config['routes']
    if len(routes) != 1 or not routes[0].get('custom_domain') or not re.fullmatch(r'[a-zA-Z0-9.-]+', routes[0]['pattern']):
        raise RuntimeError('Expected one explicit custom domain deployment target')
    base = 'https://' + routes[0]['pattern']
    cache = ROOT / '.local/deploy-cloud/download-cache'
    cache.mkdir(parents=True, exist_ok=True)
    manifest = preserve_downloads(base, output / 'site', cache)
    published = None
    if args.publish_downloads:
        bundles = {}
        for name in ('linux-ubuntu20.04', 'linux-debian12', 'linux-musl', 'windows-x64'):
            matches = [artifact for artifact in artifacts if artifact['name'] == name and not artifact['expired']]
            if len(matches) != 1:
                raise RuntimeError('Expected exactly one ' + name + ' artifact')
            artifact = matches[0]
            archive = output / (name + '.zip')
            agent.curl('https://nightly.link/' + args.repository + '/actions/artifacts/' + str(artifact['id']) + '.zip', archive)
            bundles[name] = (archive, artifact['digest'])
            selected.append({'name': name, 'id': artifact['id'], 'digest': artifact['digest']})
        published = publish_downloads(bundles, identities[0], output / 'site')
    config_path = output / 'deploy.json'
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    evidence = {'commit': commit, 'run': run['html_url'], 'jobs': jobs,
                'artifacts': selected, 'sourceDigest': identities[0]['sourceDigest'],
                'target': base, 'preservedDownloads': manifest, 'publishedDownloads': published, 'applied': False}
    evidence_path = output / 'deployment.json'
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    if not args.apply:
        print('Verified artifacts prepared: ' + str(output))
        return
    command = ['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
               '--config', str(config_path), '--no-bundle', '--keep-vars',
               '--message', 'Actions ' + str(run['id']) + ' commit ' + commit]
    result = subprocess.run(command, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (output / 'wrangler.log').write_text(result.stdout)
    print(result.stdout, flush=True)
    if result.returncode:
        raise RuntimeError('Wrangler deployment failed; inspect local evidence')
    evidence['applied'] = True
    evidence['verification'] = 'pending'
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    health = json.loads(agent.curl(base + '/api/v1/healthz'))
    for path in [output / 'site/index.html', *sorted((output / 'site/assets').glob('*')),
                 output / 'site/downloads/USER_GUIDE.md', output / 'site/downloads/index.json',
                 output / 'site/downloads/SHA256SUMS']:
        if path.is_file() and agent.curl(base + ('/' if path == output / 'site/index.html' else '/' + path.relative_to(output / 'site').as_posix())) != path.read_bytes():
            raise RuntimeError('Online asset differs from staged artifact: ' + path.name)
    if published:
        hashes = {}
        for name in published['files']:
            downloaded = output / ('online-' + name)
            agent.curl(base + '/downloads/' + name, downloaded)
            checksum = hashlib.sha256(downloaded.read_bytes()).hexdigest()
            if checksum != hashlib.sha256((output / 'site/downloads' / name).read_bytes()).hexdigest():
                raise RuntimeError('Online native archive differs from checked CI artifact')
            hashes[name] = checksum
        evidence['nativeChecksums'] = hashes
    evidence['verification'] = {'health': health, 'publicAssetBytesMatch': True}
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Deployed and verified ' + base + ' from ' + commit)


if __name__ == '__main__':
    main()
