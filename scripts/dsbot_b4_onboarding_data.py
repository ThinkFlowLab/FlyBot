"""Generate runtime/flybot-workspace-web/features/settings/onboarding-data.json.

The DS-Bot plugin (@flybot-workspace/web) serves onboarding from the user's own
DS-Bot. Its option tables are copied from flybot_workspace/onboarding.py (and the
recommended automation template titles/prompts) so both paths say the same
thing. tests/test_dsbot_b4_onboarding_data.py fails when they drift; rerun
`python scripts/dsbot_b4_onboarding_data.py` after changing onboarding.py.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / 'runtime' / 'flybot-workspace-web' / 'features' / 'settings' / 'onboarding-data.json'


def build():
    sys.path.insert(0, str(ROOT))
    from flybot_workspace import automations, onboarding
    ids = set(onboarding.DEFAULT_TEMPLATES)
    for _keys, group in onboarding.GROUPS:
        ids.update(group)
    return {
        'version': 1,
        'industries': [[name, list(roles)] for name, roles in onboarding.INDUSTRIES.items()],
        'role_max': onboarding.ROLE_MAX,
        'groups': [[list(keys), list(group)] for keys, group in onboarding.GROUPS],
        'default_templates': list(onboarding.DEFAULT_TEMPLATES),
        'automation_templates': {tid: {'title': automations.TEMPLATES[tid]['title'],
                                       'prompt': automations.TEMPLATES[tid]['prompt']}
                                 for tid in sorted(ids) if tid in automations.TEMPLATES},
        'apps': [list(item) for item in onboarding.APPS],
        'general': [list(item) for item in onboarding.GENERAL],
        'by_industry': {name: [list(item) for item in items] for name, items in onboarding.BY_INDUSTRY.items()},
        'pick_max': onboarding.PICK_MAX,
        'look_options': {name: list(options) for name, options in onboarding.LOOK_OPTIONS.items()},
    }


def render():
    return json.dumps(build(), ensure_ascii=False, indent=1, sort_keys=True) + '\n'


if __name__ == '__main__':
    TARGET.write_text(render(), encoding='utf-8')
