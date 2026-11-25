"""WSGI management API. No Docker, subprocess, host mounts, or runtime credentials."""
from dataclasses import dataclass
from http.cookies import CookieError, SimpleCookie
import hmac
import json
import re
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from .security import digest, dummy_verify, opaque, password_hash, password_matches
from .lifecycle import RuntimeFault, UNSUPPORTED, valid_key
from . import agents, artifacts, bot_social, composio, conversations, meetings, members, model_api, oidc, onboarding, personal, profiles, runtime_autoprovision, skill_secrets, social, team_templates, teams, skill_installs



from .dsbot_gateway import moved_api, owner_runtime_readiness  # noqa: E402

# Central execution routes removed in the DS-Bot architecture (thin 410 for old clients).
GONE_PATHS = frozenset({'/v1/agent-homepages/start', '/v1/runtime-keys'})
GONE_WORKSPACE_EVENTS = re.compile(r'/v1/workspaces/[0-9a-f]{32}/events')

class APIError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def refuse(status, code, message):
    raise APIError(status, code, message)


@dataclass(frozen=True)
class Config:
    origin: str
    insecure_local: bool = False
    allow_registration: bool = False
    session_seconds: int = 43200
    max_users: int = 1000
    max_sessions_per_user: int = 8
    max_sessions: int = 8192
    max_workspaces_per_user: int = 20
    max_workspaces: int = 10000
    max_members_per_workspace: int = 50
    max_invites_per_workspace: int = 20
    max_artifacts_per_workspace: int = 50
    max_shares_per_artifact: int = 10
    max_versions_per_artifact: int = 100
    max_memory_pages_per_workspace: int = 100
    max_memory_actions_per_workspace: int = 200
    max_memory_links_per_workspace: int = 500
    max_memory_preferences_per_user: int = 50
    max_agents_per_workspace: int = 50
    max_meetings_per_workspace: int = 100
    max_conversations_per_user: int = 50
    max_messages_per_conversation: int = 200
    max_social_conversations_per_workspace: int = 200
    max_social_messages_per_conversation: int = 500
    max_social_members_per_conversation: int = 50
    auth_peer_limit: int = 20
    auth_name_limit: int = 10
    auth_global_limit: int = 100
    auth_window: int = 600
    max_rate_buckets: int = 4096
    runtime_heartbeat_seconds: int = 45
    runtime_task_timeout_seconds: int = 60
    automation_interval_seconds: int = 5

    def __post_init__(self):
        parsed = urlsplit(self.origin)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
                or parsed.netloc != parsed.netloc.lower()):
            raise ValueError('Use an exact lowercase HTTP(S) origin without path or credentials')
        if parsed.scheme != 'https' and not (self.insecure_local and model_api.insecure_http_allowed(parsed.hostname)):
            raise ValueError('HTTP is allowed only for explicit insecure loopback or private-address development')
        if self.insecure_local and (parsed.scheme != 'http' or not model_api.insecure_http_allowed(parsed.hostname)):
            raise ValueError('Insecure cookies are restricted to HTTP loopback or private-address development')
        for name in self.__dataclass_fields__:
            if name not in ('origin', 'insecure_local', 'allow_registration'):
                value = getattr(self, name)
                if type(value) is not int or not 1 <= value <= (604800 if name == 'session_seconds' else 100000):
                    raise ValueError('Limits must be bounded positive integers')
        if self.session_seconds > 604800:
            raise ValueError('Session lifetime cannot exceed seven days')

    @property
    def cookie_names(self):
        prefix = 'ot_dev_' if self.insecure_local else '__Host-ot_'
        return prefix + 'session', prefix + 'csrf'


