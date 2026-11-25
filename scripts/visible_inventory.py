"""Reproducible source checklist, never a claim that every control was executed."""
import ast
import json
from html.parser import HTMLParser
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
DOC = 'docs/VISIBLE_FUNCTIONS_INVENTORY.md'
# Candidate route-level execution contracts, not a blanket passed-control label.
PROFILES = {
    'register': ('/register', 'unchanged closed-by-default registration policy, salted users/session cookies, ordinary private personal workspace; no operator-role grant', 'login entry -> public auth policy -> JSON register -> verified cookie session -> race-free personal-agent/workspace initialization -> normal settings and agent APIs', 'test_registration_page.py including actual controlled-model task/restart; registration_page.test.mjs; CI new-account form/first-home/agent reload scenes', 'Deployment must explicitly enable --open-registration and preserve exact public HTTPS Host/Origin; SMTP/MFA/reset and email auth PR293 remain separate'),
    'skills': ('/skills', 'skill_bindings, skill_task_owners, skill_task_material, skill_runs, capability/selection tables; bundled original and owner-private imported immutable instruction content, imported version/head/revoke history', '/v1/skills/catalog, /bindings, /scopes, /readiness, /runs -> own runtime or explicit owned scheduler -> digest validation/ack -> configured model -> durable result/document', 'tests/test_imported_skills.py; tests/skill_imports.test.mjs; tests/test_skill_packages.py; tests/test_skill_execution.py; tests/skills_page.test.mjs; tests/agent_loop.test.mjs; CI skills lifecycle/result editor', 'Own upgraded runtime/model; manual third-party instruction JSON is supported, but executable/archive/signed-registry/DSH/delegated skills absent; real-vendor quality unverified'),
    'chat': ('/chat', 'conversations, social messages/preferences/attachments/versions, private message_assists, group_announcements; draft composer', 'chat/app.mjs and utilities.mjs -> scoped conversation/message/assists/announcement APIs -> runtime or SQLite; explicit review before send', 'tests/chat_page.test.mjs; test_message_utilities.py; test_artifact_chat_bindings.py; CI representative chat scenes', 'Contributor332 own-message hiding landed; Model/runtime for assists; calls/voice/mute/automatic translation/agent uploads and active contributor slices remain unmet'),
    'artifacts': ('/space', 'artifacts, typed content, versions, favorites, shares, social_artifact_versions', 'artifacts/app.mjs -> workspace artifact CRUD/export/share and social send APIs with revision/idempotency', 'artifact Python/Node suites; test_office_exports.py; test_workspace_events.py; test_artifact_chat_bindings.py; CI works/export/revision scenes', 'DOCX and bounded Unicode text-PDF export plus data-only XLSX implemented and tested; full Office editing/PPTX/rendered thumbnails/media generation/CRDT collaboration absent; meetings #273'),
    'agents': ('/agents', 'workspace agents/teams/category/runtime bindings, conversations and API keys', 'agents/app.mjs -> workspace agent/team/conversation/runtime/key APIs', 'Existing agent/runtime/conversation suites; scoped skill context test', 'Active #316/#290/#313/#254; multi-agent orchestration/team directory unverified'),
    'automations': ('/automations', 'automations, runs, runtime tasks and saved artifacts', 'automations/app.mjs -> workspace automation/run APIs -> scheduler -> runtime', 'Existing scheduler/automation suites; CI representative runs', 'Contributor348 run detail landed; active #310; explicit owned instruction-skill scheduling implemented; no scheduled Composio, external triggers or distributed scheduler acceptance'),
    'memory': ('/memory', 'memory pages/profile/topics/actions/links', 'memory/app.mjs -> workspace memory/action/profile/search APIs with revisions', 'Existing memory suites and CI scenes; resource picker reads real memory', 'Contributor363 revision history/restore landed; active #299/#237; semantic retrieval/extraction/collaboration unverified'),
    'discover': ('/discover', 'directory entries/publications, profiles and follows', 'discover/app.mjs -> local Discover directory/filter/follow/publication APIs', 'Existing Discover suites and CI scenes', 'Active #280/#313; remote catalogue/recommendations/full team bundles not accepted'),
    'profile': ('/profile', 'profiles/follows/publications/visibility', 'profile/app.mjs -> profile/follow APIs; public server profile render', 'Existing profile/public-page suites and CI scenes', 'Active #298; complete privacy/visibility/social moderation unverified'),
    'team': ('/team', 'workspaces/teams/members/invites/approvals', 'team/app.mjs -> workspace/team/member/invite APIs', 'Existing team/invite/member suites and CI scenes', 'Active #281; real invitation/enterprise scenarios not exercised'),
    'members': ('/members', 'members/roles/invites/approvals', 'members/app.mjs -> workspace members/roles/invite APIs', 'Existing members/invites/permission suites', 'No real people invited; enterprise/SSO scenarios unverified'),
    'contacts': ('/contacts', 'Bot Social contacts and handles', 'contacts/app.mjs -> per-account social plugin -> shared Bot Social contact APIs', 'Contact API and gateway tests', 'Live account contact operations require a connected Bot Social service'),
    'team-runs': ('/team-runs', 'Workspace runs, step results and shares', 'team-runs/app.mjs -> per-account FlyBot team-runs plugin inside DS-Bot', 'Team runs page and native runtime tests', 'End-to-end execution requires configured agents and model access'),
    'meetings': ('/meetings', 'meetings/notes/action items/transcript search', 'meetings/app.mjs -> stored meeting/note/action/search APIs', 'Existing meeting suites and CI scenes', 'Active #289/#273; live meeting join/recording/transcription/calls absent'),
    'runtimes': ('/runtimes', 'runtime keys/connections/tasks/model access and encrypted model configuration', 'runtimes/app.mjs -> key/connect/task/diagnostic APIs; Python daemon/zipapp and container agent loop', 'Existing runtime suites; skill handshake/model context tests; CI key-prefix/daemon readiness preserved', 'Active #282; operator setup/deployment/real vendor/DSH integration not accepted'),
    'settings': ('/settings#section', 'user settings, encrypted model and per-user Composio configuration, existing keys', 'settings/app.mjs -> settings/model-api/composio/account key APIs; only verified consumers count as behavior', 'Existing settings/model/Composio tests; new chat rendering preference test', 'Active #284/#320; auto translate/reminders/full UI locale/privacy consumers and channels/authorized clients incomplete'),
    'onboarding': ('/onboarding', 'profile/industry/role/look/checklist state', 'onboarding/app.mjs -> existing profile/look/checklist APIs', 'Existing onboarding suites and CI steps', 'Active #294/#237/#281; real external setup not accepted'),
    'home': ('/', 'workspace/profile/recent works/search/notification state', 'home/app.mjs and shell -> authenticated homepage/search/navigation/notification APIs', 'Existing home/search/notification suites and CI scenes', 'Authenticated SSE invalidations consumed by chat/document editors; no token stream/browser delivery/full unread; contributor340 followed-public-work notifications landed; active #309/#284'),
    'messenger': ('/messenger -> /chat', 'Same social conversation state as chat', 'Compatibility redirect and messenger client -> chat/social APIs', 'Existing messenger redirect and social suites', 'Same unmet chat states; old route is not a second implementation'),
    'guide': ('/guide', 'Original static documentation', 'Guide client index/search/navigation', 'Existing guide suite/CI scene', 'Active #302; scene-level content/target verification incomplete'),
    'help': ('/help', 'Original static help documentation landed on main in contributor PR 307', 'settings_page allowlist -> served help page and real internal navigation', 'tests/docs_pages.test.mjs and tests/test_docs_pages.py', 'Individual help scenarios require browser verification'),
    'terms': ('/terms', 'Original static service terms landed on main in contributor PR 307', 'settings_page allowlist -> served terms and real internal navigation', 'tests/docs_pages.test.mjs and tests/test_docs_pages.py', 'Operator-specific legal review remains external; no legal compliance claim'),
    'privacy': ('/privacy', 'Original static privacy documentation landed on main in contributor PR 307', 'settings_page allowlist -> served privacy page and real internal navigation', 'tests/docs_pages.test.mjs and tests/test_docs_pages.py', 'Operator-specific policy review remains external; no legal compliance claim'),
    'about': ('/about', 'Original static branding/version/license information', 'Static served page and real repository links', 'Existing branding/page suites and CI scene', 'Individual branding and link states remain unverified'),
    'download': ('/download', 'Static platform/download guidance', 'Static served page and package/help targets', 'Existing served-page/navigation checks', 'Package availability/platform installation not independently accepted'),
    'server': ('server-generated auth/public/invite/share/agent pages', 'sessions/CSRF/registration/OIDC and existing profile/share/invite/key state', 'Source template -> corresponding authenticated/public render handler; source AST fragments do not prove a live route', 'Existing auth/public/share/invite/server-page tests; individual template state unverified', 'Active #293; SMTP/OIDC/MFA/reset/abuse/provider flows and conditional templates need separate acceptance'),
    'shell': ('shared navigation/account/menu', 'session, appearance/settings and current navigation', 'shell/app.mjs -> auth/logout/settings and real page hrefs', 'Existing shell/page suites and CI scenes', 'Help/legal pages landed in #307; active #317; download targets and conditional states unverified'),
}


