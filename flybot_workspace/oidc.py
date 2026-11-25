"""Third-party login: Google, GitHub and generic OIDC.

Authorization Code + PKCE, state and nonce checks, verified-email only.
Operator-configured client secrets stay in a private file, never in the
repository, JSON responses or logs. Disabled providers are omitted.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
from dataclasses import dataclass
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

from .security import digest, opaque, password_hash

SCHEMA = '''
CREATE TABLE IF NOT EXISTS user_identities (
 provider TEXT NOT NULL,
 subject TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 email TEXT NOT NULL,
 created INTEGER NOT NULL,
 PRIMARY KEY (provider, subject));
CREATE INDEX IF NOT EXISTS user_identity_email ON user_identities(email, user_id);
CREATE TABLE IF NOT EXISTS user_emails (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 email TEXT NOT NULL UNIQUE,
 verified INTEGER NOT NULL CHECK(verified=1),
 created INTEGER NOT NULL,
 PRIMARY KEY (user_id, email));
CREATE TABLE IF NOT EXISTS oidc_states (
 state_hash TEXT PRIMARY KEY,
 provider TEXT NOT NULL,
 nonce TEXT NOT NULL,
 verifier_blob TEXT NOT NULL,
 user_id TEXT REFERENCES users(id),
 created INTEGER NOT NULL,
 expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oidc_link_tokens (
 token_hash TEXT PRIMARY KEY,
 provider TEXT NOT NULL,
 subject TEXT NOT NULL,
 email TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 expires INTEGER NOT NULL);
'''

EMAIL = re.compile(r'[a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9][a-z0-9.\-]{0,190}\.[a-z]{2,24}')
PROVIDER_ID = re.compile(r'[a-z][a-z0-9_-]{0,31}')
WRAP_NAME = 'oidc.wrap'
DIGESTINFO_SHA256 = bytes.fromhex('3031300d060960864801650304020105000420')
STATE_TTL = 600
LINK_TTL = 600
MAX_STATES = 1000

GOOGLE = {
    'type': 'google',
    'label': 'Google',
    'issuer': 'https://accounts.google.com',
    'authorization_endpoint': 'https://accounts.google.com/o/oauth2/v2/auth',
    'token_endpoint': 'https://oauth2.googleapis.com/token',
    'jwks_uri': 'https://www.googleapis.com/oauth2/v3/certs',
    'scopes': 'openid email profile',
}
GITHUB = {
    'type': 'github',
    'label': 'GitHub',
    'issuer': 'https://github.com',
    'authorization_endpoint': 'https://github.com/login/oauth/authorize',
    'token_endpoint': 'https://github.com/login/oauth/access_token',
    'user_endpoint': 'https://api.github.com/user',
    'emails_endpoint': 'https://api.github.com/user/emails',
    'scopes': 'read:user user:email',
}


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def b64url_decode(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+=*', value) or len(value) > 8192:
        raise ValueError('invalid base64url')
    pad = '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + pad)


def pkce_pair():
    verifier = opaque()
    challenge = b64url(hashlib.sha256(verifier.encode('ascii')).digest())
    return verifier, challenge


def valid_email(value):
    return isinstance(value, str) and 3 <= len(value) <= 254 and EMAIL.fullmatch(value) is not None


def username_for(email, user_id):
    local = email.split('@', 1)[0]
    cleaned = re.sub(r'[^a-z0-9_.-]', '', local.lower())
    if re.fullmatch(r'[a-z0-9][a-z0-9_.-]{2,31}', cleaned):
        return cleaned
    return 'u' + user_id[:15]


def wrapping_key(store):
    path = store.path.parent / WRAP_NAME
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('OIDC wrapping key must be a private regular file')
        key = os.read(fd, 64)
        if len(key) == 0:
            key = secrets.token_bytes(32)
            os.write(fd, key)
        elif len(key) != 32:
            raise ValueError('OIDC wrapping key is the wrong size')
        return key
    finally:
        os.close(fd)


def _keystream(key, nonce, length):
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hmac.new(key, nonce + counter.to_bytes(8, 'big'), hashlib.sha256).digest())
        counter += 1
    return bytes(out[:length])


def wrap(key, plaintext):
    data = plaintext.encode('utf-8')
    nonce = secrets.token_bytes(16)
    cipher = bytes(a ^ b for a, b in zip(data, _keystream(key, nonce, len(data))))
    tag = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    return (nonce + cipher + tag).hex()


def unwrap(key, blob):
    try:
        raw = bytes.fromhex(blob)
    except (ValueError, TypeError):
        raise ValueError('corrupt OIDC state') from None
    if len(raw) < 48:
        raise ValueError('corrupt OIDC state')
    nonce, cipher, tag = raw[:16], raw[16:-32], raw[-32:]
    expected = hmac.new(key, nonce + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, tag):
        raise ValueError('corrupt OIDC state')
    return bytes(a ^ b for a, b in zip(cipher, _keystream(key, nonce, len(cipher)))).decode('utf-8')


def rsa_verify(n, e, signature, signed):
    k = (n.bit_length() + 7) // 8
    if n.bit_length() < 2048 or len(signature) != k:
        return False
    integer = int.from_bytes(signature, 'big')
    if integer >= n:
        return False
    em = pow(integer, e, n).to_bytes(k, 'big')
    digest = hashlib.sha256(signed).digest()
    di = DIGESTINFO_SHA256 + digest
    if k < len(di) + 11:
        return False
    expected = b'\x00\x01' + b'\xff' * (k - len(di) - 3) + b'\x00' + di
    return hmac.compare_digest(em, expected)


def rsa_sign(n, d, signed):
    k = (n.bit_length() + 7) // 8
    di = DIGESTINFO_SHA256 + hashlib.sha256(signed).digest()
    em = b'\x00\x01' + b'\xff' * (k - len(di) - 3) + b'\x00' + di
    return pow(int.from_bytes(em, 'big'), d, n).to_bytes(k, 'big')


def jwt_claims(token, *, audience, issuer, nonce, keys, now):
    try:
        header_b, payload_b, signature_b = token.split('.')
        header = json.loads(b64url_decode(header_b))
        payload = json.loads(b64url_decode(payload_b))
        signature = b64url_decode(signature_b)
    except (ValueError, TypeError, json.JSONDecodeError):
        raise ValueError('invalid id_token')
    if header.get('alg') != 'RS256' or not isinstance(header.get('kid'), str):
        raise ValueError('unsupported id_token')
    key = keys.get(header['kid'])
    if key is None or not rsa_verify(key[0], key[1], signature, f'{header_b}.{payload_b}'.encode('ascii')):
        raise ValueError('id_token signature failed')
    if payload.get('iss') != issuer or payload.get('aud') != audience:
        raise ValueError('id_token audience failed')
    if payload.get('nonce') != nonce:
        raise ValueError('id_token nonce failed')
    exp, iat = payload.get('exp'), payload.get('iat')
    if type(exp) is not int or type(iat) is not int or not iat <= now < exp:
        raise ValueError('id_token expired')
    return payload


def jwk_rsa(jwk):
    if not isinstance(jwk, dict) or jwk.get('kty') != 'RSA':
        return None
    try:
        n = int.from_bytes(b64url_decode(jwk['n']), 'big')
        e = int.from_bytes(b64url_decode(jwk['e']), 'big')
    except (KeyError, ValueError, TypeError):
        return None
    if n.bit_length() < 2048 or e < 3:
        return None
    return n, e


def parse_jwks(document):
    if not isinstance(document, dict) or not isinstance(document.get('keys'), list) or len(document['keys']) > 32:
        raise ValueError('invalid JWKS')
    keys = {}
    for item in document['keys']:
        if not isinstance(item, dict) or not isinstance(item.get('kid'), str):
            continue
        parsed = jwk_rsa(item)
        if parsed:
            keys[item['kid']] = parsed
    if not keys:
        raise ValueError('invalid JWKS')
    return keys


@dataclass(frozen=True)
class Provider:
    id: str
    type: str
    label: str
    client_id: str
    client_secret: str
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    jwks_uri: str = ''
    user_endpoint: str = ''
    emails_endpoint: str = ''
    scopes: str = 'openid email profile'
    enabled: bool = True

    def public(self):
        return {'id': self.id, 'type': self.type, 'label': self.label}


def _https_url(value, *, allow_loopback=False):
    if not isinstance(value, str) or not 8 <= len(value) <= 512:
        return False
    try:
        parts = urlsplit(value, allow_fragments=False)
    except ValueError:
        return False
    if parts.username or parts.password or parts.query or parts.fragment or not parts.hostname:
        return False
    if parts.scheme == 'https':
        return True
    return allow_loopback and parts.scheme == 'http' and parts.hostname in ('127.0.0.1', 'localhost', 'oidc.test')


def _merge_builtin(entry):
    kind = entry.get('type')
    base = {'google': dict(GOOGLE), 'github': dict(GITHUB)}.get(kind, {'type': 'oidc', 'label': entry.get('label') or entry.get('id')})
    merged = dict(base)
    merged.update({key: entry[key] for key in entry if key != 'client_secret'})
    merged['client_secret'] = entry['client_secret']
    merged['type'] = kind if kind in ('google', 'github', 'oidc') else merged.get('type', 'oidc')
    return merged


class OidcRegistry:
    def __init__(self, providers, transport=None):
        if len(providers) > 16 or len({item.id for item in providers}) != len(providers):
            raise ValueError('Invalid OIDC registry')
        self.providers = {item.id: item for item in providers if item.enabled}
        self.transport = transport

    def public(self):
        return [item.public() for item in self.providers.values()]

    def get(self, provider_id):
        return self.providers.get(provider_id)

    def authorization_url(self, provider, *, state, nonce, challenge, redirect_uri):
        params = {
            'client_id': provider.client_id,
            'redirect_uri': redirect_uri,
            'response_type': 'code',
            'scope': provider.scopes,
            'state': state,
            'code_challenge': challenge,
            'code_challenge_method': 'S256',
        }
        if provider.type != 'github':
            params['nonce'] = nonce
        return provider.authorization_endpoint + '?' + urlencode(params)

    def exchange(self, provider, *, code, verifier, redirect_uri, nonce, now):
        body = urlencode({
            'grant_type': 'authorization_code',
            'code': code,
            'redirect_uri': redirect_uri,
            'client_id': provider.client_id,
            'client_secret': provider.client_secret,
            'code_verifier': verifier,
        }).encode('ascii')
        headers = {'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'}
        payload = self._json('POST', provider.token_endpoint, headers, body)
        if provider.type == 'github':
            return self._github_identity(provider, payload)
        token = payload.get('id_token')
        if not isinstance(token, str) or len(token) > 8192:
            raise ValueError('missing id_token')
        keys = parse_jwks(self._json('GET', provider.jwks_uri, {'Accept': 'application/json'}, None))
        claims = jwt_claims(token, audience=provider.client_id, issuer=provider.issuer, nonce=nonce, keys=keys, now=now)
        email = claims.get('email')
        if claims.get('email_verified') is not True or not valid_email(str(email).lower() if isinstance(email, str) else ''):
            raise ValueError('verified email required')
        subject = claims.get('sub')
        if not isinstance(subject, str) or not 1 <= len(subject) <= 256:
            raise ValueError('invalid subject')
        return {'provider': provider.id, 'subject': subject, 'email': email.lower()}

    def _github_identity(self, provider, payload):
        token = payload.get('access_token')
        if not isinstance(token, str) or not 8 <= len(token) <= 256:
            raise ValueError('missing access_token')
        headers = {'Accept': 'application/json', 'Authorization': 'Bearer ' + token, 'User-Agent': 'FlyBot'}
        profile = self._json('GET', provider.user_endpoint, headers, None)
        subject = profile.get('id')
        subject = str(subject) if isinstance(subject, int) and subject > 0 else subject
        if not isinstance(subject, str) or not 1 <= len(subject) <= 256:
            raise ValueError('invalid subject')
        emails = self._json('GET', provider.emails_endpoint, headers, None)
        if not isinstance(emails, list) or len(emails) > 50:
            raise ValueError('verified email required')
        chosen = None
        for item in emails:
            if not isinstance(item, dict):
                continue
            address = item.get('email')
            if item.get('verified') is True and item.get('primary') is True and valid_email(str(address).lower() if isinstance(address, str) else ''):
                chosen = address.lower()
                break
        if chosen is None:
            raise ValueError('verified email required')
        return {'provider': provider.id, 'subject': subject, 'email': chosen}

    def _json(self, method, url, headers, body):
        transport = self.transport or default_transport
        status, _headers, data = transport(method, url, headers, body)
        if status != 200:
            raise ValueError('provider request failed')
        try:
            payload = json.loads(data.decode('utf-8'))
        except (UnicodeError, json.JSONDecodeError, AttributeError):
            raise ValueError('provider request failed') from None
        return payload


def load_oidc_providers(path, transport=None):
    path = __import__('pathlib').Path(path).absolute()
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError('OIDC provider path must not use symbolic links')
    parent = path.parent.stat()
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('OIDC provider directory must be private')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 65536:
            raise ValueError('OIDC provider file must be private and bounded')
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('OIDC provider file exceeds bound')
    from .app import object_only
    data = json.loads(raw, object_pairs_hook=object_only)
    if not isinstance(data, dict) or not isinstance(data.get('providers'), list) or len(data['providers']) > 16:
        raise ValueError('Invalid OIDC registry')
    allow_loopback = False
    providers = []
    for entry in data['providers']:
        if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or not PROVIDER_ID.fullmatch(entry['id']):
            raise ValueError('Invalid OIDC provider id')
        if entry.get('enabled') is False:
            continue
        if not isinstance(entry.get('client_id'), str) or not 1 <= len(entry['client_id']) <= 256:
            raise ValueError('Invalid OIDC client_id')
        if not isinstance(entry.get('client_secret'), str) or not 8 <= len(entry['client_secret']) <= 256:
            raise ValueError('Invalid OIDC client_secret')
        merged = _merge_builtin(entry)
        allow_loopback = urlsplit(merged.get('authorization_endpoint', '')).hostname in ('127.0.0.1', 'localhost', 'oidc.test')
        for field in ('authorization_endpoint', 'token_endpoint'):
            if not _https_url(merged.get(field, ''), allow_loopback=allow_loopback):
                raise ValueError('Invalid OIDC endpoint')
        if merged['type'] != 'github' and (not _https_url(merged.get('issuer', ''), allow_loopback=allow_loopback)
                                           or not _https_url(merged.get('jwks_uri', ''), allow_loopback=allow_loopback)):
            raise ValueError('Invalid OIDC issuer')
        providers.append(Provider(
            id=merged['id'], type=merged['type'], label=str(merged.get('label') or merged['id'])[:40],
            client_id=merged['client_id'], client_secret=merged['client_secret'],
            issuer=merged.get('issuer', ''), authorization_endpoint=merged['authorization_endpoint'],
            token_endpoint=merged['token_endpoint'], jwks_uri=merged.get('jwks_uri', ''),
            user_endpoint=merged.get('user_endpoint', ''), emails_endpoint=merged.get('emails_endpoint', ''),
            scopes=str(merged.get('scopes') or 'openid email profile')[:200], enabled=True,
        ))
    return OidcRegistry(providers, transport=transport)


def default_transport(method, url, headers, body):
    """HTTPS-only token/JWKS fetch for production. Timeouts and response size are bounded."""
    import ssl
    from urllib.request import Request, urlopen
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.username or parts.password:
        raise ValueError('provider request failed')
    request = Request(url, data=body, method=method, headers=headers or {})
    context = ssl.create_default_context()
    with urlopen(request, timeout=5, context=context) as response:
        data = response.read(65537)
        if len(data) > 65536:
            raise ValueError('provider request failed')
        return response.status, dict(response.headers.items()), data
