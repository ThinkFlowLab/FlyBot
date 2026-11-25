"""Read operator-owned local manager grants, never an HTTP-selected path.

The file contains credential digests only, not bearer secrets. No endpoint can
write this file or grant another instance. Reload requires an operator restart.
An entry may set ``"auto_provisioned": true``: that manager is then also
authorized for instances the server itself auto-provisioned and assigned to its
id (tracked in the database, no restart needed). It is not a wildcard.
"""
from dataclasses import dataclass
import json
import os
from pathlib import Path
import stat

from .lifecycle import ManagerAuth, ManagerIdentity


def load_manager_auth(path):
    path = Path(path).absolute()
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Manager grant path must not use symbolic links')
    parent = path.parent.stat()
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('Manager grant directory must be private')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 131072:
            raise ValueError('Manager grant file must be private and bounded')
        raw = stream.read(131073)
    if len(raw) > 131072:
        raise ValueError('Manager grant file exceeds bound')
    from .app import object_only
    data = json.loads(raw, object_pairs_hook=object_only)
    if not isinstance(data, list) or len(data) > 100:
        raise ValueError('Invalid manager grant registry')
    identities = []
    for entry in data:
        base = {'id', 'credential_hash', 'instance_ids', 'backend_mode'}
        if not isinstance(entry, dict) or set(entry) not in (base, base | {'auto_provisioned'}):
            raise ValueError('Invalid manager grant fields')
        ids = entry['instance_ids']
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids) or len(ids) != len(set(ids)):
            raise ValueError('Invalid instance grants')
        auto = entry.get('auto_provisioned', False)
        if type(auto) is not bool:
            raise ValueError('Invalid auto_provisioned grant flag')
        identities.append(ManagerIdentity(entry['id'], entry['credential_hash'], frozenset(ids), entry['backend_mode'], auto))
    return ManagerAuth(identities)


@dataclass
class OperatorAdmin:
    """Loopback bearer credential for operator-only admin APIs. Hash only is stored."""
    credential_hash: str

    def authenticate(self, env):
        import hmac
        import ipaddress
        import re
        from .lifecycle import fail
        from .security import digest
        try:
            loopback = ipaddress.ip_address(env.get('REMOTE_ADDR', '')).is_loopback
        except ValueError:
            loopback = False
        if not loopback or env.get('HTTP_COOKIE') or env.get('HTTP_ORIGIN'):
            fail(401, 'operator_auth', 'Separate loopback operator credentials required')
        match = re.fullmatch(r'Bearer ([A-Za-z0-9_-]{32,128})', env.get('HTTP_AUTHORIZATION', ''))
        actual = digest(match[1]) if match else digest('invalid')
        if not hmac.compare_digest(actual, self.credential_hash):
            fail(401, 'operator_auth', 'Separate loopback operator credentials required')
        return self


def load_operator_admin(path):
    path = Path(path).absolute()
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Operator admin path must not use symbolic links')
    parent = path.parent.stat()
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('Operator admin directory must be private')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 4096:
            raise ValueError('Operator admin file must be private and bounded')
        raw = stream.read(4097)
    if len(raw) > 4096:
        raise ValueError('Operator admin file exceeds bound')
    from .app import object_only
    data = json.loads(raw, object_pairs_hook=object_only)
    if not isinstance(data, dict) or set(data) != {'credential_hash'}:
        raise ValueError('Invalid operator admin file')
    value = data['credential_hash']
    if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('Invalid operator credential hash')
    return OperatorAdmin(value)


def load_auto_provision(path):
    """Private operator JSON: {"enabled": bool, "manager_id": str, "max_instances": int}. Default OFF."""
    from .runtime_autoprovision import AutoProvisionPolicy
    path = Path(path).absolute()
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('Auto-provision path must not use symbolic links')
    parent = path.parent.stat()
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError('Auto-provision directory must be private')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 4096:
            raise ValueError('Auto-provision file must be private and bounded')
        raw = stream.read(4097)
    if len(raw) > 4096:
        raise ValueError('Auto-provision file exceeds bound')
    from .app import object_only
    data = json.loads(raw, object_pairs_hook=object_only)
    if not isinstance(data, dict) or set(data) != {'enabled', 'manager_id', 'max_instances'}:
        raise ValueError('Invalid auto-provision file')
    return AutoProvisionPolicy(enabled=data['enabled'], manager_id=data['manager_id'], max_instances=data['max_instances'])