def profile(name):
    route, state, execution, tests, dependency = PROFILES.get(name, PROFILES['server'])
    return {'route': route, 'backend_state': state, 'execution_path': execution,
            'verification': 'Individual control unverified unless explicitly exercised; route evidence: ' + tests,
            'external_dependency_or_gap': dependency, 'checklist': DOC}


class Controls(HTMLParser):
    def __init__(self, path, offset=0, surface=None):
        super().__init__()
        self.path, self.offset, self.surface = path, offset, surface or path.parent.name
        self.rows, self.active = [], []

    def handle_starttag(self, tag, attrs):
        if tag not in ('button', 'input', 'select', 'textarea', 'form', 'a'):
            return
        attrs = dict(attrs)
        if tag == 'a' and not attrs.get('href'):
            return
        row = {'source': str(self.path), 'line': self.getpos()[0] + self.offset, 'tag': tag,
               'id': attrs.get('id'), 'name': attrs.get('name'), 'href': attrs.get('href'),
               'type': attrs.get('type'), 'label': attrs.get('aria-label') or attrs.get('title') or '',
               'initially_disabled': 'disabled' in attrs,
               'data': {k: v for k, v in attrs.items() if k.startswith('data-')},
               'execution_profile': self.surface,
               'verification': 'unverified individual control/state; route-level evidence is not universal acceptance'}
        self.rows.append(row)
        if tag in ('button', 'a'):
            self.active.append((tag, row))

    def handle_endtag(self, tag):
        if self.active and self.active[-1][0] == tag:
            self.active.pop()

    def handle_data(self, text):
        for _, row in self.active:
            row['label'] += ' ' + text.strip()


