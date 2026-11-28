"""Chat page serving tests. In-process WSGI only; not browser E2E."""
from pathlib import Path
import tempfile
import unittest

from flybot_workspace.app import App, Config
from flybot_workspace.settings_page import SettingsPage
from flybot_workspace.store import Store
from tests.test_management import Client, ORIGIN
from tests.test_settings_page import RawClient


class ChatPageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        api = App(Store(Path(self.temp.name) / 'state'), Config(ORIGIN, allow_registration=True),
                  clock=lambda: 1800000000)
        self.app = SettingsPage(api)
        self.raw = RawClient(self.app)
        self.client = Client(self.app)
        self.client.register('alice')

    def test_page_and_assets_are_served_with_strict_headers(self):
        page = self.raw.call('GET', '/chat')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        self.assertIn('聊天', html)
        self.assertIn('id="session-pane"', html)
        self.assertIn('id="conversation-list"', html)
        self.assertIn('id="chat-form"', html)
        self.assertIn('id="chat-body"', html)
        self.assertIn('id="compose-menu"', html)
        self.assertIn('id="search-panel"', html)
        self.assertIn('id="chat-avatar"', html)
        self.assertIn('id="social-agent-members"', html)
        self.assertIn('id="group-agent-chips"', html)
        self.assertIn('id="group-agent-choices"', html)
        self.assertIn('id="group-agent-add"', html)
        self.assertIn('id="onboarding-banner"', html)
        self.assertIn('id="session-filter"', html)
        self.assertLess(html.find('id="session-filter"'), html.find('id="session-search"'))
        self.assertLess(html.find('id="session-search"'), html.find('id="new-conversation"'))
        self.assertIn('aria-label="会话筛选：全部"', html)
        self.assertIn('visually-hidden', html)
        self.assertIn('id="pinned-group" hidden', html)
        self.assertRegex(html, r'<button[^>]+id="chat-invite"[^>]+aria-controls="chat-invite-panel"')
        self.assertIn('id="chat-invite-approval" checked', html)
        self.assertRegex(html, r'<button[^>]+id="chat-group-invite"[^>]+aria-haspopup="dialog"')
        self.assertIn('<dialog id="group-invite-dialog" aria-labelledby="group-invite-heading">', html)
        self.assertRegex(html, r'<button[^>]+id="chat-call"[^>]+aria-haspopup="dialog"')
        self.assertIn('<dialog id="chat-call-dialog" aria-labelledby="chat-call-title">', html)
        self.assertIn('id="chat-call-start-audio"', html)
        self.assertIn('id="chat-call-start-video"', html)
        self.assertIn('新建群组', html)
        self.assertIn('添加联系人', html)
        self.assertIn('创建智能体', html)
        self.assertIn('<dialog id="compose-dialog" aria-labelledby="compose-dialog-title" hidden>', html)
        self.assertIn('自定义群组', html)
        self.assertIn('AI 智能体团队', html)
        self.assertIn('群组名称', html)
        self.assertIn('输入群组名称（可选）', html)
        self.assertIn('id="compose-member-search"', html)
        self.assertIn('已选 0', html)
        self.assertIn('选择团队模板', html)
        self.assertIn('id="team-template-choices"', html)
        self.assertIn('compose-dialog-submit" disabled', html)
        self.assertNotIn('成员付费', html)
        self.assertNotIn('群主付费', html)
        self.assertIn('id="chat-contacts-dialog"', html)
        self.assertIn('id="account-menu"', html)
        self.assertIn('所有设置', html)
        self.assertIn('退出登录', html)
        self.assertLess(html.find('id="account-menu"'), html.find('id="logout-form"'))
        self.assertNotIn('href="/messenger"', html)
        self.assertNotIn('积分中心', html)
        self.assertNotIn('teamily.com', html.lower())
        self.assertIn("default-src 'none'", page['headers']['Content-Security-Policy'])
        script = self.raw.call('GET', '/chat/app.mjs')
        self.assertEqual(script['status'], 200)
        self.assertIn(b'/conversations', script['body'])
        self.assertIn(b'/social/conversations', script['body'])
        self.assertIn(b'agent_ids', script['body'])
        self.assertIn(b'/v1/personal-agent', script['body'])
        self.assertIn(b'/search/messages', script['body'])
        self.assertIn(b'mergeSessions', script['body'])
        self.assertIn(b'composeCreateEnabled', script['body'])
        self.assertIn(b'composeGroupPayload', script['body'])
        self.assertNotIn('请填写群名称。'.encode(), script['body'])
        dsbot_script = self.raw.call('GET', '/chat/dsbot.mjs')
        self.assertEqual(dsbot_script['status'], 200)
        self.assertIn('text/javascript', dsbot_script['headers']['Content-Type'])
        self.assertIn("media-src 'self' blob:", page['headers']['Content-Security-Policy'])
        self.assertIn('microphone=(self)', page['headers']['Permissions-Policy'])
        self.assertIn('microphone=()', self.raw.call('GET', '/profile')['headers']['Permissions-Policy'])
        self.assertEqual(self.raw.call('GET', '/chat/voice.mjs')['status'], 200)
        mention_script = self.raw.call('GET', '/chat/mentions.mjs')
        self.assertEqual(mention_script['status'], 200)
        self.assertIn('text/javascript', mention_script['headers']['Content-Type'])
        self.assertEqual(self.raw.call('GET', '/chat/app.css')['status'], 200)
        self.assertEqual(self.raw.call('GET', '/chat/missing')['status'], 404)
        discover = self.raw.call('GET', '/discover')
        self.assertEqual(discover['status'], 200)
        self.assertIn('id="discover-list"', discover['body'].decode())

    def test_empty_state_offers_the_two_recorded_next_steps(self):
        page = self.raw.call('GET', '/chat')
        self.assertEqual(page['status'], 200)
        html = page['body'].decode()
        start = html.index('id="chat-empty"')
        block = html[start:html.index('id="message-list"', start)]
        self.assertRegex(block, r'<a href="/agents"[^>]*>浏览智能体</a>')
        self.assertRegex(block, r'<a href="/discover"[^>]*>发现</a>')

    def test_page_rejects_cross_origin_queries_and_writes(self):
        self.assertEqual(self.raw.call('GET', '/chat', origin='https://evil.test')['status'], 403)
        self.assertEqual(self.raw.call('GET', '/chat', query='x=1')['status'], 400)
        self.assertEqual(self.raw.call('POST', '/chat')['status'], 405)


if __name__ == '__main__':
    unittest.main()
