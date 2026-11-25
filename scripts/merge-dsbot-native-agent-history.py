"""Merge complete missing agent threads between offline copies of one user's runtimes."""

import argparse
from contextlib import closing
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile


RUNTIME_ID = re.compile(r"[0-9a-f]{32}")
SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,120}")
AGENTS_DB = Path("flybot-workspace/features/agents/agents.sqlite3")
ROSTER = Path("bot/state.json")


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def read_json(path):
    return json.loads(path.read_bytes())


def load_roster(volume, expected_instance):
    identity = read_json(volume / "flybot-workspace/instance.json")
    require(identity.get("routingInstanceId") in (None, expected_instance), "Runtime routing identity differs")
    require(RUNTIME_ID.fullmatch(identity.get("instance_id", "")), "Invalid runtime volume identity")
    inflight = read_json(volume / "bot/inflight.json")
    require(not inflight["turns"] and not inflight["queued"], "Snapshot contains in-flight work")
    return identity["instance_id"], read_json(volume / ROSTER)


def check_account(management, source_id, target_id):
    with closing(sqlite3.connect(management.as_uri() + "?mode=ro", uri=True)) as db:
        source = db.execute("SELECT owner_id,volume_ref FROM instances WHERE id=?", (source_id,)).fetchone()
        target = db.execute("SELECT owner_id,volume_ref FROM instances WHERE id=?", (target_id,)).fetchone()
        require(source and target and source[0] == target[0], "Runtime accounts differ")
        require(source[1] == "ot-" + source_id and target[1] == "ot-" + target_id, "Unexpected volume names")
        binding = db.execute("SELECT workspace_id,agent_id FROM runtime_auto_provisions WHERE user_id=? AND instance_id=?",
                             (source[0], target_id)).fetchone()
        require(binding is not None, "Target is not the account's provisioned runtime")
        return binding


def open_threads(bot):
    return [{"sessionId": bot.get("sessionId", bot["id"]), "segments": bot.get("segments", [])},
            *bot.get("openParts", [])]


def session_ids(part):
    return [part["sessionId"], *(segment["sessionId"] for segment in part.get("segments", []))]


def logs_of(root):
    logs = {}
    for path in (root / "sessions").rglob("session.v4.jsonl.zstd"):
        require(path.is_file() and not path.is_symlink(), "Unexpected session log symlink")
        session = path.parent.name
        require(session not in logs, "A session has multiple event logs")
        logs[session] = path.relative_to(root)
    return logs


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def replace_roster(path, content):
    original = path.stat()
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".roster-", delete=False) as file:
        next_path = Path(file.name)
        try:
            file.write(content)
            file.flush()
            os.fchmod(file.fileno(), original.st_mode & 0o777)
            if os.geteuid() == 0:
                os.fchown(file.fileno(), original.st_uid, original.st_gid)
            os.fsync(file.fileno())
            os.replace(next_path, path)
        finally:
            next_path.unlink(missing_ok=True)


def copy_log(source, destination):
    with source.open("rb") as src, destination.open("xb") as dst:
        shutil.copyfileobj(src, dst)
        dst.flush()
        if os.geteuid() == 0:
            stamp = source.stat()
            os.fchown(dst.fileno(), stamp.st_uid, stamp.st_gid)
        os.fchmod(dst.fileno(), source.stat().st_mode & 0o777)
        os.fsync(dst.fileno())


