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
import os
import sys
import email
import email.policy
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('agent_deploy', ROOT / 'scripts/deploy-agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def release_post(base, path, data, token):
    # Credentials stay in memory, never in subprocess arguments or evidence.
    headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}
    for line in (agent._access.request_headers(base) or b'').decode().splitlines():
        key, value = line.split(': ', 1)
        headers[key] = value
    request = urllib.request.Request(base + path, json.dumps(data).encode(), headers, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
            return json.loads(response.read(65536))
    except urllib.error.HTTPError as error:
        raise RuntimeError('Release API request failed: HTTP ' + str(error.code)) from None


def notify_release(base, manifest, secret_file):
    if os.name != 'nt' and (secret_file.stat().st_mode & 0o077 or secret_file.stat().st_uid != os.geteuid()):
        raise RuntimeError('Owner secret must be private (0600) and owned by the current user')
    secret = secret_file.read_text().strip()
    if len(secret) < 32 or len(secret) > 4096:
        raise RuntimeError('Invalid owner secret file')
    login = release_post(base, '/api/v1/auth/login', {'kind': 'cli', 'secret': secret}, 'cli-login')
    token = login.get('token')
    if not isinstance(token, str) or not token:
        raise RuntimeError('Release login returned no token')
    expected = {key: manifest[key] for key in ('version', 'commit')}
    result = release_post(base, '/api/v1/admin/releases', expected, token)
    if result != expected:
        raise RuntimeError('Release notification identity mismatch')
    return expected


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


def preserve_downloads(base, site, cache, saved=None):
    target = site / 'downloads'
    target.mkdir(exist_ok=True)
    def read(name):
        return (saved / name).read_bytes() if saved else agent.curl(base + '/downloads/' + name)
    manifest_bytes = read('index.json')
    manifest = json.loads(manifest_bytes)
    sums_bytes = read('SHA256SUMS')
    sums = dict(line.split('  ', 1)[::-1] for line in sums_bytes.decode().splitlines())
    for name in manifest['files']:
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]+', name):
            raise RuntimeError('Unsafe published download filename')
        expected = sums.get(name)
        if not expected or not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise RuntimeError('Missing published package checksum')
        cached = cache / name
        if not cached.exists() or hashlib.sha256(cached.read_bytes()).hexdigest() != expected:
            if saved:
                shutil.copyfile(saved / name, cached)
            else:
                agent.curl(base + '/downloads/' + name, cached)
        if hashlib.sha256(cached.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Published package checksum mismatch: ' + name)
        shutil.copyfile(cached, target / name)
    (target / 'index.json').write_bytes(manifest_bytes)
    (target / 'SHA256SUMS').write_bytes(sums_bytes)
    (target / 'index.html').write_bytes(read('index.html') if saved else agent.curl(base + '/downloads/'))
    return manifest



def publish_downloads(bundles, identity, site, skip_musl=False):
    """Publish verified CI packages; an explicit musl deferral preserves its old package."""
    expected = {'linux-ubuntu20.04', 'linux-debian12', 'linux-musl', 'windows-x64'}
    if skip_musl:
        expected.remove('linux-musl')
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
                # Git/gzip versions can produce different compressed bytes for the
                # same source tree. Every platform's digest and source identity was
                # checked above; retain Ubuntu's source archive, as assemble-release.py does.
                if name == source and name in checked:
                    continue
                checked[name] = data
    target = site / 'downloads'
    target.mkdir(exist_ok=True)
    deferred = {}
    if skip_musl:
        previous = json.loads((target / 'index.json').read_text())
        prior_musl = previous.get('deferredPlatforms', {}).get('linux-musl', previous)
        old_version = prior_musl['version']
        if not re.fullmatch(r'\d+\.\d+\.\d+', old_version) or old_version == version:
            raise RuntimeError('Musl deferral requires a distinct previous verified release')
        old_name = 'coc-' + old_version + '-linux-x86_64-musl.tar.gz'
        old_sums = dict(line.split('  ', 1)[::-1] for line in (target / 'SHA256SUMS').read_text().splitlines())
        old_bytes = (target / old_name).read_bytes()
        if old_name not in previous['files'] or hashlib.sha256(old_bytes).hexdigest() != old_sums.get(old_name):
            raise RuntimeError('Deferred musl package checksum mismatch')
        checked[old_name] = old_bytes
        deferred['linux-musl'] = {'version': old_version, 'file': old_name, 'commit': prior_musl['commit']}
    if any(len(data) > 25 * 1024 * 1024 for data in checked.values()):
        raise RuntimeError('Native archive exceeds the 25 MiB static asset limit')
    for name, data in checked.items():
        if (target / name).exists() and (target / name).read_bytes() != data:
            raise RuntimeError('A different archive already exists for this version: ' + name)
    for name, data in checked.items():
        (target / name).write_bytes(data)
    manifest = {key: identity[key] for key in ('version', 'commit', 'sourceDigest', 'protocol')}
    manifest.update(files=sorted(checked), checksums='SHA256SUMS', manual='USER_GUIDE.md')
    if deferred:
        manifest['deferredPlatforms'] = deferred
    (target / 'index.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (target / 'SHA256SUMS').write_text(''.join(hashlib.sha256(checked[name]).hexdigest() + '  ' + name + '\n' for name in sorted(checked)))
    notice = ('<p>musl ' + version + ' 暂缓发布；保留已验证的 ' + deferred['linux-musl']['version'] + ' 下载。</p>') if deferred else ''
    links = ''.join('<li><a href="' + name + '">' + name + '</a></li>' for name in sorted(checked))
    (target / 'index.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codex Downloads</title><link rel="stylesheet" href="./happier-theme.css"><script src="./happier-theme.js"></script><main class="happier-document"><h1>Codex over Cloudflare ' + version + '</h1><p>Linux x86_64 / Windows x64</p>' + notice + '<ul>' + links + '<li><a href="SHA256SUMS">SHA256SUMS</a></li><li><a href="USER_GUIDE.md">用户手册</a></li></ul></main></html>', encoding='utf-8')
    return manifest


def validate_storage_config(config):
    """Reject artifacts configured for removed storage backends."""
    if 'STATE_BACKEND' in config.get('vars', {}) or config.get('d1_databases'):
        raise RuntimeError('Worker artifact must use Durable Objects without a storage backend selector or database binding')
    bindings = {entry['name']: entry['class_name'] for entry in config.get('durable_objects', {}).get('bindings', [])}
    if bindings != {'REGISTRY': 'RegistryDO', 'HOSTS': 'HostRelayDO'}:
        raise RuntimeError('Worker artifact must bind RegistryDO and HostRelayDO')


def publish_local_native(build_dir, identity, output, site, previous):
    """Explicit local static Linux release; keep the previous Windows download."""
    staged = output / 'local-native'
    staged.mkdir(exist_ok=True)
    if any(staged.iterdir()):
        shutil.rmtree(staged)
        staged.mkdir()
    for platform in ('musl', 'ubuntu20.04', 'debian12'):
        subprocess.run([sys.executable, 'scripts/package-release.py', '--build-dir', str(build_dir),
                        '--platform', platform, '--static-linux', '--output', str(staged)],
                       cwd=ROOT, check=True)
    manifest = json.loads((staged / 'index.json').read_text())
    for field in ('version', 'commit', 'sourceDigest', 'protocol'):
        if manifest[field] != identity[field]:
            raise RuntimeError('Local native identity mismatch: ' + field)
    manifest.update(localBuild=True, ciVerified=False, linuxRuntime='static-musl')
    target = site / 'downloads'
    windows = [name for name in previous['files'] if name.endswith('-windows-x64.zip')]
    if len(windows) != 1:
        raise RuntimeError('Expected one previous Windows download')
    name = windows[0]
    manifest['files'].append(name)
    manifest['deferredPlatforms'] = {'windows-x64': {'version': previous['version'],
                                    'commit': previous['commit'], 'file': name}}
    for path in staged.iterdir():
        if path.is_file():
            shutil.copyfile(path, target / path.name)
    (target / 'index.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (target / 'SHA256SUMS').write_text(''.join(hashlib.sha256((target / name).read_bytes()).hexdigest()
                                             + '  ' + name + '\n' for name in sorted(manifest['files'])))
    html = (target / 'index.html').read_text()
    html += '<p>Local static Linux build; GitHub Actions skipped by explicit request. Windows remains at the previous release.</p>'
    html += '<a href="' + name + '">Windows ' + previous['version'] + '</a>'
    (target / 'index.html').write_text(html)
    return manifest


def completed_cloud_run(repository, commit, run_id):
    """Explicit cloud-only exception: all checks except Windows must succeed."""
    run = agent.api(repository, 'runs/' + str(run_id))
    if (run['head_sha'] != commit or run['path'] != '.github/workflows/checks.yml'
            or run['event'] not in ('push', 'workflow_dispatch')
            or run['status'] != 'completed' or run['conclusion'] != 'failure'):
        raise RuntimeError('Cloud-only exception requires a completed matching failed checks run')
    jobs = agent.api(repository, 'runs/' + str(run_id) + '/jobs?per_page=100')['jobs']
    by_name = {job['name']: job for job in jobs}
    if not agent.REQUIRED_JOBS <= by_name.keys():
        raise RuntimeError('Cloud-only run is missing required jobs')
    for name in agent.REQUIRED_JOBS:
        expected = 'failure' if name == 'windows-x64' else 'success'
        if by_name[name]['conclusion'] != expected:
            raise RuntimeError('Cloud-only exception cannot accept job: ' + name)
    return run, jobs


def deployment_target(config, target, access_aud=None, without_access=False):
    """Select the isolated r2 Worker without changing the production configuration."""
    if target == 'production':
        if access_aud or without_access:
            raise RuntimeError('r2 Access options cannot modify production')
        return config
    if target != 'r2' or bool(access_aud) == bool(without_access):
        raise RuntimeError('r2 requires exactly one explicit Access configuration')
    if access_aud and not re.fullmatch(r'[a-f0-9]{64}', access_aud):
        raise RuntimeError('Invalid r2 Access audience')
    config = json.loads(json.dumps(config))
    config['name'] = 'codex-over-cloudflare-r2'
    config['routes'] = [{'pattern': 'r2.xlogic.cc', 'custom_domain': True}]
    config['workers_dev'] = False
    config['preview_urls'] = False
    # Each class belongs to this Worker. Never reference a production namespace.
    for binding in config['durable_objects']['bindings']:
        if set(binding) != {'name', 'class_name'}:
            raise RuntimeError('r2 requires Worker-local Durable Object bindings')
    config['vars']['ACCESS_ENABLED'] = 'false' if without_access else 'true'
    config['vars'].pop('ACCESS_AUD', None)
    if access_aud:
        config['vars']['ACCESS_AUD'] = access_aud
    return config


def verify_existing_worker(config, worker):
    """Compare live modules with a previously verified artifact; never log credentials."""
    token = os.environ.get('CLOUDFLARE_API_TOKEN')
    if not token:
        import tomllib
        credentials = pathlib.Path.home() / '.config/.wrangler/config/default.toml'
        token = tomllib.loads(credentials.read_text())['oauth_token']
    url = ('https://api.cloudflare.com/client/v4/accounts/' + config['account_id'] +
           '/workers/scripts/' + config['name'] + '/content/v2')
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token,
                                                  'Accept': 'multipart/form-data'})
    with urllib.request.urlopen(request, timeout=40) as response:
        content_type, content = response.headers['Content-Type'], response.read()
    message = email.message_from_bytes(('Content-Type: ' + content_type +
                                       '\r\nMIME-Version: 1.0\r\n\r\n').encode() + content,
                                      policy=email.policy.default)
    if not message.is_multipart():
        raise RuntimeError('Expected multipart live Worker modules')
    hashes = {}
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        # Wrangler normalizes debug source maps on upload; compare executable modules.
        if name == 'metadata' or (name and name.endswith('.map')):
            continue
        agent.checked_member(name)
        if name in hashes or not (worker / name).is_file():
            raise RuntimeError('Live Worker module differs from preserved artifact')
        digest = hashlib.sha256(part.get_payload(decode=True)).hexdigest()
        if hashlib.sha256((worker / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError('Live Worker code differs from preserved artifact: ' + name)
        hashes[name] = digest
    if 'index.js' not in hashes:
        raise RuntimeError('Live Worker entry point is missing')
    return hashes


def validate_web_source(previous, target):
    expected_origin = 'https://r2.xlogic.cc' if target == 'r2' else 'https://r.xlogic.cc'
    expected_worker = 'codex-over-cloudflare-r2' if target == 'r2' else 'codex-over-cloudflare'
    if (not previous.get('applied') or
            previous.get('verification', {}).get('publicAssetBytesMatch') is not True or
            previous.get('target') != expected_origin or previous.get('worker') != expected_worker):
        raise RuntimeError('Expected a verified ' + target + ' deployment for Worker preservation')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', default='hjxxlogic/codexovercloudflare')
    parser.add_argument('--commit', default='HEAD')
    parser.add_argument('--initialize-owner-secret-file', type=pathlib.Path, help='Private independent owner secret for first r2 deployment')
    parser.add_argument('--target', choices=['production', 'r2'], default='production')
    parser.add_argument('--r2-access-aud', help='Audience of the independent r2 Access application')
    parser.add_argument('--r2-without-access', action='store_true', help='Explicitly use CoC authentication alone on r2')
    parser.add_argument('--initialize-downloads', action='store_true', help='Initialize a new r2 download site from all four verified CI platforms')
    parser.add_argument('--run-id', type=int)
    parser.add_argument('--local-build', action='store_true',
                        help='Explicit local Worker/web deployment without CI verification; preserves native downloads')
    parser.add_argument('--web-only-from', type=pathlib.Path,
                        help='Reuse the exact live Worker from a verified deployment.json; local web builds only')
    parser.add_argument('--allow-uncommitted', action='store_true',
                        help='Explicitly deploy uncommitted local source, retaining its dirty identity; requires --local-build')
    parser.add_argument('--local-native-build-dir', type=pathlib.Path, help='Explicit local static Linux release; requires --local-build; preserves previous Windows')
    parser.add_argument('--timeout', type=int, default=2400)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--replace-vars', action='store_true',
                        help='Replace plain-text/JSON variables with the verified configuration; Worker secrets are preserved')
    parser.add_argument('--cloud-only-after-windows-failure', action='store_true',
                        help='Explicit staged rollout: require the other five checks to pass; preserve all native downloads')
    parser.add_argument('--delete-secret', action='append', default=[],
                        help='Remove an obsolete Worker secret after publishing the verified code')
    parser.add_argument('--preserved-downloads', type=pathlib.Path,
                        help='Previously verified download directory for recovery when the live endpoint is unavailable')
    parser.add_argument('--publish-downloads', action='store_true', help='Publish all four native platforms from this same verified Actions run')
    parser.add_argument('--skip-native-platform', choices=['linux-musl'], help='Explicitly defer musl while preserving its previous verified download; requires --publish-downloads')
    parser.add_argument('--notify-release', action='store_true', help='Notify automatic updaters after deployment and all online package checks pass')
    parser.add_argument('--owner-secret-file', type=pathlib.Path, help='Private owner secret file used only for release notification')
    args = parser.parse_args()
    previous_web_worker = None
    if args.web_only_from:
        if (not args.local_build or args.replace_vars or
                args.delete_secret or args.initialize_owner_secret_file or args.initialize_downloads or
                args.local_native_build_dir or args.publish_downloads or args.notify_release):
            parser.error('--web-only-from requires --local-build and forbids Worker/config/native changes')
        args.web_only_from = args.web_only_from.resolve()
        previous_web_worker = json.loads(args.web_only_from.read_text())
        validate_web_source(previous_web_worker, args.target)
        old_worker = args.web_only_from.parent / 'worker'
        for artifact in previous_web_worker['artifacts']:
            if artifact['name'].startswith('worker/'):
                path = args.web_only_from.parent / artifact['name']
                agent.checked_member(artifact['name'])
                if 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest() != artifact['digest']:
                    raise RuntimeError('Preserved Worker artifact checksum mismatch')
    if args.initialize_owner_secret_file:
        path = args.initialize_owner_secret_file
        if args.target != 'r2' or not args.initialize_downloads:
            parser.error('Owner initialization is only for a new r2 deployment')
        if os.name != 'nt' and (path.stat().st_mode & 0o077 or path.stat().st_uid != os.geteuid()):
            raise RuntimeError('r2 owner secret file must be private and owned by the current user')
        if not 32 <= len(path.read_text().strip()) <= 4096:
            raise RuntimeError('Invalid r2 owner secret')
    if args.target == 'production' and (args.r2_access_aud or args.r2_without_access):
        parser.error('r2 options cannot modify production')
    if args.target == 'r2' and (bool(args.r2_access_aud) == bool(args.r2_without_access)):
        parser.error('r2 requires exactly one of --r2-access-aud or --r2-without-access')
    if args.initialize_downloads and (args.target != 'r2' or not args.publish_downloads or args.skip_native_platform):
        parser.error('Initialization requires r2 and all four CI native platforms')
    if args.allow_uncommitted and not args.local_build:
        parser.error('--allow-uncommitted requires --local-build')
    if args.local_native_build_dir and not args.local_build:
        parser.error('--local-native-build-dir requires --local-build')
    if args.local_build and (args.run_id or args.cloud_only_after_windows_failure or args.publish_downloads or args.notify_release):
        parser.error('--local-build forbids CI run selection and native publication/notification')
    if args.cloud_only_after_windows_failure and (args.publish_downloads or args.notify_release or not args.run_id):
        parser.error('Cloud-only exception requires --run-id and forbids native publication/notification')
    if args.skip_native_platform and (not args.publish_downloads or args.notify_release):
        parser.error('--skip-native-platform requires --publish-downloads and forbids --notify-release')
    if args.notify_release and (not args.publish_downloads or not args.owner_secret_file):
        parser.error('--notify-release requires --publish-downloads and --owner-secret-file')
    if any(not re.fullmatch(r'[A-Z][A-Z0-9_]{0,127}', name) for name in args.delete_secret):
        parser.error('Invalid secret name')
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', args.repository):
        parser.error('Invalid repository')
    commit = subprocess.check_output(['git', 'rev-parse', '--verify', '--end-of-options',
                                      args.commit + '^{commit}'], cwd=ROOT, text=True).strip()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT) and not args.allow_uncommitted:
        raise RuntimeError('Deployment requires a clean working tree')
    tool_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    subprocess.run(['git', 'merge-base', '--is-ancestor', commit, tool_commit], cwd=ROOT, check=True)
    if args.local_build:
        if commit != tool_commit:
            raise RuntimeError('Local deployment requires --commit HEAD')
        before = json.loads(subprocess.check_output(['python3', 'scripts/build-metadata.py'], cwd=ROOT))
        run, jobs, artifacts = {'id': 'local-' + commit + '-' + before['sourceDigest'][:12], 'html_url': None}, [], []
        output = ROOT / '.local/deploy-cloud' / (str(run['id']) + ('-web-only' if args.web_only_from else '') + ('-r2' if args.target == 'r2' else ''))
        output.mkdir(parents=True, exist_ok=True)
        subprocess.run(['npm', 'run', 'build:web'], cwd=ROOT, check=True)
        subprocess.run(['npm', 'run', 'typecheck'], cwd=ROOT, check=True)
        worker = output / 'worker'
        if worker.exists():
            shutil.rmtree(worker)
        if args.web_only_from:
            shutil.copytree(old_worker, worker)
        else:
            subprocess.run(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'),
                            'deploy', '--dry-run', '--outdir', str(worker)], cwd=ROOT, check=True)
        site = output / 'site'
        if site.exists():
            shutil.rmtree(site)
        shutil.copytree(ROOT / 'dist/web', site)
        identity = json.loads(subprocess.check_output(['python3', 'scripts/build-metadata.py'], cwd=ROOT))
        if identity != before or identity['commit'] != commit or (identity['dirty'] and not args.allow_uncommitted):
            raise RuntimeError('Local build source changed during compilation')
        if not args.web_only_from:
            shutil.copyfile(ROOT / 'wrangler.jsonc', worker / 'deploy-config.jsonc')
        identities = [identity, identity]
        selected = [{'name': folder + '/' + path.relative_to(output / folder).as_posix(),
                     'digest': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()}
                    for folder in ('site', 'worker') for path in sorted((output / folder).rglob('*'))
                    if path.is_file() and 'downloads' not in path.relative_to(output / folder).parts]
    else:
        run, jobs = (completed_cloud_run(args.repository, commit, args.run_id)
                     if args.cloud_only_after_windows_failure else
                     agent.wait_run(args.repository, commit, args.run_id, args.timeout))
        output = ROOT / '.local/deploy-cloud' / (str(run['id']) + ('-r2' if args.target == 'r2' else ''))
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
            if not archive.exists() or 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest() != artifact['digest']:
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
    if args.web_only_from:
        config = json.loads((args.web_only_from.parent / 'deploy.json').read_text())
        if args.target == 'r2' and (config['vars'].get('ACCESS_AUD', previous_web_worker.get('preservedAccessAudience')) != args.r2_access_aud or args.r2_without_access):
            raise RuntimeError('Web-only deployment must preserve the existing Access audience')
        if (config['name'] != previous_web_worker['worker'] or
                config['routes'] != [{'pattern': previous_web_worker['target'][len('https://'):], 'custom_domain': True}]):
            raise RuntimeError('Web-only configuration does not match the verified target')
    config = deployment_target(config, args.target, args.r2_access_aud, args.r2_without_access)
    preserved_code = verify_existing_worker(config, output / 'worker') if args.web_only_from else None
    if args.web_only_from:
        config['vars'] = {}  # --keep-vars retains the live variables without overwriting them.
    config['main'] = str(output / 'worker/index.js')
    config['assets']['directory'] = str(output / 'site')
    validate_storage_config(config)

    routes = config['routes']
    if len(routes) != 1 or not routes[0].get('custom_domain') or not re.fullmatch(r'[a-zA-Z0-9.-]+', routes[0]['pattern']):
        raise RuntimeError('Expected one explicit custom domain deployment target')
    base = 'https://' + routes[0]['pattern']
    cache = ROOT / '.local/deploy-cloud' / ('download-cache-r2' if args.target == 'r2' else 'download-cache')
    cache.mkdir(parents=True, exist_ok=True)
    manifest = None if args.initialize_downloads else preserve_downloads(base, output / 'site', cache, args.preserved_downloads)
    if args.web_only_from:
        for name in ('USER_GUIDE.md', 'happier-theme.css', 'happier-theme.js'):
            (output / 'site/downloads' / name).write_bytes(agent.curl(base + '/downloads/' + name))
    elif args.local_build:
        shutil.copyfile(ROOT / 'docs/USER_GUIDE.md', output / 'site/downloads/USER_GUIDE.md')
    published = None
    if args.local_native_build_dir:
        published = publish_local_native(args.local_native_build_dir.resolve(), identities[0], output, output / 'site', manifest)
    if args.publish_downloads:
        bundles = {}
        for name in ('linux-ubuntu20.04', 'linux-debian12', 'linux-musl', 'windows-x64'):
            if name == args.skip_native_platform:
                continue
            matches = [artifact for artifact in artifacts if artifact['name'] == name and not artifact['expired']]
            if len(matches) != 1:
                raise RuntimeError('Expected exactly one ' + name + ' artifact')
            artifact = matches[0]
            archive = output / (name + '.zip')
            if not archive.exists() or 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest() != artifact['digest']:
                agent.curl('https://nightly.link/' + args.repository + '/actions/artifacts/' + str(artifact['id']) + '.zip', archive)
            bundles[name] = (archive, artifact['digest'])
            selected.append({'name': name, 'id': artifact['id'], 'digest': artifact['digest']})
        published = publish_downloads(bundles, identities[0], output / 'site', bool(args.skip_native_platform))
    # Downloads are public, while root assets can require Access admission.
    for name in ('happier-theme.css', 'happier-theme.js'):
        theme_asset = output / 'site' / name
        if theme_asset.is_file() and not args.web_only_from:
            shutil.copyfile(theme_asset, output / 'site/downloads' / name)
    config_path = output / 'deploy.json'
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    evidence = {'commit': commit, 'deploymentToolCommit': tool_commit,
                'localBuild': args.local_build, 'ciVerified': not args.local_build,
                'sourceIdentity': identities[0], 'allowUncommitted': args.allow_uncommitted,
                'replaceVariables': args.replace_vars,
                'cloudOnlyAfterWindowsFailure': args.cloud_only_after_windows_failure,
                'skippedNativePlatform': args.skip_native_platform, 'run': run['html_url'], 'jobs': jobs,
                'artifacts': selected, 'sourceDigest': identities[0]['sourceDigest'],
                'worker': config['name'], 'initializeDownloads': args.initialize_downloads,
                'target': base, 'preservedDownloads': manifest, 'publishedDownloads': published, 'applied': False}
    if args.web_only_from:
        evidence['webOnly'] = True
        evidence['preservedAccessAudience'] = args.r2_access_aud
        evidence['preservedWorker'] = {
            'sourceIdentity': previous_web_worker.get('preservedWorker', {}).get('sourceIdentity', previous_web_worker['sourceIdentity']),
            'moduleHashes': preserved_code,
        }
    if args.preserved_downloads:
        evidence['preservationSource'] = 'previously verified local download snapshot; package SHA256 rechecked'
    evidence_path = output / 'deployment.json'
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    if not args.apply:
        print('Verified artifacts prepared: ' + str(output))
        return
    command = ['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
               '--config', str(config_path), '--no-bundle',
               *([] if args.replace_vars else ['--keep-vars']),
               '--message', ('Local source ' + identities[0]['sourceDigest'] if args.local_build else
                             'Actions ' + str(run['id'])) + ' commit ' + commit]
    result = subprocess.run(command, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (output / 'wrangler.log').write_text(result.stdout)
    print(result.stdout, flush=True)
    if result.returncode:
        raise RuntimeError('Wrangler deployment failed; inspect local evidence')
    if args.initialize_owner_secret_file:
        subprocess.run(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'),
                        'secret', 'put', 'OWNER_SECRET', '--config', str(config_path)],
                       cwd=ROOT, input=args.initialize_owner_secret_file.read_text().strip() + '\n',
                       text=True, check=True)
        evidence['independentOwnerSecretInitialized'] = True
    evidence['applied'] = True
    evidence['verification'] = 'pending'
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    for name in args.delete_secret:
        subprocess.run(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'),
                        'secret', 'delete', name, '--config', str(config_path)],
                       cwd=ROOT, input='y\n', text=True, check=True)
        evidence.setdefault('deletedSecrets', []).append(name)
        evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    if args.web_only_from:
        if verify_existing_worker(config, output / 'worker') != preserved_code:
            raise RuntimeError('Worker module set changed during Web-only deployment')
        evidence['preservedWorker']['verifiedAfterDeploy'] = True
    health = json.loads(agent.curl(base + '/api/v1/healthz'))
    for path in [output / 'site/index.html', *sorted((output / 'site/assets').glob('*')),
                 *[output / 'site' / name for name in ('happier-theme.css', 'happier-theme.js', 'happier-LICENSE.txt')],
                 *[output / 'site/downloads' / name for name in ('index.html', 'happier-theme.css', 'happier-theme.js')],
                 output / 'site/downloads/USER_GUIDE.md', output / 'site/downloads/index.json',
                 output / 'site/downloads/SHA256SUMS']:
        relative = path.relative_to(output / 'site').as_posix()
        asset_path = '/' + (relative[:-len('index.html')] if path.name == 'index.html' else relative)
        if path.is_file() and agent.curl(base + asset_path) != path.read_bytes():
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
    if args.notify_release:
        evidence['releaseNotification'] = notify_release(base, published, args.owner_secret_file)
        evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Deployed and verified ' + base + ' from ' + commit)


if __name__ == '__main__':
    main()
