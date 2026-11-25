"""Per-user Personal Agent and built-in agent roster (issue #130 / #1).

Create the personal workspace, the user's personal agent, ten built-in
assistant records, and a welcome conversation.
"""
import re

from uuid import uuid4

from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS personal_agents (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS builtin_agents (
 agent_id TEXT PRIMARY KEY REFERENCES workspace_agents(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 builtin_key TEXT NOT NULL,
 created INTEGER NOT NULL,
 UNIQUE(workspace_id, builtin_key));
CREATE INDEX IF NOT EXISTS builtin_agent_workspace ON builtin_agents(workspace_id, builtin_key);
'''

WORKSPACE_NAME = '个人空间'
PERSONAL_SUMMARY = 'Your Cross-context Super AI Agent.'
PERSONAL_INSTRUCTIONS = (
    '你是用户的个人智能体，跨对话记住用户的目标与偏好，主动提供清晰、可执行的帮助。'
)
WELCOME = '你们已经是好友了，可以开始聊天啦！'
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')


class WorkspaceCapacity(ValueError):
    pass


WORKSPACE_ASSISTANT = ('flybot-assistant', 'FlyBot Assistant', 'FlyBot 平台助手', '帮助用户了解和使用平台功能。')

BUILTINS = (
    WORKSPACE_ASSISTANT,
    ('content-creator', 'Content Creator', '内容创作助手', '协助起草、改写和润色内容。'),
    ('finance-assistant', 'Finance Assistant', '财务助手', '帮助整理预算、账单与财务问题。'),
    ('health-assistant', 'Health Assistant', '健康助手', '提供一般性的健康与运动建议。'),
    ('ai-stock-assistant', 'AI Stock Assistant', 'AI 股票助手', '帮助整理市场信息与投资研究。'),
    ('market-research', 'Market Research', '市场调研助手', '协助收集和整理市场调研资料。'),
    ('travel-planner', 'Travel Planner', '旅行规划助手', '帮助规划行程、预算与路线。'),
    ('accounting-assistant', 'Accounting Assistant', '会计助手', '帮助整理账目与报销。'),
    ('slides-assistant', 'Slides Assistant', '演示文稿助手', '帮助组织演示文稿结构与要点。'),
    ('webpage-developer', 'Webpage Developer', '网页开发助手', '帮助搭建和修改小型网页。'),
)


def personal_name(username):
    name = "%s's Personal Agent" % (username or 'user')[:60]
    return name if len(name) <= 80 else name[:80]


def load(db, user_id):
    return db.execute('SELECT * FROM personal_agents WHERE user_id=?', (user_id,)).fetchone()


def builtins(db, workspace_id):
    return db.execute(
        'SELECT b.builtin_key, a.* FROM builtin_agents b '
        'JOIN workspace_agents a ON a.id=b.agent_id '
        'WHERE b.workspace_id=? ORDER BY b.rowid', (workspace_id,),
    ).fetchall()



def rebrand_builtin_assistant(db):
    """Rename the built-in in place, including in existing personal workspaces."""
    from . import agents

    key, default_name, default_summary, _ = WORKSPACE_ASSISTANT
    rows = db.execute(
        'SELECT b.workspace_id, a.id, a.name, a.summary FROM builtin_agents b '
        'JOIN workspace_agents a ON a.id=b.agent_id WHERE b.builtin_key=?',
        ('teamily-agent',),
    ).fetchall()
    for row in rows:
        db.execute('UPDATE builtin_agents SET builtin_key=? WHERE agent_id=?', (key, row['id']))
        name, summary = row['name'], row['summary']
        if name == 'Teamily Agent':
            name = default_name
            suffix = 2
            while db.execute('SELECT 1 FROM workspace_agents WHERE workspace_id=? AND name_hash=?',
                             (row['workspace_id'], agents.name_hash(name))).fetchone():
                name = f'{default_name} {suffix}'
                suffix += 1
        if summary == 'Teamily 平台助手':
            summary = default_summary
        if (name, summary) != (row['name'], row['summary']):
            db.execute(
                "UPDATE workspace_agents SET name=?, name_hash=?, summary=?, revision=revision+1, "
                "updated=MAX(updated, CAST(strftime('%s','now') AS INTEGER)) WHERE id=?",
                (name, agents.name_hash(name), summary, row['id']),
            )


def _insert_agent(db, workspace_id, name, summary, instructions, user_id, key, now):
    from . import agents
    if not agents.valid_name(name) or not agents.valid_summary(summary) or not agents.valid_instructions(instructions):
        raise ValueError('invalid built-in agent')
    agent_id = uuid4().hex
    key_hash = digest('personal-agent:' + key)
    request_hash = digest(name + '\n' + summary + '\n' + instructions)
    db.execute(
        'INSERT INTO workspace_agents VALUES(?,?,?,?,?,?,1,?,?,?,0,?,?)',
        (agent_id, workspace_id, name.strip(), agents.name_hash(name), summary.strip(),
         instructions, now, now, user_id, key_hash, request_hash),
    )
    return agent_id


def ensure(db, user, max_workspaces_per_user, max_workspaces, max_agents, now):
    """Create the personal workspace/agent/roster once. Returns (row, created)."""
    row = load(db, user['id'])
    if row is not None:
        return row, False
    if (db.execute('SELECT COUNT(*) FROM workspaces WHERE owner_id=?', (user['id'],)).fetchone()[0]
            >= max_workspaces_per_user
            or db.execute('SELECT COUNT(*) FROM workspaces').fetchone()[0] >= max_workspaces):
        raise WorkspaceCapacity('Workspace capacity reached')
    workspace_id = uuid4().hex
    db.execute(
        'INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
        (workspace_id, user['id'], WORKSPACE_NAME, now,
         digest('personal-space:' + user['id']), digest(WORKSPACE_NAME)),
    )
    personal_id = _insert_agent(
        db, workspace_id, personal_name(user['username']), PERSONAL_SUMMARY,
        PERSONAL_INSTRUCTIONS, user['id'], 'personal:' + user['id'], now)
    for key, name, summary, instructions in BUILTINS:
        if db.execute('SELECT COUNT(*) FROM workspace_agents WHERE workspace_id=?',
                      (workspace_id,)).fetchone()[0] >= max_agents:
            break
        agent_id = _insert_agent(db, workspace_id, name, summary, instructions, user['id'],
                                 'builtin:' + user['id'] + ':' + key, now)
        db.execute('INSERT INTO builtin_agents VALUES(?,?,?,?)',
                   (agent_id, workspace_id, key, now))
    conversation_id = uuid4().hex
    db.execute(
        'INSERT INTO agent_conversations VALUES(?,?,?,?,?,?,?,?,?)',
        (conversation_id, workspace_id, personal_id, user['id'], 'Personal Agent', now, now,
         digest('personal-conversation:' + user['id']), digest('personal-welcome')),
    )
    db.execute(
        'INSERT INTO agent_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        (uuid4().hex, conversation_id, workspace_id, personal_id, user['id'], 'assistant',
         WELCOME, 'succeeded', None, None, 1, now, now, None, None, 1),
    )
    db.execute('INSERT INTO personal_agents VALUES(?,?,?,?)',
               (user['id'], workspace_id, personal_id, now))
    return load(db, user['id']), True
