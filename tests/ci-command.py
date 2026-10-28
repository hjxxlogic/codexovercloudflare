"""Ensure CI annotations preserve the actual failure after noisy integration logs."""
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
result = subprocess.run([sys.executable, 'scripts/ci-command.py', sys.executable, '-c',
                         "import sys; print('relay log %' * 2000); print('AssertionError: final failure'); sys.exit(7)"],
                        cwd=root, capture_output=True, text=True)
assert result.returncode == 7
annotation = next(line for line in result.stdout.splitlines() if line.startswith('::error'))
assert len(annotation) < 4096
assert annotation.endswith('AssertionError: final failure')
assert '%0A' in annotation
print('PASS: noisy CI command keeps its final error in a bounded annotation')
