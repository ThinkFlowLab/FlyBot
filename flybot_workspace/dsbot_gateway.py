"""Platform gateway to each user's own DS-Bot (docs/DSBOT_PLUGIN_ARCHITECTURE.md §4).

The platform only registers, signs in, provisions and forwards. This module is the
forwarding decision: the edge (nginx ``auth_request``) asks ``GET /v1/platform/route``
for every request bound for a DS-Bot; the answer names the signed-in owner's *own*
runtime and the DSH session cookie for it, or refuses. No request field can name an
instance. The browser never receives a DSH token or cookie.

Nothing here executes user work. Credential-grade rows (``dsbot_upstreams.auth_cookie``)
are never returned by any listing API; protect database backups as credentials, as on
the FlyBot platform.
"""
import hmac
import ipaddress
import json
import re
from http.client import HTTPConnection
from http.cookies import CookieError, SimpleCookie
from pathlib import Path
from urllib.parse import quote, urlsplit

from .lifecycle import RuntimeFault
from .runtime_autoprovision import is_parked, owned_instance, resumable_instance
from .security import digest

ROUTES_FILE = Path(__file__).with_name('dsbot_routes.json')
ROUTE_PATH = '/v1/platform/route'
IMPORT_PATH = re.compile(r'^/v1/internal/instances/([0-9a-f]{32})/dsbot-import$')
UPSTREAM_PATH = re.compile(r'/v1/internal/instances/([0-9a-f]{32})/dsbot-upstream')
KEY_HEADER = 'HTTP_X_OT_GATEWAY_KEY'
PAGE_ROUTE = '/api/flybot-workspace/page'
API_ROUTE = '/api/flybot-workspace'
GATEWAY_PREFIX = '/v1/gateway/'
GATEWAY_TOKEN = re.compile(r'^ota_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$')
GATEWAY_INVOKE = re.compile(r'^/v1/gateway/agents/([0-9a-f]{32})/invocations$')
GATEWAY_STATUS = re.compile(r'^/v1/gateway/invocations/([0-9a-f]{32})$')
BEARER = re.compile(r'^Bearer ([A-Za-z0-9._~+/-]+=*)$')

SCHEMA = '''
CREATE TABLE IF NOT EXISTS dsbot_upstreams (
 instance_id TEXT PRIMARY KEY, address TEXT NOT NULL, auth_cookie TEXT NOT NULL,
 updated INTEGER NOT NULL);
'''

SAFE_METHODS = ('GET', 'HEAD', 'OPTIONS')
TOKEN = re.compile(r'[A-Za-z0-9_-]{43}')
OWNER_USERNAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,63}')
ADDRESS = re.compile(r'(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})')
COOKIE_NAME = re.compile(r'dsh-auth-[A-Za-z0-9._:%-]{1,200}')
PAGE_SEGMENT = re.compile(r'[a-z0-9][a-z0-9-]{0,40}')


