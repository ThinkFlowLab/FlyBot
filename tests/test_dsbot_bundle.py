"""Per-user DS-Bot import bundles (docs/DSBOT_PLUGIN_ARCHITECTURE.md §5)."""
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from uuid import uuid4

from flybot_workspace import artifacts
from flybot_workspace import dsbot_bundle
from flybot_workspace.app import App, Config
from flybot_workspace.security import digest
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = Store(Path(self.temp.name) / 'state')
        self.app = App(self.store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        self.alice, self.bob = Client(self.app), Client(self.app, peer='127.0.0.2')
        self.alice.register('alice')
        self.bob.register('bob')
        with self.store.transaction() as db:
            self.alice_id = self.user(db, 'alice')
            self.bob_id = self.user(db, 'bob')
            self.wid = self.add_workspace(db, self.alice_id, 'alice')
            self.bob_wid = self.add_workspace(db, self.bob_id, 'bob')

    def user(self, db, name):
        return db.execute('SELECT id FROM users WHERE username=?', (name,)).fetchone()[0]

    def add_workspace(self, db, owner_id, name):
        wid = uuid4().hex
        db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)',
                   (wid, owner_id, name, 1800000000, digest('workspace-key:' + wid),
                    digest('workspace-request:' + wid)))
        return wid

    def add_meeting(self, db, wid, user_id, title, key):
        mid = uuid4().hex
        db.execute('INSERT INTO meetings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                   (mid, wid, title, digest(title), 1800000000, '[]', '', '', '[]',
                    1, 1800000000, 1800000000, user_id, user_id, digest(key), digest(key)))
        return mid

    def add_automation(self, db, wid, title, key):
        aid = uuid4().hex
        schedule = {'kind': 'daily', 'time': '09:00', 'time_zone': 'Asia/Shanghai'}
        db.execute('INSERT INTO automations VALUES(?,?,?,?,?,?,?,?,1,1,?,?,?,?)',
                   (aid, wid, title, digest(title), '汇总。', 'custom',
                    json.dumps(schedule, sort_keys=True, separators=(',', ':')),
                    json.dumps(['alice']), 1800000000, 1800000000, digest(key), digest(key)))
        return aid

    def add_agent(self, db, wid, user_id, name, key):
        aid = uuid4().hex
        db.execute('INSERT INTO workspace_agents VALUES(?,?,?,?,?,?,1,?,?,?,0,?,?)',
                   (aid, wid, name, digest(name), '整理', '先列要点。', 1800000000, 1800000000,
                    user_id, digest(key), digest(key)))
        return aid

    def add_artifact(self, db, wid, user_id, title, key, body='正文', media=None):
        aid = uuid4().hex
        db.execute('INSERT INTO artifacts VALUES(?,?,?,?,?,?,1,?,?,?,?,?,?)',
                   (aid, wid, title, digest(title), 'document', body, 1800000000, 1800000000,
                    user_id, user_id, digest(key), digest(key)))
        if media is not None:
            payload, filename = media
            sha256 = artifacts.write_media(self.store.data_dir, wid, payload)
            artifacts.attach_media(db, aid, 'image/png', len(payload), sha256, filename)
        return aid

    def test_meetings_bundle_is_scoped_to_one_account_and_verifiable(self):
        with self.store.transaction() as db:
            self.add_meeting(db, self.wid, self.alice_id, '周会', 'bundle-meeting-0001')
            self.add_meeting(db, self.bob_wid, self.bob_id, 'bob 的会', 'bundle-meeting-0002')
        with self.store.connect() as db:
            bundle = dsbot_bundle.build(db, self.alice_id, 'meetings', now=1)
            before = db.execute('SELECT COUNT(*) FROM meetings').fetchone()[0]
        self.assertEqual(bundle['format'], dsbot_bundle.FORMAT)
        text = bundle['tables']['meetings']
        self.assertEqual(bundle['manifest']['meetings'],
                         {'rows': 1, 'sha256': hashlib.sha256(text.encode('utf-8')).hexdigest()})
        rows = json.loads(text)
        self.assertEqual([row['title'] for row in rows], ['周会'])
        self.assertEqual(rows[0]['workspace_id'], self.wid)
        self.assertEqual(before, 2, 'legacy rows are left untouched')
        self.assertEqual(json.loads(dsbot_bundle.dumps(bundle)), bundle)
        with self.assertRaises(ValueError):
            dsbot_bundle.build(db, 'x', 'nope')

    def test_automations_and_agents_bundles_are_scoped_to_one_account(self):
        with self.store.transaction() as db:
            self.add_automation(db, self.wid, '晨报', 'bundle-auto-0001')
            self.add_automation(db, self.bob_wid, 'bob 的报', 'bundle-auto-0002')
            self.add_agent(db, self.wid, self.alice_id, '文档助手', 'bundle-agent-0001xxxx')
            self.add_agent(db, self.bob_wid, self.bob_id, 'bob 助手', 'bundle-agent-0002xxxx')
        with self.store.connect() as db:
            auto = dsbot_bundle.build(db, self.alice_id, 'automations', now=1)
            agents = dsbot_bundle.build(db, self.alice_id, 'agents', now=1)
            before_auto = db.execute('SELECT COUNT(*) FROM automations').fetchone()[0]
            before_agents = db.execute('SELECT COUNT(*) FROM workspace_agents').fetchone()[0]
        titles = [row['title'] for row in json.loads(auto['tables']['automations'])]
        self.assertEqual(titles, ['晨报'])
        self.assertEqual(auto['feature'], 'automations')
        self.assertEqual(auto['manifest']['automations']['rows'], 1)
        names = [row['name'] for row in json.loads(agents['tables']['workspace_agents'])]
        self.assertEqual(names, ['文档助手'])
        self.assertEqual(agents['feature'], 'agents')
        self.assertEqual(before_auto, 2, 'legacy rows are left untouched')
        self.assertEqual(before_agents, 2, 'legacy rows are left untouched')

    def test_artifacts_bundle_is_scoped_to_one_account_and_includes_media(self):
        with self.store.transaction() as db:
            self.add_artifact(db, self.wid, self.alice_id, '周报', 'bundle-artifact-0001')
            self.add_artifact(db, self.bob_wid, self.bob_id, 'bob 的文档', 'bundle-artifact-0002')
            self.add_artifact(db, self.wid, self.alice_id, 'cover', 'bundle-artifact-media01',
                              body='', media=(PNG, 'dot.png'))
        with self.store.connect() as db:
            bundle = dsbot_bundle.build(db, self.alice_id, 'artifacts', now=1, data_dir=self.store.data_dir)
        rows = json.loads(bundle['tables']['artifacts'])
        self.assertEqual(sorted(row['title'] for row in rows), ['cover', '周报'])
        self.assertTrue(all(row['workspace_id'] == self.wid for row in rows))
        media = json.loads(bundle['media'])
        self.assertEqual(len(media), 1)
        self.assertEqual(bundle['manifest']['media']['rows'], 1)
        self.assertEqual(bundle['manifest']['media']['sha256'],
                         hashlib.sha256(bundle['media'].encode('utf-8')).hexdigest())
        self.assertEqual(base64.b64decode(media[0]['data']), PNG)


