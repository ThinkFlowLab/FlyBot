"""Operator opt-in: one isolated runtime instance per user.

Self-written for FlyBot. Default OFF. When enabled, ensuring a user's
personal agent creates exactly one runtime instance in that user's own personal
workspace (owner = that user, the trusted RuntimePolicy image/profile/backend,
its own ``ot-<id>`` volume and, at start, its personal agent bootstrap). The
account-to-container record and the manager assignment are
derived server-side only; no request field can name an instance or a manager.

The assigned manager is the operator-configured identity. A manager grant marked
``auto_provisioned`` may operate exactly the rows in this table that carry its
own id (plus its explicit ``instance_ids``); it never sees other managers' or
operator-enrolled instances it was not granted.
"""
from dataclasses import dataclass
import re
from typing import Optional

SCHEMA = '''
CREATE TABLE IF NOT EXISTS runtime_auto_provisions (
 user_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 instance_id TEXT NOT NULL UNIQUE,
 manager_id TEXT NOT NULL,
 created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS runtime_auto_manager ON runtime_auto_provisions(manager_id, instance_id);
CREATE TABLE IF NOT EXISTS runtime_auto_capacity_holds (
 instance_id TEXT PRIMARY KEY REFERENCES runtime_auto_provisions(instance_id) ON DELETE CASCADE,
 parked_at INTEGER NOT NULL);
'''

MANAGER_ID = re.compile(r'[a-z][a-z0-9-]{0,31}')
STARTING, CAPACITY, UNAVAILABLE = 'runtime_starting', 'runtime_capacity', 'runtime_unavailable'
PARKED = 'runtime_parked'
PARKED_MESSAGE = 'The personal runtime is paused by the operator'


@dataclass(frozen=True)
class AutoProvisionPolicy:
    enabled: bool = False
    manager_id: Optional[str] = None
    max_instances: int = 0
    max_per_user: int = 1

    def __post_init__(self):
        if type(self.enabled) is not bool or self.max_per_user != 1:
            raise ValueError('Invalid auto-provision policy')
        if self.enabled:
            if not isinstance(self.manager_id, str) or not MANAGER_ID.fullmatch(self.manager_id):
                raise ValueError('Auto-provisioning requires an assigned manager id')
            if type(self.max_instances) is not int or not 1 <= self.max_instances <= 100000:
                raise ValueError('Auto-provisioning requires a global cap of 1..100000 instances')


def validate(policy, lifecycle, manager_auth):
    """Fail closed at startup: the assigned manager must exist and match the profile."""
    if policy is None or not policy.enabled:
        return
    if lifecycle is None:
        raise ValueError('Auto-provisioning requires an explicit runtime profile')
    identity = manager_auth.identities.get(policy.manager_id) if manager_auth is not None else None
    if identity is None or not identity.auto_provisioned or identity.backend_mode != lifecycle.policy.backend_mode:
        raise ValueError('Auto-provisioning manager grant is missing, not auto_provisioned, or another backend')
    if policy.max_instances > lifecycle.policy.max_instances:
        raise ValueError('Auto-provisioning cap exceeds the runtime instance cap')


def load(db, user_id):
    return db.execute('SELECT * FROM runtime_auto_provisions WHERE user_id=?', (user_id,)).fetchone()


def owned_instance(db, user_id):
    """Prefer the provisioned instance. Legacy duplicates need operator reconciliation."""
    from .lifecycle import fail
    provision = load(db, user_id)
    if provision is not None:
        row = db.execute('SELECT id FROM instances WHERE id=? AND owner_id=? AND retired_at IS NULL',
                         (provision['instance_id'], user_id)).fetchone()
        if row is None:
            fail(409, 'conflict', 'The provisioned runtime is unavailable')
        return row['id']
    rows = db.execute('SELECT id FROM instances WHERE owner_id=? AND retired_at IS NULL LIMIT 2', (user_id,)).fetchall()
    if len(rows) > 1:
        fail(409, 'conflict', 'Multiple runtimes are registered for this account')
    return rows[0]['id'] if rows else None


def resumable_instance(db, user_id, manager_id, *, manager_auth=None):
    """Find the owner's confirmed stopped runtime with an active manager grant."""
    if not manager_id:
        return None
    iid = owned_instance(db, user_id)
    if iid is None or is_parked(db, iid):
        return None
    row = db.execute(
        """SELECT i.id,i.revision,p.manager_id FROM instances i
        LEFT JOIN runtime_auto_provisions p ON p.instance_id=i.id AND p.user_id=i.owner_id
        WHERE i.id=? AND i.owner_id=? AND i.backend_mode='compose'
          AND i.retired_at IS NULL AND i.desired='stopped' AND i.observed='stopped'
          AND i.observed_revision=i.revision AND i.process_ref IS NULL AND i.blocked=0
          AND i.error_code IS NULL AND NOT EXISTS (
            SELECT 1 FROM runtime_jobs j WHERE j.instance_id=i.id AND j.status IN ('queued','running')
          )""", (iid, user_id)).fetchone()
    if row is None:
        return None
    if row['manager_id'] is not None:
        return row if row['manager_id'] == manager_id else None
    if manager_auth is not None and any(
        manager.backend_mode == 'compose' and iid in manager.instance_ids
        for manager in manager_auth.identities.values()
    ):
        return row
    return None


def assigned(db, manager_id, instance_id):
    return db.execute(
        'SELECT 1 FROM runtime_auto_provisions p JOIN instances i ON i.id=p.instance_id '
        'WHERE p.manager_id=? AND p.instance_id=? AND i.retired_at IS NULL',
        (manager_id, instance_id)).fetchone() is not None


