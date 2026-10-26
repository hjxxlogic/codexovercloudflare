"""Generate native build identity from tracked and untracked nonignored source bytes."""
import hashlib
import json
import pathlib
import platform
import os
import subprocess
import sys


def identity():
    os.chdir(pathlib.Path(__file__).resolve().parents[1])
    if os.environ.get('COC_TEST_BUILD_METADATA'):
        metadata = json.loads(pathlib.Path(os.environ['COC_TEST_BUILD_METADATA']).read_text())
        metadata['dirty'] = True
        metadata['verified'] = False
        return metadata
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).split(b'\0')
    digest = hashlib.sha256()
    for name in sorted(filter(None, names)):
        path = pathlib.Path(name.decode())
        if path.is_file() or path.is_symlink():
            contents = os.fsencode(os.readlink(path)) if path.is_symlink() else path.read_bytes()
            digest.update(name + b'\0' + contents + b'\0')
    return {'version': json.loads(pathlib.Path('package.json').read_text())['version'],
            'commit': commit, 'target': 'windows-x86_64' if sys.platform == 'win32' and platform.machine().lower() in ('amd64', 'x86_64') else sys.platform + '-' + platform.machine(), 'sourceDigest': digest.hexdigest(), 'protocol': 1,
            'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'])),
            'capabilities': ['demand-v1', 'session-pages', 'request-status', 'upload-status', 'content-revision', 'external-session-queue', 'external-approvals']}


if __name__ == '__main__':
    metadata = identity()
    if len(sys.argv) > 1:
        path = pathlib.Path(sys.argv[1])
        path.parent.mkdir(parents=True, exist_ok=True)
        contents = '#pragma once\n#define COC_BUILD_JSON ' + json.dumps(json.dumps(metadata, separators=(',', ':'))) + '\n'
        if not path.exists() or path.read_text() != contents:
            path.write_text(contents)
    else:
        print(json.dumps(metadata))
