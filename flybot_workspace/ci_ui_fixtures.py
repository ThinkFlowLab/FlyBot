"""Synthetic, clearly labeled fixtures for CI screenshots of the management UI.

Throwaway data only. Never log or return passwords, session cookies, invite
tokens, runtime keys, or public homepage tokens. Not a Teamily or production
dataset.
"""
from datetime import datetime, timezone
import os
from pathlib import Path
import secrets
import struct
import time
import zlib

from .app import App, Config
from .store import Store
from tests.test_artifact_media import multipart
from tests.test_management import Client


USERNAME = 'cifixture'
MEMBER_USERNAME = 'cifixture2'
WORKSPACE_NAME = 'CI Fixture Workspace'
TEAM_NAME = 'CI Fixture Team'
TEAM_SLUG = 'ci-fixture'
EMPTY_WORKSPACE_NAME = '[CI FIXTURE] Empty library'
AGENT_NAME = '[CI FIXTURE] Directory assistant'
CHAT_TITLE = '[CI FIXTURE] Conversation'
SAVED_MESSAGE_TITLE = '[CI FIXTURE] Saved chat message'
CHAT_USER_TEXT = '[CI FIXTURE] Please reply with one labeled sentence.'
CHAT_LIVE_TEXT = '[CI FIXTURE] Live UI send from the screenshot script.'
SOCIAL_GROUP_TITLE = '[CI FIXTURE] Group chat'
SOCIAL_MESSAGE_TEXT = '[CI FIXTURE] Social message for search.'
AUTOMATION_TITLE = '[CI FIXTURE] Sample briefing'
AUTOMATION_PROMPT = 'Write one sentence of clearly labeled CI fixture text.'
DOCUMENT_TITLE = '[CI FIXTURE] Document'
DOCUMENT_DISCOVER_SLUG = 'ci-fixture-doc'
DOCUMENT_BODY = 'This is synthetic CI screenshot fixture text, not production data.'
WEBSITE_TITLE = '[CI FIXTURE] Website'
WEBSITE_BODY = '<h1>CI Fixture Site</h1><p>Synthetic static HTML for screenshots.</p>'
MEDIA_TITLE = '[CI FIXTURE] Media'
BOARD_TITLE = '[CI FIXTURE] Whiteboard'
BOARD_TEXT = 'CI FIXTURE'
RUNTIME_KEY_NAME = 'ci-fixture-desk'
MEMORY_TITLE = '[CI FIXTURE] Memory page'
MEMORY_BODY = 'This is synthetic CI screenshot fixture text for a memory page, not production data.'
MEMORY_TOPIC = 'CI fixture'
MEMORY_CREATE_TITLE = '[CI FIXTURE] Memory page created in UI'
MEMORY_CREATE_BODY = 'Synthetic body entered in the CI screenshot script, not production data.'
MEMORY_EDITED_TITLE = '[CI FIXTURE] Memory page after edit'
MEMORY_EDITED_BODY = 'Synthetic body after the CI screenshot script edited this page.'
ACTION_TITLE = '[CI FIXTURE] Next action'
ACTION_NOTES = 'Synthetic CI fixture follow-up notes, not production data.'
ACTION_DUE_AT = int(datetime(2026, 12, 31, tzinfo=timezone.utc).timestamp())
ACTION_DUE = datetime.fromtimestamp(ACTION_DUE_AT, timezone.utc).strftime('%Y-%m-%d')
ACTION_CREATE_TITLE = '[CI FIXTURE] Next action created in UI'
ACTION_CREATE_NOTES = 'Synthetic notes entered in the CI screenshot script.'
ACTION_CREATE_DUE = '2026-12-15'
ACTION_EDITED_TITLE = '[CI FIXTURE] Next action after edit'
ACTION_EDITED_NOTES = 'Synthetic notes after the CI screenshot script edited this action.'
PROVIDER_TEXT = '[CI FIXTURE] Fake provider briefing. Not a real vendor response.'


def solid_png(width=96, height=64, rgb=(0x1A, 0x5F, 0xB0)):
    """Return a visible solid-color PNG without third-party image libraries."""
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b''.join(b'\x00' + (bytes(rgb) * width) for _ in range(height))
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def _require(response, allowed, action):
    status = response['status']
    if status not in allowed:
        raise RuntimeError('Cannot %s (%s)' % (action, status))
    return response


def _bind(client, origin):
    host = origin.split('://', 1)[1]
    original = client.call

    def call(method, path, body=None, headers=None, **kw):
        extra = {'HTTP_HOST': host}
        extra.update(headers or {})
        return original(method, path, body, extra, **kw, origin=origin)

    client.call = call
    return client