def assigned_ids(db, manager_id, cursor=''):
    """Sorted lazy iterator over assigned instances, including paused instances."""
    for row in db.execute(
        'SELECT p.instance_id FROM runtime_auto_provisions p JOIN instances i ON i.id=p.instance_id '
        'WHERE p.manager_id=? AND p.instance_id>? AND i.retired_at IS NULL ORDER BY p.instance_id',
        (manager_id, cursor)):
        yield row[0]


def is_auto(db, instance_id):
    return db.execute(
        'SELECT 1 FROM runtime_auto_provisions p JOIN instances i ON i.id=p.instance_id '
        'WHERE p.instance_id=? AND i.retired_at IS NULL', (instance_id,)).fetchone() is not None


def create_key(user_id):
    return 'autoprov-' + user_id


def at_capacity(db, policy):
    return capacity_status(db, policy)['available'] == 0


def capacity_status(db, policy):
    total, parked = db.execute(
        'SELECT COUNT(*), COUNT(h.instance_id) FROM runtime_auto_provisions p '
        'LEFT JOIN runtime_auto_capacity_holds h ON h.instance_id=p.instance_id'
    ).fetchone()
    reserved = total - parked
    return {'limit': policy.max_instances, 'reserved': reserved, 'parked': parked,
            'available': max(0, policy.max_instances - reserved)}


def is_parked(db, instance_id):
    return db.execute('SELECT 1 FROM runtime_auto_capacity_holds WHERE instance_id=?',
                      (instance_id,)).fetchone() is not None


def set_parked(db, policy, instance_id, expected_revision, parked, now):
    """Change the reservation with the same IMMEDIATE transaction as lifecycle intents."""
    from .lifecycle import Lifecycle, RuntimeFault, fail
    if not policy.enabled:
        fail(409, 'disabled', 'Automatic provisioning is disabled')
    row = db.execute(
        'SELECT i.* FROM instances i JOIN runtime_auto_provisions p '
        'ON p.instance_id=i.id AND p.user_id=i.owner_id '
        'WHERE i.id=? AND i.retired_at IS NULL AND p.manager_id=?',
        (instance_id, policy.manager_id),
    ).fetchone()
    if row is None:
        fail(404, 'not_found', 'Automatically provisioned instance not found for this manager')
    if row['revision'] != expected_revision:
        raise RuntimeFault(409, 'conflict', 'Revision conflict; fetch current instance', Lifecycle.current_intent(row))
    if (row['desired'] != 'stopped' or row['observed'] != 'stopped' or row['observed_revision'] != row['revision']
            or row['process_ref'] is not None or row['blocked'] or row['error_code'] is not None
            or db.execute("SELECT 1 FROM runtime_jobs WHERE instance_id=? AND status IN ('queued','running')",
                          (instance_id,)).fetchone() is not None):
        fail(409, 'conflict', 'The runtime must be stopped and settled')
    if is_parked(db, instance_id) == parked:
        return False
    if parked:
        db.execute('INSERT INTO runtime_auto_capacity_holds VALUES(?,?)', (instance_id, now))
    else:
        if at_capacity(db, policy):
            fail(429, CAPACITY, 'Automatic runtime capacity is full')
        db.execute('DELETE FROM runtime_auto_capacity_holds WHERE instance_id=?', (instance_id,))
    return True


def ensure(db, lifecycle, policy, user_id, workspace_id, agent_id, now):
    """Idempotently provision the account container in an IMMEDIATE transaction.

    A canonical owner instance may already exist through operator enrollment.
    Capacity refusals leave no partial rows.
    """
    from .lifecycle import RuntimeFault
    if policy is None or not policy.enabled or lifecycle is None:
        return {'state': 'disabled', 'instance_id': None}
    row = load(db, user_id)
    if row is not None:
        try:
            return {'state': 'existing', 'instance_id': owned_instance(db, user_id)}
        except RuntimeFault as error:
            return {'state': 'failed', 'instance_id': None, 'error_code': error.code}
    owner = db.execute('SELECT owner_id FROM workspaces WHERE id=?', (workspace_id,)).fetchone()
    if owner is None or owner['owner_id'] != user_id:
        return {'state': 'failed', 'instance_id': None, 'error_code': 'not_personal_workspace'}
    try:
        existing = owned_instance(db, user_id)
    except RuntimeFault as error:
        return {'state': 'failed', 'instance_id': None, 'error_code': error.code}
    if existing is not None:
        # Existing operator-enrolled instances retain their current manager grants.
        return {'state': 'bound', 'instance_id': existing}
    if at_capacity(db, policy):
        return {'state': 'capacity', 'instance_id': None}
    try:
        # Compose up can create the volume and start the container under one lease.
        _created, result = lifecycle.create_with(
            db, user_id, workspace_id, create_key(user_id),
            start_immediately=lifecycle.policy.backend_mode == 'compose',
        )
    except RuntimeFault as error:
        return {'state': 'capacity' if error.status == 429 else 'failed', 'instance_id': None,
                'error_code': error.code}
    iid = result['instance']['id']
    db.execute('INSERT INTO runtime_auto_provisions VALUES(?,?,?,?,?,?)',
               (user_id, workspace_id, agent_id, iid, policy.manager_id, now))
    return {'state': 'provisioned', 'instance_id': iid}


def chat_error(db, snapshot_of, result):
    """Map an ensure() result to an actionable chat error code (or None = plain no_agent)."""
    state = result['state']
    if state == 'capacity':
        return CAPACITY
    if state == 'failed':
        return UNAVAILABLE
    if state in ('existing', 'provisioned'):
        if is_parked(db, result['instance_id']):
            return PARKED
        snapshot = snapshot_of(result['instance_id'])
        if snapshot is None or snapshot.get('blocked') or snapshot.get('error') is not None:
            return UNAVAILABLE
        return STARTING
    return None
