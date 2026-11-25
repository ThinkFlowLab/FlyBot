"""Bounded, versioned password verification and opaque credential hashing."""
import hashlib
import hmac
import secrets

SCRYPT_N, SCRYPT_R, SCRYPT_P = 32768, 8, 3


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _derive(password, salt):
    return hashlib.scrypt(password.encode('utf-8'), salt=salt, n=SCRYPT_N,
                          r=SCRYPT_R, p=SCRYPT_P, maxmem=64 * 1024 * 1024)


def password_hash(password):
    salt = secrets.token_bytes(16)
    return f'scrypt-v1${salt.hex()}${_derive(password, salt).hex()}'


def password_matches(password, encoded):
    # Fixed parameters; a corrupt record cannot select an unbounded KDF workload.
    try:
        version, salt, expected = encoded.split('$')
        if version != 'scrypt-v1' or len(salt) != 32 or len(expected) != 128:
            return False
        return hmac.compare_digest(_derive(password, bytes.fromhex(salt)), bytes.fromhex(expected))
    except (ValueError, TypeError):
        return False


def dummy_verify(password):
    _derive(password, b'\0' * 16)


def opaque():
    return secrets.token_urlsafe(32)