# Browser and non-browser /v1 routes that the signed-in owner's DS-Bot now serves.
# Kept in sync with flybot_workspace/static/shell/dsbot-api.mjs `MOVED`. A path not listed
# here stays on the platform, including authentication and the Composio callback.
MOVED_APIS = (
    (re.compile(r'^/v1/skills/(?:catalog|bindings|installed|packages(?:/import-[a-z0-9][a-z0-9-]{1,39}(?:/(?:revoke|versions(?:/[0-9.]+)?))?)?)$'), 'skills'),
    (re.compile(r'^/v1/skill-secrets$'), 'skill-secrets'),
    (re.compile(r'^/v1/stickers(?:/[0-9a-f]{32}(?:/file)?)?$'), 'stickers'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/overview$'), 'overview'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/export$'), 'export'),
    (re.compile(r'^/v1/team-templates$'), 'team-templates'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/team-templates/[a-z0-9-]{3,40}$'), 'team-templates'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/team-runs(?:/[0-9a-f]{32}(?:/(?:cancel|remove|export|steps/[0-7]/(?:retry|artifact)))?)?$'), 'team-runs'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/team-runs/automation-results/[0-9a-f]{32}/[0-9a-f]{32}$'), 'team-runs'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/(?:team-runs/[0-9a-f]{32}/share|shared-runs(?:/otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}(?:/revoke)?)?)$'), 'shares'),
    (re.compile(r'^/v1/contacts(?:/(?:lookup|otcpt_[A-Za-z0-9_-]{1,80}))?$'), 'social'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/notifications(?:/read)?$'), 'social'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/members(?:/[A-Za-z0-9._-]{1,80}(?:/(?:remove|suspend|unsuspend|transfer-ownership))?)?$'), 'members'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/invites(?:/[A-Za-z0-9._-]{1,80}/(?:revoke|freeze|unfreeze))?$'), 'invites'),
    (re.compile(r'^/v1/invites/(?:group/)?(?:accept|preview)$'), 'invites'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/join-requests(?:/[A-Za-z0-9._-]{1,80}/(?:approve|reject))?$'), 'invites'),
    (re.compile(r'^/v1/join-requests$'), 'invites'),
    (re.compile(r'^/v1/skills/(?:scopes|readiness|runs)$'), 'skills'),
    (re.compile(r'^/v1/skills/runs/[0-9a-f]{32}/(?:cancel|artifact)$'), 'skills'),
    (re.compile(r'^/v1/workspaces$'), 'teams'),
    (re.compile(r'^/v1/teams$'), 'teams'),
    (re.compile(r'^/v1/team-directory$'), 'teams'),
    (re.compile(r'^/v1/team-directory/[A-Za-z0-9._-]{1,80}/join$'), 'teams'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/directory$'), 'teams'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/social/conversations(?:/[A-Za-z0-9._-]{1,80}(?:/[A-Za-z0-9._/-]{1,120})?)?$'), 'messenger'),
    (re.compile(r'^/v1/meeting-calls/(?:create|preview|join|poll|signal|leave|end|recording)$'), 'messenger'),
    (re.compile(r'^/v1/profile/(?:social|follow-work)$'), 'discover'),
    (re.compile(r'^/v1/discover/(?:agents|works|me/works)$'), 'discover'),
    (re.compile(r'^/v1/discover/agents/[a-z0-9][a-z0-9-]{1,28}[a-z0-9]/(?:start|remix)$'), 'discover'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/artifacts/[0-9a-f]{32}/discover(?:/revoke)?$'), 'discover'),
    (re.compile(r'^/v1/discover/works/[a-z0-9][a-z0-9-]{1,28}[a-z0-9](?:/(?:engagement|remix|comments(?:/otwc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}/(?:like|remove))?))?$'), 'discover'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/agents/[0-9a-f]{32}/discover(?:/revoke)?$'), 'discover'),
    (re.compile(r'^/v1/(?:automation-templates|onboarding/automations)$'), 'automations'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/automations(?:/(?:bot-schedules|draft|schedule-preview|tick|[0-9a-f]{32}))?$'), 'automations'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/automations/[0-9a-f]{32}/(?:run|remove|runs(?:/[0-9a-f]{32}(?:/(?:cancel|retry|artifact|studio))?)?)$'), 'automations'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/agents/[0-9a-f]{32}/api-keys(?:/[0-9a-f]{32}/revoke)?$'), 'agent-api'),
    (re.compile(r'^/v1/agent-copy-grants(?:/(?:recipients|otag_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}/remix))?$'), 'agents'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/agents/[0-9a-f]{32}/shares(?:/otag_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}/revoke)?$'), 'agents'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/agents/[0-9a-f]{32}/access(?:/otc_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}/revoke)?$'), 'agents'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/agents/[0-9a-f]{32}/conversations/[0-9a-f]{32}/memory/capture$'), 'agents'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/agents/[0-9a-f]{32}/conversations/[0-9a-f]{32}/action-cards(?:/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/answer)?$'), 'agents'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/agents/draft$'), 'agents'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/agents(?:/[0-9a-f]{32}(?:/(?:archive|conversations(?:/[0-9a-f]{32}(?:/(?:attachments|reply-progress|reply-stop|messages(?:/[0-9a-f]{32}/(?:artifact|retry|files/[0-3]))?))?)?))?)?$'), 'agents'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/meetings(?:/(?:from-call/otcav_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}|draft|speech|transcribe|share-recipients|shared(?:/[0-9a-f]{32}(?:/(?:revoke|action|discussion))?)?|[0-9a-f]{32}(?:/(?:remove|export|shares|action|artifact|memory))?))?$'), 'meetings'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/memory(?:/[0-9a-f]{32}(?:/(?:remove|export|read|pin|share-group|dream(?:/[0-9a-f]{32})?|versions(?:/[0-9]{1,8}(?:/restore)?)?))?)?$'), 'memory'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/memory/actions/draft(?:/save)?$'), 'memory'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/memory/actions/from-(?:chat|meeting)$'), 'memory'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/memory/(?:candidates(?:/[0-9a-f]{32})?|profile(?:/dream)?|graph|(?:actions|links|preferences)(?:/[0-9a-f]{32}(?:/remove)?)?)$'), 'memory'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/search/(?:messages|resources)$'), 'search'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/studio/documents(?:/[0-9a-f]{32}(?:/(?:remove|restore|live|versions(?:/[1-9][0-9]{0,15})?))?)?$'), 'studio'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/artifacts/(?:activity|document-tree|shared-copy|studio-personal-copy|(?:document|spreadsheet|slides)/draft)$'), 'artifacts'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/artifacts(?:/[0-9a-f]{32}(?:/(?:remove|favorite|preview|file|export|restore|studio-copy|versions(?:/[0-9]{1,8}(?:/export)?)?|shares(?:/[0-9a-f]{32}(?:/(?:revoke|link))?)?))?)?$'), 'artifacts'),
    (re.compile(r'^/v1/settings$'), 'settings'),
    (re.compile(r'^/v1/notification-prefs$'), 'settings'),
    (re.compile(r'^/v1/onboarding(?:/(?:recommendations|picks|look|progress))?$'), 'settings'),
    (re.compile(r'^/v1/model-api(?:/(?:image|video|music|model3d))?$'), 'model-api'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/images(?:/[0-9a-f]{32})?$'), 'images'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/videos(?:/[0-9a-f]{32})?$'), 'videos'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/music(?:/[0-9a-f]{32})?$'), 'music'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/websites(?:/[0-9a-f]{32})?$'), 'websites'),
    (re.compile(r'^/v1/workspaces/[0-9a-f]{32}/models-3d(?:/[0-9a-f]{32})?$'), 'model3d'),
    (re.compile(r'^/v1/composio$'), 'connectors'),
    (re.compile(r'^/v1/composio/key$'), 'connectors'),
    (re.compile(r'^/v1/composio/toolkits$'), 'connectors'),
    (re.compile(r'^/v1/composio/connections(?:/[0-9a-f]{32}(?:/disconnect)?)?$'), 'connectors'),
    (re.compile(r'^/v1/composio/approvals(?:/[0-9a-f]{32})?$'), 'connectors'),
    (re.compile(r'^/v1/mcp/servers(?:/[0-9a-f]{32})?$'), 'connectors'),
)

# These paths are handled at the edge or on the platform. The moved API
# locations below are rendered from the same table as the gateway authorization.
PLATFORM_API_LOCATIONS = (
    'location = /v1/agent-homepages/start { return 410; }',
    'location = /v1/composio/callback { proxy_pass http://__PLATFORM__; proxy_set_header Host $host; proxy_set_header X-OT-Gateway-Key ""; }',
)


def moved_api(path):
    """Return the plugin feature that serves this /v1 path, or None."""
    if not isinstance(path, str) or not path.startswith('/v1/') or len(path) > 512:
        return None
    for pattern, feature in MOVED_APIS:
        if pattern.fullmatch(path):
            return feature
    return None




class GatewayError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


