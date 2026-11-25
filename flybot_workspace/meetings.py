"""Workspace meeting notes and action items (issue #212).

Self-written for FlyBot; no upstream or Teamily source. This slice stores
manual meeting notes only: title, start time, attendees, transcript, summary and
action items. It does not record audio/video, transcribe, diarize, or dispatch
action items to agents. The existing /space meeting chrome is reused, not
reimplemented.
"""
from datetime import datetime, timezone
import json
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS meetings (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 title_hash TEXT NOT NULL,
 started_at INTEGER NOT NULL,
 attendees TEXT NOT NULL,
 transcript TEXT NOT NULL,
 summary TEXT NOT NULL,
 action_items TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 updated_by TEXT NOT NULL REFERENCES users(id),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, title_hash));
CREATE INDEX IF NOT EXISTS meeting_workspace ON meetings(workspace_id, id);
'''

TITLE_MAX = 120
ATTENDEES_MAX = 50
ATTENDEE_MAX = 80
TRANSCRIPT_MAX = 40000
SUMMARY_MAX = 8000
ACTIONS_MAX = 50
ACTION_TEXT_MAX = 500
STARTED_MAX = 4102444800
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


def valid_title(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= TITLE_MAX and not CONTROL.search(value)


def valid_started_at(value):
    return type(value) is int and 0 <= value <= STARTED_MAX


def valid_attendees(value):
    if not isinstance(value, list) or len(value) > ATTENDEES_MAX:
        return False
    seen = set()
    for item in value:
        if not isinstance(item, str) or not 1 <= len(item.strip()) <= ATTENDEE_MAX or CONTROL.search(item):
            return False
        key = item.strip().casefold()
        if key in seen:
            return False
        seen.add(key)
    return True


def _valid_long_text(value, limit):
    return (isinstance(value, str) and len(value) <= limit and '\x00' not in value
            and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value))


def valid_transcript(value):
    return _valid_long_text(value, TRANSCRIPT_MAX)


def valid_summary(value):
    return _valid_long_text(value, SUMMARY_MAX)


def valid_action_items(value):
    if not isinstance(value, list) or len(value) > ACTIONS_MAX:
        return False
    for item in value:
        if not isinstance(item, dict) or set(item) - {'text', 'done', 'owner'}:
            return False
        text = item.get('text')
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= ACTION_TEXT_MAX or CONTROL.search(text):
            return False
        if 'done' in item and type(item['done']) is not bool:
            return False
        owner = item.get('owner', '')
        if not isinstance(owner, str) or len(owner.strip()) > ATTENDEE_MAX or CONTROL.search(owner):
            return False
    return True


def normalize_action_items(value):
    return [{'text': item['text'].strip(), 'done': bool(item.get('done', False)),
             'owner': (item.get('owner') or '').strip()} for item in value]


def view(row, include_body=True):
    data = {
        'id': row['id'],
        'workspace_id': row['workspace_id'],
        'title': row['title'],
        'started_at': row['started_at'],
        'attendees': json.loads(row['attendees']) if row['attendees'] else [],
        'revision': row['revision'],
        'created': row['created'],
        'updated': row['updated'],
        'created_by': row['created_by'],
        'updated_by': row['updated_by'],
    }
    actions = json.loads(row['action_items']) if row['action_items'] else []
    data['action_count'] = len(actions)
    data['done_count'] = sum(1 for item in actions if item.get('done'))
    if include_body:
        data['summary'] = row['summary']
        data['transcript'] = row['transcript']
        data['action_items'] = actions
    return data


def markdown(row):
    """A portable Markdown export of one stored meeting; no hidden fields."""
    data = view(row)
    started = datetime.fromtimestamp(data['started_at'], tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    lines = [
        '# ' + data['title'],
        '',
        '- 开始时间：' + started,
        '- 参会人：' + ('、'.join(data['attendees']) if data['attendees'] else '未填写'),
        '- 行动项：' + str(data['done_count']) + '/' + str(data['action_count']) + ' 已完成',
        '',
        '## 摘要',
        '',
        data['summary'] or '（未填写）',
        '',
        '## 转写 / 正文',
        '',
        data['transcript'] or '（未填写）',
        '',
        '## 行动项',
        '',
    ]
    if data['action_items']:
        for item in data['action_items']:
            owner = '（' + item['owner'] + '）' if item.get('owner') else ''
            lines.append('- [' + ('x' if item.get('done') else ' ') + '] ' + item['text'] + owner)
    else:
        lines.append('（没有行动项）')
    return '\n'.join(lines) + '\n'


def load(db, workspace_id, meeting_id):
    return db.execute('SELECT * FROM meetings WHERE id=? AND workspace_id=?',
                      (meeting_id, workspace_id)).fetchone()


def listing(db, workspace_id, cursor, limit):
    return db.execute(
        'SELECT * FROM meetings WHERE workspace_id=? AND id>? ORDER BY id LIMIT ?',
        (workspace_id, cursor, limit),
    ).fetchall()


def title_hash(title):
    from .security import digest
    return digest(title.strip().casefold())


def serialize(row):
    return json.dumps(row, ensure_ascii=False, separators=(',', ':'))
