"""Workspace agent metadata and public homepages.

An unlisted homepage shows the agent name, summary, and optional quick starts.
Management holds metadata while agent execution belongs to DS-Bot.
"""
from html import escape
import re

from .security import digest

SCHEMA = '''
CREATE TABLE IF NOT EXISTS workspace_agents (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 name_hash TEXT NOT NULL,
 summary TEXT NOT NULL,
 instructions TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 archived INTEGER NOT NULL CHECK(archived IN (0,1)),
 key_hash TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 UNIQUE(workspace_id, key_hash),
 UNIQUE(workspace_id, name_hash));
CREATE INDEX IF NOT EXISTS workspace_agent_list ON workspace_agents(workspace_id, archived, id);
CREATE TABLE IF NOT EXISTS workspace_agent_categories (
 agent_id TEXT PRIMARY KEY REFERENCES workspace_agents(id) ON DELETE CASCADE,
 category TEXT NOT NULL,
 updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_agent_homepages (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 token_prefix TEXT NOT NULL,
 created INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 revoked INTEGER NOT NULL CHECK(revoked IN (0,1)),
 revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS workspace_agent_homepage_agent
 ON workspace_agent_homepages(agent_id, revoked, created, id);
CREATE TABLE IF NOT EXISTS workspace_agent_quick_starts (
 agent_id TEXT NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position >= 0 AND position < 5),
 text TEXT NOT NULL,
 PRIMARY KEY(agent_id, position));
'''

NAME_MAX = 80
# The 17 directory categories recorded on the target agents page, as slugs.
# Kept in step with AGENT_CATEGORIES in flybot_workspace/static/agents/app.mjs.
CATEGORIES = (
    'content-creation', 'customer-support', 'data-analysis', 'design',
    'education', 'engineering', 'finance', 'it-security', 'investment',
    'legal', 'life', 'marketing', 'operations', 'product', 'recruiting',
    'research', 'sales',
)
SUMMARY_MAX = 500
INSTRUCTIONS_MAX = 16000
QUICK_START_MAX = 5
QUICK_START_TEXT_MAX = 80
CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
PREFIX_LEN = 8
HOMEPAGE_CSP = (
    "default-src 'none'; style-src 'unsafe-inline'; sandbox; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
)


def valid_name(value):
    return isinstance(value, str) and 1 <= len(value.strip()) <= NAME_MAX and not CONTROL.search(value)


def valid_summary(value):
    return isinstance(value, str) and len(value) <= SUMMARY_MAX and not CONTROL.search(value)


def valid_instructions(value):
    return (isinstance(value, str) and len(value) <= INSTRUCTIONS_MAX and '\x00' not in value
            and not any(ord(ch) < 32 and ch not in '\t\n\r' for ch in value))


def name_hash(name):
    return digest(name.strip().casefold())


def view(row):
    return {key: row[key] for key in (
        'id', 'workspace_id', 'name', 'summary', 'instructions', 'revision',
        'created', 'updated', 'created_by', 'archived')}


def homepage_view(row, include_token=False, token=None):
    if row is None or row['revoked'] == 1:
        return {'visibility': 'restricted'}
    data = {
        'visibility': 'public',
        'prefix': row['token_prefix'],
        'created': row['created'],
    }
    if include_token and token:
        data['token'] = token
        data['path'] = '/a/' + token
    return data


def valid_category(value):
    return value is None or (isinstance(value, str) and value in CATEGORIES)


def load_category(db, agent_id):
    found = db.execute(
        'SELECT category FROM workspace_agent_categories WHERE agent_id=?', (agent_id,)
    ).fetchone()
    return found['category'] if found else None


def store_category(db, agent_id, category, now):
    if category is None:
        db.execute('DELETE FROM workspace_agent_categories WHERE agent_id=?', (agent_id,))
    else:
        db.execute(
            'INSERT INTO workspace_agent_categories VALUES(?,?,?) '
            'ON CONFLICT(agent_id) DO UPDATE SET category=excluded.category, updated=excluded.updated',
            (agent_id, category, now),
        )


def valid_quick_starts(value):
    if not isinstance(value, list) or len(value) > QUICK_START_MAX:
        return False
    for item in value:
        if not isinstance(item, str) or not 1 <= len(item.strip()) <= QUICK_START_TEXT_MAX:
            return False
        if CONTROL.search(item):
            return False
    return True


def normalize_quick_starts(value):
    return [item.strip() for item in value]


def load_quick_starts(db, agent_id):
    rows = db.execute(
        'SELECT text FROM workspace_agent_quick_starts WHERE agent_id=? ORDER BY position',
        (agent_id,),
    ).fetchall()
    return [row['text'] for row in rows]


def store_quick_starts(db, agent_id, starts):
    db.execute('DELETE FROM workspace_agent_quick_starts WHERE agent_id=?', (agent_id,))
    for position, text in enumerate(starts or ()):
        db.execute(
            'INSERT INTO workspace_agent_quick_starts VALUES(?,?,?)',
            (agent_id, position, text),
        )


