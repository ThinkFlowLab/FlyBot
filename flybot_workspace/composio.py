"""Per-user Composio app connections (Connect Link flow).

There is no platform-wide Composio key: every FlyBot user enters their own
Composio project API key. The key is stored only as a wrapped blob in the
private data directory, is never returned by the API (only a masked hint), and
is never written to logs or error messages. Every Composio call made on behalf
of a user uses that user's own key; nothing falls back to another user's key.

Composio REST API v3.1 (https://docs.composio.dev/reference):
- GET  /toolkits                                  list toolkits
- POST /tool_router/session                       session for a user_id
- POST /tool_router/session/{id}/link             Connect Link (redirect_url,
                                                  connected_account_id)
- GET  /connected_accounts/{nanoid}               status polling
- GET  /connected_accounts?user_ids=...           a user's connected accounts
- DELETE /connected_accounts/{nanoid}             disconnect

Toolkit metadata is returned without external logo assets.
"""
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from . import model_api

SCHEMA = '''
CREATE TABLE IF NOT EXISTS composio_keys (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 key_blob TEXT NOT NULL,
 key_hint TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS composio_connections (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 toolkit TEXT NOT NULL,
 account_id TEXT NOT NULL,
 status TEXT NOT NULL,
 status_reason TEXT,
 created INTEGER NOT NULL,
 updated INTEGER NOT NULL,
 UNIQUE(user_id, account_id));
CREATE INDEX IF NOT EXISTS composio_connection_user ON composio_connections(user_id, toolkit, created);
'''

BASE_URL = 'https://backend.composio.dev/api/v3.1'
WRAP_NAME = 'composio.wrap'
TOOLKIT = re.compile(r'[a-z0-9_][a-z0-9_-]{0,63}')
ACCOUNT = re.compile(r'[A-Za-z0-9_-]{1,128}')
LOCAL_ID = re.compile(r'[0-9a-f]{32}')
MAX_CONNECTIONS = 100
MAX_RESPONSE = 2 * 1024 * 1024
TIMEOUT = 15
PENDING = ('INITIALIZING', 'INITIATED')
KNOWN = ('INITIALIZING', 'INITIATED', 'ACTIVE', 'INACTIVE', 'FAILED', 'EXPIRED', 'REVOKED', 'DELETED')

# FlyBot catalog id -> Composio toolkit slug, checked against the public
# Composio toolkit table (docs.composio.dev/toolkits) on 2026-11-19.
# managed: Composio ships the OAuth app ('yes'), the toolkit needs no OAuth app
# because it is API-key based ('key'), or the user must create their own auth
# config in Composio first ('own'). Ids absent here have no Composio toolkit.
CATALOG = {
    'github': ('github', 'yes'), 'notion': ('notion', 'yes'), 'linear': ('linear', 'yes'),
    'atlassian': ('jira', 'yes'), 'sentry': ('sentry', 'yes'), 'stripe': ('stripe', 'yes'),
    'paypal': ('paypal', 'own'), 'square': ('square', 'yes'), 'cloudflare': ('cloudflare', 'key'),
    'vercel': ('vercel', 'own'), 'supabase': ('supabase', 'yes'), 'neon': ('neon', 'own'),
    'figma': ('figma', 'yes'), 'canva': ('canva', 'yes'), 'intercom': ('intercom', 'yes'),
    'monday': ('monday', 'yes'), 'webflow': ('webflow', 'own'), 'wix': ('wix', 'own'),
    'airtable': ('airtable', 'yes'), 'dropbox': ('dropbox', 'yes'), 'clickup': ('clickup', 'yes'),
    'todoist': ('todoist', 'yes'), 'miro': ('miro', 'yes'), 'attio': ('attio', 'yes'),
    'postman': ('postman', 'key'), 'asana': ('asana', 'yes'), 'box': ('box', 'yes'),
    'hubspot': ('hubspot', 'yes'), 'slack': ('slack', 'yes'), 'huggingface': ('hugging_face', 'yes'),
    'exa': ('exa', 'key'),
}


class ComposioError(Exception):
    """Upstream failure. Messages are fixed strings; never include the key."""

    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def urllib_transport(method, url, headers, body):
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=TIMEOUT) as response:
            return response.status, response.read(MAX_RESPONSE + 1)
    except urllib.error.HTTPError as error:
        try:
            data = error.read(MAX_RESPONSE + 1)
        except OSError:
            data = b''
        return error.code, data


