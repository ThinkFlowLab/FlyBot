"""Trusted platform → Bot Social membership snapshot, attestation and plan."""
from pathlib import Path
import hashlib
import json
import tempfile
import unittest

from flybot_workspace import lifecycle, social_membership_migrate as migrate
from flybot_workspace.dsbot_gateway import ensure_schema as ensure_upstreams
from flybot_workspace.store import Store


def hex32(label):
    return hashlib.sha256(label.encode()).hexdigest()[:32]


class MembershipMigrateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.store = Store(self.path)
        self.owner = hex32('owner')
        self.member = hex32('member')
        self.ghost = hex32('ghost')
        self.workspace = hex32('workspace')
        self.instance = hex32('instance')
        self.now = 1_800_000_000
        with self.store.transaction() as db:
            db.executescript(lifecycle.SCHEMA)
            ensure_upstreams(db)
            for user, name in ((self.owner, 'fixture-owner'), (self.member, 'fixture-member'), (self.ghost, 'fixture-ghost')):
                db.execute('INSERT INTO users(id, username, password_hash, created) VALUES(?,?,?,?)',
                           (user, name, 'x', self.now))
            db.execute('INSERT INTO workspaces(id, owner_id, name, created, key_hash, request_hash) VALUES(?,?,?,?,?,?)',
                       (self.workspace, self.owner, 'Fixture Studio', self.now, 'k', 'r'))
            db.execute('INSERT INTO workspace_members(workspace_id, user_id, role, created, added_by) VALUES(?,?,?,?,?)',
                       (self.workspace, self.member, 'member', self.now + 1, self.owner))
            db.execute('INSERT INTO workspace_invites(id, workspace_id, token_hash, role, created, expires, created_by, max_uses, use_count, revoked) VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (hex32('invite-live'), self.workspace, hashlib.sha256(b'live-token').hexdigest(),
                        'member', self.now, self.now + 86400, self.owner, 2, 0, 0))
            db.execute('INSERT INTO workspace_invites(id, workspace_id, token_hash, role, created, expires, created_by, max_uses, use_count, revoked) VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (hex32('invite-revoked'), self.workspace, hashlib.sha256(b'revoked-token').hexdigest(),
                        'member', self.now, self.now + 86400, self.owner, 2, 0, 1))
            db.execute(
                'INSERT INTO social_conversations(id, workspace_id, kind, title, dm_key, created, updated, key_hash, request_hash) '
                'VALUES(?,?,?,?,?,?,?,?,?)',
                (hex32('convo'), self.workspace, 'group', 'Standup', None, self.now, self.now, 'ck', 'cr'))
            for user in (self.owner, self.member):
                db.execute('INSERT INTO social_members(conversation_id, workspace_id, user_id, created) VALUES(?,?,?,?)',
                           (hex32('convo'), self.workspace, user, self.now))
            db.execute(
                'INSERT INTO social_messages(id, conversation_id, workspace_id, user_id, body, seq, created, key_hash, request_hash) '
                'VALUES(?,?,?,?,?,?,?,?,?)',
                (hex32('msg'), hex32('convo'), self.workspace, self.owner, 'hello fixture', 1, self.now, 'mk', 'mr'))

    def test_canonical_digest_matches_bot_social(self):
        self.assertEqual(migrate.canonical_digest({'accounts': [], 'workspaces': []}),
                         '20f236196817f6735a91f13fa4324e35cfe10e2b0d454b15da50b75e0b64722a')
        self.assertEqual(migrate.canonical_digest({
            'accounts': [{'home_id': 'h1', 'instance_id': '0' * 32,
                          'platform_user_id': 'a' * 32, 'social_owner_id': 'own'}],
            'workspaces': [],
        }), 'c15e5844e8ab345dc65fdc430c8daa474b92ac6e2884ea40452d0dfc496fb5d5')

    def test_snapshot_uses_ids_and_millisecond_times_not_usernames(self):
        with self.store.transaction() as db:
            snapshot = migrate.build_snapshot(db)
        workspace = snapshot['workspaces'][0]
        self.assertEqual(workspace['workspace_id'], self.workspace)
        self.assertEqual(workspace['owner_platform_user_id'], self.owner)
        self.assertEqual(workspace['created_at'], self.now * 1000)
        roles = {row['platform_user_id']: row for row in workspace['members']}
        self.assertEqual(roles[self.owner]['role'], 'owner')
        self.assertEqual(roles[self.member]['role'], 'member')
        self.assertFalse(roles[self.member]['suspended'])
        self.assertTrue(all('username' not in row for row in workspace['members']))
        invites = {row['id']: row for row in workspace['invites']}
        self.assertTrue(invites[hex32('invite-revoked')]['revoked'])
        self.assertFalse(invites[hex32('invite-live')]['revoked'])
        self.assertEqual(workspace['conversations'][0]['messages'][0]['id'], hex32('msg'))
        self.assertEqual(workspace['conversations'][0]['messages'][0]['seq'], 1)

    def test_plan_blocks_workspaces_until_every_referenced_account_is_attested(self):
        with self.store.transaction() as db:
            snapshot = migrate.build_snapshot(db)
            attestation = migrate.attest_identities(db, lambda instance: {
                'social_owner_id': 'owner-social', 'home_id': 'home-1',
            })
        # No running instances yet, so the workspace stays blocked.
        planned = migrate.plan(snapshot, attestation)
        self.assertEqual(planned['ready_workspace_ids'], [])
        self.assertEqual(planned['blocked'][0]['code'], 'membership_migration_required')
        self.assertIn(self.owner, planned['blocked'][0]['missing_platform_user_ids'])

        def probe(instance):
            return {
                'social_owner_id': 'social-' + instance['platform_user_id'][:8],
                'home_id': 'home-' + instance['instance_id'][:8],
            }

        with self.store.transaction() as db:
            db.execute(
                "INSERT INTO instances(id, workspace_id, owner_id, profile, backend_mode, image_ref, volume_ref, "
                "desired, revision, operation_id, operation_type, observed, health, blocked, create_key, created) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (self.instance, self.workspace, self.owner, 'web', 'docker', 'img', 'vol-owner',
                 'running', 1, 'op', 'create', 'running', 'healthy', 0, 'ck', self.now))
            snapshot = migrate.build_snapshot(db)
            attestation = migrate.attest_identities(db, probe)
        planned = migrate.plan(snapshot, attestation)
        self.assertEqual(planned['ready_workspace_ids'], [])
        self.assertIn(self.member, planned['blocked'][0]['missing_platform_user_ids'])

    def test_ready_plan_requires_manager_attested_runtimes_not_display_names(self):
        member_ws = hex32('member-home-ws')
        member_instance = hex32('instance-member')
        with self.store.transaction() as db:
            db.execute('INSERT INTO workspaces(id, owner_id, name, created, key_hash, request_hash) VALUES(?,?,?,?,?,?)',
                       (member_ws, self.member, 'Member Home', self.now, 'k2', 'r2'))
            db.execute(
                "INSERT INTO instances(id, workspace_id, owner_id, profile, backend_mode, image_ref, volume_ref, "
                "desired, revision, operation_id, operation_type, observed, health, blocked, create_key, created) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (self.instance, self.workspace, self.owner, 'web', 'docker', 'img', 'vol-owner',
                 'running', 1, 'op', 'create', 'running', 'healthy', 0, 'ck', self.now))
            db.execute(
                "INSERT INTO instances(id, workspace_id, owner_id, profile, backend_mode, image_ref, volume_ref, "
                "desired, revision, operation_id, operation_type, observed, health, blocked, create_key, created) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (member_instance, member_ws, self.member, 'web', 'docker', 'img', 'vol-member',
                 'running', 1, 'op', 'create', 'running', 'healthy', 0, 'ck', self.now))
            snapshot = migrate.build_snapshot(db)
            attestation = migrate.attest_identities(db, lambda instance: {
                'social_owner_id': 'social-' + instance['platform_user_id'][:8],
                'home_id': 'home-' + instance['instance_id'][:8],
            })
        planned = migrate.plan(snapshot, attestation)
        self.assertEqual(planned['ready_workspace_ids'], [self.workspace, member_ws])
        self.assertEqual(planned['blocked'], [])
        self.assertEqual(len(planned['material']['accounts']), 2)
        self.assertTrue(planned['digest'])

        with self.assertRaises(ValueError):
            migrate.load_identities_file(self._write({
                'accounts': [{'username': 'fixture-owner', 'social_owner_id': 'x', 'home_id': 'y'}]
            }))

        identities = migrate.load_identities_file(self._write({
            'accounts': [
                {'platform_user_id': self.owner, 'instance_id': self.instance,
                 'social_owner_id': 'social-owner', 'home_id': 'home-owner'},
                {'platform_user_id': self.member, 'instance_id': member_instance,
                 'social_owner_id': 'social-member', 'home_id': 'home-member'},
            ]
        }))
        planned = migrate.plan(snapshot, identities)
        self.assertEqual(planned['ready_workspace_ids'], [self.workspace, member_ws])

    def test_conflicting_runtime_binding_blocks_instead_of_guessing(self):
        with self.store.transaction() as db:
            db.execute(
                "INSERT INTO instances(id, workspace_id, owner_id, profile, backend_mode, image_ref, volume_ref, "
                "desired, revision, operation_id, operation_type, observed, health, blocked, create_key, created) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (self.instance, self.workspace, self.owner, 'web', 'docker', 'img', 'vol-owner',
                 'running', 1, 'op', 'create', 'running', 'healthy', 0, 'ck', self.now))
            snapshot = migrate.build_snapshot(db)
            attestation = migrate.attest_identities(db, lambda instance: {
                'social_owner_id': 'social', 'home_id': 'home',
                'platform_user_id': self.member,
            })
        self.assertTrue(attestation['conflicts'])
        planned = migrate.plan(snapshot, attestation)
        self.assertEqual(planned['ready_workspace_ids'], [])
        self.assertEqual(planned['blocked'][0]['code'], 'membership_migration_conflict')

    def test_queued_agent_replies_are_not_imported_or_executed(self):
        with self.store.transaction() as db:
            db.execute(
                'INSERT INTO workspace_agents(id, workspace_id, name, name_hash, summary, instructions, revision, created, updated, created_by, archived, key_hash, request_hash) '
                'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (hex32('agent'), self.workspace, 'Note Bot', 'nh', 's', 'do not run', 1, self.now, self.now, self.owner, 0, 'ak', 'ar'))
            db.execute(
                'INSERT INTO social_agent_replies(id, conversation_id, workspace_id, agent_id, agent_name, '
                'requested_by, prompt, agent_revision, status, body, seq, created, updated, key_hash, request_hash) '
                'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (hex32('queued'), hex32('convo'), self.workspace, hex32('agent'), 'Note Bot',
                 self.owner, 'go', 1, 'queued', '', None, self.now, self.now, 'qk', 'qr'))
            db.execute(
                'INSERT INTO social_agent_replies(id, conversation_id, workspace_id, agent_id, agent_name, '
                'requested_by, prompt, agent_revision, status, body, seq, created, updated, key_hash, request_hash) '
                'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (hex32('done'), hex32('convo'), self.workspace, hex32('agent'), 'Note Bot',
                 self.owner, 'go', 1, 'succeeded', 'noted', 2, self.now, self.now, 'dk', 'dr'))
            snapshot = migrate.build_snapshot(db)
        messages = snapshot['workspaces'][0]['conversations'][0]['messages']
        ids = [row['id'] for row in messages]
        self.assertEqual(ids, [hex32('msg'), hex32('done')])
        self.assertEqual([row['seq'] for row in messages], [1, 2])
        self.assertEqual(messages[1]['author_kind'], 'agent')
        self.assertEqual(messages[1]['body'], 'noted')

    def _write(self, payload):
        path = Path(self.temp.name) / 'identities.json'
        path.write_text(json.dumps(payload), encoding='utf-8')
        return path


if __name__ == '__main__':
    unittest.main()
