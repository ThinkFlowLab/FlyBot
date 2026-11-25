"""Durable control-plane intents and fenced manager jobs; never executes a command."""
from dataclasses import dataclass, field
import hmac
import ipaddress
import re
import time
from uuid import uuid4

import heapq

from . import bot_social, dsbot_bundle, members, model_api, runtime_autoprovision
from .security import digest, opaque

ID = re.compile(r'[0-9a-f]{32}')
KEY = re.compile(r'[A-Za-z0-9_-]{16,64}')
ACTIONS = frozenset(('create', 'start', 'stop', 'restart'))
UNSUPPORTED = frozenset(('backup', 'restore', 'upgrade', 'reclaim', 'purge'))
ERRORS = {'runtime_failure': 'Runtime operation failed', 'interrupted': 'Manager lease expired; operator recovery required'}
GATEWAY_REFRESH_SECONDS = 15
SCHEMA = '''
CREATE TABLE IF NOT EXISTS runtime_schema (version INTEGER PRIMARY KEY CHECK(version=1));
INSERT OR IGNORE INTO runtime_schema VALUES(1);
CREATE TABLE IF NOT EXISTS instances (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_id TEXT NOT NULL REFERENCES users(id),
 profile TEXT NOT NULL, backend_mode TEXT NOT NULL, image_ref TEXT NOT NULL, volume_ref TEXT NOT NULL UNIQUE,
 desired TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), operation_id TEXT NOT NULL,
 operation_type TEXT NOT NULL, observed TEXT NOT NULL, observed_revision INTEGER,
 health TEXT NOT NULL DEFAULT 'unknown', process_ref TEXT, error_code TEXT, blocked INTEGER NOT NULL DEFAULT 0,
 create_key TEXT NOT NULL, created INTEGER NOT NULL,
 retired_at INTEGER, retired_to TEXT REFERENCES instances(id), UNIQUE(workspace_id,create_key));
CREATE INDEX IF NOT EXISTS instance_owner ON instances(owner_id,workspace_id,id);
CREATE TABLE IF NOT EXISTS runtime_jobs (
 id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id), revision INTEGER NOT NULL,
 operation_id TEXT NOT NULL, operation_type TEXT NOT NULL, status TEXT NOT NULL,
 manager_id TEXT, lease_hash TEXT, lease_until INTEGER, error_code TEXT, created INTEGER NOT NULL, finished INTEGER,
 UNIQUE(instance_id,operation_id), UNIQUE(instance_id,revision));
CREATE UNIQUE INDEX IF NOT EXISTS one_running_job ON runtime_jobs(instance_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS pending_runtime_jobs ON runtime_jobs(instance_id,status,revision);
''' + runtime_autoprovision.SCHEMA


def ensure_retirement_schema(db):
    """Add retirement metadata and prevent a new live Compose duplicate in an active transaction."""
    columns = {row[1] for row in db.execute('PRAGMA table_info(instances)')}
    if 'retired_at' not in columns:
        db.execute('ALTER TABLE instances ADD COLUMN retired_at INTEGER')
    if 'retired_to' not in columns:
        db.execute('ALTER TABLE instances ADD COLUMN retired_to TEXT REFERENCES instances(id)')
    # Existing duplicates remain available for explicit operator reconciliation.
    db.execute("""CREATE TRIGGER IF NOT EXISTS instances_one_live_compose_insert
        BEFORE INSERT ON instances
        WHEN NEW.backend_mode='compose' AND NEW.retired_at IS NULL AND EXISTS (
            SELECT 1 FROM instances WHERE owner_id=NEW.owner_id AND backend_mode='compose' AND retired_at IS NULL
        )
        BEGIN SELECT RAISE(ABORT, 'Owner already has an active Compose runtime'); END
    """)
    db.execute("""CREATE TRIGGER IF NOT EXISTS instances_one_live_compose_update
        BEFORE UPDATE OF owner_id,backend_mode,retired_at ON instances
        WHEN NEW.backend_mode='compose' AND NEW.retired_at IS NULL
          AND (OLD.owner_id<>NEW.owner_id OR OLD.backend_mode<>'compose' OR OLD.retired_at IS NOT NULL)
          AND EXISTS (
              SELECT 1 FROM instances WHERE owner_id=NEW.owner_id AND id<>OLD.id
              AND backend_mode='compose' AND retired_at IS NULL
          )
        BEGIN SELECT RAISE(ABORT, 'Owner already has an active Compose runtime'); END
    """)


