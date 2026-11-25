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
* a Personal Agent chat turn creates native Bots and one shared group, with the
  same participants and room identity across the FlyBot and DS-Bot routes;
* forged routing headers, a smuggled foreign DSH cookie, no session and a
  cross-site Origin never reach the other user's runtime;
* a runtime's DSH cookie is useless against the other runtime;
* no DSH cookie is ever sent to the browser.

A fixture model runs inside one runtime's loopback. A local Bot Social container
stores its shared group. No external provider or published port is involved.
The bridge and containers are removed afterwards. Secrets are never printed.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import runpy
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
from flybot_workspace import dsbot_bundle, lifecycle, personal  # noqa: E402
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
const steps = [
  ['create_bot', { name: 'CI Team Builder', role: 'Dev', instructions: 'Build the fixture project.' }],
  ['create_bot', { name: 'CI Team Reviewer', role: 'QA', instructions: 'Review the fixture project.' }],
  ['create_group', { name: 'CI Shared Team', members: ['CI Team Builder', 'CI Team Reviewer'] }],
]

function teamResponse(body) {
  const messages = body.messages ?? []
  const request = messages.findLastIndex(message =>
    message.role === 'user' && JSON.stringify(message.content).includes('CI-CREATE-SHARED-TEAM'))
  if (request < 0) return {}
  const results = messages.slice(request + 1).filter(message => message.role === 'tool')
  if (results.length >= steps.length) return { text: 'CI-TEAM-CREATED' }
  const [name, args] = steps[results.length]
  const available = new Set((body.tools ?? []).map(tool => tool.function?.name).filter(Boolean))
  if (available.has(name)) return { call: { name, arguments: JSON.stringify(args) }, step: results.length }
  if (available.has('run_code')) {
    return { call: { name: 'run_code', arguments: JSON.stringify({
      description: 'Create the fixture team',
      code: `return await tools.${name}(${JSON.stringify(args)})`,
    }) }, step: results.length }
  }
  const guidance = messages.some(message => message.role === 'system' &&
    JSON.stringify(message.content).includes('## FlyBot personal workspace'))
  return { text: `CI-TEAM-TOOL-MISSING: ${name} (guide=${guidance}, tools=${[...available].sort().join(',')})` }
}

require('node:http').createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) { res.writeHead(404); res.end(); return }
    if (req.headers.authorization !== 'Bearer ci-fake-model-key') { res.writeHead(401); res.end('{}'); return }
    let body = {}
    try { body = JSON.parse(raw) } catch {}
    const team = teamResponse(body)
    const text = team.text ?? 'CI-DSBOT-REPLY profile=' + (raw.includes('CI-PROFILE-MARK') ? 'yes' : 'no')
    const call = team.call && { id: 'ci-team-call-' + team.step, type: 'function', function: team.call }
    const finish = call ? 'tool_calls' : 'stop'
    const base = { id: 'chatcmpl-ci', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fake-model' }
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] } : { role: 'assistant', content: text }
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) + '\n\n')
      res.end('data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const message = call ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: text }
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage }))
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


def start_runtime(name, network, instance_id, volume_id, mounts=()):
    docker('run', '--detach', '--name', name, '--network', network, '--user', '1000:1000', '--read-only',
           '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864', '--mount', f'type=volume,src={name}-data,dst=/data',
           '-e', 'DSH_TELEMETRY_DISABLED=1', '-e', 'DSH_LISTEN_PORT=8080',
           '-e', f'FLYBOT_WORKSPACE_INSTANCE_ID={volume_id}', '-e', f'FLYBOT_WORKSPACE_ROUTING_INSTANCE_ID={instance_id}',
           *mounts, IMAGE)


