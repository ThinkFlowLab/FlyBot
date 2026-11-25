import { NIGHT_WINDOW, resolveTheme, syncAppearanceButton } from '../shell/app.mjs';
import {applySystemLocale, supportsSystemLocale, systemLocale, uiText} from '../shell/system-locale.mjs';

const KEYS = ['appearance', 'appearance_schedule', 'appearance_start', 'appearance_end', 'language',
              'chat_language', 'auto_translate', 'send_shortcut', 'message_folding', 'document_cards',
              'link_previews', 'task_completion_reminders', 'likes_visible', 'favorites_visible'];

export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function readForm(form) {
  const data = new FormData(form);
  return {
    appearance: data.get('appearance'),
    appearance_schedule: data.get('appearance_schedule'),
    appearance_start: data.get('appearance_start'),
    appearance_end: data.get('appearance_end'),
    language: form.elements?.language?.value ?? data.get('language'),
    chat_language: data.get('chat_language'),
    auto_translate: data.has('auto_translate'),
    send_shortcut: data.get('send_shortcut'),
    message_folding: data.get('message_folding'),
    document_cards: data.has('document_cards'),
    link_previews: data.has('link_previews'),
    task_completion_reminders: data.has('task_completion_reminders'),
    likes_visible: data.has('likes_visible'),
    favorites_visible: data.has('favorites_visible'),
  };
}

export function diff(current, next) {
  const changes = {};
  for (const key of KEYS) {
    if (current[key] !== next[key]) changes[key] = next[key];
  }
  return changes;
}

export function applyTheme(document, values) {
  if (document.documentElement.lang !== systemLocale(values.language)) applySystemLocale(document, values.language);
  document.body.dataset.theme = values.appearance === 'system' ? '' : values.appearance;
  if (values.appearance === 'auto') {
    document.body.dataset.schedule = values.appearance_schedule || 'sunset_sunrise';
  } else {
    delete document.body.dataset.schedule;
  }
}

