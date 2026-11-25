"""Workspace invite links and membership approval."""

SCHEMA = '''
CREATE TABLE IF NOT EXISTS workspace_invites (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role IN ('admin','member')),
 created INTEGER NOT NULL,
 expires INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 max_uses INTEGER NOT NULL CHECK(max_uses >= 1),
 use_count INTEGER NOT NULL CHECK(use_count >= 0),
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)));
CREATE INDEX IF NOT EXISTS workspace_invite_list ON workspace_invites(workspace_id, id);
CREATE TABLE IF NOT EXISTS workspace_invite_policies (
 invite_id TEXT PRIMARY KEY REFERENCES workspace_invites(id) ON DELETE CASCADE,
 requires_approval INTEGER NOT NULL DEFAULT 0 CHECK(requires_approval IN (0,1)),
 frozen INTEGER NOT NULL DEFAULT 0 CHECK(frozen IN (0,1)));
CREATE TABLE IF NOT EXISTS workspace_join_requests (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 invite_id TEXT NOT NULL REFERENCES workspace_invites(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('admin','member')),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
 created INTEGER NOT NULL,
 decided INTEGER,
 decided_by TEXT REFERENCES users(id),
 UNIQUE(workspace_id, user_id));
'''

# An invite can require owner or admin approval and can be paused independently.

TOKEN = __import__('re').compile(r'[A-Za-z0-9_-]{32,128}')


def policy(db, invite_id):
    row = db.execute('SELECT * FROM workspace_invite_policies WHERE invite_id=?', (invite_id,)).fetchone()
    return {'requires_approval': bool(row and row['requires_approval']), 'frozen': bool(row and row['frozen'])}


def view(row, db=None):
    data = {key: row[key] for key in (
        'id', 'workspace_id', 'role', 'created', 'expires', 'created_by',
        'max_uses', 'use_count', 'revoked')}
    if db is not None:
        data.update(policy(db, row['id']))
    return data


def request_view(row):
    return {key: row[key] for key in (
        'id', 'workspace_id', 'invite_id', 'user_id', 'role', 'status', 'created', 'decided', 'decided_by')} | (
        {'username': row['username']} if 'username' in row.keys() else {}) | (
        {'workspace_name': row['workspace_name']} if 'workspace_name' in row.keys() else {})


def usable(row, now):
    return row['revoked'] == 0 and row['expires'] > now and row['use_count'] < row['max_uses']
