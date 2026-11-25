"""Checks for the LibreOffice Kit corresponding-source offer."""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OFFER = ROOT / "runtime" / "third_party" / "libreoffice-kit"


class LibreOfficeKitOfferTests(unittest.TestCase):
    def test_offer_script_passes_offline(self):
        process = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "fetch-libreoffice-kit-sources.py")],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertIn("all libreoffice-kit source-offer checks passed", process.stdout)

    def test_offer_does_not_vendor_engine_binaries_and_keeps_office(self):
        pins = json.loads((OFFER / "pins.json").read_text())
        self.assertIs(pins["public_redistributable_image"], False)
        self.assertIn("retained", pins["office_functionality"])
        self.assertTrue((OFFER / "entry/LICENSE").is_file())
        self.assertIn("Mozilla Public License Version 2.0", (OFFER / "entry/LICENSE").read_text())
        core = json.loads((OFFER / "wasm/sources/core-source.json").read_text())
        self.assertEqual(core["revision"], "bce0998afefdbc355585ca324285661a2170ba77")
        forbidden = list(OFFER.rglob("*.wasm")) + list(OFFER.rglob("soffice.data")) + list(OFFER.rglob("*.tgz"))
        self.assertEqual(forbidden, [])

    def test_image_recipe_copies_the_offer_and_root_notice_points_at_it(self):
        docker = (ROOT / "runtime/flybot-image/Dockerfile").read_text()
        self.assertIn("COPY third_party/libreoffice-kit /opt/licenses/libreoffice-kit", docker)
        self.assertNotIn("soffice.wasm", docker)
        notice = (ROOT / "NOTICE").read_text()
        self.assertIn("runtime/third_party/libreoffice-kit/", notice)
        self.assertIn("office", notice.lower())
        self.assertIn("does not offer\na public redistributable runtime image", notice)


if __name__ == "__main__":
    unittest.main()