def load_routes(path=ROUTES_FILE):
    data = json.loads(Path(path).read_text('utf-8'))
    if data.get('version') != 1 or set(data) != {'version', 'mount', 'passthrough', 'moved_pages'}:
        raise ValueError('Unsupported DS-Bot route table')
    mount = data['mount']
    if not re.fullmatch(r'/[a-z]{1,16}', mount):
        raise ValueError('Invalid DS-Bot mount')
    passthrough = list(data['passthrough'])
    if any(not re.fullmatch(r'/[a-z]{1,16}/', p) for p in passthrough):
        raise ValueError('Invalid passthrough prefix')
    pages = list(data['moved_pages'])
    if any(not PAGE_SEGMENT.fullmatch(p) for p in pages) or len(set(pages)) != len(pages):
        raise ValueError('Invalid moved page list')
    return {'mount': mount, 'passthrough': tuple(passthrough), 'moved_pages': frozenset(pages)}


def ensure_schema(db):
    db.executescript(SCHEMA)


def target_for(uri, routes):
    """Map a browser request target to the DS-Bot path, or None for the platform."""
    if not isinstance(uri, str) or not uri.startswith('/') or len(uri) > 2048:
        return None
    parts = urlsplit(uri)
    path, query = parts.path, parts.query
    lowered = path.lower()
    if ('\\' in path or '//' in path or any(bad in lowered for bad in ('%2e', '%2f', '%5c', '%00'))
            or '/../' in path + '/' or '/./' in path + '/'):
        return None
    mount = routes['mount']
    if path == mount or path.startswith(mount + '/'):
        rest = path[len(mount):] or '/'
        return rest + ('?' + query if query else '')
    if any(path.startswith(prefix) for prefix in routes['passthrough']):
        return uri
    if path.startswith(GATEWAY_PREFIX) and not query:
        return path  # authorize() rewrites this to /api/flybot-workspace after the key is parsed
    feature = moved_api(path)
    if feature is not None:
        # Plugin legacy surface; authorize() keeps the session cookie swap.
        return '/api/flybot-workspace/legacy?feature=' + quote(feature, safe='') + '&path=' + quote(path, safe='') + (('&query=' + quote(query, safe='')) if query else '')
    if path == '/space' and 'artifacts' in routes['moved_pages']:
        path = '/artifacts'
    if path == '/profile/edit/' and 'profile' in routes['moved_pages']:
        path = '/profile/edit'
    first = path.split('/')[1] if path != '/' else 'home'
    if first in routes['moved_pages']:
        return PAGE_ROUTE + '?path=' + quote(path, safe='')
    return None


def _cookies(header):
    jar = SimpleCookie()
    try:
        jar.load(header or '')
    except CookieError:
        raise GatewayError(400, 'invalid_cookie')
    return {name: morsel.value for name, morsel in jar.items()}


def _same_origin(method, origin, fetch_site, fetch_mode, upgrade, public_origin):
    if fetch_site == 'cross-site' and not (method in SAFE_METHODS and fetch_mode == 'navigate' and not upgrade):
        return False
    if method in SAFE_METHODS and not upgrade:
        return origin in ('', public_origin)
    return origin == public_origin and fetch_site in ('', 'same-origin', 'none')



def gateway_call(uri, authorization):
    """Map /v1/gateway/* + Bearer ota_<instance>_<secret> to a plugin call.

    The instance id in the key identifies a candidate DS-Bot. The edge checks
    the current owner binding and forwards the key in a dedicated header for
    verification inside that DS-Bot.
    """
    parts = urlsplit(uri)
    path = parts.path
    if parts.query or not path.startswith(GATEWAY_PREFIX):
        return None
    presented = authorization or ''
    match = BEARER.fullmatch(presented.strip())
    token = match[1] if match else ''
    parsed = GATEWAY_TOKEN.fullmatch(token)
    if not parsed:
        raise GatewayError(401, 'unauthorized')
    invoke = GATEWAY_INVOKE.fullmatch(path)
    status = GATEWAY_STATUS.fullmatch(path)
    if invoke:
        endpoint, extra = 'agent-api/invoke', {'agent_id': invoke[1]}
    elif status:
        endpoint, extra = 'agent-api/invocation', {'id': status[1]}
    else:
        raise GatewayError(404, 'not_found')
    return parsed[1], endpoint, extra, token


def _upstream_row(db, instance_id):
    row = db.execute(
        "SELECT i.id, u.address, u.auth_cookie, i.owner_id FROM instances i JOIN dsbot_upstreams u ON u.instance_id=i.id "
        "WHERE i.id=? AND i.retired_at IS NULL AND i.desired='running' AND i.observed='running' AND i.health='healthy' "
        "AND i.blocked=0 AND i.observed_revision=i.revision",
        (instance_id,)).fetchone()
    if row is None:
        raise GatewayError(503, 'dsbot_not_ready')
    return row


