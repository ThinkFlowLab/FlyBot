#!/usr/bin/env python3
"""CI proof: the platform gateway routes each user to their OWN DS-Bot, and only there.

Two real runtime containers (two users' DS-Bots) and a real nginx edge using the
config rendered by ``flybot_workspace.dsbot_gateway.nginx_config`` run on one
test-scoped Docker bridge. The platform authorizer (``GatewayApp``) runs on the
runner, bound to that bridge's gateway address only. The proof drives the edge
as a browser would:

* each user's ``/b/api/flybot-workspace/page?path=/chat/`` is served by @flybot-workspace/web
  inside *their* DS-Bot (instance marker + the real FlyBot chat page);
* ``POST /b/api/flybot-workspace``, ``POST /b/api/bot`` and a private workspace-agent turn
  execute in their own DS-Bot;
* forged routing headers, a smuggled foreign DSH cookie, no session and a
  cross-site Origin never reach the other user's runtime;
* a runtime's DSH cookie is useless against the other runtime;
* no DSH cookie is ever sent to the browser.

A fixture model runs inside one runtime's loopback. No external provider, Bot
Social or published port is involved. The bridge and containers are removed
afterwards. Secrets (DSH tokens/cookies) are never printed.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from uuid import uuid4
from wsgiref.simple_server import make_server

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from flybot_workspace import dsbot_gateway as gw  # noqa: E402
from flybot_workspace import lifecycle  # noqa: E402
from flybot_workspace.security import digest  # noqa: E402
from flybot_workspace.server import QuietHandler, ThreadedWSGIServer  # noqa: E402
from flybot_workspace.store import Store  # noqa: E402

IMAGE = sys.argv[1] if len(sys.argv) > 1 else 'flybot-workspace-flybot:test'
NGINX = os.environ.get('FLYBOT_WORKSPACE_GATEWAY_NGINX_IMAGE', 'nginx:1.27-alpine')
COOKIE = 'ot_dev_session'
SECRETS: list[str] = []

FAKE_MODEL_WRITE = r"""
const fs = require('node:fs')
fs.mkdirSync('/data/secrets', { recursive: true, mode: 0o700 })
fs.writeFileSync('/data/secrets/model-api.json', JSON.stringify({ provider: 'openai', api_key: 'ci-fake-model-key',
  base_url: 'http://127.0.0.1:18799/v1', model: 'fake-model' }), { mode: 0o600 })