def retire_instance(db, iid, canonical, retired_at):
    """Archive an attested stopped Compose duplicate inside the caller's IMMEDIATE transaction."""
    if (not all(isinstance(value, str) and ID.fullmatch(value) for value in (iid, canonical))
            or iid == canonical or type(retired_at) is not int or retired_at < 0):
        raise ValueError('Invalid runtime retirement arguments')
    cursor = db.execute('SELECT * FROM instances WHERE id IN (?,?)', (iid, canonical))
    columns = [column[0] for column in cursor.description]
    rows = {row[0]: dict(zip(columns, row)) for row in cursor}
    source, target = rows.get(iid), rows.get(canonical)
    if (source is None or target is None or source['owner_id'] != target['owner_id']
            or source['backend_mode'] != 'compose' or target['backend_mode'] != 'compose'
            or target['retired_at'] is not None):
        raise ValueError('Retirement requires a live Compose runtime for the same owner')
    if source['retired_at'] is not None:
        if source['retired_to'] == canonical:
            return False
        raise ValueError('The runtime is already retired to another target')
    if (source['desired'] != 'stopped' or source['observed'] != 'stopped'
            or source['revision'] != source['observed_revision'] or source['blocked'] or source['process_ref'] is not None):
        raise ValueError('The runtime must be stopped and converged before retirement')
    provisioned = db.execute('SELECT instance_id FROM runtime_auto_provisions WHERE user_id=?',
                             (source['owner_id'],)).fetchone()
    if provisioned is not None and provisioned[0] != canonical:
        raise ValueError('The retirement target must remain the provisioned runtime')
    if db.execute("SELECT 1 FROM runtime_jobs WHERE instance_id=? AND status IN ('queued','running')", (iid,)).fetchone():
        raise ValueError('A pending manager job prevents runtime retirement')
    row = db.execute('UPDATE instances SET retired_at=?,retired_to=? WHERE id=? AND retired_at IS NULL',
                     (retired_at, canonical, iid))
    if row.rowcount != 1:
        raise ValueError('The runtime changed before retirement')
    return True


class RuntimeFault(Exception):
    def __init__(self, status, code, message, current=None):
        self.status, self.code, self.message, self.current = status, code, message, current


def fail(status, code, message):
    raise RuntimeFault(status, code, message)


def valid_key(value):
    return isinstance(value, str) and KEY.fullmatch(value) is not None


@dataclass(frozen=True)
class RuntimePolicy:
    image_ref: str = 'simulation/no-image:local'
    profile: str = 'local-simulation'
    backend_mode: str = 'simulation'
    max_instances_per_workspace: int = 8
    max_instances: int = 1000
    max_jobs: int = 10000
    lease_seconds: int = 30

    def __post_init__(self):
        if (not re.fullmatch(r'[a-z0-9./:_@-]{1,200}', self.image_ref)
                or not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', self.profile)
                or self.backend_mode not in ('simulation', 'compose-planning', 'compose')):
            raise ValueError('Invalid trusted runtime profile')
        if self.backend_mode == 'compose' and ('..' in self.image_ref or not re.fullmatch(r'[a-z0-9][a-z0-9./:_-]{0,118}@sha256:[0-9a-f]{64}', self.image_ref)):
            raise ValueError('Compose execution requires a pinned image digest')
        for name in ('max_instances_per_workspace', 'max_instances', 'max_jobs', 'lease_seconds'):
            value = getattr(self, name)
            if type(value) is not int or not 1 <= value <= (120 if name == 'lease_seconds' else 100000):
                raise ValueError('Invalid bounded runtime limit')


@dataclass(frozen=True)
class ManagerIdentity:
    id: str
    credential_hash: str = field(repr=False)
    instance_ids: frozenset
    backend_mode: str = 'simulation'
    # Server-tracked scope: also the instances THIS server auto-provisioned and
    # assigned to this manager id. Never a wildcard over operator-enrolled ids.
    auto_provisioned: bool = False

    def __post_init__(self):
        if (not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', self.id) or type(self.auto_provisioned) is not bool
                or not re.fullmatch(r'[0-9a-f]{64}', self.credential_hash)
                or not isinstance(self.instance_ids, frozenset) or len(self.instance_ids) > 1000
                or any(not isinstance(i, str) or not ID.fullmatch(i) for i in self.instance_ids)
                or self.backend_mode not in ('simulation', 'compose-planning', 'compose')):
            raise ValueError('Invalid manager grant')