def merge(management, source, target, source_id, target_id, apply=False):
    require(all(RUNTIME_ID.fullmatch(v) for v in (source_id, target_id)) and source_id != target_id, "Invalid runtime IDs")
    require(source != target and source not in target.parents and target not in source.parents, "Volume copies overlap")
    expected_binding = check_account(management, source_id, target_id)
    left_identity, left_state = load_roster(source, source_id)
    right_identity, right_state = load_roster(target, target_id)
    require(left_identity != right_identity, "Runtime volume identities are identical")

    with closing(sqlite3.connect((target / AGENTS_DB).as_uri() + ("?mode=rw" if apply else "?mode=ro"), uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.execute("ATTACH ? AS old", ((source / AGENTS_DB).as_uri() + "?mode=ro",))
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
        binding = db.execute("SELECT workspace_id,agent_id FROM native_personal_binding WHERE singleton=1").fetchone()
        require(binding and tuple(binding) == expected_binding, "Wrong target personal binding")
        agents = db.execute("SELECT s.* FROM old.agents s LEFT JOIN agents d USING(id) WHERE d.id IS NULL").fetchall()
        conversations = db.execute("""SELECT c.* FROM old.agent_conversations c
            LEFT JOIN agent_conversations d USING(id) WHERE d.id IS NULL""").fetchall()
        missing_messages = db.execute("""SELECT m.* FROM old.agent_messages m
            LEFT JOIN agent_messages d USING(id) WHERE d.id IS NULL""").fetchall()
        conversation_ids = {c["id"] for c in conversations}
        require(all(m["conversation_id"] in conversation_ids for m in missing_messages),
                "An existing thread has a partial message history")
        require(db.execute("""SELECT 1 FROM old.agent_messages s JOIN agent_messages d USING(id)
            WHERE s.conversation_id<>d.conversation_id OR s.role<>d.role""").fetchone() is None,
                "An existing message belongs to a different thread or role")
        require(db.execute("""SELECT 1 FROM old.agent_conversations s JOIN agent_conversations d USING(id)
            WHERE s.agent_id<>d.agent_id""").fetchone() is None, "An existing thread belongs to a different agent")
        require(db.execute("""SELECT 1 FROM old.agents s JOIN agents d USING(id) WHERE s.workspace_id<>d.workspace_id""")
                .fetchone() is None, "An existing agent belongs to a different workspace")
        changed_existing = db.execute("""SELECT COUNT(*) FROM old.agent_messages s JOIN agent_messages d USING(id)
            WHERE s.text IS NOT d.text OR s.status IS NOT d.status OR s.meta IS NOT d.meta OR s.created IS NOT d.created""").fetchone()[0]
        require(db.execute("""SELECT 1 FROM old.agents s JOIN agents d ON s.workspace_id=d.workspace_id AND
            (s.name_hash=d.name_hash OR s.key_hash=d.key_hash) WHERE d.id<>s.id AND NOT EXISTS
            (SELECT 1 FROM agents existing WHERE existing.id=s.id)""").fetchone() is None,
                "An imported agent would collide with an existing name or operation key")

        roster = deepcopy(right_state)
        old_bots, new_bots = left_state["bots"], roster["bots"]
        old_session_owners = {}
        for bot_id, bot in old_bots.items():
            for part in open_threads(bot):
                for sid in session_ids(part):
                    old_session_owners.setdefault(sid, set()).add(bot_id)
        target_sessions = {sid for bot in new_bots.values() for part in open_threads(bot) for sid in session_ids(part)}
        logs, target_logs = logs_of(source), logs_of(target)
        required_sessions = set()
        agent_ids = {a["id"] for a in agents}
        objects, mappings, events, proof = [], [], [], []
        source_part_sessions = {}

        def bot_of(schema, aid, bots):
            row = db.execute(f"SELECT * FROM {schema}.native_agent_objects WHERE agent_id=?", (aid,)).fetchone()
            require(row is not None and row["bot_id"] in bots, "Agent has no native Bot")
            bot = bots[row["bot_id"]]
            require(bot["flybotWorkspace"]["agent_id"] == aid, "Native Bot belongs to a different agent")
            return row, bot

        for agent in agents:
            aid = agent["id"]
            row, bot = bot_of("old", aid, old_bots)
            require(row["bot_id"] not in new_bots and row["bot_id"] not in left_state["mainBotIds"],
                    "Agent Bot ID collides or is the runtime main Bot")
            require(bot["flybotWorkspace"]["workspace_id"] == agent["workspace_id"], "Bot workspace differs from its agent")
            require(all(key.startswith("agent:" + aid + ":") and key.split(":")[-1] in conversation_ids
                        for key in bot["flybotWorkspace"].get("sessionKeys", {})),
                    "An imported Bot has additional named threads outside this merge")
            require(all(b["name"] != bot["name"] for b in new_bots.values()), "Native Bot name collides")
            new_bots[row["bot_id"]] = deepcopy(bot)
            objects.append(row)
            bot_sessions = {sid for part in open_threads(bot) for sid in session_ids(part)}
            require(not bot_sessions.intersection(required_sessions), "Multiple Bots claim a source session")
            required_sessions.update(bot_sessions)

        for convo in conversations:
            aid, cid = convo["agent_id"], convo["id"]
            key = f"agent:{aid}:{cid}"
            old_object, old_bot = bot_of("old", aid, old_bots)
            mapping = db.execute("SELECT * FROM old.native_agent_sessions WHERE conversation_key=?", (key,)).fetchone()
            require(mapping is not None and mapping["agent_id"] == aid, "Thread has no native session mapping")
            sid = mapping["session_id"]
            old_keys = old_bot["flybotWorkspace"].get("sessionKeys", {})
            require(old_keys.get(key) in (None, sid) and all(value != sid or other == key for other, value in old_keys.items()),
                    "Native session key disagrees with SQLite")
            parts = [part for part in open_threads(old_bot) if sid in session_ids(part)]
            require(len(parts) == 1, "Thread has no unique owner on its source Bot")
            ids = set(session_ids(parts[0]))
            require(all(old_session_owners[sid] == {old_object["bot_id"]} for sid in ids),
                    "A conversation session is shared by different source Bots")
            require(not ids.intersection(source_part_sessions), "Multiple conversations claim the same native session")
            source_part_sessions.update(dict.fromkeys(ids, cid))
            require(db.execute("SELECT 1 FROM native_agent_sessions WHERE conversation_key=? OR session_id=?", (key, sid))
                    .fetchone() is None, "Native session mapping collides on destination")
            if aid not in agent_ids:
                _, target_bot = bot_of("main", aid, new_bots)
                keys = target_bot["flybotWorkspace"].setdefault("sessionKeys", {})
                require(key not in keys and target_bot["flybotWorkspace"]["workspace_id"] == old_bot["flybotWorkspace"]["workspace_id"],
                        "Destination Bot contains different scope or session key")
                target_bot.setdefault("openParts", []).append(deepcopy(parts[0]))
                keys[key] = sid
                require(not ids.intersection(required_sessions), "Conversation sessions overlap another Bot")
                required_sessions.update(ids)
            else:
                new_bots[old_object["bot_id"]]["flybotWorkspace"].setdefault("sessionKeys", {})[key] = sid
            mappings.append(mapping)
            proof.append({"id": cid, "agent": aid, "workspace": old_bot["flybotWorkspace"]["workspace_id"],
                          "session": sid, "messages": []})

        by_id = {c["id"]: c for c in proof}
        for message in sorted(missing_messages, key=lambda row: (row["created"], row["id"])):
            event = db.execute("SELECT * FROM old.native_agent_events WHERE message_id=?", (message["id"],)).fetchone()
            require(event is not None and source_part_sessions.get(event["session_id"]) == message["conversation_id"],
                    "Message has no native event in its thread")
            require(db.execute("SELECT 1 FROM native_agent_events WHERE message_id=?", (message["id"],)).fetchone()
                    is None, "A destination event already claims the message ID")
            by_id[message["conversation_id"]]["messages"].append(message["id"])
            events.append(event)
        require(not required_sessions.intersection(target_sessions), "Session already belongs to a destination Bot")
        require(all(SESSION_ID.fullmatch(s) and s in logs and s not in target_logs for s in required_sessions),
                "A required event log is missing or already on the destination")
        report = {"agents": len(agents), "conversations": len(conversations), "messages": len(missing_messages),
                  "lossless_event_logs": len(required_sessions), "destination_versions_preserved": changed_existing}
        if not apply or not required_sessions:
            return report, proof

        original_roster = (target / ROSTER).read_bytes()
        copied = []
        folders = []
        roster_replaced = False
        try:
            for sid in sorted(required_sessions):
                relative = logs[sid]
                destination = target / relative
                require(destination.parent.parent.is_dir() and destination.parent.parent.resolve().is_relative_to(target),
                        "Session base directory is missing or escapes destination")
                stamp = (source / relative).parent.stat()
                destination.parent.mkdir(mode=stamp.st_mode & 0o777)
                folders.append(destination.parent)
                if os.geteuid() == 0:
                    os.chown(destination.parent, stamp.st_uid, stamp.st_gid)
                copied.append(destination)
                copy_log(source / relative, destination)
                require(digest(source / relative) == digest(destination), "Copied event log failed digest check")
            for table, rows in (("agents", agents), ("agent_conversations", conversations), ("agent_messages", missing_messages),
                                ("native_agent_objects", objects), ("native_agent_sessions", mappings), ("native_agent_events", events)):
                if rows:
                    columns = ", ".join(rows[0].keys())
                    parameters = ", ".join("?" for _ in rows[0])
                    db.executemany(f"INSERT INTO {table} ({columns}) VALUES ({parameters})", map(tuple, rows))
            require(db.execute("PRAGMA foreign_key_check").fetchone() is None, "Foreign key integrity check failed")
            replace_roster(target / ROSTER, json.dumps(roster, ensure_ascii=False).encode())
            roster_replaced = True
            db.commit()
        except BaseException:
            db.rollback()
            if roster_replaced:
                replace_roster(target / ROSTER, original_roster)
            for path in copied:
                path.unlink(missing_ok=True)
            for path in folders:
                path.rmdir()
            raise
        return report, proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("management", type=Path)
    parser.add_argument("source", type=Path, help="Offline source volume copy")
    parser.add_argument("target", type=Path, help="Offline destination volume copy")
    parser.add_argument("source_id")
    parser.add_argument("target_id")
    parser.add_argument("--apply", action="store_true", help="Write to the offline target copy")
    parser.add_argument("--proof", type=Path, help="Write private acceptance identifiers to a new file")
    args = parser.parse_args()
    if args.proof:
        require(args.proof.parent.is_dir() and not args.proof.exists() and not args.proof.is_symlink(),
                "Proof path must be new and its parent must exist")
    report, proof = merge(args.management.resolve(strict=True), args.source.resolve(strict=True),
                          args.target.resolve(strict=True), args.source_id, args.target_id, args.apply)
    if args.proof:
        fd = os.open(args.proof, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump({"report": report, "conversations": proof}, out)
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
