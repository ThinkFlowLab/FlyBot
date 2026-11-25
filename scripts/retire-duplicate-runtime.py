"""Archive a stopped Compose duplicate after checking its visible history."""

import argparse
from contextlib import closing
from importlib.util import module_from_spec, spec_from_file_location
import json
from pathlib import Path
import re
import sqlite3
import sys
import time


HELPER = Path(__file__).with_name("plan-private-history-migration.py")
AGENTS_DB = Path("flybot-workspace/features/agents/agents.sqlite3")
IMPORT_METADATA = {"ot_feature_migrations", "ot_imports", "ot_users", "ot_boot_imports"}
EXPECTED_WORKSPACE_FILES = {".deployment-persistence-sentinel"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_database(path):
    return closing(sqlite3.connect(path.resolve(strict=True).as_uri() + "?mode=ro", uri=True))


def private_history(management, source, target, source_instance, target_instance):
    spec = spec_from_file_location("private_history", HELPER)
    helper = module_from_spec(spec)
    spec.loader.exec_module(helper)
    _, summary = helper.plan(management, source, target, source_instance, target_instance)
    require(not summary["missing_conversations"] and not summary["missing_messages"],
            "Private chat history still needs to be imported")
    return summary


def agent_history(source, target):
    with read_database(source / AGENTS_DB) as db:
        db.execute("ATTACH ? AS active", ((target / AGENTS_DB).resolve(strict=True).as_uri() + "?mode=ro",))
        db.execute("BEGIN")
        require(db.execute("""
            SELECT 1 FROM (SELECT * FROM main.agents EXCEPT SELECT * FROM active.agents) LIMIT 1
        """).fetchone() is None, "The canonical roster is missing or differs from the duplicate")
        require(db.execute("""
            SELECT 1 FROM main.agent_conversations c LEFT JOIN active.agent_conversations a ON a.id=c.id
            WHERE a.id IS NULL OR a.agent_id<>c.agent_id OR a.title<>c.title OR a.created<>c.created OR a.updated<c.updated
            LIMIT 1
        """).fetchone() is None, "A conversation is missing or differs in the canonical history")
        require(db.execute("""
            SELECT 1 FROM main.agent_messages m LEFT JOIN active.agent_messages a ON a.id=m.id
            WHERE a.id IS NULL OR a.conversation_id<>m.conversation_id OR a.role<>m.role OR a.created<>m.created
              OR NOT ((a.text=m.text AND a.status=m.status) OR
                (m.role='assistant' AND m.text='' AND m.status='failed' AND a.text<>'' AND a.status='succeeded'))
            LIMIT 1
        """).fetchone() is None, "A message is missing or differs in the canonical history")
        for table, key in (("native_agent_objects", "agent_id"),
                           ("native_agent_sessions", "conversation_key"),
                           ("native_agent_events", "message_id")):
            require(db.execute(f"""
                SELECT 1 FROM (SELECT {key} FROM main.{table} EXCEPT SELECT {key} FROM active.{table}) LIMIT 1
            """).fetchone() is None, "A native DS-Bot history mapping is missing")
        sessions = {row[0] for row in db.execute("""
            SELECT DISTINCT a.session_id FROM active.native_agent_events a
            JOIN main.native_agent_events m USING(message_id) WHERE a.event_seq IS NOT NULL
        """)}
        logs = {path.parent.name for path in (target / "sessions").rglob("session.v4.jsonl.zstd")
                if path.is_file() and not path.is_symlink()}
        require(sessions <= logs, "A canonical DS-Bot session has no persisted event log")
        return {table: db.execute(f"SELECT COUNT(*) FROM main.{table}").fetchone()[0]
                for table in ("agents", "agent_conversations", "agent_messages")}


def check_other_data(source):
    for path in (source / "workspace").rglob("*"):
        if path.is_file() or path.is_symlink():
            require(path.relative_to(source / "workspace").as_posix() in EXPECTED_WORKSPACE_FILES
                    and not path.is_symlink(), "An old workspace file still needs to be reconciled")
    require(not any(p.is_file() or p.is_symlink() for p in (source / "attachments").rglob("*")),
            "Old native attachments still need to be reconciled")
    for path in (source / "flybot-workspace/features").glob("*/*.sqlite3"):
        if path.parent.name in {"agents", "chat"}:
            continue
        with read_database(path) as db:
            for (table,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                if table in IMPORT_METADATA or table.startswith("sqlite_"):
                    continue
                require(re.fullmatch(r"[a-z0-9_]+", table) is not None, "Unexpected feature database table")
                require(db.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is None,
                        "The old runtime has feature data that still needs to be reconciled")


def retire(management, source, target, source_instance, target_instance, *, apply=False):
    from flybot_workspace.lifecycle import ensure_retirement_schema, retire_instance

    summary = private_history(management, source, target, source_instance, target_instance)
    summary.update(agent_history(source, target))
    check_other_data(source)
    uri = management.as_uri() + ("?mode=rw" if apply else "?mode=ro")
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.row_factory = sqlite3.Row
        if apply:
            db.execute("BEGIN IMMEDIATE")
            ensure_retirement_schema(db)
        else:
            # Test the same lifecycle guard against an in-memory copy.
            copy = sqlite3.connect(":memory:")
            db.backup(copy)
            with closing(copy):
                ensure_retirement_schema(copy)
                retire_instance(copy, source_instance, target_instance, int(time.time()))
            return summary

        retire_instance(db, source_instance, target_instance, int(time.time()))
        db.execute("DELETE FROM dsbot_upstreams WHERE instance_id=?", (source_instance,))
        db.commit()
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--management", required=True, type=Path)
    parser.add_argument("--legacy-volume", required=True, type=Path)
    parser.add_argument("--canonical-volume", required=True, type=Path)
    parser.add_argument("--source-instance", required=True)
    parser.add_argument("--destination-instance", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    result = retire(args.management.resolve(strict=True),
                    args.legacy_volume.resolve(strict=True), args.canonical_volume.resolve(strict=True),
                    args.source_instance, args.destination_instance, apply=args.apply)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
