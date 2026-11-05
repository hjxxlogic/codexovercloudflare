"""Exercise startup failure recovery without model calls (POSIX fake Codex)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

client, agent = map(str, map(Path, sys.argv[1:]))
with tempfile.TemporaryDirectory(prefix='coc-repair-test-') as temporary:
    root = Path(temporary)
    config = root / 'broken config.json'
    config.write_text('{private-secret-invalid-json')
    capture = root / 'calls.jsonl'
    fake = root / 'codex'
    fake.write_text('#!/usr/bin/env python3\nimport os,sys,json\n'
                    'with open(os.environ["REPAIR_CAPTURE"], "a") as f:\n'
                    ' f.write(json.dumps({"args":sys.argv[1:],'
                    '"stdin":sys.stdin.read(),"guard":os.environ.get("COC_NO_STARTUP_REPAIR")})+"\\n")\n')
    fake.chmod(0o700)
    env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
               REPAIR_CAPTURE=str(capture))
    env.pop('COC_NO_STARTUP_REPAIR', None)
    def run(*args, disabled=False):
        selected = dict(env)
        if disabled:
            selected['COC_NO_STARTUP_REPAIR'] = '1'
        return subprocess.run(args, env=selected, capture_output=True, input=b"sensitive-piped-input", timeout=10)
    result = run(client, 'hosts', '--config', str(config))
    assert result.returncode == 1
    calls = [json.loads(line) for line in capture.read_text().splitlines()]
    assert len(calls) == 1 and calls[0]['guard'] == '1'
    assert calls[0]['stdin'] == ''
    assert str(config) in calls[0]['args'][-1]
    assert 'private-secret' not in calls[0]['args'][-1]
    run(client, 'hosts', '--config', str(config), disabled=True)
    run(client, 'help')
    assert len(capture.read_text().splitlines()) == 1
    with open(root / 'agent.log', 'wb') as log:
        process = subprocess.Popen([agent, 'run', '--config', str(config)], env=env,
                                   stdout=log, stderr=log)
        try:
            time.sleep(33)  # Cross the retry interval; repair must not run twice.
            assert process.poll() is None
            assert len(capture.read_text().splitlines()) == 2
        finally:
            process.terminate()
            process.wait(timeout=10)
print('startup repair: client failure, redaction, opt-out, help, agent retry passed')
