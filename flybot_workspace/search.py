"""Workspace-authorized message search (issue #88).

Self-written for FlyBot; no upstream or Teamily source. Searches only the
messages the caller may already read: their own user↔agent conversations and
social conversations they belong to. It is a simple substring scan with a
bounded page, not a full-text index, ranking model or semantic search.
"""
import re

CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
HEX32 = re.compile(r'[0-9a-f]{32}')
QUERY_MAX = 80
SNIPPET_MAX = 160
KINDS = ('all', 'agent', 'social')


def valid_query(value):
    return (isinstance(value, str) and 1 <= len(value.strip()) <= QUERY_MAX
            and not CONTROL.search(value))


def snippet(body):
    text = ' '.join((body or '').split())
    if len(text) <= SNIPPET_MAX:
        return text
    return text[:SNIPPET_MAX] + '…'


def time_after(seat, cursor):
    """Keyset condition on (created, id); nothing before the first page."""
    if seat is None:
        return '', ()
    return 'AND (m.created > ? OR (m.created = ? AND m.id > ?)) ', (seat, seat, cursor)


def cursor_seat(db, workspace_id, user_id, cursor):
    """The created stamp behind a cursor, so a page resumes in time, not in id.

    Message ids are uuid4, so `id > cursor` jumps around a conversation's history.
    Only a message the caller may already read can sit the cursor; an unknown, a
    deleted or a foreign id resolves to None and the next page starts from the
    first one instead of trusting a timestamp outside the caller's scope.
    """
    if not cursor:
        return None
    row = db.execute(
        'SELECT m.created FROM agent_messages m JOIN agent_conversations c ON c.id=m.conversation_id '
        'WHERE m.workspace_id=? AND c.user_id=? AND m.id=?',
        (workspace_id, user_id, cursor)).fetchone()
    if row is not None:
        return row['created']
    from .social import MESSAGE_ROWS
    row = db.execute(
        f'SELECT m.created FROM ({MESSAGE_ROWS}) m '
        'JOIN social_conversations c ON c.id=m.conversation_id AND c.workspace_id=m.workspace_id '
        'JOIN social_members s ON s.conversation_id=c.id AND s.workspace_id=c.workspace_id AND s.user_id=? '
        'WHERE m.workspace_id=? AND m.id=?',
        (user_id, workspace_id, cursor)).fetchone()
    return None if row is None else row['created']


def agent_rows(db, workspace_id, user_id, text, cursor, limit, conversation_id='', seat=None):
    bound, extra = time_after(seat, cursor)
    return db.execute(
        'SELECT m.id, m.conversation_id, m.body, m.created, m.role, '
        'c.title, a.name AS agent_name '
        'FROM agent_messages m JOIN agent_conversations c ON c.id=m.conversation_id '
        'LEFT JOIN workspace_agents a ON a.id=c.agent_id '
        'WHERE m.workspace_id=? AND c.user_id=? '
        "AND (?='' OR m.conversation_id=?) "
        'AND instr(lower(m.body), lower(?))>0 ' + bound +
        'ORDER BY m.created, m.id LIMIT ?',
        (workspace_id, user_id, conversation_id, conversation_id, text, *extra, limit),
    ).fetchall()


def social_rows(db, workspace_id, user_id, text, cursor, limit, conversation_id='', seat=None):
    # Import at call time: social already uses search.snippet for previews.
    # Reuse exactly the authorized message stream's success-only projection,
    # never task output, pending/error bodies or the original request prompt.
    from .social import MESSAGE_ROWS
    bound, extra = time_after(seat, cursor)
    return db.execute(
        'SELECT m.id, m.conversation_id, m.body, m.created, m.agent_id, m.agent_name, '
        'c.title, c.kind AS conversation_kind '
        f'FROM ({MESSAGE_ROWS}) m JOIN social_conversations c ON c.id=m.conversation_id '
        'AND c.workspace_id=m.workspace_id '
        'JOIN social_members s ON s.conversation_id=c.id AND s.workspace_id=c.workspace_id AND s.user_id=? '
        'WHERE m.workspace_id=? '
        "AND (?='' OR m.conversation_id=?) "
        'AND instr(lower(m.body), lower(?))>0 ' + bound +
        'ORDER BY m.created, m.id LIMIT ?',
        (user_id, workspace_id, conversation_id, conversation_id, text, *extra, limit),
    ).fetchall()


def item(kind, row):
    if kind == 'agent':
        title = row['agent_name'] or row['title'] or '对话'
    else:
        title = row['title'] or ('群聊' if row['conversation_kind'] == 'group' else '单聊')
    data = {
        'kind': kind,
        'conversation_id': row['conversation_id'],
        'message_id': row['id'],
        'title': title,
        'snippet': snippet(row['body']),
        'created': row['created'],
    }
    if kind == 'social' and row['agent_id']:
        data.update(role='agent', agent_id=row['agent_id'], agent_name=row['agent_name'],
                    source='runtime_infer')
    return data


def messages(db, workspace_id, user_id, text, kind, cursor, limit, conversation_id=''):
    seat = cursor_seat(db, workspace_id, user_id, cursor)
    collected = []
    if kind in ('all', 'agent'):
        collected.extend(item('agent', row) for row in agent_rows(
            db, workspace_id, user_id, text, cursor, limit, conversation_id, seat))
    if kind in ('all', 'social'):
        collected.extend(item('social', row) for row in social_rows(
            db, workspace_id, user_id, text, cursor, limit, conversation_id, seat))
    collected.sort(key=lambda entry: (entry['created'], entry['message_id']))
    return collected[:limit]
