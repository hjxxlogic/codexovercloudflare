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
    (target / 'index.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex Downloads</title><h1>Codex over Cloudflare ' + version + '</h1><p>Linux x86_64 / Windows x64</p>' + notice + '<ul>' + links + '<li><a href="SHA256SUMS">SHA256SUMS</a></li><li><a href="USER_GUIDE.md">用户手册</a></li></ul></html>', encoding='utf-8')
    return manifest


def configure_state_db(config, worker, database_id):
    if not database_id:
        return
    if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', database_id) or database_id.startswith('00000000-'):
        raise RuntimeError('An explicit production D1 database UUID is required')
    migrations = worker / 'state-migrations'
    if not (migrations / '0001_relay_state.sql').is_file():
        raise RuntimeError('Verified Worker artifact does not include the D1 schema')
    backend = config.setdefault('vars', {}).get('STATE_BACKEND', 'do')
    config['vars']['STATE_BACKEND'] = backend
    config['d1_databases'] = [entry for entry in config.get('d1_databases', []) if entry['binding'] != 'STATE_DB'] + [{
        'binding': 'STATE_DB', 'database_name': 'coc-relay-state',
        'database_id': database_id, 'migrations_dir': str(migrations),
    }]
    crons = config.setdefault('triggers', {}).setdefault('crons', [])
    if backend == 'd1' and '17 * * * *' not in crons:
        crons.append('17 * * * *')

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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', default='hjxxlogic/codexovercloudflare')
    parser.add_argument('--commit', default='HEAD')
    parser.add_argument('--run-id', type=int)
    parser.add_argument('--local-build', action='store_true',
                        help='Explicit local Worker/web deployment without CI verification; preserves native downloads')
    parser.add_argument('--timeout', type=int, default=2400)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--cloud-only-after-windows-failure', action='store_true',
                        help='Explicit staged rollout: require the other five checks to pass; preserve all native downloads')
    parser.add_argument('--retire-state-db', action='store_true', help='Remove D1 binding only after live confirmation of completed DO migration')
    parser.add_argument('--state-db-id', help='Override the existing production D1 database UUID in the deployment configuration')
    parser.add_argument('--delete-secret', action='append', default=[],
                        help='Remove an obsolete Worker secret after publishing the verified code')
    parser.add_argument('--preserved-downloads', type=pathlib.Path,
                        help='Previously verified download directory for recovery when the live endpoint is unavailable')
    parser.add_argument('--publish-downloads', action='store_true', help='Publish all four native platforms from this same verified Actions run')
    parser.add_argument('--skip-native-platform', choices=['linux-musl'], help='Explicitly defer musl while preserving its previous verified download; requires --publish-downloads')
    parser.add_argument('--notify-release', action='store_true', help='Notify automatic updaters after deployment and all online package checks pass')
    parser.add_argument('--owner-secret-file', type=pathlib.Path, help='Private owner secret file used only for release notification')
    args = parser.parse_args()
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
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT):
        raise RuntimeError('Deployment requires a clean working tree')
    tool_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    subprocess.run(['git', 'merge-base', '--is-ancestor', commit, tool_commit], cwd=ROOT, check=True)
    if args.local_build:
        if commit != tool_commit:
            raise RuntimeError('Local deployment requires --commit HEAD')
        run, jobs, artifacts = {'id': 'local-' + commit, 'html_url': None}, [], []
        output = ROOT / '.local/deploy-cloud' / str(run['id'])
        output.mkdir(parents=True, exist_ok=True)
        subprocess.run(['npm', 'run', 'build:web'], cwd=ROOT, check=True)
        subprocess.run(['npm', 'run', 'typecheck'], cwd=ROOT, check=True)
        worker = output / 'worker'
        if worker.exists():
            shutil.rmtree(worker)
        subprocess.run(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'),
                        'deploy', '--dry-run', '--outdir', str(worker)], cwd=ROOT, check=True)
        site = output / 'site'
        if site.exists():
            shutil.rmtree(site)
        shutil.copytree(ROOT / 'dist/web', site)
        identity = json.loads(subprocess.check_output(['python3', 'scripts/build-metadata.py'], cwd=ROOT))
        if identity['commit'] != commit or identity['dirty']:
            raise RuntimeError('Local build source changed during compilation')
        shutil.copyfile(ROOT / 'wrangler.jsonc', worker / 'deploy-config.jsonc')
        shutil.copytree(ROOT / 'migrations/d1', worker / 'state-migrations')
        identities = [identity, identity]
        selected = [{'name': folder + '/' + path.relative_to(output / folder).as_posix(),
                     'digest': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()}
                    for folder in ('site', 'worker') for path in sorted((output / folder).rglob('*'))
                    if path.is_file() and 'downloads' not in path.relative_to(output / folder).parts]
    else:
        run, jobs = (completed_cloud_run(args.repository, commit, args.run_id)
                     if args.cloud_only_after_windows_failure else
                     agent.wait_run(args.repository, commit, args.run_id, args.timeout))
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
    config['main'] = str(output / 'worker/index.js')
    config['assets']['directory'] = str(output / 'site')
    args.state_db_id = args.state_db_id or next((entry['database_id'] for entry in
        config.get('d1_databases', []) if entry['binding'] == 'STATE_DB'), None)
    configure_state_db(config, output / 'worker', args.state_db_id)
    if args.retire_state_db:
        if config.get('vars', {}).get('STATE_BACKEND') != 'do':
            raise RuntimeError('D1 retirement requires DO mode')
        migration_base = 'https://' + config['routes'][0]['pattern']
        migration_status = json.loads(agent.curl(migration_base + '/api/v1/healthz?stateMigration=1'))
        if migration_status != {'backend': 'do', 'complete': True}:
            raise RuntimeError('Live DO migration is not complete; D1 binding retained')
        config['d1_databases'] = [entry for entry in config.get('d1_databases', []) if entry['binding'] != 'STATE_DB']
        config.setdefault('triggers', {})['crons'] = []
        args.state_db_id = None

    routes = config['routes']
    if len(routes) != 1 or not routes[0].get('custom_domain') or not re.fullmatch(r'[a-zA-Z0-9.-]+', routes[0]['pattern']):
        raise RuntimeError('Expected one explicit custom domain deployment target')
    base = 'https://' + routes[0]['pattern']
    cache = ROOT / '.local/deploy-cloud/download-cache'
    cache.mkdir(parents=True, exist_ok=True)
    manifest = preserve_downloads(base, output / 'site', cache, args.preserved_downloads)
    published = None
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
    config_path = output / 'deploy.json'
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    evidence = {'commit': commit, 'deploymentToolCommit': tool_commit,
                'localBuild': args.local_build, 'ciVerified': not args.local_build,
                'cloudOnlyAfterWindowsFailure': args.cloud_only_after_windows_failure,
                'skippedNativePlatform': args.skip_native_platform, 'run': run['html_url'], 'jobs': jobs,
                'artifacts': selected, 'sourceDigest': identities[0]['sourceDigest'],
                'target': base, 'preservedDownloads': manifest, 'publishedDownloads': published, 'applied': False}
    if args.retire_state_db:
        evidence['retiredStateDatabaseBinding'] = True
        evidence['migrationVerification'] = migration_status
    if args.state_db_id:
        evidence['stateDatabase'] = args.state_db_id
    if args.preserved_downloads:
        evidence['preservationSource'] = 'previously verified local download snapshot; package SHA256 rechecked'
    evidence_path = output / 'deployment.json'
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    if not args.apply:
        print('Verified artifacts prepared: ' + str(output))
        return
    if args.state_db_id:
        result = subprocess.run(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'),
                                 'd1', 'migrations', 'apply', 'STATE_DB', '--remote', '--config', str(config_path)],
                                cwd=ROOT, input='y\n', text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (output / 'd1-migrations.log').write_text(result.stdout)
        print(result.stdout, flush=True)
        if result.returncode:
            raise RuntimeError('D1 migration failed; Worker was not published')
        evidence['stateSchemaApplied'] = True
        evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
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
    for name in args.delete_secret:
        subprocess.run(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'),
                        'secret', 'delete', name, '--config', str(config_path)],
                       cwd=ROOT, input='y\n', text=True, check=True)
        evidence.setdefault('deletedSecrets', []).append(name)
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
    if args.notify_release:
        evidence['releaseNotification'] = notify_release(base, published, args.owner_secret_file)
        evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Deployed and verified ' + base + ' from ' + commit)


if __name__ == '__main__':
    main()
