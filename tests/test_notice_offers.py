"""Offline checks for KaTeX, sharp-libvips, Anthropic, and Debian offer tooling."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KATEX = ROOT / "runtime" / "third_party" / "font-notices" / "katex"
SHARP = ROOT / "runtime" / "third_party" / "sharp-libvips"
ANTHROPIC = ROOT / "runtime" / "third_party" / "anthropic-sdk"
CODICON = ROOT / "runtime" / "third_party" / "font-notices" / "codicon"


class NoticeOfferTests(unittest.TestCase):
    def test_katex_license_matches_the_official_package_text(self):
        data = (KATEX / "LICENSE").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), "766ccc1f306c885aa45542a9846bbd0a505b27a0374f146778171c2254ce18e3")
        self.assertIn(b"MIT License", data)
        self.assertIn(b"Khan Academy", data)
        pins = json.loads((KATEX / "pins.json").read_text())
        self.assertFalse(pins["ofl_txt_in_package_or_git_tag"])
        self.assertFalse(pins["font_binaries_vendored"])
        self.assertIn("0.18.7", pins["matched_versions"])

    def test_anthropic_license_matches_the_image_inventory_hash(self):
        data = (ANTHROPIC / "LICENSE").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), "8bf96984ff8bcfae7e48cae76a529e8a25317ba9e02abf7fd3cc64fdf95657a6")
        self.assertEqual(len(data), 1056)
        self.assertIn(b"Copyright 2023 Anthropic, PBC.", data)
        readme = (ANTHROPIC / "README.md").read_text()
        self.assertIn("not", readme.lower())
        self.assertIn("claude-agent-sdk", readme)
        self.assertIn("@anthropic-ai/sdk@0.129.0", readme)

    def test_sharp_libvips_offer_offline_check_passes(self):
        process = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "fetch-sharp-libvips-sources.py")],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertNotIn(".so", [p.suffix for p in SHARP.rglob("*") if p.is_file()])
        notices = (SHARP / "THIRD-PARTY-NOTICES.md").read_text()
        self.assertIn("LGPLv3", notices)
        self.assertIn("Mozilla Public License 1.1", notices)

    def test_debian_source_offer_lists_exact_fixture_versions(self):
        inventory = {
            "collected_at": "2026-11-16T13:55:30.030Z",
            "os": {
                "os_release": {"PRETTY_NAME": "Debian GNU/Linux 12 (bookworm)", "VERSION_CODENAME": "bookworm"},
                "packages": [
                    {
                        "name": "git",
                        "version": "1:2.39.5-0+deb12u3",
                        "source_package": "git",
                        "source_version": "1:2.39.5-0+deb12u3",
                        "copyright_sha256": "8ceacdebe13249ea8aba6e400418e2b503c83a1f19ad92377380fb32ecf48d0c",
                        "copyright_fields": {"licenses": ["GPL-2", "GPL-2+"]},
                    },
                    {
                        "name": "ca-certificates",
                        "version": "20230311",
                        "source_package": "ca-certificates",
                        "source_version": "20230311",
                        "copyright_sha256": "abc",
                        "copyright_fields": {"licenses": ["GPL-2+ or MPL-2.0"]},
                    },
                ],
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            inv = Path(tmp) / "inventory.json"
            out = Path(tmp) / "offer"
            inv.write_text(json.dumps(inventory))
            process = subprocess.run(
                [sys.executable, str(ROOT / "scripts" / "debian-source-offer.py"), "--inventory", str(inv), "--out", str(out)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
            text = (out / "debian-source-offer.md").read_text()
            self.assertIn("not", text.lower())
            self.assertIn("legal", text.lower())
            self.assertIn("apt-get source git=1:2.39.5-0+deb12u3", text)
            self.assertIn("apt-get source ca-certificates=20230311", text)
            payload = json.loads((out / "debian-packages.json").read_text())
            self.assertIs(payload["public_redistributable_image"], False)
            self.assertEqual(payload["binary_package_count"], 2)
            self.assertEqual(payload["source_package_count"], 2)

    def test_inventory_runner_restores_host_ownership_before_debian_offer(self):
        script = (ROOT / "runtime" / "flybot-image" / "inventory" / "run-in-image.sh").read_text()
        offer = script.index('python3 "$repo_root/scripts/debian-source-offer.py"')
        restore = script.index('chown -R "$(id -u):$(id -g)" "$OUT"')
        self.assertLess(restore, offer)
        self.assertIn("uid 1000", script)

    def test_codicon_license_matches_playwright_v1_64_1_source(self):
        data = (CODICON / "LICENSE.txt").read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), "20535828272932407c2f5172aeb714ac7b374a34e5ecb1825af509f2902cde54")
        self.assertEqual(len(data), 1087)
        self.assertIn(b"MIT License", data)
        self.assertIn(b"Microsoft Corporation", data)
        pins = json.loads((CODICON / "pins.json").read_text())
        self.assertEqual(pins["playwright_core"], "1.64.1")
        self.assertEqual(pins["playwright_git"], "cfe490d941f992655948eee8fd4fd94e1c4234bf")
        self.assertEqual(pins["font_sha256"], "0f1d5219934e96e83b8db162d60b4d8c09b5de1e7d38031cbafe4a3c0f2889c9")
        self.assertFalse(pins["font_binaries_vendored"])
        self.assertFalse(pins["npm_tarball_ships_license_beside_font"])
        self.assertFalse(pins["public_redistributable_image"])
        self.assertFalse(any(p.suffix.lower() in {".ttf", ".woff", ".woff2"} for p in CODICON.iterdir() if p.is_file()))

    def test_corresponding_source_records_exact_build_script_urls_and_gaps(self):
        payload = json.loads((SHARP / "corresponding-source.json").read_text())
        self.assertIs(payload["public_redistributable_image"], False)
        self.assertIs(payload["reproducible_rebuild_verified"], False)
        by_id = {row["id"]: row for row in payload["libraries"]}
        self.assertEqual(
            by_id["cairo"]["url"],
            "https://cairographics.org/releases/cairo-1.18.6.tar.xz",
        )
        self.assertEqual(by_id["cairo"]["version"], "1.18.6")
        self.assertFalse(by_id["cairo"]["sha256_verified_in_this_repo"])
        self.assertEqual(
            by_id["vips"]["url"],
            "https://github.com/libvips/libvips/releases/download/v8.18.7/vips-8.18.7.tar.xz",
        )
        self.assertTrue(by_id["vips"]["sha256_verified_in_this_repo"])
        self.assertGreaterEqual(len(payload["unresolved_preferred_source_gaps"]), 3)
        text = (SHARP / "CORRESPONDING-SOURCE.md").read_text()
        self.assertIn("not a legal", text.lower())
        self.assertIn("https://download.gnome.org/sources/glib/2.90/glib-2.90.0.tar.xz", text)



if __name__ == "__main__":
    unittest.main()
