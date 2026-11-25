"""Retire issued worker credentials while the deployment is stopped and backed up."""

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
from tempfile import NamedTemporaryFile


KEY_FILE = re.compile(r"runtime-key-([a-f0-9]{32})\.json")
LEGACY_FIELDS = {"origin", "token", "hostname"}


def read_regular(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError(f"Expected a private regular file: {path.name}")
        return stream.read(), info


def rewrite(path, contents, info):
    with NamedTemporaryFile(dir=path.parent, prefix=".retire-runtime-", delete=False) as target:
        temporary = Path(target.name)
        try:
            target.write(contents)
            current = os.fstat(target.fileno())
            if (info.st_uid, info.st_gid) != (current.st_uid, current.st_gid):
                os.fchown(target.fileno(), info.st_uid, info.st_gid)
            os.fchmod(target.fileno(), stat.S_IMODE(info.st_mode))
            target.flush()
            os.fsync(target.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def retirement(database, secrets, *, apply=False):
    candidates = []
    bootstrap_count = 0
    for path in sorted(secrets.glob("runtime-key-*.json")):
        match = KEY_FILE.fullmatch(path.name)
        if match is None:
            continue
        raw, info = read_regular(path)
        document = json.loads(raw) if raw.strip() else {}
        if not isinstance(document, dict) or set(document) - LEGACY_FIELDS - {"agent_bootstrap"}:
            raise ValueError(f"Unexpected runtime credential file shape: {path.name}")
        bootstrap = document.get("agent_bootstrap")
        if bootstrap is not None:
            if not isinstance(bootstrap, dict) or bootstrap.get("instance_id") != match[1] or bootstrap.get("feature") != "agents":
                raise ValueError(f"Personal agent bootstrap is bound to another target: {path.name}")
            bootstrap_count += 1
        if LEGACY_FIELDS.intersection(document):
            contents = b"" if bootstrap is None else (json.dumps(
                {"agent_bootstrap": bootstrap}, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            candidates.append((path, contents, info))

    wrapping_key = database.parent / "instance-runtime.wrap"
    try:
        raw, _ = read_regular(wrapping_key)
        if len(raw) != 32:
            raise ValueError("Unexpected legacy wrapping key size")
        has_wrapping_key = True
    except FileNotFoundError:
        has_wrapping_key = False

    uri = database.as_uri() + ("?mode=rw" if apply else "?mode=ro")
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
        keys = db.execute(
            "SELECT COUNT(*) FROM runtime_keys WHERE revoked=0"
            " AND id IN (SELECT key_id FROM instance_runtime_keys)").fetchone()[0]
        blobs = db.execute("SELECT COUNT(*) FROM instance_runtime_keys WHERE token_blob<>''").fetchone()[0]
        if apply:
            db.execute("UPDATE runtime_keys SET revoked=1 WHERE revoked=0"
                       " AND id IN (SELECT key_id FROM instance_runtime_keys)")
            db.execute("UPDATE instance_runtime_keys SET token_blob='' WHERE token_blob<>''")
            for path, contents, info in candidates:
                rewrite(path, contents, info)
            db.commit()
            if has_wrapping_key:
                wrapping_key.unlink()

    return {"files_with_credentials": len(candidates), "bootstrap_bundles": bootstrap_count,
            "unrevoked_issued_keys": keys, "wrapped_credentials": blobs, "wrapping_key_present": has_wrapping_key}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("secrets", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.secrets.is_dir():
        parser.error("The runtime secrets directory is required")
    result = retirement(args.database.resolve(strict=True), args.secrets, apply=args.apply)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
