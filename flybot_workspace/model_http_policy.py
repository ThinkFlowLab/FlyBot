"""Operator-only exception for exact public IPv4 HTTP model *task* endpoints.

This is not a general insecure-HTTP switch. Grants travel only in authenticated
credential responses, not settings rows. Their format is a protocol/capability
marker, not a signature. Native DSH SDKs must NOT receive this HTTP credential:
only the Python/JS task transports implement direct, no-redirect delivery.
"""
from dataclasses import dataclass
import ipaddress
import json
import os
from pathlib import Path
import re
import stat

FORMAT = 'flybot-workspace.exact-http-task.v1'
HEADER = 'X-FlyBot-Workspace-Model-HTTP'
WSGI_HEADER = 'HTTP_' + HEADER.upper().replace('-', '_')
# Keep in sync with runtime/flybot-image/model-http-policy.mjs. Use an explicit
# conservative union, not is_global alone (multicast is_global is True on some
# Python versions). IPv6, including mapped IPv4, is intentionally unsupported.
DENIED_V4 = tuple(ipaddress.IPv4Network(x) for x in (
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
    '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
    '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
))
BASE = re.compile(r'http://([0-9.]+):([1-9][0-9]{0,4})(/(?:[A-Za-z0-9._~-]+/)*[A-Za-z0-9._~-]+)', re.ASCII)


def public_http_base(value):
    if type(value) is not str or not 8 <= len(value) <= 512:
        return False
    match = BASE.fullmatch(value)
    if match is None or not 1 <= int(match[2]) <= 65535:
        return False
    try:
        address = ipaddress.IPv4Address(match[1])
    except ipaddress.AddressValueError:
        return False
    if str(address) != match[1] or any(address in net for net in DENIED_V4):
        return False
    return not any(x in ('.', '..') for x in match[3].split('/'))


@dataclass(frozen=True)
class ModelHttpPolicy:
    bases: tuple = ()

    def __post_init__(self):
        if (type(self.bases) is not tuple or len(self.bases) > 16
                or any(not public_http_base(x) for x in self.bases)
                or len(set(self.bases)) != len(self.bases)):
            raise ValueError('Invalid model HTTP policy')

    @classmethod
    def from_document(cls, doc):
        if (type(doc) is not dict or set(doc) != {'version', 'allowed_http_model_bases'}
                or type(doc['version']) is not int or doc['version'] != 1
                or type(doc['allowed_http_model_bases']) is not list):
            raise ValueError('Invalid model HTTP policy')
        return cls(tuple(doc['allowed_http_model_bases']))

    def allows(self, base):
        return public_http_base(base) and base in self.bases

    def grant_for(self, base):
        return {'format': FORMAT, 'base_url': base} if self.allows(base) else None


def valid_grant(base, grant):
    return (public_http_base(base) and type(grant) is dict
            and set(grant) == {'format', 'base_url'}
            and grant['format'] == FORMAT and grant['base_url'] == base)


def completion_url(base, grant):
    if not valid_grant(base, grant):
        raise ValueError('HTTP model task grant rejected')
    return base + '/chat/completions'


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate policy field')
        result[key] = value
    return result


def load_model_http_policy(filename):
    """Bounded private operator file; openat + NOFOLLOW pins each directory.

    File and immediate directory belong to this process user with no group/other
    permissions. Ancestors must be operator/root owned, non-writable by others
    (a root-owned sticky directory such as /tmp is allowed). No symlink/FIFO or
    hard-linked file. No HTTP API can select this filename. Reload on restart.
    """
    path = Path(filename)
    if not path.is_absolute() or '..' in path.parts or len(path.parts) < 3:
        raise ValueError('Model HTTP policy requires a private absolute file')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, name in enumerate(path.parts[1:-1], 1):
            nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
            info = os.fstat(fd)
            private = index == len(path.parts) - 2
            if private:
                good = info.st_uid == os.getuid() and not info.st_mode & 0o077
            else:
                good = (info.st_uid in (0, os.getuid()) and
                        (not info.st_mode & 0o022 or (info.st_uid == 0 and info.st_mode & stat.S_ISVTX)))
            if not good:
                raise ValueError('Model HTTP policy directory is not trusted')
        file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file_fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077 or info.st_size > 16384 or info.st_nlink != 1):
                raise ValueError('Model HTTP policy must be private, regular and bounded')
            raw = stream.read(16385)
        if len(raw) > 16384:
            raise ValueError('Model HTTP policy exceeds bound')
        return ModelHttpPolicy.from_document(json.loads(raw, object_pairs_hook=_object))
    finally:
        os.close(fd)
