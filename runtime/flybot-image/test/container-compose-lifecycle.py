#!/usr/bin/env python3
"""CI proof of a real Compose Manager with a digest-pinned DS-Bot image.

A loopback registry supplies the digest of the just-built image. The manager
starts the runtime and passes in the personal agent bundle. The native plugin
imports the binding and keeps it, alongside the data volume, across a recreate.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4
from wsgiref.simple_server import make_server

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from flybot_workspace.app import App, Config
from flybot_workspace.dsbot_gateway import GatewayApp, exchange_launch_url, mount, validate_address
from flybot_workspace.lifecycle import Lifecycle, ManagerAuth, ManagerIdentity, RuntimePolicy
from flybot_workspace.manager.client import ManagerClient
from flybot_workspace.manager.engine import IMAGE, ComposeEngine, Registry, Runner
from flybot_workspace.manager.safety import write_new
from flybot_workspace.manager.worker import ManagerWorker
from flybot_workspace.security import digest, opaque
from flybot_workspace.runtime_autoprovision import AutoProvisionPolicy
from flybot_workspace.server import QuietHandler, ThreadedWSGIServer
from flybot_workspace.store import Store
from tests.test_management import Client


HEALTHCHECK = ['CMD', 'node', '/opt/flybot-workspace/runtime/flybot-image/healthcheck.mjs']
POLL_SECONDS = 90
PLUGIN_CANDIDATES = (
    '/usr/libexec/docker/cli-plugins/docker-compose',
    '/usr/lib/docker/cli-plugins/docker-compose',
    '/usr/local/lib/docker/cli-plugins/docker-compose',
)


def redact(text, secrets):
    out = text if isinstance(text, str) else str(text or '')
    for secret in secrets:
        if secret:
            out = out.replace(secret, '[redacted]')
    return out


def require(ok, message, secrets=()):
    if not ok:
        raise RuntimeError(redact(message, secrets))


def describe_error(error, secrets):
    parts = [type(error).__name__, str(error)]
    for attr in ('returncode', 'stdout', 'stderr'):
        value = getattr(error, attr, None)
        if value not in (None, ''):
            parts.append('%s=%s' % (attr, value))
    return redact(' '.join(parts), secrets)


def trace_engine(engine, secrets):
    def wrap(method):
        def wrapped(*args, **kwargs):
            try:
                return method(*args, **kwargs)
            except Exception as error:
                print('compose engine %s: %s' % (method.__name__, describe_error(error, secrets)), file=sys.stderr)
                raise
        return wrapped

    engine.inspect = wrap(engine.inspect)
    engine.compose = wrap(engine.compose)
    engine.wait = wrap(engine.wait)
    engine.install_agent_bootstrap = wrap(engine.install_agent_bootstrap)
    return engine


def docker(args, *, allow_failure=False, timeout=180, secrets=()):
    result = subprocess.run(['docker', *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0 and not allow_failure:
        detail = redact((result.stdout or '') + '\n' + (result.stderr or ''), secrets)
        raise RuntimeError('docker %s failed (%s): %s' % (args[0], result.returncode, detail))
    return result


def wait_until(desc, fn, timeout=POLL_SECONDS, secrets=()):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(0.4)
    raise RuntimeError(redact('timed out waiting for %s: %r' % (desc, last), secrets))


def copy_regular(src, dest, mode=0o700):
    real = os.path.realpath(src)
    require(os.path.isfile(real) and not os.path.islink(dest) if os.path.exists(dest) else True,
            'refusing to copy over a symlink')
    shutil.copy2(real, dest)
    os.chmod(dest, mode)
    info = os.lstat(dest)
    require(stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode), 'copied file must be regular')
    return dest


def find_compose_plugin():
    for path in PLUGIN_CANDIDATES:
        if os.path.isfile(os.path.realpath(path)):
            return path
    return None


def pin_local_image(tag, secrets):
    """Push the just-built image to a loopback registry and return name@sha256."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    name = 'ot-ci-registry-%s' % uuid4().hex[:12]
    docker([
        'run', '--detach', '--name', name, '--network', 'bridge',
        '-p', '127.0.0.1:%s:5000' % port,
        'registry:2',
    ], secrets=secrets, timeout=180)
    target = '127.0.0.1:%s/flybot-workspace-flybot:ci' % port
    try:
        def registry_ready():
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=1):
                    return True
            except OSError:
                return None
        wait_until('loopback registry accept connections', registry_ready, timeout=30, secrets=secrets)
        docker(['tag', tag, target], secrets=secrets)
        docker(['push', target], secrets=secrets, timeout=180)
        inspected = docker(['image', 'inspect', target], secrets=secrets)
        digests = json.loads(inspected.stdout)[0].get('RepoDigests') or []
        prefix = '127.0.0.1:%s/flybot-workspace-flybot@sha256:' % port
        pinned = next((item for item in digests if item.startswith(prefix) and IMAGE.fullmatch(item)), None)
        require(pinned is not None, 'local registry did not return a matching repo digest: %r' % digests)
        return name, pinned
    except Exception:
        docker(['rm', '--force', name], allow_failure=True, secrets=secrets)
        raise