class ManagerAuth:
    """Trusted operator grants. No browser/session fallback and no proxy-header trust."""
    def __init__(self, identities=()):
        identities = tuple(identities)
        if len(identities) > 100 or len({m.id for m in identities}) != len(identities):
            raise ValueError('Invalid manager registry')
        self.identities = {m.id: m for m in identities}

    def authenticate(self, env):
        try:
            loopback = ipaddress.ip_address(env.get('REMOTE_ADDR', '')).is_loopback
        except ValueError:
            loopback = False
        if not loopback or env.get('HTTP_COOKIE') or env.get('HTTP_ORIGIN'):
            fail(401, 'manager_auth', 'Separate loopback manager credentials required')
        match = re.fullmatch(r'Bearer ([a-z][a-z0-9-]{0,31})\.([A-Za-z0-9_-]{43})', env.get('HTTP_AUTHORIZATION', ''))
        identity = self.identities.get(match[1]) if match else None
        actual = digest(match[2]) if match else digest('invalid')
        expected = identity.credential_hash if identity else '0' * 64
        if not hmac.compare_digest(actual, expected) or identity is None:
            fail(401, 'manager_auth', 'Separate loopback manager credentials required')
        return identity


class Lifecycle:
    def __init__(self, store, policy=None, clock=time.time):
        self.store, self.policy, self.clock = store, policy or RuntimePolicy(), clock
        with store.connect() as db:
            table = db.execute("SELECT name FROM sqlite_master WHERE name='runtime_schema'").fetchone()
            if table and [r[0] for r in db.execute('SELECT version FROM runtime_schema')] != [1]:
                raise ValueError('Unsupported runtime schema')
            db.executescript('BEGIN IMMEDIATE;\n' + SCHEMA)
            ensure_retirement_schema(db)
            db.commit()

    def expire(self):
        # A timed-out external operation might still be running: DO NOT auto-retry or
        # release this instance for another execution. Recovery needs operator review.
        with self.store.transaction() as db:
            self.expire_with(db)

    def expire_with(self, db):
        now = int(self.clock())
        ids = [r[0] for r in db.execute(
            "SELECT j.instance_id FROM runtime_jobs j JOIN instances i ON i.id=j.instance_id "
            "WHERE i.retired_at IS NULL AND j.status='running' AND j.lease_until<=?", (now,))]
        for iid in ids:
            db.execute("UPDATE runtime_jobs SET status='interrupted',error_code='interrupted',finished=?,lease_hash=NULL WHERE instance_id=? AND status='running'", (now, iid))
            db.execute("UPDATE instances SET blocked=1,observed='unknown',health='unknown',error_code='interrupted' WHERE id=?", (iid,))

    @staticmethod
    def workspace(db, user, wid, write=False):
        row = members.load(db, wid, user)
        if row is None:
            fail(404, 'not_found', 'Workspace not found')
        if write and members.role_of(db, row, user) not in ('owner', 'admin'):
            fail(403, 'forbidden', 'Not allowed to operate instances')
        return row

    @staticmethod
    def owned(db, user, iid, write=False):
        row = db.execute('SELECT * FROM instances WHERE id=? AND retired_at IS NULL', (iid,)).fetchone()
        if row is None:
            fail(404, 'not_found', 'Instance not found')
        if row['backend_mode'] == 'compose':
            if row['owner_id'] != user or runtime_autoprovision.owned_instance(db, user) != iid:
                fail(404, 'not_found', 'Instance not found')
            return row
        workspace = members.load(db, row['workspace_id'], user)
        if workspace is None:
            fail(404, 'not_found', 'Instance not found')
        if write and members.role_of(db, workspace, user) not in ('owner', 'admin'):
            fail(403, 'forbidden', 'Not allowed to operate instances')
        return row

    @staticmethod
    def grants(db, manager, iid):
        allowed = iid in manager.instance_ids or (
            manager.auto_provisioned and runtime_autoprovision.assigned(db, manager.id, iid))
        return allowed and db.execute('SELECT 1 FROM instances WHERE id=? AND retired_at IS NULL', (iid,)).fetchone() is not None

    @staticmethod
    def managed(db, manager, iid):
        row = db.execute('SELECT * FROM instances WHERE id=?', (iid,)).fetchone() if Lifecycle.grants(db, manager, iid) else None
        if row is None or row['backend_mode'] != manager.backend_mode:
            fail(404, 'not_found', 'Instance not found')
        return row

    @staticmethod
    def current_intent(row):
        return {'revision': row['revision'], 'operation': {'type': row['operation_type'], 'operation_id': row['operation_id']}}

    @staticmethod
    def snapshot(row):
        return {**{k: row[k] for k in ('id', 'workspace_id', 'owner_id', 'profile', 'backend_mode', 'image_ref', 'volume_ref',
                                             'desired', 'revision', 'observed', 'observed_revision', 'health', 'created')},
                'operation': {'type': row['operation_type'], 'operation_id': row['operation_id']},
                'blocked': bool(row['blocked']),
                'converged': row['observed_revision'] == row['revision'] and row['observed'] == row['desired'] and not row['blocked'],
                'error': {'code': row['error_code'], 'message': ERRORS.get(row['error_code'], 'Runtime operation failed')} if row['error_code'] else None}

    @staticmethod
    def job(row):
        return {k: row[k] for k in ('id', 'instance_id', 'revision', 'operation_id', 'operation_type', 'status', 'error_code', 'created', 'finished')}

    def result(self, db, iid, operation_id=None):
        row = db.execute('SELECT * FROM instances WHERE id=?', (iid,)).fetchone()
        job = db.execute('SELECT * FROM runtime_jobs WHERE instance_id=? AND operation_id=?', (iid, operation_id or row['operation_id'])).fetchone()
        return {'instance': self.snapshot(row), 'job': self.job(job)}

    def capacity(self, db):
        if db.execute('SELECT COUNT(*) FROM runtime_jobs').fetchone()[0] >= self.policy.max_jobs:
            fail(429, 'quota', 'Runtime job capacity reached; operator archival required')

    def check_create_capacity(self, db, wid=None):
        self.capacity(db)
        workspace_full = wid is not None and db.execute(
            'SELECT COUNT(*) FROM instances WHERE workspace_id=? AND retired_at IS NULL',
            (wid,),
        ).fetchone()[0] >= self.policy.max_instances_per_workspace
        if workspace_full or db.execute('SELECT COUNT(*) FROM instances WHERE retired_at IS NULL').fetchone()[0] >= self.policy.max_instances:
            fail(429, 'quota', 'Instance capacity reached')

    def create(self, owner, wid, key, *, per_user=False):
        if not valid_key(key):
            fail(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
        with self.store.transaction() as db:
            return self.create_with(db, owner, wid, key, per_user=per_user)

    def create_with(self, db, owner, wid, key, *, per_user=False, start_immediately=False):
        """Create inside the caller's IMMEDIATE transaction (server-side auto-provisioning)."""
        if not valid_key(key):
            fail(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
        now = int(self.clock())
        self.workspace(db, owner, wid, write=True)
        owner_scoped = per_user or self.policy.backend_mode == 'compose'
        if owner_scoped:
            existing = runtime_autoprovision.owned_instance(db, owner)
            if existing is not None:
                return False, self.result(db, existing)
        else:
            old = db.execute('SELECT id FROM instances WHERE workspace_id=? AND create_key=? AND retired_at IS NULL', (wid, digest(key))).fetchone()
            if old:
                return False, self.result(db, old['id'])
        self.check_create_capacity(db, wid)
        iid, op, jid = uuid4().hex, uuid4().hex, uuid4().hex
        create_key = digest('owner:' + owner + ':' + key) if owner_scoped else digest(key)
        desired, action = ('running', 'start') if start_immediately else ('stopped', 'create')
        db.execute("INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,desired,revision,operation_id,operation_type,observed,create_key,created) VALUES(?,?,?,?,?,?,?,?,1,?,?,'pending',?,?)",
                   (iid, wid, owner, self.policy.profile, self.policy.backend_mode, self.policy.image_ref,
                    'ot-' + iid, desired, op, action, create_key, now))
        db.execute("INSERT INTO runtime_jobs(id,instance_id,revision,operation_id,operation_type,status,created) VALUES(?,?,1,?,?,'queued',?)",
                   (jid, iid, op, action, now))
        return True, self.result(db, iid)

    def inspect(self, owner, iid):
        self.expire()
        with self.store.connect() as db:
            return self.snapshot(self.owned(db, owner, iid))

    def listing(self, owner, wid, limit=20, cursor=''):
        self.expire()
        with self.store.connect() as db:
            self.workspace(db, owner, wid)
            if self.policy.backend_mode == 'compose':
                iid = runtime_autoprovision.owned_instance(db, owner)
                row = db.execute('SELECT * FROM instances WHERE id=? AND id>? AND retired_at IS NULL', (iid, cursor)).fetchone() if iid else None
                return {'items': [self.snapshot(row)] if row else [], 'cursor': None}
            rows = db.execute('SELECT * FROM instances WHERE workspace_id=? AND id>? AND retired_at IS NULL ORDER BY id LIMIT ?', (wid, cursor, limit + 1)).fetchall()
            return {'items': [self.snapshot(r) for r in rows[:limit]], 'cursor': rows[limit-1]['id'] if len(rows) > limit else None}

    def intent(self, owner, iid, action, operation_id=None, expected_revision=None):
        if action not in ACTIONS - {'create'} or (operation_id is not None and not valid_key(operation_id)):
            fail(400, 'invalid', 'Invalid lifecycle action or operation_id')
        if expected_revision is not None and (type(expected_revision) is not int or not 1 <= expected_revision <= 2147483647):
            fail(400, 'invalid', 'Invalid expected_revision')
        self.expire()
        with self.store.transaction() as db:
            row = self.owned(db, owner, iid, write=True)
            if action == 'restart' and operation_id:
                old = db.execute('SELECT * FROM runtime_jobs WHERE instance_id=? AND operation_id=?', (iid, operation_id)).fetchone()
                if old:
                    if old['operation_type'] != 'restart':
                        fail(409, 'conflict', 'operation_id is bound to another action')
                    return False, self.result(db, iid, operation_id)
            target = 'stopped' if action == 'stop' else 'running'
            if target == 'running' and runtime_autoprovision.is_parked(db, iid):
                fail(409, runtime_autoprovision.PARKED, runtime_autoprovision.PARKED_MESSAGE)
            if action != 'restart' and row['desired'] == target:
                return False, self.result(db, iid)
            if expected_revision is not None and row['revision'] != expected_revision:
                raise RuntimeFault(409, 'conflict', 'Revision conflict; fetch current instance', self.current_intent(row))
            if row['blocked']:
                fail(409, 'interrupted', ERRORS['interrupted'])
            active = db.execute("SELECT * FROM runtime_jobs WHERE instance_id=? AND status IN ('queued','running')", (iid,)).fetchone()
            if active and (active['status'] == 'running' or active['operation_type'] in ('create', 'recover') or action == 'restart'):
                raise RuntimeFault(409, 'conflict', 'Operation in progress; fetch current instance', self.current_intent(row))
            self.capacity(db)
            if active:
                db.execute("UPDATE runtime_jobs SET status='superseded',finished=? WHERE id=?", (int(self.clock()), active['id']))
            op, jid, revision = operation_id if action == 'restart' and operation_id else uuid4().hex, uuid4().hex, row['revision'] + 1
            db.execute("UPDATE instances SET desired=?,revision=?,operation_id=?,operation_type=?,health='unknown',error_code=NULL WHERE id=?", (target, revision, op, action, iid))
            db.execute("INSERT INTO runtime_jobs(id,instance_id,revision,operation_id,operation_type,status,created) VALUES(?,?,?,?,?,'queued',?)", (jid, iid, revision, op, action, int(self.clock())))
            return True, self.result(db, iid)

    def start(self, owner, iid, expected_revision=None):
        return self.intent(owner, iid, 'start', expected_revision=expected_revision)

    def stop(self, owner, iid, expected_revision=None):
        return self.intent(owner, iid, 'stop', expected_revision=expected_revision)

    def restart(self, owner, iid, operation_id=None, expected_revision=None):
        return self.intent(owner, iid, 'restart', operation_id, expected_revision)

    def get_job(self, owner, jid):
        self.expire()
        with self.store.connect() as db:
            row = db.execute('SELECT j.* FROM runtime_jobs j JOIN instances i ON i.id=j.instance_id WHERE j.id=? AND i.retired_at IS NULL', (jid,)).fetchone()
            if row is None:
                fail(404, 'not_found', 'Job not found')
            try:
                self.owned(db, owner, row['instance_id'])
            except RuntimeFault as error:
                if error.status == 404:
                    fail(404, 'not_found', 'Job not found')
                raise
            return self.job(row)

    def manager_list(self, manager, desired=None, limit=20, cursor=''):
        self.expire()
        with self.store.connect() as db:
            # Grants are bounded; never use caller input as SQL identifiers.
            static = sorted(i for i in manager.instance_ids if i > cursor)
            auto = list(runtime_autoprovision.assigned_ids(db, manager.id, cursor)) if manager.auto_provisioned else []
            auto_set = set(auto)
            rows, last = [], None
            for iid in heapq.merge(static, auto):
                if iid == last:
                    continue
                last = iid
                row = db.execute('SELECT * FROM instances WHERE id=? AND backend_mode=? AND retired_at IS NULL', (iid, manager.backend_mode)).fetchone()
                if row and (desired is None or row['desired'] == desired):
                    rows.append(row)
                    if len(rows) > limit:
                        break
            items = [{**self.snapshot(r), 'provisioning': 'auto' if r['id'] in auto_set else 'operator'} for r in rows[:limit]]
            if manager.backend_mode == 'compose':
                running = [item['id'] for item in items
                           if item['converged'] and item['observed'] == 'running' and item['health'] == 'healthy']
                published = {}
                now = int(self.clock())
                if running and db.execute("SELECT 1 FROM sqlite_master WHERE name='dsbot_upstreams' AND type='table'").fetchone():
                    # Successful stop/restart observations invalidate the previous process route.
                    # Give the poller route state without credentials or addresses.
                    placeholders = ','.join('?' for _ in running)
                    published = {row['instance_id']: row['updated'] for row in db.execute(
                        f'SELECT instance_id, updated FROM dsbot_upstreams WHERE instance_id IN ({placeholders})', running,
                    )}
                for item in items:
                    updated = published.get(item['id'])
                    item['gateway_route_present'] = updated is not None
                    item['gateway_route_fresh'] = updated is not None and now - GATEWAY_REFRESH_SECONDS < updated <= now
            return {'items': items, 'cursor': rows[limit-1]['id'] if len(rows) > limit else None}

    def claim(self, manager, iid):
        self.expire()
        with self.store.transaction() as db:
            row = self.managed(db, manager, iid)
            if row['backend_mode'] not in ('simulation', 'compose'):
                fail(501, 'unsupported', 'Planning-only profile cannot execute; choose the explicit Compose execution profile')
            if row['blocked']:
                return None
            active = db.execute("SELECT id FROM runtime_jobs WHERE instance_id=? AND status='running'", (iid,)).fetchone()
            if active:
                return None
            job = db.execute("SELECT * FROM runtime_jobs WHERE instance_id=? AND status='queued' AND revision=?", (iid, row['revision'])).fetchone()
            if job is None:
                return None
            lease = opaque()
            db.execute("UPDATE runtime_jobs SET status='running',manager_id=?,lease_hash=?,lease_until=? WHERE id=?", (manager.id, digest(lease), int(self.clock()) + self.policy.lease_seconds, job['id']))
            return {**self.result(db, iid), 'lease': lease, 'lease_until': int(self.clock()) + self.policy.lease_seconds,
                    **({'previous_process_ref': row['process_ref']} if row['backend_mode'] == 'compose' else {})}

    def leased(self, db, manager, iid, jid, revision, lease):
        row = self.managed(db, manager, iid)
        job = db.execute('SELECT * FROM runtime_jobs WHERE id=? AND instance_id=?', (jid, iid)).fetchone()
        if (job is None or job['status'] != 'running' or job['manager_id'] != manager.id
                or type(revision) is not int or revision != row['revision'] or revision != job['revision']
                or job['lease_until'] <= int(self.clock()) or not isinstance(lease, str)
                or not re.fullmatch(r'[A-Za-z0-9_-]{43}', lease)
                or not hmac.compare_digest(digest(lease), job['lease_hash'] or '')):
            fail(409, 'stale_observation', 'Stale or invalid manager lease/revision')
        return row, job

    @staticmethod
    def runtime_model_workspace(db, instance):
        if instance['backend_mode'] == 'compose' and runtime_autoprovision.is_auto(db, instance['id']):
            # The account's DS-Bot applies its own override. Its manager mount
            # supplies only the operator default, including after a key is cleared.
            return None
        return instance['workspace_id']

    def runtime_secret(self, manager, iid, jid, revision, lease, *, http_policy=None, capability=None):
        """Lease-gated resolved model API for container start. The key is not stored on the job."""
        self.expire()
        with self.store.transaction() as db:
            row, job = self.leased(db, manager, iid, jid, revision, lease)
            if job['operation_type'] not in ('create', 'start', 'restart'):
                fail(409, 'secret_not_applicable', 'Model API secret is only issued for create, start or restart')
            workspace_id = self.runtime_model_workspace(db, row)
            public, key, source = model_api.resolve(
                db, self.store, workspace_id=workspace_id, user_id=row['owner_id'] if workspace_id else None,
            )
            try:
                payload = model_api.container_payload(public, key, source, http_policy=http_policy, capability=capability)
            except model_api.ModelEndpointError as error:
                fail(409, error.code, 'Model endpoint not authorized or runtime upgrade required')
            return {'model_api_present': payload is not None, 'model_api': payload}

    def runtime_bot_social(self, manager, iid, jid, revision, lease):
        """Lease-gated resolved Bot Social server URL for container start. No token."""
        self.expire()
        with self.store.transaction() as db:
            row, job = self.leased(db, manager, iid, jid, revision, lease)
            if job['operation_type'] not in ('create', 'start', 'restart'):
                fail(409, 'bot_social_not_applicable', 'Bot Social config is only issued for create, start or restart')
            public, source = bot_social.resolve(db, workspace_id=row['workspace_id'])
            payload = bot_social.container_payload(public, source)
            if payload is not None and 'displayName' not in payload:
                # Phase C: the user's DS-Bot onboards as @<username>.home, so teammates find each
                # other by the FlyBot username. Public name only, never a credential.
                owner = db.execute('SELECT username FROM users WHERE id=?', (row['owner_id'],)).fetchone()
                name = bot_social.flatten_name(owner['username']) if owner else None
                if name:
                    payload['displayName'] = name
            return {'bot_social_present': payload is not None, 'bot_social': payload}

    def runtime_agent_bootstrap(self, manager, iid, jid, revision, lease):
        """Return the provisioned owner's initial DS-Bot data for a leased startup."""
        self.expire()
        with self.store.transaction() as db:
            row, job = self.leased(db, manager, iid, jid, revision, lease)
            if job['operation_type'] not in ('create', 'start', 'restart'):
                fail(409, 'agent_bootstrap_not_applicable', 'Personal agent bootstrap is only available for create, start or restart')
            bootstrap = None
            if runtime_autoprovision.is_auto(db, iid):
                bootstrap = dsbot_bundle.build_personal_bootstrap(db, row['owner_id'], iid, int(self.clock()))
            return {'agent_bootstrap': bootstrap}

    def heartbeat(self, manager, iid, jid, revision, lease):
        self.expire()
        with self.store.transaction() as db:
            self.leased(db, manager, iid, jid, revision, lease)
            until = int(self.clock()) + self.policy.lease_seconds
            db.execute('UPDATE runtime_jobs SET lease_until=? WHERE id=?', (until, jid))
            return {'lease_until': until}

    def observe(self, manager, iid, jid, revision, lease, observed, process_ref=None, error_code=None):
        if observed not in ('running', 'stopped', 'failed') or (process_ref is not None and (not isinstance(process_ref, str) or not ID.fullmatch(process_ref))):
            fail(400, 'invalid', 'Invalid bounded runtime observation')
        if (observed == 'failed' and error_code != 'runtime_failure') or (observed != 'failed' and error_code is not None):
            fail(400, 'invalid', 'Use only the documented runtime error code')
        self.expire()
        with self.store.transaction() as db:
            row, job = self.leased(db, manager, iid, jid, revision, lease)
            if observed != 'failed':
                if observed != row['desired'] or (observed == 'running' and process_ref is None) or (observed == 'stopped' and process_ref is not None):
                    fail(409, 'invalid_observation', 'Observation does not meet current intent')
                if job['operation_type'] == 'restart' and process_ref == row['process_ref']:
                    fail(409, 'invalid_observation', 'Restart requires a different process identity')
            status = 'failed' if observed == 'failed' else 'succeeded'
            # A new process must establish its own gateway session. Invalidate
            # the previous address/cookie before making this revision routable.
            if (status == 'succeeded' and process_ref != row['process_ref']
                    and db.execute("SELECT 1 FROM sqlite_master WHERE name='dsbot_upstreams' AND type='table'").fetchone()):
                db.execute('DELETE FROM dsbot_upstreams WHERE instance_id=?', (iid,))
            db.execute('UPDATE instances SET observed=?,observed_revision=?,health=?,process_ref=?,error_code=? WHERE id=?',
                       (observed, revision, 'healthy' if observed == 'running' else 'unknown', process_ref if observed != 'failed' else row['process_ref'], error_code, iid))
            db.execute('UPDATE runtime_jobs SET status=?,error_code=?,finished=?,lease_hash=NULL WHERE id=?', (status, error_code, int(self.clock()), jid))
            if status == 'succeeded' and job['operation_type'] == 'create' and runtime_autoprovision.is_auto(db, iid):
                self.auto_start(db, iid)
            # Receipt is for THIS job even if a follow-up intent was queued.
            return self.result(db, iid, job['operation_id'])

    def auto_start(self, db, iid):
        """Server-provisioned instances start after a confirmed create, as a new fenced revision."""
        row = db.execute('SELECT * FROM instances WHERE id=?', (iid,)).fetchone()
        if row['blocked'] or row['desired'] != 'stopped' or db.execute(
                "SELECT 1 FROM runtime_jobs WHERE instance_id=? AND status IN ('queued','running')", (iid,)).fetchone():
            return
        if db.execute('SELECT COUNT(*) FROM runtime_jobs').fetchone()[0] >= self.policy.max_jobs:
            return
        op, jid, revision = uuid4().hex, uuid4().hex, row['revision'] + 1
        db.execute("UPDATE instances SET desired='running',revision=?,operation_id=?,operation_type='start',health='unknown',error_code=NULL WHERE id=?", (revision, op, iid))
        db.execute("INSERT INTO runtime_jobs(id,instance_id,revision,operation_id,operation_type,status,created) VALUES(?,?,?,?,'start','queued',?)", (jid, iid, revision, op, int(self.clock())))

    def recover(self, manager, iid, expected_revision, operation_id, confirmation):
        """Explicit operator attestation that prior executors/actions are quiescent; never resume uncertain work.

        Creates a new fenced STOP intent. No DB-side requeue of an interrupted action,
        no automatic start, and no successful observation until the manager verifies stop.
        """
        if (type(expected_revision) is not int or expected_revision < 1 or not valid_key(operation_id)
                or confirmation != 'quiesced-executors'):
            fail(400, 'invalid', 'Explicit executor quiescence confirmation and revision/key required')
        self.expire()
        with self.store.transaction() as db:
            row = self.managed(db, manager, iid)
            if row['backend_mode'] != 'compose':
                fail(409, 'conflict', 'Recovery is defined only for the explicit Compose execution profile')
            existing = db.execute('SELECT * FROM runtime_jobs WHERE instance_id=? AND operation_id=?', (iid, operation_id)).fetchone()
            if existing:
                if existing['operation_type'] != 'recover':
                    fail(409, 'conflict', 'Operation key already used')
                return self.result(db, iid, operation_id)
            if row['revision'] != expected_revision:
                fail(409, 'conflict', 'Recovery revision changed; inspect again')
            if not row['blocked'] and row['error_code'] != 'runtime_failure':
                fail(409, 'conflict', 'Only interrupted or failed instances require recovery')
            if db.execute("SELECT id FROM runtime_jobs WHERE instance_id=? AND status IN ('running','queued')", (iid,)).fetchone():
                fail(409, 'conflict', 'Active job prevents recovery')
            self.capacity(db)
            revision, jid = row['revision'] + 1, uuid4().hex
            db.execute("UPDATE instances SET blocked=0,desired='stopped',revision=?,operation_id=?,operation_type='recover',observed='unknown',health='unknown',error_code=NULL WHERE id=?",
                       (revision, operation_id, iid))
            db.execute("INSERT INTO runtime_jobs(id,instance_id,revision,operation_id,operation_type,status,created) VALUES(?,?,?,?,'recover','queued',?)",
                       (jid, iid, revision, operation_id, int(self.clock())))
            return self.result(db, iid)

    def logs(self, owner, iid, tail=100):
        # Only structured control-plane events, never raw runtime output/secrets.
        # This deliberately does not claim to be the future runtime logs stream.
        if type(tail) is not int or not 1 <= tail <= 100:
            fail(400, 'invalid', 'tail must be 1..100')
        with self.store.connect() as db:
            self.owned(db, owner, iid)
            rows = db.execute('SELECT * FROM runtime_jobs WHERE instance_id=? ORDER BY revision DESC LIMIT ?', (iid, tail + 1)).fetchall()
            return {'source': 'control-plane-events', 'runtime_logs_supported': False, 'truncated': len(rows) > tail,
                    'items': [{k: r[k] for k in ('revision', 'operation_type', 'status', 'error_code', 'created')} for r in rows[:tail]]}
