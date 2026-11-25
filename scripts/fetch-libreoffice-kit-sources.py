#!/usr/bin/env python3
"""Verify the LibreOffice Kit corresponding-source offer.

Default mode is offline: it checks runtime/third_party/libreoffice-kit
against pins.json (hashes, no engine binaries, recorded core pin).
Pass --fetch to re-download the two public npm tarballs, check their
sha256, and compare LICENSE/NOTICE/sources against this tree.

This is not a legal opinion and does not authorize publishing an image.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OFFER = ROOT / "runtime" / "third_party" / "libreoffice-kit"
PINS = OFFER / "pins.json"
FORBIDDEN_SUFFIXES = (".wasm", ".tgz")
FORBIDDEN_NAMES = {"soffice.data", "soffice.wasm"}


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    raise SystemExit(1)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_pins() -> dict:
    if not PINS.is_file():
        fail(f"missing {PINS}")
    return json.loads(PINS.read_text())


def check_offline(pins: dict) -> int:
    errors = 0
    if pins.get("public_redistributable_image") is not False:
        print("FAIL: offer must not claim a public redistributable image")
        errors += 1
    if "retained" not in (pins.get("office_functionality") or ""):
        print("FAIL: office functionality must be recorded as retained")
        errors += 1
    files = pins.get("files") or {}
    if len(files) < 40:
        print(f"FAIL: pins.json has too few files ({len(files)})")
        errors += 1
    seen = set()
    for path in OFFER.rglob("*"):
        if not path.is_file() or path.name == ".gitignore":
            continue
        if path.relative_to(OFFER).as_posix() in {"pins.json", "README.md"}:
            continue
        rel = str(path.relative_to(OFFER))
        seen.add(rel)
        if path.name in FORBIDDEN_NAMES or path.suffix in FORBIDDEN_SUFFIXES:
            print(f"FAIL: engine binary must not be vendored: {rel}")
            errors += 1
            continue
        rec = files.get(rel)
        digest = sha256(path)
        if not rec:
            print(f"FAIL: unpinned file {rel}")
            errors += 1
        elif rec.get("sha256") != digest or rec.get("bytes") != path.stat().st_size:
            print(f"FAIL: hash mismatch {rel}")
            errors += 1
        else:
            print(f"OK {rel}")
    missing = set(files) - seen
    if missing:
        print(f"FAIL: pinned files missing on disk: {sorted(missing)[:8]}")
        errors += 1
    core = json.loads((OFFER / "wasm/sources/core-source.json").read_text())
    expected = ((pins.get("engine_source_pins_declared_in_wasm_0_1_5") or {}).get("core_source_json") or {})
    if core.get("revision") != expected.get("revision") or core.get("repository") != expected.get("repository"):
        print("FAIL: core-source.json does not match the pin")
        errors += 1
    else:
        print("OK LibreOffice/core pin", core.get("revision"))
    entry_license = ((pins.get("verified_license_text") or {}).get("entry/LICENSE") or {})
    if sha256(OFFER / "entry/LICENSE") != entry_license.get("sha256"):
        print("FAIL: entry LICENSE pin drifted")
        errors += 1
    else:
        print("OK verified entry LICENSE text")
    return errors


def check_fetch(pins: dict) -> int:
    errors = 0
    packages = pins.get("npm_packages") or {}
    mapping = {
        "@deepseek-ai/libreoffice-kit": ("entry", ("LICENSE", "NOTICE", "package.json")),
        "@deepseek-ai/libreoffice-kit-wasm": ("wasm", ()),
    }
    for name, (dest, files) in mapping.items():
        rec = packages.get(name) or {}
        url = rec.get("tarball")
        expected = rec.get("tarball_sha256")
        if not url or not expected:
            print(f"FAIL: missing tarball pin for {name}")
            errors += 1
            continue
        req = urllib.request.Request(url, headers={"User-Agent": "FlyBot-license-audit"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            blob = resp.read()
        digest = hashlib.sha256(blob).hexdigest()
        if digest != expected:
            print(f"FAIL: {name} tarball sha256 {digest} != {expected}")
            errors += 1
            continue
        print(f"OK fetched {name} sha256={digest}")
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "pkg.tgz"
            archive.write_bytes(blob)
            with tarfile.open(archive) as tar:
                if name.endswith("wasm"):
                    members = [m for m in tar.getmembers() if m.name.startswith("package/licenses/") or m.name.startswith("package/sources/") or m.name in {"package/package.json", "package/prebuilds.json"}]
                    tar.extractall(Path(tmp) / "ex", members=members, filter="data")
                    extracted = Path(tmp) / "ex" / "package"
                    for child in ("licenses", "sources", "package.json", "prebuilds.json"):
                        left = extracted / child
                        right = OFFER / dest / child
                        if not left.exists():
                            print(f"FAIL: tarball missing {child}")
                            errors += 1
                            continue
                        if left.is_file():
                            if sha256(left) != sha256(right):
                                print(f"FAIL: {dest}/{child} differs from tarball")
                                errors += 1
                            else:
                                print(f"OK tarball {dest}/{child}")
                        else:
                            for path in left.rglob("*"):
                                if not path.is_file():
                                    continue
                                rel = path.relative_to(extracted)
                                other = OFFER / dest / rel
                                if sha256(path) != sha256(other):
                                    print(f"FAIL: {dest}/{rel} differs from tarball")
                                    errors += 1
                else:
                    tar.extractall(Path(tmp) / "ex", filter="data")
                    extracted = Path(tmp) / "ex" / "package"
                    for name_ in files:
                        if sha256(extracted / name_) != sha256(OFFER / dest / name_):
                            print(f"FAIL: {dest}/{name_} differs from tarball")
                            errors += 1
                        else:
                            print(f"OK tarball {dest}/{name_}")
    return errors


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fetch", action="store_true", help="re-download the public npm tarballs and compare")
    args = parser.parse_args()
    pins = load_pins()
    errors = check_offline(pins)
    if args.fetch:
        errors += check_fetch(pins)
    if errors:
        fail(f"{errors} check(s) failed")
    print("all libreoffice-kit source-offer checks passed")


if __name__ == "__main__":
    main()
