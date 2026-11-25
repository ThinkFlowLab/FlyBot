"""Explicit simulation backend, for tests/local demos only. No FlyBot or Docker calls."""
from contextlib import contextmanager
from copy import deepcopy
import json
import threading
from uuid import uuid4

from .lifecycle import ACTIONS, ID, RuntimeFault
from .security import digest


class RuntimeFailure(Exception):
    """Only this fixed failure category crosses the manager reporting boundary."""


class FakeRuntimeBackend:
    """Memory or private SQLite fake volumes, process identities and durable receipts.

    SQL state is test-only metadata in the supplied private store, not real runtime
    volumes. A completed fake job is replayable without recycling a process twice.
    """
    def __init__(self, store=None):
        self.store = store
        self.lock = threading.RLock()
        self.state, self.receipts = {}, {}
        self.fail_next = False
        self.dispatches = []
        if store:
            with store.connect() as db:
                db.executescript('''BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS fake_runtime_state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fake_runtime_receipts (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, value TEXT NOT NULL);
COMMIT;''')

    @contextmanager
    def transaction(self):
        with self.lock:
            if self.store:
                with self.store.transaction() as db:
                    yield db
            else:
                old = deepcopy((self.state, self.receipts))
                try:
                    yield None
                except BaseException:
                    self.state, self.receipts = old
                    raise

    def read(self, db, iid):
        if db is None:
            return deepcopy(self.state.get(iid))
        row = db.execute('SELECT value FROM fake_runtime_state WHERE id=?', (iid,)).fetchone()
        return json.loads(row[0]) if row else None

    def write(self, db, iid, value):
        if db is None:
            self.state[iid] = deepcopy(value)
        else:
            db.execute('INSERT INTO fake_runtime_state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', (iid, json.dumps(value)))

    def execute(self, claim):
        instance, job = claim['instance'], claim['job']
        iid, action, jid = instance['id'], job['operation_type'], job['id']
        if (instance['backend_mode'] != 'simulation' or not ID.fullmatch(iid) or not ID.fullmatch(jid)
                or instance['volume_ref'] != 'ot-' + iid or action not in ACTIONS
                or job['instance_id'] != iid or job['revision'] != instance['revision']
                or job['operation_id'] != instance['operation']['operation_id']):
            raise RuntimeFailure('Unsupported simulation claim')
        fingerprint = digest(json.dumps([iid, action, job['revision'], job['operation_id'], instance['volume_ref']]))
        with self.transaction() as db:
            receipt = self.receipts.get(jid) if db is None else db.execute('SELECT request_hash,value FROM fake_runtime_receipts WHERE id=?', (jid,)).fetchone()
            if receipt:
                old_hash, result = receipt if db is None else (receipt['request_hash'], json.loads(receipt['value']))
                if old_hash != fingerprint:
                    raise RuntimeFailure('Conflicting simulation receipt')
                return deepcopy(result)
            if self.fail_next:
                self.fail_next = False
                raise RuntimeFailure('Injected simulation failure')
            state = self.read(db, iid)
            if action == 'create':
                if state is None:
                    state = {'volume_ref': instance['volume_ref'], 'marker': '', 'process_ref': None, 'generation': 0}
            elif state is None:
                raise RuntimeFailure('Simulation instance not created')
            if action in ('start', 'restart'):
                if action == 'restart' or state['process_ref'] is None:
                    state['process_ref'], state['generation'] = uuid4().hex, state['generation'] + 1
            elif action == 'stop':
                state['process_ref'] = None
            result = {'observed': 'running' if state['process_ref'] else 'stopped', 'process_ref': state['process_ref']}
            self.write(db, iid, state)
            if db is None:
                self.receipts[jid] = (fingerprint, deepcopy(result))
            else:
                db.execute('INSERT INTO fake_runtime_receipts VALUES(?,?,?)', (jid, fingerprint, json.dumps(result)))
            return result

    def inspect(self, iid):
        with self.transaction() as db:
            return self.read(db, iid)

    def write_marker(self, iid, value):
        # Deliberately test-only, bounded and absent from all HTTP endpoints/logs.
        if not isinstance(value, str) or len(value.encode('utf-8')) > 1024:
            raise ValueError('Simulation marker exceeds bound')
        with self.transaction() as db:
            state = self.read(db, iid)
            if state is None:
                raise RuntimeFailure('Unknown simulation instance')
            state['marker'] = value
            self.write(db, iid, state)


    def dispatch_automation(self, payload, db=None, model_api_key=None):
        """Record an automation hook. Never starts Docker or a Compose process."""
        if (not isinstance(payload, dict) or not isinstance(payload.get('automation_id'), str)
                or not isinstance(payload.get('run_id'), str) or not isinstance(payload.get('workspace_id'), str)):
            raise RuntimeFailure('Invalid automation dispatch')
        if self.fail_next:
            self.fail_next = False
            raise RuntimeFailure('Injected simulation failure')
        def instance_ids(conn):
            if conn is None or conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='instances'"
            ).fetchone() is None:
                return []
            return [row[0] for row in conn.execute(
                'SELECT id FROM instances WHERE workspace_id=? ORDER BY id', (payload['workspace_id'],))]
        def record(conn, ids):
            recorded = {
                'automation_id': payload['automation_id'],
                'workspace_id': payload['workspace_id'],
                'run_id': payload['run_id'],
                'due_at': payload.get('due_at'),
                'title': payload.get('title'),
                'instance_ids': list(ids),
                'model_api': payload.get('model_api'),
                'model_api_key_set': bool(model_api_key),
                'model_api_key_digest': digest(model_api_key) if model_api_key else None,
            }
            self.dispatches.append(recorded)
            if conn is not None and self.store:
                conn.execute('CREATE TABLE IF NOT EXISTS fake_automation_dispatches ('
                          'run_id TEXT PRIMARY KEY, value TEXT NOT NULL)')
                conn.execute(
                    'INSERT INTO fake_automation_dispatches VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET value=excluded.value',
                    (payload['run_id'], json.dumps({
                        'automation_id': payload['automation_id'],
                        'run_id': payload['run_id'],
                        'due_at': payload.get('due_at'),
                        'title': payload.get('title'),
                        'instance_ids': ids,
                    }, sort_keys=True, separators=(',', ':'))),
                )
        if db is not None:
            ids = instance_ids(db)
            record(db, ids)
        else:
            with self.transaction() as conn:
                ids = instance_ids(conn)
                record(conn, ids)
        if ids:
            return {'status': 'succeeded', 'instance_ids': ids}
        return {'status': 'skipped', 'error_code': 'no_instance', 'instance_ids': []}

class FakeManagerWorker:
    """Single explicit synchronous tick. Never installed/launched by the Web app."""
    def __init__(self, lifecycle, identity, backend):
        self.lifecycle, self.identity, self.backend = lifecycle, identity, backend

    def run_once(self, iid):
        claim = self.lifecycle.claim(self.identity, iid)
        if claim is None:
            return None
        # A simulation process can never attest a compose execution.
        if claim['instance']['backend_mode'] != 'simulation':
            raise RuntimeFailure('Simulation-only worker')
        try:
            result = self.backend.execute(claim)
        except Exception:
            # Never forward exception text, paths, environment or runtime output.
            result = {'observed': 'failed', 'error_code': 'runtime_failure'}
        return self.lifecycle.observe(self.identity, iid, claim['job']['id'], claim['job']['revision'], claim['lease'], **result)
