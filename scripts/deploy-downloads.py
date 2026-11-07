"""Publish CI or explicitly requested local Linux downloads, preserving the live Worker and web."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('cloud', ROOT / 'scripts/deploy-cloud.py')
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)
agent = cloud.agent


def check_native_inputs(package_commit, worker_commit):
    changed = subprocess.check_output(['git', 'diff', '--name-only', package_commit,
                                       worker_commit], cwd=ROOT, text=True).splitlines()
    names = {'CMakeLists.txt', 'package.json', 'package-lock.json',
             '.github/workflows/checks.yml', 'scripts/build-metadata.py', 'scripts/build-access.py'}
    relevant = [p for p in changed if p in names or
                p.startswith(('native/', 'config/', 'cmake/', 'Dockerfile', 'vcpkg'))]
    if relevant:
        raise RuntimeError('CI native inputs differ from the live source: ' + ', '.join(relevant))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deployment', type=pathlib.Path, required=True,
                        help='Successful cloud deployment.json for the currently running Worker/web')
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--run-id', type=int)
    source.add_argument('--local-build-dir', type=pathlib.Path,
                        help='Explicitly skip Actions and publish local static Linux packages, preserving Windows')
    parser.add_argument('--repository', default='hjxxlogic/codexovercloudflare')
    parser.add_argument('--gh-proxy', action='store_true', help='Accelerate public artifacts via gh-proxy.org; never send credentials')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.gh_proxy and args.local_build_dir:
        parser.error('--gh-proxy requires --run-id')
    if args.gh_proxy:
        public = json.loads(agent.curl('https://api.github.com/repos/' + args.repository))
        if public.get('private') is not False:
            raise RuntimeError('GH-Proxy is limited to public repositories')
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT):
        raise RuntimeError('Deployment tool requires a clean working tree')
    prior = json.loads(args.deployment.read_text())
    if not prior.get('applied') or not isinstance(prior.get('verification'), dict) or not prior['verification'].get('publicAssetBytesMatch'):
        raise RuntimeError('A successfully verified cloud deployment is required')
    if args.local_build_dir:
        identity = json.loads(subprocess.check_output(
            [sys.executable, 'scripts/build-metadata.py'], cwd=ROOT, text=True))
        if identity['dirty']:
            raise RuntimeError('Local publication requires clean source')
        run, jobs = None, []
        output_name = 'local-' + identity['commit']
    else:
        run = agent.api(args.repository, 'runs/' + str(args.run_id))
        if run['status'] != 'completed':
            raise RuntimeError('Only completed Actions runs are accepted; no waiting performed')
        agent.check_run(run, run['head_sha'])
        jobs = agent.api(args.repository, 'runs/' + str(args.run_id) + '/jobs?per_page=100')['jobs']
        agent.check_jobs(jobs)
        check_native_inputs(run['head_sha'], prior['sourceIdentity']['commit'])
        output_name = str(args.run_id)
    original = args.deployment.resolve().parent
    config = json.loads((original / 'deploy.json').read_text())
    cloud.validate_storage_config(config)
    if config['routes'] != [{'pattern': 'r.xlogic.cc', 'custom_domain': True}]:
        raise RuntimeError('Expected the explicit production custom domain')
    before = cloud.verify_existing_worker(config, original / 'worker')
    output = ROOT / '.local/deploy-downloads' / output_name
    output.mkdir(parents=True, exist_ok=True)
    for name in ('worker', 'site'):
        destination = output / name
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(original / name, destination)
    if args.local_build_dir:
        cache = output / 'previous-downloads'
        cache.mkdir(exist_ok=True)
        previous = cloud.preserve_downloads(prior['target'], output / 'site', cache)
        manifest = cloud.publish_local_native(args.local_build_dir.resolve(), identity,
                                              output, output / 'site', previous)
        selected = []
    else:
        artifacts = agent.api(args.repository, 'runs/' + str(args.run_id) + '/artifacts?per_page=100')['artifacts']
        platforms = sorted({'linux-ubuntu20.04', 'linux-debian12', 'linux-musl', 'windows-x64'})
        def download(platform):
            matches = [a for a in artifacts if a['name'] == platform and not a['expired']]
            if len(matches) != 1:
                raise RuntimeError('Expected one unexpired artifact for ' + platform)
            artifact = matches[0]
            archive = output / (platform + '.zip')
            digest = artifact.get('digest', '')
            if not digest.startswith('sha256:'):
                raise RuntimeError('GitHub artifact digest is required')
            if not archive.exists() or 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
                url = ('https://gh-proxy.org/https://github.com/' + args.repository +
                       '/actions/runs/' + str(args.run_id) + '/artifacts/' + str(artifact['id'])
                       if args.gh_proxy else 'https://nightly.link/' + args.repository +
                       '/actions/artifacts/' + str(artifact['id']) + '.zip')
                agent.curl(url, archive)
            if 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
                raise RuntimeError('Artifact digest mismatch: ' + platform)
            print('Downloaded and digest-verified ' + platform, flush=True)
            return platform, artifact, archive, digest
        with ThreadPoolExecutor(max_workers=4) as pool:
            downloaded = list(pool.map(download, platforms))
        bundles, selected, identity = {}, [], None
        for platform, artifact, archive, digest in downloaded:
            with zipfile.ZipFile(archive) as bundle:
                manifest = json.loads(bundle.read('index.json'))
            if manifest.get('commit') != run['head_sha'] or manifest.get('protocol') != 1:
                raise RuntimeError('Native manifest does not match the completed run')
            identity = identity or manifest
            bundles[platform] = (archive, digest)
            selected.append({'name': platform, 'id': artifact['id'], 'digest': digest})
        manifest = cloud.publish_downloads(bundles, identity, output / 'site')
    config['main'] = str(output / 'worker/index.js')
    config['assets']['directory'] = str(output / 'site')
    config['vars'] = {}  # Preserve production variables and secrets via --keep-vars.
    config_path = output / 'deploy.json'
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    evidence = {'run': run['html_url'] if run else None, 'jobs': jobs, 'artifacts': selected,
                'sourceIdentity': prior['sourceIdentity'], 'preservedWorker': before,
                'nativeIdentity': {k: identity[k] for k in ('version', 'commit', 'sourceDigest', 'protocol')},
                'nativeCiVerified': not args.local_build_dir, 'nativeInputsMatch': not args.local_build_dir,
                'localBuild': bool(args.local_build_dir), 'ciVerified': not args.local_build_dir, 'ghProxy': args.gh_proxy,
                'deploymentToolCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'target': prior['target'], 'applied': False, 'verification': 'pending'}
    evidence_path = output / 'deployment.json'
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Prepared native downloads from ' + identity['commit'] +
          (' (local Linux; Actions skipped; Windows preserved)' if args.local_build_dir else ' (CI verified)'), flush=True)
    if not args.apply:
        return
    result = subprocess.run(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
        '--config', str(config_path), '--no-bundle', '--keep-vars', '--message',
        ('Local Linux downloads ' + identity['commit'] if args.local_build_dir else 'CI native downloads ' + str(args.run_id)) +
        '; preserve Worker ' + prior['sourceIdentity']['commit']],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (output / 'wrangler.log').write_text(result.stdout)
    print(result.stdout, flush=True)
    result.check_returncode()
    evidence['applied'] = True
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    if cloud.verify_existing_worker(config, output / 'worker') != before:
        raise RuntimeError('Worker changed during native download publication')
    for name in ['index.json', 'SHA256SUMS', 'index.html', 'USER_GUIDE.md', *manifest['files']]:
        expected = (output / 'site/downloads' / name).read_bytes()
        actual = agent.curl(prior['target'] + '/downloads/' + ('' if name == 'index.html' else name))
        if hashlib.sha256(actual).digest() != hashlib.sha256(expected).digest():
            raise RuntimeError('Published download mismatch: ' + name)
    evidence['verification'] = 'passed'
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Published and verified native downloads; Worker modules preserved; ' +
          ('local Linux, previous Windows' if args.local_build_dir else 'all four CI platforms'))


if __name__ == '__main__':
    main()
