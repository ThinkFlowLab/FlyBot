"""In-process OIDC/OAuth provider for tests. No network and no real vendor credentials."""
import json
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from .oidc import b64url, parse_jwks, rsa_sign


class FakeOidcProvider:
    def __init__(self, modulus, exponent, private, *, issuer='https://oidc.test', client_id='client-test',
                 client_secret='secret-test-value', kid='test-key'):
        self.n, self.e, self.d = modulus, exponent, private
        self.issuer, self.client_id, self.client_secret, self.kid = issuer, client_id, client_secret, kid
        self.codes = {}
        self.access = {}
        self.identities = {}

    def jwks(self):
        return {'keys': [{'kty': 'RSA', 'alg': 'RS256', 'use': 'sig', 'kid': self.kid,
                          'n': b64url(self.n.to_bytes((self.n.bit_length() + 7) // 8, 'big')),
                          'e': b64url(self.e.to_bytes((self.e.bit_length() + 7) // 8, 'big'))}]}

    def issue(self, *, subject, email, email_verified=True, challenge, nonce, redirect_uri, kind='oidc'):
        code = 'code-' + uuid4().hex
        self.codes[code] = {
            'subject': subject, 'email': email, 'email_verified': email_verified,
            'challenge': challenge, 'nonce': nonce, 'redirect_uri': redirect_uri, 'kind': kind,
        }
        return code

    def id_token(self, record, now):
        header = b64url(json.dumps({'alg': 'RS256', 'kid': self.kid}, separators=(',', ':')).encode())
        payload = b64url(json.dumps({
            'iss': self.issuer, 'aud': self.client_id, 'sub': record['subject'],
            'email': record['email'], 'email_verified': record['email_verified'],
            'nonce': record['nonce'], 'iat': now - 1, 'exp': now + 300,
        }, separators=(',', ':')).encode())
        signing = f'{header}.{payload}'.encode('ascii')
        return f'{header}.{payload}.{b64url(rsa_sign(self.n, self.d, signing))}'

    def transport(self, method, url, headers, body, now=1800000000):
        parts = urlsplit(url)
        path = parts.path
        if method == 'GET' and path == '/jwks':
            return 200, {}, json.dumps(self.jwks()).encode()
        if method == 'POST' and path == '/token':
            form = {key: values[0] for key, values in parse_qs(body.decode('ascii'), keep_blank_values=True).items()}
            record = self.codes.pop(form.get('code', ''), None)
            if (record is None or form.get('client_id') != self.client_id
                    or form.get('client_secret') != self.client_secret
                    or form.get('redirect_uri') != record['redirect_uri']
                    or form.get('code_verifier') is None):
                return 400, {}, b'{}'
            import hashlib
            from .oidc import b64url as enc
            challenge = enc(hashlib.sha256(form['code_verifier'].encode('ascii')).digest())
            if challenge != record['challenge']:
                return 400, {}, b'{}'
            if record['kind'] == 'github':
                access = 'ghs-' + uuid4().hex
                self.access[access] = record
                return 200, {}, json.dumps({'access_token': access, 'token_type': 'bearer'}).encode()
            return 200, {}, json.dumps({'id_token': self.id_token(record, now), 'token_type': 'bearer'}).encode()
        if method == 'GET' and path == '/user':
            record = self._bearer(headers)
            if record is None:
                return 401, {}, b'{}'
            return 200, {}, json.dumps({'id': int(record['subject']) if record['subject'].isdigit() else record['subject']}).encode()
        if method == 'GET' and path == '/emails':
            record = self._bearer(headers)
            if record is None:
                return 401, {}, b'{}'
            return 200, {}, json.dumps([
                {'email': record['email'], 'verified': record['email_verified'], 'primary': True}
            ]).encode()
        return 404, {}, b'{}'

    def _bearer(self, headers):
        auth = (headers or {}).get('Authorization', '')
        if not auth.startswith('Bearer '):
            return None
        return self.access.get(auth[7:])


def load_test_rsa(pem_text):
    """Parse a PKCS#1 or PKCS#8 RSA private key PEM for tests only."""
    import base64

    def der_from_pem(text):
        lines = [line.strip() for line in text.splitlines() if line and not line.startswith('-----')]
        return base64.b64decode(''.join(lines))

    def read_len(data, index):
        first = data[index]
        if first < 0x80:
            return first, index + 1
        size = first & 0x7f
        value = int.from_bytes(data[index + 1:index + 1 + size], 'big')
        return value, index + 1 + size

    def read_tlv(data, index):
        tag = data[index]
        length, next_index = read_len(data, index + 1)
        return tag, data[next_index:next_index + length], next_index + length

    def read_int(data, index):
        tag, body, next_index = read_tlv(data, index)
        if tag != 0x02:
            raise ValueError('expected integer')
        return int.from_bytes(body, 'big'), next_index

    der = der_from_pem(pem_text)
    _, seq, _ = read_tlv(der, 0)
    tag, body, index = read_tlv(seq, 0)
    if tag == 0x02 and index < len(seq):
        tag2, _, index2 = read_tlv(seq, index)
        if tag2 == 0x30:
            tag3, body3, _ = read_tlv(seq, index2)
            if tag3 == 0x04:
                _, seq, _ = read_tlv(body3, 0)
    index = 0
    _, index = read_int(seq, index)
    modulus, index = read_int(seq, index)
    exponent, index = read_int(seq, index)
    private, _ = read_int(seq, index)
    return modulus, exponent, private