class Client:
    """Minimal Composio REST client. transport(method, url, headers, body) -> (status, bytes)."""

    def __init__(self, api_key, transport=None, base_url=BASE_URL):
        if not valid_api_key(api_key):
            raise ComposioError('composio_not_configured', 'Composio API key is missing')
        self._key = api_key
        self.transport = transport or urllib_transport
        self.base_url = base_url

    def __repr__(self):
        return '<composio.Client key=***>'

    def _call(self, method, path, query=None, body=None, allow=(200, 201, 202, 204)):
        url = self.base_url + path
        if query:
            url += '?' + urllib.parse.urlencode(query, doseq=True)
        headers = {'x-api-key': self._key, 'Accept': 'application/json'}
        data = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            data = json.dumps(body, separators=(',', ':')).encode('utf-8')
        try:
            status, raw = self.transport(method, url, headers, data)
        except (OSError, ValueError):
            raise ComposioError('composio_unreachable', 'Composio could not be reached') from None
        if len(raw or b'') > MAX_RESPONSE:
            raise ComposioError('composio_failed', 'Composio response was too large')
        if status in (401, 403):
            raise ComposioError('composio_key_rejected', 'Composio rejected this API key', status)
        if status == 404:
            raise ComposioError('composio_not_found', 'Composio did not find that item', status)
        if status == 429:
            raise ComposioError('composio_rate_limited', 'Composio rate limit reached; try later', status)
        if status not in allow:
            raise ComposioError('composio_failed', 'Composio request failed', status)
        if not raw:
            return {}
        try:
            payload = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeError):
            raise ComposioError('composio_failed', 'Composio returned an unreadable response') from None
        if not isinstance(payload, dict):
            raise ComposioError('composio_failed', 'Composio returned an unexpected response')
        return payload

    def list_toolkits(self, search=None, cursor=None, limit=50):
        query = {'limit': str(limit), 'sort_by': 'usage'}
        if search:
            query['search'] = search
        if cursor:
            query['cursor'] = cursor
        return self._call('GET', '/toolkits', query)

    def create_link(self, user_id, toolkit, callback_url):
        session = self._call('POST', '/tool_router/session',
                             body={'user_id': user_id, 'toolkits': {'enable': [toolkit]}})
        session_id = session.get('session_id')
        if not isinstance(session_id, str) or not ACCOUNT.fullmatch(session_id):
            raise ComposioError('composio_failed', 'Composio did not return a session')
        link = self._call('POST', f'/tool_router/session/{session_id}/link',
                          body={'toolkit': toolkit, 'callback_url': callback_url})
        redirect, account = link.get('redirect_url'), link.get('connected_account_id')
        if not isinstance(account, str) or not ACCOUNT.fullmatch(account) or not safe_redirect(redirect):
            raise ComposioError('composio_failed', 'Composio did not return a usable Connect Link')
        return {'redirect_url': redirect, 'account_id': account}

    def get_account(self, account_id):
        return self._call('GET', '/connected_accounts/' + urllib.parse.quote(account_id, safe=''))

    def list_accounts(self, user_id, limit=MAX_CONNECTIONS):
        return self._call('GET', '/connected_accounts', {'user_ids': [user_id], 'limit': str(limit)})

    def tools(self, toolkit, search=None, cursor=None):
        query = {'toolkit_slug': toolkit, 'limit': '20', 'toolkit_versions': 'latest'}
        if search:
            query['query'] = search
        else:
            query['important'] = 'true'
        if cursor:
            query['cursor'] = cursor
        return self._call('GET', '/tools', query)

    def execute(self, tool, account, user, version, arguments):
        # Fixed route and explicit account: never custom_auth_params / proxy URLs,
        # instant accounts, model-supplied user_id or automatic fallback credentials.
        return self._call('POST', '/tools/execute/' + urllib.parse.quote(tool, safe=''),
                          body={'connected_account_id': account, 'user_id': user,
                                'version': version, 'arguments': arguments})

    def delete_account(self, account_id):
        return self._call('DELETE', '/connected_accounts/' + urllib.parse.quote(account_id, safe=''))


def safe_redirect(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 for c in value):
        return False
    try:
        parts = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return parts.scheme == 'https' and bool(parts.hostname) and parts.username is None and parts.password is None