def start_bot_social(tmp, network, subnet, run, started):
    make_tls = runpy.run_path(str(Path(__file__).with_name('container-social-two-dsbots.py')))['make_tls']
    host, app = f'ot-gw-{run}-social', f'ot-gw-{run}-social-app'
    origin = f'https://{host}'
    ca, key, cert = make_tls(tmp, host)
    image = os.environ.get('FLYBOT_WORKSPACE_GATEWAY_BOT_SOCIAL_IMAGE')
    if not image:
        image = 'flybot-workspace-bot-social:ci-gateway'
        docker('build', '-q', '-t', image, str(ROOT / 'services' / 'bot-social'), timeout=900)
    docker('run', '--detach', '--name', app, '--network', network, '--tmpfs', '/data',
           '-e', f'PUBLIC_BASE_URL={origin}', '-e', f'TRUST_PROXY={subnet}', image)
    started.append(app)
    conf = tmp / 'social-tls.conf'
    conf.write_text(f'''server {{
  listen 443 ssl;
  server_name {host};
  ssl_certificate /tls/tls.crt;
  ssl_certificate_key /tls/tls.key;
  location / {{
    proxy_pass http://{app}:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }}
}}\n''')
    os.chmod(conf, 0o644)
    docker('run', '--detach', '--name', host, '--network', network, '--read-only',
           '--tmpfs', '/var/cache/nginx', '--tmpfs', '/var/run', '--tmpfs', '/tmp',
           '-v', f'{conf}:/etc/nginx/conf.d/default.conf:ro', '-v', f'{cert}:/tls/tls.crt:ro',
           '-v', f'{key}:/tls/tls.key:ro', NGINX)
    started.append(host)
    config = tmp / 'bot-social.json'
    config.write_text(json.dumps({'server': origin, 'displayName': 'CI Chief ' + run, 'source': 'platform'}))
    os.chmod(config, 0o644)
    return ['-v', f'{config}:/run/secrets/flybot-workspace-bot-social.json:ro',
            '-v', f'{ca}:/run/flybot-workspace-ci-ca.pem:ro',
            '-e', 'NODE_EXTRA_CA_CERTS=/run/flybot-workspace-ci-ca.pem']


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
            username = f'ci-gateway-user-{n}'
            db.execute('INSERT INTO users VALUES(?,?,?,?)', (user, username, 'x', now))
            if n == 0:
                binding, _ = personal.ensure(db, {'id': user, 'username': username}, 2, 5, 1, now)
                ws = binding['workspace_id']
                rt['personal_agent_id'] = binding['agent_id']
                rt['bootstrap'] = dsbot_bundle.build_personal_bootstrap(db, user, rt['id'], now)
            else:
                db.execute('INSERT INTO workspaces VALUES(?,?,?,?,?,?)', (ws, user, 'ci', now, f'k{n}', f'r{n}'))
            rt['workspace_id'] = ws
            db.execute("INSERT INTO instances(id,workspace_id,owner_id,profile,backend_mode,image_ref,volume_ref,desired,revision,"
                       "operation_id,operation_type,observed,observed_revision,health,process_ref,error_code,blocked,create_key,created) "
                       "VALUES(?,?,?,'flybot','compose','ci',?,'running',1,'op','create','running',1,'healthy',NULL,NULL,0,?,?)",
                       (rt['id'], ws, user, rt['name'], f'c{n}', now + n))
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
        ipam = json.loads(docker('network', 'inspect', network).stdout)[0]['IPAM']['Config'][0]
        gateway_ip = ipam['Gateway']
        runtimes = [{'name': name, 'id': uuid4().hex} for name in names]
        a, b = runtimes
        a['volume_id'], b['volume_id'] = uuid4().hex, b['id']
        os.chmod(tmp.name, 0o700)
        store = Store(os.path.join(tmp.name, 'platform'))
        now = int(time.time())
        token_a, token_b = seed(store, runtimes, now)
        bootstrap_path = Path(tmp.name) / 'personal-bootstrap.json'
        bootstrap_path.write_text(json.dumps({'agent_bootstrap': a['bootstrap']}))
        os.chmod(bootstrap_path, 0o644)
        social_mounts = start_bot_social(Path(tmp.name), network, ipam['Subnet'], run, started)
        for rt in runtimes:
            mounts = [*social_mounts, '-v', f'{bootstrap_path}:/run/secrets/flybot-workspace-runtime-key.json:ro'] if rt is a else []
            start_runtime(rt['name'], network, rt['id'], rt['volume_id'], mounts)
            started.append(rt['name'])
        for rt in runtimes:
            url = launch_url(rt['name'])
            rt['address'] = gw.validate_address(ip_on(rt['name'], network) + ':8080')
            wait_for(lambda: request(rt['address'], 'GET', '/', {'Host': rt['address']})[0] in (200, 401), f'{rt["name"]} HTTP')
            rt['cookie'] = wait_for(lambda: gw.exchange_launch_url(url, rt['address']), f'{rt["name"]} DSH session')
            SECRETS.append(rt['cookie'].split('=', 1)[1])
        with store.transaction() as db:
            for rt in runtimes:
                gw.record_upstream(db, rt['id'], rt['address'], rt['cookie'], int(time.time()))

        # A runtime's own cookie works on it, and is useless on the other runtime.
        ok = request(a['address'], 'POST', '/api/flybot-workspace', {'Host': a['address'], 'Cookie': a['cookie'],
                     'Content-Type': 'application/json'}, json.dumps({'endpoint': 'shell/identity'}))
        assert ok[0] == 200 and json.loads(ok[2])['value']['instance_id'] == a['volume_id'], 'own DSH cookie must work'
        cross = request(b['address'], 'POST', '/api/flybot-workspace', {'Host': b['address'], 'Cookie': a['cookie'],
                        'Content-Type': 'application/json'}, json.dumps({'endpoint': 'shell/identity'}))
        assert cross[0] == 401, f'A cookie must not open B runtime, got {cross[0]}'

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

        # Use the same workspace-agent routes as the real chat UI.
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

        # A migrated reply can be appended while the native Agent is already live.
        # The next two real turns must resume from the journal's native boundary.
        docker('exec', a['name'], 'node', '-e', """
          const {DatabaseSync} = require('node:sqlite')
          const db = new DatabaseSync('/data/flybot-workspace/features/agents/agents.sqlite3', {timeout:2000})
          db.prepare('INSERT INTO agent_messages VALUES(?,?,?,?,?,?,?)')
            .run('d'.repeat(32),process.argv[1],'assistant','Imported fixture reply','succeeded',
              Math.floor(Date.now()/1000),'{}')
          db.close()
        """, convo['id'])
        for prompt in ('first turn after history import', 'next turn in the same chat'):
            after_import = api(token_a, 'POST', f'{chat}/messages', {'body': prompt}, expected=201, timeout=150)
            assert after_import['reply']['status'] == 'succeeded', 'native reply after history import completed'
        docker('exec', a['name'], 'node', '--input-type=module', '-e', r"""
          import assert from 'node:assert/strict'
          import {globSync,readFileSync} from 'node:fs'
          import {createRequire} from 'node:module'
          import {pathToFileURL} from 'node:url'
          import {zstdDecompressSync} from 'node:zlib'
          const requireFromDSH = createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')
          const {sessionFormatCatalog} = await import(pathToFileURL(requireFromDSH.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
          const session = process.argv[1]
          const files = globSync('/data/sessions/**/' + session + '/session.v4.jsonl.zstd')
          assert.equal(files.length,1)
          const [header,...events] = zstdDecompressSync(readFileSync(files[0])).toString().trim().split('\n').map(JSON.parse)
          const restore = sessionFormatCatalog.createRestore(header,{recovery:'strict',validation:'current'})
          for (const event of events) restore.decodeRow(event)
          restore.finish()
          const turns = events.filter(event => event.type==='turn/start')
          assert.deepEqual(turns.map(event => event.data.turn),[1,2,3,4])
          assert.equal(turns.filter(event => event.data.source?.kind==='flybot-workspace-history').length,1)
        """, history['conversation']['native_session_id'])

        def plugin(token, endpoint, payload=None, kind='flybot-workspace'):
            status, _h, response = browse(token, 'POST', f'/b/api/{kind}',
                                          json.dumps({'endpoint': endpoint, 'payload': payload}))
            body = json.loads(response)
            assert status == 200 and body.get('ok'), f'{endpoint}: {status} {redact(body.get("error"))}'
            return body['value']

        wait_for(lambda: plugin(token_a, 'social/status').get('connected'), 'Bot Social onboarding')
        chief = api(token_a, 'GET', f'{agents}/{a["personal_agent_id"]}')['agent']
        chief_conversations = f'{agents}/{chief["id"]}/conversations'
        chief_conversation = api(token_a, 'POST', chief_conversations, {'title': 'CI Chief team setup'},
                                 expected=201)['conversation']
        chief_chat = f'{chief_conversations}/{chief_conversation["id"]}'
        acted = api(token_a, 'POST', f'{chief_chat}/messages',
                    {'body': 'CI-CREATE-SHARED-TEAM: Create a builder, a reviewer, and their shared group.'},
                    expected=201, timeout=150)['reply']
        assert acted['status'] == 'succeeded' and acted['body'] == 'CI-TEAM-CREATED', redact(acted.get('body'))
        # Reload the actual pages and read the same backing API data as the UI.
        assert browse(token_a, 'GET', '/agents')[0] == 200
        names_created = {'CI Team Builder', 'CI Team Reviewer'}
        created = [row for row in api(token_a, 'GET', agents)['items'] if row['name'] in names_created]
        assert len(created) == 2 and {row['name'] for row in created} == names_created
        assert all(row['native_bot_id'] for row in created)
        assert browse(token_a, 'GET', '/chat')[0] == 200
        groups = f'/v1/workspaces/{a["workspace_id"]}/social/conversations'
        found = [row for row in api(token_a, 'GET', groups)['items'] if row['title'] == 'CI Shared Team']
        assert len(found) == 1 and found[0]['kind'] == 'group' and found[0]['account_group']
        group = api(token_a, 'GET', f'{groups}/{found[0]["id"]}')['conversation']
        assert group['native_room_id'] and group['native_session_id'] == group['native_room_id']
        assert {agent['id'] for agent in group['agent_members']} == {row['id'] for row in created}
        native = plugin(token_a, 'flybot-workspace-group-open', {'conversation_id': group['id']}, kind='bot')
        assert native['conversation_id'] == group['id'] and native['room']['id'] == group['native_room_id']
        assert set(native['room']['members']) == {row['native_bot_id'] for row in created}
        assert api(token_b, 'GET', agents)['items'] == [], "B never sees the Bots created by A's Personal Agent"
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
                          'chief_team_creation': 'ok', 'instances': [a['id'], b['id']]}))
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
