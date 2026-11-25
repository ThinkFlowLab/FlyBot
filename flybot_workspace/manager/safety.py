"""Private bounded files, exclusive operator locks and output hygiene."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import stat

LIMIT = 65536


class ManagerError(Exception):
    # Codes only: never include HTTP bodies, credentials, argv or engine output.
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(condition, code='invalid'):
    if not condition:
        raise ManagerError(code)


def object_only(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, 'duplicate_json_key')
        out[key] = value
    return out


def json_loads(raw):
    try:
        return json.loads(raw, object_pairs_hook=object_only)
    except (ValueError, UnicodeError, RecursionError):
        raise ManagerError('invalid_json') from None


def trusted_path(value, *, directory=False, private=False, executable=False):
    require(isinstance(value, str), 'unsafe_path')
    p = Path(value)
    require(p.is_absolute() and str(p) == value and '..' not in p.parts, 'unsafe_path')
    for part in (*reversed(p.parents), p):
        info = part.lstat()  # lstat, not resolve: do not silently accept a symlink.
        require(not stat.S_ISLNK(info.st_mode), 'symlink')
        require(info.st_uid in (0, os.getuid()), 'path_owner')
        # /tmp's root-owned sticky directory is safe above a private owned child.
        sticky_root = stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
        require(not info.st_mode & 0o022 or (part != p and sticky_root), 'path_writable')
    info = p.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode), 'path_type')
    if private:
        require(info.st_uid == os.getuid() and not info.st_mode & 0o077, 'not_private')
    if executable:
        require(os.access(p, os.X_OK), 'not_executable')
    return p


def read_private(path):
    p = trusted_path(str(path), private=True)
    trusted_path(str(p.parent), directory=True, private=True)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        require(stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o077, 'not_private')
        raw = f.read(LIMIT + 1)
    require(len(raw) <= LIMIT, 'file_limit')
    return json_loads(raw)


def replace_private(path, data):
    """Atomically replace a private regular file (mode 0600). data is bytes."""
    require(isinstance(data, (bytes, bytearray)) and len(data) <= LIMIT, 'file_limit')
    p = Path(path)
    trusted_path(str(p.parent), directory=True, private=True)
    tmp = p.with_name(p.name + '.tmp')
    if tmp.exists() or tmp.is_symlink():
        info = tmp.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, 'not_private')
        tmp.unlink()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def write_new(path, data):
    """No overwrite; callers explicitly choose a new private state directory."""
    p = Path(path)
    trusted_path(str(p.parent), directory=True, private=True)
    raw = (json.dumps(data, sort_keys=True, separators=(',', ':')) + '\n').encode()
    require(len(raw) <= LIMIT, 'file_limit')
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(raw)
        f.flush()
        os.fsync(f.fileno())


@contextmanager
def instance_lock(root, iid):
    trusted_path(str(root), directory=True, private=True)
    path = Path(root) / ('lock-' + iid)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077, 'not_private')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ManagerError('instance_busy') from None
        yield
    finally:
        os.close(fd)


def redact(text, secrets=()):
    # Apply to the complete bounded capture, never truncate before filtering.
    for value in sorted((s for s in secrets if s), key=len, reverse=True):
        text = text.replace(value, '[REDACTED]')
    text = re.sub(r'-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)', '[REDACTED]', text)
    text = re.sub(r'(?i)\bbearer\s+[^\s,;"\']+', 'Bearer [REDACTED]', text)
    text = re.sub(r'''(?ix)(["']?(?:password|passwd|secret|token|api[_-]?key|authorization|lease(?:_hash)?|credential_hash)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)''', r'\1"[REDACTED]"', text)
    text = re.sub(r'(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])', '[REDACTED]', text)
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    return ''.join(c for c in text if c in '\n\t' or ord(c) >= 32)[:LIMIT]
