#!/usr/bin/env python3
"""Start a throwaway loopback FlyBot app and seed CI screenshot fixtures.

Binds only 127.0.0.1. Uses a fake OpenAI-compatible provider, not a real vendor.
Does not print passwords, session cookies, invite tokens, or runtime keys.
Does not change firewall, proxy, or port-forwarding rules. Not for production.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from flybot_workspace.ci_ui_fixtures import (  # noqa: E402
    PROVIDER_TEXT, USERNAME, seed_fixtures,
)
from tests.test_runtime_infer import start_fake_provider  # noqa: E402


def _free_port(preferred):
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                continue
            return sock.getsockname()[1]
    raise RuntimeError('No free loopback port')


def _write_private(path, text):
    path = Path(path)
    path.write_text(text)
    os.chmod(path, 0o600)


def _json_get(origin, path, cookies):
    host = origin.split('://', 1)[1]
    request = urllib.request.Request(
        origin + path,
        headers={
            'Host': host,
            'Origin': origin,
            'Accept': 'application/json',
            'Cookie': '; '.join('%s=%s' % item for item in cookies.items()),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        return error.code, None


def _wait_http(origin, path, timeout=20):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(urllib.request.Request(origin + path, method='GET'), timeout=2) as response:
                if response.status == 200:
                    return
                last = response.status
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            last = error
        time.sleep(0.25)
    raise RuntimeError('Loopback app did not become ready: %s' % last)


def _public_ready(seed, origin, login_file, run_status, connection_status, chat_status, git_sha):
    return {
        'origin': origin,
        'username': USERNAME,
        'login_file': str(login_file),
        'workspace_name': seed['workspace_name'],
        'workspace_id': seed['workspace_id'],
        'empty_workspace_name': seed['empty_workspace_name'],
        'empty_workspace_id': seed['empty_workspace_id'],
        'team_slug': seed['team_slug'],
        'member_username': seed['member_username'],
        'agent_id': seed['agent_id'],
        'agent_name': seed['agent_name'],
        'homepage_file': seed['homepage_file'],
        'conversation_id': seed['conversation_id'],
        'conversation_title': seed['conversation_title'],
        'saved_message_title': seed['saved_message_title'],
        'chat_user_text': seed['chat_user_text'],
        'chat_live_text': seed['chat_live_text'],
        'social_dm_id': seed['social_dm_id'],
        'social_group_id': seed['social_group_id'],
        'social_group_title': seed['social_group_title'],
        'social_message_text': seed['social_message_text'],
        'automation_id': seed['automation_id'],
        'automation_title': seed['automation_title'],
        'document_title': seed['document_title'],
        'document_body': seed['document_body'],
        'website_title': seed['website_title'],
        'media_title': seed['media_title'],
        'board_title': seed['board_title'],
        'board_text': seed['board_text'],
        'memory_id': seed['memory_id'],
        'memory_title': seed['memory_title'],
        'memory_body': seed['memory_body'],
        'memory_topic': seed['memory_topic'],
        'memory_create_title': seed['memory_create_title'],
        'memory_create_body': seed['memory_create_body'],
        'memory_edited_title': seed['memory_edited_title'],
        'memory_edited_body': seed['memory_edited_body'],
        'action_id': seed['action_id'],
        'action_title': seed['action_title'],
        'action_notes': seed['action_notes'],
        'action_due': seed['action_due'],
        'action_create_title': seed['action_create_title'],
        'action_create_notes': seed['action_create_notes'],
        'action_create_due': seed['action_create_due'],
        'action_edited_title': seed['action_edited_title'],
        'action_edited_notes': seed['action_edited_notes'],
        'runtime_key_name': seed['runtime_key_name'],
        'provider_text': seed['provider_text'],
        'run_status': run_status,
        'connection_status': connection_status,
        'chat_status': chat_status,
        'git_sha': git_sha,
        'note': (
            'Synthetic throwaway CI data on a GitHub Actions runner. '
            'Model responses come from a simulated provider on the same runner.'
        ),
    }


def _assistant_status(payload):
    items = (payload or {}).get('items') or []
    replies = [item for item in items if item.get('role') == 'assistant']
    if not replies:
        return 'missing'
    return replies[-1].get('status') or 'unknown'


def _poll_run_and_connection(origin, seed, timeout=45):
    cookies = seed['cookies']
    wid, aid = seed['workspace_id'], seed['automation_id']
    chat_path = '/v1/workspaces/%s/agents/%s/conversations/%s/messages' % (
        wid, seed['agent_id'], seed['conversation_id'],
    )
    deadline = time.time() + timeout
    run_status = 'missing'
    connection_status = 'missing'
    chat_status = 'missing'
    while time.time() < deadline:
        run_code, runs = _json_get(origin, '/v1/workspaces/%s/automations/%s/runs?limit=20' % (wid, aid), cookies)
        if run_code == 200 and runs and runs.get('items'):
            run_status = runs['items'][0].get('status') or 'unknown'
        conn_code, connections = _json_get(origin, '/v1/runtime/connections', cookies)
        if conn_code == 200 and connections and connections.get('items'):
            connection_status = connections['items'][0].get('status') or 'unknown'
        chat_code, messages = _json_get(origin, chat_path, cookies)
        if chat_code == 200:
            chat_status = _assistant_status(messages)
        if run_status == 'succeeded' and connection_status == 'online' and chat_status == 'succeeded':
            break
        time.sleep(0.5)
    return run_status, connection_status, chat_status


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--out', required=True, help='Directory for ready.json (must not be uploaded with login files)')
    parser.add_argument('--port', type=int, default=18766)
    parser.add_argument('--serve', action='store_true', help='Keep the loopback app running until SIGTERM/SIGINT')
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error('Port must be in 1..65535')
    data_dir = Path(args.data_dir)
    out_dir = Path(args.out)
    if data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True, mode=0o700)
    out_dir.mkdir(parents=True, exist_ok=True)
    port = _free_port(args.port)
    origin = 'http://127.0.0.1:%s' % port
    model_api_key = secrets.token_urlsafe(18)
    password = secrets.token_urlsafe(18)
    provider, provider_thread, _seen = start_fake_provider(model_api_key, PROVIDER_TEXT)
    provider_base = 'http://127.0.0.1:%s/v1' % provider.server_address[1]
    login_file = data_dir / 'login'
    _write_private(login_file, 'username=%s\npassword=%s\n' % (USERNAME, password))
    seed = seed_fixtures(data_dir, origin, password, provider_base, model_api_key, insecure_local=True)
    env = os.environ.copy()
    env['PYTHONPATH'] = str(ROOT) + ((':' + env['PYTHONPATH']) if env.get('PYTHONPATH') else '')
    server = subprocess.Popen(
        [sys.executable, '-m', 'flybot_workspace.server', '--data-dir', str(data_dir / 'state'),
         '--origin', origin, '--port', str(port), '--insecure-local', '--open-registration'],
        cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(0.4)
    agent = subprocess.Popen(
        [sys.executable, '-m', 'flybot-workspace.flybot', 'daemon', 'start',
         '--origin', origin, '--key-file', seed['runtime_key_file'],
         '--hostname', seed['runtime_key_name'], '--poll', '0.5'],
        cwd=str(ROOT), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )

    def shutdown(*_args):
        for process in (agent, server):
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
        for process in (agent, server):
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        provider.shutdown()
        provider_thread.join(3)
        provider.server_close()

    try:
        _wait_http(origin, '/settings')
        if server.poll() is not None:
            raise RuntimeError('Management server exited during startup')
        run_status, connection_status, chat_status = _poll_run_and_connection(origin, seed)
        git_sha = os.environ.get('GITHUB_SHA') or ''
        ready = _public_ready(seed, origin, login_file, run_status, connection_status, chat_status, git_sha)
        (out_dir / 'ready.json').write_text(json.dumps(ready, indent=2, sort_keys=True) + '\n')
        print('CI UI fixture listening at %s; ready.json in %s; run=%s connection=%s chat=%s'
              % (origin, out_dir, run_status, connection_status, chat_status), flush=True)
        if not args.serve:
            return
        signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
        signal.signal(signal.SIGINT, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
        while True:
            if server.poll() is not None:
                raise SystemExit('Management server exited')
            time.sleep(1)
    finally:
        shutdown()


if __name__ == '__main__':
    main()
