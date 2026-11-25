#!/usr/bin/env python3
"""Verify recorded reuse-audit pins and, optionally, re-fetch public files.

Default mode is offline: it checks pins.json structure and the recorded
sha256/byte lengths. Pass --fetch to download the public GitHub raw files
again and compare. This is not a license legal opinion and does not authorize
imports.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PINS_PATH = ROOT / "docs" / "reuse-audit" / "pins.json"

REQUIRED_SHA256 = {
    ("ThinkFlowLab/FlyBot", "LICENSE"): "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    ("ThinkFlowLab/FlyBot", "NOTICE"): "94f05bc42e635dee7082583c010dc13fb084b1ed9cdcfed6b9e5246c763027ca",
    ("Birfy/bot-social", "LICENSE"): "6f5b168b7397507ec7854d3787079ae4185826ea0a9ade831a269fabe3e737c3",
    ("deepseek-ai/deepseek-harness", "LICENSE"): "ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be",
    ("deepseek-ai/deepseek-harness", "THIRD_PARTY_NOTICES.md"): "aeea7aa256ede5349cc7903f56a859d54f10b82a45fba7dcce667eb69916dab0",
}


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)


def load_pins() -> dict:
    if not PINS_PATH.is_file():
        fail(f"missing {PINS_PATH}")
    return json.loads(PINS_PATH.read_text())


def check_offline(pins: dict) -> int:
    errors = 0
    repos = pins.get("pins") or {}
    mapping = {
        "ThinkFlowLab/FlyBot": repos.get("ThinkFlowLab/FlyBot", {}),
        "Birfy/bot-social": repos.get("Birfy/bot-social", {}),
        "deepseek-ai/deepseek-harness": repos.get("deepseek-ai/deepseek-harness", {}),
    }
    for repo, fname in REQUIRED_SHA256:
        rec = (mapping[repo].get("files") or {}).get(fname)
        if not rec:
            print(f"FAIL: pins.json missing {repo} {fname}")
            errors += 1
            continue
        got = rec.get("sha256")
        if got != REQUIRED_SHA256[(repo, fname)]:
            print(f"FAIL: {repo} {fname} sha256 {got} != recorded constant")
            errors += 1
        else:
            print(f"OK offline {repo} {fname} sha256={got}")
        if not rec.get("url") or "github.com" not in rec["url"]:
            print(f"FAIL: {repo} {fname} missing public github url")
            errors += 1
    cp = repos.get("Birfy/flybot-control-plane") or {}
    if cp.get("import_allowed") is not False or cp.get("license_file_in_default_tree") is not False:
        print("FAIL: control-plane must remain import_allowed=false and no license file")
        errors += 1
    else:
        print("OK control-plane remains non-importable (no license file recorded)")
    fb = repos.get("ThinkFlowLab/FlyBot") or {}
    if fb.get("commit") != "e26895e737b1218875aafa1f74ab1d3464f287d2":
        print("FAIL: FlyBot main pin changed in pins.json; re-audit required")
        errors += 1
    else:
        print("OK FlyBot pin", fb.get("commit"))
    return errors


SHIPPED_PATH = ROOT / "docs" / "reuse-audit" / "shipped-pins.json"
NOTICE_PATH = ROOT / "NOTICE"
DSH_INTEGRITY = "sha512-ijR9UEVYkG15Q/Q79JzvzLBzQOQfc63VLr9n6flpwHPhr5IKn2UxthnSoto/P9l7qGd7pPvI1Ra6TW7LH3oKpg=="
DSH_TAG_COMMIT = "66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db"
LIBREOFFICE_LICENSE = "MPL-2.0"
ON_DISK = {
    "LICENSE": "096841e8f7eceada5cbb435b01e60cedc2b458717c2065131ad64e1d7bebad6a",
    "runtime/flybot/LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "runtime/flybot/NOTICE": "94f05bc42e635dee7082583c010dc13fb084b1ed9cdcfed6b9e5246c763027ca",
    "runtime/ds-bot-upstream/LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "runtime/ds-bot-upstream/NOTICE": "7183b18ec5bd153cb7b207c0c0d8c9c8d83dc5f0add15c116f13027b5dd95050",
    "runtime/ds-bot-upstream/ds-bot/LICENSE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
    "services/bot-social/LICENSE": "6f5b168b7397507ec7854d3787079ae4185826ea0a9ade831a269fabe3e737c3",
}


def check_shipped() -> int:
    errors = 0
    if not NOTICE_PATH.is_file():
        print("FAIL: missing root NOTICE")
        return 1
    notice = NOTICE_PATH.read_text()
    for phrase in ("does not relicense", "runtime/flybot/", "runtime/ds-bot-upstream/", "services/bot-social/", "libreoffice-kit", "MPL-2.0"):
        if phrase not in notice:
            print(f"FAIL: root NOTICE missing {phrase!r}")
            errors += 1
    if not SHIPPED_PATH.is_file():
        print(f"FAIL: missing {SHIPPED_PATH}")
        return errors + 1
    shipped = json.loads(SHIPPED_PATH.read_text())
    if shipped.get("public_redistributable_image") is not False:
        print("FAIL: shipped inventory must not claim a public redistributable image")
        errors += 1
    files = shipped.get("in_repo_license_files") or {}
    for rel, expected in ON_DISK.items():
        path = ROOT / rel
        if not path.is_file():
            print(f"FAIL: missing {rel}")
            errors += 1
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        recorded = (files.get(rel) or {}).get("sha256")
        if digest != expected or recorded != expected:
            print(f"FAIL: {rel} sha256 disk={digest} recorded={recorded} expected={expected}")
            errors += 1
        else:
            print(f"OK on-disk {rel}")
    npm = ((shipped.get("dsh_0_2_2_rc_1") or {}).get("npm") or {})
    git = ((shipped.get("dsh_0_2_2_rc_1") or {}).get("git") or {})
    kit = ((shipped.get("dsh_0_2_2_rc_1") or {}).get("libreoffice_kit") or {})
    if npm.get("integrity") != DSH_INTEGRITY:
        print("FAIL: DSH 0.2.2-rc.1 integrity pin drifted")
        errors += 1
    else:
        print("OK DSH npm integrity")
    if git.get("commit") != DSH_TAG_COMMIT or git.get("npm_tarball_correspondence", "").startswith("unverified") is False:
        print("FAIL: DSH git tag pin or correspondence honesty drifted", git)
        errors += 1
    else:
        print("OK DSH git tag", DSH_TAG_COMMIT, "correspondence still unverified")
    if kit.get("license") != LIBREOFFICE_LICENSE or "blocker" not in (kit.get("redistribution") or ""):
        print("FAIL: libreoffice-kit MPL clearance blocker not recorded")
        errors += 1
    elif kit.get("source_offer") != "runtime/third_party/libreoffice-kit":
        print("FAIL: libreoffice-kit source offer path not recorded")
        errors += 1
    else:
        print("OK libreoffice-kit MPL-2.0 clearance still blocked; source offer recorded")
    dockerfile = (ROOT / "runtime/flybot-image/Dockerfile").read_text()
    if "does not close issue" in dockerfile.lower() or "closes issue" in dockerfile.lower():
        print("FAIL: Dockerfile uses GitHub closing-keyword phrasing")
        errors += 1
    else:
        print("OK Dockerfile does not use closing-keyword phrasing")
    workflow = (ROOT / ".github/workflows/flybot-runtime-image.yml").read_text()
    if "close issue" in workflow.lower() or "closes issue" in workflow.lower() or "closes #" in workflow.lower():
        print("FAIL: runtime image workflow uses GitHub closing-keyword phrasing")
        errors += 1
    else:
        print("OK runtime image workflow does not use closing-keyword phrasing")
    pin = "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9"
    if pin not in workflow or "flybot-runtime-image-license-inventory" not in workflow:
        print("FAIL: runtime image workflow must upload a pinned image license inventory artifact")
        errors += 1
    else:
        print("OK runtime image workflow uploads pinned inventory artifact")
    collector = ROOT / "runtime/flybot-image/inventory/collect.mjs"
    if not collector.is_file():
        print("FAIL: missing image inventory collector")
        errors += 1
    else:
        print("OK image inventory collector present")
    expected_offers = {
        "runtime/third_party/font-notices/katex/LICENSE": "766ccc1f306c885aa45542a9846bbd0a505b27a0374f146778171c2254ce18e3",
        "runtime/third_party/font-notices/codicon/LICENSE.txt": "20535828272932407c2f5172aeb714ac7b374a34e5ecb1825af509f2902cde54",
        "runtime/third_party/anthropic-sdk/LICENSE": "8bf96984ff8bcfae7e48cae76a529e8a25317ba9e02abf7fd3cc64fdf95657a6",
        "runtime/third_party/sharp-libvips/THIRD-PARTY-NOTICES.md": "6f0d5086e3bcbee12bcdacf5878b31d1104002aeecaeb241d3fff466108082fe",
        "runtime/third_party/sharp-libvips/LGPL-3.0.txt": "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118",
    }
    for rel, expected in expected_offers.items():
        path = ROOT / rel
        if not path.is_file():
            print(f"FAIL: missing {rel}")
            errors += 1
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != expected:
            print(f"FAIL: {rel} sha256 {digest} != {expected}")
            errors += 1
        else:
            print(f"OK offer {rel}")
    cs = ROOT / "runtime/third_party/sharp-libvips/corresponding-source.json"
    if not cs.is_file():
        print("FAIL: missing corresponding-source.json")
        errors += 1
    else:
        payload = json.loads(cs.read_text())
        if payload.get("public_redistributable_image") is not False or payload.get("reproducible_rebuild_verified") is not False:
            print("FAIL: corresponding-source.json must not claim a public image or verified rebuild")
            errors += 1
        else:
            print("OK corresponding-source.json present without clearance claims")
    if "install-redistribution-notices.mjs" not in dockerfile:
        print("FAIL: Dockerfile must install redistribution notices into the image")
        errors += 1
    else:
        print("OK Dockerfile installs redistribution notices")
    return errors


def raw_url(blob_url: str) -> str:
    # https://github.com/owner/repo/blob/sha/path -> raw.githubusercontent.com/owner/repo/sha/path
    prefix = "https://github.com/"
    if not blob_url.startswith(prefix) or "/blob/" not in blob_url:
        raise ValueError(blob_url)
    rest = blob_url[len(prefix) :]
    owner_repo, _, sha_path = rest.partition("/blob/")
    return f"https://raw.githubusercontent.com/{owner_repo}/{sha_path}"


def check_fetch(pins: dict) -> int:
    errors = 0
    repos = pins.get("pins") or {}
    for key, rec_repo in (
        ("ThinkFlowLab/FlyBot", repos.get("ThinkFlowLab/FlyBot")),
        ("Birfy/bot-social", repos.get("Birfy/bot-social")),
        ("deepseek-ai/deepseek-harness", repos.get("deepseek-ai/deepseek-harness")),
    ):
        files = (rec_repo or {}).get("files") or {}
        for fname, rec in files.items():
            url = rec.get("url")
            expected = rec.get("sha256")
            if not url or not expected:
                continue
            target = raw_url(url)
            try:
                with urllib.request.urlopen(target, timeout=30) as resp:
                    data = resp.read()
            except Exception as exc:
                print(f"FAIL fetch {key} {fname}: {exc}")
                errors += 1
                continue
            got = hashlib.sha256(data).hexdigest()
            if got != expected:
                print(f"FAIL fetch hash {key} {fname}: {got} != {expected} ({len(data)} bytes)")
                errors += 1
            else:
                print(f"OK fetch {key} {fname} ({len(data)} bytes)")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fetch", action="store_true", help="re-download public files and compare hashes")
    args = parser.parse_args()
    pins = load_pins()
    errors = check_offline(pins)
    errors += check_shipped()
    if args.fetch:
        errors += check_fetch(pins)
    if errors:
        fail(f"{errors} check(s) failed")
    print("all reuse-audit pin checks passed")


if __name__ == "__main__":
    main()
