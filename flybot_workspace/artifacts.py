"""Workspace artifacts (issue 9, second slice).

Self-written for FlyBot; no upstream or Teamily source, fonts or
marketing copy. This slice adds media uploads and structured whiteboards
with real persistence, in addition to documents, websites, provenance and
explicit revocable shares. It is not a works-library parity claim and not
browser E2E acceptance. Management has no message store, so message-to-library
is not implemented here.
"""
import hashlib
import json
import os
import re
from html import escape, unescape
from html.parser import HTMLParser
from pathlib import Path

from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS artifacts (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 title_hash TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('document')),
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
CREATE INDEX IF NOT EXISTS artifact_workspace ON artifacts(workspace_id, id);
CREATE TABLE IF NOT EXISTS artifact_favorites (
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created INTEGER NOT NULL,
 PRIMARY KEY (artifact_id, user_id));
CREATE TABLE IF NOT EXISTS artifact_meta (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 render TEXT NOT NULL CHECK(render IN ('website')));
CREATE TABLE IF NOT EXISTS artifact_sources (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('automation_run','agent_task')),
 source_id TEXT NOT NULL,
 automation_id TEXT,
 automation_title TEXT,
 task_kind TEXT,
 created INTEGER NOT NULL,
 UNIQUE(workspace_id, source_kind, source_id));
