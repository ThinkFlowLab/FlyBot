"""Isolated FlyBot Bot Social overlay: additive, loopback-only, no FlyBot hooks."""
import unittest
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - PyYAML is in the usual test env
    yaml = None

ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / 'deploy' / 'isolated' / 'bot-social.compose.yml'


@unittest.skipUnless(yaml, 'PyYAML is required to parse the overlay')
class IsolatedBotSocialOverlayTests(unittest.TestCase):
    def test_overlay_adds_only_bot_social_on_loopback(self):
        text = OVERLAY.read_text()
        self.assertNotIn('0.0.0.0:18783', text)
        self.assertNotIn('3320', text)
        self.assertNotIn('3786', text)
        data = yaml.safe_load(text)
        self.assertEqual(list(data['services']), ['bot-social'])
        svc = data['services']['bot-social']
        self.assertEqual(svc['ports'], ['127.0.0.1:${FLYBOT_WORKSPACE_BOT_SOCIAL_HEALTH_PORT:-18783}:8787'])
        self.assertEqual(svc['environment']['PUBLIC_BASE_URL'],
                         '${FLYBOT_WORKSPACE_BOT_SOCIAL_PUBLIC_URL:?Set the FlyBot Workspace public /social URL}')
        self.assertEqual(svc['volumes'], ['bot-social-data:/data'])
        self.assertIn('bot-social-data', data['volumes'])
        self.assertNotIn('networks', data)
        self.assertNotIn('network_mode', svc)
        self.assertNotIn('ports', [k for k in data.get('services', {}) if k != 'bot-social'])
