#!/usr/bin/env python3
"""CI proof (phase C): two users' own DS-Bots collaborate through a real Bot Social.

One test-scoped Docker bridge runs:
* a real Bot Social built from ``services/bot-social`` behind a TLS terminator (nginx, a throwaway
  CA made on the runner, path prefix /social, the same public-URL shape as the isolated site);
* two FlyBot runtime containers (two users' DS-Bots). Each gets the Bot Social URL the way the
  compose manager delivers it: a read-only ``/run/secrets/flybot-workspace-bot-social.json`` holding only
  ``{server, displayName}``. Each DS-Bot onboards itself (``@flybot/social``) and keeps its own
  connector token on its own volume.

The proof drives each user's ``POST /api/flybot-workspace`` (the @flybot-workspace/web plugin inside that
user's DS-Bot, DSH-authenticated with that runtime's own session cookie):
team create -> invite -> accept (members), a DM and a team group with messages and unread counts
(messenger), and a Discover publish/follow. Bot Social relays only shared state; it never sees the
other user's DSH session, and no connector token appears in any container log.

No model, firewall, proxy or published port is involved; everything is removed afterwards.
Secrets (DSH launch tokens, cookies, connector tokens) are never printed.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from flybot_workspace import dsbot_gateway as gw  # noqa: E402

IMAGE = sys.argv[1] if len(sys.argv) > 1 else 'flybot-workspace-flybot:test'
NGINX = os.environ.get('FLYBOT_WORKSPACE_GATEWAY_NGINX_IMAGE', 'nginx:1.27-alpine')
SECRETS: list[str] = []


def redact(text):
    out = str(text or '')
    for value in SECRETS:
        if value:
            out = out.replace(value, '[redacted]')
    return re.sub(r'token=[A-Za-z0-9_-]+', 'token=[redacted]', out)


def run(*args, check=True, timeout=900, cwd=None):
    result = subprocess.run(list(args), capture_output=True, text=True, timeout=timeout, cwd=cwd)
    if check and result.returncode != 0:
        raise RuntimeError(f'{args[0]} {args[1] if len(args) > 1 else ""} failed: {redact(result.stderr[-2000:])}')
    return result


def docker(*args, check=True, timeout=900):
    return run('docker', *args, check=check, timeout=timeout)


def ip_on(container, network):
    return docker('inspect', '-f', '{{(index .NetworkSettings.Networks "%s").IPAddress}}' % network, container).stdout.strip()


def wait_for(fn, what, seconds=120):
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        try:
            value = fn()
            if value:
                return value
        except Exception as error:  # noqa: BLE001 - retried until the deadline
            last = error
        time.sleep(1)
    raise RuntimeError(f'timed out waiting for {what}: {redact(last)}')


def make_tls(tmp, name):
    ca_key, ca, key, csr, crt, ext = (tmp / n for n in ('ca.key', 'ca.pem', 'tls.key', 'tls.csr', 'tls.crt', 'ext.cnf'))
    run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=flybot-workspace-ci-ca',
        '-keyout', str(ca_key), '-out', str(ca))
    run('openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', f'/CN={name}', '-keyout', str(key), '-out', str(csr))
    ext.write_text(f'subjectAltName=DNS:{name}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n')
    run('openssl', 'x509', '-req', '-in', str(csr), '-CA', str(ca), '-CAkey', str(ca_key), '-CAcreateserial',
        '-days', '1', '-extfile', str(ext), '-out', str(crt))
    for path in (ca, key, crt):
        os.chmod(path, 0o644)
    return ca, key, crt


class Runtime:
    def __init__(self, name, network):
        self.name = name
        self.network = network
        self.address = None
        self.cookie = None

    def start(self, config_path, ca_path):
        docker('run', '--detach', '--name', self.name, '--network', self.network, '--user', '1000:1000', '--read-only',
               '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864', '--mount', f'type=volume,src={self.name}-data,dst=/data',
               '-v', f'{config_path}:/run/secrets/flybot-workspace-bot-social.json:ro',
               '-v', f'{ca_path}:/run/flybot-workspace-ci-ca.pem:ro',
               '-e', 'NODE_EXTRA_CA_CERTS=/run/flybot-workspace-ci-ca.pem',
               '-e', 'DSH_TELEMETRY_DISABLED=1', '-e', 'DSH_LISTEN_PORT=8080',
               '-e', f'FLYBOT_WORKSPACE_INSTANCE_ID={uuid4().hex}', IMAGE)

    def connect(self):
        def found():
            logs = docker('logs', self.name, check=False)
            match = re.search(r'http://[0-9.]+:8080/\?token=[^\s]+', logs.stdout + '\n' + logs.stderr)
            return match[0] if match else None
        url = wait_for(found, f'{self.name} launch URL')
        SECRETS.append(url.split('token=', 1)[1])
        self.address = gw.validate_address(ip_on(self.name, self.network) + ':8080')
        self.cookie = wait_for(lambda: gw.exchange_launch_url(url, self.address), f'{self.name} DSH session')
        SECRETS.append(self.cookie.split('=', 1)[1])

    def raw(self, endpoint, payload=None):
        host, port = self.address.split(':')
        conn = http.client.HTTPConnection(host, int(port), timeout=60)
        try:
            conn.request('POST', '/api/flybot-workspace', body=json.dumps({'endpoint': endpoint, 'payload': payload}),
                         headers={'Host': self.address, 'Cookie': self.cookie, 'Content-Type': 'application/json'})
            response = conn.getresponse()
            data = response.read()
        finally:
            conn.close()
        assert response.status == 200, f'{endpoint}: HTTP {response.status}'
        return json.loads(data)

    def call(self, endpoint, payload=None):
        result = self.raw(endpoint, payload)
        assert result.get('ok'), f'{self.name} {endpoint}: {redact(json.dumps(result.get("error")))}'
        return result['value']

    def token(self):
        out = docker('exec', self.name, 'node', '-e',
                     "process.stdout.write(JSON.parse(require('fs').readFileSync('/data/bot/flybot-social.json','utf8')).token||'')",
                     check=False).stdout.strip()
        if out:
            SECRETS.append(out)
        return out


def main():
    run_id = uuid4().hex[:8]
    network = f'ot-soc-{run_id}'
    social_host = f'botsocial-{run_id}'
    social_app = f'ot-soc-{run_id}-app'
    started, volumes = [], []
    tmp_dir = tempfile.TemporaryDirectory()
    tmp = Path(tmp_dir.name)
    os.chmod(tmp, 0o755)
    try:
        docker('network', 'create', '--driver', 'bridge', '--label', 'io.flybot-workspace.ci=social', network)
        social_image = f'flybot-workspace-bot-social:ci-{run_id}'
        docker('build', '-q', '-t', social_image, str(ROOT / 'services' / 'bot-social'), timeout=1200)
        docker('run', '--detach', '--name', social_app, '--network', network, '--tmpfs', '/data',
               '-e', 'HOST=0.0.0.0', '-e', 'PORT=8787', '-e', f'PUBLIC_BASE_URL=https://{social_host}/social',
               '-e', 'TRUST_PROXY=172.16.0.0/12,10.0.0.0/8,192.168.0.0/16', social_image)
        started.append(social_app)
        ca, key, crt = make_tls(tmp, social_host)
        conf = tmp / 'tls.conf'
        conf.write_text(
            'server {\n  listen 443 ssl;\n  server_name %s;\n  ssl_certificate /tls/tls.crt;\n  ssl_certificate_key /tls/tls.key;\n'
            '  client_max_body_size 2m;\n  location = /social { return 308 /social/; }\n'
            '  location ^~ /social/ {\n    proxy_pass http://%s:8787/;\n    proxy_set_header Host $host;\n'
            '    proxy_set_header X-Forwarded-For $remote_addr;\n    proxy_set_header X-Forwarded-Proto https;\n'
            '    proxy_set_header X-Forwarded-Prefix /social;\n  }\n}\n' % (social_host, social_app))
        os.chmod(conf, 0o644)
        docker('run', '--detach', '--name', social_host, '--network', network, '--network-alias', social_host,
               '--read-only', '--tmpfs', '/var/cache/nginx', '--tmpfs', '/var/run', '--tmpfs', '/tmp',
               '-v', f'{conf}:/etc/nginx/conf.d/default.conf:ro', '-v', f'{crt}:/tls/tls.crt:ro', '-v', f'{key}:/tls/tls.key:ro', NGINX)
        started.append(social_host)

        people = []
        for label in ('a', 'b'):
            name = f'ot-soc-{run_id}-{label}'
            config = tmp / f'bot-social-{label}.json'
            # Exactly what the compose manager writes: server URL + display name, never a token.
            config.write_text(json.dumps({'server': f'https://{social_host}/social', 'displayName': f'ci{label}{run_id}', 'source': 'platform'}))
            os.chmod(config, 0o644)
            rt = Runtime(name, network)
            rt.start(config, ca)
            started.append(name)
            volumes.append(f'{name}-data')
            people.append(rt)
        for rt in people:
            rt.connect()
        a, b = people

        # Each DS-Bot joined Bot Social on its own and reports its own home handle.
        status = {}
        for rt in people:
            status[rt.name] = wait_for(lambda rt=rt: (lambda s: s if s.get('connected') else None)(rt.call('social/status')),
                                       f'{rt.name} Bot Social onboarding', seconds=180)
        ha, hb = status[a.name]['handle'], status[b.name]['handle']
        assert ha != hb and ha.endswith('.home') and hb.endswith('.home'), 'two distinct homes'
        assert ha.startswith(f'cia{run_id}'), f'home handle follows the manager display name: {ha}'

        # Members: team, invite, accept.
        team = a.call('teams/create', {'name': f'CI team {run_id}'})
        denied = b.raw('teams/get', {'team_id': team['id']})
        assert not denied['ok'] and denied['error']['code'] == 'social/team_not_found', 'non-member sees nothing'
        invite = a.call('invites/create', {'team_id': team['id'], 'max_uses': 1})
        assert b.call('invites/accept', {'code': invite['code']})['status'] == 'member'
        roster = a.call('members/list', {'team_id': team['id']})
        assert sorted(m['handle'] for m in roster['members']) == sorted([ha, hb])

        # Messenger: DM and a team group, delivered through Bot Social between the two DS-Bots.
        dm = a.call('messenger/openDm', {'handle': hb})
        a.call('messenger/send', {'conversation_id': dm['id'], 'body': f'hello from A {run_id}', 'client_key': 'ci-1'})
        inbox = b.call('messenger/list')
        assert inbox['unread'] == 1, f'B sees one unread message, got {inbox["unread"]}'
        page = b.call('messenger/messages', {'conversation_id': dm['id']})
        assert [m['body'] for m in page['messages']] == [f'hello from A {run_id}']
        assert page['messages'][0]['author']['handle'] == ha
        b.call('messenger/read', {'conversation_id': dm['id']})
        assert b.call('messenger/list')['unread'] == 0
        group = b.call('messenger/createGroup', {'title': 'CI group', 'team_id': team['id'], 'members': [ha]})
        b.call('messenger/send', {'conversation_id': group['id'], 'body': f'@{ha} group ping'})
        notes = a.call('social/notifications')
        assert any(n['kind'] == 'messenger.mention' for n in notes['notifications']), 'mention notification reached A'
        assert [m['body'] for m in a.call('messenger/messages', {'conversation_id': group['id']})['messages']] == [f'@{ha} group ping']

        # Discover: A publishes, B follows and finds it.
        b.call('discover/follow', {'handle': ha})
        a.call('discover/publish', {'kind': 'work', 'ref': 'ci-work', 'slug': f'ci-{run_id}', 'title': 'CI work', 'work_kind': 'document'})
        feed = b.call('discover/feed', {'tab': 'following'})
        assert [i['slug'] for i in feed['items']] == [f'ci-{run_id}']

        # Connector tokens stay on each user's volume: never in any container log.
        tokens = [rt.token() for rt in people]
        assert all(tokens) and tokens[0] != tokens[1], 'each DS-Bot keeps its own connector token'
        for name in started:
            logs = docker('logs', name, check=False)
            text = logs.stdout + logs.stderr
            for t in tokens:
                assert t not in text, f'connector token leaked into {name} logs'
        print(f'two-DS-Bot Bot Social proof ok: {ha} and {hb} (team, invite, DM, group, mention, discover)')
    except Exception:
        for name in started:
            logs = docker('logs', '--tail', '60', name, check=False)
            print(f'--- {name} ---\n{redact(logs.stdout[-4000:])}\n{redact(logs.stderr[-4000:])}', file=sys.stderr)
        raise
    finally:
        for name in reversed(started):
            docker('rm', '-f', name, check=False)
        for volume in volumes:
            docker('volume', 'rm', '-f', volume, check=False)
        docker('network', 'rm', network, check=False)
        tmp_dir.cleanup()


if __name__ == '__main__':
    main()