def valid_api_key(value):
    return (isinstance(value, str) and 8 <= len(value) <= 512
            and all(32 < ord(c) < 127 for c in value))


def composio_user_id(user_id):
    """Stable Composio user_id for one FlyBot account (never browser-supplied)."""
    return 'flybot-workspace-' + user_id


def hint(key):
    return '••••' + key[-4:]


def load_key_row(db, user_id):
    return db.execute('SELECT * FROM composio_keys WHERE user_id=?', (user_id,)).fetchone()


def key_view(row):
    if row is None:
        return {'configured': False, 'key_hint': None, 'revision': 0}
    return {'configured': True, 'key_hint': row['key_hint'], 'revision': row['revision']}


def user_key(store, db, user_id):
    """The signed-in user's own key, or None. Never another user's key."""
    row = load_key_row(db, user_id)
    if row is None:
        return None
    return model_api.unwrap(model_api.wrapping_key(store, WRAP_NAME), row['key_blob'])


def save_key(store, db, user_id, api_key, now):
    row = load_key_row(db, user_id)
    if api_key is None:
        if row is not None:
            db.execute('DELETE FROM composio_keys WHERE user_id=?', (user_id,))
        # Records belong to the old Composio project; the accounts there are not deleted.
        db.execute('DELETE FROM composio_connections WHERE user_id=?', (user_id,))
        return key_view(None)
    blob = model_api.wrap(model_api.wrapping_key(store, WRAP_NAME), api_key)
    if row is None:
        db.execute('INSERT INTO composio_keys VALUES(?,?,?,?,?)', (user_id, blob, hint(api_key), 1, now))
    else:
        db.execute('UPDATE composio_keys SET key_blob=?, key_hint=?, revision=?, updated=? WHERE user_id=?',
                   (blob, hint(api_key), row['revision'] + 1, now, user_id))
        db.execute('DELETE FROM composio_connections WHERE user_id=?', (user_id,))
    return key_view(load_key_row(db, user_id))


def normal_status(value):
    return value if isinstance(value, str) and value in KNOWN else 'FAILED'


def state(status):
    """UI state: connecting, connected, inactive or failed. Never a fake success."""
    if status in PENDING:
        return 'connecting'
    if status == 'ACTIVE':
        return 'connected'
    if status == 'INACTIVE':
        return 'inactive'
    return 'failed'


def connection_view(row):
    toolkit = row['toolkit']
    catalog_id = next((key for key, (slug, _m) in CATALOG.items() if slug == toolkit), None)
    return {
        'id': row['id'], 'toolkit': toolkit, 'catalog_id': catalog_id,
        'status': row['status'], 'state': state(row['status']),
        'status_reason': row['status_reason'], 'created_at': row['created'], 'updated_at': row['updated'],
    }


def reason_text(value):
    if not isinstance(value, str):
        return None
    return value[:200]


def catalog_view():
    return [{'id': key, 'toolkit': slug, 'managed': managed} for key, (slug, managed) in CATALOG.items()]


def toolkit_view(item):
    if not isinstance(item, dict) or not isinstance(item.get('slug'), str):
        return None
    meta = item.get('meta') if isinstance(item.get('meta'), dict) else {}
    description = meta.get('description') if isinstance(meta.get('description'), str) else ''
    schemes = item.get('auth_schemes') if isinstance(item.get('auth_schemes'), list) else []
    managed = item.get('composio_managed_auth_schemes')
    managed = managed if isinstance(managed, list) else []
    return {
        'slug': item['slug'].lower()[:64],
        'name': str(item.get('name') or item['slug'])[:80],
        'description': description[:240],
        'auth_schemes': [s for s in schemes if isinstance(s, str)][:8],
        'composio_managed': bool(managed) or bool(item.get('no_auth')),
        # Logos are intentionally not returned: no third-party brand assets.
    }


CALLBACK_PAGE = (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    '<meta name="referrer" content="no-referrer">'
    '<meta http-equiv="refresh" content="0;url=/settings/connectors">'
    '<title>正在返回应用连接器</title></head><body>'
    '<p>授权页已返回。正在回到 <a href="/settings/connectors">应用连接器</a> 读取真实连接状态…</p>'
    '</body></html>'
).encode('utf-8')