def snapshot(db, row, include_token=False, token=None):
    data = view(row)
    data['category'] = load_category(db, row['id'])
    data['quick_starts'] = load_quick_starts(db, row['id'])
    data['homepage'] = homepage_view(load_active_homepage(db, row['id']), include_token, token)
    return data


def can_manage(actor):
    return actor in ('owner', 'admin')


def load(db, workspace_id, agent_id):
    return db.execute(
        'SELECT * FROM workspace_agents WHERE id=? AND workspace_id=?',
        (agent_id, workspace_id),
    ).fetchone()


def listing(db, workspace_id, cursor, limit, include_archived):
    clause = 'archived IN (0, 1)' if include_archived else 'archived=0'
    return db.execute(
        'SELECT * FROM workspace_agents WHERE workspace_id=? AND ' + clause +
        ' AND id>? ORDER BY id LIMIT ?',
        (workspace_id, cursor, limit),
    ).fetchall()


def load_active_homepage(db, agent_id):
    return db.execute(
        'SELECT * FROM workspace_agent_homepages WHERE agent_id=? AND revoked=0 '
        'ORDER BY created DESC, id DESC LIMIT 1',
        (agent_id,),
    ).fetchone()


def load_homepage_by_token(db, token):
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        return None
    row = db.execute(
        'SELECT a.*, h.token_hash AS homepage_token_hash, h.revoked AS homepage_revoked '
        'FROM workspace_agent_homepages h '
        'JOIN workspace_agents a ON a.id = h.agent_id AND a.workspace_id = h.workspace_id '
        'WHERE h.token_hash=?',
        (digest('agent-home:' + token),),
    ).fetchone()
    if row is None or row['homepage_revoked'] == 1 or row['archived'] == 1:
        return None
    return row


def revoke_active_homepages(db, agent_id, now):
    db.execute(
        'UPDATE workspace_agent_homepages SET revoked=1, revoked_at=? '
        'WHERE agent_id=? AND revoked=0',
        (now, agent_id),
    )


def public_initial(name):
    for char in name or '':
        if char.isalnum():
            return char.upper()
    return '?'


HOMEPAGE_STYLE = """
:root{color-scheme:light;--ink:#1c1917;--muted:#57534e;--line:#d6d3d1;--bg:#f5f5f4;--card:#ffffff;--accent:#292524}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,sans-serif;background:var(--bg);color:var(--ink);line-height:1.5}
.topbar{display:flex;align-items:center;gap:.75rem;padding:1rem 1.5rem;border-bottom:1px solid var(--line);background:var(--card)}
.topbar .brand{display:inline-flex;align-items:center;gap:.5rem;font-weight:700;letter-spacing:-.03em;color:inherit;text-decoration:none}
.topbar .brand-mark{display:inline-flex;align-items:center;justify-content:center;width:1.75rem;height:1.75rem;border-radius:50%;background:#097845;color:#fff}
.topbar .brand-mark svg{display:block;width:1.1rem;height:1.1rem}
.topbar .crumb{color:var(--muted);font-size:.9rem}
.page{max-width:72rem;margin:0 auto;padding:2rem 1.5rem 3rem;display:grid;gap:2rem}
@media(min-width:880px){.page{grid-template-columns:minmax(16rem,1fr) minmax(20rem,26rem);align-items:start}}
.status{display:inline-block;margin:0 0 .75rem;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.identity{display:flex;gap:1rem;align-items:flex-start}
.avatar{flex:0 0 4rem;width:4rem;height:4rem;border-radius:1rem;background:var(--accent);color:#fafaf9;display:flex;align-items:center;justify-content:center;font-size:1.6rem;font-weight:600}
.identity h1{margin:0;font-size:2rem;line-height:1.15;overflow-wrap:anywhere}
.summary{margin:.75rem 0 1.25rem;white-space:pre-wrap;word-break:break-word}
.summary.empty,.note{color:var(--muted)}
.section h2{margin:1.25rem 0 .5rem;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}
.talk-list{display:flex;flex-wrap:wrap;gap:.5rem;margin:0;padding:0;list-style:none}
.talk-chip,.create-agent{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:.35rem .8rem;font:inherit;color:var(--ink)}
a.create-agent{text-decoration:none;display:inline-block}
.talk-chip[disabled],.composer button[disabled],.composer textarea[disabled]{opacity:.65;cursor:not-allowed}
.start-list{margin:0;padding:0;list-style:none}
.start-list li{padding:0;border-bottom:1px solid var(--line);color:var(--ink)}
.start-list a,.quick-start-cards a{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.55rem 0;color:inherit;text-decoration:none}
.quick-start-cards a{padding:.7rem .9rem;width:100%;box-sizing:border-box}
.start-list .chevron,.quick-start-cards .chevron{color:var(--muted)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:1.25rem;padding:1.25rem;min-height:28rem;display:flex;flex-direction:column;gap:1rem}
.panel h2{margin:0;font-size:1rem}
.panel .lead{margin:0;color:var(--muted);font-size:.9rem}
.panel-body{flex:1;display:flex;flex-direction:column;align-items:stretch;gap:1rem}
.intro-bubble{align-self:flex-start;max-width:22rem;margin:0;background:var(--bg);border-radius:1rem;padding:.75rem 1rem}
.quick-starts h3{margin:0 0 .5rem;font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}
.quick-start-cards{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:.5rem}
.quick-start-cards li{border:1px solid var(--line);border-radius:.9rem;padding:0;background:var(--bg)}
.composer{display:flex;gap:.5rem;align-items:flex-end}
.composer textarea{flex:1;min-height:3.5rem;resize:none;border:1px solid var(--line);border-radius:.9rem;padding:.75rem .9rem;font:inherit;background:var(--bg)}
.composer button{flex:0 0 auto;border:1px solid var(--line);border-radius:999px;padding:.55rem .9rem;font:inherit;background:var(--card)}
.footer{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;justify-content:center;color:var(--muted);font-size:.9rem;padding-top:.5rem}
"""


