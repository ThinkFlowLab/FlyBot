"""The source checklist must retain disabled controls, not certify them as completed."""
import json
from pathlib import Path
import unittest
from scripts.visible_inventory import generate


class InventoryTests(unittest.TestCase):
    def test_checked_in_census_matches_source_and_keeps_unverified_states(self):
        data=generate()
        path=Path(__file__).resolve().parents[1]/'docs/inventory/visible-controls.json'
        self.assertEqual(json.loads(path.read_text()),data)
        self.assertGreater(len(data['controls']),1200)
        self.assertGreater(len(data['server_template_controls']),0)
        self.assertTrue(any(c['initially_disabled'] for c in data['controls']))
        for entry in data['controls']+data['dynamic_sites']+data['server_template_controls']:
            self.assertIn(entry['execution_profile'],data['execution_profiles'])
            self.assertIn('unverified',entry['verification'])
