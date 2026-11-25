"""Transfer an unused workspace between attested Social homes for one account."""

import argparse
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def transfer(database, attestation, apply=False):
    platform_account = attestation["platform_user_id"]
    require(re.fullmatch("[0-9a-f]{32}", platform_account), "Invalid platform account")
    keep, drop = attestation["canonical"], attestation["secondary"]
    old, new = keep["social_owner_id"], drop["social_owner_id"]
    require(old != new and keep["home_id"] != drop["home_id"], "Social homes must be distinct")
    require(keep["connected"] and drop["connected"] and keep["platform_user_id"] == platform_account
            and drop.get("platform_user_id") is None, "Unexpected runtime Social attestation")

    uri = database.as_uri() + ("?mode=rw" if apply else "?mode=ro")
    with closing(sqlite3.connect(uri, uri=True)) as db:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
        for identity, expected in ((keep, platform_account), (drop, None)):
            profile = db.execute("SELECT platform_user_id FROM ot_profiles WHERE owner_id=?", (identity["social_owner_id"],)).fetchone()
            require(profile == (expected,), "Social account binding changed")
            require(db.execute("SELECT owner_id FROM bots WHERE id=?", (identity["home_id"],)).fetchone()
                    == (identity["social_owner_id"],), "Bot no longer belongs to its attested home")
        team = db.execute("SELECT id,workspace_id,listed,slug FROM ot_teams WHERE owner_id=?", (new,)).fetchall()
        require(len(team) == 1, "Secondary Social home does not own exactly one workspace")
        team_id, workspace, listed, slug = team[0]
        require(re.fullmatch("[0-9a-f]{32}", workspace) and not listed and slug is None,
                "Expected a private workspace with an unchanged ID")
        members = db.execute("SELECT owner_id,role,suspended,added_by FROM ot_team_members WHERE team_id=?", (team_id,)).fetchall()
        require(members == [(new, "owner", 0, new)], "Workspace has additional members or a changed owner")
        conversation = db.execute(
            "SELECT id,kind,last_seq,created_by FROM ot_conversations WHERE team_id=?", (team_id,)).fetchall()
        require(len(conversation) == 1 and conversation[0][1:] == ("group", 0, new),
                "Workspace does not contain just one empty group")
        conversation_id = conversation[0][0]
        for table, key, value in (
            ("ot_invites", "team_id", team_id), ("ot_join_requests", "team_id", team_id),
            ("ot_messages", "conversation_id", conversation_id), ("ot_conversation_agents", "conversation_id", conversation_id),
            ("ot_group_announcements", "conversation_id", conversation_id),
        ):
            require(db.execute(f"SELECT 1 FROM {table} WHERE {key}=?", (value,)).fetchone() is None,
                    "Workspace has live sharing data")
        require(db.execute("SELECT owner_id,read_seq FROM ot_conversation_members WHERE conversation_id=?", (conversation_id,)).fetchall()
                == [(new, 0)], "The group has other participants or a changed read cursor")
        require(db.execute("SELECT team_id FROM ot_workspace_requests WHERE owner_id=?", (new,)).fetchall() == [(team_id,)],
                "The workspace creation record is missing or changed")

        # Ensure this transfer accounts for every FlyBot reference to the secondary identity.
        expected = {
            ("ot_profiles", "owner_id"): 1,
            ("ot_teams", "owner_id"): 1,
            ("ot_team_members", "owner_id"): 1, ("ot_team_members", "added_by"): 1,
            ("ot_workspace_requests", "owner_id"): 1,
            ("ot_conversations", "created_by"): 1, ("ot_conversation_members", "owner_id"): 1,
        }
        observed = {}
        tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'ot_*'").fetchall()
        for (table,) in tables:
            require(re.fullmatch("[a-z_]+", table), "Unexpected Social schema")
            for column in (r[1] for r in db.execute(f"PRAGMA table_info({table})")):
                require(re.fullmatch("[a-z0-9_]+", column), "Unexpected Social column")
                count = db.execute(f"SELECT count(*) FROM {table} WHERE instr(CAST({column} AS TEXT),?)"
                                   f" OR instr(CAST({column} AS TEXT),?)", (new, drop["home_id"])).fetchone()[0]
                if count:
                    observed[table, column] = count
        require(observed == expected, "Secondary Social home owns additional records")

        if apply:
            for table, column, key, row_id in (
                ("ot_teams", "owner_id", "id", team_id),
                ("ot_team_members", "added_by", "team_id", team_id),
                ("ot_team_members", "owner_id", "team_id", team_id),
                ("ot_workspace_requests", "owner_id", "team_id", team_id),
                ("ot_conversations", "created_by", "id", conversation_id),
                ("ot_conversation_members", "owner_id", "conversation_id", conversation_id),
            ):
                require(db.execute(f"UPDATE {table} SET {column}=? WHERE {key}=? AND {column}=?",
                                   (old, row_id, new)).rowcount == 1, "An expected Social row changed")
            require(db.execute("PRAGMA foreign_key_check").fetchone() is None, "Social foreign key integrity check failed")
            db.commit()
        return {"workspace": workspace, "conversation": conversation_id}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path, help="Offline Bot Social database")
    parser.add_argument("attestation", type=Path, help="Manager-probed Social identities for the same account")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    report = transfer(args.database.resolve(strict=True), json.loads(args.attestation.read_bytes()), args.apply)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
