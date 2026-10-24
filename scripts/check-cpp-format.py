"""Check C++ formatting with clang-format 10 or newer (without changing files)."""
import pathlib
import subprocess
import sys

bad = []
for path in sorted(pathlib.Path('native').rglob('*')):
    if path.suffix in ('.cpp', '.hpp'):
        formatted = subprocess.check_output(['clang-format', str(path)])
        if formatted != path.read_bytes():
            bad.append(str(path))
if bad:
    print('Run npm run format:cpp for: ' + ', '.join(bad), file=sys.stderr)
    sys.exit(1)
