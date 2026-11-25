"""Public team directory for signed-in accounts.

An owner can list a workspace with a short summary. A request to join uses the
workspace’s membership approval queue.
"""
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS team_directory_listings (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 summary TEXT NOT NULL,
 invite_id TEXT REFERENCES workspace_invites(id) ON DELETE SET NULL,
 listed_by TEXT NOT NULL REFERENCES users(id),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL);
'''

SUMMARY_MAX = 200
QUERY_MAX = 60
INVITE_TTL = 2592000
INVITE_USES = 50
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')


def valid_summary(value):
    return isinstance(value, str) and len(value.strip()) <= SUMMARY_MAX and not CONTROL.search(value)


def listing(db, workspace_id):
    return db.execute('SELECT * FROM team_directory_listings WHERE workspace_id=?', (workspace_id,)).fetchone()


def like_escape(text):
    return text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def search(db, viewer_id, text, limit):
    pattern = '%' + like_escape(text.strip().lower()) + '%'
    rows = db.execute(
        'SELECT l.workspace_id, l.summary, l.updated, w.name, w.owner_id, '
        ' (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id=w.id) + 1 AS member_count, '
        ' EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=?) AS joined, '
        ' (SELECT r.status FROM workspace_join_requests r WHERE r.workspace_id=w.id AND r.user_id=?) AS request '
        'FROM team_directory_listings l JOIN workspaces w ON w.id=l.workspace_id '
        "WHERE lower(w.name) LIKE ? ESCAPE '\\' OR lower(l.summary) LIKE ? ESCAPE '\\' "
        'ORDER BY member_count DESC, l.updated DESC, l.workspace_id LIMIT ?',
        (viewer_id, viewer_id, pattern, pattern, limit)).fetchall()
    return [view(row, viewer_id) for row in rows]


def view(row, viewer_id):
    if row['owner_id'] == viewer_id or row['joined']:
        membership = 'member'
    elif row['request'] == 'pending':
        membership = 'pending'
    else:
        membership = None
    return {'workspace_id': row['workspace_id'], 'name': row['name'], 'summary': row['summary'],
            'member_count': row['member_count'], 'membership': membership, 'updated': row['updated']}


def listing_view(row):
    if row is None:
        return {'listed': False, 'summary': ''}
    return {'listed': True, 'summary': row['summary'], 'created': row['created'], 'updated': row['updated']}