CREATE TABLE IF NOT EXISTS artifact_shares (
 id TEXT PRIMARY KEY,
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 token_prefix TEXT NOT NULL,
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 expires INTEGER,
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
 revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS artifact_share_item ON artifact_shares(artifact_id, id);
CREATE TABLE IF NOT EXISTS artifact_media (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 mime TEXT NOT NULL,
 byte_count INTEGER NOT NULL CHECK(byte_count >= 1),
 sha256 TEXT NOT NULL,
 filename TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_boards (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 board TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_slides (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 deck TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_dashboards (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 dashboard TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_chat_sources (
 artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL,
 message_id TEXT NOT NULL,
 agent_id TEXT,
 created INTEGER NOT NULL,
 UNIQUE(workspace_id, message_id));
CREATE TABLE IF NOT EXISTS artifact_versions (
 artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 title TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('document', 'website', 'whiteboard', 'media')),
 body TEXT NOT NULL,
 board TEXT,
 mime TEXT,
 byte_count INTEGER,
 sha256 TEXT,
 filename TEXT,
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 PRIMARY KEY (artifact_id, revision));
CREATE INDEX IF NOT EXISTS artifact_version_item ON artifact_versions(artifact_id, revision);
'''

KINDS = ('document', 'website', 'whiteboard', 'media')
TITLE_MAX = 80
BODY_MAX = 8000
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
PREFIX_LEN = 8
MAX_MEDIA_BYTES = 2 * 1024 * 1024
BOARD_JSON_MAX = 65536
MAX_STROKES = 200
MAX_POINTS = 400
BOARD_MIN, BOARD_MAX = 100, 2000
HEX32 = re.compile(r'[0-9a-f]{32}')
SHA256 = re.compile(r'[0-9a-f]{64}')
SAFE_FILENAME = re.compile(r'[A-Za-z0-9._-]{1,80}')
STROKE_ID = re.compile(r'[A-Za-z0-9_-]{8,32}')
COLOR = re.compile(r'#[0-9A-Fa-f]{6}')
MEDIA_MIMES = {
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'audio/mpeg', 'audio/ogg', 'audio/wav',
    'video/mp4', 'video/webm',
}
IMAGE_MIMES = {'image/png', 'image/jpeg', 'image/gif', 'image/webp'}
EMPTY_BOARD = {'schema': 'flybot-workspace.whiteboard.v1', 'width': 800, 'height': 600, 'strokes': []}
SLIDES_SCHEMA = 'flybot-workspace.slides.v1'
SLIDES_MAX = 30
SLIDE_TITLE_MAX = 120
SLIDE_BULLETS_MAX = 10
SLIDE_BULLET_MAX = 200
EMPTY_SLIDES = {'schema': SLIDES_SCHEMA, 'slides': []}
SLIDE_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
DASHBOARD_SCHEMA = 'flybot-workspace.dashboard.v1'
DASHBOARD_MAX_WIDGETS = 20
DASHBOARD_TABLE_COLUMNS_MAX = 6
DASHBOARD_TABLE_ROWS_MAX = 50
DASHBOARD_CELL_MAX = 200
DASHBOARD_BARS_MAX = 12
DASHBOARD_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
EMPTY_DASHBOARD = {'schema': DASHBOARD_SCHEMA, 'widgets': []}
SHARE_CSP = (
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'self'; object-src 'none'"
)
ALLOWED_TAGS = {
    'p', 'br', 'hr', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'em', 'strong', 'b', 'i', 'u',
    's', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tfoot',
    'tr', 'th', 'td', 'img',
}
VOID_TAGS = {'br', 'hr', 'img'}
FORBIDDEN_TAGS = {
    'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
    'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math',
    'frame', 'frameset', 'applet', 'video', 'audio', 'source', 'track',
    'template', 'noscript', 'canvas',
}
DATA_IMAGE = re.compile(
    r'^data:image/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$', re.IGNORECASE
)
SAFE_FRAGMENT = re.compile(r'#[A-Za-z0-9_-]{1,64}')
ROW_SELECT = (
    'SELECT a.*, cu.username AS created_by_username, uu.username AS updated_by_username, '
    'm.render AS render, s.source_kind AS source_kind, s.source_id AS source_id, '
    's.automation_id AS automation_id, s.automation_title AS automation_title, '
    's.task_kind AS task_kind, md.mime AS media_mime, md.byte_count AS media_bytes, '
    'md.sha256 AS media_sha256, md.filename AS media_filename, b.board AS board_json, '
    'cs.message_id AS chat_message_id, cs.conversation_id AS chat_conversation_id, '
    'cs.agent_id AS chat_agent_id, ac.title AS chat_conversation_title, '
    'sl.deck AS slides_json, '
    'db.dashboard AS dashboard_json, '
    'sc.title AS social_conversation_title '
    'FROM artifacts a '
    'JOIN users cu ON cu.id=a.created_by '
    'JOIN users uu ON uu.id=a.updated_by '
    'LEFT JOIN artifact_meta m ON m.artifact_id=a.id '
    'LEFT JOIN artifact_sources s ON s.artifact_id=a.id '
    'LEFT JOIN artifact_media md ON md.artifact_id=a.id '
    'LEFT JOIN artifact_boards b ON b.artifact_id=a.id '
    'LEFT JOIN artifact_chat_sources cs ON cs.artifact_id=a.id '
    'LEFT JOIN agent_conversations ac ON ac.id=cs.conversation_id '
    'LEFT JOIN social_conversations sc ON sc.id=cs.conversation_id '
    'LEFT JOIN artifact_slides sl ON sl.artifact_id=a.id '
    'LEFT JOIN artifact_dashboards db ON db.artifact_id=a.id '
)


def valid_title(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TITLE_MAX and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', value)


def valid_body(value):
    return isinstance(value, str) and len(value) <= BODY_MAX and '\x00' not in value and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value)


def title_hash(title):
    return digest(title.strip().casefold())


def public_kind(row):
    if row['media_mime']:
        return 'media'
    if row['board_json']:
        return 'whiteboard'
    if row['slides_json']:
        return 'slides'
    if row['dashboard_json']:
        return 'dashboard'
    return 'website' if row['render'] == 'website' else 'document'


def source_view(row):
    if row['chat_message_id']:
        data = {
            'kind': 'agent_message',
            'id': row['chat_message_id'],
            'conversation_id': row['chat_conversation_id'],
        }
        if row['chat_agent_id']:
            data['agent_id'] = row['chat_agent_id']
        title = ''
        try:
            title = row['chat_conversation_title'] or row['social_conversation_title'] or ''
        except (KeyError, IndexError):
            pass
        title = title.strip()
        if title:
            data['conversation_title'] = title
        return data
    if not row['source_kind']:
        return None
    data = {'kind': row['source_kind'], 'id': row['source_id']}
    if row['automation_id']:
        data['automation_id'] = row['automation_id']
    if row['automation_title']:
        data['automation_title'] = row['automation_title']
    if row['task_kind']:
        data['task_kind'] = row['task_kind']
    return data


def view(row, include_body=True):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'kind': public_kind(row),
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
        'created_by': row['created_by_username'],
        'updated_by': row['updated_by_username'],
    }
    source = source_view(row)
    if source:
        data['source'] = source
    kind = data['kind']
    if kind == 'media':
        data['media'] = {
            'mime': row['media_mime'],
            'bytes': row['media_bytes'],
            'filename': row['media_filename'],
        }
    elif kind == 'whiteboard':
        if include_body:
            data['board'] = decode_board(row['board_json']) or dict(EMPTY_BOARD)
    elif kind == 'slides':
        if include_body:
            data['slides'] = decode_slides(row['slides_json']) or dict(EMPTY_SLIDES)
    elif kind == 'dashboard':
        if include_body:
            data['dashboard'] = decode_dashboard(row['dashboard_json']) or dict(EMPTY_DASHBOARD)
    elif include_body:
        data['body'] = row['body']
    if not include_body:
        thumb = preview(row)
        if thumb is not None:
            data['preview'] = thumb
    return data


PREVIEW_LINES = 4
PREVIEW_LINE_MAX = 90
PREVIEW_STROKES = 24
PREVIEW_POINTS = 24
_TAG = re.compile(r'<[^>]*>')
_BLOCK_TAG = re.compile(r'</?(?:p|div|h[1-6]|li|br|tr|blockquote|pre|section|article)\b[^>]*>', re.IGNORECASE)
_HEADING = re.compile(r'<h[1-3]\b[^>]*>(.*?)</h[1-3]>', re.IGNORECASE | re.DOTALL)


def _preview_text(value):
    text = re.sub(r'\s+', ' ', unescape(value or '')).strip()
    return text[:PREVIEW_LINE_MAX]


def _text_lines(body, html=False):
    source = body or ''
    if html:
        source = re.sub(r'(?is)<(script|style)\b.*?</\1>', ' ', source)
        source = _BLOCK_TAG.sub('\n', source)
        source = _TAG.sub(' ', source)
    lines = []
    for raw in source.splitlines():
        line = raw.strip()
        if not line:
            continue
        line = re.sub(r'^(#{1,6}\s+|[-*+]\s+|>\s*|\d+[.)]\s+)', '', line)
        line = re.sub(r'[*_`~]{1,3}', '', line)
        line = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', line)
        line = _preview_text(line)
        if line:
            lines.append(line)
        if len(lines) >= PREVIEW_LINES + 1:
            break
    return lines


def preview(row):
    """Small, text-only thumbnail model derived from the stored content.

    The client draws it with DOM text and SVG shapes; no stored HTML is ever
    passed through. Media previews are the media file itself, so none here.
    """
    kind = public_kind(row)
    if kind == 'media':
        return None
    if kind == 'whiteboard':
        board = decode_board(row['board_json']) or dict(EMPTY_BOARD)
        shapes = []
        for stroke in board['strokes'][:PREVIEW_STROKES]:
            item = {'type': stroke['type'], 'color': stroke['color']}
            if stroke['type'] == 'path':
                points = stroke['points']
                step = max(1, -(-len(points) // PREVIEW_POINTS))
                sampled = points[::step]
                if sampled[-1] is not points[-1]:
                    sampled.append(points[-1])
                item['points'] = [[round(x), round(y)] for x, y in sampled]
                item['width'] = stroke['width']
            elif stroke['type'] == 'text':
                item.update(x=round(stroke['x']), y=round(stroke['y']), size=stroke['size'],
                            text=stroke['text'][:40])
            else:
                item.update(x=round(stroke['x']), y=round(stroke['y']),
                            width=round(stroke['width']), height=round(stroke['height']))
            shapes.append(item)
        return {'type': 'board', 'width': board['width'], 'height': board['height'],
                'shapes': shapes, 'count': len(board['strokes'])}
    if kind == 'slides':
        deck = decode_slides(row['slides_json']) or dict(EMPTY_SLIDES)
        slides = deck['slides']
        first = slides[0] if slides else {'title': '', 'bullets': []}
        return {'type': 'slides', 'title': _preview_text(first['title']),
                'bullets': [_preview_text(item) for item in first['bullets'][:3]],
                'count': len(slides)}
    if kind == 'dashboard':
        dashboard = decode_dashboard(row['dashboard_json']) or dict(EMPTY_DASHBOARD)
        widgets = []
        for widget in dashboard['widgets'][:4]:
            item = {'type': widget['type'], 'title': _preview_text(widget['title'])}
            if widget['type'] == 'metric':
                item['value'] = _preview_text(widget['value'])[:24]
            elif widget['type'] == 'bar':
                top = max(widget['values']) or 1
                item['bars'] = [round(value * 100 / top) for value in widget['values'][:8]]
            else:
                item['columns'] = [_preview_text(column)[:24] for column in widget['columns'][:4]]
                item['rows'] = min(len(widget['rows']), 99)
            widgets.append(item)
        return {'type': 'dashboard', 'widgets': widgets}
    body = row['body'] if 'body' in row.keys() else ''
    if kind == 'website':
        match = _HEADING.search(body or '')
        heading = _preview_text(_TAG.sub(' ', match.group(1))) if match else ''
        lines = _text_lines(body, html=True)
        if heading and lines and lines[0] == heading:
            lines = lines[1:]
        return {'type': 'website', 'heading': heading, 'lines': lines[:PREVIEW_LINES]}
    lines = _text_lines(body)
    heading = ''
    first = (body or '').lstrip().split('\n', 1)[0]
    if first.startswith('#') and lines:
        heading, lines = lines[0], lines[1:]
    # Preserve the first visible block shapes instead of flattening headings,
    # lists and code into indistinguishable prose. Bounded, text-only, never HTML.
    blocks = []
    in_code = False
    for raw in (body or '').splitlines():
        value = raw.strip()
        if value.startswith('```'):
            in_code = not in_code
            continue
        if not value:
            continue
        block_type = ('code' if in_code else 'heading' if re.match(r'^#{1,3}\s', value)
                      else 'list' if re.match(r'^(?:[-*+] |[0-9]+[.)] )', value)
                      else 'quote' if value.startswith('>') else 'text')
        text = _text_lines(value)
        if text:
            blocks.append({'type': block_type, 'text': text[0]})
        if len(blocks) >= 6:
            break
    return {'type': 'document', 'heading': heading, 'lines': lines[:PREVIEW_LINES], 'blocks': blocks}


def can_edit(role, user_id, row):
    return role in ('owner', 'admin') or row['created_by'] == user_id


def load(db, workspace_id, artifact_id):
    return db.execute(
        ROW_SELECT + 'WHERE a.id=? AND a.workspace_id=?',
        (artifact_id, workspace_id),
    ).fetchone()


def listing(db, workspace_id, cursor, limit, needle=''):
    rows = db.execute(
        ROW_SELECT + 'WHERE a.workspace_id=? ORDER BY a.id',
        (workspace_id,),
    ).fetchall()
    if needle:
        rows = [row for row in rows if needle in row['title'].casefold()]
    if cursor:
        rows = [row for row in rows if row['id'] > cursor]
    return rows[:limit]


def set_render(db, artifact_id, kind):
    db.execute('DELETE FROM artifact_meta WHERE artifact_id=?', (artifact_id,))
    if kind == 'website':
        db.execute('INSERT INTO artifact_meta VALUES(?,?)', (artifact_id, 'website'))


def attach_source(db, artifact_id, workspace_id, now, source_kind, source_id, automation_id=None, automation_title=None, task_kind=None):
    db.execute(
        'INSERT INTO artifact_sources VALUES(?,?,?,?,?,?,?,?)',
        (artifact_id, workspace_id, source_kind, source_id, automation_id, automation_title, task_kind, now),
    )


def load_source_artifact(db, workspace_id, source_kind, source_id):
    row = db.execute(
        'SELECT artifact_id FROM artifact_sources WHERE workspace_id=? AND source_kind=? AND source_id=?',
        (workspace_id, source_kind, source_id),
    ).fetchone()
    if row is None:
        return None
    return load(db, workspace_id, row['artifact_id'])


def attach_chat_source(db, artifact_id, workspace_id, now, conversation_id, message_id, agent_id=None):
    db.execute(
        'INSERT INTO artifact_chat_sources VALUES(?,?,?,?,?,?)',
        (artifact_id, workspace_id, conversation_id, message_id, agent_id, now),
    )


def load_chat_artifact(db, workspace_id, message_id):
    row = db.execute(
        'SELECT artifact_id FROM artifact_chat_sources WHERE workspace_id=? AND message_id=?',
        (workspace_id, message_id),
    ).fetchone()
    if row is None:
        return None
    return load(db, workspace_id, row['artifact_id'])


VERSION_SELECT = (
    'SELECT v.*, u.username AS created_by_username '
    'FROM artifact_versions v JOIN users u ON u.id=v.created_by '
)


def version_count(db, artifact_id):
    return db.execute(
        'SELECT COUNT(*) FROM artifact_versions WHERE artifact_id=?', (artifact_id,)
    ).fetchone()[0]


def record_version(db, row):
    kind = public_kind(row)
    stored_kind = 'document' if kind in ('slides', 'dashboard') else kind
    if kind == 'slides':
        body = row['slides_json'] or slides_json(EMPTY_SLIDES) or ''
    elif kind == 'dashboard':
        body = row['dashboard_json'] or dashboard_json(EMPTY_DASHBOARD) or ''
    else:
        body = row['body'] if kind in ('document', 'website') else ''
    board = row['board_json'] if kind == 'whiteboard' else None
    mime = row['media_mime'] if kind == 'media' else None
    byte_count = row['media_bytes'] if kind == 'media' else None
    digest_hex = row['media_sha256'] if kind == 'media' else None
    filename = row['media_filename'] if kind == 'media' else None
    db.execute(
        'INSERT OR IGNORE INTO artifact_versions '
        'VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        (row['id'], row['revision'], row['title'], stored_kind, body, board, mime, byte_count,
         digest_hex, filename, row['updated'], row['updated_by']),
    )


def list_versions(db, artifact_id):
    return db.execute(
        VERSION_SELECT + 'WHERE v.artifact_id=? ORDER BY v.revision DESC', (artifact_id,)
    ).fetchall()


def load_version(db, artifact_id, revision):
    return db.execute(
        VERSION_SELECT + 'WHERE v.artifact_id=? AND v.revision=?', (artifact_id, revision)
    ).fetchone()


def version_view(row, include_body=True):
    kind = row['kind']
    data = {
        'revision': row['revision'],
        'title': row['title'],
        'kind': kind,
        'created': row['created'],
        'created_by': row['created_by_username'],
    }
    if kind == 'media':
        data['media'] = {
            'mime': row['mime'],
            'bytes': row['byte_count'],
            'filename': row['filename'],
        }
    else:
        structured_kind, structured = decode_structured(row['body']) if kind == 'document' else (None, None)
        if structured is not None:
            data['kind'] = structured_kind
            if include_body:
                data[structured_kind] = structured
        elif include_body:
            if kind == 'whiteboard':
                data['board'] = decode_board(row['board']) or dict(EMPTY_BOARD)
            else:
                data['body'] = row['body']
    return data


def same_as_version(row, snapshot):
    if row['title'] != snapshot['title']:
        return False
    current_kind = public_kind(row)
    if current_kind in ('slides', 'dashboard'):
        structured_kind, structured = (decode_structured(snapshot['body'])
                                        if snapshot['kind'] == 'document' else (None, None))
        if structured_kind != current_kind:
            return False
        if current_kind == 'slides':
            return row['slides_json'] == slides_json(structured)
        return row['dashboard_json'] == dashboard_json(structured)
    if current_kind != snapshot['kind']:
        return False
    kind = snapshot['kind']
    if kind == 'media':
        return row['media_sha256'] == snapshot['sha256'] and row['media_filename'] == snapshot['filename']
    if kind == 'whiteboard':
        return row['board_json'] == snapshot['board']
    return row['body'] == snapshot['body']


def media_digests(db, artifact_id):
    values = set()
    current = db.execute(
        'SELECT sha256 FROM artifact_media WHERE artifact_id=?', (artifact_id,)
    ).fetchone()
    if current and current['sha256']:
        values.add(current['sha256'])
    for item in db.execute(
        'SELECT sha256 FROM artifact_versions WHERE artifact_id=? AND sha256 IS NOT NULL',
        (artifact_id,),
    ):
        values.add(item['sha256'])
    return values


def export_filename(title, kind, revision=None, media_filename=None):
    if kind == 'media':
        name = clean_filename(media_filename or '')
        return name if name != 'file' or not media_filename else 'file'
    suffix = {'document': '.txt', 'website': '.html', 'whiteboard': '.svg', 'slides': '.html', 'dashboard': '.html'}.get(kind, '.txt')
    tag = kind + (f'-{revision}' if revision else '')
    base = tag + suffix
    return base if SAFE_FILENAME.fullmatch(base) else 'artifact' + suffix


def export_headers(content_type, filename, csp=None):
    name = clean_filename(filename)
    headers = [
        ('Content-Type', content_type),
        ('Content-Security-Policy', csp or "default-src 'none'; sandbox; frame-ancestors 'none'; object-src 'none'"),
        ('Cross-Origin-Resource-Policy', 'same-origin'),
        ('X-Content-Type-Options', 'nosniff'),
        ('X-Frame-Options', 'DENY'),
        ('Content-Disposition', 'attachment; filename="' + name + '"'),
        ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'),
    ]
    return headers


def export_bytes(row, data_dir, workspace_id, from_version=False):
    kind = row['kind'] if from_version else public_kind(row)
    title = row['title']
    revision = row['revision']
    if kind == 'media':
        mime = row['mime'] if from_version else row['media_mime']
        digest_hex = row['sha256'] if from_version else row['media_sha256']
        filename = row['filename'] if from_version else row['media_filename']
        expected = row['byte_count'] if from_version else row['media_bytes']
        payload = read_media_bytes(data_dir, workspace_id, digest_hex, expected)
        name = export_filename(title, kind, revision, filename)
        return payload, mime, name
    structured_kind, structured = (None, None)
    if kind == 'slides':
        structured_kind, structured = 'slides', decode_slides(row['slides_json'])
    elif kind == 'dashboard':
        structured_kind, structured = 'dashboard', decode_dashboard(row['dashboard_json'])
    elif from_version and kind == 'document':
        structured_kind, structured = decode_structured(row['body'])
    if structured is not None:
        if structured_kind == 'slides':
            payload = render_slides_page(title, structured).encode('utf-8')
        else:
            payload = render_dashboard_page(title, structured).encode('utf-8')
        return payload, 'text/html; charset=utf-8', export_filename(title, structured_kind, revision)
    if kind == 'website':
        payload = render_website_page(title, row['body']).encode('utf-8')
        return payload, 'text/html; charset=utf-8', export_filename(title, kind, revision)
    if kind == 'whiteboard':
        raw = row['board'] if from_version else row['board_json']
        board = decode_board(raw) or dict(EMPTY_BOARD)
        payload = render_board_svg(board).encode('utf-8')
        return payload, 'image/svg+xml; charset=utf-8', export_filename(title, kind, revision)
    body = row['body'] if isinstance(row['body'], str) else ''
    payload = body.encode('utf-8')
    return payload, 'text/plain; charset=utf-8', export_filename(title, kind, revision)


def unique_title(db, workspace_id, title, suffix):
    candidate = title
    if not valid_title(candidate):
        candidate = (title[: TITLE_MAX - 9] + '-' + suffix[:8]).strip('-')
    digest_value = title_hash(candidate)
    if db.execute(
        'SELECT id FROM artifacts WHERE workspace_id=? AND title_hash=?', (workspace_id, digest_value)
    ).fetchone() is None:
        return candidate
    fallback = (title[: TITLE_MAX - 9] + '-' + suffix[:8]).strip()
    if not valid_title(fallback):
        fallback = suffix[:TITLE_MAX]
    return fallback


def share_view(row, include_token=False, token=None):
    data = {
        'id': row['id'],
        'artifact_id': row['artifact_id'],
        'workspace_id': row['workspace_id'],
        'prefix': row['token_prefix'],
        'created': row['created'],
        'created_by': row['created_by_username'] if 'created_by_username' in row.keys() else None,
        'expires': row['expires'],
        'revoked': bool(row['revoked']),
        'scope': 'read',
    }
    if include_token and token:
        data['token'] = token
        data['path'] = '/share/' + token
    return data


def load_share(db, share_id, artifact_id=None):
    sql = (
        'SELECT s.*, u.username AS created_by_username FROM artifact_shares s '
        'JOIN users u ON u.id=s.created_by WHERE s.id=?'
    )
    args = [share_id]
    if artifact_id:
        sql += ' AND s.artifact_id=?'
        args.append(artifact_id)
    return db.execute(sql, args).fetchone()


def list_shares(db, artifact_id):
    return db.execute(
        'SELECT s.*, u.username AS created_by_username FROM artifact_shares s '
        'JOIN users u ON u.id=s.created_by WHERE s.artifact_id=? ORDER BY s.id',
        (artifact_id,),
    ).fetchall()


def active_share_count(db, artifact_id, now):
    return db.execute(
        'SELECT COUNT(*) FROM artifact_shares WHERE artifact_id=? AND revoked=0 '
        'AND (expires IS NULL OR expires>?)',
        (artifact_id, now),
    ).fetchone()[0]


def load_share_by_token(db, token, now):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        return None
    share = db.execute(
        'SELECT * FROM artifact_shares WHERE token_hash=?',
        (digest('share:' + token),),
    ).fetchone()
    if share is None or share['revoked'] == 1 or (share['expires'] is not None and share['expires'] <= now):
        return None
    return load(db, share['workspace_id'], share['artifact_id'])


def safe_href(value):
    text = unescape(value or '').strip()
    if not text or re.search(r'[\x00-\x1f\x7f]', text) or len(text) > 2000:
        return None
    if SAFE_FRAGMENT.fullmatch(text):
        return text
    lowered = text.casefold().lstrip()
    if lowered.startswith(('javascript:', 'vbscript:', 'data:')):
        return None
    for scheme in ('https://', 'http://', 'mailto:'):
        if lowered.startswith(scheme) and len(text) > len(scheme):
            return text
    return None


def safe_img_src(value):
    text = unescape(value or '').strip().replace(' ', '')
    if DATA_IMAGE.fullmatch(text) and len(text) <= BODY_MAX:
        return text
    return None


def _ok_attr(tag, name, value):
    name = name.casefold()
    if name.startswith('on') or name in {'style', 'srcset', 'srcdoc', 'xlink:href', 'formaction'}:
        return None
    if tag == 'a' and name in {'href', 'title'}:
        if name == 'title':
            return value[:200] if isinstance(value, str) and not re.search(r'[\x00-\x1f]', value) else None
        return safe_href(value)
    if tag == 'img' and name in {'src', 'alt', 'width', 'height'}:
        if name == 'src':
            return safe_img_src(value)
        if name == 'alt':
            return value[:200] if isinstance(value, str) and not re.search(r'[\x00-\x1f]', value) else ''
        if name in {'width', 'height'} and isinstance(value, str) and re.fullmatch(r'[0-9]{1,4}', value):
            return value
        return None
    if tag in {'td', 'th'} and name in {'colspan', 'rowspan'} and isinstance(value, str) and re.fullmatch(r'[0-9]{1,2}', value):
        return value
    return None


class _Sanitizer(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.stack = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.casefold()
        if tag in FORBIDDEN_TAGS:
            if tag not in VOID_TAGS:
                self.skip += 1
            return
        if self.skip or tag not in ALLOWED_TAGS:
            return
        pieces = [tag]
        for name, value in attrs:
            allowed = _ok_attr(tag, name, value if value is not None else '')
            if allowed is not None:
                pieces.append(name.casefold() + '="' + escape(allowed, quote=True) + '"')
        if tag == 'a' and not any(part.startswith('href=') for part in pieces[1:]):
            return
        if tag == 'img' and not any(part.startswith('src=') for part in pieces[1:]):
            return
        text = '<' + ' '.join(pieces) + (' />' if tag in VOID_TAGS else '>')
        self.parts.append(text)
        if tag not in VOID_TAGS:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        tag = tag.casefold()
        if tag in FORBIDDEN_TAGS:
            if tag not in VOID_TAGS and self.skip:
                self.skip -= 1
            return
        if self.skip or tag not in ALLOWED_TAGS or tag in VOID_TAGS:
            return
        if tag in self.stack:
            while self.stack:
                current = self.stack.pop()
                self.parts.append('</' + current + '>')
                if current == tag:
                    break

    def handle_data(self, data):
        if not self.skip and data:
            self.parts.append(escape(data, quote=False))

    def handle_comment(self, data):
        return

    def handle_pi(self, data):
        return

    def handle_decl(self, decl):
        return

    def unknown_decl(self, data):
        return

    def close_open(self):
        while self.stack:
            self.parts.append('</' + self.stack.pop() + '>')
        return ''.join(self.parts)


def sanitize_html(source):
    parser = _Sanitizer()
    try:
        parser.feed(source or '')
        parser.close()
    except Exception:
        return escape(source or '')
    return parser.close_open()


def render_document_page(title, body):
    heading = escape(title or '文档')
    content = escape(body or '')
    return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>'
        '<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;'
        'line-height:1.5}pre{white-space:pre-wrap;word-break:break-word}</style>'
        '</head><body><article><h1>' + heading + '</h1><pre>' + content + '</pre>'
        '</article></body></html>'
    )


def render_website_page(title, body):
    heading = escape(title or '网站')
    content = sanitize_html(body or '')
    return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>'
        '<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;line-height:1.5}</style>'
        '</head><body>' + content + '</body></html>'
    )


def render_slides_page(title, deck):
    heading = escape(title or '幻灯片')
    slides = (deck or {}).get('slides') or []
    parts = [
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>',
        '<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;padding:1.5rem}'
        '.deck{display:grid;gap:1rem;max-width:52rem;margin:0 auto}'
        '.slide{background:#fff;border:1px solid #d8dde6;border-radius:14px;padding:1.2rem 1.4rem;'
        'box-shadow:0 1px 2px rgba(0,0,0,.04)}'
        '.slide h2{margin:.2rem 0 .6rem;font-size:1.35rem}'
        '.slide .n{font-size:.75rem;color:#5b6472;letter-spacing:.08em}'
        '.slide ul{margin:0;padding-left:1.2rem;line-height:1.7}'
        '.slide li{margin:.15rem 0}'
        '.slide.empty .hint{color:#5b6472;font-size:.85rem}</style>',
        '</head><body><main class="deck">',
    ]
    if not slides:
        parts.append('<section class="slide empty"><span class="n">1</span>'
                     '<h2>' + heading + '</h2><p class="hint">还没有幻灯片内容。</p></section>')
    for index, slide in enumerate(slides, 1):
        parts.append('<section class="slide"><span class="n">' + str(index) + '</span>'
                     '<h2>' + escape(slide.get('title') or '') + '</h2>')
        bullets = slide.get('bullets') or []
        if bullets:
            parts.append('<ul>' + ''.join('<li>' + escape(item) + '</li>' for item in bullets) + '</ul>')
        parts.append('</section>')
    parts.append('</main></body></html>')
    return ''.join(parts)


def render_dashboard_page(title, dashboard):
    heading = escape(title or '看板')
    widgets = (dashboard or {}).get('widgets') or []
    parts = [
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
        '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>',
        '<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;padding:1.5rem}'
        '.board{max-width:56rem;margin:0 auto;display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}'
        '.widget{background:#fff;border:1px solid #d8dde6;border-radius:14px;padding:1rem 1.2rem;'
        'box-shadow:0 1px 2px rgba(0,0,0,.04);grid-column:span 1}'
        '.widget.wide{grid-column:1/-1}'
        '.widget h2{margin:0 0 .6rem;font-size:.95rem;color:#3a4350}'
        '.metric{font-size:1.8rem;font-weight:700}'
        '.note{color:#5b6472;font-size:.85rem;margin:.25rem 0 0}'
        'table{width:100%;border-collapse:collapse;font-size:.9rem}'
        'th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #e6e9ef}'
        '.bar{display:grid;gap:.45rem}'
        '.bar-row{display:grid;grid-template-columns:6rem 1fr 4rem;gap:.5rem;align-items:center;font-size:.85rem}'
        '.bar-track{background:#eef2f8;border-radius:999px;height:.7rem;overflow:hidden}'
        '.bar-fill{background:#7aa2ff;height:100%}</style>',
        '</head><body><main class="board">',
    ]
    if not widgets:
        parts.append('<section class="widget wide"><h2>' + heading + '</h2>'
                     '<p class="note">还没有看板组件。</p></section>')
    for widget in widgets:
        kind = widget.get('type')
        wide = ' wide' if kind in ('table', 'bar') else ''
        parts.append('<section class="widget' + wide + '"><h2>' + escape(widget.get('title') or '') + '</h2>')
        if kind == 'metric':
            parts.append('<p class="metric">' + escape(widget.get('value') or '—') + '</p>')
            if widget.get('note'):
                parts.append('<p class="note">' + escape(widget['note']) + '</p>')
        elif kind == 'table':
            parts.append('<table><thead><tr>' + ''.join(
                '<th>' + escape(column) + '</th>' for column in widget.get('columns') or []) + '</tr></thead><tbody>')
            for row in widget.get('rows') or []:
                parts.append('<tr>' + ''.join('<td>' + escape(cell) + '</td>' for cell in row) + '</tr>')
            parts.append('</tbody></table>')
        elif kind == 'bar':
            labels = widget.get('labels') or []
            values = widget.get('values') or []
            maximum = max(values) if values else 0
            parts.append('<div class="bar">')
            for label, number in zip(labels, values):
                width = (number / maximum * 100) if maximum else 0
                shown = ('%g' % number)
                parts.append('<div class="bar-row"><span>' + escape(label) + '</span>'
                             '<span class="bar-track"><span class="bar-fill" style="width:'
                             + ('%.1f' % width) + '%"></span></span><span>' + escape(shown) + '</span></div>')
            parts.append('</div>')
        parts.append('</section>')
    parts.append('</main></body></html>')
    return ''.join(parts)


def render_page(row):
    kind = public_kind(row)
    if kind == 'slides':
        return render_slides_page(row['title'], decode_slides(row['slides_json']) or EMPTY_SLIDES)
    if kind == 'dashboard':
        return render_dashboard_page(row['title'], decode_dashboard(row['dashboard_json']) or EMPTY_DASHBOARD)
    if kind == 'website':
        return render_website_page(row['title'], row['body'])
    if kind == 'whiteboard':
        return render_whiteboard_page(row['title'], decode_board(row['board_json']) or EMPTY_BOARD)
    if kind == 'media':
        return render_media_page(row)
    return render_document_page(row['title'], row['body'])


def share_headers():
    return [
        ('Content-Type', 'text/html; charset=utf-8'),
        ('Content-Security-Policy', SHARE_CSP),
        ('Cross-Origin-Resource-Policy', 'same-origin'),
        ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'),
        ('X-Frame-Options', 'SAMEORIGIN'),
    ]


def decode_board(raw):
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    return normalize_board(value)


def finite_number(value, lo, hi):
    if type(value) is bool or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float('inf'), float('-inf')):
        return None
    if not lo <= value <= hi:
        return None
    return float(value) if isinstance(value, float) else int(value)


def normalize_stroke(item):
    if not isinstance(item, dict):
        return None
    stroke_id, kind = item.get('id'), item.get('type')
    color = item.get('color', '#111111')
    if not isinstance(stroke_id, str) or not STROKE_ID.fullmatch(stroke_id):
        return None
    if kind not in ('path', 'rect', 'ellipse', 'text') or not isinstance(color, str) or not COLOR.fullmatch(color):
        return None
    if kind == 'path':
        points = item.get('points')
        width = finite_number(item.get('width', 2), 1, 40)
        if not isinstance(points, list) or not 2 <= len(points) <= MAX_POINTS or width is None:
            return None
        cleaned = []
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                return None
            x, y = finite_number(point[0], 0, BOARD_MAX), finite_number(point[1], 0, BOARD_MAX)
            if x is None or y is None:
                return None
            cleaned.append([x, y])
        return {'id': stroke_id, 'type': 'path', 'color': color, 'width': width, 'points': cleaned}
    if kind in ('rect', 'ellipse'):
        x, y = finite_number(item.get('x'), 0, BOARD_MAX), finite_number(item.get('y'), 0, BOARD_MAX)
        w, h = finite_number(item.get('width'), 1, BOARD_MAX), finite_number(item.get('height'), 1, BOARD_MAX)
        if None in (x, y, w, h):
            return None
        return {'id': stroke_id, 'type': kind, 'color': color, 'x': x, 'y': y, 'width': w, 'height': h}
    text = item.get('text', '')
    x, y = finite_number(item.get('x'), 0, BOARD_MAX), finite_number(item.get('y'), 0, BOARD_MAX)
    size = finite_number(item.get('size', 16), 8, 96)
    if not isinstance(text, str) or not 1 <= len(text) <= 200 or '\x00' in text or x is None or y is None or size is None:
        return None
    if any(ord(ch) < 32 and ch not in '\t' for ch in text):
        return None
    return {'id': stroke_id, 'type': 'text', 'color': color, 'x': x, 'y': y, 'size': size, 'text': text}


def normalize_board(value):
    if not isinstance(value, dict):
        return None
    width = finite_number(value.get('width', 800), BOARD_MIN, BOARD_MAX)
    height = finite_number(value.get('height', 600), BOARD_MIN, BOARD_MAX)
    strokes = value.get('strokes', [])
    if width is None or height is None or not isinstance(strokes, list) or len(strokes) > MAX_STROKES:
        return None
    cleaned, seen = [], set()
    for item in strokes:
        stroke = normalize_stroke(item)
        if stroke is None or stroke['id'] in seen:
            return None
        seen.add(stroke['id'])
        cleaned.append(stroke)
    return {
        'schema': 'flybot-workspace.whiteboard.v1',
        'width': int(width),
        'height': int(height),
        'strokes': cleaned,
    }


def apply_board_operations(board, operations):
    current = normalize_board(board)
    if current is None or not isinstance(operations, list) or not 1 <= len(operations) <= MAX_STROKES:
        return None
    strokes = {item['id']: item for item in current['strokes']}
    order = [item['id'] for item in current['strokes']]
    for item in operations:
        if not isinstance(item, dict) or set(item) - {'op', 'stroke', 'id', 'board'}:
            return None
        op = item.get('op')
        if op == 'replace':
            current = normalize_board(item.get('board'))
            if current is None:
                return None
            strokes = {part['id']: part for part in current['strokes']}
            order = [part['id'] for part in current['strokes']]
            continue
        if op == 'add':
            stroke = normalize_stroke(item.get('stroke'))
            if stroke is None or stroke['id'] in strokes or len(order) >= MAX_STROKES:
                return None
            strokes[stroke['id']] = stroke
            order.append(stroke['id'])
            continue
        if op == 'remove':
            stroke_id = item.get('id')
            if not isinstance(stroke_id, str) or stroke_id not in strokes:
                return None
            del strokes[stroke_id]
            order = [key for key in order if key != stroke_id]
            continue
        return None
    current['strokes'] = [strokes[key] for key in order]
    return current


def board_json(board):
    text = json.dumps(board, ensure_ascii=True, separators=(',', ':'))
    if len(text) > BOARD_JSON_MAX:
        return None
    return text


def normalize_slides(value):
    if not isinstance(value, dict) or value.get('schema', SLIDES_SCHEMA) != SLIDES_SCHEMA:
        return None
    slides = value.get('slides')
    if not isinstance(slides, list) or len(slides) > SLIDES_MAX:
        return None
    out = []
    for slide in slides:
        if not isinstance(slide, dict):
            return None
        title = slide.get('title', '')
        bullets = slide.get('bullets', [])
        if not isinstance(title, str) or len(title.strip()) > SLIDE_TITLE_MAX or SLIDE_CONTROL.search(title):
            return None
        if not isinstance(bullets, list) or len(bullets) > SLIDE_BULLETS_MAX:
            return None
        clean = []
        for bullet in bullets:
            if (not isinstance(bullet, str) or len(bullet.strip()) > SLIDE_BULLET_MAX
                    or SLIDE_CONTROL.search(bullet)):
                return None
            if bullet.strip():
                clean.append(bullet.strip())
        if not title.strip() and not clean:
            return None
        out.append({'title': title.strip(), 'bullets': clean})
    return {'schema': SLIDES_SCHEMA, 'slides': out}


def slides_json(deck):
    normalized = normalize_slides(deck)
    if normalized is None:
        return None
    text = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    if len(text) > 65536:
        return None
    return text


def decode_slides(raw):
    if not raw or not isinstance(raw, str) or not raw.lstrip().startswith('{'):
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get('schema') != SLIDES_SCHEMA:
        return None
    return normalize_slides(value)


def attach_slides(db, artifact_id, deck):
    payload = slides_json(deck)
    if payload is None:
        return False
    db.execute('DELETE FROM artifact_slides WHERE artifact_id=?', (artifact_id,))
    db.execute('INSERT INTO artifact_slides VALUES(?,?)', (artifact_id, payload))
    return True


def _dash_text(value, limit):
    return (isinstance(value, str) and len(value.strip()) <= limit
            and not DASHBOARD_CONTROL.search(value))


def normalize_dashboard(value):
    if not isinstance(value, dict) or value.get('schema', DASHBOARD_SCHEMA) != DASHBOARD_SCHEMA:
        return None
    widgets = value.get('widgets')
    if not isinstance(widgets, list) or len(widgets) > DASHBOARD_MAX_WIDGETS:
        return None
    out = []
    for widget in widgets:
        if not isinstance(widget, dict):
            return None
        kind = widget.get('type')
        title = widget.get('title', '')
        if not _dash_text(title, SLIDE_TITLE_MAX) or not title.strip():
            return None
        if kind == 'metric':
            metric_value = widget.get('value', '')
            note = widget.get('note', '')
            if not _dash_text(metric_value, SLIDE_TITLE_MAX) or not _dash_text(note, 200):
                return None
            out.append({'type': 'metric', 'title': title.strip(),
                        'value': metric_value.strip(), 'note': note.strip()})
        elif kind == 'table':
            columns = widget.get('columns')
            rows = widget.get('rows', [])
            if (not isinstance(columns, list) or not 1 <= len(columns) <= DASHBOARD_TABLE_COLUMNS_MAX
                    or any(not _dash_text(column, DASHBOARD_CELL_MAX) for column in columns)):
                return None
            if not isinstance(rows, list) or len(rows) > DASHBOARD_TABLE_ROWS_MAX:
                return None
            clean_rows = []
            for row in rows:
                if (not isinstance(row, list) or len(row) != len(columns)
                        or any(not _dash_text(cell, DASHBOARD_CELL_MAX) for cell in row)):
                    return None
                clean_rows.append([cell.strip() for cell in row])
            out.append({'type': 'table', 'title': title.strip(),
                        'columns': [column.strip() for column in columns], 'rows': clean_rows})
        elif kind == 'bar':
            labels = widget.get('labels')
            values = widget.get('values')
            if (not isinstance(labels, list) or not 1 <= len(labels) <= DASHBOARD_BARS_MAX
                    or any(not _dash_text(label, DASHBOARD_CELL_MAX) for label in labels)):
                return None
            if not isinstance(values, list) or len(values) != len(labels):
                return None
            clean_values = []
            for number in values:
                if type(number) is bool or not isinstance(number, (int, float)):
                    return None
                if not 0 <= number <= 10 ** 12 or number != number:
                    return None
                clean_values.append(number)
            out.append({'type': 'bar', 'title': title.strip(),
                        'labels': [label.strip() for label in labels], 'values': clean_values})
        else:
            return None
    return {'schema': DASHBOARD_SCHEMA, 'widgets': out}


def dashboard_json(value):
    normalized = normalize_dashboard(value)
    if normalized is None:
        return None
    text = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    if len(text) > 65536:
        return None
    return text


def decode_dashboard(raw):
    if not raw or not isinstance(raw, str) or not raw.lstrip().startswith('{'):
        return None
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get('schema') != DASHBOARD_SCHEMA:
        return None
    return normalize_dashboard(value)


def attach_dashboard(db, artifact_id, dashboard):
    payload = dashboard_json(dashboard)
    if payload is None:
        return False
    db.execute('DELETE FROM artifact_dashboards WHERE artifact_id=?', (artifact_id,))
    db.execute('INSERT INTO artifact_dashboards VALUES(?,?)', (artifact_id, payload))
    return True


def decode_structured(raw):
    deck = decode_slides(raw)
    if deck is not None:
        return 'slides', deck
    dashboard = decode_dashboard(raw)
    if dashboard is not None:
        return 'dashboard', dashboard
    return None, None


def render_board_svg(board):
    width, height = int(board['width']), int(board['height'])
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img">'
    ]
    for stroke in board['strokes']:
        color = stroke['color']
        if stroke['type'] == 'path':
            d = ' '.join(
                ('M' if index == 0 else 'L') + f'{point[0]} {point[1]}'
                for index, point in enumerate(stroke['points'])
            )
            parts.append(
                f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{stroke["width"]}" '
                'stroke-linecap="round" stroke-linejoin="round" />'
            )
        elif stroke['type'] == 'rect':
            parts.append(
                f'<rect x="{stroke["x"]}" y="{stroke["y"]}" width="{stroke["width"]}" '
                f'height="{stroke["height"]}" fill="none" stroke="{color}" stroke-width="2" />'
            )
        elif stroke['type'] == 'ellipse':
            cx = stroke['x'] + stroke['width'] / 2
            cy = stroke['y'] + stroke['height'] / 2
            parts.append(
                f'<ellipse cx="{cx}" cy="{cy}" rx="{stroke["width"] / 2}" ry="{stroke["height"] / 2}" '
                f'fill="none" stroke="{color}" stroke-width="2" />'
            )
        else:
            parts.append(
                f'<text x="{stroke["x"]}" y="{stroke["y"]}" fill="{color}" font-size="{stroke["size"]}" '
                f'font-family="system-ui,sans-serif">{escape(stroke["text"], quote=True)}</text>'
            )
    parts.append('</svg>')
    return ''.join(parts)


def render_whiteboard_page(title, board):
    heading = escape(title or '白板')
    svg = render_board_svg(board)
    return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>'
        '<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;line-height:1.5}'
        'svg{max-width:100%;height:auto;border:1px solid #ccc;background:#fff}</style>'
        '</head><body><article><h1>' + heading + '</h1>' + svg + '</article></body></html>'
    )


def render_media_page(row):
    heading = escape(row['title'] or '媒体')
    name = escape(row['media_filename'] or 'file')
    mime = escape(row['media_mime'] or '')
    return (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>'
        '<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;line-height:1.5}</style>'
        '</head><body><article><h1>' + heading + '</h1><p>' + name + ' · ' + mime + '</p>'
        '</article></body></html>'
    )


def sniff_mime(data):
    if not data or len(data) < 12:
        return None
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith(b'GIF87a') or data.startswith(b'GIF89a'):
        return 'image/gif'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        return 'image/webp'
    if data.startswith(b'ID3') or data.startswith(b'\xff\xfb') or data.startswith(b'\xff\xf3'):
        return 'audio/mpeg'
    if data.startswith(b'OggS'):
        return 'audio/ogg'
    if data.startswith(b'RIFF') and data[8:12] == b'WAVE':
        return 'audio/wav'
    if data[4:8] == b'ftyp' and data[8:12] in {b'isom', b'iso2', b'mp41', b'mp42', b'M4A ', b'avc1'}:
        return 'video/mp4'
    if data.startswith(b'\x1a\x45\xdf\xa3'):
        return 'video/webm'
    return None


def clean_filename(name):
    if not isinstance(name, str):
        return 'file'
    if '/' in name or chr(92) in name or '..' in name or name.startswith('.'):
        return 'file'
    if SAFE_FILENAME.fullmatch(name) and name not in {'.', '..'}:
        return name
    return 'file'


def media_root(data_dir):
    return Path(data_dir) / 'artifact-objects'


def media_path(data_dir, workspace_id, digest_hex):
    if not HEX32.fullmatch(workspace_id) or not SHA256.fullmatch(digest_hex):
        raise ValueError('invalid object path')
    return media_root(data_dir) / workspace_id / digest_hex


def _private_dir(path):
    if path.exists() and (path.is_symlink() or not path.is_dir()):
        raise OSError('invalid media directory')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if path.is_symlink() or not path.is_dir():
        raise OSError('invalid media directory')
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise OSError('media directory must be private')


def write_media(data_dir, workspace_id, payload):
    digest_hex = hashlib.sha256(payload).hexdigest()
    folder = media_root(data_dir) / workspace_id
    _private_dir(media_root(data_dir))
    _private_dir(folder)
    path = media_path(data_dir, workspace_id, digest_hex)
    if path.exists() and not path.is_symlink() and path.is_file():
        return digest_hex
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        written = 0
        view = memoryview(payload)
        while written < len(payload):
            written += os.write(fd, view[written:])
        os.fsync(fd)
    finally:
        os.close(fd)
    return digest_hex


def read_media_bytes(data_dir, workspace_id, digest_hex, expected=None):
    path = media_path(data_dir, workspace_id, digest_hex)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not (info.st_mode & 0o170000 == 0o100000) or info.st_size > MAX_MEDIA_BYTES:
            raise OSError('invalid media object')
        if expected is not None and info.st_size != expected:
            raise OSError('media size mismatch')
        data = os.read(fd, info.st_size)
        if len(data) != info.st_size:
            raise OSError('short media read')
        return data
    finally:
        os.close(fd)


def unlink_media(data_dir, workspace_id, digest_hex, db):
    current = db.execute(
        'SELECT COUNT(*) FROM artifact_media md JOIN artifacts a ON a.id=md.artifact_id '
        'WHERE a.workspace_id=? AND md.sha256=?',
        (workspace_id, digest_hex),
    ).fetchone()[0]
    historic = db.execute(
        'SELECT COUNT(*) FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id '
        'WHERE a.workspace_id=? AND v.sha256=?',
        (workspace_id, digest_hex),
    ).fetchone()[0]
    if current or historic:
        return
    path = media_path(data_dir, workspace_id, digest_hex)
    try:
        os.unlink(path)
    except OSError:
        return


def attach_media(db, artifact_id, mime, byte_count, digest_hex, filename):
    db.execute('DELETE FROM artifact_media WHERE artifact_id=?', (artifact_id,))
    db.execute(
        'INSERT INTO artifact_media VALUES(?,?,?,?,?)',
        (artifact_id, mime, byte_count, digest_hex, filename),
    )


def attach_board(db, artifact_id, board):
    payload = board_json(board)
    if payload is None:
        return False
    db.execute('DELETE FROM artifact_boards WHERE artifact_id=?', (artifact_id,))
    db.execute('INSERT INTO artifact_boards VALUES(?,?)', (artifact_id, payload))
    return True


def media_headers(row, payload=False):
    name = clean_filename(row['media_filename'] if 'media_filename' in row.keys() else 'file')
    headers = [
        ('Content-Type', row['media_mime']),
        ('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'self'; object-src 'none'"),
        ('Cross-Origin-Resource-Policy', 'same-origin'),
        ('X-Content-Type-Options', 'nosniff'),
        ('Content-Disposition', 'inline; filename="' + name + '"'),
        ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'),
    ]
    return headers


def parse_multipart(content_type, raw):
    from email import policy
    from email.parser import BytesParser
    if not isinstance(content_type, str) or not isinstance(raw, (bytes, bytearray)) or len(content_type) > 200:
        return None
    if content_type.split(';', 1)[0].strip().lower() != 'multipart/form-data' or 'boundary=' not in content_type.lower():
        return None
    try:
        header = b'Content-Type: ' + content_type.encode('ascii') + b'\r\n\r\n'
    except UnicodeEncodeError:
        return None
    message = BytesParser(policy=policy.default).parsebytes(header + raw)
    if not message.is_multipart():
        return None
    fields, uploads = {}, {}
    for part in message.iter_parts():
        disposition = part.get('Content-Disposition', '')
        name = part.get_param('name', header='content-disposition')
        filename = part.get_param('filename', header='content-disposition')
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', name):
            return None
        payload = part.get_content()
        if filename is not None:
            if name in uploads or not isinstance(payload, (bytes, bytearray, str)):
                return None
            data = payload.encode('utf-8') if isinstance(payload, str) else bytes(payload)
            declared = (part.get_content_type() or 'application/octet-stream').lower()
            uploads[name] = {'filename': filename, 'content_type': declared, 'data': data}
        else:
            if name in fields or not isinstance(payload, str) or len(payload) > TITLE_MAX + 32:
                if isinstance(payload, (bytes, bytearray)) and len(payload) <= TITLE_MAX + 32:
                    try:
                        payload = payload.decode('utf-8')
                    except UnicodeDecodeError:
                        return None
                else:
                    return None
            fields[name] = payload
    return {'fields': fields, 'files': uploads}


def render_listed_media(row, path):
    """Only for explicitly listed works; path is a validated local public slug."""
    mime, source = row['media_mime'], escape(path, quote=True)
    title = escape(row['title'] or '媒体')
    if mime.startswith('image/'):
        player = '<img style="max-width:100%;height:auto" src="' + source + '" alt="' + title + '">'
    elif mime.startswith('audio/'):
        player = '<audio controls preload="metadata" src="' + source + '"></audio>'
    else:
        player = '<video style="max-width:100%" controls preload="metadata" src="' + source + '"></video>'
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>' + title + '</title><body><h1>' + title + '</h1>' + player +
            '<p><a href="' + source + '" download>下载媒体</a></p></body></html>')