def seed_fixtures(data_dir, origin, password, provider_base, model_api_key, *, insecure_local=False):
    """Create labeled fixture records. Returns public metadata plus in-memory secrets."""
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(data_dir / 'state')
    app = App(store, Config(origin, insecure_local=insecure_local, allow_registration=True), clock=time.time)
    owner = _bind(Client(app), origin)
    member = _bind(Client(app, peer='127.0.0.2'), origin)
    member_password = secrets.token_urlsafe(18)
    _require(owner.call('POST', '/v1/auth/register', {'username': USERNAME, 'password': password}),
             (200, 201), 'create the fixture user')
    _require(owner.call('POST', '/v1/auth/login', {'username': USERNAME, 'password': password}),
             (200,), 'sign in the fixture user')
    _require(member.call('POST', '/v1/auth/register', {'username': MEMBER_USERNAME, 'password': member_password}),
             (200, 201), 'create the fixture member')
    _require(owner.call('POST', '/v1/settings', {'revision': 0, 'changes': {
        'appearance': 'light', 'send_shortcut': 'mod_enter', 'language': 'zh-CN',
    }}), (200,), 'save fixture settings')
    _require(owner.call('POST', '/v1/model-api', {
        'revision': 0,
        'changes': {'provider': 'openai', 'base_url': provider_base, 'model': 'fake-model', 'api_key': model_api_key},
    }), (200,), 'configure the loopback model API')
    space = _require(owner.call('POST', '/v1/workspaces', {'name': WORKSPACE_NAME},
                                {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-space-0001'}),
                     (200, 201), 'create the fixture workspace')
    wid = space['body']['workspace']['id']
    _require(owner.call('POST', '/v1/workspaces/%s/members' % wid,
                        {'username': MEMBER_USERNAME, 'role': 'member'}),
             (200, 201), 'add the fixture member')
    team = _require(owner.call('POST', '/v1/teams', {
        'name': TEAM_NAME, 'slug': TEAM_SLUG, 'mode': 'convert', 'workspace_id': wid,
    }, {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-team-0001'}), (200, 201), 'convert the fixture team')
    wid = team['body']['workspace']['id']
    # Create an invite so the members page lists one. Discard the one-time token.
    invite = _require(owner.call('POST', '/v1/workspaces/%s/invites' % wid, {'role': 'member'}),
                      (201,), 'create a fixture invite')
    invite_id = invite['body']['invite']['id']
    agent = _require(owner.call('POST', '/v1/workspaces/%s/agents' % wid, {
        'name': AGENT_NAME, 'summary': 'Synthetic CI directory entry.',
        'instructions': 'Keep replies short. This agent is fixture data only.',
    }, {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-agent-0001'}), (201,), 'create the fixture agent')
    agent_id = agent['body']['agent']['id']
    _require(owner.call('POST', '/v1/workspaces/%s/agents/%s' % (wid, agent_id), {
        'revision': agent['body']['agent']['revision'],
        'quick_starts': [
            'Ask how this fixture agent is organized',
            'Request a walkthrough of the directory',
            'List what this fixture assistant covers',
        ],
    }), (200,), 'set fixture homepage quick starts')
    published = _require(owner.call(
        'POST', '/v1/workspaces/%s/agents/%s/homepage' % (wid, agent_id), {},
    ), (200, 201), 'publish the fixture agent homepage')
    homepage_path = published['body']['agent']['homepage']['path']
    homepage_file = data_dir / 'homepage-path'
    homepage_file.write_text(homepage_path + '\n')
    os.chmod(homepage_file, 0o600)
    # Synthetic public catalog entries exercise real search and cursor paging.
    _require(owner.call('POST', '/v1/workspaces/%s/agents/%s/discover' % (wid, agent_id),
                        {'slug': 'ci-directory-assistant'}), (200, 201), 'list fixture agent')
    for index in range(12):
        public_agent = _require(owner.call('POST', '/v1/workspaces/%s/agents' % wid, {
            'name': '[CI FIXTURE] Catalog helper %02d' % index,
            'summary': 'Synthetic public catalog entry, not a real creator.',
            'instructions': 'Fixture only.',
        }, {'HTTP_IDEMPOTENCY_KEY': 'ci-catalog-agent-%04d' % index}), (201,), 'create catalog fixture')
        _require(owner.call('POST', '/v1/workspaces/%s/agents/%s/discover' % (
            wid, public_agent['body']['agent']['id']), {'slug': 'ci-helper-%02d' % index}),
                 (200, 201), 'list catalog fixture')
    conversation = _require(owner.call(
        'POST', '/v1/workspaces/%s/agents/%s/conversations' % (wid, agent_id),
        {'title': CHAT_TITLE},
        {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-chat-0001'},
    ), (201,), 'create the fixture conversation')
    conversation_id = conversation['body']['conversation']['id']
    sent = _require(owner.call(
        'POST', '/v1/workspaces/%s/agents/%s/conversations/%s/messages' % (wid, agent_id, conversation_id),
        {'body': CHAT_USER_TEXT},
        {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-msg-0001'},
    ), (201,), 'send the fixture conversation message')
    _require(owner.call(
        'POST', '/v1/workspaces/%s/agents/%s/conversations/%s/messages/%s/artifact' % (
            wid, agent_id, conversation_id, sent['body']['message']['id']),
        {'title': SAVED_MESSAGE_TITLE},
    ), (201,), 'save the fixture conversation message to the library')
    roster = _require(owner.call('GET', '/v1/workspaces/%s/members' % wid), (200,), 'list fixture members')
    member_id = next(item['user_id'] for item in roster['body']['items'] if item['username'] == MEMBER_USERNAME)
    social_dm = _require(owner.call(
        'POST', '/v1/workspaces/%s/social/conversations' % wid,
        {'kind': 'dm', 'member_ids': [member_id]},
        {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-social-dm-0001'},
    ), (200, 201), 'create the fixture direct message')
    social_dm_id = social_dm['body']['conversation']['id']
    social_group = _require(owner.call(
        'POST', '/v1/workspaces/%s/social/conversations' % wid,
        {'kind': 'group', 'member_ids': [member_id], 'title': SOCIAL_GROUP_TITLE},
        {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-social-group-0001'},
    ), (200, 201), 'create the fixture group conversation')
    social_group_id = social_group['body']['conversation']['id']
    _require(owner.call(
        'POST', '/v1/workspaces/%s/social/conversations/%s/messages' % (wid, social_group_id),
        {'body': SOCIAL_MESSAGE_TEXT},
        {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-social-msg-0001'},
    ), (201,), 'send the fixture social message')
    automation = _require(owner.call('POST', '/v1/workspaces/%s/automations' % wid, {
        'title': AUTOMATION_TITLE,
        'prompt': AUTOMATION_PROMPT,
        'template_id': 'custom',
        'schedule': {'kind': 'now', 'time_zone': 'Asia/Shanghai'},
        'participants': [USERNAME],
    }, {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-auto-0001'}), (201,), 'create the fixture automation')
    aid = automation['body']['automation']['id']
    revision = automation['body']['automation']['revision']
    _require(owner.call('POST', '/v1/workspaces/%s/automations/%s' % (wid, aid),
                        {'revision': revision, 'changes': {'enabled': True}}),
             (200,), 'enable the fixture automation')
    document = _require(owner.call('POST', '/v1/workspaces/%s/artifacts' % wid, {
        'title': DOCUMENT_TITLE, 'body': DOCUMENT_BODY, 'kind': 'document',
    }, {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-doc-0001'}), (201,), 'create the fixture document')
    _require(owner.call(
        'POST',
        '/v1/workspaces/%s/artifacts/%s/discover' % (wid, document['body']['artifact']['id']),
        {'slug': DOCUMENT_DISCOVER_SLUG},
        {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-doc-discover-0001'},
    ), (201,), 'list the fixture document on discover')
    website = _require(owner.call('POST', '/v1/workspaces/%s/artifacts' % wid, {
        'title': WEBSITE_TITLE, 'body': WEBSITE_BODY, 'kind': 'website',
    }, {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-site-0001'}), (201,), 'create the fixture website')
    _require(owner.call('POST', '/v1/workspaces/%s/artifacts/%s/discover' %
                        (wid, website['body']['artifact']['id']), {'slug': 'ci-fixture-site'}),
             (201,), 'list the fixture website on discover')
    raw, content_type = multipart(
        [('title', MEDIA_TITLE), ('kind', 'media')],
        [('file', 'ci-fixture.png', 'image/png', solid_png())],
    )
    _require(owner.call('POST', '/v1/workspaces/%s/artifacts' % wid, raw=raw, headers={
        'CONTENT_TYPE': content_type, 'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-media-0001',
    }), (201,), 'upload the fixture media')
    _require(owner.call('POST', '/v1/workspaces/%s/artifacts' % wid, {
        'title': BOARD_TITLE, 'kind': 'whiteboard', 'board': {
            'width': 800, 'height': 600,
            'strokes': [
                {'id': 'stroke001', 'type': 'path', 'color': '#1A5FB0', 'width': 6,
                 'points': [[40, 40], [200, 80], [360, 200], [520, 120]]},
                {'id': 'stroke002', 'type': 'text', 'color': '#111111', 'x': 48, 'y': 260, 'size': 28, 'text': BOARD_TEXT},
            ],
        },
    }, {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-board-0001'}), (201,), 'create the fixture whiteboard')
    memory = _require(owner.call('POST', '/v1/workspaces/%s/memory' % wid, {
        'title': MEMORY_TITLE, 'body': MEMORY_BODY, 'topics': [MEMORY_TOPIC],
    }, {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-memory-0001'}), (201,), 'create the fixture memory page')
    memory_id = memory['body']['page']['id']
    action = _require(owner.call('POST', '/v1/workspaces/%s/memory/actions' % wid, {
        'title': ACTION_TITLE, 'notes': ACTION_NOTES, 'due_at': ACTION_DUE_AT,
        'memory_page_id': memory_id,
    }, {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-action-0001'}), (201,), 'create the fixture next action')
    action_id = action['body']['action']['id']
    empty_space = _require(owner.call('POST', '/v1/workspaces', {'name': EMPTY_WORKSPACE_NAME},
                                      {'HTTP_IDEMPOTENCY_KEY': 'ci-ui-screenshot-empty-space-0001'}),
                           (200, 201), 'create the empty fixture workspace')
    empty_workspace_id = empty_space['body']['workspace']['id']
    issued = _require(owner.call('POST', '/v1/runtime-keys', {'name': RUNTIME_KEY_NAME}),
                      (200, 201), 'issue a fixture runtime key')
    runtime_token = issued['body']['token']
    key_path = data_dir / 'runtime-key'
    key_path.write_text(runtime_token + '\n')
    os.chmod(key_path, 0o600)
    return {
        'origin': origin,
        'username': USERNAME,
        'member_username': MEMBER_USERNAME,
        'workspace_id': wid,
        'workspace_name': TEAM_NAME,
        'empty_workspace_id': empty_workspace_id,
        'empty_workspace_name': EMPTY_WORKSPACE_NAME,
        'team_slug': TEAM_SLUG,
        'agent_id': agent_id,
        'agent_name': AGENT_NAME,
        'homepage_file': str(homepage_file),
        'conversation_id': conversation_id,
        'conversation_title': CHAT_TITLE,
        'saved_message_title': SAVED_MESSAGE_TITLE,
        'chat_user_text': CHAT_USER_TEXT,
        'chat_live_text': CHAT_LIVE_TEXT,
        'social_dm_id': social_dm_id,
        'social_group_id': social_group_id,
        'social_group_title': SOCIAL_GROUP_TITLE,
        'social_message_text': SOCIAL_MESSAGE_TEXT,
        'document_body': DOCUMENT_BODY,
        'automation_id': aid,
        'automation_title': AUTOMATION_TITLE,
        'document_title': DOCUMENT_TITLE,
        'website_title': WEBSITE_TITLE,
        'media_title': MEDIA_TITLE,
        'board_title': BOARD_TITLE,
        'board_text': BOARD_TEXT,
        'memory_id': memory_id,
        'memory_title': MEMORY_TITLE,
        'memory_body': MEMORY_BODY,
        'memory_topic': MEMORY_TOPIC,
        'memory_create_title': MEMORY_CREATE_TITLE,
        'memory_create_body': MEMORY_CREATE_BODY,
        'memory_edited_title': MEMORY_EDITED_TITLE,
        'memory_edited_body': MEMORY_EDITED_BODY,
        'action_id': action_id,
        'action_title': ACTION_TITLE,
        'action_notes': ACTION_NOTES,
        'action_due': ACTION_DUE,
        'action_create_title': ACTION_CREATE_TITLE,
        'action_create_notes': ACTION_CREATE_NOTES,
        'action_create_due': ACTION_CREATE_DUE,
        'action_edited_title': ACTION_EDITED_TITLE,
        'action_edited_notes': ACTION_EDITED_NOTES,
        'runtime_key_name': RUNTIME_KEY_NAME,
        'provider_text': PROVIDER_TEXT,
        'invite_id': invite_id,
        'runtime_key_file': str(key_path),
        'cookies': dict(owner.cookies),
    }
