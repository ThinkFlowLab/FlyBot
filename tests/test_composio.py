"""Platform boundaries for the connector API and its public callback."""
from pathlib import Path
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from flybot_workspace import composio
from flybot_workspace.app import App, Config
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN

ALICE_KEY = 'ak_alice_fake_composio_key_0001'


class ComposioTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                       clock=lambda: 1800000000)
        self.alice = Client(self.app)
        self.assertEqual(self.alice.register('alice')['status'], 201)

    def assert_no_connector_state(self):
        with self.app.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM composio_keys').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM composio_connections').fetchone()[0], 0)

    def test_private_connector_routes_refuse_central_reads_and_writes(self):
        connection = '/v1/composio/connections/' + 'a' * 32
        routes = (
            ('GET', '/v1/composio', None),
            ('POST', '/v1/composio/key', {'api_key': ALICE_KEY}),
            ('POST', '/v1/composio/key', {'api_key': None}),
            ('GET', '/v1/composio/toolkits?search=git', None),
            ('GET', '/v1/composio/connections', None),
            ('POST', '/v1/composio/connections', {'toolkit': 'github'}),
            ('GET', connection, None),
            ('POST', connection + '/disconnect', {}),
        )
        clients = (('owner', self.alice), ('signed-out', Client(self.app)))
        with patch.object(composio, 'Client') as transport, patch.dict(os.environ, {'COMPOSIO_API_KEY': ALICE_KEY}):
            for actor, client in clients:
                for method, path, body in routes:
                    with self.subTest(actor=actor, method=method, path=path):
                        result = client.call(method, path, body)
                        self.assertEqual(result['status'], 410)
                        self.assertEqual(result['body']['error']['code'], 'moved_to_dsbot')
                        self.assertNotIn(ALICE_KEY, json.dumps(result))
            transport.assert_not_called()
        self.assert_no_connector_state()

    def test_callback_page_changes_nothing_and_bounces_to_connectors(self):
        anonymous = Client(self.app)
        with patch.object(composio, 'Client') as transport:
            result = anonymous.call('GET', '/v1/composio/callback?status=success&connected_account_id=ca_x',
                                    origin=None, parse='raw')
            self.assertEqual(result['status'], 200)
            self.assertIn(b'url=/settings/connectors', result['body'])
            self.assertNotIn(b'ca_x', result['body'])
            denied = anonymous.call('POST', '/v1/composio/callback')
            self.assertEqual(denied['status'], 405)
            transport.assert_not_called()
        self.assert_no_connector_state()

    def test_client_repr_and_errors_hide_the_key(self):
        client = composio.Client(ALICE_KEY, transport=lambda *a: (500, b''))
        self.assertNotIn(ALICE_KEY, repr(client))
        with self.assertRaises(composio.ComposioError) as caught:
            client.list_toolkits()
        self.assertNotIn(ALICE_KEY, str(caught.exception))
        with self.assertRaises(composio.ComposioError):
            composio.Client(None)


if __name__ == '__main__':
    unittest.main()