"""
FAKE_MODEL_SERVER = r"""
require('node:http').createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) { res.writeHead(404); res.end(); return }
    if (req.headers.authorization !== 'Bearer ci-fake-model-key') { res.writeHead(401); res.end('{}'); return }
    let body = {}
    try { body = JSON.parse(raw) } catch {}
    const text = 'CI-DSBOT-REPLY profile=' + (raw.includes('CI-PROFILE-MARK') ? 'yes' : 'no')
    const base = { id: 'chatcmpl-ci', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-model' }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n')
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
  })
}).listen(18799, '127.0.0.1')
"""
FAKE_MODEL_PROBE = r"""
const s = require('node:net').connect(18799, '127.0.0.1', () => { s.end(); process.exit(0) })
s.on('error', () => process.exit(1))
"""


def redact(text):
    out = str(text or '')
    for value in SECRETS:
        if value:
            out = out.replace(value, '[redacted]')
    return re.sub(r'token=[A-Za-z0-9_-]+', 'token=[redacted]', out)


def docker(*args, check=True, timeout=180):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(f'docker {args[0]} failed: {redact(result.stderr)}')
    return result


def ip_on(container, network):
    return docker('inspect', '-f', '{{(index .NetworkSettings.Networks "%s").IPAddress}}' % network, container).stdout.strip()


def request(address, method, path, headers=None, body=None, timeout=20):
    host, port = address.split(':')
    conn = http.client.HTTPConnection(host, int(port), timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        return response.status, response.headers, response.read()
    finally:
        conn.close()


def wait_for(fn, what, seconds=90):
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        try:
            value = fn()
            if value:
                return value
        except Exception as error:  # noqa: BLE001 - retried until the deadline
            last = error
        time.sleep(0.5)
    raise RuntimeError(f'timed out waiting for {what}: {redact(last)}')


def start_runtime(name, network, instance_id, volume_id):
    docker('run', '--detach', '--name', name, '--network', network, '--user', '1000:1000', '--read-only',
           '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864', '--mount', f'type=volume,src={name}-data,dst=/data',
           '-e', 'DSH_TELEMETRY_DISABLED=1', '-e', 'DSH_LISTEN_PORT=8080',
           '-e', f'FLYBOT_WORKSPACE_INSTANCE_ID={volume_id}', '-e', f'FLYBOT_WORKSPACE_ROUTING_INSTANCE_ID={instance_id}', IMAGE)


def launch_url(name):
    def found():
        logs = docker('logs', name, check=False)
        match = re.search(r'http://[0-9.]+:8080/\?token=[^\s]+', logs.stdout + '\n' + logs.stderr)
        return match[0] if match else None
    url = wait_for(found, f'{name} launch URL')
    SECRETS.append(url.split('token=', 1)[1])
    return url


def seed(store, runtimes, now):
    tokens = []
    with store.transaction() as db:
        db.executescript(lifecycle.SCHEMA)
        gw.ensure_schema(db)
        for n, rt in enumerate(runtimes):
            user, ws = uuid4().hex, uuid4().hex
            rt['workspace_id'] = ws
            db.execute('INSERT INTO users VALUES(?,?,?,?)', (user, f'ci-gateway-user-{n}', 'x', now))
            db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)', (ws, user, 'ci', now, f'k{n}', f'r{n}'))
            db.execute("INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,desired,revision,"
                       "operation_id,operation_type,observed,observed_revision,health,process_ref,error_code,blocked,create_key,created) "
                       "VALUES(?,?,?,'flybot','compose','ci',?,'running',1,'op','create','running',1,'healthy',NULL,NULL,0,?,?)",
                       (rt['id'], ws, user, rt['name'], f'c{n}', now + n))
            gw.record_upstream(db, rt['id'], rt['address'], rt['cookie'], now)
            token = secrets.token_urlsafe(32)
            SECRETS.append(token)
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?)', (digest(token), digest('csrf'), user, now + 3600, now))
            tokens.append(token)
    return tokens


def main():
    run = uuid4().hex[:10]
    network = f'ot-gw-{run}'
    names = [f'ot-gw-{run}-a', f'ot-gw-{run}-b']
    edge = f'ot-gw-{run}-edge'
    started = []
    httpd = None
    tmp = tempfile.TemporaryDirectory()
    try:
        docker('network', 'create', '--driver', 'bridge', '--label', 'io.flybot-workspace.ci=gateway', network)
        gateway_ip = json.loads(docker('network', 'inspect', network).stdout)[0]['IPAM']['Config'][0]['Gateway']
        runtimes = []
        for index, name in enumerate(names):
            rt = {'name': name, 'id': uuid4().hex}
            rt['volume_id'] = uuid4().hex if index == 0 else rt['id']
            start_runtime(name, network, rt['id'], rt['volume_id'])
            started.append(name)
            runtimes.append(rt)
        for rt in runtimes:
            url = launch_url(rt['name'])
            rt['address'] = gw.validate_address(ip_on(rt['name'], network) + ':8080')
            wait_for(lambda: request(rt['address'], 'GET', '/', {'Host': rt['address']})[0] in (200, 401), f'{rt["name"]} HTTP')
            rt['cookie'] = wait_for(lambda: gw.exchange_launch_url(url, rt['address']), f'{rt["name"]} DSH session')
            SECRETS.append(rt['cookie'].split('=', 1)[1])
        a, b = runtimes

        # A runtime's own cookie works on it, and is useless on the other runtime.
        ok = request(a['address'], 'POST', '/api/flybot-workspace', {'Host': a['address'], 'Cookie': a['cookie'],
                     'Content-Type': 'application/json'}, json.dumps({'endpoint': 'shell/identity'}))
        assert ok[0] == 200 and json.loads(ok[2])['value']['instance_id'] == a['volume_id'], 'own DSH cookie must work'
        cross = request(b['address'], 'POST', '/api/flybot-workspace', {'Host': b['address'], 'Cookie': a['cookie'],
                        'Content-Type': 'application/json'}, json.dumps({'endpoint': 'shell/identity'}))
        assert cross[0] == 401, f'A cookie must not open B runtime, got {cross[0]}'

        os.chmod(tmp.name, 0o700)
        store = Store(os.path.join(tmp.name, 'platform'))
        now = int(time.time())
        token_a, token_b = seed(store, runtimes, now)
        key = secrets.token_urlsafe(32)
        SECRETS.append(key)
        httpd = make_server(gateway_ip, 0, lambda e, s: None, handler_class=QuietHandler, server_class=ThreadedWSGIServer)
        platform_port = httpd.server_port

        def platform(env, start):
            start('200 OK', [('Content-Type', 'text/plain')])
            return [b'platform']
        conf = gw.nginx_config(gw.load_routes(), f'{gateway_ip}:{platform_port}', 8081, key=key)
        conf_path = Path(tmp.name) / 'edge.conf'
        conf_path.write_text(conf)
        os.chmod(conf_path, 0o644)
        docker('run', '--detach', '--name', edge, '--network', network, '--read-only',
               '--tmpfs', '/var/cache/nginx', '--tmpfs', '/var/run', '--tmpfs', '/tmp',
               '-v', f'{conf_path}:/etc/nginx/conf.d/default.conf:ro', NGINX)
        started.append(edge)
        edge_address = ip_on(edge, network) + ':8081'
        public_origin = 'http://' + edge_address
        httpd.set_app(gw.mount(platform, gw.GatewayApp(store, public_origin, COOKIE, key)))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        wait_for(lambda: request(edge_address, 'GET', '/v1/x')[0] == 200, 'edge')

        def browse(token, method, path, body=None, **extra):
            headers = {'Host': edge_address}
            if token:
                headers['Cookie'] = f'{COOKIE}={token}'
            if method != 'GET':
                headers.update({'Origin': public_origin, 'Content-Type': 'application/json'})
            headers.update(extra)
            return request(edge_address, method, path, headers, body)

        pages = {}
        for token, rt in ((token_a, a), (token_b, b)):
            status, headers, body = browse(token, 'GET', '/b/api/flybot-workspace/page?path=%2Fchat%2F')
            assert status == 200, f'page via gateway: {status} {redact(body[:200])}'
            assert headers.get('x-flybot-workspace-served-by') == f'ds-bot; instance={rt["volume_id"]}', 'served by own DS-Bot'
            html = body.decode()
            assert f'<meta name="flybot-workspace-instance" content="{rt["volume_id"]}">' in html
            assert 'chat' in html.lower() and '<script' in html, 'the real FlyBot chat page is bundled'
            assert not headers.get_all('Set-Cookie'), 'no DSH cookie may reach the browser'
            pages[rt['id']] = html
            status, _h, body = browse(token, 'POST', '/b/api/flybot-workspace', json.dumps({'endpoint': 'shell/identity'}))
            value = json.loads(body)['value']
            assert status == 200 and value['instance_id'] == rt['volume_id'] and value['served_by'] == 'ds-bot'
            status, _h, body = browse(token, 'POST', '/b/api/bot', json.dumps({'endpoint': 'state', 'payload': {}}))
            result = json.loads(body)
            assert status == 200 and result['ok'] and isinstance(result['value']['bots'], list), 'DS-Bot executes behind the gateway'
            status, _h, _b = browse(token, 'GET', '/b/')
            assert status == 200, f'DSH web index through the gateway: {status}'

        # Moved page: /chat/ itself is served by each user's own DS-Bot.
        for token, rt in ((token_a, a), (token_b, b)):
            status, headers, body = browse(token, 'GET', '/chat/')
            assert status == 200 and headers.get('x-flybot-workspace-served-by') == f'ds-bot; instance={rt["volume_id"]}', f'/chat/ moved: {status}'
            asset = re.search(rb'href="(/chat/assets/[0-9a-f]{32}/chat/dsbot\.mjs)"', body)
            assert asset, 'chat page preloads its release-scoped adapter'
            status, headers, _b = browse(token, 'GET', asset[1].decode())
            assert status == 200 and headers.get('ETag', '').startswith('"sha256-'), 'chat adapter bundled'
        # User A cannot steer to B: forged routing headers and B's own DSH cookie are dropped.
        status, headers, _b = browse(token_a, 'GET', '/b/api/flybot-workspace/page?path=%2Fchat%2F',
                                     **{'X-OT-Upstream': b['address'], 'X-OT-Instance': b['id'],
                                        'Cookie': f'{COOKIE}={token_a}; {b["cookie"]}'})
        assert status == 200 and headers['x-flybot-workspace-served-by'] == f'ds-bot; instance={a["volume_id"]}', 'A stays on A'
        status, _h, _b = browse(token_a, 'GET', f'/b/api/flybot-workspace/page?path=%2Fchat%2F&instance={b["id"]}')
        assert _h['x-flybot-workspace-served-by'].endswith(a['volume_id'])
        # No session: never reaches any runtime (redirect to platform sign-in).
        status, headers, _b = browse(None, 'GET', '/b/api/flybot-workspace/page?path=%2Fchat%2F')
        assert status == 302 and headers['Location'] == '/login', f'no session: {status}'
        status, _h, _b = browse(None, 'GET', '/b/', Cookie=b['cookie'])
        assert status == 302, 'a smuggled DSH cookie alone opens nothing'
        # Cross-site writes are refused before routing.
        status, _h, _b = browse(token_a, 'POST', '/b/api/bot', json.dumps({'endpoint': 'state'}), Origin='https://evil.example')
        assert status == 403, f'cross-site write: {status}'
        # The authorizer itself is not reachable from outside.
        status, _h, _b = browse(token_a, 'GET', '/v1/platform/route')
        assert status == 404
        # Platform paths stay on the platform.
        status, _h, body = browse(token_a, 'GET', '/v1/auth/session')
        assert status == 200 and body == b'platform'
        assert pages[a['id']] != pages[b['id']]

        # B1: private chat executes as a native DS-Bot turn inside A's own runtime.
        # A labeled fake OpenAI-compatible model runs on A's loopback; the operator
        # model file is the one the manager would install (fake key, CI only).
        docker('exec', a['name'], 'node', '-e', FAKE_MODEL_WRITE)
        docker('exec', '-d', a['name'], 'node', '-e', FAKE_MODEL_SERVER)
        wait_for(lambda: docker('exec', a['name'], 'node', '-e', FAKE_MODEL_PROBE, check=False).returncode == 0, 'fake model')

        def api(token, method, path, payload=None, expected=200, timeout=20):
            headers = {'Host': edge_address, 'Cookie': f'{COOKIE}={token}', 'Origin': public_origin}
            if payload is not None:
                headers.update({'Content-Type': 'application/json', 'Idempotency-Key': uuid4().hex})
            status, _h, body = request(edge_address, method, path, headers,
                                       json.dumps(payload) if payload is not None else None, timeout=timeout)
            assert status == expected, f'{method} {path}: {status} {redact(body[:300])}'
            return json.loads(body)

        # Use the same workspace-agent routes as the real chat UI. An unseeded
        # runtime has no personal binding; the Compose lifecycle test proves
        # signup/manager bootstrapping separately.
        agents = f'/v1/workspaces/{a["workspace_id"]}/agents'
        agent = api(token_a, 'POST', agents, {'name': 'CI assistant', 'instructions': 'CI-PROFILE-MARK'},
                    expected=201)['agent']
        assert agent['served_by'] == 'ds-bot' and agent['native_bot_id'], 'agent has an owned native Bot'
        conversations = f'{agents}/{agent["id"]}/conversations'
        convo = api(token_a, 'POST', conversations, {'title': 'CI chat'}, expected=201)['conversation']
        chat = f'{conversations}/{convo["id"]}'
        sent = api(token_a, 'POST', f'{chat}/messages', {'body': 'hello from the CI test account'},
                   expected=201, timeout=150)
        reply = sent['reply']
        assert reply['status'] == 'succeeded', 'native DS-Bot reply completed'
        assert reply['body'].startswith('CI-DSBOT-REPLY'), f'reply: {redact(reply["body"][:200])}'
        assert 'profile=yes' in reply['body'], 'agent instructions reach the DS-Bot turn'
        history = api(token_a, 'GET', chat)
        assert history['conversation']['native_session_id'], 'private chat uses a native Session'
        assert [m['role'] for m in history['items']] == ['user', 'assistant']
        assert api(token_b, 'GET', agents)['items'] == [], "B never sees A's agents"
        api(token_b, 'GET', chat, expected=404)
        # An old volume can retain its native identity while using its
        # canonical manager-issued ID in external Agent API keys.
        external_key = api(token_a, 'POST', f'{agents}/{agent["id"]}/api-keys',
                           {'name': 'CI gateway'}, expected=201)['token']
        SECRETS.append(external_key)
        assert external_key.startswith(f'ota_{a["id"]}_'), 'key must route through the canonical instance'
        bearer = {'Authorization': f'Bearer {external_key}'}
        status, _h, body = browse(None, 'POST', f'/v1/gateway/agents/{agent["id"]}/invocations',
                                  json.dumps({'prompt': 'hello through the Agent API'}),
                                  **bearer, **{'Idempotency-Key': uuid4().hex})
        assert status == 202, f'Agent API invocation: {status} {redact(body[:200])}'
        invocation_id = json.loads(body)['invocation']['id']

        def invocation_done():
            status, _h, body = browse(None, 'GET', f'/v1/gateway/invocations/{invocation_id}', **bearer)
            assert status == 200, f'Agent API poll: {status} {redact(body[:200])}'
            invocation = json.loads(body)['invocation']
            return invocation if invocation['status'] not in ('queued', 'running') else None

        result = wait_for(invocation_done, 'native external Agent API reply', seconds=120)
        assert result['status'] == 'succeeded' and result['engine'] == 'ds-bot'
        assert result['reply'].startswith('CI-DSBOT-REPLY')
        print(json.dumps({'gateway_isolation': 'ok', 'runtimes': 2, 'served_by': 'ds-bot', 'chat': 'ds-bot-native',
                          'instances': [a['id'], b['id']]}))
    except Exception as error:
        for name in started:
            logs = docker('logs', '--tail', '80', name, check=False)
            print(f'--- {name} logs ---\n{redact(logs.stdout)}\n{redact(logs.stderr)}', file=sys.stderr)
        print('gateway isolation failed:', redact(error), file=sys.stderr)
        raise SystemExit(1)
    finally:
        if httpd is not None:
            httpd.shutdown()
        for name in started:
            docker('rm', '-f', name, check=False)
        for name in names:
            docker('volume', 'rm', '-f', f'{name}-data', check=False)
        docker('network', 'rm', network, check=False)
        tmp.cleanup()


if __name__ == '__main__':
    main()
