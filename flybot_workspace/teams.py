"""Team profiles and the create or convert workspace wizard."""
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS workspace_teams (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 slug TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 converted INTEGER NOT NULL CHECK(converted IN (0,1)),
 created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS team_requests (
 key_hash TEXT PRIMARY KEY,
 request_hash TEXT NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL);
'''

SLUG = re.compile(r'[a-z0-9][a-z0-9-]{1,28}[a-z0-9]')
RESERVED = frozenset({
    'admin', 'api', 'automations', 'docs', 'health', 'invite', 'invites',
    'login', 'logout', 'me', 'members', 'contacts', 'new', 'settings', 'static', 'team',
    'teams', 'v1', 'workspaces',
})


def valid_name(value):
    return (isinstance(value, str) and 1 <= len(value.strip()) <= 60
            and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in value)
            and _unicode(value))


def valid_slug(value):
    return isinstance(value, str) and SLUG.fullmatch(value) and value not in RESERVED


def _unicode(value):
    try:
        value.encode('utf-8')
    except UnicodeError:
        return False
    return True


def load(db, workspace_id):
    return db.execute(
        'SELECT * FROM workspace_teams WHERE workspace_id=?', (workspace_id,)
    ).fetchone()


def by_slug(db, slug):
    return db.execute('SELECT * FROM workspace_teams WHERE slug=?', (slug,)).fetchone()


def attach(db, row):
    data = {key: row[key] for key in ('id', 'owner_id', 'name', 'created')}
    team = load(db, row['id'])
    if team is None:
        data.update({'kind': 'workspace', 'slug': None, 'team_name': None, 'converted': False})
    else:
        data.update({'kind': 'team', 'slug': team['slug'], 'team_name': team['name'],
                     'converted': bool(team['converted'])})
    return data
