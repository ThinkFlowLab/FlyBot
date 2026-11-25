"""Self-service profile and public handle projection (issue #130). In-process WSGI."""
from pathlib import Path
import sqlite3
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state'
        self.app = App(Store(self.path), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.alice.register('alice')
        self.bob = Client(self.app, peer='127.0.0.2')
        self.bob.register('bob')

    def save(self, client, revision, changes):
        return client.call('POST', '/v1/profile', {'revision': revision, 'changes': changes})

    def create(self, client=None, **changes):
        body = {'name': 'Alice', 'bio': '做产品的人。', 'tags': ['产品', '旅行'],
                'gender': 'female', 'location': '杭州', 'website': 'https://example.com',
                'goals': {'health': '每周跑两次', 'career': '做出一个好产品'}}
        body.update(changes)
        return self.save(client or self.alice, 0, body)

    def test_create_read_update_and_public_projection(self):
        self.assertEqual(self.alice.call('GET', '/v1/profile')['body']['profile'], None)
        created = self.create()
        self.assertEqual(created['status'], 201, created)
        profile = created['body']['profile']
        self.assertEqual(profile['handle'], 'alice')
        self.assertEqual(profile['name'], 'Alice')
        self.assertEqual(profile['tags'], ['产品', '旅行'])
        self.assertEqual(profile['goals']['health'], '每周跑两次')
        self.assertEqual(profile['revision'], 1)
        seen = self.alice.call('GET', '/v1/profile')['body']['profile']
        self.assertEqual(seen['handle'], 'alice')
        public = self.alice.call('GET', '/v1/profiles/alice')
        self.assertEqual(public['status'], 200)
        self.assertEqual(public['body']['profile']['handle'], 'alice')
        self.assertNotIn('goals', public['body']['profile'])
        self.assertNotIn('revision', public['body']['profile'])
        updated = self.save(self.alice, 1, {
            'handle': 'alice.dev', 'bio': '新的简介。', 'tags': ['产品'],
            'goals': {'health': '每天散步'}})
        self.assertEqual(updated['status'], 200, updated)
        self.assertEqual(updated['body']['profile']['handle'], 'alice.dev')
        self.assertEqual(updated['body']['profile']['revision'], 2)
        self.assertEqual(self.alice.call('GET', '/v1/profiles/alice')['status'], 404)
        self.assertEqual(self.alice.call('GET', '/v1/profiles/alice.dev')['status'], 200)
        stale = self.save(self.alice, 1, {'bio': 'stale'})
        self.assertEqual(stale['status'], 409)
        self.assertEqual(stale['body']['error']['current']['revision'], 2)
        same = self.save(self.alice, 2, {'bio': '新的简介。'})
        self.assertEqual(same['status'], 200)
        self.assertEqual(same['body']['profile']['revision'], 2)
        with sqlite3.connect(self.path / 'management.sqlite3') as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_handle_validation_uniqueness_and_isolation(self):
        self.create()
        self.assertEqual(self.save(self.alice, 1, {'handle': 'Admin'})['status'], 400)
        self.assertEqual(self.save(self.alice, 1, {'handle': 'a'})['status'], 400)
        self.assertEqual(self.save(self.alice, 1, {'handle': 'a..b'})['status'], 400)
        self.assertEqual(self.save(self.alice, 1, {'handle': '.alice'})['status'], 400)
        self.assertEqual(self.save(self.alice, 1, {'handle': 'settings'})['status'], 400)
        bob = self.create(self.bob, name='Bob')
        self.assertEqual(bob['status'], 201)
        self.assertEqual(bob['body']['profile']['handle'], 'bob')
        taken = self.save(self.bob, 1, {'handle': 'alice'})
        self.assertEqual(taken['status'], 409, taken)
        self.assertEqual(self.bob.call('GET', '/v1/profiles/alice')['body']['profile']['name'], 'Alice')
        self.assertEqual(self.alice.call('GET', '/v1/profile')['body']['profile']['handle'], 'alice')

    def test_bounds_and_csrf(self):
        cases = [
            {'name': ''},
            {'name': 'x' * 41},
            {'bio': 'x' * 201},
            {'tags': ['t%d' % i for i in range(9)]},
            {'tags': ['x'] * 2},
            {'tags': ['x' * 21]},
            {'location': 'x' * 81},
            {'website': 'ftp://example.com'},
            {'website': 'https://user:pass@example.com'},
            {'gender': 'unknown'},
            {'goals': {'unknown': 'x'}},
            {'goals': {'health': 'x' * 201}},
        ]
        for changes in cases:
            self.assertEqual(self.save(self.alice, 0, changes)['status'], 400, changes)
        self.assertEqual(self.alice.call('POST', '/v1/profile', {'revision': 0, 'changes': {'name': 'A'}},
                                         csrf=False)['status'], 403)
        self.assertEqual(self.alice.call('GET', '/v1/profiles/nobody')['status'], 404)
        self.assertEqual(self.alice.call('GET', '/v1/profiles/a')['status'], 404)

    def test_public_profile_page_escapes_and_hides_private_goals(self):
        created = self.create(name='<b>Alice</b>', bio='<script>alert(1)</script>',
                             tags=['<x>', '产品'])
        self.assertEqual(created['status'], 201)
        page = self.alice.call('GET', '/p/alice', parse='raw', csrf=False, origin=None)
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('&lt;b&gt;Alice&lt;/b&gt;', html)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', html)
        self.assertNotIn('<script>', html)
        self.assertIn('&lt;x&gt;', html)
        self.assertIn('产品', html)
        self.assertNotIn('每周跑两次', html)
        csp = dict(page['headers'])['Content-Security-Policy']
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIn("default-src 'none'", csp)
        self.assertEqual(self.alice.call('GET', '/p/nobody', parse='raw', csrf=False, origin=None)['status'], 404)
        self.assertEqual(self.alice.call('POST', '/p/alice', parse='raw', csrf=False, origin=None)['status'], 400)
        self.assertEqual(self.alice.call('GET', '/p/alice?x=1', parse='raw', csrf=False, origin=None)['status'], 400)
        self.alice.call('POST', '/v1/profile', {'revision': 1, 'changes': {'handle': 'alice.dev'}})
        self.assertEqual(self.alice.call('GET', '/p/alice', parse='raw', csrf=False, origin=None)['status'], 404)
        self.assertEqual(self.alice.call('GET', '/p/alice.dev', parse='raw', csrf=False, origin=None)['status'], 200)
        self.assertEqual(self.alice.call('GET', '/v1/profiles/alice.dev')['status'], 200)



if __name__ == '__main__':
    unittest.main()
