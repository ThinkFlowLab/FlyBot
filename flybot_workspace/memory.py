"""Workspace memory pages, next actions, and the relationship graph (issue 8).

Self-written for FlyBot; no upstream, Timeline, Project, or Teamily
source, fonts or marketing copy. Pages, next actions, topics and links are
workspace-scoped. Pages and actions persist on create and can be edited or
deleted. The graph is derived from optional page topics, [[Title]] mentions
in page bodies, and optional manual links. Export covers one saved page as a
Markdown file; it is not a workspace export, a share link, a profile, or
Teamily memory parity, and it is not browser E2E acceptance.
"""
from datetime import datetime, timezone
import json
import re
from urllib.parse import quote

from .search import snippet
from .security import digest

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_page_versions (
 page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 title TEXT NOT NULL,
 body TEXT NOT NULL,
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY(page_id, revision));
CREATE INDEX IF NOT EXISTS memory_page_version_owner
 ON memory_page_versions(workspace_id, page_id, revision);
CREATE TABLE IF NOT EXISTS memory_pages (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 title_hash TEXT NOT NULL,
 body TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 updated_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, title_hash));
CREATE INDEX IF NOT EXISTS memory_page_workspace ON memory_pages(workspace_id, id);
CREATE TABLE IF NOT EXISTS memory_actions (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 notes TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open', 'done')),
 due_at INTEGER CHECK(due_at IS NULL OR due_at >= 0),
 memory_page_id TEXT REFERENCES memory_pages(id) ON DELETE SET NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 updated_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash));
CREATE INDEX IF NOT EXISTS memory_action_workspace ON memory_actions(workspace_id, status, id);
CREATE TABLE IF NOT EXISTS memory_page_topics (
 page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 name_hash TEXT NOT NULL,
 PRIMARY KEY (page_id, name_hash));
CREATE INDEX IF NOT EXISTS memory_page_topic_workspace ON memory_page_topics(workspace_id, name_hash, page_id);
CREATE TABLE IF NOT EXISTS memory_links (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 left_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 right_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, left_id, right_id),
 UNIQUE(workspace_id, key_hash),
 CHECK(left_id < right_id));
CREATE INDEX IF NOT EXISTS memory_link_workspace ON memory_links(workspace_id, id);
CREATE TABLE IF NOT EXISTS memory_suggestions (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 page_id TEXT NOT NULL REFERENCES memory_pages(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 summary TEXT NOT NULL,
 payload TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('open', 'accepted', 'ignored')),
 created INTEGER NOT NULL,
 decided INTEGER,
 applied TEXT);
CREATE INDEX IF NOT EXISTS memory_suggestion_page ON memory_suggestions(workspace_id, page_id, id);
CREATE TABLE IF NOT EXISTS memory_profiles (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 professional TEXT NOT NULL, work_style TEXT NOT NULL, communication TEXT NOT NULL,
 revision INTEGER NOT NULL, updated INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS memory_preferences (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 text TEXT NOT NULL,
 text_hash TEXT NOT NULL,
 position INTEGER NOT NULL,
 created INTEGER NOT NULL,
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, user_id, text_hash),
 UNIQUE(workspace_id, user_id, key_hash));
CREATE INDEX IF NOT EXISTS memory_preference_owner
 ON memory_preferences(workspace_id, user_id, position, id);
