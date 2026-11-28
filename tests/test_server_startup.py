"""Checks that the development server names the precondition that stopped it."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ServerStartupMessageTests(unittest.TestCase):
    def test_public_data_directory_names_the_permission_rule(self):
        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp) / 'data'
            data_dir.mkdir()
            os.chmod(data_dir, 0o755)
            process = subprocess.run(
                [sys.executable, '-m', 'flybot_workspace.server',
                 '--data-dir', str(data_dir),
                 '--origin', 'http://127.0.0.1:8787',
                 '--port', '8787',
                 '--insecure-local',
                 '--open-registration'],
                cwd=ROOT, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(process.returncode, 2, process.stdout + process.stderr)
            self.assertIn('Data directory must be private and owned by this process user', process.stderr)
            self.assertNotIn('Cannot initialize private storage', process.stderr)
            self.assertEqual(list(data_dir.iterdir()), [], 'the refused data directory must stay empty')
