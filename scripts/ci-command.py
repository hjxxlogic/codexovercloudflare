"""Run a CI command and attach its failure output to the GitHub check annotation."""
from collections import deque
import subprocess
import sys

# Native tools and GitHub log commands use UTF-8 on every runner.
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

if len(sys.argv) < 2:
    raise SystemExit('Usage: ci-command.py executable [arguments...]')

try:
    process = subprocess.Popen(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding='utf-8', errors='replace')
except OSError as error:
    print(f'::error::Cannot start CI command: {error}', flush=True)
    raise SystemExit(1)

lines = deque(maxlen=60)
for line in process.stdout:
    print(line, end='', flush=True)
    lines.append(line.rstrip())
status = process.wait()
if status:
    summary = '\n'.join(lines)[-12000:]
    for literal, escaped in [('%', '%25'), ('\r', '%0D'), ('\n', '%0A')]:
        summary = summary.replace(literal, escaped)
    print('::error title=CI command failed::' + summary, flush=True)
raise SystemExit(status)
