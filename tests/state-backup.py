"""Exercise backup/restore with a live WAL writer and the Agent lock."""
import fcntl
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix='coc-backup-test-') as directory:
    root = pathlib.Path(directory)
    journal = root / 'agent.db'
    connection = sqlite3.connect(journal)
    connection.execute('PRAGMA journal_mode=WAL')
    for table in ['sessions', 'events', 'history']:
        connection.execute(f'CREATE TABLE {table}(value TEXT)')
    connection.execute("INSERT INTO sessions VALUES ('original')")
    connection.execute('CREATE TABLE transport2_identity(instance TEXT)')
    connection.execute("INSERT INTO transport2_identity VALUES ('original-instance')")
    connection.execute('CREATE TABLE transport2_results(value TEXT)')
    connection.execute("INSERT INTO transport2_results VALUES ('unacknowledged result')")
    connection.commit()
    backup = root / 'snapshot.db'
    command = [sys.executable, 'scripts/state-backup.py']
    subprocess.run(command + ['backup', '--data-dir', str(root), '--file', str(backup)], check=True)
    assert backup.stat().st_mode & 0o777 == 0o600
    refused = subprocess.run(command + ['backup', '--data-dir', str(root), '--file', str(backup)], capture_output=True)
    assert refused.returncode != 0, 'Existing backup cannot be replaced'
    connection.execute("UPDATE sessions SET value='changed'")
    connection.commit()
    connection.close()
    lock = os.open(root / 'agent.lock', os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    refused = subprocess.run(command + ['restore', '--data-dir', str(root), '--file', str(backup)], capture_output=True)
    assert refused.returncode != 0
    os.close(lock)
    subprocess.run(command + ['restore', '--data-dir', str(root), '--file', str(backup)], check=True)
    with sqlite3.connect(journal) as restored:
        assert restored.execute('SELECT value FROM sessions').fetchone()[0] == 'original'
        assert restored.execute('SELECT instance FROM transport2_identity').fetchone()[0] == 'original-instance'
        assert restored.execute('SELECT value FROM transport2_results').fetchone()[0] == 'unacknowledged result'
        assert restored.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
print('PASS: online WAL backup, private mode, restore lock, content recovery and integrity')
