"""Back up a live Agent SQLite journal, or restore one while the Agent is stopped."""
import argparse
import fcntl
import os
import pathlib
import sqlite3
import stat
import tempfile


def checked(path):
    database = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    if database.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        database.close()
        raise RuntimeError('Database integrity check failed')
    tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    # requests was removed by delivery:2. Authoritative history remains readable
    # in both old and new databases; backup must include every reliable table.
    if not {'sessions', 'events', 'history'} <= tables:
        database.close()
        raise RuntimeError('Not an Agent history database')
    return database


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['backup', 'restore'])
    parser.add_argument('--data-dir', type=pathlib.Path, required=True)
    parser.add_argument('--file', type=pathlib.Path, required=True)
    args = parser.parse_args()
    journal = args.data_dir / 'agent.db'
    if args.file.resolve() == journal.resolve():
        parser.error('Snapshot and live journal must be different files')
    if args.operation == 'backup':
        if args.file.exists():
            parser.error('Backup destination already exists')
        with checked(journal) as source:
            fd, temporary = tempfile.mkstemp(prefix='.coc-backup-', dir=args.file.parent)
            try:
                os.close(fd)
                with sqlite3.connect(temporary) as target:
                    source.backup(target, pages=256, sleep=0.05)
                    if target.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                        raise RuntimeError('Backup integrity check failed')
                with open(temporary, 'rb') as snapshot:
                    os.fsync(snapshot.fileno())
                # Exclusive publication preserves an existing destination on races.
                os.link(temporary, args.file)
                parent = os.open(args.file.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(parent)
                finally:
                    os.close(parent)
            finally:
                os.unlink(temporary)
    else:
        if journal.is_symlink():
            parser.error('Restore target must not be a symbolic link')
        # The same lock as the Agent protects the complete restore transaction.
        descriptor = os.open(args.data_dir / 'agent.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # A fresh restore must have the same private mode as an Agent DB,
            # independently of the caller's umask. Never follow a target link.
            target_fd = os.open(journal, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                if not stat.S_ISREG(os.fstat(target_fd).st_mode):
                    raise RuntimeError('Restore target must be a regular file')
                os.fchmod(target_fd, 0o600)
            finally:
                os.close(target_fd)
            with checked(args.file) as source:
                with sqlite3.connect(journal) as target:
                    target.execute('PRAGMA busy_timeout=5000')
                    source.backup(target, pages=256, sleep=0.05)
                    if target.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                        raise RuntimeError('Restored journal integrity check failed')
        finally:
            os.close(descriptor)
    print(args.operation + ' complete')


if __name__ == '__main__':
    main()
