#!/usr/bin/env python3
"""Remove unsupported autoUpdate.intervalHours from x0-x9 CoC configurations."""

import argparse
import json
import os
from pathlib import Path
import pwd
import stat
import tempfile


def repair(path, apply):
    # Do not let an administrator's invocation follow user-controlled links.
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError('symbolic links are not supported')
    try:
        metadata = path.stat()
    except FileNotFoundError:
        print(f'MISSING {path}')
        return
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError('not a regular file')
    original = path.read_bytes()
    config = json.loads(original)
    if not isinstance(config, dict):
        raise ValueError('configuration must be a JSON object')
    update = config.get('autoUpdate')
    if not isinstance(update, dict) or 'intervalHours' not in update:
        print(f'UNCHANGED {path}')
        return
    if not apply:
        print(f'WOULD REMOVE autoUpdate.intervalHours: {path}')
        return
    del update['intervalHours']
    replacement = (json.dumps(config, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    # Create an exclusive backup; never overwrite an earlier backup.
    backup_fd, backup = tempfile.mkstemp(prefix=path.name + '.before-interval-removal-',
                                         dir=path.parent)
    with os.fdopen(backup_fd, 'wb') as stream:
        stream.write(original)
        stream.flush()
        os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
        os.fchmod(stream.fileno(), stat.S_IMODE(metadata.st_mode))
        os.fsync(stream.fileno())
    temporary_fd, temporary = tempfile.mkstemp(prefix=path.name + '.repair-', dir=path.parent)
    try:
        with os.fdopen(temporary_fd, 'wb') as stream:
            stream.write(replacement)
            stream.flush()
            os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(metadata.st_mode))
            os.fsync(stream.fileno())
        if path.stat() != metadata or path.read_bytes() != original:
            raise RuntimeError('configuration changed during repair; retry when idle')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f'UPDATED {path} (backup: {backup})')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='write changes; default is preview')
    parser.add_argument('--config-relative', action='append', metavar='PATH',
                        help='path relative to each home; repeatable; replaces default paths')
    args = parser.parse_args()
    paths = args.config_relative or ['.config/coc-agent/agent.json',
                                   '.config/coc-client/credentials.json']
    if any(Path(p).is_absolute() or '..' in Path(p).parts or p in ('', '.') for p in paths):
        parser.error('--config-relative must be a file path within each home directory')
    failures = 0
    checked = 0
    for index in range(10):
        user = f'x{index}'
        try:
            home = Path(pwd.getpwnam(user).pw_dir)
        except KeyError:
            print(f'MISSING USER {user}')
            continue
        for relative in dict.fromkeys(paths):
            path = home / relative
            checked += 1
            try:
                repair(path, args.apply)
            except (OSError, ValueError, RuntimeError) as error:
                # Never print JSON contents: configurations can contain credentials.
                detail = 'invalid JSON' if isinstance(error, json.JSONDecodeError) else str(error)
                print(f'SKIPPED {path}: {detail}; continuing with remaining configurations')
                failures += 1
                continue
    print(f'Finished: checked {checked} paths; skipped {failures} due to errors.')
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
