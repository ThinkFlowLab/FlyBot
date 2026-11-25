"""The DS-Bot plugin's onboarding tables must equal flybot_workspace/onboarding.py."""
import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class OnboardingDataDrift(unittest.TestCase):
    def test_plugin_copy_matches_server_tables(self):
        spec = importlib.util.spec_from_file_location('gen', ROOT / 'scripts' / 'dsbot_b4_onboarding_data.py')
        gen = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gen)
        self.assertEqual(gen.TARGET.read_text(encoding='utf-8'), gen.render(),
                         'run python scripts/dsbot_b4_onboarding_data.py')


if __name__ == '__main__':
    unittest.main()
