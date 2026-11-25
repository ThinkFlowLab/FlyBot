"""Single claim, bounded execute, independently inspected ready state, fenced receipt."""
import time

from .safety import ManagerError, require, instance_lock


class LeaseGuard:
    def __init__(self, client, iid, claim):
        self.client, self.iid, self.claim = client, iid, claim
        self.update(claim['lease_until'])

    def update(self, until):
        remaining = until - time.time() if type(until) is int else 0
        require(0 < remaining <= 121, 'lease_lost')
        self.deadline = time.monotonic() + remaining
        self.next_renew = time.monotonic() + min(5, remaining / 3)

    def __call__(self, force=False):
        require(time.monotonic() < self.deadline, 'lease_lost')
        if force or time.monotonic() >= self.next_renew:
            try:
                data = self.client.leased_call(self.iid, self.claim, 'heartbeat')
                self.update(data.get('lease_until'))
            except ManagerError:
                raise ManagerError('lease_lost') from None


class ManagerWorker:
    def __init__(self, client, registry, engine):
        self.client, self.registry, self.engine = client, registry, engine

    def run_once(self, iid):
        self.registry.entry(iid)
        with instance_lock(self.registry.root, iid):
            claim = self.client.claim(iid)
            if claim is None:
                return {'status': 'no_claim', 'instance_id': iid}
            try:
                self.registry.entry(iid, claim['instance'])
                guard = LeaseGuard(self.client, iid, claim)
                guard(force=True)
                action = claim['job']['operation_type']
                if action in ('create', 'start', 'restart'):
                    self.engine.install_secret(iid, self.client.runtime_secret(iid, claim), heartbeat=guard)
                    self.engine.install_bot_social(iid, self.client.runtime_bot_social(iid, claim))
                    bundle = self.client.runtime_agent_bootstrap(iid, claim)
                    self.engine.install_agent_bootstrap(iid, bundle)
                before = self.engine.inspect(iid, guard)
                if action == 'restart':
                    require(before['present'] and (before['stopped'] or before['process_ref'] is not None), 'restart_requires_container')
                if action == 'create':
                    require(before['stopped'], 'create_requires_stopped')
                # Apply a supported Compose upgrade by recreating the container.
                # The same named volume is mounted again.
                if action == 'create' and before.get('needs_recreate'):
                    action = 'create-recreate'
                elif action in ('start', 'restart') and before.get('needs_recreate'):
                    action = 'start-recreate'
                self.engine.compose(iid, action, heartbeat=guard)
                observation = self.engine.wait(iid, action, before['process_ref'], guard)
                if action == 'restart':
                    require(observation['process_ref'] != claim.get('previous_process_ref'), 'restart_identity_unchanged')
                guard(force=True)
                result = self.client.leased_call(iid, claim, 'observe', **observation)
                require(isinstance(result.get('job'), dict) and result['job'].get('id') == claim['job']['id'] and
                        result['job'].get('status') == 'succeeded' and isinstance(result.get('instance'), dict) and
                        result['instance'].get('id') == iid and result['instance'].get('observed_revision') == claim['job']['revision'], 'observe_response')
                return {'status': 'observed', 'instance_id': iid, 'job_id': claim['job']['id'], 'revision': claim['job']['revision'], **observation}
            except (ManagerError, OSError):
                # A daemon operation may outlive its CLI. Do not fabricate failed/success
                # receipts or retry; stop renewing, allowing the server's interrupted latch.
                return {'status': 'uncertain', 'instance_id': iid, 'job_id': claim['job']['id'],
                        'note': 'No receipt confirmed; inspect lease expiry and quiesce before explicit recovery'}