def generate():
    controls, generated, templates, routes = [], [], [], {}
    for path in sorted((ROOT / 'flybot_workspace/static').rglob('*.html')):
        rel = path.relative_to(ROOT)
        parser = Controls(rel)
        parser.feed(path.read_text())
        controls.extend(parser.rows)
        scripts = list(path.parent.glob('*.mjs'))
        routes[str(rel)] = {'execution_profile': path.parent.name, 'candidate_apis': sorted(set(
            item for script in scripts for item in re.findall('/v1/[^"\'`\\s]+', script.read_text())))}
    for path in sorted((ROOT / 'flybot_workspace/static').rglob('*.mjs')):
        for line_number, line in enumerate(path.read_text().splitlines(), 1):
            if re.search(r"createElement\(['\"](?:button|input|select|textarea|a)['\"]\)", line):
                generated.append({'source': str(path.relative_to(ROOT)), 'line': line_number,
                                  'construction': line.strip(), 'execution_profile': path.parent.name,
                                  'verification': 'unverified dynamic construction site; conditional instances require execution'})
    for path in sorted((ROOT / 'flybot_workspace').glob('*.py')):
        tree = ast.parse(path.read_text())
        formatted = list(node for node in ast.walk(tree) if isinstance(node, ast.JoinedStr))
        inside_formatted = {id(child) for node in formatted for child in ast.walk(node) if child is not node}
        for node in ast.walk(tree):
            if id(node) in inside_formatted:
                continue
            if isinstance(node, ast.JoinedStr):
                text = ''.join(value.value if isinstance(value, ast.Constant) and isinstance(value.value, str)
                               else '{dynamic}' for value in node.values)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                text = node.value
            else:
                continue
            if not re.search(r'<(?:button|input|select|textarea|form|a)\b', text):
                continue
            parser = Controls(path.relative_to(ROOT), node.lineno - 1, 'server')
            parser.feed(text)
            templates.extend(parser.rows)
    return {
        'method': 'Source census of static HTML, dynamic JS construction sites and Python HTML string/template fragments. '
                  'Hidden/initially disabled entries retained; no completed-control percentage. Shared chrome repeats. '
                  'Python interpolation is symbolic, never evaluated. Runtime template expansion, attribute mutation and '
                  'permission/loading/error variants still need scene execution. Labels are repository UI, not account captures.',
        'execution_profiles': {name: profile(name) for name in PROFILES},
        'controls': controls, 'dynamic_sites': generated, 'server_template_controls': templates, 'routes': routes,
    }


def render(data):
    """One census record per line keeps the exhaustive JSON reviewable on GitHub."""
    fields = []
    for key, value in data.items():
        if isinstance(value, list):
            encoded = '[\n' + ',\n'.join('    ' + json.dumps(row, ensure_ascii=False) for row in value) + '\n  ]'
        else:
            encoded = json.dumps(value, ensure_ascii=False, indent=2).replace('\n', '\n  ')
        fields.append('  ' + json.dumps(key) + ': ' + encoded)
    return '{\n' + ',\n'.join(fields) + '\n}\n'


if __name__ == '__main__':
    data = generate()
    destination = ROOT / 'docs/inventory/visible-controls.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(render(data))
    print(len(data['controls']), 'static controls;', len(data['dynamic_sites']), 'dynamic sites;',
          len(data['server_template_controls']), 'server-template controls;', len(data['routes']), 'HTML surfaces')
