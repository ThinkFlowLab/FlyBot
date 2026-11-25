"""Platform and workspace Bot Social collaboration endpoint.

Management records only a validated server URL (and optional display name).
Connector tokens stay on the instance volume after onboarding; they are never
accepted, stored, or returned here. Workspace override wins over the platform
default. Self-written; not a Teamily parity claim.
"""
from urllib.parse import urlsplit

SCHEMA = '''
CREATE TABLE IF NOT EXISTS bot_social_configs (
 id TEXT PRIMARY KEY,
 scope TEXT NOT NULL CHECK(scope IN ('platform','workspace')),
 workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
 server TEXT NOT NULL,
 display_name TEXT,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 updated INTEGER NOT NULL,
 CHECK(
  (scope='platform' AND workspace_id IS NULL)
  OR (scope='workspace' AND workspace_id IS NOT NULL)
 ));
CREATE UNIQUE INDEX IF NOT EXISTS bot_social_platform ON bot_social_configs(scope) WHERE scope='platform';
CREATE UNIQUE INDEX IF NOT EXISTS bot_social_workspace ON bot_social_configs(workspace_id) WHERE scope='workspace';
'''

MAX_URL = 200
MAX_NAME = 40
LOOPBACK = {'localhost', '127.0.0.1', '::1'}
EMPTY = {'server': None, 'displayName': None, 'revision': 0, 'scope': None}


class BotSocialConfigError(ValueError):
    pass


def flatten_name(value):
    if value is None:
        return None
    if not isinstance(value, str):
        raise BotSocialConfigError('display name must be a string')
    text = ' '.join(value.replace('\x00', ' ').split())
    if any(ord(c) < 32 for c in text):
        raise BotSocialConfigError('display name must not contain control characters')
    text = text[:MAX_NAME].strip()
    return text or None


def parse_server_url(value):
    """Return a normalized https (or loopback http) address, or None if unset."""
    if value is None or value == '':
        return None
    if not isinstance(value, str):
        raise BotSocialConfigError('Bot Social server address must be a string')
    text = value.strip()
    if text == '':
        return None
    if len(text) > MAX_URL:
        raise BotSocialConfigError('Bot Social server address is too long')
    if any(ord(c) < 32 for c in text) or '\x00' in text:
        raise BotSocialConfigError('Bot Social server address is not a valid URL')
    loopback_host = False
    lower = text.lower()
    for host in ('localhost', '127.0.0.1', '[::1]'):
        if lower == host or lower.startswith(host + ':') or lower.startswith(host + '/') or lower.startswith(host + '?'):
            loopback_host = True
            break
    if '://' not in text:
        text = ('http://' if loopback_host else 'https://') + text
    try:
        parts = urlsplit(text, allow_fragments=True)
    except ValueError as error:
        raise BotSocialConfigError('Bot Social server address is not a valid URL') from error
    if parts.scheme not in ('https', 'http'):
        raise BotSocialConfigError('Bot Social server address must start with https://')
    if parts.username is not None or parts.password is not None:
        raise BotSocialConfigError('leave user name and password out of the Bot Social server address')
    if parts.query or parts.fragment:
        raise BotSocialConfigError('use the plain Bot Social server address, without ? or # parts')
    host = (parts.hostname or '').lower()
    if not host:
        raise BotSocialConfigError('Bot Social server address is not a valid URL')
    if parts.scheme == 'http' and host not in LOOPBACK:
        raise BotSocialConfigError('http:// is only accepted for localhost')
    path = parts.path.rstrip('/')
    netloc = parts.netloc
    return f'{parts.scheme}://{netloc}{path}'


def public_view(row, scope=None):
    if row is None:
        empty = dict(EMPTY)
        empty['scope'] = scope
        return empty
    return {
        'scope': row['scope'],
        'server': row['server'],
        'displayName': row['display_name'],
        'revision': row['revision'],
    }


def load_platform(db):
    return db.execute("SELECT * FROM bot_social_configs WHERE scope='platform'").fetchone()


def load_workspace(db, workspace_id):
    return db.execute(
        "SELECT * FROM bot_social_configs WHERE scope='workspace' AND workspace_id=?",
        (workspace_id,),
    ).fetchone()


def resolve(db, workspace_id=None):
    """Workspace override if it has a server, otherwise the platform default."""
    if workspace_id:
        row = load_workspace(db, workspace_id)
        if row is not None and row['server']:
            return public_view(row, 'workspace'), 'workspace'
    row = load_platform(db)
    if row is not None and row['server']:
        return public_view(row, 'platform'), 'platform'
    return public_view(None, 'platform'), None


def effective_view(public, source):
    return {
        'server': public.get('server') if public else None,
        'displayName': public.get('displayName') if public else None,
        'scope': public.get('scope') if public else None,
        'source': source or 'none',
    }


def container_payload(public, source):
    """JSON the FlyBot image loader expects. Never includes a connector token."""
    if not public or not public.get('server'):
        return None
    if source not in ('platform', 'workspace'):
        return None
    payload = {'server': public['server'], 'source': source}
    if public.get('displayName'):
        payload['displayName'] = public['displayName']
    return payload
