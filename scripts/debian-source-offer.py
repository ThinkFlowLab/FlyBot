#!/usr/bin/env python3
"""Build a Debian source-offer listing from a built-image inventory.

Reads inventory.json produced by runtime/flybot-image/inventory/collect.mjs
and writes debian-source-offer.md plus debian-packages.json with the exact
installed package and source versions, copyright hashes, and an apt-get
source process. This repository does not host Debian source packages.

This is a compliance collection of pointers, not a legal opinion that the
pointers are a sufficient source offer for a published image.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


HEADER = """# Debian source offer for a FlyBot runtime image

This file is generated from a built-image inventory. It is **not** a legal
opinion and **not** clearance to publish a pre-built image. FlyBot
does not host Debian source packages in this repository.

## Process

The image is based on Debian bookworm (from `node:24-bookworm-slim`) plus
the runtime packages `ca-certificates`, `git`, and `curl` and their
dependencies. For each source package and version below, on a bookworm
system with `deb-src` enabled for the matching pocket of
`http://deb.debian.org/debian` (and `debian-security` where the version
came from a security update):

```
apt-get source {source_package}={source_version}
```

The in-image copyright file path and sha256 are recorded so a later
inventory can detect drift. Enabling `deb-src` and fetching sources is
an operator or release-time step, not something the default image does.
Whether this process is a sufficient source offer for a published image
is legal interpretation and is not decided here.
"""


def load_inventory(path: Path) -> dict:
    inv = json.loads(path.read_text())
    if "os" not in inv or "packages" not in inv["os"]:
        raise SystemExit("inventory.json is missing os.packages")
    return inv


def unique_sources(packages: list[dict]) -> list[dict]:
    grouped: dict[tuple[str, str], dict] = {}
    for pkg in packages:
        key = (pkg.get("source_package") or pkg["name"], pkg.get("source_version") or pkg.get("version") or "")
        rec = grouped.setdefault(
            key,
            {
                "source_package": key[0],
                "source_version": key[1],
                "binaries": [],
            },
        )
        rec["binaries"].append(
            {
                "name": pkg["name"],
                "version": pkg.get("version"),
                "copyright_path": pkg.get("copyright_path"),
                "copyright_sha256": pkg.get("copyright_sha256"),
                "licenses": (pkg.get("copyright_fields") or {}).get("licenses") or [],
            }
        )
    return [grouped[k] for k in sorted(grouped)]


def render(inv: dict) -> tuple[str, dict]:
    os_rel = (inv.get("os") or {}).get("os_release") or {}
    packages = (inv.get("os") or {}).get("packages") or []
    sources = unique_sources(packages)
    payload = {
        "not_a_legal_opinion": True,
        "public_redistributable_image": False,
        "os": os_rel.get("PRETTY_NAME") or os_rel.get("ID"),
        "codename": os_rel.get("VERSION_CODENAME"),
        "binary_package_count": len(packages),
        "source_package_count": len(sources),
        "collected_at": inv.get("collected_at"),
        "sources": sources,
    }
    lines = [
        HEADER.format(source_package="<source>", source_version="<version>"),
        f"- Distro: {payload['os']} ({payload['codename'] or ''})",
        f"- Binary packages: {payload['binary_package_count']}",
        f"- Unique source packages: {payload['source_package_count']}",
        f"- Inventory collected at: {payload['collected_at'] or 'unknown'}",
        "",
        "## Exact source packages",
        "",
        "| Source | Version | Binary packages | Copyright sha256 (first binary) | License fields (union) |",
        "| --- | --- | --- | --- | --- |",
    ]
    for src in sources:
        binaries = ", ".join(f"{b['name']}={b['version']}" for b in src["binaries"])
        licenses = sorted({lic for b in src["binaries"] for lic in b["licenses"]})
        digest = src["binaries"][0].get("copyright_sha256") or ""
        lines.append(
            f"| `{src['source_package']}` | `{src['source_version']}` | {binaries} | `{digest}` | {', '.join(licenses)} |"
        )
    lines.append("")
    lines.append("## apt-get source commands")
    lines.append("")
    lines.append("```")
    for src in sources:
        lines.append(f"apt-get source {src['source_package']}={src['source_version']}")
    lines.append("```")
    lines.append("")
    return "\n".join(lines) + "\n", payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    inv = load_inventory(args.inventory)
    markdown, payload = render(inv)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "debian-source-offer.md").write_text(markdown)
    (args.out / "debian-packages.json").write_text(json.dumps(payload, indent=2) + "\n")
    if payload["binary_package_count"] < 1:
        raise SystemExit("no Debian packages in the inventory")
    print(
        "wrote",
        args.out / "debian-source-offer.md",
        "binaries",
        payload["binary_package_count"],
        "sources",
        payload["source_package_count"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
