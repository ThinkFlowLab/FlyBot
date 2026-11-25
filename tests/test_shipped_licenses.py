"""Inventory checks for the licenses and pins of what this revision ships."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHIPPED = ROOT / "docs" / "reuse-audit" / "shipped-pins.json"
NOTICE = ROOT / "NOTICE"


class ShippedLicenseInventoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shipped = json.loads(SHIPPED.read_text())

    def test_root_notice_points_at_imported_trees_and_does_not_relicense_them(self):
        text = NOTICE.read_text()
        self.assertIn("does not relicense", text)
        self.assertIn("runtime/flybot/", text)
        self.assertIn("runtime/ds-bot-upstream/", text)
        self.assertIn("services/bot-social/", text)
        self.assertIn("MPL-2.0", text)
        self.assertIn("libreoffice-kit", text)
        self.assertIn("docs/reuse-audit/SHIPPED.md", text)

    def test_on_disk_license_hashes_match_the_shipped_inventory(self):
        files = self.shipped["in_repo_license_files"]
        self.assertGreaterEqual(len(files), 7)
        for rel, rec in files.items():
            data = (ROOT / rel).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), rec["sha256"], rel)
            self.assertEqual(len(data), rec["bytes"], rel)

    def test_inventory_records_dsh_pin_mpl_blocker_and_refuses_a_public_image(self):
        self.assertIs(self.shipped["public_redistributable_image"], False)
        npm = self.shipped["dsh_0_2_2_rc_1"]["npm"]
        self.assertEqual(npm["version"], "0.2.2-rc.1")
        self.assertEqual(npm["declared_license"], "MIT")
        self.assertEqual(
            npm["integrity"],
            "sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg==",
        )
        self.assertIsNone(npm["gitHead_in_registry_metadata"])
        self.assertEqual(npm["direct_dependency_count"], 90)
        git = self.shipped["dsh_0_2_2_rc_1"]["git"]
        self.assertEqual(git["commit"], "66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db")
        self.assertTrue(git["npm_tarball_correspondence"].startswith("unverified"))
        kit = self.shipped["dsh_0_2_2_rc_1"]["libreoffice_kit"]
        self.assertEqual(kit["license"], "MPL-2.0")
        self.assertIn("blocker", kit["redistribution"])
        directs = self.shipped["dsh_0_2_2_rc_1"]["direct_dependencies_of_cli_and_image_extras"]
        cli = {row["name"]: row for row in directs}
        self.assertEqual(cli["@deepseek-ai/dsh-skill-office"]["license"], "MIT")
        self.assertEqual(cli["@deepseek-ai/libreoffice-kit"]["license"], "MPL-2.0")
        self.assertTrue(any("MPL-2.0" in item or "libreoffice" in item for item in self.shipped["known_open_items"]))

    def test_bot_social_lock_npm_licenses_are_recorded_and_contain_no_copyleft_field(self):
        rec = self.shipped["vendored_npm_lockfiles"]["services/bot-social/package-lock.json"]
        self.assertEqual(rec["unique_name_version"], 223)
        self.assertEqual(rec["license_fields_in_lockfile"], 0)
        special = rec["non_permissive_or_special"]
        self.assertEqual(special, [])
        counts = rec["npm_registry_license_counts_for_unique_versions"]
        self.assertEqual(sum(counts.values()), 223)
        self.assertNotIn("GPL-2.0", counts)
        self.assertNotIn("MPL-2.0", counts)

    def test_verify_reuse_audit_pins_passes_offline(self):
        process = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "verify-reuse-audit-pins.py")],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertIn("all reuse-audit pin checks passed", process.stdout)


if __name__ == "__main__":
    unittest.main()
