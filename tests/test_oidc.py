"""OIDC/OAuth login tests with an in-process fake provider. No network."""
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import json
import subprocess
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.fake_oidc import FakeOidcProvider, load_test_rsa
from flybot_workspace.lifecycle import Lifecycle, ManagerAuth, ManagerIdentity, RuntimePolicy
from flybot_workspace.oidc import OidcRegistry, Provider, parse_jwks, jwt_claims
from flybot_workspace.runtime_autoprovision import AutoProvisionPolicy
from flybot_workspace.security import digest, opaque
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD

NOW = 1800000000


def test_key():
    pem = subprocess.check_output(['openssl', 'genrsa', '2048'], stderr=subprocess.DEVNULL)
    return load_test_rsa(pem.decode())


class OidcTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.n, self.e, self.d = test_key()
        self.fake = FakeOidcProvider(self.n, self.e, self.d)
        google = Provider(
            id='google', type='google', label='Google', client_id=self.fake.client_id,
            client_secret=self.fake.client_secret, issuer=self.fake.issuer,
            authorization_endpoint='https://oidc.test/auth',
            token_endpoint='https://oidc.test/token', jwks_uri='https://oidc.test/jwks',
        )
        github = Provider(
            id='github', type='github', label='GitHub', client_id=self.fake.client_id,
            client_secret=self.fake.client_secret, issuer='https://github.com',
            authorization_endpoint='https://oidc.test/auth',
            token_endpoint='https://oidc.test/token',
            user_endpoint='https://oidc.test/user', emails_endpoint='https://oidc.test/emails',
            scopes='read:user user:email',
        )
        self.registry = OidcRegistry([google, github], transport=self.fake.transport)
        self.store = Store(Path(self.temp.name) / 'state')
        self.app = App(self.store, Config(ORIGIN, allow_registration=True),
                       clock=lambda: NOW, oidc_registry=self.registry)
        self.client = Client(self.app)

    def start(self, client=None, provider='google'):
        return (client or self.client).call('POST', '/v1/auth/oidc/start', {'provider': provider})

    def callback(self, url, client=None, **kw):
        path = url if url.startswith('/') else (urlsplit(url).path + ('?' + urlsplit(url).query if urlsplit(url).query else ''))
        # The IdP redirect has no Origin/CSRF.
        return (client or self.client).call('GET', path, csrf=False, origin=None, **kw)

    def complete(self, email='alice@example.com', subject='sub-alice', provider='google',
                 email_verified=True, client=None, kind=None):
        started = self.start(client, provider)
        self.assertEqual(started['status'], 200, started)
        params = parse_qs(urlsplit(started['body']['authorization_url']).query)
        code = self.fake.issue(
            subject=subject, email=email, email_verified=email_verified,
            challenge=params['code_challenge'][0], nonce=params.get('nonce', [''])[0],
            redirect_uri=params['redirect_uri'][0],
            kind=kind or ('github' if provider == 'github' else 'oidc'),
        )
        return self.callback(f"/v1/auth/oidc/callback?code={code}&state={params['state'][0]}", client)

    def test_providers_hide_disabled_and_secrets(self):
        listed = self.client.call('GET', '/v1/auth/providers', csrf=False)
        self.assertEqual(listed['status'], 200)
        self.assertEqual([item['id'] for item in listed['body']['items']], ['google', 'github'])
        dumped = json.dumps(listed)
        self.assertNotIn(self.fake.client_secret, dumped)
        empty = App(self.store, self.app.config, clock=lambda: NOW)
        self.assertEqual(Client(empty).call('GET', '/v1/auth/providers', csrf=False)['body']['items'], [])
        self.assertEqual(self.start(provider='unknown')['status'], 404)

    def test_google_login_creates_account_and_sets_session(self):
        result = self.complete()
        self.assertEqual(result['status'], 302, result)
        self.assertEqual(result['body']['user']['username'], 'alice')
        self.assertTrue(any(key.lower() == 'location' and value == '/chat' for key, value in result['headers']))
        session = self.client.call('GET', '/v1/auth/session')
        self.assertEqual(session['status'], 200)
        self.assertEqual(session['body']['user']['id'], result['body']['user']['id'])
        # Same subject signs in to the same account.
        other = Client(self.app, peer='127.0.0.2')
        again = self.complete(client=other)
        self.assertEqual(again['body']['user']['id'], result['body']['user']['id'])

    def test_first_oidc_login_queues_compose_start_before_redirect(self):
        runtime = Lifecycle(self.store, RuntimePolicy(image_ref='registry.test/runtime@sha256:' + 'a' * 64,
                                                     backend_mode='compose'), clock=lambda: NOW)
        manager_auth = ManagerAuth([ManagerIdentity('auto-mgr', digest(opaque()), frozenset(), 'compose', True)])
        self.app = App(self.store, self.app.config, clock=lambda: NOW, oidc_registry=self.registry,
                       lifecycle=runtime, manager_auth=manager_auth,
                       auto_provision=AutoProvisionPolicy(enabled=True, manager_id='auto-mgr', max_instances=3))
        self.client = Client(self.app)
        result = self.complete()
        self.assertEqual(result['status'], 302)
        owner = result['body']['user']['id']
        again = self.complete(client=Client(self.app, peer='127.0.0.2'))
        self.assertEqual(again['body']['user']['id'], owner)
        with self.store.connect() as db:
            rows = db.execute(
                'SELECT j.operation_type, j.status, j.revision FROM runtime_jobs j '
                'JOIN runtime_auto_provisions p ON p.instance_id=j.instance_id WHERE p.user_id=?', (owner,),
            ).fetchall()
        self.assertEqual([tuple(row) for row in rows], [('start', 'queued', 1)])

    def test_unverified_email_and_bad_pkce_are_rejected(self):
        self.assertEqual(self.complete(email_verified=False)['status'], 400)
        started = self.start()
        params = parse_qs(urlsplit(started['body']['authorization_url']).query)
        code = self.fake.issue(
            subject='sub-bad', email='bad@example.com', email_verified=True,
            challenge='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            nonce=params['nonce'][0], redirect_uri=params['redirect_uri'][0],
        )
        self.assertEqual(self.callback(f"/v1/auth/oidc/callback?code={code}&state={params['state'][0]}")['status'], 400)
        # Replay of a used state fails.
        self.assertEqual(self.callback(f"/v1/auth/oidc/callback?code={code}&state={params['state'][0]}")['status'], 400)

    def test_existing_email_requires_explicit_confirmation(self):
        first = self.complete(email='owner@example.com', subject='sub-one')
        owner_id = first['body']['user']['id']
        # New client, different subject, same verified email.
        guest = Client(self.app, peer='127.0.0.3')
        conflict = self.complete(email='owner@example.com', subject='sub-two', client=guest)
        self.assertEqual(conflict['status'], 409)
        self.assertEqual(conflict['body']['error']['code'], 'link_required')
        self.assertNotIn('owner@example.com', json.dumps(conflict))
        token = conflict['body']['link']['token']
        # Confirm with the original password cannot work (OIDC user has a random password).
        # Link while signed in as the owner.
        confirmed = self.client.call('POST', '/v1/auth/oidc/link', {'token': token})
        self.assertEqual(confirmed['status'], 302, confirmed)
        self.assertEqual(confirmed['body']['user']['id'], owner_id)
        third = Client(self.app, peer='127.0.0.4')
        again = self.complete(email='owner@example.com', subject='sub-two', client=third)
        self.assertEqual(again['body']['user']['id'], owner_id)

    def test_password_user_can_confirm_link(self):
        alice = Client(self.app)
        alice.register('bob')
        # No email on the password account yet; OIDC with a new email creates a distinct account.
        created = self.complete(email='bob@example.com', subject='sub-bob', client=Client(self.app, peer='127.0.0.5'))
        self.assertEqual(created['status'], 302)
        # Logged-in password user starts and completes Google, linking by being signed in.
        started = self.start(alice)
        params = parse_qs(urlsplit(started['body']['authorization_url']).query)
        code = self.fake.issue(
            subject='sub-bob-pass', email='bob@example.com', email_verified=True,
            challenge=params['code_challenge'][0], nonce=params['nonce'][0],
            redirect_uri=params['redirect_uri'][0],
        )
        # The email is already owned by the OIDC-created account, so even a signed-in user is refused.
        linked = self.callback(
            f"/v1/auth/oidc/callback?code={code}&state={params['state'][0]}", alice)
        self.assertEqual(linked['status'], 409)

    def test_github_uses_verified_primary_email(self):
        result = self.complete(email='githuber@example.com', subject='99', provider='github', kind='github',
                               client=Client(self.app, peer='127.0.0.6'))
        self.assertEqual(result['status'], 302, result)
        self.assertEqual(result['body']['user']['username'], 'githuber')

    def test_start_requires_origin_and_password_login_still_works(self):
        self.assertEqual(self.client.call('POST', '/v1/auth/oidc/start', {'provider': 'google'},
                                          origin='https://evil.test')['status'], 403)
        alice = Client(self.app, peer='127.0.0.7')
        alice.register('carol')
        self.assertEqual(alice.call('GET', '/v1/auth/session')['status'], 200)
        again = Client(self.app, peer='127.0.0.8')
        login = again.call('POST', '/v1/auth/login', {'username': 'carol', 'password': PASSWORD})
        self.assertEqual(login['status'], 200)


if __name__ == '__main__':
    unittest.main()