def native_binding(cid, network, secrets):
    address = docker(['inspect', '-f', '{{(index .NetworkSettings.Networks "%s").IPAddress}}' % network, cid],
                     secrets=secrets).stdout.strip() + ':8080'
    address = validate_address(address)

    def launch_url():
        logs = docker(['logs', cid], allow_failure=True, secrets=secrets)
        match = re.search(r'http://[0-9.]+:8080/\?token=[^\s]+', logs.stdout + '\n' + logs.stderr)
        return match[0] if match else None

    url = wait_until('DSH launch URL', launch_url, secrets=secrets)
    secrets.append(url.split('token=', 1)[1])
    cookie = exchange_launch_url(url, address)
    secrets.append(cookie.split('=', 1)[1])
    host, port = address.split(':')
    conn = HTTPConnection(host, int(port), timeout=POLL_SECONDS)
    try:
        conn.request('POST', '/api/flybot-workspace',
                     body=json.dumps({'endpoint': 'agents/personal-binding', 'payload': {}}),
                     headers={'Host': address, 'Cookie': cookie, 'Content-Type': 'application/json'})
        response = conn.getresponse()
        result = json.loads(response.read())
        require(response.status == 200 and result.get('ok'), 'native personal binding lookup failed')
        return result['value'], address, cookie
    finally:
        conn.close()


def compose_container_id(iid, secrets):
    result = docker(['ps', '-aq', '-f', 'label=com.docker.compose.project=ot-%s' % iid,
                     '-f', 'label=com.docker.compose.service=flybot'], secrets=secrets)
    ids = result.stdout.split()
    require(len(ids) == 1, 'expected one compose flybot container, got %r' % ids)
    return ids[0]


def diagnose_container(cid, iid, image_ref, secrets):
    raw = docker(['inspect', cid], allow_failure=True, secrets=secrets)
    if raw.returncode != 0:
        print(redact('compose inspect diagnosis failed: %s %s' % (raw.stdout, raw.stderr), secrets), file=sys.stderr)
        return
    data = json.loads(raw.stdout)[0]
    host, config, mounts, state = data.get('HostConfig') or {}, data.get('Config') or {}, data.get('Mounts') or [], data.get('State') or {}
    summary = {
        'Privileged': host.get('Privileged'),
        'ReadonlyRootfs': host.get('ReadonlyRootfs'),
        'User': config.get('User'),
        'CapDrop': host.get('CapDrop'),
        'CapAdd': host.get('CapAdd'),
        'Devices': host.get('Devices'),
        'PidMode': host.get('PidMode'),
        'IpcMode': host.get('IpcMode'),
        'NetworkMode': host.get('NetworkMode'),
        'expectedNetwork': 'ot-%s_default' % iid,
        'SecurityOpt': host.get('SecurityOpt'),
        'PortBindings': host.get('PortBindings'),
        'Binds': host.get('Binds'),
        'Image': config.get('Image'),
        'expectedImage': image_ref,
        'Status': state.get('Status'),
        'Restarting': state.get('Restarting'),
        'Mounts': [
            {'Type': item.get('Type'), 'Destination': item.get('Destination'), 'RW': item.get('RW'),
             'Name': item.get('Name'), 'Propagation': item.get('Propagation')}
            for item in mounts
        ],
    }
    print('compose inspect diagnosis: ' + redact(json.dumps(summary, default=str), secrets), file=sys.stderr)


