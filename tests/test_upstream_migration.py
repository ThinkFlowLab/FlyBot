"""Provenance and exclusion checks for the first FlyBot / Bot Social import."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "verify-upstream-migration.py"


def load_verifier():
    spec = importlib.util.spec_from_file_location("verify_upstream_migration", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class UpstreamMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.verify = load_verifier()

    def test_current_tree_passes_offline_verifier(self):
        errors = self.verify.verify(ROOT, fetch=False)
        self.assertEqual(errors, [])

    def test_audit_license_pins_are_the_recorded_bytes(self):
        pins = self.verify.AUDIT_PINS
        self.assertEqual(
            self.verify.sha256_file(ROOT / "runtime/flybot/LICENSE"),
            pins["runtime/flybot/LICENSE"],
        )
        self.assertEqual(
            self.verify.sha256_file(ROOT / "runtime/flybot/NOTICE"),
            pins["runtime/flybot/NOTICE"],
        )
        self.assertEqual(
            self.verify.sha256_file(ROOT / "services/bot-social/LICENSE"),
            pins["services/bot-social/LICENSE"],
        )

    def test_default_core_exclusions_are_absent(self):
        flybot = ROOT / "runtime/flybot"
        self.assertFalse((flybot / "core").exists())
        self.assertFalse((flybot / "ds-bot.pin.json").exists())
        self.assertFalse((flybot / "plugins/project").exists())
        self.assertFalse((flybot / "plugins/timeline").exists())
        self.assertFalse((flybot / "plugins/tree").exists())
        self.assertFalse((flybot / "plugins/workflow").exists())
        self.assertFalse((flybot / "ds-bot").exists())
        self.assertFalse((flybot / "patches").exists())
        self.assertFalse((flybot / "Dockerfile").exists())
        self.assertFalse((flybot / "compose.yaml").exists())
        self.assertFalse((flybot / "docs/images").exists())
        self.assertFalse((flybot / "docs/assets/wechat-group.png").exists())
        self.assertFalse((ROOT / "services/bot-social/docs/assets").exists())
        self.assertFalse((ROOT / "services/bot-social/docs/index.html").exists())
        self.assertFalse((ROOT / "services/bot-social/scripts/install.sh").exists())
        self.assertFalse((ROOT / "services/bot-social/scripts/demo.ts").exists())
        self.assertTrue((flybot / "plugins/social/index.js").is_file())
        self.assertTrue((flybot / "docker/entrypoint.mjs").is_file())
        self.assertTrue((ROOT / "services/bot-social/src/server.ts").is_file())
        self.assertTrue((ROOT / "services/bot-social/public/index.html").is_file())

    def test_verifier_flags_excluded_plugin_and_dotenv(self):
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            flybot = base / "runtime/flybot"
            (flybot / "plugins/project").mkdir(parents=True)
            (flybot / "plugins/project/index.js").write_text("x\n", encoding="utf-8")
            manifest = {
                "components": {
                    "flybot": {
                        "destination": "runtime/flybot",
                        "excluded_paths": ["plugins/project/index.js"],
                    },
                    "bot-social": {
                        "destination": "services/bot-social",
                        "excluded_paths": [],
                    },
                }
            }
            errors: list[str] = []
            self.verify.check_exclusions(base, manifest, errors)
            self.assertTrue(any("plugins/project" in item for item in errors), errors)

            social = base / "services/bot-social"
            social.mkdir(parents=True)
            (social / ".env").write_text("TOKEN=nope\n", encoding="utf-8")
            clean_errors: list[str] = []
            self.verify.check_clean_tree(base, clean_errors)
            self.assertTrue(any(".env" in item for item in clean_errors), clean_errors)

    def test_core_fork_is_recorded_as_absent(self):
        errors = []
        self.verify.check_core_fork_absent(ROOT, errors)
        self.assertEqual(errors, [])
        origin = (ROOT / "runtime/flybot/ORIGIN.md").read_text(encoding="utf-8")
        self.assertIn("does **not** contain `core/`", origin)
        self.assertIn("v0.3.6", origin)
        selection = (ROOT / "docs/upstream/SELECTION.md").read_text(encoding="utf-8")
        self.assertIn("runtime/flybot/core/", selection)
        self.assertIn("v0.3.6", selection)
        equiv = json.loads((ROOT / "docs/upstream/ds-bot-pin-equivalence.json").read_text(encoding="utf-8"))
        self.assertEqual(equiv["status"], "not_imported")

    def test_modified_files_are_recorded_and_differ_from_the_pin(self):
        manifest = json.loads((ROOT / "docs/upstream/migration-manifest.json").read_text(encoding="utf-8"))
        modified = manifest["modified_files"]
        self.assertIn("services/bot-social/package.json", modified)
        self.assertIn("runtime/flybot/README.md", modified)
        pkg = json.loads((ROOT / "services/bot-social/package.json").read_text(encoding="utf-8"))
        self.assertNotIn("demo", pkg.get("scripts") or {})
        errors = []
        self.verify.apply_workspace_overlay(ROOT, manifest, errors)
        self.verify.check_modified_files(
            ROOT,
            manifest,
            {
                "runtime/flybot": json.loads((ROOT / "docs/upstream/flybot-files.json").read_text()),
                "services/bot-social": json.loads((ROOT / "docs/upstream/bot-social-files.json").read_text()),
            },
            errors,
        )
        self.assertEqual(errors, [])

    def test_bot_social_test_script_still_present(self):
        pkg = json.loads((ROOT / "services/bot-social/package.json").read_text(encoding="utf-8"))
        self.assertIn("test", pkg.get("scripts") or {})
        self.assertIn("tsx", pkg["scripts"]["test"])


if __name__ == "__main__":
    unittest.main()