def render_homepage(row, quick_starts=None):
    heading = escape(row['name'] or '智能体')
    raw_summary = (row['summary'] or '').strip()
    summary = escape(raw_summary)
    initial = escape(public_initial(row['name'] or '智能体'))
    body = (
        ('<p class="summary">' + summary + '</p>') if raw_summary
        else '<p class="summary empty">还没有简介。</p>'
    )
    placeholder = escape('Message ' + (row['name'] or '智能体') + ' on the web…')
    starts = list(quick_starts if quick_starts is not None else row.get('quick_starts') or ())
    start_items = ''.join(
        '<li><a class="quick-start-link" href="/chat?start=' + str(index) + '">'
        '<span>' + escape(item) + '</span><span class="chevron" aria-hidden="true">→</span></a></li>'
        for index, item in enumerate(starts)
    )
    if starts:
        start_block = (
            '<ul class="start-list">' + start_items + '</ul>'
            '<p class="note">登录且属于该工作区后，点击开场会在聊天里发起对话并发送这条提示。'
            '未接通：输入框仍不能在此页发送，公开主页本身不会调用模型。'
            '未登录或不属于该工作区时不会创建会话。</p>'
        )
        cards = (
            '<div class="quick-starts"><h3>Quick starts</h3>'
            '<ul class="quick-start-cards">' + start_items + '</ul></div>'
        )
    else:
        start_block = (
            '<p class="note">未接通：还没有开场提示。公开主页不会发送消息，也不会调用模型。</p>'
        )
        cards = ''
    intro = (
        '<p class="intro-bubble">Start a conversation with ' + heading + '. '
        + (
            'Click a quick start to continue in chat if you are a signed-in workspace member. '
            'This page does not call a model itself.'
            if starts else
            'This panel is typography only and does not run a conversation or call a model.'
        )
        + '</p>'
    )
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">'
        '<title>' + heading + '</title>'
        '<style>' + HOMEPAGE_STYLE + '</style>'
        '</head><body>'
        '<header class="topbar"><a class="brand" href="/chat" title="FlyBot">'
        '<span class="brand-mark" aria-hidden="true"><img class="brand-glyph" src="/shell/flybot-logo.svg" width="28" height="28" alt=""></span>'
        '<span>FlyBot</span></a>'
        '<span class="crumb">Agent profile</span></header>'
        '<main class="page">'
        '<section>'
        '<p class="status">Public page</p>'
        '<div class="identity"><div class="avatar" aria-hidden="true">' + initial + '</div>'
        '<div><h1>' + heading + '</h1>' + body + '</div></div>'
        '<div class="section"><h2>Talk via</h2>'
        '<ul class="talk-list">'
        '<li><button type="button" class="talk-chip" disabled>Web</button></li>'
        '<li><button type="button" class="talk-chip" disabled title="未接通：公开主页还不能连接即时通讯渠道。">Channels</button></li>'
        '</ul></div>'
        '<div class="section"><h2>Start a conversation</h2>'
        + start_block +
        '</div></section>'
        '<section class="panel" aria-labelledby="web-conversation-title">'
        '<div><h2 id="web-conversation-title">Web conversation</h2>'
        '<p class="lead">Talk directly with ' + heading + '.</p></div>'
        '<div class="panel-body">' + intro + cards + '</div>'
        '<div class="composer">'
        '<label class="visually-hidden" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)" for="public-composer">Message</label>'
        '<textarea id="public-composer" disabled placeholder="' + placeholder + '"></textarea>'
        '<button type="button" disabled title="未接通：公开主页不会发送消息。">Send</button>'
        '</div></section>'
        '<footer class="footer"><span>Built with FlyBot</span>'
        '<a class="create-agent" href="/agents" title="打开工作区智能体页。公开主页不会直接创建智能体。">Create your own Agent</a>'
        '</footer></main></body></html>'
    )


def homepage_headers():
    return [
        ('Content-Type', 'text/html; charset=utf-8'),
        ('Content-Security-Policy', HOMEPAGE_CSP),
        ('Cross-Origin-Resource-Policy', 'same-origin'),
        ('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'),
        ('X-Frame-Options', 'DENY'),
    ]
