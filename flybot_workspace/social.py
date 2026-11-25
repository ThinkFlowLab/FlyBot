"""Workspace conversation metadata for direct messages and groups.

Groups can include workspace agents as well as human members.
"""
import re

from .security import digest
from . import search

SCHEMA = '''
CREATE TABLE IF NOT EXISTS social_artifact_versions (
 message_id TEXT PRIMARY KEY REFERENCES social_messages(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS social_conversations (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('dm','group')),
 title TEXT NOT NULL,
 dm_key TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, dm_key));
CREATE INDEX IF NOT EXISTS social_conversation_ws
 ON social_conversations(workspace_id, id);
CREATE TABLE IF NOT EXISTS social_members (
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY(conversation_id, user_id));
CREATE INDEX IF NOT EXISTS social_member_user
 ON social_members(workspace_id, user_id, conversation_id);
CREATE TABLE IF NOT EXISTS social_agent_members (
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY(conversation_id, agent_id));
CREATE TABLE IF NOT EXISTS social_agent_replies (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id),
 agent_name TEXT NOT NULL,
 requested_by TEXT NOT NULL REFERENCES users(id),
 prompt TEXT NOT NULL,
 agent_revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 task_id TEXT,
 error_code TEXT,
 body TEXT NOT NULL DEFAULT '',
 seq INTEGER,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(conversation_id, key_hash),
 UNIQUE(conversation_id, seq));
CREATE INDEX IF NOT EXISTS social_agent_reply_pending
 ON social_agent_replies(conversation_id, status);
CREATE TABLE IF NOT EXISTS social_messages (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 body TEXT NOT NULL,
 seq INTEGER NOT NULL,
 created INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(conversation_id, seq),
 UNIQUE(conversation_id, key_hash));
CREATE INDEX IF NOT EXISTS social_message_list
 ON social_messages(conversation_id, seq, id);
CREATE TABLE IF NOT EXISTS social_reads (
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 read_seq INTEGER NOT NULL DEFAULT 0 CHECK(read_seq >= 0),
 PRIMARY KEY(conversation_id, user_id));

CREATE TABLE IF NOT EXISTS social_message_deletions (
 message_id TEXT NOT NULL REFERENCES social_messages(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY(message_id, user_id));
CREATE TABLE IF NOT EXISTS social_message_state (
 message_id TEXT PRIMARY KEY REFERENCES social_messages(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1, edited INTEGER, retracted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS social_preferences (
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN(0,1)),
 PRIMARY KEY(conversation_id,user_id));
CREATE TABLE IF NOT EXISTS social_attachments (
 message_id TEXT PRIMARY KEY REFERENCES social_messages(id) ON DELETE CASCADE,
 artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS social_message_pins (
 conversation_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
 message_id TEXT NOT NULL REFERENCES social_messages(id) ON DELETE CASCADE,
 pinned_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY(conversation_id, message_id));
CREATE TABLE IF NOT EXISTS social_forwards (
 message_id TEXT PRIMARY KEY REFERENCES social_messages(id) ON DELETE CASCADE,
 source_message_id TEXT NOT NULL,
 source_author TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS social_reactions (
 message_id TEXT NOT NULL REFERENCES social_messages(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 emoji TEXT NOT NULL,
 created INTEGER NOT NULL,
 PRIMARY KEY(message_id, user_id, emoji));
'''

# Default reaction set.
REACTIONS = ('👍', '❤️', '😄', '🎉', '👀', '✅')

KINDS = ('dm', 'group')
TITLE_MAX = 80
BODY_MAX = 4000
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
HEX32 = re.compile(r'[0-9a-f]{32}')


def valid_title(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TITLE_MAX and not CONTROL.search(value)


def valid_body(value):
    return (isinstance(value, str) and 1 <= len(value) <= BODY_MAX and '\x00' not in value
            and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value))