def object_only(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


class App:
    def __init__(self, store, config, clock=time.time, lifecycle=None, manager_auth=None, operator_admin=None, oidc_registry=None, composio_transport=None, model_http_policy=None, auto_provision=None, mcp_transport=None):
        from .model_http_policy import ModelHttpPolicy
        if model_http_policy is not None and not isinstance(model_http_policy, ModelHttpPolicy):
            raise ValueError("Invalid operator model HTTP policy")
        self.model_http_policy = model_http_policy or ModelHttpPolicy()
        self.store, self.config, self.clock = store, config, clock
        self.lifecycle, self.manager_auth = lifecycle, manager_auth
        from . import runtime_autoprovision
        if auto_provision is not None and not isinstance(auto_provision, runtime_autoprovision.AutoProvisionPolicy):
            raise ValueError('Invalid auto-provision policy')
        runtime_autoprovision.validate(auto_provision, lifecycle, manager_auth)
        self.auto_provision = auto_provision or runtime_autoprovision.AutoProvisionPolicy()
        self.operator_admin = operator_admin
        self.oidc_registry = oidc_registry

    def __call__(self, env, start_response):
        headers = [('Cache-Control', 'no-store'),
                   ('X-Content-Type-Options', 'nosniff'), ('Referrer-Policy', 'no-referrer')]
        try:
            status, body, extra = self.dispatch(env)
            headers += extra
        except (APIError, RuntimeFault) as error:
            status, body = error.status, {'error': {'code': error.code, 'message': error.message}}
            if isinstance(error, RuntimeFault) and error.current is not None:
                body['error']['current'] = error.current
            if status == 429 and error.code == 'rate_limited':
                headers.append(('Retry-After', str(self.config.auth_window)))
        except (sqlite3.Error, OSError):
            status, body = 503, {'error': {'code': 'unavailable', 'message': 'Storage is temporarily unavailable'}}
        except Exception:
            status, body = 500, {'error': {'code': 'internal', 'message': 'Internal service error'}}
        if not any(key.lower() == 'content-security-policy' for key, _value in headers):
            headers.append(('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"))
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
            if not any(key.lower() == 'content-type' for key, _value in headers):
                headers.insert(0, ('Content-Type', 'text/plain; charset=utf-8'))
        else:
            headers.insert(0, ('Content-Type', 'application/json; charset=utf-8'))
            data = json.dumps(body, ensure_ascii=True, separators=(',', ':')).encode('utf-8')
        headers.append(('Content-Length', str(len(data))))
        reasons = {200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
                   404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 411: 'Length Required',
                   413: 'Content Too Large', 415: 'Unsupported Media Type', 429: 'Too Many Requests',
                   500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable'}
        start_response(f'{status} {reasons[status]}', headers)
        return [data]

    def cookies(self, env):
        raw = env.get('HTTP_COOKIE', '')
        if len(raw) > 4096:
            refuse(400, 'invalid', 'Cookie header is too large')
        try:
            names = [part.split('=', 1)[0].strip() for part in raw.split(';') if '=' in part]
            if len(names) != len(set(names)):
                raise ValueError()
            result = SimpleCookie()
            result.load(raw)
            return {key: value.value for key, value in result.items()}
        except (CookieError, ValueError):
            refuse(400, 'invalid', 'Malformed cookies')

    def body(self, env, allowed, limit=16384):
        if env.get('HTTP_TRANSFER_ENCODING'):
            refuse(400, 'invalid', 'Transfer encoding is not supported')
        length = env.get('CONTENT_LENGTH', '')
        if not re.fullmatch(r'[0-9]{1,8}', length):
            refuse(411, 'invalid', 'A bounded Content-Length is required')
        length = int(length)
        if length > limit:
            refuse(413, 'invalid', 'Request body is too large')
        if env.get('CONTENT_TYPE', '').split(';', 1)[0].strip().lower() != 'application/json':
            refuse(415, 'invalid', 'Use application/json')
        raw = env['wsgi.input'].read(length)
        try:
            if len(raw) != length:
                raise ValueError()
            body = json.loads(raw.decode('utf-8'), object_pairs_hook=object_only,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(body, dict) or set(body) - set(allowed):
                raise ValueError()
            return body
        except (ValueError, UnicodeError, RecursionError):
            refuse(400, 'invalid', 'Malformed JSON or unexpected fields')

    def origin_check(self, env):
        if (env.get('HTTP_ORIGIN') != self.config.origin
                or env.get('HTTP_SEC_FETCH_SITE', '') not in ('', 'same-origin', 'none')):
            refuse(403, 'origin', 'A same-origin request is required')

    def csrf_check(self, env, session):
        self.origin_check(env)
        csrf = env.get('HTTP_X_CSRF_TOKEN', '')
        cookie = self.cookies(env).get(self.config.cookie_names[1], '')
        if (not re.fullmatch(r'[A-Za-z0-9_-]{43}', csrf) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', cookie) or not hmac.compare_digest(csrf, cookie)
                or not hmac.compare_digest(digest(csrf), session['csrf_hash'])):
            refuse(403, 'csrf', 'A valid CSRF token is required')

    def authenticated(self, db, env, now):
        token = self.cookies(env).get(self.config.cookie_names[0], '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            refuse(401, 'unauthorized', 'Sign in first')
        session = db.execute('SELECT s.*,u.username FROM sessions s JOIN users u ON u.id=s.user_id '
                             'WHERE s.token_hash=? AND s.expires>?', (digest(token), now)).fetchone()
        if session is None:
            refuse(401, 'unauthorized', 'Sign in first')
        return session

    def rate_limit(self, env, username, now):
        peer = env.get('REMOTE_ADDR', '')
        if len(peer) > 128:
            refuse(400, 'invalid', 'Invalid client address')
        limits = [('peer:' + peer, self.config.auth_peer_limit),
                  ('name:' + username, self.config.auth_name_limit), ('global', self.config.auth_global_limit)]
        blocked = False
        with self.store.transaction() as db:
            db.execute('DELETE FROM rate_limits WHERE expires<=?', (now,))
            for key, limit in limits:
                key = digest(key)
                row = db.execute('SELECT count FROM rate_limits WHERE key=?', (key,)).fetchone()
                if row is None:
                    if db.execute('SELECT COUNT(*) FROM rate_limits').fetchone()[0] >= self.config.max_rate_buckets:
                        blocked = True
                        break
                    db.execute('INSERT INTO rate_limits VALUES(?,1,?)', (key, now + self.config.auth_window))
                else:
                    if row['count'] >= limit:
                        blocked = True
                    else:
                        db.execute('UPDATE rate_limits SET count=count+1 WHERE key=?', (key,))
        if blocked:
            refuse(429, 'rate_limited', 'Authentication request limit reached; try later')


    def session_headers(self, token, csrf, expires=False):
        headers = []
        for name, value, http_only in zip(self.config.cookie_names, [token, csrf], [True, False]):
            cookie = SimpleCookie()
            cookie[name] = value
            item = cookie[name]
            item['path'], item['samesite'] = '/', 'Strict'
            item['max-age'] = 0 if expires else self.config.session_seconds
            if not self.config.insecure_local:
                item['secure'] = True
            if http_only:
                item['httponly'] = True
            headers.append(('Set-Cookie', item.OutputString()))
        return headers

    def new_session(self, db, user_id, now):
        db.execute('DELETE FROM sessions WHERE expires<=?', (now,))
        count = db.execute('SELECT COUNT(*) FROM sessions WHERE user_id=?', (user_id,)).fetchone()[0]
        if count >= self.config.max_sessions_per_user:
            db.execute('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=? '
                       'ORDER BY created,rowid LIMIT ?)', (user_id, count - self.config.max_sessions_per_user + 1))
        if db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] >= self.config.max_sessions:
            refuse(429, 'quota', 'Session capacity reached')
        token, csrf = opaque(), opaque()
        db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)',
                   (digest(token), digest(csrf), user_id, now + self.config.session_seconds, now))
        return self.session_headers(token, csrf)

    def oidc_start(self, env, now, body):
        provider_id = body.get('provider')
        if not isinstance(provider_id, str) or self.oidc_registry is None:
            refuse(404, 'not_found', 'Provider not found')
        provider = self.oidc_registry.get(provider_id)
        if provider is None:
            refuse(404, 'not_found', 'Provider not found')
        self.rate_limit(env, 'oidc:' + provider.id, now)
        state, nonce = opaque(), opaque()
        verifier, challenge = oidc.pkce_pair()
        redirect_uri = self.config.origin + '/v1/auth/oidc/callback'
        user_id = None
        with self.store.transaction() as db:
            token = self.cookies(env).get(self.config.cookie_names[0], '')
            if re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
                session = db.execute(
                    'SELECT user_id FROM sessions WHERE token_hash=? AND expires>?', (digest(token), now)
                ).fetchone()
                user_id = None if session is None else session['user_id']
            db.execute('DELETE FROM oidc_states WHERE expires<=?', (now,))
            if db.execute('SELECT COUNT(*) FROM oidc_states').fetchone()[0] >= oidc.MAX_STATES:
                refuse(429, 'quota', 'Authentication request limit reached; try later')
            db.execute(
                'INSERT INTO oidc_states VALUES(?,?,?,?,?,?,?)',
                (digest(state), provider.id, nonce, oidc.wrap(oidc.wrapping_key(self.store), verifier),
                 user_id, now, now + oidc.STATE_TTL),
            )
        url = self.oidc_registry.authorization_url(
            provider, state=state, nonce=nonce, challenge=challenge, redirect_uri=redirect_uri)
        return 200, {'authorization_url': url, 'provider': provider.id}, []

    def oidc_callback(self, env, now, query):
        if self.oidc_registry is None:
            refuse(404, 'not_found', 'Provider not found')
        try:
            args = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=8) if query else {}
            if any(len(v) != 1 for v in args.values()):
                raise ValueError()
        except ValueError:
            refuse(400, 'invalid', 'Invalid callback parameters')
        if args.get('error'):
            refuse(400, 'invalid', 'Sign-in was cancelled or rejected')
        state, code = args.get('state', [None])[0], args.get('code', [None])[0]
        if (not isinstance(state, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', state)
                or not isinstance(code, str) or not 8 <= len(code) <= 256 or any(c < ' ' for c in code)):
            refuse(400, 'invalid', 'Invalid callback parameters')
        redirect_uri = self.config.origin + '/v1/auth/oidc/callback'
        with self.store.transaction() as db:
            row = db.execute('SELECT * FROM oidc_states WHERE state_hash=?', (digest(state),)).fetchone()
            if row is None or row['expires'] <= now:
                refuse(400, 'invalid', 'Sign-in session expired; start again')
            db.execute('DELETE FROM oidc_states WHERE state_hash=?', (row['state_hash'],))
            provider_id, nonce, verifier_blob, session_user = row['provider'], row['nonce'], row['verifier_blob'], row['user_id']
        provider = self.oidc_registry.get(provider_id)
        if provider is None:
            refuse(404, 'not_found', 'Provider not found')
        try:
            verifier = oidc.unwrap(oidc.wrapping_key(self.store), verifier_blob)
            identity = self.oidc_registry.exchange(
                provider, code=code, verifier=verifier, redirect_uri=redirect_uri,
                nonce=nonce, now=now)
        except ValueError:
            refuse(400, 'invalid', 'Sign-in could not be verified')
        with self.store.transaction() as db:
            return self.finish_oidc(db, now, identity, session_user)

    def oidc_link(self, env, now):
        self.origin_check(env)
        if self.oidc_registry is None:
            refuse(404, 'not_found', 'Provider not found')
        with self.store.transaction() as db:
            session = None
            token_cookie = self.cookies(env).get(self.config.cookie_names[0], '')
            if re.fullmatch(r'[A-Za-z0-9_-]{43}', token_cookie):
                session = db.execute(
                    'SELECT s.*,u.username,u.password_hash FROM sessions s JOIN users u ON u.id=s.user_id '
                    'WHERE s.token_hash=? AND s.expires>?', (digest(token_cookie), now)
                ).fetchone()
            if session is not None:
                self.csrf_check(env, session)
                body = self.body(env, ['token'])
            else:
                body = self.body(env, ['token', 'username', 'password'])
            token = body.get('token')
            if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
                refuse(400, 'invalid', 'Provide a valid link token')
            db.execute('DELETE FROM oidc_link_tokens WHERE expires<=?', (now,))
            row = db.execute('SELECT * FROM oidc_link_tokens WHERE token_hash=?', (digest(token),)).fetchone()
            if row is None or row['expires'] <= now:
                refuse(400, 'invalid', 'Link token expired; start again')
            if session is not None:
                if session['user_id'] != row['user_id']:
                    refuse(403, 'forbidden', 'Sign in to the matching account to confirm')
                user_id = session['user_id']
            else:
                try:
                    username, password = self.credentials(body)
                except APIError:
                    raise
                user = db.execute('SELECT * FROM users WHERE id=?', (row['user_id'],)).fetchone()
                if user is None or user['username'] != username or not password_matches(password, user['password_hash']):
                    dummy_verify(body.get('password') if isinstance(body.get('password'), str) else 'x' * 12)
                    refuse(401, 'unauthorized', 'Invalid username or password')
                user_id = user['id']
            db.execute('DELETE FROM oidc_link_tokens WHERE token_hash=?', (row['token_hash'],))
            identity = {'provider': row['provider'], 'subject': row['subject'], 'email': row['email']}
            return self.finish_oidc(db, now, identity, user_id, confirmed=True)

    def finish_oidc(self, db, now, identity, session_user_id, confirmed=False):
        existing = db.execute(
            'SELECT * FROM user_identities WHERE provider=? AND subject=?',
            (identity['provider'], identity['subject']),
        ).fetchone()
        if existing:
            if session_user_id and existing['user_id'] != session_user_id:
                refuse(409, 'conflict', 'This login is already linked to another account')
            return self.oidc_signed_in(db, now, existing['user_id'])
        owner = db.execute('SELECT * FROM user_emails WHERE email=?', (identity['email'],)).fetchone()
        if session_user_id:
            if owner and owner['user_id'] != session_user_id:
                refuse(409, 'conflict', 'This email is already linked to another account')
            self.attach_oidc(db, session_user_id, identity, now)
            return self.oidc_signed_in(db, now, session_user_id)
        if owner and not confirmed:
            token = opaque()
            db.execute(
                'INSERT INTO oidc_link_tokens VALUES(?,?,?,?,?,?)',
                (digest(token), identity['provider'], identity['subject'], identity['email'],
                 owner['user_id'], now + oidc.LINK_TTL),
            )
            hint = identity['email'][0] + '***@' + identity['email'].split('@', 1)[1]
            return 409, {'error': {'code': 'link_required', 'message': 'Confirm linking this login to the existing account'},
                         'link': {'token': token, 'email_hint': hint}}, []
        if owner and confirmed:
            self.attach_oidc(db, owner['user_id'], identity, now)
            return self.oidc_signed_in(db, now, owner['user_id'])
        user_id = uuid4().hex
        base = oidc.username_for(identity['email'], user_id)
        username, suffix = base, 0
        while db.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone():
            suffix += 1
            username = (base[:28] + '-' + str(suffix))[:64]
        if db.execute('SELECT COUNT(*) FROM users').fetchone()[0] >= self.config.max_users:
            refuse(429, 'quota', 'Account capacity reached')
        db.execute(
            'INSERT INTO users VALUES(?,?,?,?)',
            (user_id, username, password_hash(opaque() + opaque()), now),
        )
        self.attach_oidc(db, user_id, identity, now)
        self.queue_new_account_runtime(db, user_id, username, now)
        return self.oidc_signed_in(db, now, user_id)

    def attach_oidc(self, db, user_id, identity, now):
        db.execute(
            'INSERT INTO user_identities VALUES(?,?,?,?,?)',
            (identity['provider'], identity['subject'], user_id, identity['email'], now),
        )
        if db.execute('SELECT email FROM user_emails WHERE email=?', (identity['email'],)).fetchone() is None:
            db.execute('INSERT INTO user_emails VALUES(?,?,1,?)', (user_id, identity['email'], now))

    def oidc_signed_in(self, db, now, user_id):
        user = db.execute('SELECT id, username FROM users WHERE id=?', (user_id,)).fetchone()
        headers = self.new_session(db, user['id'], now)
        headers.append(('Location', '/'))
        return 302, {'redirect': '/', 'user': {'id': user['id'], 'username': user['username']}}, headers

    def credentials(self, body):

        username, password = body.get('username'), body.get('password')
        if (not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,63}', username)
                or not isinstance(password, str) or not 12 <= len(password) <= 256):
            refuse(400, 'invalid', 'Use a 3–64 character username and a 12–256 character password')
        try:
            if len(password.encode('utf-8')) > 256:
                raise ValueError()
        except (UnicodeError, ValueError):
            refuse(400, 'invalid', 'Password exceeds the UTF-8 byte limit')
        return username.lower(), password

    def dispatch(self, env):
        if env.get('HTTP_HOST', '').lower() != urlsplit(self.config.origin).netloc:
            refuse(403, 'host', 'Unrecognized host')
        if env.get('HTTP_ORIGIN') and env['HTTP_ORIGIN'] != self.config.origin:
            refuse(403, 'origin', 'A same-origin request is required')
        method, path, query = env.get('REQUEST_METHOD'), env.get('PATH_INFO', ''), env.get('QUERY_STRING', '')
        if len(path) > 256 or len(query) > 512:
            refuse(400, 'invalid', 'Request target is too long')
        if method not in ('GET', 'POST', 'DELETE'):
            refuse(405, 'method', 'Only GET, POST and DELETE are supported')
        if method == 'POST' and query:
            refuse(400, 'invalid', 'Query parameters are not accepted for writes')
        if method == 'DELETE' and query:
            refuse(400, 'invalid', 'Query parameters are not accepted for writes')
        now = int(self.clock())
        profile_path = re.fullmatch(r'/v1/profiles/([a-z0-9._]{3,30})', path)
        if profile_path:
            if method != 'GET' or query:
                refuse(400, 'invalid', 'Invalid profile request')
            with self.store.connect() as db:
                row = profiles.load_handle(db, profile_path[1])
            if row is None:
                refuse(404, 'not_found', 'Profile not found')
            return 200, {'profile': profiles.public_view(row)}, []
        page_path = re.fullmatch(r'/p/([a-z0-9._]{3,30})', path)
        if page_path:
            if method != 'GET' or query:
                refuse(400, 'invalid', 'Invalid profile page request')
            with self.store.connect() as db:
                row = profiles.load_handle(db, page_path[1])
            if row is None:
                refuse(404, 'not_found', 'Profile not found')
            return 200, profiles.render_page(row).encode('utf-8'), [
                ('Content-Type', 'text/html; charset=utf-8'),
                ('Content-Security-Policy', profiles.PAGE_CSP),
            ]
        if path == '/v1/auth/policy':
            if method!='GET' or query:
                refuse(400,'invalid','Authentication policy requires GET without query parameters')
            return 200,{'registration_open':self.config.allow_registration,
                        'password_min_length':12,'password_max_length':256,
                        'username_min_length':3,'username_max_length':64,
                        'session_requires_https':not self.config.insecure_local},[]
        if path in ('/v1/auth/register', '/v1/auth/login') and method == 'POST':
            self.origin_check(env)  # Login/registration CSRF protection before a session exists.
            body = self.body(env, ['username', 'password'])
            username, password = self.credentials(body)
            self.rate_limit(env, username, now)  # Separate committed transaction: failures count too.
            if path.endswith('register'):
                if not self.config.allow_registration:
                    refuse(403, 'registration_closed', 'Public registration is disabled')
                hashed_password = password_hash(password)
                with self.store.transaction() as db:
                    if db.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone():
                        refuse(409, 'conflict', 'Registration is unavailable for this username')
                    if db.execute('SELECT COUNT(*) FROM users').fetchone()[0] >= self.config.max_users:
                        refuse(429, 'quota', 'Account capacity reached')
                    user_id = uuid4().hex
                    db.execute('INSERT INTO users VALUES(?,?,?,?)', (user_id, username, hashed_password, now))
                    personal_chat = self.queue_new_account_runtime(db, user_id, username, now)
                    headers = self.new_session(db, user_id, now)
                signup = {'user': {'id': user_id, 'username': username}}
                if personal_chat is not None:
                    signup['personal_chat'] = personal_chat
                return 201, signup, headers
            with self.store.connect() as db:
                user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
            if user is None:
                dummy_verify(password)
                refuse(401, 'unauthorized', 'Invalid username or password')
            if not password_matches(password, user['password_hash']):
                refuse(401, 'unauthorized', 'Invalid username or password')
            with self.store.transaction() as db:
                headers = self.new_session(db, user['id'], now)
            return 200, {'user': {'id': user['id'], 'username': user['username']}}, headers
        if path == '/v1/auth/providers' and method == 'GET' and not query:
            items = self.oidc_registry.public() if self.oidc_registry else []
            return 200, {'items': items}, []
        if path == '/v1/auth/oidc/start' and method == 'POST' and not query:
            self.origin_check(env)
            return self.oidc_start(env, now, self.body(env, ['provider']))
        if path == '/v1/auth/oidc/callback' and method == 'GET':
            return self.oidc_callback(env, now, query)
        if path == '/v1/auth/oidc/link' and method == 'POST' and not query:
            return self.oidc_link(env, now)
        if path == '/v1/composio/callback':
            # Composio redirects the browser here cross-site after sign-in.
            # SameSite=Strict cookies are absent, so nothing is changed here:
            # the page bounces to the connectors page, which re-reads status
            # with the signed-in session. Query parameters are not trusted.
            if method != 'GET':
                refuse(405, 'method', 'Only GET is supported')
            return 200, composio.CALLBACK_PAGE, [
                ('Content-Type', 'text/html; charset=utf-8'),
                ('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"),
            ]
        if path.startswith('/v1/admin/'):
            if self.operator_admin is None:
                refuse(401, 'operator_auth', 'Separate loopback operator credentials required')
            self.operator_admin.authenticate(env)
            if path == '/v1/admin/model-api' and method == 'GET' and not query:
                with self.store.connect() as db:
                    return 200, {'model_api': model_api.public_view(model_api.load_platform(db), 'platform')}, []
            if path == '/v1/admin/model-api' and method == 'POST' and not query:
                with self.store.transaction() as db:
                    return self.save_model_api(db, None, now, None, self.body(env, ['revision', 'changes']), scope='platform')
            if path == '/v1/admin/bot-social' and method == 'GET' and not query:
                with self.store.connect() as db:
                    public, source = bot_social.resolve(db)
                    return 200, {'bot_social': bot_social.public_view(bot_social.load_platform(db), 'platform'),
                                 'effective': bot_social.effective_view(public, source)}, []
            if path == '/v1/admin/bot-social' and method == 'POST' and not query:
                with self.store.transaction() as db:
                    return self.save_bot_social(db, now, None, self.body(env, ['revision', 'changes']), scope='platform')
            refuse(404, 'not_found', 'Route not found')
        if GONE_WORKSPACE_EVENTS.fullmatch(path):
            refuse(410, 'retired', 'Workspace event streams have been retired')
        if path.startswith(('/v1/agent/', '/v1/gateway/', '/v1/runtime/')) or path in GONE_PATHS or moved_api(path):
            # Execution moved to each user's DS-Bot; public pages to Bot Social. Old clients get 410.
            refuse(410, 'moved_to_dsbot', 'This route now runs on your own DS-Bot')
        runtime_path = re.fullmatch(r'/v1/workspaces/[0-9a-f]{32}/instances|/v1/instances/[0-9a-f]{32}(?:/[a-z]+)?|/v1/jobs/[0-9a-f]{32}', path)
        if self.lifecycle is not None and (runtime_path or path.startswith('/v1/internal/')):
            if path.startswith('/v1/internal/'):
                if self.manager_auth is None:
                    refuse(401, 'manager_auth', 'Manager access is not configured')
                manager = self.manager_auth.authenticate(env)
                return self.manager_dispatch(env, manager, method, path, query)
            with self.store.connect() as db:
                session = self.authenticated(db, env, now)
            if method == 'POST':
                self.csrf_check(env, session)
            return self.runtime_dispatch(env, session, method, path, query)
        if path == '/v1/auth/runtime-readiness' and method == 'GET' and query in ('', 'include=personal-chat'):
            with self.store.connect() as db:
                session = self.authenticated(db, env, now)
                owner = session['user_id']
                state = self.runtime_readiness(db, owner)
                result = {'state': state, 'user_id': owner}
                if query and state in ('starting', 'stopped', 'ready'):
                    row = personal.load(db, owner)
                    if row is not None:
                        result['personal_chat'] = {'workspace_id': row['workspace_id'], 'agent_id': row['agent_id']}
            return 200, result, []
        if path == '/v1/auth/runtime-start' and method == 'POST' and not query:
            return self.start_personal_runtime(env, now)
        if path == '/v1/auth/session' and method == 'GET' and query in ('', 'include=home'):
            with self.store.connect() as db:
                session = self.authenticated(db, env, now)
                result = {'user': {'id': session['user_id'], 'username': session['username']},
                          'expires_at': session['expires']}
                if query:
                    result['home'] = self.home_session(db, session['user_id'])
            return 200, result, []
        with self.store.transaction() as db:
            session = self.authenticated(db, env, now)
            if method in ('POST', 'DELETE'):
                self.csrf_check(env, session)
            if path == '/v1/auth/logout' and method == 'POST':
                self.body(env, [])
                db.execute('DELETE FROM sessions WHERE token_hash=?', (session['token_hash'],))
                return 200, {'logged_out': True}, self.session_headers('', '', expires=True)
            if path == '/v1/profile/avatar':
                if method == 'GET':
                    return self.profile_avatar(db, session, query)
                if method == 'POST' and not query:
                    return self.save_avatar(db, session, now, env)
                refuse(400, 'invalid', 'Invalid avatar request')
            if path == '/v1/profile':
                if method == 'GET' and not query:
                    row = profiles.load(db, session['user_id'])
                    return 200, {'profile': profiles.view(row) if row is not None else None,
                                 'avatar': profiles.avatar_view(profiles.load_avatar(db, session['user_id']))}, []
                if method == 'POST' and not query:
                    return self.save_profile(db, session, now, env)
                refuse(400, 'invalid', 'Invalid profile request')
            if path == '/v1/personal-agent':
                if method == 'GET' and not query:
                    return self.personal_agent_get(db, session)
                if method == 'POST' and not query:
                    return self.personal_agent_ensure(db, session, now)
                refuse(400, 'invalid', 'Invalid personal agent request')
            model_path = re.fullmatch(r'/v1/workspaces/([0-9a-f]{32})/model-api', path)
            if model_path:
                workspace = members.load(db, model_path[1], session['user_id'])
                if workspace is None:
                    refuse(404, 'not_found', 'Workspace not found')
                if method == 'GET' and not query:
                    override = model_api.public_view(model_api.load_workspace(db, workspace['id']), 'workspace')
                    effective, _secret, source = model_api.resolve(db, self.store, workspace_id=workspace['id'])
                    return 200, {'model_api': override, 'effective': model_api.effective_view(effective, source)}, []
                if method == 'POST' and not query:
                    role = members.role_of(db, workspace, session['user_id'])
                    if role not in ('owner', 'admin'):
                        refuse(403, 'forbidden', 'Not allowed to change model API settings')
                    return self.save_model_api(db, session['user_id'], now, workspace, self.body(env, ['revision', 'changes']))
                refuse(400, 'invalid', 'Invalid model API request')
            bot_path = re.fullmatch(r'/v1/workspaces/([0-9a-f]{32})/bot-social', path)
            if bot_path:
                workspace = members.load(db, bot_path[1], session['user_id'])
                if workspace is None:
                    refuse(404, 'not_found', 'Workspace not found')
                if method == 'GET' and not query:
                    override = bot_social.public_view(bot_social.load_workspace(db, workspace['id']), 'workspace')
                    effective, source = bot_social.resolve(db, workspace_id=workspace['id'])
                    return 200, {'bot_social': override, 'effective': bot_social.effective_view(effective, source)}, []
                if method == 'POST' and not query:
                    role = members.role_of(db, workspace, session['user_id'])
                    if role not in ('owner', 'admin'):
                        refuse(403, 'forbidden', 'Not allowed to change Bot Social settings')
                    return self.save_bot_social(db, now, workspace, self.body(env, ['revision', 'changes']))
                refuse(400, 'invalid', 'Invalid Bot Social request')
            match = re.fullmatch(r'/v1/workspaces/([0-9a-f]{32})(/instances)?', path)
            if match:
                row = members.load(db, match[1], session['user_id'])
                if row is None:
                    refuse(404, 'not_found', 'Workspace not found')
                if match[2]:
                    refuse(501, 'unsupported', 'Runtime lifecycle is not implemented in this slice')
                if method == 'GET' and not query:
                    return 200, {'workspace': teams.attach(db, row)}, []
            if path.startswith(('/v1/instances/', '/v1/internal/')):
                refuse(501, 'unsupported', 'Runtime lifecycle and manager authentication are not implemented in this slice')
        refuse(404, 'not_found', 'Route not found')

    @staticmethod
    def workspace(row):
        return {key: row[key] for key in ('id', 'owner_id', 'name', 'created')}

    def _media_upload(self, env, limit=None, mimes=None, unsupported=400):
        limit = artifacts.MAX_MEDIA_BYTES + 8192 if limit is None else limit
        if env.get('HTTP_TRANSFER_ENCODING'):
            refuse(400, 'invalid', 'Transfer encoding is not supported')
        length = env.get('CONTENT_LENGTH', '')
        if not re.fullmatch(r'[0-9]{1,8}', length):
            refuse(411, 'invalid', 'A bounded Content-Length is required')
        length = int(length)
        if length > limit:
            refuse(413, 'invalid', 'Request body is too large')
        raw = env['wsgi.input'].read(length)
        if len(raw) != length:
            refuse(400, 'invalid', 'Incomplete request body')
        parsed = artifacts.parse_multipart(env.get('CONTENT_TYPE', ''), raw)
        if not parsed or 'file' not in parsed['files']:
            refuse(400, 'invalid', 'Upload a media file')
        upload = parsed['files']['file']
        data = upload['data']
        if not data or len(data) > artifacts.MAX_MEDIA_BYTES:
            refuse(413 if data and len(data) > artifacts.MAX_MEDIA_BYTES else 400, 'invalid',
                   'Media file is missing or too large' if not data else 'Request body is too large')
        mime = artifacts.sniff_mime(data)
        allowed = artifacts.MEDIA_MIMES if mimes is None else mimes
        if mime is None or mime not in allowed:
            refuse(unsupported, 'invalid', 'Unsupported or unrecognizable media type')
        filename = artifacts.clean_filename(upload['filename'])
        title = parsed['fields'].get('title')
        return parsed['fields'], data, mime, filename, title




    def workspace_instance(self, db, workspace_id, instance_id):
        if self.lifecycle is None:
            return None
        if not isinstance(instance_id, str) or not re.fullmatch(r'[0-9a-f]{32}', instance_id):
            return None
        self.lifecycle.expire_with(db)
        row = db.execute(
            'SELECT * FROM instances WHERE id=? AND workspace_id=? AND retired_at IS NULL',
            (instance_id, workspace_id),
        ).fetchone()
        return None if row is None else self.lifecycle.snapshot(row)


    def save_profile(self, db, session, now, env):
        body = self.body(env, ['revision', 'changes'])
        revision, changes = body.get('revision'), body.get('changes')
        if (type(revision) is not int or not 0 <= revision <= 2 ** 31
                or not isinstance(changes, dict) or not changes):
            refuse(400, 'invalid', 'Provide the current revision and non-empty changes')
        normalized = profiles.normalize_changes(changes)
        if normalized is None:
            refuse(400, 'invalid', 'Invalid profile field')
        row = profiles.load(db, session['user_id'])
        if row is None:
            if revision != 0:
                refuse(409, 'conflict', 'Profile does not exist yet')
            name = normalized.get('name') or session['username']
            handle = normalized.get('handle') or profiles.default_handle(db, session['username'])
            if handle is None or profiles.load_handle(db, handle) is not None:
                refuse(409, 'conflict', 'FlyBot ID is unavailable')
            try:
                db.execute(
                    'INSERT INTO user_profiles VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)',
                    (session['user_id'], handle, handle, name[:profiles.NAME_MAX],
                     normalized.get('bio', ''), profiles.serialize_tags(normalized.get('tags', [])),
                     normalized.get('gender', ''), normalized.get('location', ''),
                     normalized.get('website', ''), profiles.serialize_goals(normalized.get('goals', {})),
                     now, now))
            except sqlite3.IntegrityError:
                refuse(409, 'conflict', 'FlyBot ID is unavailable')
            return 201, {'profile': profiles.view(profiles.load(db, session['user_id']))}, []
        if revision != row['revision']:
            raise RuntimeFault(409, 'conflict', 'Profile changed elsewhere; reload and retry',
                               profiles.view(row))
        handle = normalized.get('handle', row['handle'])
        if handle != row['handle']:
            other = profiles.load_handle(db, handle)
            if other is not None and other['user_id'] != session['user_id']:
                refuse(409, 'conflict', 'FlyBot ID is unavailable')
        name = normalized.get('name', row['name'])
        bio = normalized.get('bio', row['bio'])
        tags = profiles.serialize_tags(normalized['tags']) if 'tags' in normalized else row['tags']
        gender = normalized.get('gender', row['gender'])
        location = normalized.get('location', row['location'])
        website = normalized.get('website', row['website'])
        goals = profiles.serialize_goals(normalized['goals']) if 'goals' in normalized else row['goals']
        if (handle, name, bio, tags, gender, location, website, goals) == (
                row['handle'], row['name'], row['bio'], row['tags'], row['gender'],
                row['location'], row['website'], row['goals']):
            return 200, {'profile': profiles.view(row)}, []
        try:
            db.execute(
                'UPDATE user_profiles SET handle=?, handle_lower=?, name=?, bio=?, tags=?, '
                'gender=?, location=?, website=?, goals=?, revision=?, updated=? WHERE user_id=?',
                (handle, handle, name, bio, tags, gender, location, website, goals,
                 row['revision'] + 1, now, session['user_id']))
        except sqlite3.IntegrityError:
            refuse(409, 'conflict', 'FlyBot ID is unavailable')
        return 200, {'profile': profiles.view(profiles.load(db, session['user_id']))}, []

    def save_avatar(self, db, session, now, env):
        _fields, data, mime, filename, _title = self._media_upload(
            env, mimes=profiles.AVATAR_MIMES, unsupported=415)
        namespace = profiles.avatar_namespace(session['user_id'])
        try:
            digest_hex = artifacts.write_media(self.store.data_dir, namespace, data)
        except OSError:
            refuse(503, 'unavailable', 'Storage is temporarily unavailable')
        previous = profiles.load_avatar(db, session['user_id'])
        db.execute(
            'INSERT INTO user_avatars VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET '
            'mime=excluded.mime, byte_count=excluded.byte_count, sha256=excluded.sha256, '
            'filename=excluded.filename, updated=excluded.updated',
            (session['user_id'], mime, len(data), digest_hex, filename, now))
        if previous is not None and previous['sha256'] != digest_hex:
            still_used = db.execute(
                'SELECT COUNT(*) FROM user_avatars WHERE sha256=?', (previous['sha256'],)).fetchone()[0]
            if not still_used:
                artifacts.unlink_media(self.store.data_dir, namespace, previous['sha256'], db)
        return 200, {'avatar': profiles.avatar_view(profiles.load_avatar(db, session['user_id']))}, []

    def profile_avatar(self, db, session, query):
        if query and not re.fullmatch(r'v=[0-9a-f]{6,64}', query):
            refuse(400, 'invalid', 'Invalid avatar request')
        row = profiles.load_avatar(db, session['user_id'])
        if row is None:
            refuse(404, 'not_found', 'Avatar not set')
        namespace = profiles.avatar_namespace(session['user_id'])
        try:
            payload = artifacts.read_media_bytes(
                self.store.data_dir, namespace, row['sha256'], row['byte_count'])
        except (OSError, ValueError):
            refuse(404, 'not_found', 'Avatar not set')
        return 200, payload, [
            ('Content-Type', row['mime']),
            ('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'self'; object-src 'none'"),
            ('Cross-Origin-Resource-Policy', 'same-origin'),
            ('X-Content-Type-Options', 'nosniff'),
            ('Cache-Control', 'private, max-age=31536000, immutable'),
        ]


    def runtime_readiness(self, db, user_id):
        if not self.auto_provision.enabled:
            return 'unmanaged'
        state = owner_runtime_readiness(db, user_id, self.auto_provision.manager_id, manager_auth=self.manager_auth)
        if state != 'setup':
            return state
        if runtime_autoprovision.at_capacity(db, self.auto_provision):
            return 'capacity'
        personal_agent = personal.load(db, user_id)
        try:
            self.lifecycle.check_create_capacity(db, personal_agent['workspace_id'] if personal_agent is not None else None)
        except RuntimeFault as error:
            if error.status == 429:
                return 'capacity'
            raise
        return state

    def start_personal_runtime(self, env, now):
        with self.store.connect() as db:
            # Use one snapshot for readiness and the resumable revision. The
            # lifecycle write checks that revision after this connection closes.
            db.execute('BEGIN')
            session = self.authenticated(db, env, now)
            self.csrf_check(env, session)
            self.body(env, [])
            owner = session['user_id']
            state = self.runtime_readiness(db, owner)
            if state in ('starting', 'ready'):
                return 200, {'state': state}, []
            if state == 'parked':
                refuse(409, runtime_autoprovision.PARKED, runtime_autoprovision.PARKED_MESSAGE)
            if state != 'stopped':
                refuse(409, 'runtime_unavailable', 'The personal runtime cannot be started here')
            instance = runtime_autoprovision.resumable_instance(
                db, owner, self.auto_provision.manager_id, manager_auth=self.manager_auth,
            )
        if instance is None:
            refuse(409, 'runtime_unavailable', 'The personal runtime changed; check its current state')
        started, _ = self.lifecycle.start(owner, instance['id'], expected_revision=instance['revision'])
        with self.store.connect() as db:
            db.execute('BEGIN')
            state = self.runtime_readiness(db, owner)
        return (202 if started else 200), {'state': state}, []

    def personal_agent_get(self, db, session):
        row = personal.load(db, session['user_id'])
        if row is None:
            return 200, {'personal_agent': None}, []
        return 200, self.personal_payload(db, session, row), []

    def home_session(self, db, user_id):
        state = self.runtime_readiness(db, user_id)
        card = None
        if state in ('ready', 'unmanaged'):
            row = db.execute('''
                SELECT w.id AS workspace_id, w.name AS workspace_name,
                       a.id AS agent_id, a.name AS agent_name, a.summary AS agent_summary
                FROM personal_agents p
                JOIN workspaces w ON w.id=p.workspace_id AND w.owner_id=p.user_id
                JOIN workspace_agents a ON a.id=p.agent_id AND a.workspace_id=w.id
                WHERE p.user_id=?
            ''', (user_id,)).fetchone()
            if row is not None:
                card = {'workspace': {'id': row['workspace_id'], 'name': row['workspace_name'], 'kind': 'personal'},
                        'agent': {'id': row['agent_id'], 'name': row['agent_name'], 'summary': row['agent_summary']},
                        'look': onboarding.load_look(db, user_id)}
        return {'runtime_state': state, 'personal_agent': card}

    def personal_agent_ensure(self, db, session, now):
        try:
            row, created = self.ensure_personal_agent(db, session['user_id'], session['username'], now)
        except personal.WorkspaceCapacity:
            refuse(429, 'quota', 'Workspace capacity reached')
        payload = self.personal_payload(db, session, row)
        if self.auto_provision.enabled:
            provision = self.ensure_personal_runtime(db, session['user_id'], row, now)
            payload['personal_agent']['runtime_provisioning'] = {
                'state': provision['state'], 'instance_id': provision['instance_id'],
                'readiness': self.runtime_readiness(db, session['user_id']),
                'error_code': runtime_autoprovision.chat_error(
                    db, lambda iid: self.workspace_instance(db, row['workspace_id'], iid), provision)}
        return (201 if created else 200), payload, []

    def ensure_personal_agent(self, db, user_id, username, now):
        return personal.ensure(db, {'id': user_id, 'username': username},
                               self.config.max_workspaces_per_user, self.config.max_workspaces,
                               self.config.max_agents_per_workspace, now)

    def queue_new_account_runtime(self, db, user_id, username, now):
        if not self.auto_provision.enabled or self.lifecycle.policy.backend_mode != 'compose':
            return
        try:
            row, _ = self.ensure_personal_agent(db, user_id, username, now)
        except personal.WorkspaceCapacity:
            # Signup can succeed even if the personal workspace must be retried.
            return
        provision = self.ensure_personal_runtime(db, user_id, row, now)
        if provision['instance_id']:
            return {'workspace_id': row['workspace_id'], 'agent_id': row['agent_id']}

    def ensure_personal_runtime(self, db, user_id, row, now):
        """Server-derived: the caller's own personal workspace and agent only."""
        return runtime_autoprovision.ensure(db, self.lifecycle, self.auto_provision, user_id,
                                            row['workspace_id'], row['agent_id'], now)


    def personal_payload(self, db, session, row):
        workspace = db.execute('SELECT * FROM workspaces WHERE id=?', (row['workspace_id'],)).fetchone()
        agent = agents.load(db, row['workspace_id'], row['agent_id'])
        return {
            'personal_agent': {
                'workspace': {'id': workspace['id'], 'name': workspace['name'], 'kind': 'personal'},
                'agent': agents.snapshot(db, agent) if agent is not None else None,
                'look': onboarding.load_look(db, session['user_id']),
            },
            'builtin_agents': [
                {'key': item['builtin_key'], 'agent': agents.snapshot(db, item)}
                for item in personal.builtins(db, row['workspace_id'])
            ],
        }

    def save_model_api(self, db, user_id, now, workspace, body, scope=None):
        revision, changes = body.get('revision'), body.get('changes')
        if type(revision) is not int or not 0 <= revision <= 2 ** 31 or not isinstance(changes, dict) or not changes:
            refuse(400, 'invalid', 'Provide the current revision and a non-empty changes object')
        allowed = {'provider', 'base_url', 'model', 'api_key'}
        if set(changes) - allowed:
            refuse(400, 'invalid', 'Unknown model API field')
        scope = scope or ('workspace' if workspace else 'account')
        if scope == 'platform':
            row = model_api.load_platform(db)
        elif scope == 'workspace':
            row = model_api.load_workspace(db, workspace['id'])
        else:
            row = model_api.load_account(db, user_id)
        current = model_api.public_view(row, scope)
        if revision != current['revision']:
            raise RuntimeFault(409, 'conflict', 'Model API settings changed elsewhere; reload and retry', current)
        provider = changes['provider'] if 'provider' in changes else current['provider']
        base_url = changes['base_url'] if 'base_url' in changes else current['base_url']
        model_name = changes['model'] if 'model' in changes else current['model']
        clearing = 'api_key' in changes and changes['api_key'] is None
        replacing = 'api_key' in changes and changes['api_key'] is not None
        if replacing and not model_api.valid_api_key(changes['api_key']):
            refuse(400, 'invalid', 'API key must be 8–4096 characters')
        # An operator policy removal must not prevent revoking a stored key.
        # Mixed metadata updates still receive normal validation.
        if not (clearing and set(changes) == {'api_key'}):
            if not model_api.valid_provider(provider) or not model_api.valid_base_url(base_url, self.model_http_policy) or not model_api.valid_model(model_name):
                refuse(400, 'invalid', 'Provide a supported provider, authorized model base URL and model name')
        if not clearing and self.model_http_policy.allows(base_url) and provider not in ('openai', 'custom'):
            refuse(400, 'invalid', 'HTTP model exceptions require an OpenAI-compatible task provider')
        if not replacing and not clearing:
            if (provider, base_url, model_name) == (current['provider'], current['base_url'], current['model']) and row is not None:
                return 200, {'model_api': current}, []
        if row is None and clearing and not replacing and provider is None:
            return 200, {'model_api': current}, []
        key_blob = None if clearing else (row['key_blob'] if row and not replacing else None)
        if replacing:
            key_blob = model_api.wrap(model_api.wrapping_key(self.store), changes['api_key'])
        if key_blob is None and not clearing and row is not None:
            key_blob = row['key_blob']
        identity = row['id'] if row else uuid4().hex
        if row is None:
            if scope == 'platform':
                db.execute(
                    'INSERT INTO model_api_configs VALUES(?,?,NULL,NULL,?,?,?,?,?,?)',
                    (identity, scope, provider, base_url, model_name, key_blob, 1, now),
                )
            elif scope == 'workspace':
                db.execute(
                    'INSERT INTO model_api_configs VALUES(?,?,NULL,?,?,?,?,?,?,?)',
                    (identity, scope, workspace['id'], provider, base_url, model_name, key_blob, 1, now),
                )
            else:
                db.execute(
                    'INSERT INTO model_api_configs VALUES(?,?,?,NULL,?,?,?,?,?,?)',
                    (identity, scope, user_id, provider, base_url, model_name, key_blob, 1, now),
                )
        else:
            db.execute(
                'UPDATE model_api_configs SET provider=?, base_url=?, model=?, key_blob=?, revision=?, updated=? WHERE id=?',
                (provider, base_url, model_name, key_blob, current['revision'] + 1, now, row['id']),
            )
        if scope == 'platform':
            stored = model_api.load_platform(db)
        elif scope == 'workspace':
            stored = model_api.load_workspace(db, workspace['id'])
        else:
            stored = model_api.load_account(db, user_id)
        return 200, {'model_api': model_api.public_view(stored, scope)}, []

    def save_bot_social(self, db, now, workspace, body, scope=None):
        revision, changes = body.get('revision'), body.get('changes')
        if type(revision) is not int or not 0 <= revision <= 2 ** 31 or not isinstance(changes, dict) or not changes:
            refuse(400, 'invalid', 'Provide the current revision and a non-empty changes object')
        if 'token' in changes or 'api_key' in changes or 'connector' in changes:
            refuse(400, 'invalid', 'Connector tokens are not stored in management')
        if set(changes) - {'server', 'displayName'}:
            refuse(400, 'invalid', 'Unknown Bot Social field')
        scope = scope or 'workspace'
        if scope == 'platform':
            row = bot_social.load_platform(db)
        else:
            row = bot_social.load_workspace(db, workspace['id'])
        current = bot_social.public_view(row, scope)
        if revision != current['revision']:
            raise RuntimeFault(409, 'conflict', 'Bot Social settings changed elsewhere; reload and retry', current)
        clearing = 'server' in changes and changes['server'] in (None, '')
        try:
            server = bot_social.parse_server_url(current['server'] if 'server' not in changes else changes['server'])
            display = current['displayName'] if 'displayName' not in changes else bot_social.flatten_name(changes['displayName'])
        except bot_social.BotSocialConfigError as error:
            refuse(400, 'invalid', str(error))
        if clearing:
            server = None
            if row is None:
                return 200, {'bot_social': current}, []
            db.execute('DELETE FROM bot_social_configs WHERE id=?', (row['id'],))
            stored = bot_social.load_platform(db) if scope == 'platform' else bot_social.load_workspace(db, workspace['id'])
            return 200, {'bot_social': bot_social.public_view(stored, scope)}, []
        if server is None:
            refuse(400, 'invalid', 'Provide a Bot Social server address')
        if server == current['server'] and display == current['displayName'] and row is not None:
            return 200, {'bot_social': current}, []
        identity = row['id'] if row else uuid4().hex
        if row is None:
            if scope == 'platform':
                db.execute(
                    'INSERT INTO bot_social_configs(id,scope,workspace_id,server,display_name,revision,updated) VALUES(?,?,NULL,?,?,1,?)',
                    (identity, scope, server, display, now),
                )
            else:
                db.execute(
                    'INSERT INTO bot_social_configs(id,scope,workspace_id,server,display_name,revision,updated) VALUES(?,?,?,?,?,1,?)',
                    (identity, scope, workspace['id'], server, display, now),
                )
        else:
            db.execute(
                'UPDATE bot_social_configs SET server=?, display_name=?, revision=?, updated=? WHERE id=?',
                (server, display, current['revision'] + 1, now, row['id']),
            )
        stored = bot_social.load_platform(db) if scope == 'platform' else bot_social.load_workspace(db, workspace['id'])
        return 200, {'bot_social': bot_social.public_view(stored, scope)}, []

    def with_model_api(self, payload):
        def attach(db, instance):
            workspace_id = self.lifecycle.runtime_model_workspace(db, instance)
            public, _key, source = model_api.resolve(db, self.store, workspace_id=workspace_id)
            return {**instance, 'model_api': model_api.effective_view(public, source)}

        with self.store.connect() as db:
            if 'instance' in payload:
                return {**payload, 'instance': attach(db, payload['instance'])}
            return {**payload, 'items': [attach(db, instance) for instance in payload['items']]}

    @staticmethod
    def pagination(query, allowed=()):

        try:
            args = parse_qs(query, keep_blank_values=True, strict_parsing=True,
                                max_num_fields=2 + len(allowed)) if query else {}
            if set(args) - {'limit', 'cursor', *allowed} or any(len(v) != 1 for v in args.values()):
                raise ValueError()
            limit, cursor = args.get('limit', ['20'])[0], args.get('cursor', [''])[0]
            if not re.fullmatch(r'[0-9]{1,3}', limit) or not 1 <= int(limit) <= 100 or (cursor and not re.fullmatch(r'[0-9a-f]{32}', cursor)):
                raise ValueError()
            return int(limit), cursor, args
        except ValueError:
            refuse(400, 'invalid', 'Invalid pagination parameters')

    def create_account_instance(self, owner, username, workspace_id, key):
        if not valid_key(key):
            refuse(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
        runtime = self.lifecycle
        now = int(self.clock())
        with self.store.transaction() as db:
            runtime.workspace(db, owner, workspace_id, write=True)
            existing = runtime_autoprovision.owned_instance(db, owner)
            if existing is not None:
                return False, runtime.result(db, existing)
            try:
                personal_row, _ = self.ensure_personal_agent(db, owner, username, now)
            except personal.WorkspaceCapacity:
                refuse(429, 'quota', 'Workspace capacity reached')
            provision = self.ensure_personal_runtime(db, owner, personal_row, now)
            if provision['state'] == 'capacity':
                refuse(429, 'quota', 'Instance capacity reached')
            if provision['instance_id'] is None:
                refuse(409, 'runtime_unavailable', 'The account runtime could not be provisioned')
            return provision['state'] == 'provisioned', runtime.result(db, provision['instance_id'])

    def runtime_dispatch(self, env, session, method, path, query):
        runtime = self.lifecycle
        owner = session['user_id']
        match = re.fullmatch(r'/v1/workspaces/([0-9a-f]{32})/instances', path)
        if match:
            if method == 'POST':
                self.body(env, [])
                key = env.get('HTTP_IDEMPOTENCY_KEY', '')
                if self.auto_provision.enabled and runtime.policy.backend_mode == 'compose':
                    created, result = self.create_account_instance(owner, session['username'], match[1], key)
                else:
                    created, result = runtime.create(owner, match[1], key, per_user=self.auto_provision.enabled)
                return 201 if created else 200, self.with_model_api(result), []
            limit, cursor, _ = self.pagination(query)
            listed = runtime.listing(owner, match[1], limit, cursor)
            return 200, self.with_model_api(listed), []
        match = re.fullmatch(r'/v1/jobs/([0-9a-f]{32})', path)
        if match and method == 'GET' and not query:
            return 200, {'job': runtime.get_job(owner, match[1])}, []
        match = re.fullmatch(r'/v1/instances/([0-9a-f]{32})(?:/([a-z]+))?', path)
        if match:
            iid, action = match.groups()
            # Authorization precedes even unsupported operation disclosure.
            instance = runtime.inspect(owner, iid)
            if method == 'GET' and action is None and not query:
                return 200, self.with_model_api({'instance': instance}), []
            if method == 'POST' and action in UNSUPPORTED:
                self.body(env, [])
                refuse(501, 'unsupported', 'This runtime operation is not implemented')
            if method == 'POST' and action in ('start', 'stop', 'restart'):
                body = self.body(env, ['expected_revision', 'operation_id'] if action == 'restart' else ['expected_revision'])
                changed, result = getattr(runtime, action)(owner, iid, **body)
                return 202 if changed else 200, self.with_model_api(result), []
            if method == 'GET' and action == 'logs':
                try:
                    args = parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=1) if query else {}
                    if set(args) - {'tail'} or any(len(v) != 1 for v in args.values()):
                        raise ValueError()
                    tail = args.get('tail', ['100'])[0]
                    if not re.fullmatch(r'[0-9]{1,3}', tail):
                        raise ValueError()
                except ValueError:
                    refuse(400, 'invalid', 'Invalid log options')
                return 200, runtime.logs(owner, iid, int(tail)), []
        refuse(404, 'not_found', 'Route not found')

    def manager_dispatch(self, env, manager, method, path, query):
        runtime = self.lifecycle
        if path == '/v1/internal/instances' and method == 'GET':
            limit, cursor, args = self.pagination(query, ('desired',))
            desired = args.get('desired', [None])[0]
            if desired not in (None, 'running', 'stopped'):
                refuse(400, 'invalid', 'Invalid desired filter')
            return 200, runtime.manager_list(manager, desired, limit, cursor), []
        if path == '/v1/internal/jobs/claim' and method == 'POST':
            body = self.body(env, ['instance_id'])
            iid = body.get('instance_id')
            if not isinstance(iid, str) or not re.fullmatch(r'[0-9a-f]{32}', iid):
                refuse(400, 'invalid', 'Invalid instance_id')
            return 200, {'claim': runtime.claim(manager, iid)}, []
        recovery = re.fullmatch(r'/v1/internal/instances/([0-9a-f]{32})/recover', path)
        if recovery and method == 'POST' and not query:
            body = self.body(env, ['expected_revision', 'operation_id', 'confirmation'])
            if set(body) != {'expected_revision', 'operation_id', 'confirmation'}:
                refuse(400, 'invalid', 'Recovery confirmation, revision and operation key required')
            return 200, runtime.recover(manager, recovery[1], **body), []
        secret = re.fullmatch(r'/v1/internal/instances/([0-9a-f]{32})/runtime-secret', path)
        if secret and method == 'POST' and not query:
            body = self.body(env, ['job_id', 'observed_revision', 'lease'])
            if set(body) != {'job_id', 'observed_revision', 'lease'} or not isinstance(body['job_id'], str) or not re.fullmatch(r'[0-9a-f]{32}', body['job_id']):
                refuse(400, 'invalid', 'Incomplete or invalid manager observation')
            from .model_http_policy import WSGI_HEADER
            return 200, runtime.runtime_secret(
                manager, secret[1], body['job_id'], body['observed_revision'], body['lease'],
                http_policy=self.model_http_policy, capability=env.get(WSGI_HEADER)), []
        collaboration = re.fullmatch(r'/v1/internal/instances/([0-9a-f]{32})/runtime-bot-social', path)
        if collaboration and method == 'POST' and not query:
            body = self.body(env, ['job_id', 'observed_revision', 'lease'])
            if set(body) != {'job_id', 'observed_revision', 'lease'} or not isinstance(body['job_id'], str) or not re.fullmatch(r'[0-9a-f]{32}', body['job_id']):
                refuse(400, 'invalid', 'Incomplete or invalid manager observation')
            return 200, runtime.runtime_bot_social(manager, collaboration[1], body['job_id'], body['observed_revision'], body['lease']), []
        bootstrap = re.fullmatch(r'/v1/internal/instances/([0-9a-f]{32})/runtime-agent-bootstrap', path)
        if bootstrap and method == 'POST' and not query:
            body = self.body(env, ['job_id', 'observed_revision', 'lease'])
            if set(body) != {'job_id', 'observed_revision', 'lease'} or not isinstance(body['job_id'], str) or not re.fullmatch(r'[0-9a-f]{32}', body['job_id']):
                refuse(400, 'invalid', 'Incomplete or invalid manager observation')
            return 200, runtime.runtime_agent_bootstrap(
                manager, bootstrap[1], body['job_id'], body['observed_revision'], body['lease']), []
        match = re.fullmatch(r'/v1/internal/instances/([0-9a-f]{32})/(observe|heartbeat)', path)
        if match and method == 'POST':
            allowed = ['job_id', 'observed_revision', 'lease']
            if match[2] == 'observe':
                allowed += ['observed', 'process_ref', 'error_code']
            body = self.body(env, allowed)
            required = {'job_id', 'observed_revision', 'lease'} | ({'observed'} if match[2] == 'observe' else set())
            if not required <= body.keys() or not isinstance(body['job_id'], str) or not re.fullmatch(r'[0-9a-f]{32}', body['job_id']):
                refuse(400, 'invalid', 'Incomplete or invalid manager observation')
            body['jid'], body['revision'] = body.pop('job_id'), body.pop('observed_revision')
            handler = runtime.observe if match[2] == 'observe' else runtime.heartbeat
            return 200, handler(manager, match[1], **body), []
        refuse(404, 'not_found', 'Route not found')