class PersonalBootstrapTests(unittest.TestCase):
    def test_personal_bootstrap_seeds_only_initial_roster_and_welcome(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        store = Store(Path(temp.name) / 'state')
        app = App(store, Config(ORIGIN, allow_registration=True), clock=lambda: 1800000000)
        alice, bob = Client(app), Client(app, peer='127.0.0.2')
        self.assertEqual(alice.register('alice')['status'], 201)
        self.assertEqual(bob.register('bob')['status'], 201)
        private = alice.call('POST', '/v1/personal-agent', {})['body']['personal_agent']
        other = bob.call('POST', '/v1/personal-agent', {})['body']['personal_agent']
        with store.connect() as db:
            aid = db.execute("SELECT id FROM users WHERE username='alice'").fetchone()[0]
            bundle = dsbot_bundle.build_personal_bootstrap(db, aid, 'a' * 32, 1800000000)
        self.assertEqual(bundle['instance_id'], 'a' * 32)
        tables = {name: json.loads(raw) for name, raw in bundle['tables'].items()}
        self.assertEqual(tables['personal_agents'][0]['user_id'], aid)
        self.assertTrue(all(a['workspace_id'] == private['workspace']['id'] for a in tables['workspace_agents']))
        self.assertEqual(len(tables['workspace_agents']), 11)
        self.assertEqual(len(tables['agent_messages']), 1)
        self.assertEqual(tables['agent_messages'][0]['agent_id'], private['agent']['id'])
        self.assertNotIn(other['workspace']['id'], str(bundle))
        for name, raw in bundle['tables'].items():
            self.assertEqual(bundle['manifest'][name]['sha256'], hashlib.sha256(raw.encode()).hexdigest())

if __name__ == '__main__':
    unittest.main()
