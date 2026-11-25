from . import message_utilities, skill_packages
"""Private SQLite v1 store. One transaction per bounded operation; no runtime secrets."""
from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3
import stat

from . import custom_mcp, agents, artifacts, automations, bot_social, composio, conversations, discover, invites, meetings, members, memory, model_api, notifications, oidc, onboarding, personal, profiles, retired_task_schema, settings, skill_secrets, social, team_directory, teams, skill_installs

SCHEMA = '''
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS session_user ON sessions(user_id, created, token_hash);
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL, created INTEGER NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL,
 UNIQUE(owner_id, key_hash));
CREATE INDEX IF NOT EXISTS workspace_owner ON workspaces(owner_id, id);
CREATE TABLE IF NOT EXISTS rate_limits (
 key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
'''


class Store:
    def __init__(self, data_dir):
        directory = Path(data_dir).absolute()
        # The configured directory is administrator input, never an API field.
        for part in [directory, *directory.parents]:
            if part.is_symlink():
                raise ValueError('Data directory must not use symbolic links')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = directory.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Data directory must be private and owned by this process user')
        self.data_dir = directory
        self.path = directory / 'management.sqlite3'
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError('Database must be a private regular file')
        finally:
            os.close(fd)
        with self.connect() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise ValueError('Unsupported database schema version; no automatic migration')
            if version == 0 and db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
                raise ValueError('Unrecognized non-empty database; refusing initialization')
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('BEGIN IMMEDIATE;\n' + SCHEMA + settings.SCHEMA + members.SCHEMA + automations.SCHEMA + invites.SCHEMA + model_api.SCHEMA + oidc.SCHEMA + skill_installs.SCHEMA + skill_secrets.SCHEMA + teams.SCHEMA + retired_task_schema.SCHEMA + bot_social.SCHEMA + artifacts.SCHEMA + memory.SCHEMA + agents.SCHEMA + conversations.SCHEMA + social.SCHEMA + notifications.SCHEMA + discover.SCHEMA + profiles.SCHEMA + onboarding.SCHEMA + personal.SCHEMA + meetings.SCHEMA + team_directory.SCHEMA + composio.SCHEMA + custom_mcp.SCHEMA + message_utilities.SCHEMA + skill_packages.SCHEMA + '\nPRAGMA user_version=1;\nCOMMIT;')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise
