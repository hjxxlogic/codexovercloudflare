"""Publish completed CI native artifacts while preserving the verified live Worker and web."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import shutil
import subprocess
import zipfile

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
    parser.add_argument('--run-id', type=int, required=True)
    parser.add_argument('--repository', default='hjxxlogic/codexovercloudflare')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT):
        raise RuntimeError('Deployment tool requires a clean working tree')
    prior = json.loads(args.deployment.read_text())
    if not prior.get('applied') or not isinstance(prior.get('verification'), dict) or not prior['verification'].get('publicAssetBytesMatch'):
        raise RuntimeError('A successfully verified cloud deployment is required')
    run = agent.api(args.repository, 'runs/' + str(args.run_id))
    if run['status'] != 'completed':
        raise RuntimeError('Only completed Actions runs are accepted; no waiting performed')
    agent.check_run(run, run['head_sha'])
    jobs = agent.api(args.repository, 'runs/' + str(args.run_id) + '/jobs?per_page=100')['jobs']
    agent.check_jobs(jobs)
    check_native_inputs(run['head_sha'], prior['sourceIdentity']['commit'])
    original = args.deployment.resolve().parent
    config = json.loads((original / 'deploy.json').read_text())
    cloud.validate_storage_config(config)
    if config['routes'] != [{'pattern': 'r.xlogic.cc', 'custom_domain': True}]:
        raise RuntimeError('Expected the explicit production custom domain')
    before = cloud.verify_existing_worker(config, original / 'worker')
    output = ROOT / '.local/deploy-downloads' / str(args.run_id)
    output.mkdir(parents=True, exist_ok=True)
    for name in ('worker', 'site'):
        destination = output / name
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(original / name, destination)
    artifacts = agent.api(args.repository, 'runs/' + str(args.run_id) + '/artifacts?per_page=100')['artifacts']
    bundles, selected, identity = {}, [], None
    for platform in sorted({'linux-ubuntu20.04', 'linux-debian12', 'linux-musl', 'windows-x64'}):
        matches = [a for a in artifacts if a['name'] == platform and not a['expired']]
        if len(matches) != 1:
            raise RuntimeError('Expected one unexpired artifact for ' + platform)
        artifact = matches[0]
        archive = output / (platform + '.zip')
        digest = artifact.get('digest', '')
        if not digest.startswith('sha256:'):
            raise RuntimeError('GitHub artifact digest is required')
        if not archive.exists() or 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
            agent.curl('https://nightly.link/' + args.repository + '/actions/artifacts/' + str(artifact['id']) + '.zip', archive)
        if 'sha256:' + hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Artifact digest mismatch')
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
    evidence = {'run': run['html_url'], 'jobs': jobs, 'artifacts': selected,
                'sourceIdentity': prior['sourceIdentity'], 'preservedWorker': before,
                'nativeIdentity': {k: identity[k] for k in ('version', 'commit', 'sourceDigest', 'protocol')},
                'nativeCiVerified': True, 'nativeInputsMatch': True,
                'deploymentToolCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'target': prior['target'], 'applied': False, 'verification': 'pending'}
    evidence_path = output / 'deployment.json'
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Prepared verified CI native downloads from ' + run['head_sha'], flush=True)
    if not args.apply:
        return
    result = subprocess.run(['node', str(ROOT / 'node_modules/wrangler/bin/wrangler.js'), 'deploy',
        '--config', str(config_path), '--no-bundle', '--keep-vars', '--message',
        'CI native downloads ' + str(args.run_id) + '; preserve Worker ' + prior['sourceIdentity']['commit']],
        cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (output / 'wrangler.log').write_text(result.stdout)
    print(result.stdout, flush=True)
    result.check_returncode()
    evidence['applied'] = True
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    if cloud.verify_existing_worker(config, output / 'worker') != before:
        raise RuntimeError('Worker changed during native download publication')
    for name in ['index.json', 'SHA256SUMS', 'index.html', *manifest['files']]:
        expected = (output / 'site/downloads' / name).read_bytes()
        actual = agent.curl(prior['target'] + '/downloads/' + ('' if name == 'index.html' else name))
        if hashlib.sha256(actual).digest() != hashlib.sha256(expected).digest():
            raise RuntimeError('Published download mismatch: ' + name)
    evidence['verification'] = 'passed'
    evidence_path.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Published and verified all four CI native platforms; Worker modules preserved')


if __name__ == '__main__':
    main()