def main(argv):
    if len(argv) != 2:
        print('usage: python3 runtime/flybot-image/test/container-compose-lifecycle.py <image>', file=sys.stderr)
        return 2
    image = argv[1]
    if not shutil.which('docker'):
        print('this proof runs in CI with Docker; docker is not available here', file=sys.stderr)
        return 2
    if docker(['image', 'inspect', image], allow_failure=True).returncode != 0:
        print('image %s is not present; build it first' % image, file=sys.stderr)
        return 2
    plugin = find_compose_plugin()
    if plugin is None:
        print('docker compose plugin not found in the well-known libexec paths', file=sys.stderr)
        return 2
    docker_bin = shutil.which('docker')
    socket_path = '/run/docker.sock' if os.path.exists('/run/docker.sock') else '/var/run/docker.sock'
    if not os.path.exists(socket_path):
        print('docker socket not found', file=sys.stderr)
        return 2

    secrets = []
    registry_name = None
    httpd = None
    iid = None
    volume = None
    network = None
    # Runner.trusted_path rejects group/world-writable ancestors. GitHub Actions
    # sets TMPDIR to a 0775 workspace path, so the operator root must live under
    # sticky, root-owned /tmp rather than the default TemporaryDirectory location.
    temp = tempfile.TemporaryDirectory(prefix='ot-compose-bootstrap-', dir='/tmp')
    try:
        os.chmod(temp.name, 0o700)
        root = Path(temp.name) / 'operator'
        root.mkdir(mode=0o700)
        copy_regular(docker_bin, str(root / 'docker'))
        home_plugins = root / 'docker-home' / 'cli-plugins'
        # Runner also creates docker-home; pre-create so we can drop the plugin.
        (root / 'docker-home').mkdir(mode=0o700)
        home_plugins.mkdir(mode=0o700)
        copy_regular(plugin, str(home_plugins / 'docker-compose'))

        registry_name, image_ref = pin_local_image(image, secrets)
        require(IMAGE.fullmatch(image_ref), 'digest pin failed the existing image regex: %s' % image_ref)

        store = Store(Path(temp.name) / 'state')
        policy = RuntimePolicy(image_ref=image_ref, profile='local-compose', backend_mode='compose', lease_seconds=60)
        lifecycle = Lifecycle(store, policy)
        httpd = make_server('127.0.0.1', 0, lambda *a: None, handler_class=QuietHandler, server_class=ThreadedWSGIServer)
        loopback_origin = 'http://127.0.0.1:%s' % httpd.server_address[1]
        manager_token = opaque()
        secrets.append(manager_token)
        app = App(
            store, Config(loopback_origin, insecure_local=True, allow_registration=True),
            lifecycle=lifecycle,
            manager_auth=ManagerAuth([
                ManagerIdentity('manager-a', digest(manager_token), frozenset(), 'compose', auto_provisioned=True),
            ]),
            auto_provision=AutoProvisionPolicy(enabled=True, manager_id='manager-a', max_instances=1),
        )
        httpd.set_app(mount(app, GatewayApp(store, loopback_origin, app.config.cookie_names[0], opaque(),
                                         manager_auth=app.manager_auth)))
        threading.Thread(target=httpd.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True).start()

        class ApiClient(Client):
            def __init__(self, app, origin):
                super().__init__(app)
                self.origin_value = origin

            def call(self, method, path, body=None, headers=None, raw=None, csrf=True, origin=None, parse='json'):
                origin = self.origin_value if origin is None else origin
                extra = {'HTTP_HOST': urlsplit(self.origin_value).netloc}
                if origin:
                    extra['HTTP_HOST'] = urlsplit(origin).netloc
                extra.update(headers or {})
                return super().call(method, path, body, extra, raw, csrf, origin, parse)

        user = ApiClient(app, loopback_origin)
        require(user.register('alice')['status'] == 201, 'register failed')
        readiness_path = '/v1/auth/runtime-readiness?include=personal-chat'
        initial = user.call('GET', readiness_path)
        require(initial['status'] == 200 and initial['body']['state'] == 'starting',
                'signup did not queue the personal runtime')
        enrolled = user.call('POST', '/v1/personal-agent')
        require(enrolled['status'] == 200, 'personal agent already seeded by signup')
        personal = enrolled['body']['personal_agent']
        provision = personal['runtime_provisioning']
        require(provision['state'] == 'existing' and provision['readiness'] == 'starting',
                'personal agent did not reuse signup provisioning')
        iid = provision['instance_id']
        volume = 'ot-' + iid
        network = volume + '_default'
        binding = {'workspace_id': personal['workspace']['id'], 'agent_id': personal['agent']['id']}
        require(initial['body']['personal_chat'] == binding, 'readiness did not return the signup binding')
        instance = user.call('GET', f'/v1/instances/{iid}')
        require(instance['status'] == 200, 'provisioned instance not found')
        require(instance['body']['instance']['image_ref'] == image_ref, 'instance did not pin the digest')
        require(instance['body']['instance']['backend_mode'] == 'compose', 'instance is not compose mode')

        write_new(root / 'manager.json', {
            'version': 1,
            'execution_enabled': True,
            'base_url': loopback_origin,
            'server_host': urlsplit(loopback_origin).netloc,
            'manager_id': 'manager-a',
            'token': manager_token,
            'docker': str(root / 'docker'),
            'socket': socket_path,
            'instances': {iid: {'image': image_ref, 'healthcheck': HEALTHCHECK, 'publish_port': None}},
        })
        registry = Registry(str(root / 'manager.json'))
        engine = trace_engine(ComposeEngine(registry, Runner(registry, enabled=True)), secrets)
        client = ManagerClient(loopback_origin, 'manager-a', manager_token, enabled=True, timeout=5)
        worker = ManagerWorker(client, registry, engine)

        running = worker.run_once(iid)
        if running.get('status') != 'observed' or running.get('observed') != 'running':
            try:
                diagnose_container(compose_container_id(iid, secrets), iid, image_ref, secrets)
                logs = docker(['logs', compose_container_id(iid, secrets)], allow_failure=True, secrets=secrets)
                print(redact(logs.stdout + '\n' + logs.stderr, secrets), file=sys.stderr)
            except Exception as error:
                print(redact('compose inspect diagnosis unavailable: %s' % error, secrets), file=sys.stderr)
            raise RuntimeError(redact('compose start failed: %r' % running, secrets))

        def assert_bootstrap_file():
            path = engine.agent_bootstrap_path(iid)
            require(path.exists() and (path.stat().st_mode & 0o777) in (0o600, 0o644),
                    'personal-agent bootstrap file missing or mode unexpected', secrets)
            document = json.loads(path.read_text())
            require(set(document) == {'agent_bootstrap'} and document['agent_bootstrap'].get('instance_id') == iid,
                    'personal-agent bootstrap file has unexpected fields or instance', secrets)

        assert_bootstrap_file()
        cid = compose_container_id(iid, secrets)

        def check_ready(cid, job):
            require(user.call('GET', readiness_path)['body']['state'] == 'starting',
                    'unpublished runtime must remain starting')
            actual, address, cookie = native_binding(cid, network, secrets)
            require(actual == binding, 'native personal binding did not match signup')
            client.dsbot_upstream(iid, address, cookie, job['process_ref'])
            ready = user.call('GET', readiness_path)
            require(ready['status'] == 200 and ready['body']['state'] == 'ready'
                    and ready['body']['personal_chat'] == binding, 'published runtime did not become ready')

        check_ready(cid, running)
        docker(['exec', '-u', '1000:1000', cid, 'sh', '-c', 'echo persistent-test-content > /data/volume-sentinel'], secrets=secrets)
        stopped = user.call('POST', f'/v1/instances/{iid}/stop', {})
        require(stopped['status'] == 202, 'stop failed: %r' % stopped)
        stopped_job = worker.run_once(iid)
        require(stopped_job.get('status') == 'observed' and stopped_job.get('observed') == 'stopped',
                'compose stop failed: %r' % stopped_job)
        docker(['rm', '--force', compose_container_id(iid, secrets)], secrets=secrets)
        require(user.call('GET', readiness_path)['body']['state'] == 'stopped', 'stopped runtime was not resumable')
        restarted = user.call('POST', '/v1/auth/runtime-start', {})
        require(restarted['status'] == 202 and restarted['body']['state'] == 'starting',
                'resuming the personal runtime failed: %r' % restarted)
        again = worker.run_once(iid)
        require(again.get('status') == 'observed' and again.get('observed') == 'running',
                'start after no-delete container delete failed: %r' % again)
        cid = compose_container_id(iid, secrets)
        sentinel = docker(['exec', '-u', '1000:1000', cid, 'cat', '/data/volume-sentinel'], secrets=secrets)
        require(sentinel.stdout.strip() == 'persistent-test-content',
                'volume sentinel missing after no-delete recreate: %r' % sentinel.stdout)
        assert_bootstrap_file()
        with store.connect() as db:
            require(db.execute('SELECT COUNT(*) FROM instance_runtime_keys').fetchone()[0] == 0,
                    'container lifecycle created a retired instance credential')
        check_ready(cid, again)
        print('PASS: Compose manager started a digest-pinned DS-Bot, provisioned its personal agent, '
              'and preserved the binding and data volume across recreate.')
        return 0
    finally:
        if iid:
            try:
                cid = compose_container_id(iid, secrets)
                docker(['rm', '--force', cid], allow_failure=True, secrets=secrets)
            except Exception:
                pass
        if network:
            docker(['network', 'rm', network], allow_failure=True, secrets=secrets)
        if volume:
            docker(['volume', 'rm', volume], allow_failure=True, secrets=secrets)
        if registry_name:
            docker(['rm', '--force', registry_name], allow_failure=True, secrets=secrets)
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        temp.cleanup()


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