"""

TITLE_MAX = 80
BODY_MAX = 8000
PREFERENCE_MAX = 120
ROW_SELECT = (
    'SELECT p.*, cu.username AS created_by_username, uu.username AS updated_by_username '
    'FROM memory_pages p '
    'JOIN users cu ON cu.id=p.created_by '
    'JOIN users uu ON uu.id=p.updated_by '
)


def valid_title(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TITLE_MAX and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value)


def valid_body(value):
    return isinstance(value, str) and len(value) <= BODY_MAX and '\x00' not in value and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value)


def title_hash(title):
    return digest(title.strip().casefold())


def view(row, include_body=True, topics=None):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
        'created_by': row['created_by_username'],
        'updated_by': row['updated_by_username'],
    }
    if include_body:
        data['body'] = row['body']
    else:
        data['preview'] = snippet(row['body'])
    if topics is not None:
        data['topics'] = list(topics)
    return data


def can_edit(role, user_id, row):
    return role in ('owner', 'admin') or row['created_by'] == user_id


def load(db, workspace_id, page_id):
    return db.execute(
        ROW_SELECT + 'WHERE p.id=? AND p.workspace_id=?',
        (page_id, workspace_id),
    ).fetchone()


def listing(db, workspace_id, cursor, limit, needle=''):
    rows = db.execute(
        ROW_SELECT + 'WHERE p.workspace_id=? ORDER BY p.id',
        (workspace_id,),
    ).fetchall()
    if needle:
        rows = [row for row in rows if needle in row['title'].casefold()]
    if cursor:
        rows = [row for row in rows if row['id'] > cursor]
    return rows[:limit]

NOTES_MAX = 2000
ACTION_STATUSES = ('open', 'done')
ACTION_ROW_SELECT = (
    'SELECT a.*, cu.username AS created_by_username, uu.username AS updated_by_username, '
    'mp.title AS memory_page_title '
    'FROM memory_actions a '
    'JOIN users cu ON cu.id=a.created_by '
    'JOIN users uu ON uu.id=a.updated_by '
    'LEFT JOIN memory_pages mp ON mp.id=a.memory_page_id '
)


def valid_notes(value):
    return isinstance(value, str) and len(value) <= NOTES_MAX and '\x00' not in value and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value)


def valid_status(value):
    return value in ACTION_STATUSES


def valid_due_at(value):
    return value is None or (type(value) is int and 0 <= value <= 2 ** 31)


def valid_page_ref(value):
    return value is None or (isinstance(value, str) and bool(re.fullmatch(r'[0-9a-f]{32}', value)))


def action_view(row, include_notes=True):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'status': row['status'],
        'due_at': row['due_at'],
        'memory_page_id': row['memory_page_id'],
        'memory_page_title': row['memory_page_title'],
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
        'created_by': row['created_by_username'],
        'updated_by': row['updated_by_username'],
    }
    if include_notes:
        data['notes'] = row['notes']
    return data


def load_action(db, workspace_id, action_id):
    return db.execute(
        ACTION_ROW_SELECT + 'WHERE a.id=? AND a.workspace_id=?',
        (action_id, workspace_id),
    ).fetchone()


def action_listing(db, workspace_id, cursor, limit, needle='', status=''):
    rows = db.execute(
        ACTION_ROW_SELECT + 'WHERE a.workspace_id=? ORDER BY a.id',
        (workspace_id,),
    ).fetchall()
    if status:
        rows = [row for row in rows if row['status'] == status]
    if needle:
        rows = [row for row in rows if needle in row['title'].casefold()]
    if cursor:
        rows = [row for row in rows if row['id'] > cursor]
    return rows[:limit]

TOPIC_MAX = 40
TOPICS_PER_PAGE = 8
MENTION_RE = re.compile(r'\[\[([^\[\]]{1,80})\]\]')
LINK_ROW_SELECT = (
    'SELECT l.*, cu.username AS created_by_username '
    'FROM memory_links l '
    'JOIN users cu ON cu.id=l.created_by '
)


def valid_topic_name(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TOPIC_MAX and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value)


def normalize_topics(value):
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > TOPICS_PER_PAGE:
        return None
    names, seen = [], set()
    for item in value:
        if not valid_topic_name(item):
            return None
        name = item.strip()
        key = name.casefold()
        if key in seen:
            continue
        seen.add(key)
        names.append(name)
    return names


def topics_for(db, page_ids):
    grouped = {page_id: [] for page_id in page_ids}
    if not page_ids:
        return grouped
    rows = db.execute(
        'SELECT page_id, name FROM memory_page_topics WHERE page_id IN (%s) ORDER BY name COLLATE NOCASE, name'
        % ','.join('?' * len(page_ids)),
        tuple(page_ids),
    ).fetchall()
    for row in rows:
        grouped.setdefault(row['page_id'], []).append(row['name'])
    return grouped


def decorate(db, row, include_body=True):
    if row is None:
        return None
    return view(row, include_body=include_body, topics=topics_for(db, [row['id']]).get(row['id'], []))


def decorate_many(db, rows, include_body=False):
    grouped = topics_for(db, [row['id'] for row in rows])
    return [view(row, include_body=include_body, topics=grouped.get(row['id'], [])) for row in rows]


def replace_topics(db, workspace_id, page_id, names):
    db.execute('DELETE FROM memory_page_topics WHERE page_id=?', (page_id,))
    for name in names:
        db.execute(
            'INSERT INTO memory_page_topics(page_id, workspace_id, name, name_hash) VALUES(?,?,?,?)',
            (page_id, workspace_id, name, digest(name.casefold())),
        )


def mention_titles(body):
    titles, seen = [], set()
    for raw in MENTION_RE.findall(body or ''):
        title = raw.strip()
        if not title:
            continue
        key = title.casefold()
        if key in seen:
            continue
        seen.add(key)
        titles.append(title)
    return titles


def link_pair(first, second):
    if not first or not second or first == second:
        return None
    return (first, second) if first < second else (second, first)


def load_link(db, workspace_id, link_id):
    return db.execute(
        LINK_ROW_SELECT + 'WHERE l.id=? AND l.workspace_id=?',
        (link_id, workspace_id),
    ).fetchone()


def link_view(row):
    return {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'source': row['left_id'],
        'target': row['right_id'],
        'kind': 'manual',
        'created': row['created'],
        'created_by': row['created_by_username'],
    }


def can_edit_link(role, user_id, row):
    return role in ('owner', 'admin') or row['created_by'] == user_id


def graph(db, workspace_id):
    pages = listing(db, workspace_id, cursor='', limit=10_000)
    nodes = decorate_many(db, pages, include_body=False)
    by_id = {row['id']: row for row in pages}
    by_title = {}
    for row in pages:
        by_title.setdefault(row['title'].casefold(), row['id'])
    pairs = {}
    for row in pages:
        for title in mention_titles(row['body']):
            target = by_title.get(title.casefold())
            pair = link_pair(row['id'], target)
            if not pair:
                continue
            pairs[pair] = {'id': None, 'source': pair[0], 'target': pair[1], 'kind': 'mention'}
    for row in db.execute(
        LINK_ROW_SELECT + 'WHERE l.workspace_id=? ORDER BY l.id',
        (workspace_id,),
    ).fetchall():
        if row['left_id'] in by_id and row['right_id'] in by_id:
            pairs[(row['left_id'], row['right_id'])] = {
                'id': row['id'], 'source': row['left_id'], 'target': row['right_id'], 'kind': 'manual',
            }
    edges = [pairs[key] for key in sorted(pairs)]
    topic_index = {}
    for node in nodes:
        for name in node['topics']:
            bucket = topic_index.setdefault(name.casefold(), {'name': name, 'pages': []})
            bucket['pages'].append({'id': node['id'], 'title': node['title']})
    topics = []
    for key in sorted(topic_index):
        item = topic_index[key]
        topics.append({'name': item['name'], 'pages': item['pages'], 'page_count': len(item['pages'])})
    return {
        'nodes': nodes,
        'edges': edges,
        'topics': topics,
        'counts': {'nodes': len(nodes), 'edges': len(edges), 'topics': len(topics)},
    }


def valid_preference(value):
    return (isinstance(value, str) and 1 <= len(value.strip()) <= PREFERENCE_MAX
            and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value))


def preference_hash(text):
    return digest(text.strip().casefold())


def preference_view(row):
    return {'id': row['id'], 'text': row['text'], 'created': row['created']}


def preference_listing(db, workspace_id, user_id):
    return db.execute(
        'SELECT * FROM memory_preferences WHERE workspace_id=? AND user_id=? ORDER BY position, id',
        (workspace_id, user_id),
    ).fetchall()


def load_preference(db, workspace_id, user_id, preference_id):
    return db.execute(
        'SELECT * FROM memory_preferences WHERE id=? AND workspace_id=? AND user_id=?',
        (preference_id, workspace_id, user_id),
    ).fetchone()
EXPORT_NAME_MAX = 60
EXPORT_STAMP = '%Y-%m-%dT%H:%M:%SZ'


def export_flat(value):
    """One front-matter line: whitespace folds so a title cannot add keys."""
    return ' '.join(str(value or '').split())


def export_quoted(value):
    return '"' + export_flat(value).replace('\\', '\\\\').replace('"', '\\"') + '"'


def export_filename(title):
    """An ASCII-safe attachment name; the exact title travels in filename*."""
    flat = re.sub(r'[^A-Za-z0-9._-]+', '-', export_flat(title))
    flat = flat.strip('-._')[:EXPORT_NAME_MAX].strip('-._')
    return (flat or 'memory') + '.md'


def export_disposition(title):
    """Content-Disposition with an ASCII fallback and an RFC 5987 name."""
    return ('attachment; filename="' + export_filename(title) + '"; filename*=UTF-8\'\''
            + quote(export_flat(title)[:TITLE_MAX] or 'memory', safe='') + '.md')


def export_document(row, topics):
    """One saved page as Markdown: YAML front matter, then the body verbatim."""
    lines = ['---', 'title: ' + export_quoted(row['title'])]
    names = [name for name in (export_flat(topic) for topic in topics or []) if name]
    if names:
        lines.append('topics:')
        lines.extend('  - ' + export_quoted(name) for name in names)
    else:
        lines.append('topics: []')
    lines.append('revision: %d' % row['revision'])
    lines.append('updated: ' + datetime.fromtimestamp(row['updated'], timezone.utc).strftime(EXPORT_STAMP))
    lines.append('---')
    body = row['body']
    document = '\n'.join(lines) + '\n\n' + body
    return document if document.endswith('\n') else document + '\n'


VERSION_KEEP = 50
VERSION_ROW_SELECT = (
    'SELECT v.*, u.username AS created_by_username FROM memory_page_versions v '
    'JOIN users u ON u.id=v.created_by '
)


def version_view(row):
    return {
        'revision': row['revision'],
        'title': row['title'],
        'summary': snippet(row['body']) if row['body'].strip() else '（空白正文）',
        'created': row['created'],
        'created_by': row['created_by_username'],
    }


def version_body_view(row):
    return {
        'revision': row['revision'],
        'title': row['title'],
        'body': row['body'],
        'created': row['created'],
        'created_by': row['created_by_username'],
    }


def version_rows(db, workspace_id, page_id, before_revision, limit):
    return db.execute(
        VERSION_ROW_SELECT + 'WHERE v.workspace_id=? AND v.page_id=? AND v.revision<? '
        'ORDER BY v.revision DESC LIMIT ?',
        (workspace_id, page_id, before_revision, limit),
    ).fetchall()


def load_version(db, workspace_id, page_id, revision):
    return db.execute(
        VERSION_ROW_SELECT + 'WHERE v.workspace_id=? AND v.page_id=? AND v.revision=?',
        (workspace_id, page_id, revision),
    ).fetchone()


def record_version(db, workspace_id, page_id, revision, title, body, now, user_id):
    db.execute(
        'INSERT OR IGNORE INTO memory_page_versions VALUES(?,?,?,?,?,?,?)',
        (page_id, workspace_id, revision, title, body, now, user_id),
    )
    # A bounded history keeps the newest VERSION_KEEP revisions; pruning older
    # snapshots never touches the current revision or the live page row.
    db.execute(
        'DELETE FROM memory_page_versions WHERE page_id=? AND revision<=?',
        (page_id, revision - VERSION_KEEP),
    )
SUGGESTION_SELECT = 'SELECT * FROM memory_suggestions WHERE id=? AND workspace_id=? AND page_id=?'


def suggestion_view(row):
    if row is None:
        return None
    try:
        payload = json.loads(row['payload'])
    except ValueError:
        payload = {}
    try:
        applied = json.loads(row['applied']) if row['applied'] else None
    except ValueError:
        applied = None
    return {
        'id': row['id'],
        'kind': row['kind'],
        'summary': row['summary'],
        'status': row['status'],
        'created': row['created'],
        'decided': row['decided'],
        'detail': payload if isinstance(payload, dict) else {},
        'applied': applied if isinstance(applied, dict) else None,
    }


def load_suggestion(db, workspace_id, page_id, suggestion_id):
    return db.execute(SUGGESTION_SELECT, (suggestion_id, workspace_id, page_id)).fetchone()


def paragraphs(body):
    return [part.strip() for part in re.split(r'\n[ \t]*\n', body or '') if part.strip()]


def _paragraph_key(text):
    return re.sub(r'\s+', ' ', text).strip().casefold()


def duplicate_paragraph(body):
    """The first pair of byte-different paragraphs that say the same thing."""
    seen = {}
    for part in paragraphs(body):
        key = _paragraph_key(part)
        if key in seen:
            return seen[key], part
        seen.setdefault(key, part)
    return None, None


def propose(db, workspace_id, page, now, suggestion_id):
    """One suggestion for this page, or None when there is honestly nothing to do."""
    kept, dropped = duplicate_paragraph(page['body'])
    if kept is None:
        return None
    payload = json.dumps({'kept': kept[:4000], 'dropped': dropped[:4000]},
                         ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    summary = '这一页有 2 段重复的正文，可以合并成 1 段。'
    db.execute('INSERT INTO memory_suggestions VALUES(?,?,?,?,?,?,?,?,?,?)',
               (suggestion_id, workspace_id, page['id'], 'merge_paragraphs', summary, payload,
                'open', now, None, None))
    return load_suggestion(db, workspace_id, page['id'], suggestion_id)


def merged_body(body, dropped):
    """Drop later paragraphs that repeat the one the suggestion named; keep the first."""
    key = _paragraph_key(dropped or '')
    kept_any = False
    out = []
    for part in paragraphs(body):
        if _paragraph_key(part) == key:
            if kept_any:
                continue
            kept_any = True
        out.append(part)
    if not out:
        return body
    return '\n\n'.join(out) + ('\n' if body.endswith('\n') else '')


def decide(db, workspace, page, suggestion, action, user_id, now):
    """Apply or decline one suggestion. Accept is the only path that writes a page."""
    status = 'accepted' if action == 'accept' else 'ignored'
    applied = None
    if action == 'accept':
        try:
            payload = json.loads(suggestion['payload'])
        except ValueError:
            payload = {}
        dropped = payload.get('dropped') if isinstance(payload, dict) else ''
        before = page['body']
        after = merged_body(before, dropped)
        if after == before:
            applied = {'removed': None, 'note': '接受时这一页已经没有重复段落，正文未改动。'}
        else:
            db.execute('UPDATE memory_pages SET body=?, revision=revision+1, updated=?, updated_by=? WHERE id=?',
                       (after, now, user_id, page['id']))
            applied = {'removed': dropped, 'before_length': len(before), 'after_length': len(after)}
    db.execute('UPDATE memory_suggestions SET status=?, decided=?, applied=? WHERE id=?',
               (status, now, json.dumps(applied, ensure_ascii=False, sort_keys=True) if applied else None,
                suggestion['id']))
    return applied