def owner_runtime_readiness(db, user_id, manager_id=None, *, manager_auth=None):
    """The browser receives a state only, never the address or runtime cookie."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='dsbot_upstreams' AND type='table'").fetchone():
        return 'unmanaged'
    try:
        iid = owned_instance(db, user_id)
    except RuntimeFault:
        return 'unavailable'
    if iid is None:
        return 'setup'
    if is_parked(db, iid):
        return 'parked'
    try:
        _upstream_row(db, iid)
    except GatewayError:
        state = db.execute("""
            SELECT i.desired, i.blocked, i.error_code, EXISTS (
                SELECT 1 FROM runtime_auto_provisions p JOIN runtime_jobs j ON j.instance_id=p.instance_id
                WHERE p.instance_id=i.id AND j.revision=i.revision
                  AND j.operation_type='create' AND j.status IN ('queued','running')
            ) AS creating
            FROM instances i WHERE i.id=?
        """, (iid,)).fetchone()
        if state is None or state[1] or state[2]:
            return 'unavailable'
        if state[0] == 'running' or state[3]:
            return 'starting'
        return 'stopped' if resumable_instance(db, user_id, manager_id, manager_auth=manager_auth) is not None else 'unavailable'
    return 'ready'


def authorize(db, *, cookie_header, session_cookie, method, uri, origin, fetch_site, fetch_mode,
              upgrade, public_origin, now, routes, authorization=''):
    """Return the internal headers for the edge, or raise GatewayError."""
    method = (method or '').upper()
    if method not in ('GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'):
        raise GatewayError(405, 'method')
    upgrade = (upgrade or '').lower()
    if upgrade not in ('', 'websocket'):
        raise GatewayError(400, 'upgrade')
    call = gateway_call(uri, authorization)
    if call is not None:
        # External Agent API: the key can target only its owner's assigned DS-Bot.
        if upgrade:
            raise GatewayError(400, 'upgrade')
        instance_id, endpoint, extra, token = call
        row = _upstream_row(db, instance_id)
        try:
            canonical = owned_instance(db, row['owner_id'])
        except RuntimeFault as error:
            raise GatewayError(503, 'dsbot_not_ready') from error
        if canonical != instance_id:
            raise GatewayError(503, 'dsbot_not_ready')
        address = validate_address(row[1])
        # Path includes the original /v1/gateway/... so the plugin can dispatch;
        # the token travels in a dedicated header (not Authorization; nginx strips that).
        return [
            ('X-OT-Upstream', address),
            ('X-OT-Upstream-Path', '/api/flybot-workspace/gateway?path=' + quote(urlsplit(uri).path, safe='')),
            ('X-OT-Upstream-Origin', 'http://' + address),
            ('X-OT-Upstream-Cookie', row[2]),
            ('X-OT-Instance', row[0]),
            ('X-OT-Upstream-Token', token),
        ]
    upstream_path = target_for(uri, routes)
    if upstream_path is None:
        raise GatewayError(404, 'not_gateway')
    if not _same_origin(method, origin or '', (fetch_site or '').lower(), (fetch_mode or '').lower(),
                        bool(upgrade), public_origin):
        raise GatewayError(403, 'origin')
    token = _cookies(cookie_header).get(session_cookie, '')
    if not TOKEN.fullmatch(token):
        raise GatewayError(401, 'unauthorized')
    session = db.execute(
        'SELECT sessions.user_id, users.username FROM sessions JOIN users ON users.id=sessions.user_id '
        'WHERE sessions.token_hash=? AND sessions.expires>?', (digest(token), now),
    ).fetchone()
    if session is None:
        raise GatewayError(401, 'unauthorized')
    try:
        instance_id = owned_instance(db, session[0])
    except RuntimeFault as error:
        raise GatewayError(503, 'dsbot_not_ready') from error
    row = _upstream_row(db, instance_id)
    address = validate_address(row[1])
    username = session[1]
    return [
        ('X-OT-Upstream', address),
        ('X-OT-Upstream-Path', upstream_path),
        ('X-OT-Upstream-Origin', 'http://' + address),
        ('X-OT-Upstream-Cookie', row[2]),
        ('X-OT-Instance', row[0]),
        ('X-OT-Owner-Username', username if OWNER_USERNAME.fullmatch(username) else ''),
    ]


def validate_address(address):
    match = ADDRESS.fullmatch(address or '')
    if not match:
        raise ValueError('Upstream must be an IPv4 literal with a port')
    ip = ipaddress.IPv4Address(match[1])
    port = int(match[2])
    if not (ip.is_private and not ip.is_loopback and not ip.is_link_local) or not 1024 <= port <= 65535:
        raise ValueError('Upstream must be a private runtime address')
    return f'{ip}:{port}'


def record_upstream(db, instance_id, address, auth_cookie, now):
    """Manager side: remember where an active instance listens and its DSH session cookie."""
    if not re.fullmatch(r'[0-9a-f]{32}', instance_id or ''):
        raise ValueError('Invalid instance id')
    name, _, value = (auth_cookie or '').partition('=')
    if not COOKIE_NAME.fullmatch(name) or not re.fullmatch(r'[A-Za-z0-9._~-]{16,2048}', value):
        raise ValueError('Invalid DSH session cookie')
    ensure_schema(db)
    updated = db.execute(
        'INSERT INTO dsbot_upstreams(instance_id,address,auth_cookie,updated) '
        'SELECT id,?,?,? FROM instances WHERE id=? AND retired_at IS NULL '
        'ON CONFLICT(instance_id) DO UPDATE SET address=excluded.address, '
        'auth_cookie=excluded.auth_cookie, updated=excluded.updated',
        (validate_address(address), auth_cookie, int(now), instance_id),
    )
    if updated.rowcount != 1:
        raise ValueError('Instance is not active')


def exchange_launch_url(launch_url, address, timeout=10):
    """Trade a runtime's tokenized launch URL for its DSH session cookie, server side.

    The request goes to the runtime's private address with that address as Host, so the
    signed cookie is bound to the authority the edge later presents. Nothing is logged.
    """
    address = validate_address(address)
    parts = urlsplit(launch_url)
    if parts.scheme != 'http' or not parts.query.startswith('token=') or parts.path not in ('', '/'):
        raise ValueError('Unexpected DSH launch URL')
    host, port = address.split(':')
    conn = HTTPConnection(host, int(port), timeout=timeout)
    try:
        conn.request('GET', '/?' + parts.query, headers={'Host': address})
        response = conn.getresponse()
        response.read()
        found = []
        for header in response.headers.get_all('Set-Cookie') or []:
            pair = header.split(';', 1)[0].strip()
            if COOKIE_NAME.fullmatch(pair.partition('=')[0]):
                found.append(pair)
    finally:
        conn.close()
    if len(found) != 1:
        raise ValueError('DSH did not issue exactly one session cookie')
    return found[0]


class GatewayApp:
    """WSGI endpoint for the edge's auth_request. Mount with :func:`mount`.

    With ``manager_auth`` it also accepts the manager's upstream report
    ``POST /v1/internal/instances/<id>/dsbot-upstream`` (loopback manager bearer only,
    instance must be granted to that manager).
    """

    def __init__(self, store, public_origin, session_cookie, key, routes=None, clock=None, manager_auth=None):
        import time
        if not isinstance(key, str) or len(key) < 32:
            raise ValueError('Gateway key must be at least 32 characters')
        self.store, self.public_origin, self.session_cookie = store, public_origin, session_cookie
        self.manager_auth = manager_auth
        self.key_hash = digest(key)
        self.routes = routes or load_routes()
        self.clock = clock or time.time
        with store.transaction() as db:
            ensure_schema(db)


    def import_bundles(self, env, iid):
        """Manager job: build this owner's per-feature import bundles, secrets sealed to seal_key.

        The 32-byte seal key is the same one the manager binds at
        /run/secrets/flybot-workspace-seal.key. Plain secrets never leave this process
        except re-wrapped in the response, which is loopback-only.
        """
        from . import dsbot_bundle
        from .lifecycle import Lifecycle, RuntimeFault
        if self.manager_auth is None:
            raise GatewayError(404, 'not_found')
        if env.get('REQUEST_METHOD') != 'POST' or env.get('QUERY_STRING'):
            raise GatewayError(405, 'method')
        try:
            manager = self.manager_auth.authenticate(env)
        except RuntimeFault:
            raise GatewayError(401, 'manager_auth')
        try:
            length = int(env.get('CONTENT_LENGTH') or 0)
        except ValueError:
            raise GatewayError(400, 'invalid')
        if not 0 < length <= 256:
            raise GatewayError(400, 'invalid')
        try:
            body = json.loads(env['wsgi.input'].read(length))
        except (ValueError, KeyError):
            raise GatewayError(400, 'invalid')
        if not isinstance(body, dict) or set(body) != {'seal_key'}:
            raise GatewayError(400, 'invalid')
        key = body['seal_key']
        if not isinstance(key, str) or not re.fullmatch(r'[0-9a-f]{64}', key):
            raise GatewayError(400, 'invalid')
        seal = bytes.fromhex(key)
        with self.store.transaction() as db:
            row = db.execute('SELECT owner_id FROM instances WHERE id=? AND retired_at IS NULL', (iid,)).fetchone()
            if row is None or not Lifecycle.grants(db, manager, iid):
                raise GatewayError(403, 'not_granted')
            try:
                destination = owned_instance(db, row[0])
            except RuntimeFault as error:
                raise GatewayError(409, 'import_destination') from error
            if destination != iid:
                raise GatewayError(409, 'import_destination')
            features = []
            for feature in dsbot_bundle.FEATURE_TABLES:
                bundle = dsbot_bundle.build_with_secrets(db, self.store, row[0], feature, seal, int(self.clock()))
                bundle['instance_id'] = iid
                features.append({'name': feature, 'bundle': bundle})
        return [('Content-Type', 'application/json')], json.dumps({'owner_imported': True, 'features': features}, separators=(',', ':')).encode()

    def decide(self, env):
        presented = env.get(KEY_HEADER, '')
        if not presented or not hmac.compare_digest(digest(presented), self.key_hash):
            raise GatewayError(404, 'not_found')
        if env.get('REQUEST_METHOD') != 'GET':
            raise GatewayError(405, 'method')
        with self.store.connect() as db:
            # Resolve the account binding and upstream from the same snapshot.
            db.execute('BEGIN')
            return authorize(
                db, cookie_header=env.get('HTTP_COOKIE', ''), session_cookie=self.session_cookie,
                method=env.get('HTTP_X_ORIGINAL_METHOD', ''), uri=env.get('HTTP_X_ORIGINAL_URI', ''),
                origin=env.get('HTTP_ORIGIN', ''), fetch_site=env.get('HTTP_SEC_FETCH_SITE', ''),
                fetch_mode=env.get('HTTP_SEC_FETCH_MODE', ''), upgrade=env.get('HTTP_X_ORIGINAL_UPGRADE', ''),
                public_origin=self.public_origin, now=int(self.clock()), routes=self.routes,
                authorization=env.get('HTTP_AUTHORIZATION', ''))

    def record(self, env, iid):
        """Manager report: where instance ``iid`` listens and its DSH session cookie."""
        from .lifecycle import Lifecycle, RuntimeFault
        if self.manager_auth is None:
            raise GatewayError(404, 'not_found')
        if env.get('REQUEST_METHOD') != 'POST' or env.get('QUERY_STRING'):
            raise GatewayError(405, 'method')
        try:
            manager = self.manager_auth.authenticate(env)
        except RuntimeFault:
            raise GatewayError(401, 'manager_auth')
        try:
            length = int(env.get('CONTENT_LENGTH') or 0)
        except ValueError:
            raise GatewayError(400, 'invalid')
        if not 0 < length <= 8192:
            raise GatewayError(400, 'invalid')
        try:
            body = json.loads(env['wsgi.input'].read(length))
        except (ValueError, KeyError):
            raise GatewayError(400, 'invalid')
        if not isinstance(body, dict) or set(body) != {'address', 'auth_cookie', 'process_ref'}:
            raise GatewayError(400, 'invalid')
        if not isinstance(body['process_ref'], str) or not re.fullmatch(r'[0-9a-f]{32}', body['process_ref']):
            raise GatewayError(400, 'invalid')
        with self.store.transaction() as db:
            row = db.execute('SELECT process_ref, desired, observed, health, blocked, revision, observed_revision '
                             'FROM instances WHERE id=? AND retired_at IS NULL', (iid,)).fetchone()
            if row is None or not Lifecycle.grants(db, manager, iid):
                raise GatewayError(403, 'not_granted')
            if (row['process_ref'] != body['process_ref'] or row['observed_revision'] != row['revision']
                    or row['desired'] != 'running' or row['observed'] != 'running'
                    or row['health'] != 'healthy' or row['blocked']):
                raise GatewayError(409, 'stale_process')
            try:
                record_upstream(db, iid, body['address'], body['auth_cookie'], self.clock())
            except ValueError:
                raise GatewayError(400, 'invalid')
        return [('Content-Type', 'application/json')], b'{"recorded":true}'

    def __call__(self, env, start_response):
        base = [('Cache-Control', 'no-store'), ('Content-Type', 'text/plain; charset=utf-8')]
        imported = IMPORT_PATH.fullmatch(env.get('PATH_INFO', ''))
        if imported:
            try:
                headers, body = self.import_bundles(env, imported[1])
                start_response('200 OK', [('Cache-Control', 'no-store')] + headers)
                return [body]
            except GatewayError as error:
                start_response(f'{error.status} Refused', [('Cache-Control', 'no-store'), ('Content-Type', 'application/json')])
                return [json.dumps({'error': {'code': error.code}}).encode()]
            except Exception:
                start_response('503 Service Unavailable', [('Content-Type', 'application/json')])
                return [b'{"error":{"code":"unavailable"}}']
        reported = UPSTREAM_PATH.fullmatch(env.get('PATH_INFO', ''))
        if reported:
            try:
                headers, body = self.record(env, reported[1])
                start_response('200 OK', [('Cache-Control', 'no-store')] + headers)
                return [body]
            except GatewayError as error:
                start_response(f'{error.status} Refused', [('Cache-Control', 'no-store'), ('Content-Type', 'application/json')])
                return [json.dumps({'error': {'code': error.code}}).encode()]
            except Exception:
                start_response('503 Service Unavailable', [('Content-Type', 'application/json')])
                return [b'{"error":{"code":"unavailable"}}']
        try:
            headers = self.decide(env)
            start_response('204 No Content', base + headers)
            return [b'']
        except GatewayError as error:
            reasons = {400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
                       405: 'Method Not Allowed', 409: 'Conflict', 503: 'Service Unavailable'}
            start_response(f'{error.status} {reasons.get(error.status, "Error")}',
                           base + [('X-OT-Gateway-Error', error.code)])
            return [error.code.encode()]
        except Exception:
            start_response('503 Service Unavailable', base + [('X-OT-Gateway-Error', 'unavailable')])
            return [b'unavailable']


def load_operator_key(path):
    """Read the operator gateway key file ``{"version":1,"key":"..."}`` (0600, owner-only)."""
    import os
    import stat
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Gateway key file must be a private regular file')
        data = json.loads(os.read(fd, 4096))
    finally:
        os.close(fd)
    if not isinstance(data, dict) or set(data) != {'version', 'key'} or data['version'] != 1:
        raise ValueError('Unsupported gateway key file')
    key = data['key']
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key):
        raise ValueError('Invalid gateway key')
    return key


def wrap(app, store, config, key_file, manager_auth=None):
    """Deployment wiring for wsgi.py: ``application = dsbot_gateway.wrap(app, store, config, path, manager_auth)``.

    ``config`` is the management ``Config`` (public origin and session cookie name come
    from it). Without a key file the gateway stays off and ``app`` is returned as is.
    """
    if not key_file:
        return app
    gateway = GatewayApp(store, config.origin, config.cookie_names[0], load_operator_key(key_file),
                         manager_auth=manager_auth)
    return mount(app, gateway)


def mount(app, gateway):
    """Compose the management app with the gateway endpoint; nothing else changes."""
    def composed(env, start_response):
        if gateway is not None and (env.get('PATH_INFO') == ROUTE_PATH
                                    or UPSTREAM_PATH.fullmatch(env.get('PATH_INFO', ''))
                                    or IMPORT_PATH.fullmatch(env.get('PATH_INFO', ''))):
            return gateway(env, start_response)
        return app(env, start_response)
    return composed


NGINX_TEMPLATE = r'''# Generated by flybot_workspace.dsbot_gateway.nginx_config. Edge for one public origin:
# platform paths go to the management app; DS-Bot paths go to the signed-in owner's
# own runtime after auth_request. Client X-OT-* headers and dsh-auth-* cookies never
# reach a runtime. In production the gateway key comes from an operator include.
map $http_upgrade $ot_connection_upgrade { default upgrade; '' close; }
server {
  listen __LISTEN__;
  server_name _;
  absolute_redirect off;
  client_max_body_size 64m;
__KEY_SETTING__
  location = /v1/internal { return 404; }
  location ^~ /v1/internal/ { return 404; }
  location = /v1/admin { return 404; }
  location ^~ /v1/admin/ { return 404; }
  location = /v1/platform/route { return 404; }
  location ^~ /v1/runtime/ {
    default_type application/json;
    return 410 '{"error":{"code":"retired"}}';
  }
__SOCIAL_LOCATION__
  location = /_ot_authz {
    internal;
    proxy_pass http://__PLATFORM__/v1/platform/route;
    proxy_method GET;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host $host;
    proxy_set_header X-Original-URI $request_uri;
    proxy_set_header X-Original-Method $request_method;
    proxy_set_header X-Original-Upgrade $http_upgrade;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-OT-Gateway-Key $ot_gateway_key;
  }
__DSBOT_LOCATIONS__
  location @ot_dsbot {
    auth_request /_ot_authz;
    error_page 401 = @ot_login;
    error_page 500 = @ot_dsbot_error;
    auth_request_set $ot_gateway_error $upstream_http_x_ot_gateway_error;
    auth_request_set $ot_upstream $upstream_http_x_ot_upstream;
    auth_request_set $ot_path $upstream_http_x_ot_upstream_path;
    auth_request_set $ot_origin $upstream_http_x_ot_upstream_origin;
    auth_request_set $ot_cookie $upstream_http_x_ot_upstream_cookie;
    auth_request_set $ot_owner_username $upstream_http_x_ot_owner_username;
    proxy_pass http://$ot_upstream$ot_path;
    proxy_http_version 1.1;
    proxy_set_header Host $ot_upstream;
    proxy_set_header Origin $ot_origin;
    proxy_set_header Cookie $ot_cookie;
    proxy_set_header Authorization "";
    proxy_set_header Sec-Fetch-Site "";
    proxy_set_header X-OT-Upstream "";
    proxy_set_header X-OT-Upstream-Cookie "";
    proxy_set_header X-OT-Owner-Username $ot_owner_username;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $ot_connection_upgrade;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_redirect off;
    proxy_hide_header Set-Cookie;
  }
  location @ot_dsbot_error {
    default_type application/json;
    if ($ot_gateway_error != dsbot_not_ready) { return 500 '{"error":{"code":"runtime_route_failed"}}'; }
    if ($http_sec_fetch_mode = navigate) { rewrite ^ /runtime-starting? last; }
    add_header Cache-Control no-store always;
    add_header Retry-After 3 always;
    return 503 '{"error":{"code":"dsbot_not_ready"}}';
  }
  location ^~ /v1/gateway/ {
    auth_request /_ot_authz;
    error_page 401 = @ot_gateway_unauthorized;
    error_page 500 = @ot_gateway_error;
    auth_request_set $ot_gateway_error $upstream_http_x_ot_gateway_error;
    auth_request_set $ot_upstream $upstream_http_x_ot_upstream;
    auth_request_set $ot_path $upstream_http_x_ot_upstream_path;
    auth_request_set $ot_origin $upstream_http_x_ot_upstream_origin;
    auth_request_set $ot_cookie $upstream_http_x_ot_upstream_cookie;
    auth_request_set $ot_token $upstream_http_x_ot_upstream_token;
    proxy_pass http://$ot_upstream$ot_path;
    proxy_http_version 1.1;
    proxy_set_header Host $ot_upstream;
    proxy_set_header Origin $ot_origin;
    proxy_set_header Cookie $ot_cookie;
    proxy_set_header Authorization "";
    proxy_set_header X-OT-Gateway-Token $ot_token;
    proxy_set_header Sec-Fetch-Site "";
    proxy_set_header X-OT-Upstream "";
    proxy_set_header X-OT-Upstream-Cookie "";
    proxy_set_header X-OT-Upstream-Token "";
    proxy_set_header X-OT-Owner-Username "";
    proxy_hide_header Set-Cookie;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_redirect off;
  }
  location @ot_gateway_unauthorized {
    default_type application/json;
    add_header Cache-Control no-store always;
    return 401 '{"error":{"code":"unauthorized"}}';
  }
  location @ot_gateway_error {
    default_type application/json;
    add_header Cache-Control no-store always;
    if ($ot_gateway_error = dsbot_not_ready) { return 503 '{"error":{"code":"dsbot_not_ready"}}'; }
    if ($ot_gateway_error = not_found) { return 404 '{"error":{"code":"not_found"}}'; }
    return 500 '{"error":{"code":"runtime_route_failed"}}';
  }
  recursive_error_pages on;
  error_page 418 = @ot_dsbot;
  error_page 401 = @ot_login;
  location @ot_login {
    if ($uri = /discover/) { rewrite ^ /_ot_discover_guest/discover last; }
    if ($uri ~ "^/discover(?:/app[.](?:css|mjs)|/(?:comments|document-reader)[.]mjs)?$") {
      rewrite ^ /_ot_discover_guest$uri last;
    }
__GUEST_DISCOVER_FEEDS__
__WORKSPACE_LOGIN_REWRITE__
    return 302 /login;
  }
  location = /_ot_workspace_login {
    internal;
    limit_except GET HEAD { deny all; }
    proxy_pass http://__PLATFORM__/login;
    proxy_set_header Host $host;
    proxy_set_header Sec-Fetch-Site "";
    proxy_set_header X-OT-Gateway-Key "";
  }
  location ^~ /_ot_discover_guest/ {
    internal;
    limit_except GET HEAD { deny all; }
    proxy_pass http://__PLATFORM__/;
    proxy_set_header Host $host;
    proxy_set_header Sec-Fetch-Site "";
    proxy_set_header Cookie "";
    proxy_set_header Authorization "";
    proxy_set_header X-OT-Gateway-Key "";
  }
  location / {
    proxy_pass http://__PLATFORM__;
    proxy_set_header Host $host;
    proxy_set_header X-OT-Gateway-Key "";
  }
}
'''


SOCIAL_UPSTREAM = re.compile(r'^[0-9A-Za-z.\-]+:\d{2,5}$')
SOCIAL_SOCKET_PATH = '/run/flybot-workspace-social/bot-social.sock'

# Isolated FlyBot Bot Social is reached at /social/ on the existing public
# origin. The prefix is stripped; the container sees /v1/... and /healthz.
# Omit bot_social to leave this location out (current sites without the service).
def social_location(upstream):
    if not SOCIAL_UPSTREAM.fullmatch(upstream):
        raise ValueError('Invalid Bot Social upstream')
    return (
        '  location = /social { absolute_redirect off; return 308 /social/; }\n'
        '  location ^~ /social/ {\n'
        f'    proxy_pass http://{upstream}/;\n'
        '    proxy_http_version 1.1;\n'
        '    proxy_set_header Host $host;\n'
        '    proxy_set_header X-Forwarded-Proto $scheme;\n'
        '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n'
        '    proxy_set_header X-Forwarded-Prefix /social;\n'
        '    proxy_set_header X-OT-Gateway-Key "";\n'
        '    proxy_read_timeout 60s;\n'
        '    proxy_redirect off;\n'
        '  }\n'
        '  location ^~ /_ot_public_feed/ {\n'
        '    internal;\n'
        '    limit_except GET HEAD { deny all; }\n'
        f'    proxy_pass http://{upstream}/v1/ot/public/discover/;\n'
        '    proxy_http_version 1.1;\n'
        '    proxy_set_header Host $host;\n'
        '    proxy_set_header Cookie "";\n'
        '    proxy_set_header Authorization "";\n'
        '    proxy_set_header X-OT-Gateway-Key "";\n'
        '    proxy_hide_header Set-Cookie;\n'
        '    proxy_read_timeout 15s;\n'
        '    proxy_redirect off;\n'
        '  }\n'
        # Public agent homepages (/a/<slug>), works (/w/<slug>) and read-only shares
        # (/share/<token>) on the site root are rendered by the dedicated Bot Social.
        # Site cookies and credentials never reach it.
        '  location ~ ^/(?:a|w|share)/ {\n'
        '    limit_except GET HEAD { deny all; }\n'
        f'    proxy_pass http://{upstream};\n'
        '    proxy_http_version 1.1;\n'
        '    proxy_set_header Host $host;\n'
        '    proxy_set_header Cookie "";\n'
        '    proxy_set_header Authorization "";\n'
        '    proxy_set_header X-OT-Gateway-Key "";\n'
        '    proxy_hide_header Set-Cookie;\n'
        '    proxy_read_timeout 30s;\n'
        '    proxy_redirect off;\n'
        '  }'
    )


def nginx_config(routes, platform, listen, key_include=None, key=None, bot_social=None, bot_social_socket=False):
    """Render the edge config.

    Production passes ``key_include``: the absolute path of an operator-owned nginx
    include containing ``set $ot_gateway_key "<key>";`` so the key never sits in the
    rendered file. Tests may pass ``key`` directly. ``bot_social`` is ``host:port``
    of the isolated FlyBot Bot Social on the compose network; leave it unset
    when that service is not running.
    """
    if (key_include is None) == (key is None):
        raise ValueError('Pass exactly one of key_include or key')
    if key_include is not None:
        if not re.fullmatch(r'/[A-Za-z0-9/_.-]{1,200}', key_include) or '..' in key_include:
            raise ValueError('Invalid key include path')
        setting = f'  include {key_include};'
    else:
        if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', key):
            raise ValueError('Invalid gateway key')
        setting = f'  set $ot_gateway_key "{key}";'
    if not re.fullmatch(r'[0-9A-Za-z.\-]+:\d{2,5}', platform) or not re.fullmatch(r'[0-9A-Za-z.:\[\]]+', str(listen)):
        raise ValueError('Invalid platform or listen address')
    locations = [f'  location = {routes["mount"]} {{ return 418; }}',
                 f'  location ^~ {routes["mount"]}/ {{ return 418; }}']
    for prefix in routes['passthrough']:
        locations.append(f'  location ^~ {prefix} {{ return 418; }}')
    locations.extend('  ' + line.replace('__PLATFORM__', platform) for line in PLATFORM_API_LOCATIONS)
    # nginx treats unquoted PCRE quantifiers as configuration block delimiters.
    locations.extend(f'  location ~ "{pattern.pattern}" {{ return 418; }}' for pattern, _ in MOVED_APIS)
    if 'artifacts' in routes['moved_pages']:
        locations.append('  location = /space { return 418; }')
    for page in sorted(routes['moved_pages']):
        if page == 'home':
            locations.append('  location = / { return 418; }')
        locations.append(f'  location = /{page} {{ return 418; }}')
        locations.append(f'  location ^~ /{page}/ {{ return 418; }}')
    social = social_location(bot_social) if bot_social else ''
    guest_feeds = ('    rewrite ^/v1/discover/(works|agents)$ /_ot_public_feed/$1 last;'
                   if bot_social else '')
    private_pages = sorted(routes['moved_pages'] - {'home', 'discover'})
    private_paths = [f"(?:{'|'.join(private_pages)})/?"] if private_pages else []
    for page, path in (('artifacts', 'space'), ('profile', 'profile/edit/?'),
                       ('settings', 'settings/[a-z0-9][a-z0-9-]{0,40}/?')):
        if page in private_pages:
            private_paths.append(path)
    # Render the login form at the original address. The browser retains both
    # the query string and the fragment, which the gateway never sees.
    workspace_login = ('    if ($http_sec_fetch_mode = navigate) {\n'
                       f'      rewrite "^/(?:{"|".join(private_paths)})$" /_ot_workspace_login? last;\n'
                       '    }' if private_paths else '')
    configuration = (NGINX_TEMPLATE.replace('__LISTEN__', str(listen)).replace('__PLATFORM__', platform)
            .replace('__KEY_SETTING__', setting).replace('__DSBOT_LOCATIONS__', '\n'.join(locations))
            .replace('__SOCIAL_LOCATION__', social).replace('__GUEST_DISCOVER_FEEDS__', guest_feeds)
            .replace('__WORKSPACE_LOGIN_REWRITE__', workspace_login))
    if not bot_social_socket:
        return configuration
    if not bot_social:
        raise ValueError('The Bot Social socket requires a Bot Social upstream')
    return configuration + f'''server {{
  listen unix:{SOCIAL_SOCKET_PATH};
  server_name _;
  client_max_body_size 64m;
  location = /v1/ot/ops {{ return 404; }}
  location ^~ /v1/ot/ops/ {{ return 404; }}
  location ^~ /v1/ot/ {{
    proxy_pass http://{bot_social};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For "";
    proxy_set_header Forwarded "";
    proxy_set_header Cookie "";
    proxy_set_header X-OT-Gateway-Key "";
    proxy_redirect off;
    proxy_connect_timeout 2s;
  }}
  location / {{ return 404; }}
}}
'''


def main(argv=None):
    """Render the edge config: ``python -m flybot_workspace.dsbot_gateway render ...``."""
    import argparse
    parser = argparse.ArgumentParser(prog='python -m flybot_workspace.dsbot_gateway')
    sub = parser.add_subparsers(dest='command', required=True)
    render = sub.add_parser('render', help='Print the nginx edge config for the current route table')
    render.add_argument('--platform', required=True, help='host:port of the management app as seen by nginx')
    render.add_argument('--listen', required=True, help='nginx listen address, e.g. 127.0.0.1:8081')
    render.add_argument('--key-include', required=True, help='absolute path of the operator include setting $ot_gateway_key')
    render.add_argument('--routes', default=str(ROUTES_FILE))
    render.add_argument('--bot-social', default=None,
                        help='host:port of the isolated FlyBot Bot Social (compose service, e.g. bot-social:8787). Adds /social/ on this origin.')
    render.add_argument('--bot-social-socket', action='store_true',
                        help='Also serve the account runtime collaboration API over the fixed Unix socket')
    args = parser.parse_args(argv)
    print(nginx_config(load_routes(args.routes), args.platform, args.listen,
                       key_include=args.key_include, bot_social=args.bot_social,
                       bot_social_socket=args.bot_social_socket), end='')


if __name__ == '__main__':
    main()