function clockMinutes(value) {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function clockLabel(value) {
  const total = clockMinutes(value);
  if (total == null) return '';
  const hours = String(Math.floor(total / 60)).padStart(2, '0');
  const minutes = String(total % 60).padStart(2, '0');
  return hours + ':' + minutes;
}

function nextSwitchLabel(values, theme) {
  const custom = values && values.appearance_schedule === 'custom';
  const start = custom ? values.appearance_start : NIGHT_WINDOW.start;
  const end = custom ? values.appearance_end : NIGHT_WINDOW.end;
  if (clockMinutes(start) == null || clockMinutes(end) == null || clockMinutes(start) === clockMinutes(end)) {
    return '';
  }
  return clockLabel(theme === 'dark' ? end : start);
}

export function describeAppearance(values, now = new Date(), media) {
  const theme = resolveTheme(values || { appearance: 'system' }, now, media);
  const look = theme === 'dark' ? '深色' : '浅色';
  const appearance = values && values.appearance;
  if (appearance === 'light') return '当前为浅色。';
  if (appearance === 'dark') return '当前为深色。';
  if (appearance === 'auto') {
    const until = nextSwitchLabel(values, theme);
    return until ? look + '，直到 ' + until + '。' : '当前为' + look + '。';
  }
  return '当前为' + look + '（跟随系统）。';
}

const OVERVIEW_CHOICES = {
  'appearance.light': ['浅色', 'Light'],
  'appearance.dark': ['深色', 'Dark'],
  'appearance.auto': ['自动', 'Automatic'],
  'appearance.system': ['跟随系统', 'System'],
  'message_folding.compact': ['紧凑', 'Compact'],
  'message_folding.standard': ['标准', 'Standard'],
  'message_folding.none': ['不折叠', 'Do not fold'],
};

export function syncOverviewCurrentValues(document, values) {
  const appearance = document.getElementById('appearance-current');
  const folding = document.getElementById('folding-current');
  if (appearance) {
    appearance.textContent = uiText(document, `appearance.${values.appearance}`, undefined, OVERVIEW_CHOICES) || '';
  }
  if (folding) {
    folding.textContent = uiText(document, `message_folding.${values.message_folding}`, undefined, OVERVIEW_CHOICES) || '';
  }
}

const AUTOSAVE_KEYS = ['appearance', 'appearance_schedule', 'appearance_start', 'appearance_end',
                       'language', 'chat_language', 'auto_translate', 'send_shortcut',
                       'message_folding', 'document_cards', 'link_previews',
                       'task_completion_reminders'];

const PATH_VIEWS = {
  '/settings/appearance': 'appearance',
  '/settings/language': 'language',
  '/settings/message-folding': 'message-folding',
  '/settings/privacy': 'privacy',
  '/settings/shortcuts': 'shortcuts',
  '/settings/channels': 'channels',
  '/settings/agent-access': 'agent-access',
  '/settings/connectors': 'connectors',
  '/settings/skill-configuration': 'skill-configuration',
  '/settings/model-api': 'model-api',
};

const HASH_VIEWS = {
  appearance: 'appearance',
  'language-section': 'language',
  language: 'language',
  'message-display': 'message-folding',
  'message-folding': 'message-folding',
  privacy: 'privacy',
  'send-shortcut': 'shortcuts',
  shortcuts: 'shortcuts',
  'model-api': 'model-api',
  'image-api': 'model-api',
  'video-api': 'model-api',
  'music-api': 'model-api',
  'model3d-api': 'model-api',
  'skill-secrets': 'skill-configuration',
};

export function settingsViewFromLocation(pathname, hash) {
  const path = String(pathname || '').replace(/\/+$/, '');
  if (PATH_VIEWS[path]) return PATH_VIEWS[path];
  const name = String(hash || '').replace(/^#/, '');
  return HASH_VIEWS[name] || 'hub';
}

export function applySettingsView(document, view) {
  const current = view || 'hub';
  for (const node of document.querySelectorAll('[data-settings-hub]')) {
    node.hidden = current !== 'hub';
  }
  for (const node of document.querySelectorAll('[data-settings-page]')) {
    node.hidden = node.getAttribute('data-settings-page') !== current;
  }
  if (current !== 'connectors' && typeof document.getElementById === 'function') {
    syncMcpDialog(document, false);
  }
}

export function syncMcpDialog(document, open) {
  const dialog = document.getElementById('mcp-dialog');
  const trigger = document.getElementById('add-mcp-server');
  if (!dialog) return;
  const wasOpen = !dialog.hidden;
  dialog.hidden = !open;
  if (trigger) trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const ack = document.getElementById('mcp-dialog-ack');
    if (ack && typeof ack.focus === 'function') ack.focus();
  } else if (wasOpen && trigger && typeof trigger.focus === 'function') {
    trigger.focus();
  }
}


// Public fields only, copied from the in-repo DS-Bot baseline
// runtime/ds-bot-upstream/ds-bot/src/host/connectors/catalog.js CATALOG.
// Do not put OAuth client ids, MCP URLs, tokens, headers, or whoami
// endpoints in this frontend module.
export const CONNECTOR_CATALOG = [
  {id: 'github', name: 'GitHub', category: 'dev', about: 'Repositories, issues, and pull requests'},
  {id: 'notion', name: 'Notion', category: 'docs', about: 'Pages, databases, and wiki content'},
  {id: 'linear', name: 'Linear', category: 'work', about: 'Issues, projects, and cycles'},
  {id: 'atlassian', name: 'Atlassian', category: 'work', about: 'Jira issues and Confluence pages'},
  {id: 'sentry', name: 'Sentry', category: 'dev', about: 'Errors, traces, and releases'},
  {id: 'stripe', name: 'Stripe', category: 'commerce', about: 'Payments, invoices, and customers'},
  {id: 'paypal', name: 'PayPal', category: 'commerce', about: 'Orders, payments, and invoices'},
  {id: 'square', name: 'Square', category: 'commerce', about: 'Payments, orders, and catalog'},
  {id: 'cloudflare', name: 'Cloudflare', category: 'dev', about: 'Workers, DNS, and account resources'},
  {id: 'vercel', name: 'Vercel', category: 'dev', about: 'Projects, deployments, and logs'},
  {id: 'supabase', name: 'Supabase', category: 'data', about: 'Databases, tables, and project settings'},
  {id: 'neon', name: 'Neon', category: 'data', about: 'Postgres databases and branches'},
  {id: 'figma', name: 'Figma', category: 'design', about: 'Design files, components, and comments'},
  {id: 'canva', name: 'Canva', category: 'design', about: 'Designs, folders, and exports'},
  {id: 'intercom', name: 'Intercom', category: 'work', about: 'Conversations, contacts, and articles'},
  {id: 'monday', name: 'monday.com', category: 'work', about: 'Boards, items, and workflows'},
  {id: 'webflow', name: 'Webflow', category: 'design', about: 'Sites, pages, and CMS content'},
  {id: 'wix', name: 'Wix', category: 'design', about: 'Sites, pages, and site content'},
  {id: 'netlify', name: 'Netlify', category: 'dev', about: 'Sites, deploys, and forms'},
  {id: 'airtable', name: 'Airtable', category: 'data', about: 'Bases, tables, and records'},
  {id: 'dropbox', name: 'Dropbox', category: 'docs', about: 'Files and folders'},
  {id: 'zapier', name: 'Zapier', category: 'work', about: 'Zaps and app actions'},
  {id: 'clickup', name: 'ClickUp', category: 'work', about: 'Tasks, lists, and docs'},
  {id: 'todoist', name: 'Todoist', category: 'work', about: 'Tasks and projects'},
  {id: 'miro', name: 'Miro', category: 'design', about: 'Boards and whiteboard items'},
  {id: 'attio', name: 'Attio', category: 'work', about: 'CRM records, lists, and notes'},
  {id: 'postman', name: 'Postman', category: 'dev', about: 'Collections, requests, and workspaces'},
  {id: 'asana', name: 'Asana', category: 'work', about: 'Tasks, projects, and workspaces'},
  {id: 'box', name: 'Box', category: 'docs', about: 'Files, folders, and metadata'},
  {id: 'hubspot', name: 'HubSpot', category: 'work', about: 'Contacts, deals, and tickets'},
  {id: 'slack', name: 'Slack', category: 'work', about: 'Channels and messages'},
  {id: 'huggingface', name: 'Hugging Face', category: 'data', about: 'Models, datasets, and Spaces'},
  {id: 'exa', name: 'Exa', category: 'search', about: 'Web search for agents'},
  {id: 'deepwiki', name: 'DeepWiki', category: 'docs', about: 'Documentation for public code repositories'},
  {id: 'context7', name: 'Context7', category: 'docs', about: 'Library documentation and code examples'},
  {id: 'mslearn', name: 'Microsoft Learn', category: 'docs', about: 'Microsoft product documentation'},
  {id: 'cloudflare-docs', name: 'Cloudflare Docs', category: 'docs', about: 'Cloudflare product documentation'},
  {id: 'amap', name: 'Amap', category: 'search', about: 'Maps, places, and routes in China'},
  {id: 'mail', name: 'Mailbox', category: 'mail', about: 'Read and send email over IMAP and SMTP'},
];

export function filterConnectorCatalog(query, catalog = CONNECTOR_CATALOG, group = 'all') {
  const needle = String(query || '').trim().toLowerCase();
  return catalog.filter((item) => (
    (group === 'all' || item.category === group)
    && (!needle
      || item.id.toLowerCase().includes(needle)
      || item.name.toLowerCase().includes(needle)
      || item.about.toLowerCase().includes(needle))
  ));
}

export function applyConnectorSearch(document, query, group = 'all') {
  const list = document.getElementById('connectors-catalog');
  const empty = document.getElementById('connectors-empty');
  const visible = filterConnectorCatalog(query, CONNECTOR_CATALOG, group);
  if (!list) {
    if (empty) empty.hidden = visible.length > 0;
    return visible;
  }
  const allowed = new Set(visible.map((item) => item.id));
  for (const row of list.querySelectorAll('[data-connector-id]')) {
    const id = row.getAttribute('data-connector-id');
    row.hidden = !allowed.has(id);
  }
  if (empty) empty.hidden = visible.length > 0;
  return visible;
}

// Composio connections. Each user enters their own Composio API key; there is
// no platform key. States come only from the management API, never guessed.
export function pickConnection(items, toolkit) {
  const rank = {connected: 3, connecting: 2, inactive: 1, failed: 0};
  let best = null;
  for (const item of items || []) {
    if (!item || item.toolkit !== toolkit || item.status === 'DELETED') continue;
    if (!best || (rank[item.state] ?? -1) > (rank[best.state] ?? -1)
        || ((rank[item.state] ?? -1) === (rank[best.state] ?? -1) && item.created_at >= best.created_at)) {
      best = item;
    }
  }
  return best;
}

export function composioRowState(row, configured, connection, readState = 'ready') {
  if (!row || !row.toolkit) {
    return {state: 'unavailable', status: '未接通', button: '+ 连接', disabled: true, action: '',
            title: '未接通：Composio 没有这个应用，暂时不能连接。'};
  }
  if (readState !== 'ready') {
    const status = readState === 'loading' ? '正在读取…' : '状态暂不可用';
    return {state:readState, status, button:'+ 连接', disabled:true, action:'', title:status};
  }
  if (!configured) {
    return {state: 'unconfigured', status: '未配置 Composio', button: '配置密钥', disabled: false, action: 'focus-key',
            title: '前往 Composio API key 输入框。'};
  }
  if (connection && connection.state === 'connected') {
    return {state: 'connected', status: '已连接', button: '断开', disabled: false, action: 'disconnect',
            title: '断开会删除你 Composio 项目里的这个连接。'};
  }
  if (connection && connection.state === 'connecting') {
    return {state: 'connecting', status: '连接中…', button: '取消', disabled: false, action: 'disconnect',
            title: '正在等待你在 Composio 授权页完成授权。'};
  }
  if (row.managed === 'own') {
    return {state: 'needs-auth-config', status: '需自建 auth config', button: '+ 连接', disabled: true, action: '',
            title: '未接通：Composio 没有为这个应用托管 OAuth 应用，需要先在你的 Composio 项目里建 auth config；本页暂不支持。'};
  }
  if (connection && (connection.state === 'failed' || connection.state === 'inactive')) {
    const label = connection.state === 'inactive' ? '未激活' : '连接失败';
    const reason = connection.status_reason ? '：' + connection.status_reason : '';
    return {state: connection.state, status: label, button: '重试', disabled: false, action: 'connect',
            title: label + reason};
  }
  return {state: 'idle', status: '未连接', button: '+ 连接', disabled: false, action: 'connect',
          title: '通过你的 Composio 项目授权连接。'};
}

export function applyComposioRows(document, configured, items, readState = 'ready') {
  const list = document.getElementById('connectors-catalog');
  if (!list) return [];
  const applied = [];
  for (const node of list.querySelectorAll('[data-connector-id]')) {
    const row = {toolkit: node.getAttribute('data-composio-toolkit'), managed: node.getAttribute('data-composio-managed')};
    const connection = row.toolkit ? pickConnection(items, row.toolkit) : null;
    const view = composioRowState(row, configured, connection, readState);
    const status = node.querySelector('.connector-status');
    const button = node.querySelector('button');
    if (status) {
      status.textContent = view.status;
      status.setAttribute('data-state', view.state);
    }
    if (button) {
      button.textContent = view.button;
      button.disabled = view.disabled;
      button.title = view.title;
      button.setAttribute('data-composio-action', view.action);
      if (connection) button.setAttribute('data-connection-id', connection.id);
      else button.removeAttribute('data-connection-id');
    }
    applied.push({id: node.getAttribute('data-connector-id'), ...view});
  }
  const connectedCount = document.getElementById('connectors-connected-count');
  if (connectedCount) {
    connectedCount.textContent = applied.filter(row => row.state === 'connected').length + ' 个已连接';
    connectedCount.hidden = readState !== 'ready';
  }
  return applied;
}

const COMPOSIO_ERRORS = {
  composio_not_configured: '未配置 Composio：先填入你自己的 Composio API key。',
  composio_key_rejected: 'Composio 拒绝了这个 API key，请检查后重新保存。',
  composio_unreachable: '暂时连不上 Composio，请稍后再试。',
  composio_conflict: 'Composio 报告连接冲突。请刷新页面查看当前连接，再重试。',
  composio_rate_limited: 'Composio 暂时限制了请求次数。请稍后重试。',
  composio_upstream: 'Composio 服务暂时异常，请稍后重试。',
  composio_not_found: 'Composio 里找不到这个连接。',
  composio_failed: 'Composio 请求失败。',
};

export function composioMessage(error, fallback) {
  return error && Object.hasOwn(COMPOSIO_ERRORS, error.code) ? COMPOSIO_ERRORS[error.code] : fallback;
}

function placeAppearanceStatus(document, auto) {
  const status = document.getElementById('appearance-status');
  const scheduleCard = document.getElementById('appearance-schedule-card');
  const appearance = document.getElementById('appearance');
  if (!status || !status.parentNode) return;
  if (auto && scheduleCard && typeof scheduleCard.insertBefore === 'function') {
    const notes = typeof scheduleCard.querySelectorAll === 'function'
      ? scheduleCard.querySelectorAll(':scope > .note')
      : [];
    const lastNote = notes[notes.length - 1];
    if (lastNote) scheduleCard.insertBefore(status, lastNote);
    else if (typeof scheduleCard.appendChild === 'function') scheduleCard.appendChild(status);
    return;
  }
  if (appearance && appearance.parentNode && typeof appearance.parentNode.insertBefore === 'function') {
    appearance.parentNode.insertBefore(status, scheduleCard || appearance.nextSibling);
  }
}

export function syncAppearanceExtras(document, values) {
  const scheduleCard = document.getElementById('appearance-schedule-card');
  const customFields = document.getElementById('custom-period-fields');
  const auto = Boolean(values && values.appearance === 'auto');
  if (scheduleCard) scheduleCard.hidden = !auto;
  if (customFields) {
    customFields.hidden = !(values && values.appearance === 'auto' && values.appearance_schedule === 'custom');
  }
  const zone = document.getElementById('appearance-time-zone');
  if (zone) {
    try {
      zone.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
    } catch (error) {
      zone.textContent = 'Asia/Shanghai';
    }
  }
  placeAppearanceStatus(document, auto);
}

export function readModelForm(form) {
  const data = new FormData(form);
  const provider = data.get('provider') || '';
  const changes = {};
  if (provider) {
    changes.provider = provider;
    changes.base_url = data.get('base_url') || '';
    changes.model = data.get('model') || '';
  }
  const key = data.get('api_key');
  if (key) changes.api_key = key;
  return changes;
}

export function fillModelForm(form, values) {
  form.elements.provider.value = values && values.api_key_set ? (values.provider || '') : '';
  form.elements.base_url.value = values && values.api_key_set ? (values.base_url || '') : '';
  form.elements.model.value = values && values.api_key_set ? (values.model || '') : '';
  form.elements.api_key.value = '';
}

export function renderModelApi(document, form, data, failed = false) {
  const values = data?.model_api;
  const effective = data?.effective;
  const platform = effective?.source === 'platform';
  const account = effective?.source === 'account';
  const state = platform ? 'platform' : account ? 'account' : failed ? 'read-failed' : values ? 'unavailable' : 'loading';
  const source = platform ? 'platform-active' : account ? 'account-active' :
    failed ? 'load-error' : values ? 'none' : 'loading';

  function label(id, suffix) {
    const node = document.getElementById(id);
    const key = 'settings.model-api.' + suffix;
    node.textContent = uiText(document, key);
    node.setAttribute('data-ui-text', key);
  }

  label('model-key-state', state);
  label('model-effective-source', source);
  label('model-api-override-title', account ? 'override-edit' : 'override');
  const model = (platform || account) && effective.model;
  document.getElementById('model-effective-model').textContent = model ? ' (' + model + ')' : '';
  document.getElementById('model-platform-ready').hidden = !platform;
  document.getElementById('model-key-state-detail').hidden = !values?.api_key_set;
  document.getElementById('restore-platform-model').hidden = !values?.api_key_set;
  const retry = document.getElementById('retry-model-api');
  if (retry) retry.hidden = !failed;
  const override = document.getElementById('model-api-override');
  override.hidden = !values;
  override.open = account;
  document.getElementById('model-api-fields').disabled = !values;
  fillModelForm(form, values);
  form.elements.api_key.required = Boolean(values && !values.api_key_set);
}

export function fillForm(form, values) {
  for (const option of form.querySelectorAll('[name="appearance"], [name="appearance_schedule"]')) {
    option.checked = option.value === values[option.name];
  }
  for (const name of ['appearance_start', 'appearance_end', 'language',
                      'chat_language', 'message_folding', 'send_shortcut']) {
    const field = form.elements[name];
    if (field) field.value = values[name];
  }
  for (const name of ['auto_translate', 'document_cards', 'link_previews', 'task_completion_reminders', 'likes_visible', 'favorites_visible']) {
    const field = form.elements[name];
    if (field) {
      field.checked = values[name];
      if (field.getAttribute('role') === 'switch') field.setAttribute('aria-checked', values[name] ? 'true' : 'false');
    }
  }
}

export function newlineBinding(sendShortcut) {
  return sendShortcut === 'mod_enter' ? 'Enter' : 'Shift+Enter';
}

// The stored value is a code; the sentence a user reads has to say what the
// choice actually does when a message is sent, not just echo the label.
export function chatLanguageEffect(value, label = '', locale) {
  return !value || value === 'auto'
    ? uiText(locale, 'settings.language.auto-hint')
    : uiText(locale, 'settings.language.reply-hint', {language:label || value});
}

export function syncChatLanguageNote(document, value, label = '') {
  const text = chatLanguageEffect(value, label, document);
  const note = document.getElementById('chat-language-effect');
  if (note) note.textContent = text;
  return text;
}

export function syncShortcutRows(document, values) {
  const keys = document.getElementById('newline-keys');
  if (!keys) return;
  const binding = newlineBinding(values && values.send_shortcut);
  keys.replaceChildren();
  const parts = binding.split('+');
  parts.forEach((part, index) => {
    if (index) {
      const plus = document.createElement('span');
      plus.className = 'shortcut-plus';
      plus.textContent = '+';
      keys.appendChild(plus);
    }
    const key = document.createElement('kbd');
    key.textContent = part;
    keys.appendChild(key);
  });
}

export function privacyChanges(current, next) {
  const changes = {};
  if (!current || !next) return changes;
  for (const key of ['likes_visible', 'favorites_visible']) {
    if (current[key] !== next[key]) changes[key] = next[key];
  }
  return changes;
}

export function syncPrivacySaveButton(document, current, next) {
  const button = document.getElementById('save');
  if (!button) return;
  button.disabled = Object.keys(privacyChanges(current, next)).length === 0;
}

export function removeSecretPrompt(item) {
  const name = String((item && item.name) || '');
  return {question: `删除技能密钥「${name}」？`, confirmLabel: '确认删除'};
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function mountMediaApi(document, request, type, noun) {
  const id = type + '-api';
  const form = document.getElementById(id + '-form');
  if (!form) return null;
  const fields = document.getElementById(id);
  const status = document.getElementById(id + '-status');
  const remove = document.getElementById('clear-' + id);
  const keyInput = form.elements.api_key;
  const endpoint = '/v1/model-api/' + type;
  const responseKey = type + '_api';
  let config = null;

  function fill(view, message) {
    config.revision = view.revision;
    remove.hidden = !view.has_api_key;
    status.textContent = message || (view.has_api_key ? noun + '密钥已保存。' : '尚未配置' + noun + '密钥。');
    fields.disabled = false;
  }

  async function load(message) {
    const active = config;
    if (!active || active.busy) return;
    active.busy = fields.disabled = true;
    status.textContent = '正在读取' + noun + '配置…';
    const response = await request('GET', endpoint).catch(() => ({status: 0, body: {}}));
    if (active !== config) return;
    active.busy = false;
    if (response.status === 200 && response.body[responseKey]) fill(response.body[responseKey], message);
    else status.textContent = '无法读取' + noun + '配置，请刷新后重试。';
  }

  async function save(api_key) {
    const active = config;
    if (!active || active.revision === null || active.busy) return;
    active.busy = fields.disabled = true;
    keyInput.value = '';
    status.textContent = '正在保存…';
    const response = await request('POST', endpoint, {revision: active.revision, api_key})
      .catch(() => ({status: 0, body: {}}));
    if (active !== config) return;
    active.busy = fields.disabled = false;
    if (response.status === 200 && response.body[responseKey]) {
      fill(response.body[responseKey], api_key === null ? '已移除' + noun + '密钥。' : noun + '配置已保存。');
    } else if (response.status === 409) {
      await load(noun + '配置已在其他窗口更新，请重新输入密钥。');
    } else {
      status.textContent = messageFor(response.body.error, '无法保存' + noun + '配置，请重试。');
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    const secret = keyInput.value.trim();
    if (secret) void save(secret);
    else status.textContent = '请输入' + noun + ' API 密钥。';
  });
  remove.addEventListener('click', () => void save(null));

  return {
    setAccount(account) {
      if (config?.account === account) return;
      config = account === null ? null : {account, revision: null, busy: false};
      keyInput.value = '';
      fields.disabled = true;
      remove.hidden = true;
      status.textContent = '';
    },
    render(hash) {
      if (config?.revision === null) void load();
      if (hash === '#' + id) fields.scrollIntoView?.({block: 'start'});
    },
  };
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const settingsPanel = document.getElementById('settings-panel');
  const whoami = document.getElementById('whoami');
  const form = document.getElementById('settings-form');
  const modelForm = document.getElementById('model-api-form');
  const modelFields = modelForm && document.getElementById('model-api-fields');
  const modelRetry = document.getElementById('retry-model-api');
  const imageForm = document.getElementById('image-api-form');
  const imageFields = document.getElementById('image-api');
  const imageStatus = document.getElementById('image-api-status');
  const removeImageKey = document.getElementById('clear-image-api');
  const mediaApis = [
    mountMediaApi(document, request, 'video', '视频'),
    mountMediaApi(document, request, 'music', '音乐'),
    mountMediaApi(document, request, 'model3d', '3D 模型'),
  ].filter(Boolean);
  let imageAccount = null;
  let imageRevision = null;
  let imageLoading = false;
  let imageSaving = false;
  let revision = 0;
  let current = null;
  let loadSequence = 0;
  const notificationState = document.getElementById('notification-prefs-state');
  const notificationInputs = Object.fromEntries(['mentions', 'task_completion', 'artifacts'].map(key =>
    [key, document.getElementById('notify-' + key.replaceAll('_', '-'))]).filter(([, input]) => input));
  let notificationValues = {};
  let languageSave = null;
  let modelRevision = null;
  let pendingSecretConfirm = null;
  let secretConfirmSeq = 0;

  function closeSecretConfirm(restoreFocus) {
    if (!pendingSecretConfirm) return false;
    const {box, trigger} = pendingSecretConfirm;
    pendingSecretConfirm = null;
    if (typeof box.remove === 'function') box.remove();
    trigger.hidden = false;
    if (restoreFocus && typeof trigger.focus === 'function') trigger.focus();
    return true;
  }

  function askSecretConfirmation(row, trigger, item) {
    closeSecretConfirm(false);
    const {question, confirmLabel} = removeSecretPrompt(item);
    const box = document.createElement('span');
    box.className = 'skill-secret-confirm';
    box.setAttribute('role', 'alertdialog');
    secretConfirmSeq += 1;
    const questionNode = document.createElement('span');
    questionNode.id = 'skill-secret-confirm-' + secretConfirmSeq;
    questionNode.textContent = question;
    box.setAttribute('aria-labelledby', questionNode.id);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => closeSecretConfirm(true));
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = confirmLabel;
    confirm.addEventListener('click', async () => {
      const target = {name: item.name};
      closeSecretConfirm(false);
      const result = await request('POST', '/v1/skill-secrets', {name: target.name, action: 'delete'});
      if (result.status !== 200) {
        show('error', messageFor(result.body.error, '无法删除技能密钥。'));
        return;
      }
      await renderSkillSecrets();
      show('ok', `已删除技能密钥「${target.name}」。`);
    });
    box.appendChild(questionNode);
    box.appendChild(cancel);
    box.appendChild(confirm);
    row.appendChild(box);
    trigger.hidden = true;
    pendingSecretConfirm = {box, trigger};
    if (typeof cancel.focus === 'function') cancel.focus();
  }

  function renderView() {
    const location = globalThis.location || {};
    const view = settingsViewFromLocation(location.pathname, location.hash);
    applySettingsView(document, view);
    if (current) syncAppearanceExtras(document, current);
    if (view === 'model-api' && current && imageForm && imageRevision === null) void loadImageApi();
    if (view === 'model-api' && location.hash === '#image-api') imageFields?.scrollIntoView?.({block:'start'});
    if (view === 'model-api') for (const api of mediaApis) api.render(location.hash);
  }

  function refreshAppearance() {
    applyTheme(document, current);
    syncAppearanceButton(document, current);
    syncAppearanceExtras(document, current);
    const appearanceStatus = document.getElementById('appearance-status');
    if (appearanceStatus) appearanceStatus.textContent = describeAppearance(current);
    syncOverviewCurrentValues(document, current);
    const languageCurrent = document.getElementById('language-current');
    const languageSelect = form.querySelector('select[name="language"]');
    if (languageCurrent && languageSelect) {
      const option = languageSelect.selectedOptions[0];
      languageCurrent.textContent = option ? option.textContent : '';
    }
    const fallback = document.getElementById('system-language-fallback');
    if (fallback) {
      fallback.hidden = supportsSystemLocale(current.language);
      languageSelect?.setAttribute('aria-describedby',
        fallback.hidden ? 'system-language-scope' : 'system-language-scope system-language-fallback');
    }
    const chatLanguageSelect = form.elements.chat_language;
    if (chatLanguageSelect) {
      const chosen = chatLanguageSelect.selectedOptions && chatLanguageSelect.selectedOptions[0];
      syncChatLanguageNote(document, chatLanguageSelect.value, chosen ? chosen.textContent : '');
    }
    if (current) {
      syncShortcutRows(document, current);
      syncPrivacySaveButton(document, current, readForm(form));
    }
  }

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body) {
    const headers = {'Accept': 'application/json'};
    const options = {method, headers, credentials: 'same-origin'};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = csrfCookie(document.cookie);
      options.body = JSON.stringify(body);
    }
    const response = await fetcher(path, options);
    const payload = await response.json();
    return {status: response.status, body: payload};
  }

  function prepareNotificationPrefs() {
    notificationValues = {};
    if (notificationState) notificationState.textContent = '';
    for (const input of Object.values(notificationInputs)) {
      input.disabled = true;
      input.checked = false;
    }
  }

  async function renderNotificationPrefs(sequence, pending) {
    if (!pending) return;
    const result = await pending;
    if (sequence !== loadSequence) return;
    if (result?.status !== 200 || !result.body?.prefs) {
      if (notificationState) notificationState.textContent = uiText(document, 'settings.notify.load-error');
      return;
    }
    for (const [key, input] of Object.entries(notificationInputs)) {
      const value = result.body.prefs[key];
      const supported = typeof value === 'boolean';
      const row = document.getElementById('row-notify-' + key.replaceAll('_', '-'));
      if (row) row.hidden = !supported;
      if (!supported) continue;
      notificationValues[key] = value;
      input.checked = value;
      input.disabled = false;
    }
  }

  for (const [key, input] of Object.entries(notificationInputs)) {
    input.addEventListener('change', async () => {
      const previous = notificationValues[key];
      if (input.disabled || typeof previous !== 'boolean') return;
      const sequence = loadSequence;
      input.disabled = true;
      const saved = await request('PUT', '/v1/notification-prefs', {changes:{[key]:input.checked}}).catch(() => null);
      if (sequence !== loadSequence) return;
      const value = saved?.status === 200 ? saved.body?.prefs?.[key] : undefined;
      input.disabled = false;
      if (typeof value !== 'boolean') {
        input.checked = previous;
        if (notificationState) notificationState.textContent = uiText(document, 'settings.notify.save-error');
        return;
      }
      input.checked = notificationValues[key] = value;
      if (notificationState) notificationState.textContent = uiText(document, value ? 'settings.notify.enabled' : 'settings.notify.disabled');
    });
  }

  async function loadModelStatus(sequence, pending) {
    const model = await pending;
    if (sequence !== loadSequence) return false;
    const values = model?.status === 200 && model.body?.model_api;
    modelRevision = Number.isInteger(values?.revision) ? values.revision : null;
    const loaded = modelRevision !== null;
    renderModelApi(document, modelForm, loaded ? model.body : null, !loaded);
    return loaded;
  }

  async function load() {
    const sequence = ++loadSequence;
    prepareNotificationPrefs();
    if (composioCard) {
      composioItems = [];
      renderComposio(null, 'loading');
    }
    if (modelForm) {
      modelRevision = null;
      if (modelRetry) modelRetry.disabled = false;
      renderModelApi(document, modelForm);
    }
    if (languageSave) {
      languageSave.input.disabled = false;
      languageSave = null;
    }
    const session = await request('GET', '/v1/auth/session');
    if (sequence !== loadSequence) return;
    if (session.status === 401) {
      current = null;
      if (document.documentElement.lang !== 'zh-CN') applySystemLocale(document, 'zh-CN');
      switchImageAccount(null);
      for (const api of mediaApis) api.setAccount(null);
      loginPanel.hidden = false;
      settingsPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    const account = session.body.user.id ?? session.body.user.username;
    switchImageAccount(account);
    for (const api of mediaApis) api.setAccount(account);
    const modelRead = modelForm && request('GET', '/v1/model-api').catch(() => null);
    const location = globalThis.location || {};
    const prefsRead = Object.keys(notificationInputs).length > 0 && settingsViewFromLocation(location.pathname, location.hash) === 'hub'
      ? request('GET', '/v1/notification-prefs').catch(() => null) : null;
    const settings = await request('GET', '/v1/settings');
    if (sequence !== loadSequence) return;
    if (settings.status !== 200) {
      show('error', uiText(document, 'settings.load.error'));
      return;
    }
    current = settings.body.settings.values;
    revision = settings.body.settings.revision;
    whoami.textContent = session.body.user.username;
    loginPanel.hidden = true;
    settingsPanel.hidden = false;
    fillForm(form, current);
    refreshAppearance();
    renderView();
    void renderNotificationPrefs(sequence, prefsRead);
    if (modelRead) await loadModelStatus(sequence, modelRead);
    if (sequence !== loadSequence) return;
    await renderSkillSecrets();
    await syncComposio();
  }

  async function renderProviders() {
    const box = document.getElementById('oidc-providers');
    if (!box) return;
    box.textContent = '';
    const listed = await request('GET', '/v1/auth/providers');
    if (listed.status !== 200 || !listed.body.items || !listed.body.items.length) return;
    for (const item of listed.body.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '使用 ' + item.label + ' 登录';
      button.dataset.provider = item.id;
      button.addEventListener('click', async () => {
        const started = await request('POST', '/v1/auth/oidc/start', {provider: item.id});
        if (started.status !== 200 || !started.body.authorization_url) {
          show('error', messageFor(started.body.error, '无法开始第三方登录。'));
          return;
        }
        globalThis.location.assign(started.body.authorization_url);
      });
      box.appendChild(button);
    }
  }

  document.getElementById('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    document.getElementById('password').value = '';
    await load();
  });

  async function autosave(successKey, language = false) {
    if (!current) return;
    const changes = diff(current, readForm(form));
    const selected = {};
    for (const key of AUTOSAVE_KEYS) {
      if ((key === 'language') !== language) continue;
      if (Object.prototype.hasOwnProperty.call(changes, key)) selected[key] = changes[key];
    }
    if (!Object.keys(selected).length) return;
    const sequence = loadSequence;
    const result = await request('POST', '/v1/settings', {revision, changes: selected}).catch(() => ({status:0, body:{}}));
    if (sequence !== loadSequence) return;
    if (result.status === 409) {
      current = result.body.error.current.values;
      revision = result.body.error.current.revision;
      fillForm(form, current);
      refreshAppearance();
      show('error', uiText(document, 'settings.save.conflict'));
      return;
    }
    if (result.status !== 200) {
      const latest = readForm(form);
      for (const [name, value] of Object.entries(selected)) {
        if (latest[name] !== value) continue;
        const control = form.elements[name];
        if (control?.type === 'checkbox') {
          control.checked = Boolean(current[name]);
          if (control.getAttribute('role') === 'switch') control.setAttribute('aria-checked', String(control.checked));
        } else if (control) control.value = current[name] ?? '';
      }
      refreshAppearance();
      show('error', uiText(document, 'settings.save.error'));
      return;
    }
    current = result.body.settings.values;
    revision = result.body.settings.revision;
    fillForm(form, current);
    refreshAppearance();
    show('ok', uiText(document, successKey));
  }

  settingsPanel.addEventListener('change', (event) => {
    const name = event.target && event.target.name;
    if (name === 'language') {
      const input = event.target;
      if (!current || languageSave || !supportsSystemLocale(input.value)) return;
      const attempt = {input, focused:document.activeElement === input};
      languageSave = attempt;
      input.disabled = true;
      return autosave('settings.saved', true).finally(() => {
        if (languageSave !== attempt) return;
        input.disabled = false;
        languageSave = null;
        if (attempt.focused && document.activeElement === document.body) input.focus({preventScroll:true});
      });
    }
    if (name === 'likes_visible' || name === 'favorites_visible') {
      const field = event.target;
      if (field && field.getAttribute('role') === 'switch') {
        field.setAttribute('aria-checked', field.checked ? 'true' : 'false');
      }
      syncPrivacySaveButton(document, current, readForm(form));
      return;
    }
    if (name === 'document_cards' && event.target && event.target.getAttribute('role') === 'switch') {
      event.target.setAttribute('aria-checked', event.target.checked ? 'true' : 'false');
    }
    if (name === 'send_shortcut') syncShortcutRows(document, readForm(form));
    if (name === 'chat_language' && event.target) {
      const selected = event.target.selectedOptions && event.target.selectedOptions[0];
      syncChatLanguageNote(document, event.target.value, selected ? selected.textContent : '');
    }
    if (!AUTOSAVE_KEYS.includes(name)) return;
    const key = ['appearance', 'appearance_schedule', 'appearance_start', 'appearance_end'].includes(name)
      ? 'settings.appearance.saved' : 'settings.saved';
    autosave(key);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!current) return;
    const changes = diff(current, readForm(form));
    delete changes.language;
    if (!Object.keys(changes).length) {
      show('ok', '没有需要保存的更改。');
      return;
    }
    const sequence = loadSequence;
    const result = await request('POST', '/v1/settings', {revision, changes});
    if (sequence !== loadSequence) return;
    if (result.status === 409) {
      current = result.body.error.current.values;
      revision = result.body.error.current.revision;
      fillForm(form, current);
      refreshAppearance();
      show('error', '设置已在别处更新，已重新加载，请再保存一次。');
      return;
    }
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    current = result.body.settings.values;
    revision = result.body.settings.revision;
    fillForm(form, current);
    refreshAppearance();
    show('ok', '已保存。');
    syncPrivacySaveButton(document, current, readForm(form));
  });

  async function renderSkillSecrets() {
    const list = document.getElementById('skill-secret-list');
    const skillForm = document.getElementById('skill-secrets-form');
    const empty = document.getElementById('skill-empty');
    if (!list || !skillForm) return;
    closeSecretConfirm(false);
    list.textContent = '';
    const listed = await request('GET', '/v1/skill-secrets');
    if (listed.status !== 200) return;
    const items = listed.body.items || [];
    for (const item of items) {
      const row = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = item.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.addEventListener('click', () => askSecretConfirmation(row, remove, item));
      row.appendChild(name);
      row.appendChild(remove);
      list.appendChild(row);
    }
    if (empty) empty.hidden = items.length > 0;
    list.hidden = items.length === 0;
  }

  const skillForm = document.getElementById('skill-secrets-form');
  const skillAddOpen = document.getElementById('skill-add-open');
  const skillAddCancel = document.getElementById('skill-add-cancel');
  if (skillAddOpen && skillForm) {
    skillAddOpen.addEventListener('click', () => {
      skillForm.hidden = false;
      const name = skillForm.elements.name;
      if (name) name.focus();
    });
  }
  if (skillAddCancel && skillForm) {
    skillAddCancel.addEventListener('click', () => {
      skillForm.hidden = true;
      skillForm.elements.value.value = '';
    });
  }
  if (skillForm) {
    skillForm.addEventListener('submit', async event => {
      event.preventDefault();
      const name = skillForm.elements.name.value.trim();
      const value = skillForm.elements.value.value;
      const result = await request('POST', '/v1/skill-secrets', {name, action: 'set', value});
      skillForm.elements.value.value = '';
      if (result.status !== 200) {
        show('error', messageFor(result.body.error, '保存技能密钥失败。'));
        return;
      }
      show('ok', '技能密钥已保存。');
      skillForm.hidden = true;
      await renderSkillSecrets();
    });
  }

  function switchImageAccount(account) {
    if (!imageForm || imageAccount === account) return;
    imageAccount = account;
    imageRevision = null;
    imageLoading = imageSaving = false;
    imageForm.reset?.();
    imageFields.disabled = true;
    removeImageKey.hidden = true;
    imageStatus.textContent = '';
  }

  function fillImageApi(config,message) {
    imageRevision = config.revision;
    imageForm.elements.base_url.value = config.base_url;
    imageForm.elements.model.value = config.model;
    imageForm.elements.api_key.value = '';
    removeImageKey.hidden = !config.api_key_set;
    imageStatus.textContent = message || (config.api_key_set ? '图片密钥已保存。' : '尚未配置图片密钥。');
    imageFields.disabled = false;
  }

  async function loadImageApi() {
    if (imageLoading) return;
    const account = imageAccount;
    imageLoading = true;
    imageStatus.textContent = '正在读取图片配置…';
    const response = await request('GET','/v1/model-api/image').catch(() => ({status:0,body:{}}));
    if (account !== imageAccount) return;
    imageLoading = false;
    if (response.status === 200 && response.body.image_api) fillImageApi(response.body.image_api);
    else imageStatus.textContent = '无法读取图片配置，请刷新后重试。';
  }

  async function saveImageApi(changes) {
    if (imageRevision === null || imageLoading || imageSaving) return;
    const account = imageAccount;
    imageSaving = imageFields.disabled = true;
    imageStatus.textContent = '正在保存…';
    const response = await request('POST','/v1/model-api/image',{revision:imageRevision,changes})
      .catch(() => ({status:0,body:{}}));
    if (account !== imageAccount) return;
    imageSaving = imageFields.disabled = false;
    imageForm.elements.api_key.value = '';
    if (response.status === 200 && response.body.image_api) {
      fillImageApi(response.body.image_api,changes.api_key === null ? '已移除图片密钥。' : '图片配置已保存。');
    } else if (response.status === 409) await loadImageApi();
    else imageStatus.textContent = messageFor(response.body.error,'无法保存图片配置，请重试。');
  }

  imageForm?.addEventListener('submit',event => {
    event.preventDefault();
    const {base_url,model,api_key} = imageForm.elements;
    const secret = api_key.value.trim();
    void saveImageApi({base_url:base_url.value.trim(),model:model.value.trim(),...(secret ? {api_key:secret} : {})});
  });
  removeImageKey?.addEventListener('click',() => void saveImageApi({api_key:null}));

  if (modelForm) {
    modelRetry?.addEventListener('click', async () => {
      if (modelRetry.hidden || modelRetry.disabled) return;
      const sequence = loadSequence;
      const focused = document.activeElement === modelRetry;
      modelRetry.disabled = true;
      const loaded = await loadModelStatus(sequence, request('GET', '/v1/model-api').catch(() => null));
      if (sequence !== loadSequence) return;
      modelRetry.disabled = false;
      if (focused && (document.activeElement === modelRetry || document.activeElement === document.body)) {
        const target = loaded ? document.getElementById('model-api-override-title') : modelRetry;
        target?.focus({preventScroll:true});
      }
    });

    async function saveModelApi(changes, success) {
      if (modelRevision === null || modelFields.disabled) return;
      const sequence = loadSequence;
      if (!Object.keys(changes).length) {
        show('ok', uiText(document, 'settings.model-api.no-changes'));
        return;
      }
      modelFields.disabled = true;
      const result = await request('POST', '/v1/model-api', {revision: modelRevision, changes}).catch(() => null);
      if (sequence !== loadSequence) return;
      modelFields.disabled = false;
      modelForm.elements.api_key.value = '';
      if (result?.status === 409) {
        show('error', uiText(document, 'settings.model-api.save-conflict'));
        await load();
        return;
      }
      if (result?.status !== 200) {
        show('error', uiText(document, 'settings.model-api.save-error'));
        return;
      }
      show('ok', uiText(document, success));
      await load();
    }

    modelForm.addEventListener('submit', event => {
      event.preventDefault();
      return saveModelApi(readModelForm(modelForm), 'settings.model-api.saved');
    });
    document.getElementById('restore-platform-model').addEventListener('click', () =>
      saveModelApi({api_key: null}, 'settings.model-api.restored'));
  }

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    current = null;
    revision = 0;
    switchImageAccount(null);
    for (const api of mediaApis) api.setAccount(null);
    await load();
  });

  const composioCard = document.getElementById('composio-key-card');
  const composioRetry = document.getElementById('composio-retry');
  let composioConfigured = false;
  let composioItems = [];
  let composioPoll = null;
  let composioRead;
  let composioReadState = 'loading';

  function composioNote(kind, text) {
    const node = document.getElementById('composio-key-message');
    if (!node) return;
    node.dataset.kind = kind;
    node.textContent = text;
  }

  function focusComposioKey() {
    const input = document.getElementById('composio-key-input');
    if (input) input.focus();
  }

  const keyJump = document.getElementById('connectors-key-jump');
  if (keyJump) keyJump.addEventListener('click', event => {
    event.preventDefault();
    focusComposioKey();
  });

  function renderComposio(view, readState, message = '') {
    composioConfigured = view?.configured === true;
    composioReadState = readState;
    const badge = document.getElementById('composio-key-state');
    const input = document.getElementById('composio-key-input');
    const save = document.getElementById('composio-key-save');
    const remove = document.getElementById('composio-key-remove');
    const status = document.getElementById('composio-read-message');
    if (badge) {
      badge.textContent = view ? (composioConfigured ? '已保存 ' + (view.key_hint || '') : '未配置 Composio')
        : readState === 'loading' ? '正在读取配置…' : '状态暂不可用';
      badge.setAttribute('data-state', view ? (composioConfigured ? 'configured' : 'unconfigured') : readState);
    }
    if (input) {
      input.disabled = !view;
      input.placeholder = composioConfigured ? '输入新 key 替换（原文不会显示）' : '粘贴你的 Composio API key';
    }
    if (status) {
      status.textContent = message;
      status.dataset.kind = readState === 'error' ? 'error' : '';
    }
    if (save) save.disabled = !view;
    if (remove) remove.hidden = !composioConfigured;
    if (keyJump) keyJump.hidden = !view || composioConfigured;
    if (composioRetry) composioRetry.hidden = readState !== 'error';
    applyComposioRows(document, composioConfigured, composioItems, readState);
  }

  async function syncComposio({refresh = false} = {}) {
    const sequence = loadSequence;
    if (!composioCard || (!refresh && composioRead?.sequence === sequence)) return;
    const read = composioRead = {sequence};
    const active = () => composioRead === read && sequence === loadSequence;
    let config;
    composioItems = [];
    renderComposio(null, 'loading');
    try {
      const view = await request('GET', '/v1/composio');
      if (!active()) return;
      if (view.status !== 200 || typeof view.body?.composio?.configured !== 'boolean') {
        renderComposio(null, 'error', '暂时无法读取 Composio 配置。');
        return;
      }
      config = view.body.composio;
      let cached = '';
      if (config.configured) {
        const listed = await request('GET', '/v1/composio/connections');
        if (!active()) return;
        if (listed.status !== 200 || !Array.isArray(listed.body?.items)) {
          renderComposio(config, 'error', '暂时无法读取应用连接状态。');
          return;
        }
        composioItems = listed.body.items;
        if (listed.body.sync === 'failed') cached = '暂时读不到 Composio 上的最新状态，显示的是本地记录。';
      }
      renderComposio(config, 'ready', cached);
      if (cached && composioRetry) composioRetry.hidden = false;
      if (composioItems.some(item => item.state === 'connecting')) startComposioPoll();
    } catch {
      if (active()) renderComposio(config, 'error', config ? '暂时无法读取应用连接状态。' : '暂时无法读取 Composio 配置。');
    } finally {
      if (composioRead === read) composioRead = null;
    }
  }

  composioRetry?.addEventListener('click', () => void syncComposio());

  function startComposioPoll() {
    if (composioPoll || typeof globalThis.setInterval !== 'function') return;
    let rounds = 0;
    composioPoll = globalThis.setInterval(async () => {
      const sequence = loadSequence;
      rounds += 1;
      const pending = composioItems.filter(item => item.state === 'connecting');
      if (!pending.length || rounds > 100) {
        globalThis.clearInterval(composioPoll);
        composioPoll = null;
        return;
      }
      for (const item of pending) {
        const result = await request('GET', '/v1/composio/connections/' + item.id);
        if (sequence !== loadSequence) return;
        if (result.status === 200) {
          composioItems = composioItems.map(old => old.id === item.id ? result.body.connection : old);
        } else if (result.status === 404) {
          composioItems = composioItems.filter(old => old.id !== item.id);
        }
      }
      applyComposioRows(document, composioConfigured, composioItems, composioReadState);
    }, 3000);
  }

  const composioForm = document.getElementById('composio-key-form');
  if (composioForm) {
    composioForm.addEventListener('submit', async event => {
      event.preventDefault();
      const input = document.getElementById('composio-key-input');
      if (input?.disabled) return;
      const value = input ? String(input.value || '').trim() : '';
      if (!value) {
        composioNote('error', '请先粘贴你的 Composio API key。');
        return;
      }
      const result = await request('POST', '/v1/composio/key', {api_key: value});
      if (input) input.value = '';
      if (result.status !== 200) {
        composioNote('error', messageFor(result.body.error, '无法保存 Composio API key。'));
        return;
      }
      composioNote('ok', '已保存你的 Composio API key（原文不会再显示）。');
      await syncComposio({refresh:true});
    });
  }
  const composioRemove = document.getElementById('composio-key-remove');
  if (composioRemove) {
    composioRemove.addEventListener('click', async () => {
      const result = await request('POST', '/v1/composio/key', {api_key: null});
      if (result.status !== 200) {
        composioNote('error', messageFor(result.body.error, '无法移除 Composio API key。'));
        return;
      }
      composioNote('ok', '已移除 Composio API key。本地连接记录已清除，Composio 项目里的账号不会被删除。');
      await syncComposio({refresh:true});
    });
  }
  const composioList = document.getElementById('connectors-catalog');
  if (composioList && composioCard) {
    composioList.addEventListener('click', async event => {
      const button = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('button[data-composio-action]') : null;
      if (!button || button.disabled) return;
      const action = button.getAttribute('data-composio-action');
      if (action === 'focus-key') {
        focusComposioKey();
        return;
      }
      const row = button.closest('[data-connector-id]');
      const toolkit = row ? row.getAttribute('data-composio-toolkit') : '';
      if (action === 'connect' && toolkit) {
        const popup = typeof globalThis.open === 'function' ? globalThis.open('', '_blank') : null;
        button.disabled = true;
        const result = await request('POST', '/v1/composio/connections', {toolkit});
        if (result.status !== 201) {
          if (popup) popup.close();
          composioNote('error', composioMessage(result.body.error, '无法开始连接。'));
          applyComposioRows(document, composioConfigured, composioItems, composioReadState);
          return;
        }
        composioItems = composioItems.concat([result.body.connection]);
        applyComposioRows(document, composioConfigured, composioItems, composioReadState);
        composioNote('ok', '已打开 Composio 授权页。完成授权后这里会自动更新状态。');
        if (popup) {
          popup.opener = null;
          popup.location.href = result.body.redirect_url;
        } else if (globalThis.location && typeof globalThis.location.assign === 'function') {
          globalThis.location.assign(result.body.redirect_url);
        }
        startComposioPoll();
      } else if (action === 'disconnect') {
        const id = button.getAttribute('data-connection-id');
        if (!id) return;
        button.disabled = true;
        const result = await request('POST', '/v1/composio/connections/' + id + '/disconnect', {});
        if (result.status !== 200 && result.status !== 404) {
          composioNote('error', composioMessage(result.body.error, '无法断开连接。'));
          applyComposioRows(document, composioConfigured, composioItems, composioReadState);
          return;
        }
        composioItems = composioItems.filter(item => item.id !== id);
        applyComposioRows(document, composioConfigured, composioItems, composioReadState);
        composioNote('ok', '已断开。');
      }
    });
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('focus', () => { if (composioConfigured) syncComposio(); });
    }
  }

  const connectorSearch = document.getElementById('connector-search');
  if (connectorSearch) {
    let group = 'all';
    const applySearch = () => applyConnectorSearch(document, connectorSearch.value, group);
    const filters = document.getElementById('connectors-filters');
    if (filters) {
      const groups = new Map();
      for (const row of CONNECTOR_CATALOG) {
        groups.set(row.category, (groups.get(row.category) || 0) + 1);
      }
      const overview = document.getElementById('connectors-catalog-count');
      if (overview) overview.textContent = CONNECTOR_CATALOG.length + ' 个应用 · ' + groups.size + ' 个分类';

      const choices = filters.querySelectorAll('[data-connector-group]');
      for (const choice of choices) {
        const category = choice.dataset.connectorGroup;
        const count = category === 'all' ? CONNECTOR_CATALOG.length : (groups.get(category) || 0);
        choice.querySelector('span').textContent = count;
        choice.addEventListener('click', () => {
          group = category;
          for (const option of choices) {
            option.setAttribute('aria-pressed', String(option === choice));
          }
          applySearch();
        });
      }
      filters.hidden = false;
    }
    connectorSearch.addEventListener('input', applySearch);
    connectorSearch.addEventListener('search', applySearch);
    applySearch();
  }

  const addMcp = document.getElementById('add-mcp-server');
  const mcpAck = document.getElementById('mcp-dialog-ack');
  if (addMcp) {
    addMcp.addEventListener('click', () => syncMcpDialog(document, true));
  }
  if (mcpAck) {
    mcpAck.addEventListener('click', () => syncMcpDialog(document, false));
  }
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const dialog = document.getElementById('mcp-dialog');
    if (dialog && !dialog.hidden) {
      event.preventDefault();
      syncMcpDialog(document, false);
      return;
    }
    if (pendingSecretConfirm) {
      event.preventDefault();
      closeSecretConfirm(true);
    }
  });

  globalThis.addEventListener('hashchange', renderView);
  renderView();
  return load();
}

if (globalThis.document && globalThis.document.getElementById('settings-form')) {
  mount(globalThis.document);
}
