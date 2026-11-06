"""Regression checks for recovery after a one-way database upgrade."""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote', pathlib.Path(__file__).resolve().parents[1] / 'scripts/deploy-agent-remote.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)


class RecoveryTests(unittest.TestCase):
    def test_upgrade_never_restores_incompatible_binary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            binary = root / 'agent'
            candidate = root / 'candidate'
            binary.write_bytes(b'old')
            candidate.write_bytes(b'new')
            args = argparse.Namespace(binary=str(binary), candidate=str(candidate),
                sha256=hashlib.sha256(b'new').hexdigest(), service='agent.service',
                allow_restart_active=False, recover_stopped_evidence=None,
                database='db', verify_seconds=0)
            actions = []
            def execute(command):
                return '123' if 'MainPID' in ' '.join(command) else '{}'
            with patch.object(remote, 'target_status', return_value={'pid': 0, 'idle': True}), \
                 patch.object(remote, 'identity'), patch.object(remote, 'execute', side_effect=execute), \
                 patch.object(remote, 'schema_version', side_effect=[0, 2]), \
                 patch.object(remote, 'service', side_effect=lambda action, name: actions.append(action)):
                with self.assertRaisesRegex(RuntimeError, 'forbids binary-only rollback'):
                    remote.install(args)
            self.assertEqual(binary.read_bytes(), b'new')
            self.assertEqual(actions, ['stop', 'start', 'stop'])

    def test_stopped_recovery_rejects_live_session(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            evidence = root / 'deployment.json'
            evidence.write_text(json.dumps({'binary': str(root / 'agent'), 'before': {'idle': True}}))
            database = root / 'agent.db'
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE sessions(value TEXT)')
                db.execute('INSERT INTO sessions VALUES (?)', (json.dumps({'state': 'running'}),))
            args = argparse.Namespace(recover_stopped_evidence=str(evidence), database=str(database), service='agent.service')
            with patch.object(remote, 'execute', return_value='0'):
                with self.assertRaisesRegex(RuntimeError, 'potentially active'):
                    remote.target_status(root / 'agent', args)


if __name__ == '__main__':
    unittest.main()