def valid_member_ids(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 49:
        return False
    if any(not isinstance(item, str) or not HEX32.fullmatch(item) for item in value):
        return False
    return len(set(value)) == len(value)


def valid_agent_ids(value):
    return isinstance(value, list) and len(value) <= 49 and (
        not value or valid_member_ids(value))


def agent_member_rows(db, conversation_id):
    rows = db.execute(
        'SELECT m.agent_id, a.name, a.archived, m.created FROM social_agent_members m '
        'JOIN workspace_agents a ON a.id=m.agent_id '
        'JOIN social_conversations c ON c.id=m.conversation_id AND c.workspace_id=a.workspace_id '
        'WHERE m.conversation_id=? ORDER BY a.name, m.agent_id', (conversation_id,))
    return [dict(row) for row in rows]


def dm_key(first, second):
    return digest('social-dm:' + ':'.join(sorted((first, second))))


def conversation_view(row, members=None, preview='', agent_members=None):
    data = {key: row[key] for key in (
        'id', 'workspace_id', 'kind', 'title', 'created', 'updated')}
    data['preview'] = preview or ''
    data['agent_members'] = agent_members or []
    if members is not None:
        data['members'] = members
    return data


def message_view(row):
    data = {key: row[key] for key in (
        'id', 'conversation_id', 'workspace_id', 'user_id', 'body', 'created')}
    data.update(revision=row['revision'] if 'revision' in row.keys() else 1,
                edited=row['edited'] if 'edited' in row.keys() else None,
                retracted=bool(row['retracted']) if 'retracted' in row.keys() else False)
    if not data['retracted'] and 'attachment_id' in row.keys() and row['attachment_id']:
        mime = row['attachment_mime'] if 'attachment_mime' in row.keys() else None
        base = '/v1/workspaces/' + row['workspace_id'] + '/artifacts/' + row['attachment_id']
        # A picture is shown inline from the raw file; a document keeps the
        # version-aware export path. The stored media type is what lets the
        # client show a picture as a picture; a client guessing from the
        # filename would render a renamed upload as a document.
        if mime and mime.startswith('image/'):
            path = base + '/file'
        elif row['attachment_revision']:
            path = base + '/versions/' + str(row['attachment_revision']) + '/export'
        else:
            path = base + '/file'
        attachment = {'id': row['attachment_id'], 'title': row['attachment_title'],
                      'kind': row['attachment_kind'], 'revision': row['attachment_revision'],
                      'path': path}
        if mime:
            attachment['mime'] = mime
        data['attachment'] = attachment
    if 'agent_id' in row.keys() and row['agent_id']:
        data.update(role='agent', agent_id=row['agent_id'], agent_name=row['agent_name'],
                    source='runtime_infer')
    return data


# Success-only union: agent output has no human author and shares the group sequence.
MESSAGE_ROWS = """
 SELECT m.id, m.conversation_id, m.workspace_id, m.user_id, m.body, m.seq, m.created,
        NULL AS agent_id, NULL AS agent_name, COALESCE(st.revision,1) AS revision,
        st.edited, COALESCE(st.retracted,0) AS retracted, at.artifact_id AS attachment_id, COALESCE(av.title,af.title) AS attachment_title,
        am.mime AS attachment_mime, av.revision AS attachment_revision, COALESCE(av.kind,'media') AS attachment_kind FROM social_messages m
 LEFT JOIN social_message_state st ON st.message_id=m.id
 LEFT JOIN social_attachments at ON at.message_id=m.id
 LEFT JOIN artifacts af ON af.id=at.artifact_id
 LEFT JOIN artifact_media am ON am.artifact_id=at.artifact_id
 LEFT JOIN social_artifact_versions av ON av.message_id=m.id
 UNION ALL
 SELECT id, conversation_id, workspace_id, NULL, body, seq, updated,
        agent_id, agent_name, 1 AS revision, NULL AS edited, 0 AS retracted, NULL AS attachment_id, NULL AS attachment_title,
        NULL AS attachment_mime, NULL AS attachment_revision, NULL AS attachment_kind
 FROM social_agent_replies WHERE status='succeeded'
"""


def reply_view(row):
    return {key: row[key] for key in (
        'id', 'agent_id', 'agent_name', 'requested_by', 'prompt', 'status',
        'task_id', 'error_code', 'created', 'updated')}


def reply_requests(db, conversation_id):
    return db.execute('SELECT * FROM social_agent_replies WHERE conversation_id=? ORDER BY created, id',
                      (conversation_id,)).fetchall()


def message_slots(db, conversation_id):
    human = db.execute('SELECT COUNT(*) FROM social_messages WHERE conversation_id=?',
                       (conversation_id,)).fetchone()[0]
    replies = db.execute("SELECT COUNT(*) FROM social_agent_replies WHERE conversation_id=? "
                         "AND status IN ('queued','running','succeeded')", (conversation_id,)).fetchone()[0]
    return human + replies


def member_view(row):
    return {key: row[key] for key in ('user_id', 'username', 'created')}


def load(db, workspace_id, conversation_id):
    return db.execute(
        'SELECT * FROM social_conversations WHERE id=? AND workspace_id=?',
        (conversation_id, workspace_id),
    ).fetchone()


def load_by_key(db, workspace_id, key_hash):
    return db.execute(
        'SELECT * FROM social_conversations WHERE workspace_id=? AND key_hash=?',
        (workspace_id, key_hash),
    ).fetchone()


def load_dm(db, workspace_id, key):
    return db.execute(
        'SELECT * FROM social_conversations WHERE workspace_id=? AND dm_key=?',
        (workspace_id, key),
    ).fetchone()


def is_member(db, conversation_id, workspace_id, user_id):
    return db.execute(
        'SELECT 1 FROM social_members WHERE conversation_id=? AND workspace_id=? AND user_id=?',
        (conversation_id, workspace_id, user_id),
    ).fetchone() is not None


def member_rows(db, conversation_id):
    rows = db.execute(
        'SELECT m.user_id, u.username, m.created FROM social_members m '
        'JOIN users u ON u.id=m.user_id WHERE m.conversation_id=? '
        'ORDER BY u.username, m.user_id',
        (conversation_id,),
    ).fetchall()
    return [member_view(row) for row in rows]

def last_previews(db, workspace_id, conversation_ids, user_id=None):
    ids = [item for item in conversation_ids if item]
    if not ids:
        return {}
    placeholders = ','.join('?' * len(ids))
    hidden = ''
    args = [workspace_id, *ids]
    if user_id:
        hidden = ' AND id NOT IN (SELECT message_id FROM social_message_deletions WHERE user_id=?)'
        args.append(user_id)
    rows = db.execute(
        'SELECT conversation_id, body FROM ('
        ' SELECT conversation_id, body,'
        ' ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY seq DESC, id DESC) AS rn'
        f' FROM ({MESSAGE_ROWS}) WHERE workspace_id=? AND conversation_id IN ({placeholders})'
        f" AND trim(body) != ''{hidden}) ranked WHERE rn=1",
        args,
    ).fetchall()
    return {row['conversation_id']: search.snippet(row['body']) for row in rows}


def conversation_item(db, row, members=None, user_id=None):
    preview = last_previews(db, row['workspace_id'], [row['id']], user_id).get(row['id'], '')
    if members is None:
        members = member_rows(db, row['id'])
    return conversation_view(row, members, preview, agent_member_rows(db, row['id']))


def conversation_items(db, rows, user_id=None):
    if not rows:
        return []
    previews = last_previews(db, rows[0]['workspace_id'], [row['id'] for row in rows], user_id)
    return [conversation_view(row, member_rows(db, row['id']), previews.get(row['id'], ''),
                              agent_member_rows(db, row['id']))
            for row in rows]


def listing(db, workspace_id, user_id, cursor, limit):
    return db.execute(
        'SELECT c.* FROM social_conversations c JOIN social_members m '
        'ON m.conversation_id=c.id WHERE c.workspace_id=? AND m.user_id=? AND c.id>? '
        'ORDER BY c.id LIMIT ?',
        (workspace_id, user_id, cursor, limit),
    ).fetchall()


def messages(db, conversation_id, cursor, limit, user_id=None):
    start = 0
    if cursor:
        current = db.execute(
            f'SELECT seq FROM ({MESSAGE_ROWS}) WHERE conversation_id=? AND id=?',
            (conversation_id, cursor),
        ).fetchone()
        if current is None:
            return None
        start = current['seq']
    hidden = ''
    args = [conversation_id, start, limit]
    if user_id:
        hidden = ' AND id NOT IN (SELECT message_id FROM social_message_deletions WHERE user_id=?)'
        args.insert(2, user_id)
    return db.execute(
        f'SELECT * FROM ({MESSAGE_ROWS}) WHERE conversation_id=? AND seq>?{hidden} ORDER BY seq LIMIT ?',
        args,
    ).fetchall()


def load_message_by_key(db, conversation_id, key_hash):
    return db.execute(
        'SELECT * FROM social_messages WHERE conversation_id=? AND key_hash=?',
        (conversation_id, key_hash),
    ).fetchone()


def next_seq(db, conversation_id):
    row = db.execute(
        f'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ({MESSAGE_ROWS}) WHERE conversation_id=?',
        (conversation_id,),
    ).fetchone()
    return row['seq']


def workspace_member_ids(db, workspace):
    ids = {workspace['owner_id']}
    for row in db.execute(
            'SELECT user_id FROM workspace_members m WHERE workspace_id=? AND NOT EXISTS (SELECT 1 FROM '
            'workspace_member_suspensions s WHERE s.workspace_id=m.workspace_id AND s.user_id=m.user_id)',
            (workspace['id'],)):
        ids.add(row['user_id'])
    return ids


def username(db, user_id):
    row = db.execute('SELECT username FROM users WHERE id=?', (user_id,)).fetchone()
    return None if row is None else row['username']


def unread_count(db, conversation_id, user_id):
    return db.execute(
        f"""SELECT COUNT(*) FROM ({MESSAGE_ROWS}) msg
        WHERE msg.conversation_id=? AND msg.retracted=0 AND (msg.user_id IS NULL OR msg.user_id<>?)
        AND msg.seq>COALESCE((SELECT read_seq FROM social_reads
                             WHERE conversation_id=? AND user_id=?),0)""",
        (conversation_id, user_id, conversation_id, user_id)).fetchone()[0]


def mark_read(db, conversation_id, user_id, message_id):
    message = db.execute(f'SELECT seq FROM ({MESSAGE_ROWS}) WHERE conversation_id=? AND id=?',
                         (conversation_id, message_id)).fetchone()
    if message is None:
        return False
    db.execute("""INSERT INTO social_reads(conversation_id,user_id,read_seq) VALUES(?,?,?)
        ON CONFLICT(conversation_id,user_id) DO UPDATE SET read_seq=MAX(read_seq,excluded.read_seq)""",
               (conversation_id, user_id, message['seq']))
    return True


def preference(db, conversation_id, user_id):
    row = db.execute('SELECT pinned FROM social_preferences WHERE conversation_id=? AND user_id=?',
                     (conversation_id, user_id)).fetchone()
    return {'pinned': bool(row and row['pinned'])}


def reactions_for(db, message_ids, user_id):
    """Aggregate reactions per message: [{emoji, count, mine}] in REACTIONS order."""
    ids = [mid for mid in message_ids if mid]
    result = {mid: [] for mid in ids}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        rows = db.execute(
            'SELECT message_id, emoji, COUNT(*) AS count, SUM(user_id=?) AS mine FROM social_reactions '
            f'WHERE message_id IN ({",".join("?" * len(chunk))}) GROUP BY message_id, emoji',
            (user_id, *chunk)).fetchall()
        for row in rows:
            if row['emoji'] in REACTIONS:
                result[row['message_id']].append(
                    {'emoji': row['emoji'], 'count': row['count'], 'mine': bool(row['mine'])})
    for items in result.values():
        items.sort(key=lambda item: REACTIONS.index(item['emoji']))
    return result


def with_reactions(db, views, user_id):
    found = reactions_for(db, [view['id'] for view in views if view.get('role') != 'agent'], user_id)
    for view in views:
        view['reactions'] = [] if view.get('retracted') else found.get(view['id'], [])
    return views


PIN_LIMIT = 20
FORWARD_LIMIT = 20


def pinned_messages(db, conversation_id, user_id=None):
    hidden = ''
    args = [conversation_id]
    if user_id:
        hidden = ' AND m.id NOT IN (SELECT message_id FROM social_message_deletions WHERE user_id=?)'
        args.append(user_id)
    rows = db.execute(
        'SELECT p.message_id, p.pinned_by, p.created, m.body, m.user_id, u.username AS pinned_by_username '
        'FROM social_message_pins p JOIN social_messages m ON m.id=p.message_id '
        'JOIN users u ON u.id=p.pinned_by LEFT JOIN social_message_state st ON st.message_id=m.id '
        f'WHERE p.conversation_id=? AND COALESCE(st.retracted,0)=0{hidden} ORDER BY p.created DESC, p.message_id',
        args).fetchall()
    return [{'message_id': r['message_id'], 'pinned_by': r['pinned_by'], 'pinned_by_username': r['pinned_by_username'],
             'author_id': r['user_id'], 'created': r['created'],
             'excerpt': r['body'] if len(r['body']) <= 120 else r['body'][:119] + '…'} for r in rows]


def forward_info(db, views):
    ids = [v['id'] for v in views if v.get('role') != 'agent']
    if not ids:
        return views
    found = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        for row in db.execute(f'SELECT * FROM social_forwards WHERE message_id IN ({",".join("?" * len(chunk))})', chunk):
            found[row['message_id']] = row['source_author']
    for view in views:
        if view['id'] in found:
            view['forwarded_from'] = {'author': found[view['id']]}
    return views
