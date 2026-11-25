import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyComposioRows, applyConnectorSearch, applySettingsView, composioMessage, composioRowState, pickConnection, CONNECTOR_CATALOG, csrfCookie, describeAppearance, diff, filterConnectorCatalog, mount, newlineBinding, privacyChanges, readForm, renderModelApi, settingsViewFromLocation, syncAppearanceExtras, syncOverviewCurrentValues, syncMcpDialog, syncPrivacySaveButton, syncShortcutRows } from '../flybot_workspace/static/settings/app.mjs';
import { mountToolApprovals } from '../flybot_workspace/static/settings/connected-tools.mjs';

test('csrfCookie reads host-bound and development cookie names only', () => {
  assert.equal(csrfCookie('__Host-ot_csrf=token-a'), 'token-a');
  assert.equal(csrfCookie('ot_dev_session=x; ot_dev_csrf=token-b'), 'token-b');
  assert.equal(csrfCookie('csrf=nope; other=1'), '');
});

test('diff emits only changed settings keys', () => {
  const current = {appearance: 'system', appearance_schedule: 'sunset_sunrise',
                   appearance_start: '18:00', appearance_end: '07:00',
                   language: 'zh-CN', chat_language: 'auto', auto_translate: false,
                   send_shortcut: 'enter', message_folding: 'standard', document_cards: false,
                   link_previews: true, task_completion_reminders: true,
                   likes_visible: true, favorites_visible: true};
  assert.deepEqual(diff(current, current), {});
  assert.deepEqual(diff(current, {...current, appearance: 'dark', document_cards: true}),
                   {appearance: 'dark', document_cards: true});
});

test('readForm maps radios, select and checkboxes', () => {
  const form = {
    appearance: 'light', appearance_schedule: 'custom', appearance_start: '21:00',
    appearance_end: '06:00', language: 'en', chat_language: 'ja',
    send_shortcut: 'mod_enter', message_folding: 'compact',
  };
  const fake = {
    get(name) { return form[name]; },
    has(name) { return name === 'document_cards' || name === 'link_previews'; },
  };
  const original = globalThis.FormData;
  globalThis.FormData = class { constructor() { return fake; } };
  try {
    assert.deepEqual(readForm({}), {
      appearance: 'light', appearance_schedule: 'custom', appearance_start: '21:00',
      appearance_end: '06:00', language: 'en', chat_language: 'ja', auto_translate: false,
      send_shortcut: 'mod_enter', message_folding: 'compact', document_cards: true,
      link_previews: true, task_completion_reminders: false,
      likes_visible: false, favorites_visible: false,
    });
  } finally {
    globalThis.FormData = original;
  }
});

test('describeAppearance names the current look and next switch without inventing sunrise times', () => {
  assert.equal(describeAppearance({appearance: 'light'}), '当前为浅色。');
  assert.equal(describeAppearance({appearance: 'dark'}), '当前为深色。');
  const afternoon = new Date(2026, 10, 18, 15, 0, 0);
  const night = new Date(2026, 10, 18, 23, 0, 0);
  assert.equal(
    describeAppearance({appearance: 'auto', appearance_schedule: 'sunset_sunrise'}, afternoon),
    '浅色，直到 22:00。',
  );
  assert.equal(
    describeAppearance({appearance: 'auto', appearance_schedule: 'sunset_sunrise'}, night),
    '深色，直到 06:00。',
  );
  assert.equal(
    describeAppearance({
      appearance: 'auto', appearance_schedule: 'custom',
      appearance_start: '18:00', appearance_end: '07:00',
    }, afternoon),
    '浅色，直到 18:00。',
  );
  assert.equal(
    describeAppearance({
      appearance: 'auto', appearance_schedule: 'custom',
      appearance_start: '18:00', appearance_end: '07:00',
    }, new Date(2026, 10, 18, 20, 0, 0)),
    '深色，直到 07:00。',
  );
  const auto = describeAppearance({appearance: 'auto', appearance_schedule: 'sunset_sunrise'}, afternoon);
  assert.doesNotMatch(auto, /日落|日出/);
  assert.doesNotMatch(auto, /按系统浅色或深色偏好估算/);
  assert.doesNotMatch(auto, /拿不到你所在的位置/);
  assert.match(describeAppearance({appearance: 'system'}, afternoon, {matches: false}), /当前为浅色（跟随系统）。/);
  assert.match(describeAppearance({appearance: 'system'}, afternoon, {matches: true}), /当前为深色（跟随系统）。/);
});


test('syncOverviewCurrentValues shows saved choices in the current language', () => {
  const appearance = {textContent: ''};
  const folding = {textContent: ''};
  const nodes = {'appearance-current': appearance, 'folding-current': folding};
  const document = {documentElement: {lang: 'zh-CN'}, getElementById: (id) => nodes[id]};
  syncOverviewCurrentValues(document, {appearance: 'auto', message_folding: 'standard'});
  assert.equal(appearance.textContent, '自动');
  assert.equal(folding.textContent, '标准');
  document.documentElement.lang = 'en';
  syncOverviewCurrentValues(document, {appearance: 'light', message_folding: 'compact'});
  assert.equal(appearance.textContent, 'Light');
  assert.equal(folding.textContent, 'Compact');
  syncOverviewCurrentValues(document, {appearance: 'unknown', message_folding: ''});
  assert.equal(appearance.textContent, '');
  assert.equal(folding.textContent, '');
});

