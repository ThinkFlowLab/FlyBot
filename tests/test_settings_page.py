"""Settings page serving tests. In-process WSGI only; not browser E2E."""
import io
import os
import re
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN, PASSWORD


class RawClient:
    def __init__(self, app, peer='127.0.0.1'):
        self.app, self.peer = app, peer

    def call(self, method, path, origin=ORIGIN, host='management.test', site='', query='', if_none_match=None):
        env = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': query,
               'HTTP_HOST': host, 'REMOTE_ADDR': self.peer, 'CONTENT_LENGTH': '0',
               'wsgi.input': io.BytesIO()}
        if origin is not None:
            env['HTTP_ORIGIN'] = origin
        if site:
            env['HTTP_SEC_FETCH_SITE'] = site
        if if_none_match is not None:
            env['HTTP_IF_NONE_MATCH'] = if_none_match
        result = {}
        def start(status, values):
            result['status'], result['headers'] = int(status.split()[0]), dict(values)
        result['body'] = b''.join(self.app(env, start))
        return result


class SettingsPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.api = api
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/settings')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('<h1 data-ui-text="shell.settings">设置</h1>', html)
        self.assertIn('id="settings-index"', html)
        self.assertIn('账户与资料', html)
        self.assertIn('AI 与智能体设置', html)
        self.assertIn('偏好与安全', html)
        self.assertIn(b'/v1/settings', page['body'])
        self.assertIn('default-src \'none\'', page['headers']['Content-Security-Policy'])
        self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(page['headers']['X-Content-Type-Options'], 'nosniff')
        script = self.raw.call('GET', '/settings/app.mjs')
        css = self.raw.call('GET', '/settings/app.css')
        self.assertEqual(script['status'], 200)
        self.assertEqual(css['status'], 200)
        self.assertIn('javascript', script['headers']['Content-Type'])
        head = self.raw.call('HEAD', '/settings')
        self.assertEqual(head['status'], 200)
        self.assertEqual(head['body'], b'')

    def test_static_validators_revalidate_get_and_head_without_a_body(self):
        for path in ('/shell/app.css', '/shell/agent-categories.mjs', '/look/app.mjs', '/artifacts/entry.mjs'):
            first = self.raw.call('GET', path)
            self.assertEqual(first['status'], 200)
            self.assertEqual(first['headers']['Cache-Control'], 'private, no-cache')
            tag = first['headers']['ETag']
            self.assertRegex(tag, r'^W/"sha256-[0-9a-f]{64}"$')
            head = self.raw.call('HEAD', path)
            self.assertEqual(head['headers']['Content-Length'], str(len(first['body'])))
            self.assertEqual(head['headers']['ETag'], tag)
            self.assertEqual(head['body'], b'')
            for method in ('GET', 'HEAD'):
                for candidate in (tag, tag[2:], '"old,tag",\t' + tag, '*'):
                    with self.subTest(path=path, method=method, candidate=candidate):
                        cached = self.raw.call(method, path, if_none_match=candidate)
                        self.assertEqual(cached['status'], 304)
                        self.assertEqual(cached['headers']['ETag'], tag)
                        self.assertEqual(cached['headers']['Cache-Control'], 'private, no-cache')
                        self.assertNotIn('Content-Length', cached['headers'])
                        self.assertEqual(cached['body'], b'')
            for candidate in ('"outdated"', '"prefix,' + tag[3:-1] + '"', '*, ' + tag):
                self.assertEqual(self.raw.call('GET', path, if_none_match=candidate)['status'], 200)

    def test_static_validator_changes_when_only_contents_change(self):
        self.app.root = Path(self.temp.name) / 'package'
        file = self.app.root / 'shell' / 'app.css'
        file.parent.mkdir(parents=True)
        file.write_bytes(b'a{}')
        tag = self.raw.call('GET', '/shell/app.css')['headers']['ETag']
        info = file.stat()
        file.write_bytes(b'b{}')
        os.utime(file, ns=(info.st_atime_ns, info.st_mtime_ns))
        updated = self.raw.call('GET', '/shell/app.css', if_none_match=tag)
        self.assertEqual(updated['status'], 200)
        self.assertNotEqual(updated['headers']['ETag'], tag)
        self.assertEqual(updated['body'], b'b{}')
        file.unlink()
        missing = self.raw.call('GET', '/shell/app.css', if_none_match='*')
        self.assertEqual(missing['status'], 503)
        self.assertEqual(missing['headers']['Cache-Control'], 'no-store')
        self.assertNotIn('ETag', missing['headers'])

    def test_static_validators_do_not_bypass_request_checks_or_apply_to_pages(self):
        path = '/shell/app.css'
        for method, url, status, options in (
                ('GET', path, 403, {'origin': 'https://evil.test'}),
                ('GET', path, 403, {'host': 'evil.test'}),
                ('GET', path, 403, {'site': 'cross-site'}),
                ('POST', path, 405, {}),
                ('GET', path, 400, {'query': 'v=1'}),
                ('GET', '/shell/missing.css', 404, {}),
                ('GET', '/shell/../settings_page.py', 404, {}),
                ('GET', '/settings', 200, {}),
                ('GET', '/login', 200, {}),
                ('GET', '/v1/auth/session', 401, {})):
            with self.subTest(path=url, method=method, options=options):
                result = self.raw.call(method, url, if_none_match='*', **options)
                self.assertEqual(result['status'], status)
                self.assertEqual(result['headers']['Cache-Control'], 'no-store')
                self.assertNotIn('ETag', result['headers'])

    def test_composer_deep_links_pass_only_known_queries(self):
        for kind in ('document', 'website', 'slides', 'dashboard', 'whiteboard'):
            self.assertEqual(self.raw.call('GET', '/space', query='new=' + kind)['status'], 200, kind)
        self.assertEqual(self.raw.call('GET', '/space', query='new=image')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/automations', query='template=daily_brief')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/automations', query='template=custom')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/automations', query='template=nope')['status'], 400)
        self.assertEqual(self.raw.call('GET', '/shell/thumb.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/memory/rich.mjs')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/shell/thumb.mjs', query='x=1')['status'], 400)

    def test_saved_document_deep_link_is_strict_html_only_not_authorization(self):
        workspace, artifact = 'a' * 32, 'b' * 32
        query = f'workspace={workspace}&artifact={artifact}'
        for route in ('/space', '/artifacts'):
            for pair in (query, f'artifact={artifact}&workspace={workspace}'):
                for method in ('GET', 'HEAD'):
                    response = self.raw.call(method, route, query=pair)
                    self.assertEqual(response['status'], 200, (route, pair, method))
                    self.assertIn("default-src 'none'", response['headers']['Content-Security-Policy'])
            for invalid in (f'workspace={workspace}', f'artifact={artifact}',
                            query + '&artifact=' + artifact, query + '&new=document',
                            query + '&x=1', query + '&', 'x=1&' + query,
                            query.replace('workspace=', '%77orkspace='),
                            query.replace(workspace, '../' + workspace),
                            query.replace(artifact, '%62' * 32),
                            query.replace(artifact, 'B' * 32),
                            query.replace(artifact, artifact[:-1])):
                self.assertEqual(self.raw.call('GET', route, query=invalid)['status'], 400, invalid)
        for asset in ('/artifacts/app.mjs', '/artifacts/app.css', '/skills/app.mjs', '/settings'):
            self.assertEqual(self.raw.call('GET', asset, query=query)['status'], 400, asset)
        self.assertEqual(self.raw.call('GET', '/space', query=query, origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('POST', '/space', query=query)['status'], 405)

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/settings', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/settings', host='evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/settings', site='cross-site')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/settings', query='q=1')['status'], 400)
        posted = self.raw.call('POST', '/settings')
        self.assertEqual(posted['status'], 405)
        self.assertEqual(posted['headers']['Allow'], 'GET, HEAD')
        self.assertEqual(self.raw.call('GET', '/settings/../settings.py')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/settings/missing')['status'], 404)

    def test_team_studio_page_accepts_only_exact_document_links(self):
        workspace, document = 'a' * 32, 'b' * 32
        query = f'workspace={workspace}&studio={document}'
        for route in ('/space', '/artifacts'):
            page = self.raw.call('GET', route, query=query)
            self.assertEqual(page['status'], 200)
            for bad in (query + f'&studio={document}', query + f'&artifact={document}', 'studio=' + document):
                self.assertEqual(self.raw.call('GET', route, query=bad)['status'], 400)

        for script in ('/artifacts/shared-studio.mjs', '/shell/studio-link.mjs'):
            self.assertEqual(self.raw.call('GET', script)['status'], 200)
            self.assertEqual(self.raw.call('GET', script, query=query)['status'], 400)

    def test_discover_page_accepts_supported_filtered_links(self):
        for kind in ('document', 'whiteboard', 'dashboard', 'spreadsheet'):
            with self.subTest(kind=kind):
                query = f'feed=collected&kind={kind}&q=quarterly&creator=author.home&topic=education&work=public-preview'
                self.assertEqual(self.raw.call('GET', '/discover', query=query)['status'], 200)
        for query in ('kind=unknown', 'creator=../author', 'creator=original&creator=second', 'sort=popular&creator=author.home',
                      'topic=../education', 'topic=education&topic=travel'):
            with self.subTest(query=query):
                self.assertEqual(self.raw.call('GET', '/discover', query=query)['status'], 400)

    def test_discover_agent_and_team_catalogues_can_restore_public_search(self):
        for query in ('tab=agents&category=education&q=%E8%AF%BE%E7%A8%8B',
                      'tab=agents&section=groups&q=research', 'tab=agents&creator=author.home'):
            with self.subTest(query=query):
                self.assertEqual(self.raw.call('GET', '/discover', query=query)['status'], 200)
        for query in ('tab=agents&q=one&q=two', 'tab=agents&q=%0A', 'tab=agents&category=unknown',
                      'tab=agents&section=groups&category=education', 'tab=agents&feed=following',
                      'tab=agents&creator=../author', 'tab=agents&creator=one&creator=two',
                      'tab=agents&section=groups&creator=author.home'):
            with self.subTest(query=query):
                self.assertEqual(self.raw.call('GET', '/discover', query=query)['status'], 400)

    def test_discover_can_play_media_from_its_own_origin(self):
        headers = self.raw.call('GET', '/discover')['headers']
        self.assertIn("media-src 'self'", headers['Content-Security-Policy'])
        self.assertNotIn('blob:', headers['Content-Security-Policy'].split('media-src ', 1)[1])
        self.assertIn('microphone=()', headers['Permissions-Policy'])

    def test_discover_3d_engine_can_load_from_the_public_shell(self):
        asset = self.raw.call('GET', '/shell/model3d-engine-0.187.0.mjs')
        self.assertEqual(asset['status'], 200)
        self.assertIn('javascript', asset['headers']['Content-Type'])
        self.assertGreater(len(asset['body']), 256 * 1024)

    def test_discover_reader_modules_load_without_a_session(self):
        for path in ('/discover/document-reader.mjs', '/shell/markdown.mjs', '/shell/markdown-table.mjs', '/shell/work-topics.mjs'):
            with self.subTest(path=path):
                asset = self.raw.call('GET', path)
                self.assertEqual(asset['status'], 200)
                self.assertIn('javascript', asset['headers']['Content-Type'])

    def test_chat_entry_can_load_from_the_platform_shell(self):
        asset = self.raw.call('GET', '/chat/app.mjs')
        self.assertEqual(asset['status'], 200)
        self.assertIn('javascript', asset['headers']['Content-Type'])
        self.assertIn(b'startChatReads', asset['body'])

    def test_platform_settings_api_stays_retired_without_disabling_login(self):
        self.assertEqual(self.client.call('GET', '/v1/settings')['status'], 410)
        update = self.client.call('POST', '/v1/settings', {'revision': 0, 'changes': {'appearance': 'dark'}})
        self.assertEqual(update['status'], 410)
        login = Client(self.app, peer='127.0.0.2')
        again = login.call('POST', '/v1/auth/login', {'username': 'alice', 'password': PASSWORD})
        self.assertEqual(again['status'], 200)

    def test_html_lists_only_documented_setting_keys(self):
        html = self.raw.call('GET', '/settings')['body'].decode()
        for name in ('appearance', 'appearance_schedule', 'language', 'chat_language', 'auto_translate',
                     'send_shortcut', 'message_folding', 'document_cards', 'link_previews',
                     'task_completion_reminders', 'likes_visible', 'favorites_visible'):
            self.assertIn(f'name="{name}"', html)
        self.assertIn('sunset_sunrise', html)
        self.assertIn('id="appearance"', html)
        light, dark, auto, system = (html.find(f'value="{name}"') for name in ('light', 'dark', 'auto', 'system'))
        self.assertTrue(-1 < light < dark < auto < system)
        self.assertLess(html.find('始终使用浅色主题。'), html.find('始终使用深色主题。'))
        self.assertIn('默认夜间时段', html)
        self.assertIn('22:00 至次日 06:00 使用深色主题。', html)
        self.assertNotIn('会等你停止操作约 1 分钟再切换', html)
        self.assertIn('legend class="visually-hidden"', html)
        self.assertIn('settings-card-title', html)
        self.assertNotIn('name="fold_long_messages"', html)

    def test_overview_maps_existing_settings_and_omits_billing_chrome(self):
        html = self.raw.call('GET', '/settings')['body'].decode()
        self.assertIn('id="settings-index"', html)
        self.assertIn('id="whoami"', html)
        self.assertIn('href="/members"', html)
        self.assertIn('技能配置', html)
        self.assertIn('无需填写个人 API 密钥', html)
        self.assertNotIn('id="settings-usage-card"', html)
        self.assertNotIn('id="settings-upgrade"', html)
        self.assertNotIn('id="group-creator"', html)
        self.assertNotIn('id="group-billing"', html)
        self.assertNotIn('>升级</button>', html)
        for label in ('创作者与奖励', '套餐、账单与用量', '创作赚钱', '积分中心', '套餐与账单', '教育优惠认证', '兑换码'):
            self.assertNotIn(label, html)
        account = html.find('id="group-account"')
        ai = html.find('id="group-ai"')
        prefs = html.find('id="group-prefs"')
        support = html.find('id="group-support"')
        self.assertTrue(-1 < account < ai < prefs < support)
        self.assertIn('支持与法律', html)
        support_html = html[support:]
        self.assertIn('href="/about"', support_html)
        self.assertIn('href="/guide"', support_html)
        self.assertIn('href="/profile"', html)
        self.assertIn('href="/settings/language"', html)
        self.assertIn('href="/settings/channels"', html)
        self.assertIn('href="/settings/agent-access"', html)
        self.assertIn('href="#model-api"', html)
        self.assertIn('href="/settings/skill-configuration"', html)
        self.assertIn('href="/settings/connectors"', html)
        self.assertNotIn('href="/runtimes"', html)
        language = html.find('href="/settings/language"')
        channels = html.find('href="/settings/channels"')
        agent_api = html.find('href="/settings/agent-access"')
        model_api = html.find('href="#model-api"')
        skills = html.find('href="/settings/skill-configuration"')
        connectors = html.find('href="/settings/connectors"')
        self.assertTrue(-1 < language < channels < agent_api < model_api < skills < connectors)
        self.assertIn('href="/settings/appearance"', html)
        self.assertIn('href="/settings/shortcuts"', html)
        self.assertIn('href="/settings/message-folding"', html)
        self.assertIn('href="/settings/privacy"', html)
        prefs = html[html.find('id="group-prefs"'):html.find('id="group-notification-prefs"')]
        folding = prefs.find('href="/settings/message-folding"')
        appearance = prefs.find('href="/settings/appearance"')
        privacy = prefs.find('href="/settings/privacy"')
        shortcuts = prefs.find('href="/settings/shortcuts"')
        self.assertTrue(-1 < folding < appearance < privacy < shortcuts)
        self.assertIn('id="folding-current"', prefs)
        self.assertIn('id="appearance-current"', prefs)
        self.assertIn('隐私设置', prefs)
        support = html[html.find('id="group-support"'):html.find('id="settings-form"')]
        help_center = support.find('href="/help"')
        guide = support.find('href="/guide"')
        terms = support.find('href="/terms"')
        policy = support.find('href="/privacy"')
        about = support.find('href="/about"')
        issues = support.find('href="https://github.com/ThinkFlowLab/FlyBot/issues"')
        self.assertTrue(-1 < help_center < guide < terms < policy < about < issues)
        self.assertNotIn('退款政策', support)
        self.assertIn('系统语言', html)
        self.assertIn('始终使用浅色主题。', html)
        self.assertIn('选择长消息在对话里最先展示多少内容。', html)
        self.assertIn('保存更改', html)
        self.assertIn('name="link_previews"', html)
        self.assertIn('role="switch"', html)
        self.assertIn('settings-row-icon', html)
        self.assertIn('settings-row-chevron', html)
        self.assertNotIn('按对照把总览和已有设置子页分开', html)
        self.assertIn('class="visually-hidden"', html)
        self.assertNotIn('0m 后重置', html)
        self.assertNotIn('已赚取', html)
        self.assertNotIn('$CASH', html)
        self.assertNotIn('CREDIT', html)
        self.assertNotIn('剩余 100%', html)
        self.assertNotIn('Free 套餐', html)
        self.assertNotIn('href="/settings/subscription"', html)
        self.assertNotIn('href="/settings/credits-center"', html)
        self.assertNotIn('href="/pricing"', html)
        self.assertNotIn('Teamily Agent', html)
        self.assertEqual(re.findall(r'<img\b[^>]*\bsrc="([^"]+)"', html), ['/shell/flybot-logo.svg'])
        # Isolated word「用量」must not return as a billing-row label.
        self.assertNotIn('>用量</span>', html)
        self.assertNotIn('5 小时窗口', html)

    def test_recorded_subpages_serve_the_same_settings_shell(self):
        for path in ('/settings/appearance', '/settings/language',
                     '/settings/message-folding', '/settings/privacy',
                     '/settings/shortcuts', '/settings/channels',
                     '/settings/agent-access', '/settings/connectors',
                     '/settings/skill-configuration'):
            page = self.raw.call('GET', path)
            self.assertEqual(page['status'], 200, path)
            html = page['body'].decode()
            self.assertIn('id="settings-index"', html)
            self.assertIn(f'data-settings-page="{path.rsplit("/", 1)[-1]}"', html)
            self.assertEqual(page['headers']['Cache-Control'], 'no-store')
        self.assertEqual(self.raw.call('GET', '/settings/missing')['status'], 404)
        self.assertEqual(self.raw.call('GET', '/settings/appearance', query='q=1')['status'], 400)

    def test_support_rows_link_the_pages_the_server_serves(self):
        html = self.raw.call('GET', '/settings')['body'].decode()
        for label, href in (('帮助中心', '/help'), ('服务条款', '/terms'), ('隐私政策', '/privacy')):
            self.assertNotIn(f'disabled title="未接通：还没有 FlyBot {label}页"', html)
            self.assertNotIn(f'disabled title="未实现：还没有 FlyBot {label}页"', html)
            self.assertIn(f'<a class="settings-row" href="{href}">', html)
            page = self.raw.call('GET', href)
            self.assertEqual(page['status'], 200, href)
            self.assertEqual(page['headers']['Content-Type'], 'text/html; charset=utf-8', href)
            body = page['body'].decode()
            self.assertIn(f'<title>{label} · FlyBot</title>', body)
            self.assertIn(f'<h1>{label}</h1>', body)

    def test_channel_agent_api_and_connectors_pages_explain_available_actions(self):
        html = self.raw.call('GET', '/settings/channels')['body'].decode()
        self.assertIn('data-settings-page="channels"', html)
        self.assertIn('WeChat Official Account', html)
        self.assertIn('Apple iMessage', html)
        self.assertIn('Slack', html)
        self.assertIn('WhatsApp', html)
        channels = html[html.find('data-settings-page="channels"'):html.find('data-settings-page="agent-access"')]
        help_page = self.raw.call('GET', '/help')
        self.assertEqual(help_page['status'], 200)
        help_html = help_page['body'].decode()
        for channel in ('wechat', 'imessage', 'slack', 'whatsapp'):
            self.assertIn(f'href="/help#channel-{channel}"', channels)
            self.assertIn(f'id="channel-{channel}"', help_html)
        self.assertNotIn('+ 连接', channels)
        self.assertIn('disabled', html)
        self.assertNotIn('Teamily Agent', html)
        agent = self.raw.call('GET', '/settings/agent-access')['body'].decode()
        self.assertIn('href="/agents">前往智能体管理密钥</a>', agent)
        self.assertIn('在「外部 API 访问」中查看有效密钥、生成新密钥或撤销已有密钥。', agent)
        self.assertNotIn('你的 agent 还没有向本实例之外开放。', agent)
        connectors = self.raw.call('GET', '/settings/connectors')['body'].decode()
        self.assertIn('placeholder="搜索应用…"', connectors)
        self.assertIn('+ 添加 MCP 服务器', connectors)
        self.assertIn('id="add-mcp-server"', connectors)
        self.assertIn('id="mcp-dialog"', connectors)
        self.assertIn('在智能体里添加自定义 MCP 服务器', connectors)
        self.assertIn('id="custom-mcp-form"', connectors)
        self.assertIn('name="bearer_token" type="password"', connectors)
        self.assertIn('/settings/custom-mcp.mjs', connectors)
        self.assertIn('id="mcp-dialog-ack"', connectors)
        self.assertIn('知道了', connectors)
        self.assertIn('hidden role="dialog"', connectors)
        self.assertNotIn('disabled title="未实现：对照里「添加 MCP 服务器」', connectors)
        self.assertNotIn('已连接', connectors)
        self.assertIn('公开 HTTPS:443 Streamable HTTP', connectors)
        self.assertIn('class="connector-search-icon"', connectors)
        self.assertEqual(connectors.count('class="connector-row"'), 39)
        # Rows start disabled until the user's own Composio key is loaded.
        self.assertEqual(connectors.count('data-state="loading">正在读取…<'), 31)
        self.assertIn('id="composio-retry" class="secondary" hidden>重试读取状态</button>', connectors)
        self.assertEqual(connectors.count('data-state="unavailable">未接通<'), 8)
        self.assertEqual(connectors.count('disabled title="正在读取连接配置。">+ 连接'), 31)
        self.assertEqual(connectors.count('disabled title="未接通：Composio 没有这个应用，暂时不能连接。">+ 连接'), 8)
        self.assertIn('id="composio-key-form"', connectors)
        self.assertIn('id="connectors-catalog"', connectors)
        self.assertIn('没有匹配的应用。', connectors)
        self.assertIn('id="connectors-empty"', connectors)
        self.assertNotIn('还没有可连接的应用目录。', connectors)
        for name in ('GitHub', 'Notion', 'monday.com', 'Hugging Face', 'Microsoft Learn',
                     'Cloudflare Docs', 'Mailbox', 'Slack', 'Amap'):
            self.assertIn(f'>{name}<', connectors)
        script = self.raw.call('GET', '/settings/app.mjs')['body'].decode()
        css = self.raw.call('GET', '/settings/app.css')['body'].decode()
        for blob in (connectors, script, css):
            for marker in ('Ov23liin4waZGLSJJgn5', 'DS_BOT_GITHUB_OAUTH_CLIENT_ID',
                           'githubcopilot.com', 'mcp.notion.com', 'mcp.slack.com',
                           'api.github.com/user', 'X-MCP-Toolsets', 'lbs.amap.com',
                           'huggingface.co/mcp', 'learn.microsoft.com/api/mcp',
                           'docs.mcp.cloudflare.com', 'mcp.amap.com', 'GITHUB_TOKEN'):
                self.assertNotIn(marker, blob)

    def test_preference_subpages_follow_recorded_copy(self):
        html = self.raw.call('GET', '/settings/appearance')['body'].decode()
        self.assertIn('settings-card-title">自动切换', html)
        self.assertIn('22:00 至次日 06:00 使用深色主题。', html)
        self.assertIn('自定义时段<span class="hint">在你设定的时间切换。', html)
        self.assertIn('id="appearance-status"', html)
        self.assertIn('class="settings-appearance-status"', html)
        self.assertIn('白天浅色、夜间深色。按下面的时段或你设定的时间切换。', html)
        self.assertNotIn('夜间取 22:00 至次日 06:00，或用你设定的时段。', html)
        css = self.raw.call('GET', '/settings/app.css')['body'].decode()
        self.assertIn('grid-template-columns: auto minmax(0, 1fr)', css)
        schedule = html.find('id="appearance-schedule-card"')
        status = html.find('id="appearance-status"')
        self.assertLess(html.find('id="appearance"'), schedule)
        self.assertLess(schedule, status)
        self.assertLess(status, html.find('</fieldset>', schedule))
        self.assertNotIn('可能相差一小时以上', html)
        self.assertNotIn('可能偏差一小时以上', html)
        self.assertNotIn('按系统浅色或深色偏好估算', html)
        self.assertNotIn('按你所在地的日落和日出', html)

        language = self.raw.call('GET', '/settings/language')['body'].decode()
        self.assertIn('系统语言', language)
        self.assertIn('聊天语言', language)
        self.assertIn('自动翻译消息', language)
        self.assertIn('根据消息语言回复', language)
        self.assertIn('class="settings-field"', language)

        folding = self.raw.call('GET', '/settings/message-folding')['body'].decode()
        self.assertIn('‹ 设置', folding)
        self.assertIn('选择长消息在对话里最先展示多少内容。', folding)
        self.assertIn('长消息会把对话推得很高。', folding)
        self.assertIn('长文档收成卡片', folding)
        self.assertIn('含多个章节的消息会显示为卡片', folding)
        self.assertNotIn('折叠前展示多少内容', folding)
        self.assertNotIn('长消息会拉开推动聊天窗', folding)

        privacy = self.raw.call('GET', '/settings/privacy')['body'].decode()
        self.assertIn('‹ 隐私设置', privacy)
        self.assertIn('管理你的社交动态对他人的可见性', privacy)
        self.assertIn('点赞列表', privacy)
        self.assertIn('收藏列表', privacy)
        self.assertIn('允许他人查看你点赞的内容', privacy)
        self.assertIn('允许他人查看你收藏的内容', privacy)
        self.assertIn('id="save"', privacy)
        self.assertIn('disabled', privacy)
        self.assertNotIn('没有留下这一页的版式截图', privacy)

        shortcuts = self.raw.call('GET', '/settings/shortcuts')['body'].decode()
        self.assertIn('‹ 快捷键', shortcuts)
        self.assertIn('>消息<', shortcuts)
        self.assertIn('发送消息', shortcuts)
        self.assertIn('name="send_shortcut"', shortcuts)
        self.assertIn('>Enter<', shortcuts)
        self.assertIn('Ctrl + Enter', shortcuts)
        self.assertIn('换行', shortcuts)
        self.assertIn('id="newline-keys"', shortcuts)
        self.assertNotIn('没有留下这一页的版式截图', shortcuts)
        self.assertNotIn('Enter 发送', shortcuts)




if __name__ == '__main__':
    unittest.main()