test('the settings overview lists preference and support rows in order', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/settings/index.html', import.meta.url), 'utf8');
  const prefs = html.slice(html.indexOf('id="group-prefs"'), html.indexOf('id="group-notification-prefs"'));
  const prefHrefs = [...prefs.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(prefHrefs, [
    '/settings/message-folding',
    '/settings/appearance',
    '/settings/privacy',
    '/settings/shortcuts',
  ]);
  assert.match(prefs, /id="folding-current"/);
  assert.match(prefs, /id="appearance-current"/);
  assert.match(prefs, /settings-row-label">隐私设置</);
  const support = html.slice(html.indexOf('id="group-support"'), html.indexOf('id="settings-form"'));
  const supportHrefs = [...support.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(supportHrefs, [
    '/help',
    '/guide',
    '/terms',
    '/privacy',
    '/about',
    'https://github.com/ThinkFlowLab/FlyBot/issues',
  ]);
  assert.doesNotMatch(support, /退款政策/);
});

test('settingsViewFromLocation maps recorded paths and leftover hashes', () => {
  assert.equal(settingsViewFromLocation('/settings', ''), 'hub');
  assert.equal(settingsViewFromLocation('/settings/', ''), 'hub');
  assert.equal(settingsViewFromLocation('/settings/appearance', ''), 'appearance');
  assert.equal(settingsViewFromLocation('/settings/language', ''), 'language');
  assert.equal(settingsViewFromLocation('/settings/message-folding', ''), 'message-folding');
  assert.equal(settingsViewFromLocation('/settings/privacy', ''), 'privacy');
  assert.equal(settingsViewFromLocation('/settings/shortcuts', ''), 'shortcuts');
  assert.equal(settingsViewFromLocation('/settings/channels', ''), 'channels');
  assert.equal(settingsViewFromLocation('/settings/agent-access', ''), 'agent-access');
  assert.equal(settingsViewFromLocation('/settings/connectors', ''), 'connectors');
  assert.equal(settingsViewFromLocation('/settings/skill-configuration', ''), 'skill-configuration');
  assert.equal(settingsViewFromLocation('/settings', '#skill-secrets'), 'skill-configuration');
  assert.equal(settingsViewFromLocation('/settings', '#appearance'), 'appearance');
  assert.equal(settingsViewFromLocation('/settings', '#language-section'), 'language');
  assert.equal(settingsViewFromLocation('/settings', '#send-shortcut'), 'shortcuts');
  assert.equal(settingsViewFromLocation('/settings', '#message-display'), 'message-folding');
  assert.equal(settingsViewFromLocation('/settings', '#model-api'), 'model-api');
  assert.equal(settingsViewFromLocation('/settings', '#video-api'), 'model-api');
  assert.equal(settingsViewFromLocation('/settings/model-api', '#video-api'), 'model-api');
  assert.equal(settingsViewFromLocation('/settings', '#music-api'), 'model-api');
  assert.equal(settingsViewFromLocation('/settings', '#model3d-api'), 'model-api');
});

test('applySettingsView shows one recorded page at a time', () => {
  const hub = {hidden: false};
  const appearance = {hidden: true, getAttribute: () => 'appearance'};
  const language = {hidden: true, getAttribute: () => 'language'};
  const document = {
    querySelectorAll(selector) {
      if (selector === '[data-settings-hub]') return [hub];
      if (selector === '[data-settings-page]') return [appearance, language];
      return [];
    },
  };
  applySettingsView(document, 'appearance');
  assert.equal(hub.hidden, true);
  assert.equal(appearance.hidden, false);
  assert.equal(language.hidden, true);
  applySettingsView(document, 'hub');
  assert.equal(hub.hidden, false);
  assert.equal(appearance.hidden, true);
  assert.equal(language.hidden, true);
});

test('syncAppearanceExtras hides schedule controls until auto is selected', () => {
  const scheduleCard = {hidden: false};
  const customFields = {hidden: false};
  const zone = {textContent: ''};
  const document = {
    getElementById(id) {
      if (id === 'appearance-schedule-card') return scheduleCard;
      if (id === 'custom-period-fields') return customFields;
      if (id === 'appearance-time-zone') return zone;
      return null;
    },
  };
  syncAppearanceExtras(document, {appearance: 'light', appearance_schedule: 'custom'});
  assert.equal(scheduleCard.hidden, true);
  assert.equal(customFields.hidden, true);
  syncAppearanceExtras(document, {appearance: 'auto', appearance_schedule: 'sunset_sunrise'});
  assert.equal(scheduleCard.hidden, false);
  assert.equal(customFields.hidden, true);
  syncAppearanceExtras(document, {appearance: 'auto', appearance_schedule: 'custom'});
  assert.equal(scheduleCard.hidden, false);
  assert.equal(customFields.hidden, false);
});

test('appearance choices keep the radio beside the title when the hint wraps', () => {
  const html = readFileSync(new URL('../flybot_workspace/static/settings/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../flybot_workspace/static/settings/app.css', import.meta.url), 'utf8');
  const autoHint = html.match(/value="auto">\s*<span>自动<span class="hint">([^<]+)<\/span>/);
  assert.ok(autoHint, 'auto option has a title and hint');
  assert.match(autoHint[1], /白天浅色、夜间深色。按下面的时段或你设定的时间切换。/);
  assert.doesNotMatch(autoHint[1], /22:00|日落/);
  const appearanceStart = html.indexOf('fieldset id="appearance"');
  const scheduleStart = html.indexOf('id="appearance-schedule-card"');
  const statusStart = html.indexOf('id="appearance-status"');
  assert.ok(appearanceStart > 0 && scheduleStart > appearanceStart);
  assert.ok(statusStart > scheduleStart);
  assert.ok(statusStart < html.indexOf('</fieldset>', scheduleStart));
  assert.match(css, /#appearance \.choice,\s*#appearance-schedule-card \.choice,\s*#message-display \.choice \{\s*display: grid;/);
  assert.match(css, /grid-template-columns: auto minmax\(0, 1fr\)/);
});

test('syncAppearanceExtras moves the status into the schedule card only for auto', () => {
  const parent = { children: [] };
  const timezoneNote = { className: 'note' };
  const laterNote = { className: 'note' };
  const status = { id: 'appearance-status', parentNode: parent };
  const appearance = { id: 'appearance', parentNode: parent };
  const scheduleCard = {
    hidden: false,
    notes: [timezoneNote, laterNote],
    querySelectorAll(selector) {
      assert.equal(selector, ':scope > .note');
      return this.notes;
    },
    insertBefore(node, before) {
      this.inserted = { node, before };
      node.parentNode = this;
    },
  };
  parent.insertBefore = (node, before) => {
    parent.moved = { node, before };
    node.parentNode = parent;
  };
  const nodes = {
    'appearance-status': status,
    'appearance-schedule-card': scheduleCard,
    appearance,
    'custom-period-fields': { hidden: false },
    'appearance-time-zone': { textContent: '' },
  };
  const document = { getElementById: (id) => nodes[id] || null };
  syncAppearanceExtras(document, { appearance: 'auto', appearance_schedule: 'sunset_sunrise' });
  assert.equal(scheduleCard.hidden, false);
  assert.equal(scheduleCard.inserted.node, status);
  assert.equal(scheduleCard.inserted.before, laterNote);
  syncAppearanceExtras(document, { appearance: 'light' });
  assert.equal(scheduleCard.hidden, true);
  assert.equal(parent.moved.node, status);
  assert.equal(parent.moved.before, scheduleCard);
});

test('newlineBinding complements the recorded send shortcut', () => {
  assert.equal(newlineBinding('enter'), 'Shift+Enter');
  assert.equal(newlineBinding('mod_enter'), 'Enter');
  assert.equal(newlineBinding(undefined), 'Shift+Enter');
});

test('syncShortcutRows renders complementary key chips', () => {
  const children = [];
  const keys = {
    replaceChildren() { children.length = 0; },
    appendChild(node) { children.push(node); return node; },
  };
  const document = {
    getElementById(id) { return id === 'newline-keys' ? keys : null; },
    createElement(tag) { return {tagName: tag, className: '', textContent: ''}; },
  };
  syncShortcutRows(document, {send_shortcut: 'enter'});
  assert.deepEqual(children.filter((node) => node.tagName === 'kbd').map((node) => node.textContent), ['Shift', 'Enter']);
  syncShortcutRows(document, {send_shortcut: 'mod_enter'});
  assert.deepEqual(children.filter((node) => node.tagName === 'kbd').map((node) => node.textContent), ['Enter']);
});

test('syncPrivacySaveButton stays disabled until a privacy value changes', () => {
  const button = {disabled: false};
  const document = { getElementById(id) { return id === 'save' ? button : null; } };
  const current = {likes_visible: true, favorites_visible: true};
  syncPrivacySaveButton(document, current, current);
  assert.equal(button.disabled, true);
  syncPrivacySaveButton(document, current, {...current, likes_visible: false});
  assert.equal(button.disabled, false);
  assert.deepEqual(privacyChanges(current, {...current, favorites_visible: false}), {favorites_visible: false});
  assert.deepEqual(privacyChanges(current, current), {});
});

test('syncMcpDialog opens and closes the recorded instruction dialog', () => {
  const dialog = {hidden: true};
  const trigger = {attrs: {'aria-expanded': 'false'}, setAttribute(name, value) { this.attrs[name] = value; }, focus() { this.focused = true; }};
  const ack = {focus() { this.focused = true; }};
  const document = {
    getElementById(id) {
      if (id === 'mcp-dialog') return dialog;
      if (id === 'add-mcp-server') return trigger;
      if (id === 'mcp-dialog-ack') return ack;
      return null;
    },
  };
  syncMcpDialog(document, true);
  assert.equal(dialog.hidden, false);
  assert.equal(trigger.attrs['aria-expanded'], 'true');
  assert.equal(ack.focused, true);
  syncMcpDialog(document, false);
  assert.equal(dialog.hidden, true);
  assert.equal(trigger.attrs['aria-expanded'], 'false');
  assert.equal(trigger.focused, true);
});

test('applySettingsView closes the MCP dialog when leaving connectors', () => {
  const dialog = {hidden: false};
  const trigger = {attrs: {'aria-expanded': 'true'}, setAttribute(name, value) { this.attrs[name] = value; }, focus() { this.focused = true; }};
  const nodes = [];
  const document = {
    querySelectorAll() { return nodes; },
    getElementById(id) {
      if (id === 'mcp-dialog') return dialog;
      if (id === 'add-mcp-server') return trigger;
      return null;
    },
  };
  applySettingsView(document, 'hub');
  assert.equal(dialog.hidden, true);
  assert.equal(trigger.attrs['aria-expanded'], 'false');
});


const SETTINGS_FRONTEND = [
  new URL('../flybot_workspace/static/settings/index.html', import.meta.url),
  new URL('../flybot_workspace/static/settings/app.mjs', import.meta.url),
  new URL('../flybot_workspace/static/settings/app.css', import.meta.url),
  new URL('../docs/SETTINGS.md', import.meta.url),
];

const SECRET_MARKERS = [
  'Ov23liin4waZGLSJJgn5',
  'DS_BOT_GITHUB_OAUTH_CLIENT_ID',
  'githubcopilot.com',
  'mcp.notion.com',
  'mcp.linear.app',
  'mcp.atlassian.com',
  'mcp.sentry.dev',
  'mcp.stripe.com',
  'mcp.paypal.com',
  'mcp.squareup.com',
  'bindings.mcp.cloudflare.com',
  'mcp.vercel.com',
  'mcp.supabase.com',
  'mcp.neon.tech',
  'mcp.figma.com',
  'mcp.canva.com',
  'mcp.intercom.com',
  'mcp.monday.com',
  'mcp.webflow.com',
  'mcp.wix.com',
  'netlify-mcp.netlify.app',
  'mcp.airtable.com',
  'mcp.dropbox.com',
  'mcp.zapier.com',
  'mcp.clickup.com',
  'ai.todoist.net',
  'mcp.miro.com',
  'mcp.attio.com',
  'mcp.postman.com',
  'mcp.asana.com',
  'mcp.box.com',
  'mcp.hubspot.com',
  'mcp.slack.com',
  'huggingface.co/mcp',
  'mcp.exa.ai',
  'mcp.deepwiki.com',
  'mcp.context7.com',
  'learn.microsoft.com/api/mcp',
  'docs.mcp.cloudflare.com',
  'mcp.amap.com',
  'api.github.com/user',
  'X-MCP-Toolsets',
  'lbs.amap.com',
  'GITHUB_TOKEN',
];

test('CONNECTOR_CATALOG is the 39 public DS-Bot entries', () => {
  assert.equal(CONNECTOR_CATALOG.length, 39);
  assert.deepEqual(CONNECTOR_CATALOG.map((item) => item.id), [
    'github', 'notion', 'linear', 'atlassian', 'sentry', 'stripe', 'paypal', 'square',
    'cloudflare', 'vercel', 'supabase', 'neon', 'figma', 'canva', 'intercom', 'monday',
    'webflow', 'wix', 'netlify', 'airtable', 'dropbox', 'zapier', 'clickup', 'todoist',
    'miro', 'attio', 'postman', 'asana', 'box', 'hubspot', 'slack', 'huggingface', 'exa',
    'deepwiki', 'context7', 'mslearn', 'cloudflare-docs', 'amap', 'mail',
  ]);
  for (const item of CONNECTOR_CATALOG) {
    assert.deepEqual(Object.keys(item).sort(), ['about', 'category', 'id', 'name']);
    assert.equal(typeof item.about, 'string');
    assert.ok(item.about.length > 0);
  }
});

test('filterConnectorCatalog matches name, about, or id and is empty when nothing matches', () => {
  assert.equal(filterConnectorCatalog('').length, 39);
  assert.equal(filterConnectorCatalog('   ').length, 39);
  const github = filterConnectorCatalog('GitHub');
  assert.deepEqual(github.map((item) => item.id), ['github']);
  const byAbout = filterConnectorCatalog('pull requests');
  assert.deepEqual(byAbout.map((item) => item.id), ['github']);
  const byId = filterConnectorCatalog('cloudflare-docs');
  assert.deepEqual(byId.map((item) => item.id), ['cloudflare-docs']);
  const payments = filterConnectorCatalog('payments');
  assert.deepEqual(payments.map((item) => item.id), ['stripe', 'paypal', 'square']);
  assert.deepEqual(filterConnectorCatalog('no-such-connector-xyz'), []);
  assert.equal(filterConnectorCatalog('', CONNECTOR_CATALOG, 'dev').length, 6);
  assert.deepEqual(filterConnectorCatalog('cloudflare', CONNECTOR_CATALOG, 'docs').map(item => item.id), ['cloudflare-docs']);
  assert.deepEqual(filterConnectorCatalog('github', CONNECTOR_CATALOG, 'mail'), []);
});

test('applyConnectorSearch hides unmatched rows and shows the empty state', () => {
  const rows = CONNECTOR_CATALOG.map((item) => ({
    id: item.id,
    hidden: false,
    getAttribute(name) { return name === 'data-connector-id' ? this.id : null; },
  }));
  const empty = {hidden: true};
  const document = {
    getElementById(id) {
      if (id === 'connectors-catalog') {
        return {querySelectorAll() { return rows; }};
      }
      if (id === 'connectors-empty') return empty;
      return null;
    },
  };
  const visible = applyConnectorSearch(document, 'mailbox');
  assert.deepEqual(visible.map((item) => item.id), ['mail']);
  assert.equal(rows.find((row) => row.id === 'mail').hidden, false);
  assert.equal(rows.filter((row) => !row.hidden).length, 1);
  assert.equal(empty.hidden, true);
  applyConnectorSearch(document, 'mailbox', 'dev');
  assert.equal(rows.every((row) => row.hidden), true);
  assert.equal(empty.hidden, false);
  applyConnectorSearch(document, '');
  assert.equal(rows.every((row) => !row.hidden), true);
  assert.equal(empty.hidden, true);
});

test('settings connectors markup lists the catalog as disconnected without leaking secrets', () => {
  const html = readFileSync(fileURLToPath(new URL('../flybot_workspace/static/settings/index.html', import.meta.url)), 'utf8');
  const ids = [...html.matchAll(/data-connector-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, CONNECTOR_CATALOG.map((item) => item.id));
  assert.equal((html.match(/class="connector-row"/g) || []).length, 39);
  // Before the signed-in Composio state loads, every row is disabled: 31 rows
  // map to a Composio toolkit and say 未配置 Composio, 8 have no toolkit (未接通).
  assert.equal((html.match(/<span class="connector-status" data-state="loading">正在读取…<\/span>/g) || []).length, 31);
  assert.equal((html.match(/<span class="connector-status" data-state="unavailable">未接通<\/span>/g) || []).length, 8);
  assert.equal((html.match(/data-composio-action="connect" disabled title="正在读取连接配置。">\+ 连接<\/button>/g) || []).length, 31);
  assert.equal((html.match(/disabled title="未接通：Composio 没有这个应用，暂时不能连接。">\+ 连接<\/button>/g) || []).length, 8);
  assert.match(html, /id="composio-key-input" name="api_key" type="password"/);
  assert.match(html, /id="connectors-key-jump" href="#composio-key-input" hidden/);
  const groups = [...html.matchAll(/data-connector-group="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(new Set(groups), new Set(['all', ...CONNECTOR_CATALOG.map(item => item.category)]));
  assert.equal((html.match(/class="connector-mark"/g) || []).length, 39);
  assert.match(html, /data-mark="github"/);
  assert.match(html, /class="channel-mark" data-mark="slack"/);
  assert.match(html, /class="connector-search-icon"/);
  assert.match(html, /id="connectors-empty"[^>]*hidden[^>]*>没有匹配的应用。/);
  assert.doesNotMatch(html, /还没有可连接的应用目录/);
  assert.doesNotMatch(html, /已连接/);
  for (const item of CONNECTOR_CATALOG) {
    assert.ok(html.includes(`>${item.name}<`), item.name);
    assert.ok(html.includes(item.about), item.id);
  }
  const sources = SETTINGS_FRONTEND.map((url) => readFileSync(fileURLToPath(url), 'utf8')).join('\n');
  for (const marker of SECRET_MARKERS) {
    assert.equal(sources.includes(marker), false, marker);
  }
});

// --- skill-secret delete confirmation (page only) ---

const SETTINGS_VALUES = {
  appearance: 'light', appearance_schedule: 'sunset_sunrise', appearance_start: '20:00',
  appearance_end: '07:00', language: 'zh-CN', chat_language: '', auto_translate: false,
  send_shortcut: 'enter', message_folding: 'all', document_cards: true, link_previews: true,
  task_completion_reminders: false, likes_visible: true, favorites_visible: true,
};

class SettingsNode {
  constructor(tag = 'div', doc = null) {
    this.tagName = tag;
    this._doc = doc;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.handlers = {};
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.className = '';
    this.type = '';
    this.id = '';
    this.name = '';
    this._text = '';
    this.elements = {};
    this.selectedOptions = [{textContent: '中文'}];
  }
  set textContent(value) {
    this._text = value;
    if (value === '') this.children = [];
  }
  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }
  addEventListener(type, handler) { (this.handlers[type] ||= []).push(handler); }
  removeEventListener() {}
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  prepend(...children) {
    for (const child of children) child.parentElement = this;
    this.children.unshift(...children);
  }
  remove() {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }
  replaceChildren(...nodes) { this.children = []; for (const node of nodes) this.appendChild(node); }
  focus() { if (this._doc) this._doc.activeElement = this; }
  querySelector(selector) {
    if (this.tagName === 'form' && /select\[name="language"\]/.test(selector)) {
      return this.elements.language || null;
    }
    return null;
  }
  querySelectorAll() { return []; }
  addEventListenerOnce(type, handler) { this.addEventListener(type, handler); }
}

function settingsDocument() {
  const elements = new Map();
  const doc = {
    readyState: 'complete',
    cookie: 'ot_dev_csrf=token-a',
    activeElement: null,
    documentElement: {lang: '', dataset: {}},
    body: {dataset: {}},
    handlers: {},
    getElementById(id) {
      if (!elements.has(id)) {
        const tag = id.endsWith('-form') ? 'form' : id === 'skill-secret-list' ? 'ul' : 'div';
        const node = new SettingsNode(tag, doc);
        node.id = id;
        node.elements = new Proxy({}, {
          get(target, name) {
            if (typeof name !== 'string') return undefined;
            if (!target[name]) {
              const field = new SettingsNode('input', doc);
              field.name = name;
              target[name] = field;
            }
            return target[name];
          },
        });
        elements.set(id, node);
      }
      return elements.get(id);
    },
    createElement(tag) { return new SettingsNode(tag, doc); },
    querySelectorAll() { return []; },
    addEventListener(type, handler) { (doc.handlers[type] ||= []).push(handler); },
    fire(type, event = {}) {
      const payload = {type, preventDefault() {}, ...event};
      if (payload.target && typeof payload.target === 'object') {
        for (const handler of payload.target.handlers?.[type] || []) handler(payload);
      }
      for (const handler of doc.handlers[type] || []) handler(payload);
      return payload;
    },
  };
  return {doc, elements};
}

function settingsJson(status, body) { return {status, json: async () => body}; }

test('model settings show the ready platform model, keep personal credentials optional, and clear stale account state', () => {
  const {doc} = settingsDocument();
  const el = id => doc.getElementById(id);
  const form = el('model-api-form');
  doc.documentElement.lang = 'zh-CN';
  const platform = {
    model_api: {revision: 0, api_key_set: false},
    effective: {source: 'platform', model: 'DeepSeek-V4.1-Flash', base_url: 'https://internal.example/v1'},
  };
  renderModelApi(doc, form, platform);
  assert.equal(el('model-key-state').textContent, '平台默认');
  assert.equal(el('model-effective-source').textContent, '正在使用平台默认配置');
  assert.equal(el('model-effective-model').textContent, ' (DeepSeek-V4.1-Flash)');
  assert.equal(el('model-platform-ready').hidden, false);
  assert.equal(el('model-api-override').hidden, false);
  assert.equal(el('model-api-override').open, false);
  assert.equal(el('restore-platform-model').hidden, true);
  assert.equal(form.elements.base_url.value, '', 'the platform endpoint is never placed in the personal form');
  assert.equal(form.elements.api_key.value, '');
  assert.equal(form.elements.api_key.required, true, 'creating an override requires a personal key');

  doc.documentElement.lang = 'en';
  renderModelApi(doc, form, {
    model_api: {revision: 2, api_key_set: true, provider: 'custom', model: 'owner-model', base_url: 'https://owner.example/v1'},
    effective: {source: 'account', model: 'owner-model'},
  });
  assert.equal(el('model-key-state').textContent, 'Personal configuration');
  assert.equal(el('model-effective-source').textContent, 'Using your personal configuration');
  assert.equal(el('model-api-override').open, true);
  assert.equal(el('model-platform-ready').hidden, true);
  assert.equal(el('restore-platform-model').hidden, false);
  assert.equal(form.elements.model.value, 'owner-model');
  assert.equal(form.elements.api_key.value, '');
  assert.equal(form.elements.api_key.required, false);

  renderModelApi(doc, form, null, true);
  assert.equal(el('model-effective-source').textContent, 'Could not check model status');
  assert.equal(el('model-effective-model').textContent, '');
  assert.equal(el('model-api-override').hidden, true);
  assert.equal(el('model-api-fields').disabled, true);
  assert.equal(form.elements.model.value, '');
});

function makeSettingsApi({secrets = ['GITHUB_TOKEN', 'OPENAI_KEY']}) {
  const calls = [];
  const items = secrets.map(name => ({name}));
  async function fetcher(path, options = {}) {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({method, path, body});
    if (path === '/v1/auth/session') return settingsJson(200, {user: {id: 'u-me', username: 'alice'}});
    if (path === '/v1/settings') return settingsJson(200, {settings: {values: {...SETTINGS_VALUES}, revision: 4}});
    if (path === '/v1/model-api') return settingsJson(200, {model_api: {revision: 1, api_key_set: false}, effective: {source: 'platform'}});
    if (path === '/v1/skill-secrets' && method === 'GET') return settingsJson(200, {items: items.map(item => ({...item}))});
    if (path === '/v1/skill-secrets' && method === 'POST') {
      if (body && body.action === 'delete') {
        const index = items.findIndex(item => item.name === body.name);
        if (index >= 0) items.splice(index, 1);
        return settingsJson(200, {deleted: body.name});
      }
      if (body && body.action === 'set') {
        items.push({name: body.name});
        return settingsJson(200, {saved: body.name});
      }
    }
    throw new Error('unexpected request ' + method + ' ' + path);
  }
  return {fetcher, calls, items};
}

async function settleSettings(rounds = 24) {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setImmediate(resolve));
}

const REAL_FORM_DATA = globalThis.FormData;
function stubFormData(node) {
  globalThis.FormData = class {
    constructor() { this.node = node; }
    get(name) {
      const field = this.node && this.node.elements && this.node.elements[name];
      if (!field) return null;
      return field.type === 'checkbox' ? (field.checked ? 'on' : null) : field.value;
    }
    has(name) {
      const field = this.node && this.node.elements && this.node.elements[name];
      return Boolean(field && (field.type === 'checkbox' ? field.checked : true));
    }
  };
}

function stubWindowListeners() {
  const previous = globalThis.addEventListener;
  if (typeof globalThis.addEventListener !== 'function') {
    globalThis.addEventListener = () => {};
    return () => { delete globalThis.addEventListener; };
  }
  return () => { globalThis.addEventListener = previous; };
}

async function mountSettingsPage({secrets} = {}) {
  const {doc} = settingsDocument();
  const {fetcher, calls, items} = makeSettingsApi(secrets === undefined ? {} : {secrets});
  stubFormData(doc.getElementById('settings-form'));
  const restoreListeners = stubWindowListeners();
  try {
    await mount(doc, {fetcher});
    await settleSettings();
  } finally {
    globalThis.FormData = REAL_FORM_DATA;
    restoreListeners();
  }
  return {
    doc, calls, items,
    list: doc.getElementById('skill-secret-list'),
    secretForm: doc.getElementById('skill-secrets-form'),
    status: doc.getElementById('status'),
  };
}

test('failed model status can be rechecked once without reloading settings', async () => {
  const {doc} = settingsDocument();
  const api = makeSettingsApi({});
  const retry = doc.getElementById('retry-model-api');
  const readCount = {models: 0, settings: 0};
  let finishRetry;
  const fetcher = (path, options) => {
    if (path === '/v1/model-api') {
      readCount.models += 1;
      if (readCount.models === 1) return settingsJson(503, {});
      return new Promise(resolve => { finishRetry = resolve; });
    }
    if (path === '/v1/settings') readCount.settings += 1;
    return api.fetcher(path, options);
  };
  stubFormData(doc.getElementById('settings-form'));
  const restoreListeners = stubWindowListeners();
  try {
    await mount(doc, {fetcher});
    await settleSettings();
    assert.equal(retry.hidden, false);
    assert.equal(doc.getElementById('model-key-state').textContent, '读取失败');
    assert.equal(doc.getElementById('model-api-fields').disabled, true);
    retry.focus();
    doc.fire('click', {target:retry});
    doc.fire('click', {target:retry});
    assert.equal(retry.disabled, true);
    assert.deepEqual(readCount, {models:2, settings:1});
    finishRetry(settingsJson(200, {
      model_api:{revision:4, api_key_set:false},
      effective:{source:'platform', model:'shared-model'},
    }));
    await settleSettings();
    assert.equal(retry.hidden, true);
    assert.equal(doc.getElementById('model-api-fields').disabled, false);
    assert.equal(doc.getElementById('model-effective-model').textContent, ' (shared-model)');
    assert.equal(doc.activeElement, doc.getElementById('model-api-override-title'));
    assert.deepEqual(readCount, {models:2, settings:1});
  } finally {
    globalThis.FormData = REAL_FORM_DATA;
    restoreListeners();
  }
});

test('notification settings load native values, save only the changed switch and restore it on failure', async () => {
  const {doc} = settingsDocument();
  const api = makeSettingsApi({});
  const calls = [];
  const stored = {mentions: true, task_completion: false, artifacts: true};
  let fail = false;
  const fetcher = async (path, options) => {
    if (path !== '/v1/notification-prefs') return api.fetcher(path, options);
    calls.push(options.method);
    if (options.method === 'PUT') {
      if (fail) throw new Error('network unavailable');
      const {changes} = JSON.parse(options.body);
      assert.deepEqual(changes, {mentions: false});
      Object.assign(stored, changes);
    }
    return settingsJson(200, {prefs: {...stored}});
  };
  const restore = stubWindowListeners();
  stubFormData(doc.getElementById('settings-form'));
  try {
    await mount(doc, {fetcher});
    const mention = doc.getElementById('notify-mentions');
    const task = doc.getElementById('notify-task-completion');
    const work = doc.getElementById('notify-artifacts');
    assert.deepEqual([mention.checked, task.checked, work.checked], [true, false, true]);
    assert.deepEqual([mention.disabled, task.disabled, work.disabled], [false, false, false]);
    mention.checked = false;
    doc.fire('change', {target: mention});
    await settleSettings();
    assert.equal(mention.checked, false);
    assert.match(doc.getElementById('notification-prefs-state').textContent, /隐藏/);
    fail = true;
    task.checked = true;
    doc.fire('change', {target: task});
    await settleSettings();
    assert.equal(task.checked, false);
    assert.equal(task.disabled, false);
    assert.match(doc.getElementById('notification-prefs-state').textContent, /未能保存/);
    assert.deepEqual(calls, ['GET', 'PUT', 'PUT']);
  } finally {
    globalThis.FormData = REAL_FORM_DATA;
    restore();
  }
});

async function checkMediaModelForm(type, provider, model) {
  const {doc} = settingsDocument();
  const api = makeSettingsApi({});
  const changes = [];
  const key = 'synthetic-' + type + '-key';
  let config = {provider, model, has_api_key: false, revision: 2};
  const fetcher = async (path, options) => {
    if (path === '/v1/model-api/' + type) {
      if (options.method === 'POST') {
        const change = JSON.parse(options.body);
        changes.push(change);
        config = {...config, has_api_key: change.api_key !== null, revision: config.revision + 1};
      }
      return settingsJson(200, {[type + '_api']: config});
    }
    if (path === '/v1/model-api/image') return settingsJson(404, {});
    return api.fetcher(path, options);
  };
  const previousLocation = globalThis.location;
  globalThis.location = {pathname: '/settings/model-api', hash: '#' + type + '-api'};
  const restoreListeners = stubWindowListeners();
  stubFormData(doc.getElementById('settings-form'));
  try {
    await mount(doc, {fetcher});
    const form = doc.getElementById(type + '-api-form');
    const remove = doc.getElementById('clear-' + type + '-api');
    assert.equal(doc.getElementById(type + '-api').disabled, false);
    assert.equal(remove.hidden, true);
    form.elements.api_key.value = key;
    doc.fire('submit', {target: form});
    assert.equal(form.elements.api_key.value, '');
    await settleSettings();
    assert.equal(remove.hidden, false);
    doc.fire('click', {target: remove});
    await settleSettings();
    assert.equal(remove.hidden, true);
    assert.deepEqual(changes, [
      {revision: 2, api_key: key},
      {revision: 3, api_key: null},
    ]);
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    globalThis.FormData = REAL_FORM_DATA;
    restoreListeners();
  }
}

test('the video model form saves and clears the write-only key using its own revision',
  () => checkMediaModelForm('video', 'runway', 'gen4.5'));
test('the music model form saves and clears the write-only key using its own revision',
  () => checkMediaModelForm('music', 'elevenlabs', 'music_v2_5'));
test('the 3D model form saves and clears the write-only Meshy key using its own revision',
  () => checkMediaModelForm('model3d', 'meshy', 'meshy-7.1'));

function secretRow(list, name) {
  return list.children.find(row => row.children.some(child => child.tagName === 'button' && child.textContent === '删除')
    && row.textContent.includes(name));
}

function secretDialog(row) {
  return row.children.find(child => child.getAttribute('role') === 'alertdialog');
}

test('removeSecretPrompt words the delete question with the server-side name', async () => {
  const {removeSecretPrompt} = await import('../flybot_workspace/static/settings/app.mjs');
  assert.deepEqual(removeSecretPrompt({name: 'GITHUB_TOKEN'}),
    {question: '删除技能密钥「GITHUB_TOKEN」？', confirmLabel: '确认删除'});
});

test('clicking delete asks inline before calling the API', async () => {
  const {doc, calls, list, status} = await mountSettingsPage();
  const before = calls.length;
  const row = secretRow(list, 'GITHUB_TOKEN');
  const remove = row.children.find(child => child.tagName === 'button' && child.textContent === '删除');

  doc.fire('click', {target: remove});
  await settleSettings();

  const posts = calls.slice(before).filter(call => call.method === 'POST');
  assert.equal(posts.length, 0, 'the first click must not call the API');
  assert.equal(remove.hidden, true, 'the trigger yields its place to the question');
  const box = secretDialog(row);
  assert.ok(box, 'an alertdialog appears in the same row');
  const question = box.children[0];
  assert.equal(question.textContent, '删除技能密钥「GITHUB_TOKEN」？');
  assert.equal(box.getAttribute('aria-labelledby'), question.id);
  assert.equal(box.children[1].textContent, '取消');
  assert.equal(box.children[2].textContent, '确认删除');
  assert.equal(doc.activeElement, box.children[1], 'focus starts on cancel');
  assert.match(row.textContent, /GITHUB_TOKEN/, 'the key is still listed');
  assert.equal(status.textContent, '', 'the status line is untouched');
});

test('cancelling the delete question sends nothing and restores focus', async () => {
  const {doc, calls, list} = await mountSettingsPage();
  const before = calls.length;
  const row = secretRow(list, 'GITHUB_TOKEN');
  const remove = row.children.find(child => child.tagName === 'button' && child.textContent === '删除');
  doc.fire('click', {target: remove});
  const box = secretDialog(row);
  assert.ok(box, 'a question opens for the row');

  doc.fire('click', {target: box.children[1]});
  await settleSettings();

  assert.equal(calls.length, before, 'cancel sends no request');
  assert.equal(remove.hidden, false, 'the trigger comes back');
  assert.equal(doc.activeElement, remove, 'focus returns to the trigger');
  assert.equal(secretDialog(row), undefined, 'the question is gone');
});

test('Escape closes the delete question without sending anything', async () => {
  const {doc, calls, list} = await mountSettingsPage();
  const before = calls.length;
  const row = secretRow(list, 'OPENAI_KEY');
  const remove = row.children.find(child => child.tagName === 'button' && child.textContent === '删除');
  doc.fire('click', {target: remove});
  assert.ok(secretDialog(row), 'a question opens for the row before Escape');

  doc.fire('keydown', {key: 'Escape'});
  await settleSettings();

  assert.equal(calls.length, before, 'Escape sends no request');
  assert.equal(secretDialog(row), undefined, 'the question is gone');
  assert.equal(remove.hidden, false);
  assert.equal(doc.activeElement, remove, 'focus returns to the trigger');
});

test('confirming the delete issues exactly one request with the row name and refreshes the list', async () => {
  const {doc, calls, list, status} = await mountSettingsPage();
  const row = secretRow(list, 'GITHUB_TOKEN');
  const remove = row.children.find(child => child.tagName === 'button' && child.textContent === '删除');
  const before = calls.length;
  doc.fire('click', {target: remove});
  const box = secretDialog(row);
  assert.ok(box, 'a question opens for the row');

  doc.fire('click', {target: box.children[2]});
  await settleSettings();

  const posts = calls.slice(before).filter(call => call.method === 'POST');
  assert.equal(posts.length, 1, 'confirm sends exactly one request');
  assert.deepEqual(posts[0].body, {name: 'GITHUB_TOKEN', action: 'delete'});
  assert.equal(calls.slice(before).filter(call => call.method === 'GET' && call.path === '/v1/skill-secrets').length, 1,
    'the list reloads once');
  assert.equal(secretRow(list, 'GITHUB_TOKEN'), undefined, 'the deleted key leaves the list');
  assert.ok(secretRow(list, 'OPENAI_KEY'), 'the other key stays');
  assert.equal(status.dataset.kind, 'ok');
  assert.match(status.textContent, /GITHUB_TOKEN/);
  assert.equal(list.children.some(rowNode => secretDialog(rowNode)), false, 'no question survives the reload');
});

test('opening a second delete question retires the first one', async () => {
  const {doc, calls, list} = await mountSettingsPage();
  const first = secretRow(list, 'GITHUB_TOKEN');
  const second = secretRow(list, 'OPENAI_KEY');
  const firstRemove = first.children.find(child => child.tagName === 'button');
  const secondRemove = second.children.find(child => child.tagName === 'button');
  const before = calls.length;

  doc.fire('click', {target: firstRemove});
  doc.fire('click', {target: secondRemove});
  await settleSettings();

  assert.equal(secretDialog(first), undefined, 'the first row gives up its question');
  assert.ok(secretDialog(second), 'the second row owns the only question');
  assert.equal(list.children.filter(rowNode => secretDialog(rowNode)).length, 1, 'one question at a time');
  assert.equal(firstRemove.hidden, false, 'the first trigger is visible again');
  assert.equal(calls.length, before, 'opening questions sends no request');
});

test('re-rendering the list retires a pending delete question', async () => {
  const {doc, list, secretForm} = await mountSettingsPage();
  const row = secretRow(list, 'GITHUB_TOKEN');
  const remove = row.children.find(child => child.tagName === 'button');
  doc.fire('click', {target: remove});
  assert.ok(secretDialog(row), 'the question is open');

  secretForm.elements.name.value = 'NEW_KEY';
  secretForm.elements.value.value = 'v';
  doc.fire('submit', {target: secretForm});
  await settleSettings();

  assert.equal(list.children.filter(rowNode => secretDialog(rowNode)).length, 0, 'no question hangs on the fresh rows');
  assert.ok(secretRow(list, 'NEW_KEY'), 'the new key is listed');

  doc.activeElement = null;
  doc.fire('keydown', {key: 'Escape'});
  await settleSettings();
  assert.equal(doc.activeElement, null, 'Escape finds no stale question left over from the old rows');
});

test('connector errors distinguish a conflict, rate limit and upstream service failure', () => {
  const conflict = composioMessage({code: 'composio_conflict'}, '');
  const limited = composioMessage({code: 'composio_rate_limited'}, '');
  const upstream = composioMessage({code: 'composio_upstream'}, '');
  assert.match(conflict, /连接冲突.*刷新页面查看当前连接/);
  assert.doesNotMatch(conflict, /已经有|断开/);
  assert.match(limited, /限制了请求次数.*稍后重试/);
  assert.match(upstream, /服务暂时异常.*稍后重试/);
  assert.equal(composioMessage({code: 'constructor'}, '无法开始连接。'), '无法开始连接。');
});

test('composioRowState never shows success without a real connected state', () => {
  const mapped = {toolkit: 'github', managed: 'yes'};
  assert.deepEqual(composioRowState(null, true, null).disabled, true);
  assert.equal(composioRowState({toolkit: null}, true, null).status, '未接通');
  const unconfigured = composioRowState(mapped, false, {state: 'connected', id: 'x'});
  assert.equal(unconfigured.status, '未配置 Composio');
  assert.equal(unconfigured.disabled, false);
  assert.equal(unconfigured.action, 'focus-key');
  assert.equal(unconfigured.button, '配置密钥');
  assert.equal(composioRowState(mapped, true, null).status, '未连接');
  assert.equal(composioRowState(mapped, true, null).action, 'connect');
  assert.equal(composioRowState(mapped, true, {state: 'connecting'}).status, '连接中…');
  assert.equal(composioRowState(mapped, true, {state: 'connected'}).status, '已连接');
  assert.equal(composioRowState(mapped, true, {state: 'connected'}).action, 'disconnect');
  const failed = composioRowState(mapped, true, {state: 'failed', status_reason: 'User denied'});
  assert.equal(failed.status, '连接失败');
  assert.match(failed.title, /User denied/);
  const own = composioRowState({toolkit: 'vercel', managed: 'own'}, true, null);
  assert.equal(own.disabled, true);
  assert.match(own.title, /未接通/);
});

test('pickConnection prefers a connected account and ignores deleted ones', () => {
  const items = [
    {id: 'a', toolkit: 'github', state: 'failed', created_at: 3},
    {id: 'b', toolkit: 'github', state: 'connected', created_at: 1},
    {id: 'c', toolkit: 'notion', state: 'connected', created_at: 2},
    {id: 'd', toolkit: 'github', state: 'failed', status: 'DELETED', created_at: 9},
  ];
  assert.equal(pickConnection(items, 'github').id, 'b');
  assert.equal(pickConnection(items, 'linear'), null);
});

test('applyComposioRows updates status, button and connection id from server data', () => {
  function node(attrs) {
    const status = {textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }};
    const button = {textContent: '', disabled: true, title: '', attrs: {},
                    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }};
    return {status, button, getAttribute: k => attrs[k] ?? null,
            querySelector: sel => sel === 'button' ? button : status};
  }
  const github = node({'data-connector-id': 'github', 'data-composio-toolkit': 'github', 'data-composio-managed': 'yes'});
  const amap = node({'data-connector-id': 'amap'});
  const count = {hidden: true};
  const nodes = {
    'connectors-catalog': {querySelectorAll: () => [github, amap]},
    'connectors-connected-count': count,
  };
  const document = {getElementById: id => nodes[id]};
  applyComposioRows(document, true, [{id: 'c1', toolkit: 'github', state: 'connected', created_at: 1}]);
  assert.equal(github.status.textContent, '已连接');
  assert.equal(github.status.attrs['data-state'], 'connected');
  assert.equal(github.button.textContent, '断开');
  assert.equal(github.button.disabled, false);
  assert.equal(github.button.attrs['data-connection-id'], 'c1');
  assert.equal(amap.status.textContent, '未接通');
  assert.equal(amap.button.disabled, true);
  assert.equal(count.textContent, '1 个已连接');
  assert.equal(count.hidden, false);
  applyComposioRows(document, true, [], 'error');
  assert.equal(github.status.textContent, '状态暂不可用');
  assert.equal(github.button.disabled, true);
  assert.equal(github.button.attrs['data-connection-id'], undefined);
  assert.equal(amap.status.textContent, '未接通');
  assert.equal(count.hidden, true);
  applyComposioRows(document, false, []);
  assert.equal(github.status.textContent, '未配置 Composio');
  assert.equal(github.button.disabled, false);
  assert.equal(github.button.attrs['data-composio-action'], 'focus-key');
  assert.equal(count.textContent, '0 个已连接');
  assert.equal(github.button.attrs['data-connection-id'], undefined);
});


test('connected-tool approvals do not imply a connected account before key setup', () => {
  const source = readFileSync(fileURLToPath(new URL('../flybot_workspace/static/settings/connected-tools.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /已连接/);
  assert.match(source, /允许此调用一次/);
  assert.match(source, /decision/);
  assert.doesNotMatch(source, /innerHTML/);
});

test('automatic GitHub activity has no approval buttons and another app requires an explicit decision', async () => {
  const {doc} = settingsDocument();
  let section;
  doc.getElementById('composio-key-card').after = node => { section = node; };
  const createElement = doc.createElement;
  let failOnce = true;
  doc.createElement = tag => {
    if (tag === 'strong' && failOnce) {
      failOnce = false;
      throw new Error('Fixture render interrupted');
    }
    return createElement(tag);
  };
  const id = 'a'.repeat(32);
  const item = {id, name: 'SLACK_SEND_MESSAGE', status: 'pending', task_id: null,
                arguments: {text: 'fixture message'}, account: {toolkit: 'slack', account_id: 'fixture'}, prompt: ''};
  const read = {...item, id: 'c'.repeat(32), name: 'GITHUB_GET_A_PULL_REQUEST', status: 'succeeded',
                approval_mode: 'automatic_read', arguments: {pull_number: 17}, account: {...item.account, toolkit: 'github'}};
  const write = {...read, id: 'd'.repeat(32), name: 'GITHUB_CREATE_ISSUE', status: 'approved',
                 approval_mode: 'automatic', arguments: {title: 'fixture issue'}};
  const decisions = [];
  const view = await mountToolApprovals(doc, async (path, options) => {
    if (options?.method === 'POST') {
      decisions.push({path, csrf: options.headers['X-CSRF-Token'], body: JSON.parse(options.body)});
      return {ok: true};
    }
    return {ok: true, json: async () => ({items: [item, {...item, id: 'b'.repeat(32), task_id: 'legacy-1234'}, read, write]})};
  }, null);
  const list = section.children[2];
  assert.deepEqual(list.children, []);
  await view.refresh();
  const [native, legacy, automaticRead, automaticWrite] = list.children;
  assert.match(section.children[1].textContent, /支持 GitHub 工具的对话.*已授权.*读取和写入.*会自动执行。/);
  assert.match(section.children[1].textContent, /其他应用的工具调用需逐次确认/);
  assert.equal(native.children[0].textContent, 'SLACK_SEND_MESSAGE · 待确认');
  assert.match(native.children[2].textContent, /"text": "fixture message"/);
  assert.match(legacy.children[0].textContent, / · 任务 legacy-1$/);
  assert.equal(automaticRead.children[0].textContent, 'GITHUB_GET_A_PULL_REQUEST · 自动只读 · 已完成');
  assert.equal(automaticWrite.children[0].textContent, 'GITHUB_CREATE_ISSUE · 自动执行 · 待执行');
  for (const automatic of [automaticRead, automaticWrite]) {
    assert.equal(automatic.children.some(node => node.tagName === 'button'), false);
  }
  assert.deepEqual(decisions, []);
  const approve = native.children.find(node => node.textContent === '允许此调用一次');
  await approve.handlers.click[0]();
  assert.deepEqual(decisions, [{path: '/v1/composio/approvals/' + id, csrf: 'token-a', body: {decision: 'approve'}}]);
});
