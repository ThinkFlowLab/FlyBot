import { readWorkspaceChoices, servedByDsBot } from '../shell/dsbot-api.mjs';
import { mountActionMenus } from '../shell/action-menu.mjs';
import { chatPathId } from '../shell/chat-utils.mjs';
import { meetingArchiveDepth, meetingArchiveHref, meetingArchiveLocation, saveMeetingArchive } from '../shell/meeting-link.mjs';
import { studioDocumentFromSearch, studioDocumentHref } from '../shell/studio-link.mjs';
import { appendWorkTopics, isWorkTopic } from '../shell/work-topics.mjs';
import { preloadStudio, sharedWorkCopyToken, studioCopyCandidate, studioScope } from './entry.mjs';
import { artifactTargetFromSearch, startSavedArtifactReads, takeSpaceStartup } from './startup.mjs';

export { artifactTargetFromSearch };

function studioTargetFromSearch(search) {
  const params = new URLSearchParams(search || '');
  if (!params.has('studio')) return null;
  const workspace = params.get('workspace');
  if (params.size === 2 && params.get('studio') === 'catalog' && /^[0-9a-f]{32}$/.test(workspace || '')) {
    return {workspace, catalog:true};
  }
  return studioDocumentFromSearch(search) || {invalid:true};
}

import { mountArtifactNotifications } from './notifications.mjs';
import {
  artifactKindLabel as kindLabel, renderThumb,
  websiteTitle, websiteStub, websitePrompt, saveableSocialMessage, saveableAgentMessage,
  socialSavePath, agentSavePath, defaultSaveTitle, describeWebsiteDispatch, conversationChatHref,
} from '../shell/thumb.mjs';

// `/space?new=<kind>` opens the matching 新建 editor once the page has loaded
// (used by the chat composer's 创建 grid). Unknown values are ignored.
const NEW_KIND_BUTTONS = {document: 'new-artifact', website: 'new-website', slides: 'new-slides', dashboard: 'new-dashboard', spreadsheet: 'new-spreadsheet', whiteboard: 'new-board', media: 'new-media'};
export function newKindFromSearch(search) {
  const value = new URLSearchParams(search || '').get('new') || '';
  return Object.prototype.hasOwnProperty.call(NEW_KIND_BUTTONS, value) ? value : '';
}
export function newKindButtonId(kind) {
  return NEW_KIND_BUTTONS[kind] || '';
}

export function csrfCookie(raw) {
  const parts = String(raw || '').split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name === '__Host-ot_csrf' || name === 'ot_dev_csrf') return rest.join('=');
  }
  return '';
}

const DRAFT_STORAGE_PREFIX = 'ot-space-draft-v1:';
const DRAFT_MAX_ENTRIES = 16;
const DRAFT_MAX_AGE = 24 * 60 * 60 * 1000;
const DRAFT_MAX_BODY = 32_000;
const CATALOG_PAGE_SIZE = 20;
const CATALOG_READ_LIMIT = 100;
const CATALOG_CURSOR = /^[a-f0-9]{32}$/;
const CATALOG_SEARCH_DELAY = 180;
const MEETING_SEARCH_WINDOW = 100;

const FILE_TYPES = {
  云文档: 'document',
  电子表格: 'spreadsheet',
  幻灯片: 'slides',
  看板: 'dashboard',
  网页: 'website',
  图片: 'image',
  视频: 'video',
  文件: 'file',
  音频: 'audio',
  '3D 模型': 'model3d',
  白板: 'whiteboard',
  消息: 'messages',
};

export const FILE_TYPE_LABELS = Object.keys(FILE_TYPES);

export function listQuery(search, {
  kind = 'all', scope = 'all', types = [], creators = [], sessions = [], updated = {},
} = {}) {
  const needle = (search || '').trim();
  const parameters = [];
  if (needle) parameters.push('q=' + encodeURIComponent(needle));
  if (kind !== 'all') parameters.push('kind=' + encodeURIComponent(kind));
  if (scope !== 'all') parameters.push('scope=' + encodeURIComponent(scope));
  const filterTypes = types.filter(label => Object.hasOwn(FILE_TYPES, label)).map(label => FILE_TYPES[label]);
  for (const [name, values] of [['type', filterTypes], ['creator', creators], ['session', sessions]]) {
    for (const value of [...new Set(values)].sort()) parameters.push(name + '=' + encodeURIComponent(value));
  }
  if (Number.isSafeInteger(updated.since)) parameters.push('updated_since=' + updated.since);
  if (Number.isSafeInteger(updated.before)) parameters.push('updated_before=' + updated.before);
  return parameters.length ? '?' + parameters.join('&') : '';
}

const isModel3d = item => item?.kind === 'media' && item.media?.mime === 'model/gltf-binary';
const isGeneralFile = item => item?.kind === 'media' && item.media?.mime === 'application/octet-stream';

export function artifactMatchesType(item, type) {
  const mime = String((item && item.media && item.media.mime) || '');
  if (type === '云文档') return item.kind === 'document' && !(item.source && item.source.kind === 'agent_message');
  if (type === '网页') return item.kind === 'website';
  if (type === '图片') return item.kind === 'media' && mime.startsWith('image/');
  if (type === '视频') return item.kind === 'media' && mime.startsWith('video/');
  if (type === '文件') return isGeneralFile(item);
  if (type === '音频') return item.kind === 'media' && mime.startsWith('audio/');
  if (type === '3D 模型') return isModel3d(item);
  if (type === '白板') return item.kind === 'whiteboard';
  if (type === '电子表格') return item.kind === 'spreadsheet';
  if (type === '幻灯片') return item.kind === 'slides';
  if (type === '看板') return item.kind === 'dashboard';
  if (type === '消息') return !!(item.source && item.source.kind === 'agent_message');
  return false;
}

function localDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1) return null;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function localDayAfter(date) {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime() / 1000;
}

export function artifactModifiedBounds(window, now = Date.now(), {start, end} = {}) {
  if (window === 'custom') {
    const from = localDate(start);
    const through = localDate(end);
    if (!from || !through || through < from) return null;
    return {since: from.getTime() / 1000, before: localDayAfter(through)};
  }
  if (window === 'today') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return {since: start.getTime() / 1000, before: localDayAfter(start)};
  }
  const days = {d7: 7, d30: 30, d90: 90};
  return Object.hasOwn(days, window) ? {since: Math.ceil(now / 1000 - days[window] * 86400)} : {};
}

function artifactWithinBounds(item, {since, before}) {
  if (since == null && before == null) return true;
  const updated = Number(item?.updated);
  return item?.updated != null && Number.isFinite(updated) &&
    (since == null || updated >= since) && (before == null || updated < before);
}

function artifactSearchMatch(item) {
  const match = item.match;
  if (!match || !['title', 'body', 'filename'].includes(match.kind)
      || typeof match.text !== 'string' || match.text.length > 220
      || !Number.isInteger(match.start) || !Number.isInteger(match.end)
      || match.start < 0 || match.end <= match.start || match.end > match.text.length
      || /[\uDC00-\uDFFF]/u.test(match.text[match.start])
      || /[\uDC00-\uDFFF]/u.test(match.text[match.end])) return null;
  return match;
}

function appendArtifactHighlight(document, parent, match, excerpt = false) {
  const before = match.text.slice(0, match.start);
  const after = match.text.slice(match.end);
  const leading = excerpt ? [...before].slice(-16).join('') : before;
  const trailing = excerpt ? [...after].slice(0, 44).join('') : after;
  const mark = document.createElement('mark');
  mark.textContent = match.text.slice(match.start, match.end);
  parent.append(document.createTextNode((leading === before ? '' : '…') + leading), mark,
    document.createTextNode(trailing + (trailing === after ? '' : '…')));
}

export function artifactMatchesModified(item, window, now = Date.now(), range) {
  return artifactWithinBounds(item, artifactModifiedBounds(window, now, range) || {});
}

export function visibleArtifacts(items, options = {}) {
  const kind = options.kind || 'all';
  const scope = options.scope || 'all';
  const username = options.username || '';
  const types = options.types || [];
  const creators = options.creators || [];
  const sessions = options.sessions || [];
  const updated = options.updated ?? artifactModifiedBounds(options.modified, options.now ?? Date.now(), options.range) ?? {};
  if (kind === 'meetings') return [];
  let rows = [...(items || [])];
  if (scope === 'favorites') rows = rows.filter(item => item.favorited);
  if (scope === 'mine' && username) {
    rows = rows.filter((item) => item.created_by === username);
  }
  if (scope === 'memory') {
    rows = rows.filter((item) => item.source && item.source.kind === 'agent_task');
  }
  if (scope === 'automation') {
    rows = rows.filter((item) => item.source?.kind === 'automation_run');
  }
  if (kind === 'messages') {
    rows = rows.filter((item) => item.source && item.source.kind === 'agent_message');
  } else if (kind && kind !== 'all') {
    rows = rows.filter((item) => item.kind === kind);
  }
  if (types.length) {
    rows = rows.filter((item) => types.some((type) => artifactMatchesType(item, type)));
  }
  rows = rows.filter((item) => artifactWithinBounds(item, updated));
  if (creators.length) rows = rows.filter((item) => creators.includes(item.created_by));
  if (sessions.length) {
    rows = rows.filter((item) => item.source && sessions.includes(item.source.conversation_id));
  }
  return rows;
}

export function meetingActionLabel(count, done) {
  const total = Number(count) || 0;
  const finished = Number(done) || 0;
  if (total <= 0) return '尚无行动项';
  if (finished >= total) return `${total} 项行动项，全部完成`;
  if (finished > 0) return `${total} 项行动项，${finished} 项已完成`;
  return `${total} 项行动项`;
}

export function meetingTimeLabel(epochSeconds) {
  const ms = Number(epochSeconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function meetingRows(items) {
  const rows = (items || []).filter((item) => item && typeof item.title === 'string');
  rows.sort((left, right) => (Number(right.started_at) || 0) - (Number(left.started_at) || 0));
  return rows.map((item) => ({
    id: item.id,
    title: item.title,
    started_at: Number(item.started_at) || 0,
    actionLabel: meetingActionLabel(item.action_count, item.done_count),
    ...(item.shared === true ? {shared: true, organizer: item.organizer} : {}),
  }));
}

export function meetingsForScope(items, {scope = 'all', username = '', userId = ''} = {}) {
  const rows = Array.isArray(items) ? items : [];
  if (scope !== 'joined') return rows;
  const name = (username || '').trim().toLowerCase();
  return rows.filter((row) => {
    if (row.shared === true) return true;
    // The single-owner DS-Bot uses this marker when its platform user ID is unavailable.
    if (userId && (row.created_by === userId || row.created_by === 'owner')) return true;
    const attendees = Array.isArray(row.attendees) ? row.attendees : [];
    return Boolean(name) && attendees.some((item) => String(item).trim().toLowerCase() === name);
  });
}


export function sessionFilterChoices(items) {
  const sessions = [];
  const seen = new Set();
  for (const item of items || []) {
    const id = item.source && item.source.conversation_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = String((item.source && item.source.conversation_title) || '').trim();
    sessions.push({id, label: title || '对话'});
  }
  sessions.sort((left, right) => (left.label < right.label ? -1 : left.label > right.label ? 1 : left.id.localeCompare(right.id)));
  return sessions;
}

export function viewFromSearch(search) {
  const value = new URLSearchParams(search || '').get('view');
  if (value === 'created') return {kind: 'all', scope: 'mine'};
  if (value === 'starred') return {kind: 'all', scope: 'favorites'};
  if (value === 'memory') return {kind: 'all', scope: 'memory'};
  if (value === 'automation') return {kind: 'all', scope: 'automation'};
  if (value === 'meetings') return {kind: 'meetings', scope: 'all'};
  return {kind: 'all', scope: 'all'};
}

export function queryForView(kind, scope) {
  if (kind === 'meetings') return '?view=meetings';
  if (scope === 'mine') return '?view=created';
  if (scope === 'favorites') return '?view=starred';
  if (scope === 'memory') return '?view=memory';
  if (scope === 'automation') return '?view=automation';
  return '';
}

function workspaceFromFragment(hash) {
  const matches = new URLSearchParams((hash || '').slice(1)).getAll('workspace');
  return matches.length === 1 && /^[0-9a-f]{32}$/.test(matches[0]) ? matches[0] : '';
}

export function artifactOrigin(item, workspace) {
  if (!item?.source) return null;
  const source = item.source;
  const scoped = CATALOG_CURSOR.test(workspace || '') && (!item.workspace_id || item.workspace_id === workspace);
  if (source.kind === 'automation_run') {
    const href = scoped && CATALOG_CURSOR.test(source.automation_id || '') && CATALOG_CURSOR.test(source.id || '')
      ? '/automations?' + new URLSearchParams({workspace, automation: source.automation_id, run: source.id}) : '';
    return {kind: '自动化运行', title: source.automation_title || '', label: '查看原运行', href};
  }
  if (source.kind === 'team_run_step') {
    const step = source.position;
    const href = scoped && CATALOG_CURSOR.test(source.id || '') && Number.isInteger(step) && step >= 0 && step < 8
      ? '/team-runs#' + new URLSearchParams({workspace,run:source.id,step}) : '';
    return {kind:'团队任务', title:source.run_title || '', label:'查看来源步骤', href};
  }
  if (source.kind === 'agent_message') {
    const {conversation_id: id, agent_id, id: message_id} = source;
    const href = scoped && chatPathId(id) && chatPathId(message_id) && (!agent_id || CATALOG_CURSOR.test(agent_id))
      ? conversationChatHref(workspace, {source: agent_id ? 'agent' : 'social', id, agent_id, message_id}) : '';
    return {kind: '对话消息', title: source.conversation_title || '', label: '查看原消息', href};
  }
  if (source.kind === 'agent_task') return {kind: '智能体任务'};
  return null;
}

export function artifactDeletePrompt(artifact) {
  const title = artifact && typeof artifact.title === 'string' ? artifact.title.trim() : '';
  return {
    question: title ? `删除「${title}」？` : '删除这个作品？',
    detail: '删除后不能恢复。',
    cancelLabel: '取消',
    confirmLabel: '确认',
  };
}

export function savableTaskArtifacts(runs) {
  return (Array.isArray(runs) ? runs : []).filter(run =>
    run?.verified === true && /^[a-f0-9]{32}$/.test(run.task?.id || '')
  ).map(run => run.task);
}

export function taskArtifactTitle(task) {
  const prompt = task && typeof task.prompt === 'string' ? task.prompt.trim() : '';
  return prompt || '任务结果';
}

export function taskArtifactError(status, body, fallback = '保存失败。') {
  if (status === 401) return '登录后才能把任务成果保存到作品库。';
  if (status === 403) return '没有权限把这条任务成果保存到这个工作区。';
  const message = body && body.error && body.error.message;
  return typeof message === 'string' && message ? message : fallback;
}

export function applyDirectoryCollapsed(root, collapsed) {
  const next = Boolean(collapsed);
  const dir = root.getElementById('artifact-dir');
  const workspace = root.getElementById('list-panel');
  const collapse = root.getElementById('dir-collapse');
  const expand = root.getElementById('dir-expand');
  if (workspace) workspace.classList.toggle('dir-collapsed', next);
  if (dir) dir.hidden = next;
  if (collapse) collapse.setAttribute('aria-expanded', next ? 'false' : 'true');
  if (expand) expand.hidden = !next;
  return next;
}

function bindCatalogToolbar(document, closePopovers) {
  const viewport = document.defaultView?.matchMedia?.('(max-width: 700px)');
  const panel = document.getElementById('main-panel');
  const title = document.getElementById('space-title');
  const titleActions = document.getElementById('catalog-title-actions');
  const searchActions = document.getElementById('catalog-search-actions');
  const directory = document.getElementById('artifact-dir');
  const catalog = document.getElementById('list-panel');
  const newMenu = document.getElementById('new-menu-button')?.parentElement;
  const notify = document.getElementById('artifact-notify');
  const search = document.getElementById('search')?.parentElement;
  const filter = document.getElementById('filter-button')?.parentElement;
  const layout = document.getElementById('layout-toggle');
  const controls = [layout, newMenu, notify, search, filter];
  if (!viewport || !panel || !title || !titleActions || !searchActions || !directory || !catalog ||
      controls.some(control => !control?.parentElement)) {
    return () => {};
  }
  // Move the original controls so focus order follows their visual order and
  // there is still only one search, workspace context, and set of popovers.
  const original = [newMenu, search, filter, layout, notify].map(node => ({
    node, parent: node.parentElement, next: node.nextElementSibling,
  }));
  let catalogView = false;
  let compact = false;
  let active = false;

  function sync() {
    const next = catalogView && viewport.matches;
    if (next === compact && active === catalogView) return;
    compact = next;
    active = catalogView;
    closePopovers();
    const focus = document.activeElement;
    const restoreFocus = controls.some(node => node.contains(focus));
    if (compact) {
      titleActions.append(layout, newMenu, notify);
      searchActions.append(search, filter);
    } else {
      for (const {node, parent, next} of original.slice().reverse()) parent.insertBefore(node, next);
      if (active) searchActions.append(search, notify);
    }
    panel.classList.toggle('is-compact-catalog', compact);
    title.classList.toggle('visually-hidden', !active);
    directory.hidden = !compact && catalog.classList.contains('dir-collapsed');
    if (restoreFocus && !focus.closest('[hidden]')) focus.focus({preventScroll: true});
  }

  viewport.addEventListener?.('change', sync);
  return enabled => { catalogView = enabled; sync(); };
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

function idempotencyKey() {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let text = '';
  for (const value of bytes) text += String.fromCharCode(value);
  return globalThis.btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

const DISCOVER_SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export function suggestedDiscoverSlug(title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return DISCOVER_SLUG.test(slug) ? slug : '';
}

export function kindBadge(kind) {
  return ({document: 'DOC', website: 'WEB', slides: 'PPT', dashboard: 'DASH', spreadsheet: 'XLSX', whiteboard: 'BOARD', media: 'MEDIA', image: 'IMG', audio: 'AUDIO', video: 'VIDEO'}[kind] || 'FILE');
}

export function artifactTime(seconds, now = Date.now()) {
  if (!seconds) return '';
  const when = new Date(Number(seconds) * 1000);
  if (Number.isNaN(when.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date(now);
  const sameDay = when.toDateString() === today.toDateString();
  return sameDay ? `今天 ${pad(when.getHours())}:${pad(when.getMinutes())}`
    : `${when.getMonth() + 1}月${when.getDate()}日 ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

export function applyArtifactLayout(list, layout) {
  list.dataset.layout = layout === 'list' ? 'list' : 'grid';
  return list.dataset.layout;
}

export function canSendArtifactToChat(item) {
  return Boolean(item && item.id && ['media','document','website','whiteboard','slides','dashboard','spreadsheet'].includes(item.kind));
}

export function conversationLabel(item) {
  if (!item) return '未命名会话';
  const title = (item.title || '').trim();
  if (title) return title;
  const names = (item.members || []).map(row => row.username).filter(Boolean);
  if (names.length) return names.join('、');
  return item.kind === 'dm' ? '单聊' : '群聊';
}

function agentConversations(directory, {includeArchived = false} = {}) {
  const agents = new Map((directory.items || []).filter(agent => includeArchived || (!agent.archived && !agent.native_deleted))
    .map(agent => [agent.id, agent]));
  return (directory.conversations || []).filter(row => agents.has(row.agent_id)).map(row => {
    const agent = agents.get(row.agent_id);
    const title = (row.title || '').trim();
    const label = title && title !== agent.name ? agent.name + ' · ' + title : agent.name;
    return {...row, source: 'agent', label};
  });
}

const validActivityVersion = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

export function createArtifactActivity({read, apply, report, visible,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout, interval = 8000}) {
  let scope = '', version = '', timer, controller, failures = 0;

  function pause() {
    clearTimer(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  }

  function schedule(delay) {
    if (!scope || !visible()) return;
    clearTimer(timer);
    timer = setTimer(() => void check(), delay);
    timer?.unref?.();
  }

  async function check() {
    if (!scope || !visible() || controller) return;
    clearTimer(timer);
    const workspace = scope;
    const active = new AbortController();
    controller = active;
    const current = () => controller === active && workspace === scope && visible();
    const timeout = setTimer(() => active.abort(), 6000);
    timeout?.unref?.();
    try {
      const snapshot = await read(workspace, active.signal);
      if (!current()) return;
      if (active.signal.aborted || !validActivityVersion(snapshot?.version)) throw new Error('Invalid activity version');
      const applied = await apply(snapshot, {
        workspace, changed: version !== snapshot.version, signal: active.signal,
      });
      if (!current()) return;
      if (applied === false) throw new Error('Could not apply activity update');
      if (applied !== 'defer') version = validActivityVersion(applied) ? applied : snapshot.version;
      failures = 0;
      report('ready');
    } catch {
      if (!current()) return;
      failures += 1;
      report('error');
    } finally {
      clearTimer(timeout);
      if (controller === active) {
        controller = undefined;
        schedule(Math.min(45000, interval * 2 ** Math.min(failures, 3)));
      }
    }
  }

  return {
    setScope(workspace) {
      if (scope === workspace) return;
      pause();
      scope = workspace;
      version = '';
      failures = 0;
      report('idle');
      schedule(interval);
    },
    seed(workspace, baseline) {
      if (scope !== workspace || version || !validActivityVersion(baseline)) return;
      version = baseline;
      report('ready');
    },
    resume() {
      if (!visible()) pause();
      else void check();
    },
    check,
  };
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis), activityTimers} = {}) {
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const form = document.getElementById('editor-form');
  const listPanel = document.getElementById('list-panel');
  const editorLoading = document.getElementById('editor-loading');
  const main = document.getElementById('main');
  const catalogScrollers = [main, listPanel, listPanel.querySelector?.('.artifact-main')];
  const actionMenus = mountActionMenus(document);
  const newMenuButton = document.getElementById('new-menu-button');
  const newMenu = actionMenus.bind(newMenuButton, document.getElementById('new-menu'));
  let fileUpload;
  let fileUploadModule;
  let artifactRename;
  let artifactRenameModule;
  const catalogToolbar = bindCatalogToolbar(document, () => {
    actionMenus.close({focus: true});
    closeFilterPanel({focus: true});
  });
  const liveBanner = document.getElementById('artifact-live-update');
  const liveMessage = document.getElementById('artifact-live-message');
  const liveLoad = document.getElementById('artifact-live-load');
  const liveCompare = document.getElementById('artifact-live-compare');
  const editorPanels = new Map(['version', 'share', 'discover'].map(name => [name, document.getElementById(name + '-panel')]));
  const discoverSlug = document.getElementById('discover-slug');
  const treeOpen = document.getElementById('catalog-document-tree');
  const treeDialog = document.getElementById('document-tree');
  const treeHeading = document.getElementById('document-tree-heading');
  const treeList = document.getElementById('document-tree-list');
  const treeStatus = document.getElementById('document-tree-status');
  const treeRetry = document.getElementById('retry-document-tree');
  const editorDocumentNav = document.getElementById('editor-document-nav');
  const editorParentDocument = document.getElementById('editor-parent-document');
  const newChildDocument = document.getElementById('new-child-document');
  const moveDocument = document.getElementById('move-document');
  const moveDocumentForm = document.getElementById('move-document-form');
  const moveDestination = document.getElementById('move-document-destination');
  const moveSubmit = document.getElementById('move-document-submit');
  let treeRead;
  let documentMove;
  const discoverTopic = document.getElementById('discover-topic');
  const discoverTopicField = document.getElementById('discover-topic-field');
  const discoverEditable = document.getElementById('discover-editable-remix');
  const discoverEditableField = document.getElementById('discover-editable-remix-field');
  const discoverEditableNote = document.getElementById('discover-editable-remix-note');
  const discoverPublicLink = document.getElementById('discover-public-link');
  const discoverRevision = document.getElementById('discover-revision');
  const shareRevision = document.getElementById('share-revision');
  const publishDiscover = document.getElementById('publish-discover');
  const revokeDiscover = document.getElementById('revoke-discover');
  const mobileMenu = document.getElementById('mobile-editor-menu');
  const mobileMore = document.getElementById('mobile-editor-more');
  const mobileMarkdown = document.getElementById('mobile-editor-markdown');
  const mobileDelete = document.getElementById('mobile-editor-delete');
  const mobileSave = document.getElementById('mobile-editor-save');
  const mobilePanels = new Map([...editorPanels.keys()].map(name => [name, document.getElementById('mobile-editor-' + name)]));
  const saveButtons = ['save-artifact', 'document-save', 'sheet-save', 'slides-save', 'mobile-editor-save']
    .map(id => document.getElementById(id)).filter(Boolean);
  const workspaceSelect = document.getElementById('workspace');
  const workspacePending = document.getElementById('workspace-pending');
  const createButtons = [newMenuButton, ...[
    ...Object.values(NEW_KIND_BUTTONS), 'new-agent-document', 'new-agent-website', 'new-save-message',
    'empty-new-document', 'empty-agent-website', 'empty-save-message', 'empty-starred-save-message',
    'resume-draft-document', 'resume-draft-website',
  ].map(id => document.getElementById(id))].filter(Boolean);
  const search = document.getElementById('search');
  const clearSearch = document.getElementById('clear-artifact-search');
  const resetArtifactSearch = document.getElementById('reset-artifact-search');
  const nativeCatalog = servedByDsBot(document);
  if (nativeCatalog && discoverTopicField) {
    discoverTopicField.hidden = false;
    appendWorkTopics(document, discoverTopic);
  }
  const pageMore = document.getElementById('more-artifacts');
  const pageFooter = document.getElementById('artifact-pagination');
  const pageNote = document.getElementById('artifact-pagination-note');
  const filterButton = document.getElementById('filter-button');
  const filterPanel = document.getElementById('filter-panel');
  const filterReset = document.getElementById('filter-reset');
  const filterDates = document.getElementById('custom-range');
  const dateStart = document.getElementById('filter-date-start');
  const dateEnd = document.getElementById('filter-date-end');
  const dateMessage = document.getElementById('filter-date-message');
  const duplicateDialog = document.getElementById('duplicate-artifact-dialog');
  const duplicateForm = document.getElementById('duplicate-artifact-form');
  const duplicateTitle = document.getElementById('duplicate-artifact-title');
  const duplicateSource = document.getElementById('duplicate-artifact-source');
  const duplicateStatus = document.getElementById('duplicate-artifact-status');
  const duplicateCancel = document.getElementById('duplicate-artifact-cancel');
  const duplicateSubmit = document.getElementById('duplicate-artifact-submit');
  let duplicateState = null;
  let currentUser = null;
  let workspaceResolved = false;
  let studioWorkspaces = [];
  let workspaceLoad = 0;
  let studioPreload = null;
  let current = null;
  let editor = null;
  let catalog = null;
  let searchTimer = null;
  let draftKind = 'document';
  let catalogKind = 'all';
  let catalogScope = 'all';
  let catalogLayout = 'grid';
  const meetingTabs = [...document.querySelectorAll('.meeting-scopes [data-meeting-scope]')];
  const resultsPanel = document.getElementById('space-results-panel');
  let meetingScope = 'joined';
  let filterTypes = [];
  let filterUpdated = {};
  let filterCreators = [];
  let filterSessions = [];
  let facets = null;
  let allItems = [];
  let meetingItems = [];
  let meetingError = '';
  let meetingLoadedFor = '';
  let meetingLoading = false;
  let meetingRequest = 0;
  let meetingCursors = {meeting: '', shared: ''};
  let meetingVersion;
  let meetingDepth = 0;
  let meetingRetryLimit = 0;
  let focusedMeeting = '';
  let bookmarkRevision = 0;
  const pendingBookmarks = new Set();
  // A delete question is bound to the workspace and artifact it was asked about;
  // leaving that workspace retires it instead of letting the answer land elsewhere.
  let pendingDeleteCancel = null;

  form.elements.title.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit?.();
  });
  form.elements.title.addEventListener('input', () => {
    const title = form.elements.title;
    if (/[\r\n]/.test(title.value)) title.value = title.value.replace(/[\r\n]+/g, ' ');
  });

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extraHeaders, signal, keepalive = false) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie)};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin', signal, keepalive,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function canCreateInWorkspace() {
    return Boolean(currentUser && workspaceResolved && workspaceId());
  }

  function syncWorkspaceCreation() {
    const enabled = canCreateInWorkspace();
    for (const button of createButtons) button.disabled = !enabled;
    syncDocumentTreeAction();
    if (!enabled) {
      newMenu.close();
      fileUpload?.close();
      artifactRename?.close();
      closeDocumentTree();
    }
  }

  const notifications = mountArtifactNotifications(document, {
    request: (method, path, body, options = {}) =>
      request(method, path, body, undefined, options.signal, options.keepalive),
  });
  const studioButton = document.getElementById('studio-open');
  const studioDialog = document.getElementById('studio-dialog');
  const studioCopyButtons = ['studio-copy-open','studio-copy-mobile'].map(id => document.getElementById(id)).filter(Boolean);
  const studioRequest = (method, path, body, {headers,signal} = {}) => request(method, path, body, headers, signal);
  const selectedStudioWorkspace = () => nativeCatalog ? studioWorkspaces.find(item => item.id === workspaceId()) : null;
  const studioOptions = {
    request: studioRequest,
    personalWorkspace: () => studioWorkspaces.find(item => item.kind === 'personal' &&
      (!item.owner_id || item.owner_id === currentUser?.id))?.id,
    onOpenCatalog(workspace) {
      const current = studioTargetFromSearch(document.defaultView?.location?.search);
      if (current?.catalog && current.workspace === workspace) return;
      writeSpaceAddress(studioCatalogAddress(workspace), {push:true});
    },
    onDocument(workspace, id, revision) {
      const href = studioDocumentHref(workspace, id, revision);
      if (!href || spaceLocation() === href) return;
      const current = studioTargetFromSearch(document.defaultView?.location?.search);
      const studioFromCatalog = current?.catalog === true && current.workspace === workspace;
      if (studioFromCatalog) writeSpaceAddress(spaceLocation(), {studioFocus:id});
      writeSpaceAddress(href, {push:studioFromCatalog, studioFromCatalog});
    },
    onCatalog(workspace, {back = false} = {}) {
      const history = document.defaultView?.history;
      if (back && spaceAddress?.entry.studioFromCatalog && typeof history?.back === 'function') {
        approvedBack = true;
        history.back();
        return true;
      }
      writeSpaceAddress(studioCatalogAddress(workspace));
      return false;
    },
    onClose() {
      if (studioTargetFromSearch(document.defaultView?.location?.search)) syncViewUrl();
    },
  };
  const studio = lazyEditor(async () => {
    const {mountSharedStudio} = await import('./shared-studio.mjs');
    const component = mountSharedStudio(document, studioOptions);
    component?.setWorkspace(selectedStudioWorkspace(), currentUser?.id);
    return component;
  });
  const studioCopySource = () => ({
    selection: editor, item: current,
    workspaces: nativeCatalog ? studioWorkspaces : [],
  });
  const studioCopyOptions = {
    source: studioCopySource,
    ready(selection) {
      if (!activeEditor(selection) || !selection.account) return '请重新打开文档后再试。';
      if (selection.saving) return '作品正在保存，请稍候。';
      if (hasEditorDraft()) return '请先保存修改，再预览要复制的版本。';
      return '';
    },
    request: (selection, id, review) =>
      request('POST', editorPath(selection, id) + '/studio-copy', review, undefined, selection.controller.signal),
    show,
  };
  const studioCopy = lazyEditor(async () => {
    const {mountStudioCopy} = await import('./studio-copy.mjs');
    return mountStudioCopy(document, studioCopyOptions);
  });
  const sharedWorkCopyOptions = {
    request: (method, path, body, signal) => request(method, path, body, undefined, signal),
    dismissLink: () => syncViewUrl(),
    openArtifact: (workspace, artifact) => {
      void openEditor(artifact, {workspace,saved:true,notice:{kind:'ok',text:'已保存到个人空间。'}});
    },
  };
  const sharedWorkCopy = lazyEditor(async () => {
    const {mountSharedWorkCopy} = await import('./shared-work-copy.mjs');
    return mountSharedWorkCopy(document, sharedWorkCopyOptions);
  });
  const workVersion = lazyEditor(async () => {
    const {mountWorkVersion} = await import('./version-preview.mjs');
    return mountWorkVersion(document, {
      read: (path, signal) => request('GET', path, undefined, undefined, signal),
      closeAddress: ({workspace, id}) => writeSpaceAddress(worksPath() + '?' + new URLSearchParams({workspace,artifact:id}),
        {fromCatalog:Boolean(spaceAddress?.entry.fromCatalog)}),
    });
  });

  function syncStudioCopy() {
    const available = Boolean(studioCopyCandidate(studioCopySource()));
    for (const button of studioCopyButtons) button.hidden = !available;
  }

  function syncStudioWorkspace() {
    const team = selectedStudioWorkspace();
    if (studio.instance) studio.instance.setWorkspace(team, currentUser?.id);
    else if (studioButton) studioButton.hidden = typeof studioDialog?.showModal !== 'function' || !studioScope(team, currentUser?.id);
    syncStudioCopy();
  }

  studioButton?.addEventListener('click', async () => {
    if (!workspaceResolved || !studioScope(selectedStudioWorkspace(), currentUser?.id)) return;
    const load = workspaceLoad;
    studioButton.disabled = true;
    show('', '正在打开团队协作…');
    try {
      await studio.prepare();
      if (load !== workspaceLoad) return;
      show('', '');
      await studio.instance?.open();
    } catch {
      if (load === workspaceLoad) show('error', '无法加载团队协作，请重试。');
    } finally {
      studioButton.disabled = false;
    }
  });

  for (const button of studioCopyButtons) button.addEventListener('click', async () => {
    const source = studioCopyCandidate(studioCopySource());
    if (!source) return;
    button.disabled = true;
    try {
      await studioCopy.prepare();
      if (source.selection === editor && source.item === current) studioCopy.instance?.open();
    } catch {
      if (source.selection === editor) show('error', '无法打开团队复制，请重试。');
    } finally {
      button.disabled = false;
    }
  });

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

  function strokeId() {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  let boardState = {schema: 'flybot-workspace.whiteboard.v1', width: 800, height: 600, strokes: []};
  let boardTool = 'path';
  let drawing = null;

  function drawBoard() {
    const canvas = document.getElementById('board-canvas');
    if (!canvas) return;
    const width = Number.isInteger(boardState.width) && boardState.width >= 100 && boardState.width <= 2000 ? boardState.width : 800;
    const height = Number.isInteger(boardState.height) && boardState.height >= 100 && boardState.height <= 2000 ? boardState.height : 600;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const stroke of boardState.strokes) {
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      if (stroke.type === 'path' && stroke.points && stroke.points.length) {
        ctx.lineWidth = stroke.width || 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
        for (let i = 1; i < stroke.points.length; i += 1) ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
        ctx.stroke();
      } else if (stroke.type === 'rect') {
        ctx.lineWidth = 2;
        ctx.strokeRect(stroke.x, stroke.y, stroke.width, stroke.height);
      } else if (stroke.type === 'ellipse') {
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(stroke.x + stroke.width / 2, stroke.y + stroke.height / 2, Math.abs(stroke.width / 2), Math.abs(stroke.height / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (stroke.type === 'text') {
        ctx.font = (stroke.size || 16) + 'px system-ui,sans-serif';
        ctx.fillText(stroke.text, stroke.x, stroke.y);
      }
    }
  }

  function canvasPoint(event) {
    const canvas = document.getElementById('board-canvas');
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left) * (canvas.width / box.width);
    const y = (event.clientY - box.top) * (canvas.height / box.height);
    return [Math.max(0, Math.min(canvas.width, x)), Math.max(0, Math.min(canvas.height, y))];
  }

  let slidesState = {schema: 'flybot-workspace.slides.v1', slides: []};
  let slideEditCount = 0;
  let pendingSlideDraft = null;
  const slideDraft = document.getElementById('slide-draft');
  const slidePrompt = document.getElementById('slide-prompt');
  const slideDraftStatus = document.getElementById('slide-draft-status');
  const slideDraftSubmit = document.getElementById('slide-draft-submit');
  const slideContext = document.getElementById('slide-context');
  const slideContextOption = document.getElementById('slide-context-option');
  const slideContextTitle = document.getElementById('slide-context-title');
  const sendSlides = document.getElementById('send-saved-slides');
  const downloadSlides = document.getElementById('download-slides');

  function slidesDeck() {
    return {
      schema: 'flybot-workspace.slides.v1',
      slides: slidesState.slides.map(slide => ({
        title: String(slide.title || '').trim(),
        bullets: (slide.bullets || []).map(value => String(value).trim()).filter(Boolean),
      })),
    };
  }

  function renderSlidesEditor(focusIndex) {
    const list = document.getElementById('slide-list');
    if (!list) return;
    let focusTarget;
    list.replaceChildren();
    slidesState.slides.forEach((slide, index) => {
      const li = document.createElement('li');
      li.className = 'slide-card';
      const head = document.createElement('div');
      head.className = 'slide-head';
      const label = document.createElement('span');
      label.className = 'slide-index';
      label.textContent = '第 ' + (index + 1) + ' 页';
      const actions = document.createElement('div');
      actions.className = 'slide-card-actions';
      for (const [offset, text, name] of [[-1, '↑', '上移'], [1, '↓', '下移']]) {
        const move = document.createElement('button');
        const to = index + offset;
        move.type = 'button';
        move.textContent = text;
        move.setAttribute('aria-label', name + label.textContent);
        move.disabled = to < 0 || to >= slidesState.slides.length;
        move.addEventListener('click', () => {
          slidesState.slides[index] = slidesState.slides[to];
          slidesState.slides[to] = slide;
          slideEditCount++;
          renderSlidesEditor(to);
        });
        actions.append(move);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.setAttribute('aria-label', '删除' + label.textContent);
      remove.addEventListener('click', () => {
        slidesState.slides.splice(index, 1);
        slideEditCount++;
        renderSlidesEditor(Math.min(index, slidesState.slides.length - 1));
      });
      actions.append(remove);
      head.append(label, actions);
      const title = document.createElement('input');
      title.type = 'text';
      title.maxLength = 120;
      title.placeholder = '页标题';
      title.setAttribute('aria-label', label.textContent + '标题');
      title.value = slide.title || '';
      title.addEventListener('input', () => {
        slide.title = title.value;
        slideEditCount++;
      });
      const bullets = document.createElement('textarea');
      bullets.rows = 4;
      bullets.maxLength = 4000;
      bullets.placeholder = '每行一条要点（最多 10 条）';
      bullets.setAttribute('aria-label', label.textContent + '要点');
      bullets.value = (slide.bullets || []).join('\n');
      bullets.addEventListener('input', () => {
        slide.bullets = bullets.value.split('\n');
        slideEditCount++;
      });
      li.append(head, title, bullets);
      list.append(li);
      if (index === focusIndex) focusTarget = title;
    });
    const count = document.getElementById('slides-count');
    if (count) count.textContent = slidesState.slides.length + ' / 30 页';
    const add = document.getElementById('add-slide');
    if (add) add.disabled = slidesState.slides.length >= 30;
    if (focusIndex !== undefined) (focusTarget || add)?.focus();
  }

  if (slideDraftSubmit && slidePrompt && slideDraftStatus) {
    form.elements.title.addEventListener?.('input', () => {
      if (current?.kind === 'slides') slideEditCount++;
    });
    slideDraftSubmit.addEventListener('click', async () => {
      const prompt = slidePrompt.value.trim();
      if (pendingSlideDraft || current?.kind !== 'slides' || current.id || !workspaceId()) return;
      if (!prompt) {
        slideDraftStatus.textContent = '请填写幻灯片主题或素材。';
        slidePrompt.focus();
        return;
      }
      if (slidesDeck().slides.some(slide => slide.title || slide.bullets.length)) {
        slideDraftStatus.textContent = '已有幻灯片内容。请新建一份空白幻灯片后起草。';
        return;
      }
      const artifact = current;
      const wid = workspaceId();
      const edits = slideEditCount;
      const token = pendingSlideDraft = {};
      const active = () => pendingSlideDraft === token && !form.hidden && current === artifact && workspaceId() === wid;
      const origin = artifactSendOrigin;
      const body = {prompt};
      if (slideContext?.checked && origin?.allowed && origin.item === artifact && origin.wid === wid) {
        body.conversation_id = origin.conversation;
      }
      slideDraftSubmit.disabled = true;
      slideDraftSubmit.textContent = '正在生成…';
      slideDraftStatus.textContent = '智能体正在起草幻灯片。';
      try {
        const result = await request('POST', `/v1/workspaces/${wid}/artifacts/slides/draft`, body);
        if (!active()) return;
        if (slideEditCount !== edits || form.inert) {
          slideDraftStatus.textContent = '已保留你的编辑。需要起草时请重新生成。';
          return;
        }
        if (result.status !== 200 || !result.body.slides?.slides?.length) {
          slideDraftStatus.textContent = messageFor(result.body.error, '无法生成幻灯片草稿，请重试。');
          return;
        }
        slidesState = result.body.slides;
        if (!form.elements.title.value.trim()) form.elements.title.value = result.body.title || '';
        slideDraft.open = false;
        slideDraft.querySelector?.('summary')?.focus();
        renderSlidesEditor();
        slideDraftStatus.textContent = '草稿已生成。可编辑后保存。';
      } catch {
        if (active()) slideDraftStatus.textContent = '无法生成幻灯片草稿，请重试。';
      } finally {
        if (pendingSlideDraft === token) {
          pendingSlideDraft = null;
          slideDraftSubmit.disabled = false;
          slideDraftSubmit.textContent = '生成草稿';
        }
      }
    });
  }

  let dashboardState = {schema: 'flybot-workspace.dashboard.v1', widgets: []};

  function widgetDefault(type) {
    if (type === 'table') return {type: 'table', title: '', columns: ['列 1', '列 2'], rows: [['', '']]};
    if (type === 'bar') return {type: 'bar', title: '', labels: ['A'], values: [0]};
    return {type: 'metric', title: '', value: '', note: ''};
  }

  function splitList(text) {
    return String(text || '').split(',').map(value => value.trim()).filter(Boolean);
  }

  function parseRows(text, width) {
    return String(text || '').split('\n').map(line => line.split('|').map(cell => cell.trim()))
      .filter(row => row.some(Boolean));
  }

  function dashboardValue() {
    return {
      schema: 'flybot-workspace.dashboard.v1',
      widgets: dashboardState.widgets.map(widget => {
        if (widget.type === 'metric') {
          return {type: 'metric', title: widget.title || '', value: widget.value || '', note: widget.note || ''};
        }
        if (widget.type === 'table') {
          return {type: 'table', title: widget.title || '', columns: widget.columns || [], rows: widget.rows || []};
        }
        return {type: 'bar', title: widget.title || '', labels: widget.labels || [], values: widget.values || []};
      }),
    };
  }

  function renderDashboardEditor() {
    const list = document.getElementById('widget-list');
    if (!list) return;
    list.replaceChildren();
    dashboardState.widgets.forEach((widget, index) => {
      const li = document.createElement('li');
      li.className = 'slide-card';
      const head = document.createElement('div');
      head.className = 'slide-head';
      const types = document.createElement('select');
      for (const value of ['metric', 'table', 'bar']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value === 'metric' ? '指标' : (value === 'table' ? '表格' : '条形图');
        if (widget.type === value) option.selected = true;
        types.append(option);
      }
      types.addEventListener('change', () => {
        dashboardState.widgets[index] = widgetDefault(types.value);
        renderDashboardEditor();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '删除';
      remove.addEventListener('click', () => {
        dashboardState.widgets.splice(index, 1);
        renderDashboardEditor();
      });
      head.append(types, remove);
      const title = document.createElement('input');
      title.type = 'text';
      title.maxLength = 120;
      title.placeholder = '组件标题';
      title.value = widget.title || '';
      title.addEventListener('input', () => { widget.title = title.value; });
      li.append(head, title);
      if (widget.type === 'metric') {
        const value = document.createElement('input');
        value.type = 'text';
        value.maxLength = 120;
        value.placeholder = '指标值，例如 2400 元';
        value.value = widget.value || '';
        value.addEventListener('input', () => { widget.value = value.value; });
        const note = document.createElement('input');
        note.type = 'text';
        note.maxLength = 200;
        note.placeholder = '备注（可选）';
        note.value = widget.note || '';
        note.addEventListener('input', () => { widget.note = note.value; });
        li.append(value, note);
      } else if (widget.type === 'table') {
        const columns = document.createElement('input');
        columns.type = 'text';
        columns.placeholder = '列名，用逗号分隔';
        columns.value = (widget.columns || []).join(', ');
        columns.addEventListener('input', () => { widget.columns = splitList(columns.value); });
        const rows = document.createElement('textarea');
        rows.rows = 4;
        rows.placeholder = '每行一条，单元格用 | 分隔';
        rows.value = (widget.rows || []).map(row => row.join(' | ')).join('\n');
        rows.addEventListener('input', () => { widget.rows = parseRows(rows.value); });
        li.append(columns, rows);
      } else {
        const labels = document.createElement('input');
        labels.type = 'text';
        labels.placeholder = '标签，用逗号分隔';
        labels.value = (widget.labels || []).join(', ');
        labels.addEventListener('input', () => { widget.labels = splitList(labels.value); });
        const values = document.createElement('input');
        values.type = 'text';
        values.placeholder = '数值，用逗号分隔';
        values.value = (widget.values || []).join(', ');
        values.addEventListener('input', () => {
          widget.values = splitList(values.value).map(value => {
            const number = Number(value);
            return Number.isFinite(number) ? number : 0;
          });
        });
        li.append(labels, values);
      }
      list.append(li);
    });
    const add = document.getElementById('add-widget');
    if (add) add.disabled = dashboardState.widgets.length >= 20;
  }

  function lazyEditor(initialize) {
    let pending;
    let instance;
    return {
      get instance() { return instance; },
      prepare() {
        pending ??= initialize().then(tool => {
          instance = tool;
        }).catch(error => {
          pending = undefined;
          throw error;
        });
        return pending;
      },
    };
  }

  const richDocument = lazyEditor(async () => {
    const { bindDocumentEditor } = await import('../shell/rich-editor.mjs');
    return bindDocumentEditor(document, form);
  });
  const documentDraftPanel = document.getElementById('document-draft');
  const documentDraftPrompt = document.getElementById('document-draft-prompt');
  const documentDraftStatus = document.getElementById('document-draft-status');
  const documentDraftGenerate = document.getElementById('document-draft-generate');
  const documentDraftPreview = document.getElementById('document-draft-preview');
  let documentDraftRequest;
  let documentDraftResult;

  function resetDocumentDraft(enabled = false) {
    documentDraftRequest?.abort();
    documentDraftRequest = documentDraftResult = null;
    if (!documentDraftPanel) return;
    documentDraftPanel.hidden = !enabled;
    documentDraftPanel.open = false;
    documentDraftPrompt.value = documentDraftStatus.textContent = '';
    documentDraftGenerate.disabled = false;
    documentDraftPreview.hidden = true;
    document.getElementById('document-draft-body').replaceChildren();
  }

  function acceptsDocumentDraft(selection) {
    return nativeCatalog && activeEditor(selection) && current?.kind === 'document' && !current.id && !form.hidden && !form.inert;
  }

  documentDraftPrompt?.addEventListener('input', () => {
    if (!documentDraftResult) return;
    documentDraftResult = null;
    documentDraftPreview.hidden = true;
    documentDraftStatus.textContent = '描述已修改，请重新生成。';
  });

  documentDraftGenerate?.addEventListener('click', async () => {
    const selection = editor;
    if (!acceptsDocumentDraft(selection) || documentDraftRequest) return;
    const prompt = documentDraftPrompt.value.trim();
    if (!prompt) {
      documentDraftStatus.textContent = '请填写主题或要点。';
      documentDraftPrompt.focus();
      return;
    }
    const controller = documentDraftRequest = new AbortController();
    documentDraftResult = null;
    documentDraftPreview.hidden = true;
    documentDraftGenerate.disabled = true;
    documentDraftStatus.textContent = '正在起草文档…';
    const active = () => documentDraftRequest === controller && acceptsDocumentDraft(selection);
    try {
      const signal = AbortSignal.any([controller.signal, selection.controller.signal, AbortSignal.timeout(45000)]);
      const result = await request('POST', `/v1/workspaces/${selection.workspace}/artifacts/document/draft`, {prompt}, undefined, signal);
      if (!active()) return;
      const {title, document: markdown} = result.body;
      if (result.status !== 200 || typeof title !== 'string' || title.length > 80 ||
          typeof markdown !== 'string' || !markdown.trim() || markdown.length > 8000) {
        throw new Error(messageFor(result.body.error, '无法生成草稿，请重试。'));
      }
      const [{renderMarkdown}, {tableMarkdownOptions}] = await Promise.all([
        import('../shell/markdown.mjs'), import('../shell/markdown-table.mjs'),
      ]);
      if (!active()) return;
      if (prompt !== documentDraftPrompt.value.trim()) {
        documentDraftStatus.textContent = '描述已修改，请重新生成。';
        return;
      }
      documentDraftResult = {selection, title, markdown};
      document.getElementById('document-draft-title').textContent = title;
      renderMarkdown(document, document.getElementById('document-draft-body'), markdown, tableMarkdownOptions);
      documentDraftPreview.hidden = false;
      documentDraftStatus.textContent = '草稿已生成，可以预览并采用。';
    } catch (error) {
      if (active()) documentDraftStatus.textContent = error.name === 'Error' ? error.message : '无法生成草稿，请重试。';
    } finally {
      if (documentDraftRequest === controller) {
        documentDraftRequest = null;
        documentDraftGenerate.disabled = false;
      }
    }
  });

  document.getElementById('document-draft-apply')?.addEventListener('click', () => {
    const preview = documentDraftResult;
    if (!preview || !acceptsDocumentDraft(preview.selection) || !richDocument.instance) return;
    richDocument.instance.flush();
    if (form.elements.body.value.trim()) {
      documentDraftStatus.textContent = '已保留你的正文。清空正文后可以采用预览，也可以复制其中需要的部分。';
      return;
    }
    if (!form.elements.title.value.trim()) form.elements.title.value = preview.title;
    form.elements.body.value = preview.markdown;
    richDocument.instance.load(preview.markdown, true);
    persistDraft();
    resetDocumentDraft(true);
    document.getElementById('document-rich').focus();
    show('ok', '已采用草稿，可以编辑后保存。');
  });

  const spreadsheet = lazyEditor(async () => {
    const { mountSpreadsheet } = await import('./spreadsheet.mjs');
    return mountSpreadsheet(document, {
      async onDraft(prompt) {
        const result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/spreadsheet/draft`, {prompt});
        if (result.status !== 200 || !result.body.spreadsheet) {
          throw new Error(messageFor(result.body.error, '无法生成表格草稿。'));
        }
        return result.body;
      },
      onTitle(title) {
        if (!form.elements.title.value.trim()) form.elements.title.value = title;
      },
    });
  });
  const sendSpreadsheet = document.getElementById('send-saved-spreadsheet');
  const downloadSpreadsheet = document.getElementById('download-spreadsheet');
  const model3dPanel = document.getElementById('media-model3d');
  const model3dDownload = document.getElementById('media-model3d-download');
  const model3dPreview = lazyEditor(async () => {
    const { bindModel3dPreview } = await import('../shell/model3d-preview.mjs');
    return bindModel3dPreview(document.getElementById('media-model3d-toggle'),
      document.getElementById('media-model3d-preview'), document.getElementById('media-model3d-status'));
  });

  function editorTools(item) {
    if (item?.kind === 'document') return richDocument;
    if (item?.kind === 'spreadsheet') return spreadsheet;
    if (isModel3d(item)) return model3dPreview;
    return null;
  }

  const websitePreview = document.getElementById('website-preview');
  const websiteControls = document.getElementById('website-preview-controls');
  const websiteToggle = document.getElementById('website-preview-toggle');
  const websiteStatus = document.getElementById('website-preview-status');
  let websiteSource = '';
  let websiteRevision = null;
  let websiteInteractive = false;

  function renderWebsitePreview(interactive = false) {
    websiteInteractive = interactive && websiteRevision !== null;
    websitePreview.hidden = !websiteSource;
    websitePreview.setAttribute('sandbox', websiteInteractive ? 'allow-scripts' : '');
    if (websiteSource) websitePreview.src = websiteInteractive ? websiteSource + '?revision=' + websiteRevision : websiteSource;
    else websitePreview.removeAttribute('src');
    if (websiteControls) websiteControls.hidden = websiteRevision === null;
    if (websiteToggle) {
      websiteToggle.textContent = websiteInteractive ? '关闭互动预览' : '打开互动预览';
      websiteToggle.setAttribute('aria-pressed', String(websiteInteractive));
    }
    if (websiteStatus) {
      websiteStatus.textContent = websiteInteractive ? `正在预览已保存的版本 ${websiteRevision}。` : '';
      websiteStatus.hidden = !websiteInteractive;
    }
  }

  function setWebsitePreview(item = null) {
    const eligible = item?.kind === 'website' && item.id && workspaceId();
    websiteSource = eligible ? `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/preview` : '';
    websiteRevision = eligible && servedByDsBot(document) && item.body?.trim()
      && Number.isSafeInteger(item.revision) && item.revision > 0 ? item.revision : null;
    renderWebsitePreview();
  }

  websiteToggle?.addEventListener('click', () => renderWebsitePreview(!websiteInteractive));

  function updateEditorMeta(item, kind) {
    const meta = document.getElementById('editor-meta');
    const labels = {website: '新网站', media: '新媒体', whiteboard: '新白板', slides: '新幻灯片', dashboard: '新看板', spreadsheet: '新电子表格', document: '新文档'};
    if (item && item.id) {
      meta.textContent = `${kindLabel(kind, item.media?.mime)} · 修订 ${item.revision} · 作者 ${item.created_by || ''}`;
    } else {
      meta.textContent = labels[kind] || '新文档';
    }
    syncSharingRevisions(item?.revision);
  }

  function fillEditor(item) {
    form.elements.title.value = item && item.title ? item.title : '';
    form.elements.body.value = item && typeof item.body === 'string' ? item.body : '';
    const kind = (item && item.kind) || draftKind;
    richDocument.instance?.load(form.elements.body.value, kind === 'document');
    resetDocumentDraft(nativeCatalog && kind === 'document' && !item?.id);
    updateEditorMeta(item, kind);
    document.getElementById('body-label').hidden = kind !== 'website';
    document.getElementById('media-editor').hidden = kind !== 'media';
    document.getElementById('board-editor').hidden = kind !== 'whiteboard';
    document.getElementById('slides-editor').hidden = kind !== 'slides';
    document.getElementById('dashboard-editor').hidden = kind !== 'dashboard';
    const spreadsheetEditor = document.getElementById('spreadsheet-editor');
    if (spreadsheetEditor) spreadsheetEditor.hidden = kind !== 'spreadsheet';
    for (const button of [sendSpreadsheet, downloadSpreadsheet]) {
      if (button) button.hidden = kind !== 'spreadsheet' || !item?.id;
    }
    if (kind === 'spreadsheet') spreadsheet.instance.load(item?.spreadsheet, item?.id, !item?.id);
    for (const button of [sendSlides, downloadSlides]) {
      if (button) button.hidden = kind !== 'slides' || !item?.id;
    }
    pendingSlideDraft = null;
    if (kind === 'slides') {
      if (slideDraft) {
        slideDraft.hidden = Boolean(item?.id);
        slideDraft.open = false;
      }
      if (slidePrompt) slidePrompt.value = '';
      if (slideContext) slideContext.checked = false;
      if (slideContextOption) slideContextOption.hidden = true;
      if (slideContextTitle) slideContextTitle.hidden = true;
      if (slideDraftStatus) slideDraftStatus.textContent = '';
      if (slideDraftSubmit) {
        slideDraftSubmit.disabled = false;
        slideDraftSubmit.textContent = '生成草稿';
      }
      slidesState = item && item.slides ? item.slides : {schema: 'flybot-workspace.slides.v1', slides: []};
      if (!Array.isArray(slidesState.slides)) slidesState = {schema: 'flybot-workspace.slides.v1', slides: []};
      if (!slidesState.slides.length) slidesState.slides.push({title: '', bullets: []});
      renderSlidesEditor();
    }
    if (kind === 'dashboard') {
      dashboardState = item && item.dashboard ? item.dashboard : {schema: 'flybot-workspace.dashboard.v1', widgets: []};
      if (!Array.isArray(dashboardState.widgets)) dashboardState = {schema: 'flybot-workspace.dashboard.v1', widgets: []};
      if (!dashboardState.widgets.length) dashboardState.widgets.push(widgetDefault('metric'));
      renderDashboardEditor();
    }
    const image = document.getElementById('media-image');
    const audio = document.getElementById('media-audio');
    const video = document.getElementById('media-video');
    const mediaMeta = document.getElementById('media-meta');
    const model3d = Boolean(item?.id && isModel3d(item));
    const picker = document.getElementById('media-file-picker');
    const download = document.getElementById('media-file-download');
    const generalFile = isGeneralFile(item);
    if (picker) picker.hidden = model3d || generalFile;
    if (download) {
      download.hidden = !generalFile;
      if (generalFile) download.href = `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/file`;
      else download.removeAttribute('href');
    }
    if (kind === 'media') document.getElementById('media-file').value = '';
    if (model3dPanel) model3dPanel.hidden = !model3d;
    let model3dSource = '';
    image.hidden = true; audio.hidden = true; video.hidden = true;
    image.removeAttribute('src'); audio.removeAttribute('src'); video.removeAttribute('src');
    if (kind === 'media') {
      if (item && item.id && item.media) {
        const fileType = generalFile ? '' : ` · ${item.media.mime || ''}`;
        mediaMeta.textContent = `${item.media.filename || ''}${fileType} · ${item.media.bytes || 0} 字节`;
        const src = `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/file`;
        if ((item.media.mime || '').startsWith('image/')) { image.hidden = false; image.src = src; }
        else if ((item.media.mime || '').startsWith('audio/')) { audio.hidden = false; audio.src = src; }
        else if ((item.media.mime || '').startsWith('video/')) { video.hidden = false; video.src = src; }
        else if (model3d) {
          model3dSource = src;
          if (model3dDownload) model3dDownload.href = `/v1/workspaces/${workspaceId()}/artifacts/${item.id}/export`;
        }
      } else {
        mediaMeta.textContent = '选择一张图片或一段音视频，大小不超过 2 MB。';
      }
    }
    model3dPreview.instance?.setSource(model3dSource);
    if (kind === 'whiteboard') {
      boardState = item && item.board ? item.board : {schema: 'flybot-workspace.whiteboard.v1', width: 800, height: 600, strokes: []};
      drawBoard();
    }
    const source = document.getElementById('editor-source');
    const origin = artifactOrigin(item, workspaceId());
    source.hidden = !origin;
    source.textContent = origin ? '来源：' + origin.kind : '';
    if (origin?.title) source.append(' · ' + origin.title);
    if (origin?.href) {
      const link = document.createElement('a');
      link.href = origin.href;
      link.textContent = origin.label;
      source.append(' ', link);
    }
    setWebsitePreview(item);
    if (editor) editor.cleanDraft = editorDraft();
  }

  function closeNewMenu() {
    newMenu.close();
  }

  function worksPath() {
    const path = (document.defaultView && document.defaultView.location && document.defaultView.location.pathname) || '/space';
    const trimmed = path.replace(/\/+$/, '') || '/space';
    return trimmed === '/artifacts' ? '/artifacts' : '/space';
  }

  const previousSpaceState = document.defaultView?.history?.state;
  const previousSpaceEntry = previousSpaceState?.flybotWorkspaceSpace;
  const restoredSpaceEntry = /^[A-Za-z0-9_-]{24}$/.test(previousSpaceEntry?.session || '') &&
    Number.isSafeInteger(previousSpaceEntry.position) && previousSpaceEntry.position >= 0 ? previousSpaceEntry : null;
  const spaceHistoryId = restoredSpaceEntry?.session || idempotencyKey();
  let spaceAddress;
  let restoringAddress = false;
  let approvedBack = false;

  function spaceLocation() {
    const location = document.defaultView?.location;
    return location ? location.pathname + (location.search || '') + (location.hash || '') : '';
  }

  function studioCatalogAddress(workspace) {
    return worksPath() + '?' + new URLSearchParams({workspace, studio:'catalog'});
  }

  function writeSpaceAddress(url, {push = false, fromCatalog = false, catalogView, studioFromCatalog = false, studioFocus} = {}) {
    const history = document.defaultView?.history;
    if (!history?.replaceState || (push && !history.pushState)) return;
    const entry = {
      session: spaceHistoryId, position: (spaceAddress?.entry.position ?? 0) + Number(push),
      fromCatalog, catalogView, studioFromCatalog, studioFocus,
    };
    const state = {...history.state, flybotWorkspaceSpace:entry};
    history[push ? 'pushState' : 'replaceState'](state, '', url);
    spaceAddress = {url, state, entry};
  }

  function recordEditorAddress(selection, item) {
    if (!/^[0-9a-f]{32}$/.test(selection?.workspace || '') || !/^[0-9a-f]{32}$/.test(item?.id || '')) return;
    const target = artifactTargetFromSearch(document.defaultView?.location?.search);
    if (target?.workspace === selection.workspace && target.artifact === item.id) return;
    const fromCatalog = Boolean(selection.catalogView);
    if (fromCatalog) writeSpaceAddress(spaceLocation(), {catalogView:selection.catalogView});
    writeSpaceAddress(worksPath() + '?workspace=' + selection.workspace + '&artifact=' + item.id,
      {push:fromCatalog, fromCatalog:fromCatalog || Boolean(spaceAddress?.entry.fromCatalog)});
    selection.catalogView = null;
  }

  function syncViewUrl() {
    const view = document.defaultView;
    if (!view || !view.history || !view.history.replaceState) return;
    const fragment = /^[0-9a-f]{32}$/.test(workspaceId())
      ? '#workspace=' + encodeURIComponent(workspaceId()) : '';
    const url = catalogKind === 'meetings' ? meetingArchiveHref(workspaceId(), {scope: meetingScope})
      : worksPath() + queryForView(catalogKind, catalogScope) + fragment;
    writeSpaceAddress(url);
  }

  function syncMeetingScope() {
    for (const tab of meetingTabs) {
      const selected = tab.dataset.meetingScope === meetingScope;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    if (catalogKind === 'meetings') {
      resultsPanel?.setAttribute('role', 'tabpanel');
      resultsPanel?.setAttribute('aria-labelledby', 'meeting-scope-' + meetingScope);
    } else {
      resultsPanel?.removeAttribute('role');
      resultsPanel?.removeAttribute('aria-labelledby');
    }
  }

  function applyView(kind, scope, {sync = true} = {}) {
    catalogKind = kind || 'all';
    catalogScope = scope || 'all';
    if (catalogKind === 'meetings') {
      catalogScope = 'all';
      meetingScope = sync ? 'joined' : meetingArchiveLocation(document.defaultView?.location?.hash).scope;
    }
    syncMeetingScope();
    syncDocumentTreeAction();
    catalogToolbar(catalogKind !== 'meetings');
    const searchLabel = catalogKind === 'meetings' ? '搜索会议' : '搜索作品';
    search.placeholder = searchLabel;
    search.setAttribute('aria-label', searchLabel);
    for (const item of document.querySelectorAll('.artifact-kinds [data-kind]')) {
      if (item.getAttribute('data-kind') === catalogKind) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    for (const item of document.querySelectorAll('.artifact-scopes [data-scope]')) {
      if (item.getAttribute('data-scope') === catalogScope) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    if (sync) syncViewUrl();
    renderCatalog();
  }

  function closeFilterPanel({focus = false} = {}) {
    if (!filterPanel || filterPanel.hidden) return;
    filterPanel.hidden = true;
    filterButton?.setAttribute('aria-expanded', 'false');
    if (focus) filterButton?.focus();
  }

  const dateMode = () => document.querySelector('#filter-panel input[name="modified"]:checked')?.value || 'any';
  const appliedFilters = () => filterTypes.length + filterCreators.length + filterSessions.length +
    Number(filterUpdated.since != null || filterUpdated.before != null);

  function renderFilterControls() {
    const count = appliedFilters();
    if (filterButton) filterButton.textContent = count ? `筛选 · ${count}` : '筛选';
    if (filterReset) filterReset.disabled = !count && dateMode() === 'any';
  }

  function readFilterDates() {
    const mode = dateMode();
    const start = dateStart?.value;
    const end = dateEnd?.value;
    const bounds = artifactModifiedBounds(mode, Date.now(), {start, end});
    const invalid = mode === 'custom' && Boolean(start && end && !bounds);
    if (filterDates) filterDates.hidden = mode !== 'custom';
    for (const field of [dateStart, dateEnd]) {
      if (invalid) field?.setAttribute('aria-invalid', 'true');
      else field?.removeAttribute('aria-invalid');
    }
    if (dateMessage) dateMessage.textContent = invalid ? '请选择有效日期，结束日期不能早于开始日期。' :
      bounds ? '包含开始和结束日期。' : '选好开始和结束日期后应用筛选。';
    if (bounds) filterUpdated = bounds;
  }

  function clearFilters() {
    for (const input of document.querySelectorAll('#filter-panel input[type="checkbox"]')) input.checked = false;
    for (const input of document.querySelectorAll('#filter-panel input[name="modified"]')) input.checked = input.value === 'any';
    if (dateStart) dateStart.value = '';
    if (dateEnd) dateEnd.value = '';
    filterTypes = [];
    filterCreators = [];
    filterSessions = [];
    filterUpdated = {};
    readFilterDates();
    renderFilterControls();
  }

  function restoreCatalogFilters({filters}) {
    if (!filters) return;
    search.value = filters.query;
    if (clearSearch) clearSearch.hidden = !search.value;
    filterTypes = filters.types;
    filterCreators = filters.creators;
    filterSessions = filters.sessions;
    for (const input of document.querySelectorAll('#filter-panel input[name="file-type"]')) {
      input.checked = filterTypes.includes(input.value);
    }
    for (const input of document.querySelectorAll('#filter-panel input[name="modified"]')) {
      input.checked = input.value === filters.dateMode;
    }
    if (dateStart) dateStart.value = filters.start;
    if (dateEnd) dateEnd.value = filters.end;
    readFilterDates();
    // Keep the applied range shown before the work opened, including an
    // already-applied range while the user was typing the next date.
    filterUpdated = filters.updated;
    renderFilterControls();
  }

  function refreshFilters(previous) {
    renderFilterControls();
    if (nativeCatalog && catalogQuery() !== previous) return loadList({reuse: true});
    if (!nativeCatalog) renderCatalog({preserve: true});
  }

  function applyFilters({dates = false} = {}) {
    const previous = catalogQuery();
    const selected = name => [...document.querySelectorAll(`#filter-panel input[name="${name}"]:checked`)].map(input => input.value);
    filterTypes = selected('file-type');
    filterCreators = selected('creator');
    filterSessions = selected('session');
    if (dates) readFilterDates();
    return refreshFilters(previous);
  }

  function matchingArtifacts() {
    if (catalog && !sameSelection(catalog)) return [];
    if (nativeCatalog) {
      if (catalogKind === 'meetings') return [];
      return catalogScope === 'favorites' ? allItems.filter(item => item.favorited) : allItems;
    }
    return visibleArtifacts(allItems, {
      kind: catalogKind, scope: catalogScope,
      username: currentUser?.username,
      types: filterTypes, updated: filterUpdated, creators: filterCreators, sessions: filterSessions,
    });
  }

  function renderFacetInputs(box, name, choices, selected) {
    if (!box) return;
    const signature = JSON.stringify(choices);
    if (box.dataset.choiceSignature === signature) {
      for (const label of box.children) {
        const input = label.children[0];
        input.checked = selected.includes(input.value);
      }
      return;
    }
    const focused = document.activeElement?.name === name ? document.activeElement.value : null;
    const nodes = choices.map(({id, label}) => {
      const row = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = name;
      input.value = id;
      input.checked = selected.includes(id);
      row.appendChild(input);
      row.appendChild(document.createTextNode(' ' + label));
      return row;
    });
    box.replaceChildren(...nodes);
    box.dataset.choiceSignature = signature;
    if (focused !== null) {
      nodes.find(row => row.children[0].value === focused)?.children[0].focus();
    }
  }

  function renderFilterChoices() {
    const creatorBox = document.getElementById('filter-creator-list');
    const creatorEmpty = document.getElementById('filter-creator-empty');
    const sessionBox = document.getElementById('filter-session-list');
    const sessionEmpty = document.getElementById('filter-session-empty');
    const currentFacets = facets?.workspace === workspaceId() && facets.account === currentUser ? facets : null;
    const loadedNames = allItems.map(item => item.created_by).filter(Boolean);
    const names = [...new Set([...(currentFacets?.creators || []), ...loadedNames, ...filterCreators])].sort();
    renderFacetInputs(creatorBox, 'creator', names.map(id => ({id, label: id})), filterCreators);
    if (creatorEmpty) creatorEmpty.hidden = names.length > 0;
    const sessions = currentFacets?.sessions?.slice() ?? sessionFilterChoices(allItems);
    for (const id of filterSessions) {
      if (!sessions.some(session => session.id === id)) sessions.push({id, label: '对话'});
    }
    renderFacetInputs(sessionBox, 'session', sessions, filterSessions);
    if (sessionEmpty) sessionEmpty.hidden = sessions.length > 0;
  }

  async function loadFacets() {
    const workspace = workspaceId();
    if (!nativeCatalog || !workspace || !currentUser ||
        (facets?.workspace === workspace && facets.account === currentUser)) return;
    const pending = {workspace, account: currentUser};
    facets = pending;
    const result = await request('GET', `/v1/workspaces/${workspace}/artifacts?facets=1`).catch(() => null);
    if (facets !== pending || workspace !== workspaceId() || pending.account !== currentUser) return;
    if (result?.status !== 200) {
      facets = null;
      return;
    }
    pending.creators = Array.isArray(result.body.creators) ? result.body.creators : [];
    pending.sessions = Array.isArray(result.body.sessions) ? result.body.sessions : [];
    renderFilterChoices();
  }

  function resetMeetings() {
    meetingRequest += 1;
    meetingLoadedFor = '';
    meetingItems = [];
    meetingCursors = {meeting:'', shared:''};
    meetingVersion = undefined;
    meetingDepth = 0;
    meetingError = '';
    meetingLoading = false;
    meetingRetryLimit = 0;
    focusedMeeting = '';
  }

  function moreMeetings() {
    return Boolean(meetingCursors.meeting || meetingCursors.shared);
  }

  async function loadMeetings({append = false, limit = 24} = {}) {
    const id = workspaceId(), account = currentUser;
    if (!id || (append ? !moreMeetings() || meetingLoading : meetingLoadedFor === id)) return;
    const seq = ++meetingRequest;
    if (!append) {
      meetingItems = [];
      meetingCursors = {meeting:'', shared:''};
      meetingDepth = 0;
      meetingVersion = undefined;
    }
    meetingError = '';
    meetingLoadedFor = id;
    meetingLoading = true;
    renderCatalog();
    const base = `/v1/workspaces/${id}/meetings`;
    const read = kind => {
      const cursor = meetingCursors[kind];
      if (append && !cursor) return null;
      const query = new URLSearchParams({limit: nativeCatalog ? limit : 100});
      if (kind === 'meeting' && nativeCatalog) query.set('order', 'recent');
      if (cursor) query.set('cursor', cursor);
      return request('GET', base + (kind === 'shared' ? '/shared?' : '?') + query)
        .catch(() => ({status: 0, body: {}}));
    };
    const [listed, shared] = await Promise.all([read('meeting'), nativeCatalog ? read('shared') : null]);
    if (seq !== meetingRequest || workspaceId() !== id || currentUser !== account) return;
    meetingLoading = false;
    const results = [['meeting', listed], ['shared', shared]].filter(([, result]) => result);
    for (const [kind, result] of results) {
      if (result.status !== 200 || !Array.isArray(result.body?.items)) {
        meetingError ||= messageFor(result.body?.error, kind === 'shared' ? '无法读取共享纪要，请重试。' : '无法读取会议纪要，请重试。');
      }
    }
    meetingRetryLimit = 0;
    if (append && meetingError) {
      meetingRetryLimit = limit;
      if (catalogKind === 'meetings') renderCatalog();
      return;
    }
    const version = listed?.body?.activity_version;
    if (append && listed?.status === 200 && meetingVersion !== undefined && version !== undefined && version !== meetingVersion) {
      meetingLoadedFor = '';
      return loadMeetings({limit: Math.min(100, meetingDepth + limit)});
    }
    if (listed?.status === 200) meetingVersion = version;
    for (const [kind, result] of results) {
      if (result.status !== 200 || !Array.isArray(result.body?.items)) continue;
      const keys = new Set(meetingItems.filter(item => Boolean(item.shared) === (kind === 'shared')).map(item => item.id));
      for (const item of result.body.items) {
        if (!item?.id || (nativeCatalog && !CATALOG_CURSOR.test(item.id)) || keys.has(item.id)) continue;
        meetingItems.push({...item, shared: kind === 'shared'});
        keys.add(item.id);
      }
      const cursor = result.body.cursor;
      meetingCursors[kind] = nativeCatalog && CATALOG_CURSOR.test(cursor || '') && cursor !== meetingCursors[kind] ? cursor : '';
    }
    if (meetingError) meetingLoadedFor = '';
    if (!meetingError) meetingDepth += limit;
    if (catalogKind === 'meetings') {
      renderCatalog();
      return expandMeetingSearch();
    }
  }

  function expandMeetingSearch() {
    const remaining = MEETING_SEARCH_WINDOW - meetingDepth;
    if (!nativeCatalog || !search.value.trim() || !moreMeetings() || remaining <= 0 || meetingError || meetingLoading) return;
    return loadMeetings({append:true, limit:remaining});
  }

  async function openMeetingArchive() {
    const view = document.defaultView;
    const account = currentUser, workspace = workspaceId();
    const {focus} = meetingArchiveLocation(view?.location?.hash);
    const context = {owner:account?.id, workspace, scope:meetingScope, focus};
    const depth = meetingArchiveDepth(view, context);
    await loadMeetings({limit:Math.max(24, Math.min(100, depth))});
    if (!focus || focusedMeeting === focus) return;
    const current = () => catalogKind === 'meetings' && currentUser === account && workspaceId() === workspace &&
      meetingScope === context.scope && meetingArchiveLocation(view?.location?.hash).focus === focus;
    const find = () => document.querySelector(`#artifact-list [data-meeting-key="${focus}"]`);
    while (current() && !find() && !meetingError && !meetingLoading && moreMeetings() && meetingDepth < depth) {
      await loadMeetings({append:true, limit:Math.min(100, depth - meetingDepth)});
    }
    if (current() && find()) {
      focusedMeeting = focus;
      find().focus();
    }
  }

  function renderMeetings() {
    const list = document.getElementById('artifact-list');
    const empty = document.getElementById('list-empty');
    const emptyMeetings = document.getElementById('empty-meetings');
    const errorBox = document.getElementById('meetings-error');
    const needle = search.value.trim().toLocaleLowerCase();
    const matches = meetingItems.filter(item => [item.title, item.organizer, ...(item.attendees || [])]
      .some(value => String(value || '').toLocaleLowerCase().includes(needle)));
    const rows = meetingRows(meetingsForScope(matches, {
      scope: meetingScope,
      username: currentUser && currentUser.username,
      userId: currentUser && currentUser.id,
    }));
    const caption = document.getElementById('meetings-caption');
    if (caption) {
      caption.textContent = meetingScope === 'joined'
        ? '你参与、创建或收到的会议纪要，最新的在前。'
        : '这个工作区的会议纪要，最新的在前。';
    }
    list.textContent = '';
    if (errorBox) {
      errorBox.hidden = !meetingError;
      errorBox.textContent = meetingError;
    }
    const emptyKind = document.getElementById('empty-kind');
    if (emptyKind) emptyKind.hidden = true;
    const waiting = document.getElementById('meetings-loading');
    if (waiting) waiting.hidden = !meetingLoading;
    const noMatch = document.getElementById('meetings-no-match');
    const filtered = Boolean(needle) || (meetingScope === 'joined' && meetingItems.length > 0);
    if (noMatch) noMatch.hidden = !filtered || Boolean(meetingError) || meetingLoading || rows.length > 0;
    if (noMatch) noMatch.textContent = moreMeetings() ? '已加载的会议里暂无符合条件的记录。' : '没有符合当前条件的会议。';
    const showAll = document.getElementById('meetings-show-all');
    if (showAll) showAll.hidden = !noMatch || noMatch.hidden || meetingScope !== 'joined' || Boolean(needle);
    if (emptyMeetings) emptyMeetings.hidden = filtered || Boolean(meetingError) || rows.length > 0 || meetingLoading || !workspaceId();
    if (empty) empty.hidden = !meetingError && rows.length > 0;
    const retry = document.getElementById('retry-meetings');
    if (retry) retry.hidden = !meetingError;
    const more = document.getElementById('more-shared-meetings');
    if (more) {
      more.hidden = !moreMeetings();
      more.disabled = meetingLoading || Boolean(meetingError);
      more.textContent = meetingLoading ? '正在加载…' : '加载更多会议';
    }
    const create = document.getElementById('new-meeting-in-space');
    if (create) {
      create.hidden = !workspaceId();
      create.href = '/meetings#' + new URLSearchParams({workspace: workspaceId(), new: '1'});
    }
    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'meeting-item';
      item.dataset.kind = 'meetings';
      const link = document.createElement('a');
      const kind = row.shared ? 'shared' : 'meeting';
      const focus = kind + ':' + row.id;
      link.dataset.meetingKey = focus;
      const params = new URLSearchParams({workspace: workspaceId(), [kind]: row.id});
      if (nativeCatalog) params.set('library', meetingScope);
      link.href = '/meetings#' + params;
      link.addEventListener('click', event => {
        if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const workspace = workspaceId();
        const context = {scope:meetingScope, focus};
        saveMeetingArchive(document.defaultView, {
          owner:currentUser?.id, workspace, ...context, depth:meetingDepth,
        });
        writeSpaceAddress(meetingArchiveHref(workspace, context));
      });
      const title = document.createElement('span');
      title.className = 'meeting-title';
      title.append(document.createTextNode(row.title));
      if (row.shared) {
        item.dataset.meetingShared = 'true';
        const badge = document.createElement('span');
        badge.className = 'meeting-share-badge';
        badge.textContent = '共享纪要';
        title.append(badge);
      }
      const when = document.createElement('span');
      when.className = 'note';
      when.textContent = meetingTimeLabel(row.started_at);
      const actions = document.createElement('span');
      actions.className = 'note meeting-actions';
      actions.textContent = [row.shared && row.organizer ? row.organizer + ' 分享' : '', row.actionLabel].filter(Boolean).join(' · ');
      link.append(title, when, actions);
      item.appendChild(link);
      list.appendChild(item);
    }
    return rows;
  }

  function renderCatalog({preserve = false} = {}) {
    const items = matchingArtifacts();
    if (clearSearch) clearSearch.hidden = !search.value;
    const busy = catalogKind === 'meetings' ? meetingLoading
      : searchTimer !== null || (sameSelection(catalog) && catalog.state === 'loading' && !catalog.background);
    document.getElementById('artifact-list').setAttribute('aria-busy', String(Boolean(busy)));
    renderPageFooter(items.length);
    renderDraftResume();
    if (catalogKind === 'meetings') renderMeetings();
    else {
      renderList(items, {preserve});
      const meetingsErrorBox = document.getElementById('meetings-error');
      if (meetingsErrorBox) meetingsErrorBox.hidden = true;
      const moreMeetings = document.getElementById('more-shared-meetings');
      if (moreMeetings) moreMeetings.hidden = true;
    }
    // The meetings list owns its own empty and error rows; the artifact empty states stay out of it.
    if (catalogKind === 'meetings') {
      if (mainPanel) mainPanel.classList.toggle('is-meetings', true);
      const chrome = document.getElementById('meetings-chrome');
      if (chrome) chrome.hidden = false;
      return;
    }
    const empty = document.getElementById('list-empty');
    const emptyAll = document.getElementById('empty-all');
    const emptyStarred = document.getElementById('empty-starred');
    const emptyMemory = document.getElementById('empty-memory');
    const emptyAutomation = document.getElementById('empty-automation');
    const emptyKind = document.getElementById('empty-kind');
    const emptyMatches = document.getElementById('empty-no-match');
    const emptyMeetings = document.getElementById('empty-meetings');
    const emptyMessage = document.getElementById('list-empty-message');
    const newWebsite = document.getElementById('new-website');
    const meetingsChrome = document.getElementById('meetings-chrome');
    if (mainPanel) mainPanel.classList.toggle('is-meetings', catalogKind === 'meetings');
    if (meetingsChrome) meetingsChrome.hidden = catalogKind !== 'meetings';
    if (!empty) return;
    const isEmpty = items.length === 0 && searchTimer === null &&
      (!catalog || (sameSelection(catalog) && catalog.state === 'ready' && !catalog.cursor));
    empty.hidden = !isEmpty;
    if (!isEmpty) return;
    const noWorkspace = emptyMessage && emptyMessage.textContent === '还没有工作区。';
    const noMatches = !noWorkspace && Boolean(search.value.trim() || appliedFilters());
    const showMeetings = catalogKind === 'meetings' && !noWorkspace;
    const showStarred = catalogScope === 'favorites' && !showMeetings && !noWorkspace && !noMatches;
    const showMemory = catalogScope === 'memory' && !showMeetings && !noWorkspace && !noMatches;
    const showAutomation = catalogScope === 'automation' && catalogKind === 'all' && !noWorkspace && !noMatches;
    const showAllEmpty = (catalogKind === 'all' && (catalogScope === 'all' || catalogScope === 'mine')
      && !showStarred && !showMemory && !noWorkspace && !noMatches);
    if (emptyAll) emptyAll.hidden = !showAllEmpty;
    if (emptyStarred) emptyStarred.hidden = !showStarred;
    if (emptyMemory) emptyMemory.hidden = !showMemory;
    if (emptyAutomation) emptyAutomation.hidden = !showAutomation;
    if (emptyMeetings) emptyMeetings.hidden = !showMeetings;
    if (emptyMatches) emptyMatches.hidden = !noMatches;
    if (resetArtifactSearch && noMatches) {
      resetArtifactSearch.textContent = search.value.trim()
        ? appliedFilters() ? '清除搜索和筛选' : '清除搜索'
        : '清除筛选';
    }
    if (emptyKind) emptyKind.hidden = showAllEmpty || showStarred || showMemory || showAutomation || showMeetings || noWorkspace || noMatches;
    if (emptyMessage) emptyMessage.hidden = !noWorkspace;
    if (newWebsite) newWebsite.hidden = !(emptyKind && !emptyKind.hidden && catalogKind === 'website');
    if (emptyKind && !emptyKind.hidden) {
      const note = document.getElementById('empty-kind-note');
      if (note) {
        if (catalogKind === 'messages') note.textContent = '还没有从对话保存到作品库的消息。';
        else if (catalogScope === 'mine') note.textContent = '还没有你创建的作品。';
        else note.textContent = '这一类还没有作品。';
      }
    }
  }

  const sendDialog = document.getElementById('send-to-chat-dialog');
  const sendList = document.getElementById('send-to-chat-list');
  const sendEmpty = document.getElementById('send-to-chat-empty');
  const sendError = document.getElementById('send-to-chat-error');
  const sendLead = document.getElementById('send-to-chat-lead');
  const sendConfirm = document.getElementById('send-to-chat-confirm');
  const sendCancel = document.getElementById('send-to-chat-cancel');
  const sendNew = document.getElementById('send-to-chat-new');
  const sendAgent = document.getElementById('send-to-chat-agent');
  const sendNote = document.getElementById('send-to-chat-note');
  let sendingArtifact = null;
  let artifactSendOrigin = null;

  async function revealSlideContext(origin) {
    if (!slideContext || !slideContextOption || !slideContextTitle || !slideDraftSubmit) return;
    const {wid, conversation, item} = origin;
    const path = `/v1/workspaces/${wid}/social/conversations/${encodeURIComponent(conversation)}`;
    slideDraftSubmit.disabled = true;
    slideContextTitle.textContent = '正在确认原会话…';
    slideContextTitle.hidden = false;
    const data = await request('GET', path, undefined, undefined, AbortSignal.timeout(5000)).catch(() => null);
    if (artifactSendOrigin !== origin || current !== item || workspaceId() !== wid || form.hidden) return;
    slideDraftSubmit.disabled = false;
    const source = data?.body.conversation;
    if (data?.status !== 200 || source?.id !== conversation || source.public_agent || source.direct?.open === false) {
      slideContextTitle.textContent = '无法读取原会话。仍可根据主题或素材起草。';
      return;
    }
    origin.allowed = true;
    slideContext.checked = true;
    slideContextOption.hidden = false;
    slideContextTitle.textContent = '会话：' + conversationLabel(source);
  }

  function sendStatus(message = '') {
    if (!sendError) return;
    sendError.textContent = message;
    sendError.hidden = !message;
  }

  const sendCurrent = state => sendingArtifact === state && workspaceId() === state.wid && currentUser?.id === state.owner;

  function closeSendDialog({force = false, restoreFocus = true} = {}) {
    if (!sendDialog || (!force && sendingArtifact?.pending)) return;
    const trigger = sendingArtifact?.trigger;
    sendDialog.hidden = true;
    sendingArtifact = null;
    if (restoreFocus && trigger?.isConnected) trigger.focus({preventScroll: true});
  }

  function chooseSendDestination(state, destination, button) {
    if (!sendCurrent(state) || state.pending) return;
    state.destination = destination;
    for (const option of sendList.querySelectorAll('button')) option.setAttribute('aria-pressed', String(option === button));
    if (button) sendAgent.value = '';
    sendConfirm.disabled = !destination;
    sendLead.textContent = state.lead + (destination?.source === 'agent' ? '智能体会读取这份附件。' : '');
    sendStatus();
  }

  sendAgent?.addEventListener('change', () => {
    const state = sendingArtifact;
    if (!state) return;
    const agent = state.agents?.get(sendAgent.value);
    chooseSendDestination(state, agent ? {source:'agent', agent_id:agent.id, label:agent.name} : null);
  });

  async function openSendDialog(item, trigger) {
    if (!sendDialog || !workspaceId() || !canSendArtifactToChat(item)) return;
    const wid = workspaceId();
    const state = {item:{...item}, owner:currentUser?.id, wid, trigger, destination:null,
      pending:false, keys:new Map(), threads:new Map()};
    sendingArtifact = state;
    sendDialog.hidden = false;
    sendConfirm.textContent = '确认发送';
    sendConfirm.disabled = true;
    sendNote.value = '';
    sendNote.disabled = false;
    sendNew.hidden = true;
    sendNew.open = false;
    sendAgent.disabled = false;
    sendAgent.replaceChildren();
    if (sendCancel) sendCancel.disabled = false;
    const formats = {document:'Word 文档', website:'网页源码（文本）', whiteboard:'白板数据（JSON）',
      slides:'PowerPoint 文件', dashboard:'Excel 文件', spreadsheet:'Excel 工作簿', media:'媒体文件'};
    state.lead = `「${item.title}」版本 ${item.revision} 将作为${formats[item.kind]}发送。`;
    sendLead.textContent = state.lead + '请选择接收会话。';
    sendStatus();
    sendList.replaceChildren();
    sendEmpty.hidden = false;
    sendEmpty.textContent = '正在读取会话…';
    sendCancel?.focus();
    const native = servedByDsBot(document);
    const base = `/v1/workspaces/${wid}`;
    const get = suffix => request('GET', base + suffix).catch(() => ({status: 0, body: {}}));
    const [social, directory] = await Promise.all([
      get('/social/conversations?limit=100'),
      native ? get('/agents?limit=100&include=conversations') : null,
    ]);
    if (!sendCurrent(state)) return;
    const socialItems = social.status === 200 ? (social.body.items || [])
      .filter(row => !row.public_agent && row.direct?.open !== false)
      .map(row => ({...row, source: 'social', label: conversationLabel(row)})) : [];
    const privateItems = directory?.status === 200 ? agentConversations(directory.body) : [];
    const items = [...socialItems, ...privateItems].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    state.agents = new Map((directory?.status === 200 ? directory.body.items || [] : [])
      .filter(agent => /^[a-f0-9]{32}$/.test(agent.id) && !agent.archived && !agent.native_deleted)
      .map(agent => [agent.id, agent]));
    if (state.agents.size) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '请选择智能体';
      sendAgent.append(placeholder);
      for (const agent of state.agents.values()) {
        const option = document.createElement('option');
        option.value = agent.id;
        option.textContent = agent.name;
        sendAgent.append(option);
      }
      sendAgent.value = '';
      sendNew.hidden = false;
      sendNew.open = !items.length;
      if (sendNew.open && document.activeElement === sendCancel) sendAgent.focus({preventScroll:true});
    }
    const incomplete = social.status !== 200 || (native && (directory?.status !== 200 || !Array.isArray(directory.body.conversations)));
    if (artifactSendOrigin?.wid === wid && artifactSendOrigin.item.id === item.id) {
      state.destination = socialItems.find(conversation => conversation.id === artifactSendOrigin.conversation) || null;
      sendConfirm.disabled = !state.destination;
    }
    sendEmpty.hidden = items.length > 0 || state.agents.size > 0;
    sendEmpty.textContent = incomplete ? '无法读取可发送的会话，请稍后重试。' : '这个工作区还没有可发送的会话。';
    if (items.length && incomplete) sendStatus('部分会话无法加载。');
    for (const conversation of items) {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.chatSource = conversation.source;
      button.textContent = conversation.source === 'agent' ? '智能体 · ' + conversation.label : conversation.label;
      button.setAttribute('aria-pressed', String(state.destination === conversation));
      button.addEventListener('click', () => chooseSendDestination(state, conversation, button));
      row.append(button);
      sendList.append(row);
    }
  }

  sendConfirm?.addEventListener('click', async () => {
    const state = sendingArtifact;
    if (!state?.destination || state.pending || !sendCurrent(state)) return;
    const {wid, item, destination, keys} = state;
    const isAgent = destination.source === 'agent';
    const collection = isAgent ? `agents/${destination.agent_id}/conversations` : 'social/conversations';
    const base = `/v1/workspaces/${wid}/${collection}`;
    const note = sendNote.value.trim();
    if (note.length > 2000) { sendStatus('附言不能超过 2000 个字符。'); return; }
    const requestKey = fingerprint => {
      if (!keys.has(fingerprint)) keys.set(fingerprint, idempotencyKey());
      return keys.get(fingerprint);
    };
    state.pending = true;
    sendConfirm.disabled = true;
    sendConfirm.textContent = '正在发送…';
    sendAgent.disabled = sendNote.disabled = true;
    if (sendCancel) sendCancel.disabled = true;
    sendStatus();
    try {
      let conversationId = destination.id || state.threads.get(base);
      if (isAgent && !conversationId) {
        const opened = await request('POST', base, {title:[...item.title].slice(0, 40).join('')},
          {'Idempotency-Key':requestKey('new:' + base)});
        if (!sendCurrent(state)) return;
        const thread = opened.body.conversation;
        if (![200, 201].includes(opened.status) || !/^[a-f0-9]{32}$/.test(thread?.id || '') ||
            thread.workspace_id !== wid || thread.agent_id !== destination.agent_id) {
          sendStatus(messageFor(opened.body.error, '无法创建智能体对话，请重试。'));
          return;
        }
        conversationId = thread.id;
        state.threads.set(base, conversationId);
      }
      const path = `${base}/${conversationId}/messages`;
      const result = await request('POST', path, {artifact_id:item.id, artifact_revision:item.revision, ...(note ? {body:note} : {})},
        {'Idempotency-Key':requestKey(JSON.stringify([path,note]))});
      if (!sendCurrent(state)) return;
      const accepted = isAgent ? [201, 202].includes(result.status) && result.body?.message?.id
        : [200, 201].includes(result.status);
      if (!accepted) {
        sendStatus(messageFor(result.body.error, '发送失败，请重试。'));
        return;
      }
      state.pending = false;
      closeSendDialog({restoreFocus:false});
      show('ok', '已发送到「' + destination.label + '」。');
      const receipt = document.createElement('a');
      receipt.className = 'send-chat-receipt';
      receipt.href = conversationChatHref(wid, {...destination,id:conversationId,message_id:result.body.message?.id});
      receipt.textContent = '在聊天中查看';
      status.append(receipt);
      receipt.focus({preventScroll:true});
    } catch {
      if (sendCurrent(state)) sendStatus('未能确认发送结果，请保留当前附言和接收会话重试。');
    } finally {
      state.pending = false;
      if (sendingArtifact === state || !sendingArtifact) {
        sendConfirm.textContent = '确认发送';
        sendConfirm.disabled = !sendingArtifact?.destination;
        sendAgent.disabled = sendNote.disabled = false;
        if (sendCancel) sendCancel.disabled = false;
      }
    }
  });

  sendCancel?.addEventListener('click', () => closeSendDialog());
  sendDialog?.addEventListener('click', event => {
    if (event.target === sendDialog) closeSendDialog();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !sendDialog?.hidden) closeSendDialog();
  });

  function itemMenuOpen() {
    return actionMenus.activeButton?.classList.contains('artifact-more');
  }
  function closeItemMenu() {
    if (itemMenuOpen()) actionMenus.close();
  }

  async function renameFromCatalog(item, trigger, inScope) {
    closeItemMenu();
    const scope = () => canCreateInWorkspace() ? {owner:currentUser.id,workspace:workspaceId()} : null;
    try {
      artifactRenameModule ??= import('./rename.mjs');
      const {mountArtifactRename} = await artifactRenameModule;
      if (!inScope() || listPanel.hidden || !scope()) return;
      artifactRename ??= mountArtifactRename(document, {
        scope,
        request: (method, path, data, signal) => request(method,path,data,undefined,signal),
        updated(saved) {
          allItems = allItems.map(row => row.id === saved.id && row.revision < saved.revision
            ? {...row,title:saved.title,revision:saved.revision,updated:saved.updated,updated_by:saved.updated_by,
              match:row.match?.kind === 'title' ? null : row.match}
            : row);
          renderCatalog({preserve:true});
          show('ok', '已更新作品名称。');
          void loadList({background:true});
        },
      });
      artifactRename.open(item,trigger.id);
    } catch {
      artifactRenameModule = null;
      if (inScope()) show('error', '暂时无法打开重命名窗口，请重试。');
    }
  }

  function canDuplicate(item) {
    return nativeCatalog && typeof duplicateDialog?.showModal === 'function' && /^[0-9a-f]{32}$/.test(item?.id || '') &&
      Number.isSafeInteger(item.revision) && item.revision > 0;
  }

  function setDuplicateStatus(text, kind = '') {
    duplicateStatus.hidden = !text;
    duplicateStatus.dataset.kind = kind;
    duplicateStatus.textContent = text;
  }

  function closeDuplicateDialog({focus = false} = {}) {
    const previous = duplicateState;
    duplicateState = null;
    if (duplicateDialog?.open) duplicateDialog.close();
    if (focus && previous?.trigger?.isConnected) previous.trigger.focus();
  }

  function suggestedDuplicateTitle(title) {
    const used = new Set(allItems.map(item => item.title.toLocaleLowerCase('en-US')));
    const stem = title.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    for (let index = 1; ; index += 1) {
      const suffix = index === 1 ? ' · 副本' : ' · 副本 ' + index;
      const candidate = stem.slice(0,80 - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix;
      if (!used.has(candidate.toLocaleLowerCase('en-US'))) return candidate;
    }
  }

  function openDuplicateDialog(item, trigger) {
    if (!currentUser || !workspaceId() || !canDuplicate(item) || duplicateDialog.open) return;
    duplicateState = {source:item, account:currentUser, workspace:workspaceId(), trigger, keys:new Map()};
    duplicateSource.textContent = `「${item.title}」的修订 ${item.revision}`;
    duplicateTitle.value = suggestedDuplicateTitle(item.title);
    duplicateTitle.disabled = duplicateSubmit.disabled = duplicateCancel.disabled = false;
    duplicateSubmit.textContent = '创建副本';
    duplicateCancel.textContent = '取消';
    setDuplicateStatus('');
    duplicateDialog.showModal();
    duplicateTitle.focus();
    duplicateTitle.select();
  }

  duplicateDialog?.addEventListener('cancel', event => {
    event.preventDefault();
    if (!duplicateState?.pending) closeDuplicateDialog({focus:true});
  });
  duplicateCancel?.addEventListener('click', () => closeDuplicateDialog({focus:true}));
  duplicateForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const state = duplicateState;
    if (!state || state.pending) return;
    const {source,workspace,account} = state;
    if (workspace !== workspaceId() || account !== currentUser) return;
    const openCopy = () => openEditor(state.created,{workspace,saved:true,notice:{kind:'ok',text:'已创建副本。'}});
    if (state.created) { await openCopy(); return; }
    const title = duplicateTitle.value.trim();
    if (!title) { setDuplicateStatus('请输入新作品名称。','error'); duplicateTitle.focus(); return; }
    let key = state.keys.get(title);
    if (!key) { key = idempotencyKey(); state.keys.set(title,key); }
    state.pending = true;
    duplicateTitle.disabled = duplicateSubmit.disabled = duplicateCancel.disabled = true;
    duplicateSubmit.textContent = '正在创建…';
    setDuplicateStatus('');
    const result = await request('POST',`/v1/workspaces/${workspace}/artifacts`,
      {title,duplicate_from:{artifact_id:source.id,revision:source.revision}}, {'Idempotency-Key':key},
      AbortSignal.timeout(12000)).catch(() => ({status:0,body:{}}));
    if (duplicateState !== state || currentUser !== account || workspaceId() !== workspace) return;
    state.pending = false;
    const copied = result.body.artifact;
    if (![200,201].includes(result.status) || !canDuplicate(copied) || copied.workspace_id !== workspace || copied.id === source.id) {
      duplicateTitle.disabled = duplicateSubmit.disabled = duplicateCancel.disabled = false;
      duplicateSubmit.textContent = result.status === 0 || result.status >= 500 ? '重试' : '创建副本';
      setDuplicateStatus(messageFor(result.body.error,'暂时无法确认副本是否创建成功，可以重试。'),'error');
      if (result.body.error?.code === 'title_conflict') { duplicateTitle.focus(); duplicateTitle.select(); }
      return;
    }
    state.created = copied;
    catalog = null;
    facets = null;
    duplicateSubmit.disabled = duplicateCancel.disabled = false;
    duplicateSubmit.textContent = '打开副本';
    duplicateCancel.textContent = '返回原作品';
    setDuplicateStatus('副本已创建，你可以继续编辑原作品。','ok');
    if (!editor?.saving && !hasEditorDraft()) await openCopy();
    else duplicateSubmit.focus();
  });

  function itemMenu(item, onOpen, inScope, path, origin) {
    const wrap = document.createElement('span');
    wrap.className = 'artifact-more-wrap';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'artifact-more';
    button.id = 'artifact-more-' + item.id;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', item.title + '：更多操作');
    button.textContent = '⋯';
    const menu = document.createElement('div');
    menu.className = 'artifact-item-menu';
    menu.id = 'artifact-item-actions-' + item.id;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-labelledby', button.id);
    button.setAttribute('aria-controls', menu.id);
    menu.hidden = true;
    const send = document.createElement('button');
    send.type = 'button';
    send.setAttribute('role', 'menuitem');
    send.className = 'artifact-menu-send';
    send.textContent = '发送到聊天';
    if (canSendArtifactToChat(item)) {
      send.disabled = false;
      send.title = '把此作品的保存版本发到会话';
      send.addEventListener('click', () => {
        if (inScope()) void openSendDialog(item, button);
      });
    } else {
      send.disabled = true;
      send.title = '请先保存作品再发送';
    }
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.setAttribute('role', 'menuitem');
    rename.textContent = '重命名';
    rename.addEventListener('click', async () => {
      if (nativeCatalog && /^[0-9a-f]{32}$/.test(item.id || '') &&
          Number.isSafeInteger(item.revision) && item.revision > 0) {
        if (inScope()) await renameFromCatalog(item, button, inScope);
        return;
      }
      if (await onOpen(item)) {
        const title = form.elements.title;
        title?.focus();
        title?.select();
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('role', 'menuitem');
    remove.className = 'artifact-menu-danger';
    remove.textContent = '删除';
    remove.addEventListener('click', async () => {
      if (!inScope() || !item.id) return;
      if (typeof globalThis.confirm === 'function' && !globalThis.confirm('删除「' + item.title + '」？')) return;
      const result = await request('POST', path + '/remove', {}).catch(() => ({status: 0, body: {}}));
      if (!inScope()) return;
      if (result.status !== 200) {
        show('error', messageFor(result.body.error, '删除失败。'));
        return;
      }
      show('ok', '已删除。');
      const keepFocus = document.activeElement === button;
      await loadList();
      if (keepFocus && document.activeElement === document.body) newMenuButton?.focus({preventScroll: true});
    });
    menu.append(send);
    if (origin?.href) {
      const link = document.createElement('a');
      link.setAttribute('role', 'menuitem');
      link.className = 'artifact-menu-origin';
      link.href = origin.href;
      link.textContent = origin.label;
      link.addEventListener('click', event => {
        if (!inScope()) event.preventDefault();
      });
      menu.append(link);
    }
    menu.append(rename);
    if (canDuplicate(item)) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.setAttribute('role', 'menuitem');
      copy.textContent = '复制为新作品';
      copy.addEventListener('click', () => {
        if (inScope()) openDuplicateDialog(item,button);
      });
      menu.append(copy);
    }
    menu.append(remove);
    actionMenus.bind(button, menu, {
      onOpen() {
        document.body.appendChild(menu);
        const anchor = button.getBoundingClientRect();
        const viewport = document.defaultView;
        const height = viewport?.visualViewport?.height || viewport?.innerHeight || 800;
        const width = viewport?.visualViewport?.width || viewport?.innerWidth || 400;
        const top = anchor.bottom + menu.offsetHeight + 8 > height ? anchor.top - menu.offsetHeight - 4 : anchor.bottom + 4;
        menu.style.top = Math.max(8, Math.min(height - menu.offsetHeight - 8, top)) + 'px';
        menu.style.left = Math.max(8, Math.min(width - menu.offsetWidth - 8, anchor.right - menu.offsetWidth)) + 'px';
      },
      onClose: () => menu.remove(),
    });
    wrap.append(button);
    return wrap;
  }

  const renderedArtifactRows = new WeakMap();

  function renderList(items, {preserve = false} = {}) {
    const workspace = workspaceId();
    const account = currentUser;
    const inScope = () => !!account && currentUser === account && workspaceId() === workspace;
    const onOpen = (item, findText) => inScope() && openEditor(item, {workspace, findText});
    const list = document.getElementById('artifact-list');
    const empty = document.getElementById('list-empty');
    const previousRows = preserve ? [...list.children] : [];
    const byId = new Map(previousRows.filter(row => row.dataset.artifactId).map(row => [row.dataset.artifactId, row]));
    const scroller = preserve ? [list.closest?.('.artifact-main'), listPanel, main].find(node => Number(node?.scrollTop) > 0) : null;
    const active = preserve ? document.activeElement : null;
    const focusedRow = active?.closest?.('.artifact-item');
    const viewport = scroller?.getBoundingClientRect();
    const focusedBounds = viewport && focusedRow?.getBoundingClientRect();
    const anchor = !viewport ? null
      : focusedBounds && focusedBounds.bottom > viewport.top && focusedBounds.top < viewport.bottom
        ? focusedRow
        : previousRows.find(row => row.dataset.artifactId && row.getBoundingClientRect().bottom > viewport.top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const focusSelector = active?.matches?.('.artifact-bookmark') ? '.artifact-bookmark'
      : active?.matches?.('.link') ? '.link' : '.artifact-more';
    if (!preserve) {
      list.textContent = '';
      closeItemMenu();
    }
    applyArtifactLayout(list, catalogLayout);
    if (empty) empty.hidden = items.length > 0;
    const nextRows = [];
    if (items.length) {
      let head = previousRows.find(row => row.classList.contains('artifact-list-head'));
      if (!head) {
        head = document.createElement('li');
        head.className = 'artifact-list-head';
        head.setAttribute('aria-hidden', 'true');
        for (const label of ['标题', '来源', '创建时间', '最近动态', '操作']) {
          const cell = document.createElement('span');
          cell.textContent = label;
          head.append(cell);
        }
      }
      nextRows.push(head);
    }
    for (const item of items) {
      const prior = byId.get(item.id);
      const rendered = prior && renderedArtifactRows.get(prior);
      if (rendered === item) {
        nextRows.push(prior);
        continue;
      }
      const path = `/v1/workspaces/${workspace}/artifacts/${item.id}`;
      const row = document.createElement('li');
      row.className = 'artifact-item';
      row.dataset.artifactId = item.id;
      row.dataset.kind = item.kind || '';
      renderedArtifactRows.set(row, item);
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'link';
      const match = search.value.trim() ? artifactSearchMatch(item) : null;
      const titleMatch = match?.kind === 'title' && match.text === item.title && match.start < 16;
      if (titleMatch) appendArtifactHighlight(document, open, match);
      else open.textContent = item.title;
      open.addEventListener('click', () => onOpen(item,
        item.kind === 'document' && match?.kind === 'body' ? match.text.slice(match.start, match.end) : ''));
      const meta = document.createElement('span');
      meta.className = 'note';
      const origin = artifactOrigin(item, workspace);
      meta.textContent = [kindLabel(item.kind, item.media?.mime), item.created_by, origin?.kind].filter(Boolean).join(' · ');
      row.appendChild(open);
      row.appendChild(meta);
      if (match && !titleMatch) {
        const context = document.createElement('span');
        context.className = 'artifact-search-context';
        const label = document.createElement('span');
        label.className = 'artifact-search-context-label';
        label.textContent = {title: '标题 · ', body: '正文 · ', filename: '文件名 · '}[match.kind];
        context.appendChild(label);
        appendArtifactHighlight(document, context, match, true);
        row.dataset.searchContext = 'true';
        row.appendChild(context);
      }
      const cover = document.createElement('span');
      cover.className = 'artifact-cover';
      cover.setAttribute('aria-hidden', 'true');
      cover.addEventListener('click', () => {
        // The title remains the single keyboard target for opening this work.
        open.focus({preventScroll: true});
        open.click();
      });
      const mime = item.media && item.media.mime ? String(item.media.mime) : '';
      const thumb = item.preview ? renderThumb(document, item.preview) : null;
      if (thumb) {
        cover.classList.add('has-thumb');
        cover.append(thumb);
      } else if (item.kind === 'media' && /^image\//.test(mime) && item.id && workspace) {
        const img = document.createElement('img');
        img.className = 'artifact-cover-img';
        img.alt = '';
        img.loading = 'lazy';
        img.src = path + '/file';
        cover.classList.add('has-thumb');
        cover.append(img);
      } else {
        cover.textContent = kindLabel(item.kind, mime);
      }
      row.appendChild(cover);
      const badge = document.createElement('span');
      badge.className = 'artifact-kind';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = isModel3d(item) ? '3D' : kindBadge(item.kind);
      row.appendChild(badge);
      const bookmark = document.createElement('button');
      bookmark.type = 'button';
      bookmark.className = 'artifact-bookmark';
      bookmark.title = item.favorited ? '取消收藏' : '收藏';
      bookmark.setAttribute('aria-label', bookmark.title);
      bookmark.setAttribute('aria-pressed', String(!!item.favorited));
      bookmark.addEventListener('click', async event => {
        event.stopPropagation();
        if (!inScope() || pendingBookmarks.has(path)) return;
        pendingBookmarks.add(path);
        bookmarkRevision += 1;
        bookmark.disabled = true;
        try {
          const result = await request('POST', path + '/favorite', {enabled: !item.favorited});
          if (!inScope()) return;
          if (result.status !== 200) { show('error', messageFor(result.body.error, '收藏未保存。')); return; }
          allItems = allItems.map(row => row.id === item.id ? {...row, favorited: result.body.favorited} : row);
          if (!listPanel.hidden) renderCatalog({preserve: true});
        } catch {
          if (inScope()) show('error', '网络错误，收藏未保存。');
        } finally {
          pendingBookmarks.delete(path);
          bookmarkRevision += 1;
          bookmark.disabled = false;
        }
      });
      bookmark.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v16l-5-3-5 3V4Z"/></svg>';
      row.appendChild(bookmark);
      const created = document.createElement('span');
      created.className = 'artifact-created';
      created.textContent = artifactTime(item.created);
      const updated = document.createElement('span');
      updated.className = 'artifact-updated';
      updated.textContent = item.updated ? '编辑于 ' + artifactTime(item.updated) : '';
      row.append(created, updated, itemMenu(item, onOpen, inScope, path, origin));
      nextRows.push(row);
    }
    if (!preserve) {
      for (const row of nextRows) list.appendChild(row);
      return;
    }
    const keep = new Set(nextRows);
    for (const row of previousRows) if (!keep.has(row)) row.remove();
    nextRows.forEach((row, index) => {
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    });
    if (focusedRow && !list.contains(active)) {
      const replacement = nextRows.find(row => row.dataset.artifactId === focusedRow.dataset.artifactId);
      (replacement?.querySelector(focusSelector) || search)?.focus({preventScroll: true});
    } else if (focusedRow && document.activeElement !== active) {
      active.focus({preventScroll: true});
    }
    if (anchor) {
      const replacement = nextRows.find(row => row.dataset.artifactId === anchor.dataset.artifactId);
      if (replacement) scroller.scrollTop += replacement.getBoundingClientRect().top - anchorTop;
    }
  }

  function activeEditor(selection) {
    return !!selection && editor === selection && selection.account === currentUser && selection.workspace === workspaceId();
  }

  function editorDraft() {
    const kind = current?.kind || draftKind;
    if (kind === 'document') richDocument.instance?.flush();
    let content;
    if (kind === 'document' || kind === 'website') content = form.elements.body.value;
    if (kind === 'spreadsheet') content = spreadsheet.instance?.value();
    if (kind === 'slides') content = slidesDeck();
    if (kind === 'dashboard') content = dashboardValue();
    if (kind === 'whiteboard') content = boardState;
    return {
      content: JSON.stringify([kind, form.elements.title.value, content]),
      file: kind === 'media' ? document.getElementById('media-file')?.files?.[0] : undefined,
    };
  }

  const recovery = document.getElementById('artifact-draft-recovery');
  const recoveryMessage = document.getElementById('artifact-draft-message');
  const recoveryDetails = document.getElementById('artifact-draft-details');
  const recoveryCopy = document.getElementById('artifact-draft-copy');
  let draftTimer;

  function draftKey(selection = editor, item = current) {
    const actor = selection?.account?.id;
    if (!actor || selection.account !== currentUser || !selection.workspace ||
        !['document', 'website'].includes(item?.kind)) return '';
    const draftId = item.id || (item.parent?.id ? 'child:' + item.parent.id : null);
    return DRAFT_STORAGE_PREFIX + JSON.stringify([actor, selection.workspace, item.kind, draftId]);
  }

  function readDraft(key) {
    if (!key) return null;
    try {
      const bin = document.defaultView.sessionStorage;
      const entry = JSON.parse(bin.getItem(key));
      if (entry && typeof entry.title === 'string' && entry.title.length <= 80 &&
          typeof entry.body === 'string' && entry.body.length <= DRAFT_MAX_BODY &&
          (entry.revision === null || Number.isSafeInteger(entry.revision) && entry.revision > 0) &&
          Number.isFinite(entry.updated) && Date.now() - entry.updated < DRAFT_MAX_AGE) return entry;
      if (entry) bin.removeItem(key);
    } catch {}
    return null;
  }

  function removeDraft(key) {
    if (!key) return;
    try { document.defaultView.sessionStorage.removeItem(key); } catch {}
  }

  function renderDraftResume() {
    const resume = document.getElementById('artifact-draft-resume');
    if (!resume) return;
    const scope = {account:currentUser, workspace:workspaceId()};
    let visible = false;
    for (const kind of ['document', 'website']) {
      const button = document.getElementById('resume-draft-' + kind);
      if (!button) continue;
      button.hidden = !readDraft(draftKey(scope, {kind}));
      visible ||= !button.hidden;
    }
    resume.hidden = catalogKind === 'meetings' || !visible;
  }

  function persistDraft() {
    clearTimeout(draftTimer);
    const key = draftKey();
    if (!key || form.hidden || !editor?.cleanDraft) return;
    const previous = readDraft(key);
    const revision = current.revision ?? null;
    // A draft based on an older revision stays available for copying.
    if (previous && previous.revision !== revision) return;
    if (!hasEditorDraft()) {
      removeDraft(key);
      if (recovery) recovery.hidden = true;
      return;
    }
    const {title, body} = form.elements;
    if (body.value.length > DRAFT_MAX_BODY || (previous?.title === title.value && previous.body === body.value)) return;
    try {
      const bin = document.defaultView.sessionStorage;
      if (!previous) {
        const entries = Object.keys(bin).filter(name => name.startsWith(DRAFT_STORAGE_PREFIX))
          .map(name => ({name, updated:readDraft(name)?.updated})).filter(entry => entry.updated != null)
          .sort((left, right) => left.updated - right.updated);
        for (const entry of entries.slice(0, Math.max(0, entries.length - DRAFT_MAX_ENTRIES + 1))) {
          bin.removeItem(entry.name);
        }
      }
      bin.setItem(key, JSON.stringify({revision, title:title.value, body:body.value, updated:Date.now()}));
    } catch {}
  }

  function readEditorRecovery({restore = false} = {}) {
    if (!recovery) return;
    recovery.hidden = true;
    recoveryDetails.hidden = true;
    recoveryDetails.open = false;
    recoveryCopy.value = '';
    const key = draftKey();
    const entry = readDraft(key);
    if (!entry) return;
    if (entry.title === (current.title || '') && entry.body === (current.body || '')) {
      removeDraft(key);
      return;
    }
    const conflict = entry.revision !== (current.revision ?? null);
    if (restore && !conflict) {
      form.elements.title.value = entry.title;
      form.elements.body.value = entry.body;
      richDocument.instance?.load(entry.body, current.kind === 'document');
    }
    if (!restore && !conflict) return;
    recoveryMessage.textContent = conflict
      ? '作品已有新版本。你可以查看并复制先前草稿。'
      : '已恢复未保存的草稿。保存后会更新这件作品。';
    recovery.hidden = false;
    recoveryDetails.hidden = !conflict;
    if (conflict) recoveryCopy.value = entry.title + '\n\n' + entry.body;
  }

  function scheduleDraft(event) {
    if (!draftKey()) return;
    const target = event.target;
    if (event.type === 'input' && target !== form.elements.title && target !== form.elements.body &&
        !target.closest?.('#document-rich, #document-source')) return;
    if (event.type === 'click' && !target.closest?.('[data-doc-format]')) return;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDraft, 200);
  }

  form.addEventListener('input', scheduleDraft);
  form.addEventListener('click', scheduleDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistDraft();
  });
  document.defaultView?.addEventListener?.('pagehide', persistDraft);
  document.getElementById('artifact-draft-discard')?.addEventListener('click', () => {
    if (!activeEditor(editor) || editor.saving) return;
    const key = draftKey();
    const entry = readDraft(key);
    if (!entry) return;
    removeDraft(key);
    if (entry.revision === (current.revision ?? null)) fillEditor(current);
    else persistDraft();
    readEditorRecovery();
    form.elements.title.focus();
  });

  function editorDraftChanged(saved, draft = editorDraft()) {
    return saved && (saved.content !== draft.content || saved.file !== draft.file);
  }

  function hasEditorDraft() {
    return Boolean(current && !form.hidden && editor?.cleanDraft && editorDraftChanged(editor.cleanDraft));
  }

  function canLeaveEditor() {
    if (editor?.saving) {
      show('loading', '作品正在保存，请稍候。');
      return false;
    }
    if (!hasEditorDraft()) return true;
    const browser = document.defaultView;
    const discard = (browser?.confirm || globalThis.confirm)?.call(browser,
      '这个作品有未保存的修改。要放弃修改并离开吗？') === true;
    if (discard) {
      const key = draftKey();
      if (readDraft(key)?.revision === (current.revision ?? null)) removeDraft(key);
      clearTimeout(draftTimer);
    }
    return discard;
  }

  function warnBeforeLeavingSpace(event) {
    if (!editor?.saving && !hasEditorDraft()) return;
    persistDraft();
    const entry = readDraft(draftKey());
    if (!editor?.saving && entry?.revision === (current.revision ?? null) &&
        entry.title === form.elements.title.value && entry.body === form.elements.body.value) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function setSaving(saving) {
    for (const button of saveButtons) button.disabled = saving;
    if (mobileSave) mobileSave.textContent = saving ? '保存中…' : '保存';
  }

  function updateMobileActions() {
    const saved = Boolean(current?.id);
    const isDocument = current?.kind === 'document';
    if (mobileMenu) mobileMenu.hidden = false;
    if (mobileMarkdown) mobileMarkdown.hidden = !isDocument;
    if (mobileDelete) mobileDelete.hidden = !saved;
    for (const button of mobilePanels.values()) if (button) button.hidden = !saved;
    syncDocumentLocation();
    syncStudioCopy();
  }

  function hideEditor() {
    closeDocumentTree();
    artifactRename?.close();
    richDocument.instance?.closeFind();
    resetDocumentDraft();
    workVersion.instance?.close();
    if (pendingDeleteCancel) pendingDeleteCancel();
    closeDuplicateDialog();
    studioCopy.instance?.close();
    editor?.controller.abort();
    document.defaultView?.removeEventListener?.('beforeunload', warnBeforeLeavingSpace);
    editor = null;
    current = null;
    clearCreatedShare();
    clearTimeout(draftTimer);
    if (recovery) recovery.hidden = true;
    if (recoveryCopy) recoveryCopy.value = '';
    artifactSendOrigin = null;
    closeSpaceActionDialog();
    if (agentTaskDialog) closeAgentTaskDialog();
    sendingArtifact = null;
    sendDialog.hidden = true;
    for (const id of ['media-image', 'media-audio', 'media-video']) {
      const media = document.getElementById(id);
      if (media.getAttribute('src')) {
        media.removeAttribute('src');
        media.load?.();
      }
    }
    model3dPreview.instance?.setSource('');
    setWebsitePreview();
    form.hidden = true;
    form.inert = false;
    editorLoading.hidden = true;
    listPanel.hidden = false;
    liveLoad.disabled = false;
    liveCompare.removeAttribute('href');
    if (mobileMenu) mobileMenu.open = false;
    setSaving(false);
  }

  function resetEditorPanels() {
    for (const [name, panel] of editorPanels) {
      panel.open = false;
      panel.hidden = !current?.id;
      document.getElementById(name + '-status').hidden = true;
    }
    for (const id of ['share-once', 'share-empty', 'version-empty', 'revoke-discover', 'artifact-live-update']) {
      document.getElementById(id).hidden = true;
    }
    for (const id of ['share-list', 'version-list']) document.getElementById(id).textContent = '';
    clearCreatedShare();
    document.getElementById('create-share').disabled = false;
    document.getElementById('share-expires').value = '';
    discoverSlug.value = current?.id ? suggestedDiscoverSlug(current.title) : '';
    if (discoverTopic) discoverTopic.value = '';
    if (discoverEditable) discoverEditable.checked = false;
    const canReleaseEditable = nativeCatalog && ['slides','whiteboard'].includes(current?.kind);
    if (discoverEditableField) discoverEditableField.hidden = !canReleaseEditable;
    if (discoverEditableNote) discoverEditableNote.hidden = !canReleaseEditable;
    if (editor) {
      editor.discoverSlugEdited = false;
      editor.discoverTopicEdited = false;
      editor.discoverEditableEdited = false;
      editor.discoverListing = null;
    }
    if (publishDiscover) publishDiscover.textContent = '发布到发现页';
    syncSharingRevisions(current?.revision);
    showDiscoverPublicLink('');
    setDiscoverPending(false);
  }

  function showCatalog({preserve = false} = {}) {
    renderFilterChoices();
    renderCatalog({preserve});
  }

  async function openEditor(item, {workspace = workspaceId(), notice, saved = false, focusTitle = false, findText} = {}) {
    if (!canCreateInWorkspace() || workspaceId() !== workspace) return;
    if (!canLeaveEditor()) return false;
    const target = artifactTargetFromSearch(document.defaultView?.location?.search);
    const catalogView = !listPanel.hidden && !target?.artifact ? {
      account:currentUser.id, workspace, kind:catalogKind, scope:catalogScope,
      scroll:catalogScrollers.map(node => node?.scrollTop ?? 0), focus:item?.id,
      depth:sameSelection(catalog) ? catalog.depth : CATALOG_PAGE_SIZE,
      filters:{query:search.value, types:filterTypes, creators:filterCreators, sessions:filterSessions,
        dateMode:dateMode(), start:dateStart?.value || '', end:dateEnd?.value || '', updated:filterUpdated},
    } : null;
    hideEditor();
    closeNewMenu();
    show('', '');
    const selection = {workspace, account: currentUser, controller: new AbortController(), reads: new Map(), catalogView, focusTitle};
    editor = selection;
    listPanel.hidden = true;
    if (main) main.scrollTop = 0;
    if (item?.id && !saved) {
      editorLoading.hidden = false;
      // The catalog can identify the editor before the exact record arrives.
      void editorTools(item)?.prepare().catch(() => {});
      const seen = await request('GET', `/v1/workspaces/${workspace}/artifacts/${item.id}`, undefined, undefined, selection.controller.signal)
        .catch(() => ({status: 0, body: {}}));
      if (!activeEditor(selection)) return;
      if (seen.status !== 200 || seen.body.artifact?.id !== item.id ||
          (seen.body.artifact.workspace_id && seen.body.artifact.workspace_id !== workspace)) {
        hideEditor();
        showCatalog();
        show('error', messageFor(seen.body.error, '无法打开文档。'));
        return;
      }
      item = seen.body.artifact;
    }
    const tools = editorTools(item);
    if (tools && !tools.instance) {
      // Chat-linked creation captures the draft during the new button's click.
      if (!item?.id) current = item;
      editorLoading.hidden = false;
      try {
        await tools.prepare();
      } catch {
        if (!activeEditor(selection)) return;
        hideEditor();
        showCatalog();
        show('error', '无法加载编辑器，请刷新页面后重试。');
        return;
      }
      if (!activeEditor(selection)) return;
    }
    current = item;
    fillEditor(current);
    readEditorRecovery({restore:true});
    resetEditorPanels();
    updateMobileActions();
    document.getElementById('remove-artifact').hidden = !current?.id;
    editorLoading.hidden = true;
    form.hidden = false;
    document.defaultView?.addEventListener?.('beforeunload', warnBeforeLeavingSpace);
    if (current?.id) recordEditorAddress(selection, current);
    if (notice) show(notice.kind, notice.text);
    if (focusTitle) form.elements.title?.focus({preventScroll: true});
    if (current?.kind === 'document' && findText) richDocument.instance?.find(findText);
    return true;
  }

  function editorPath(selection, id = current.id) {
    return `/v1/workspaces/${selection.workspace}/artifacts/${id}`;
  }

  function syncDocumentTreeAction() {
    if (treeOpen) treeOpen.hidden = !nativeCatalog || !canCreateInWorkspace() || catalogKind === 'meetings';
  }

  function documentHref(workspace, id) {
    return worksPath() + '?' + new URLSearchParams({workspace, artifact:id});
  }

  function syncDocumentLocation() {
    if (!editorDocumentNav) return;
    editorDocumentNav.hidden = !nativeCatalog || current?.kind !== 'document';
    newChildDocument.hidden = !current?.id;
    if (moveDocument) moveDocument.hidden = !current?.id;
    const parent = current?.parent;
    editorParentDocument.hidden = !CATALOG_CURSOR.test(parent?.id || '');
    editorParentDocument.textContent = parent ? '上级 · ' + parent.title : '';
    if (!editorParentDocument.hidden) editorParentDocument.href = documentHref(workspaceId(), parent.id);
    else editorParentDocument.removeAttribute('href');
  }

  function discardDocumentTree() {
    treeRead?.abort();
    treeRead = null;
    documentMove = null;
    treeList?.replaceChildren();
    if (treeStatus) treeStatus.textContent = '';
  }

  function closeDocumentTree() {
    discardDocumentTree();
    if (treeDialog?.open) treeDialog.close();
  }

  function documentClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  }

  function openTreeDocument(item) {
    if (current?.id === item.id) return closeDocumentTree();
    return openEditor({id:item.id, kind:'document'});
  }

  function startChildDocument({id, title}) {
    return openEditor({kind:'document', parent:{id, title}}, {focusTitle:true});
  }

  async function showDocumentTree({move = false} = {}) {
    if (!treeDialog || !nativeCatalog || !canCreateInWorkspace()) return;
    const workspace = workspaceId(), account = currentUser;
    const itemToMove = move && current?.kind === 'document' && current.id ? current : null;
    discardDocumentTree();
    const controller = new AbortController();
    treeRead = controller;
    if (itemToMove) documentMove = {item: itemToMove, workspace, account, controller};
    if (treeHeading) treeHeading.textContent = itemToMove ? `移动「${itemToMove.title}」` : '文档树';
    if (moveDocumentForm) moveDocumentForm.hidden = true;
    treeList.hidden = Boolean(itemToMove);
    treeStatus.textContent = '正在读取文档…';
    treeRetry.hidden = true;
    if (!treeDialog.open) treeDialog.showModal();
    const result = await request('GET', `/v1/workspaces/${workspace}/artifacts/document-tree`, undefined, undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])).catch(() => ({status:0}));
    if (treeRead !== controller || !treeDialog.open || workspaceId() !== workspace || currentUser !== account) return;
    if (result.status !== 200 || !Array.isArray(result.body?.items)) {
      treeStatus.textContent = '无法读取文档树。';
      treeRetry.hidden = false;
      return;
    }
    const items = result.body.items.filter(item => CATALOG_CURSOR.test(item?.id || '') && typeof item.title === 'string');
    const ids = new Set(items.map(item => item.id));
    const children = new Map();
    for (const item of items) {
      const parent = ids.has(item.parent_id) ? item.parent_id : null;
      const list = children.get(parent) || [];
      list.push(item);
      children.set(parent, list);
    }
    if (itemToMove) {
      const row = items.find(item => item.id === itemToMove.id);
      if (!row) {
        treeStatus.textContent = '这份文档已不在当前工作区。';
        return;
      }
      documentMove.expectedParent = row.parent_id;
      const destinationOption = (value, text) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        return option;
      };
      moveDestination.replaceChildren(destinationOption('', '请选择位置'));
      if (row.parent_id !== null) moveDestination.append(destinationOption('root', '资料空间根目录'));
      const addDestinations = (parent, depth) => {
        for (const item of children.get(parent) || []) {
          if (item.id === row.id) continue;
          if (item.id !== row.parent_id) {
            moveDestination.append(destinationOption(item.id, ' '.repeat(Math.min(depth, 6)) + item.title));
          }
          addDestinations(item.id, depth + 1);
        }
      };
      addDestinations(null, 0);
      const available = moveDestination.options.length > 1;
      treeStatus.textContent = available ? '' : '当前没有其他可选位置。';
      moveDocumentForm.hidden = !available;
      moveDestination.value = '';
      moveDestination.disabled = false;
      moveSubmit.disabled = true;
      if (available) moveDestination.focus({preventScroll: true});
      return;
    }
    treeStatus.textContent = items.length ? '' : '这个工作区还没有云文档。';
    const addRows = (parent, depth) => {
      for (const item of children.get(parent) || []) {
        const row = document.createElement('li');
        row.className = 'document-tree-row';
        row.style.setProperty('--document-depth', String(Math.min(depth, 6)));
        const link = document.createElement('a');
        link.href = documentHref(workspace, item.id);
        link.textContent = item.title;
        if (current?.id === item.id) link.setAttribute('aria-current', 'page');
        link.addEventListener('click', event => {
          if (!documentClick(event)) return;
          event.preventDefault();
          void openTreeDocument(item);
        });
        const child = document.createElement('button');
        child.type = 'button';
        child.textContent = '新建子文档';
        child.setAttribute('aria-label', `在「${item.title}」下新建子文档`);
        child.addEventListener('click', () => void startChildDocument(item));
        row.append(link, child);
        treeList.append(row);
        addRows(item.id, depth + 1);
      }
    };
    addRows(null, 0);
  }

  async function submitDocumentMove(event) {
    event.preventDefault();
    const move = documentMove;
    const target = moveDestination.value;
    if (!move || moveSubmit.disabled || (target !== 'root' && !CATALOG_CURSOR.test(target))) return;
    const parentId = target === 'root' ? null : target;
    moveSubmit.disabled = moveDestination.disabled = true;
    treeStatus.textContent = '正在移动文档…';
    const result = await request('POST', `/v1/workspaces/${move.workspace}/artifacts/document-tree`, {
      artifact_id: move.item.id, parent_id: parentId, expected_parent_id: move.expectedParent,
    }, undefined, AbortSignal.any([move.controller.signal, AbortSignal.timeout(8000)])).catch(() => ({status:0}));
    if (documentMove !== move || currentUser !== move.account || workspaceId() !== move.workspace || current?.id !== move.item.id) return;
    const parent = result.body?.parent;
    if (result.status !== 200 || result.body?.id !== move.item.id || (parent?.id ?? null) !== parentId) {
      treeStatus.textContent = messageFor(result.body?.error, '无法确认文档位置，请刷新后重试。');
      treeRetry.hidden = false;
      return;
    }
    if (parent) current.parent = parent;
    else delete current.parent;
    syncDocumentLocation();
    closeDocumentTree();
    show('success', '文档已移动。');
  }

  function panelStatus(name, text) {
    const node = document.getElementById(name + '-status');
    node.hidden = !text;
    node.textContent = text;
  }

  async function readPanel(name, suffix) {
    const selection = editor;
    if (!activeEditor(selection) || !current?.id) return null;
    const item = current;
    const token = Symbol(name);
    selection.reads.set(name, token);
    panelStatus(name, '正在读取…');
    const result = await request('GET', editorPath(selection, item.id) + suffix, undefined, undefined, selection.controller.signal)
      .catch(() => ({status: 0, body: {}}));
    if (!activeEditor(selection) || current.id !== item.id || selection.reads.get(name) !== token) return null;
    return {result, item, selection};
  }

  function showDiscoverPublicLink(path) {
    if (!discoverPublicLink) return;
    discoverPublicLink.hidden = !path;
    if (path) discoverPublicLink.href = path;
    else discoverPublicLink.removeAttribute('href');
  }

  function setDiscoverPending(pending) {
    if (publishDiscover) publishDiscover.disabled = pending;
    if (revokeDiscover) revokeDiscover.disabled = pending;
    if (discoverSlug) discoverSlug.disabled = pending;
    if (discoverTopic) discoverTopic.disabled = pending;
    if (discoverEditable) discoverEditable.disabled = pending;
  }

  function syncSharingRevisions(revision) {
    const saved = Number.isSafeInteger(revision) && revision > 0 ? revision : null;
    if (shareRevision) shareRevision.textContent = saved ? '将分享当前保存的修订 ' + saved + '。' : '';
    if (!discoverRevision) return;
    const listing = editor?.discoverListing;
    const published = listing?.published_revision;
    discoverRevision.hidden = !saved;
    if (!saved) discoverRevision.textContent = '';
    else if (!listing?.listed) discoverRevision.textContent = '当前保存的修订 ' + saved + '。';
    else if (!Number.isSafeInteger(published)) discoverRevision.textContent = '当前保存的修订 ' + saved + '。旧发布记录未标注修订。';
    else discoverRevision.textContent = published === saved ? '发现页公开修订 ' + published + '。'
      : '发现页公开修订 ' + published + ' · 当前保存的修订 ' + saved;
  }

  function renderDiscoverListing(row, updateSlug = true) {
    const slug = typeof row.slug === 'string' && DISCOVER_SLUG.test(row.slug) ? row.slug : '';
    const listed = row.listed === true && Boolean(slug);
    if (editor) editor.discoverListing = listed ? row : null;
    syncSharingRevisions(current?.revision);
    if (updateSlug) discoverSlug.value = slug || suggestedDiscoverSlug(current?.title);
    if (discoverTopic && !editor?.discoverTopicEdited) {
      discoverTopic.value = listed && isWorkTopic(row.category) ? row.category : '';
    }
    if (discoverEditable && !editor?.discoverEditableEdited) discoverEditable.checked = listed && row.editable_remix === true;
    if (revokeDiscover) revokeDiscover.hidden = !listed;
    if (publishDiscover) publishDiscover.textContent = listed ? '更新公开版本' : '发布到发现页';
    const path = '/w/' + slug;
    showDiscoverPublicLink(listed ? (row.path === '/social' + path ? row.path : path) : '');
    panelStatus('discover', listed ? (row.editable_remix === true ? '已公开并允许复制可编辑版本。' : '已公开到发现页。') : '尚未公开到发现页。');
  }

  async function loadDiscover() {
    if (editor?.discoverWrite) return;
    const response = await readPanel('discover', '/discover');
    if (!response) return;
    const {result, selection} = response;
    if (result.status !== 200) {
      panelStatus('discover', '无法读取公开状态。关闭后重新展开可重试。');
      return;
    }
    renderDiscoverListing(result.body.discover || {}, !selection.discoverSlugEdited);
  }

  async function changeDiscoverListing(publish) {
    const selection = editor;
    if (!activeEditor(selection) || !current?.id || selection.discoverWrite) return;
    const slug = discoverSlug.value.trim();
    if (publish && !DISCOVER_SLUG.test(slug)) {
      panelStatus('discover', '请输入符合要求的公开短地址。');
      discoverSlug.focus();
      return;
    }
    selection.discoverWrite = true;
    selection.reads.delete('discover');
    setDiscoverPending(true);
    panelStatus('discover', publish ? '正在发布作品…' : '正在撤回作品…');
    const id = current.id;
    const path = editorPath(selection, id) + '/discover';
    const payload = publish ? {slug,revision:current.revision} : {};
    if (publish && nativeCatalog && discoverTopic && (discoverTopic.value || selection.discoverTopicEdited)) {
      payload.category = discoverTopic.value || null;
    }
    if (publish && discoverEditableField && !discoverEditableField.hidden) {
      payload.allow_editable_remix = discoverEditable.checked;
    }
    const isCurrent = () => activeEditor(selection) && current?.id === id;
    const validListing = row => row?.listed === false ||
      (row?.listed === true && typeof row.slug === 'string' && DISCOVER_SLUG.test(row.slug));
    const topicMatches = row => payload.category === undefined || (row.category ?? null) === payload.category;
    const showConfirmed = row => {
      if (publish) selection.discoverSlugEdited = false;
      selection.discoverTopicEdited = false;
      selection.discoverEditableEdited = false;
      renderDiscoverListing(row, !selection.discoverSlugEdited);
      if (!publish) panelStatus('discover', '已从发现页撤回。');
    };

    try {
      const result = await request('POST', path + (publish ? '' : '/revoke'), payload, undefined,
        AbortSignal.any([selection.controller.signal, AbortSignal.timeout(15000)]))
        .catch(() => ({status: 0}));
      if (!isCurrent()) return;
      const accepted = result.status === 200 || (publish && result.status === 201);
      const received = result.body?.discover;
      if (accepted && validListing(received) && received.listed === publish &&
          (!publish || (received.slug === slug && topicMatches(received)))) {
        showConfirmed(received);
        return;
      }

      const action = publish ? '发布' : '撤回';
      if (accepted || !result.status || result.status === 408 || result.status >= 500) {
        panelStatus('discover', '正在核对公开状态…');
        const check = await request('GET', path, undefined, undefined,
          AbortSignal.any([selection.controller.signal, AbortSignal.timeout(8000)]))
          .catch(() => ({status: 0}));
        if (!isCurrent()) return;
        const observed = check.body?.discover;
        if (check.status !== 200 || !validListing(observed)) {
          panelStatus('discover', `未能确认${action}结果。重新展开此面板可查询公开状态。`);
          return;
        }
        const matches = publish ? observed.listed && observed.slug === slug && observed.published_revision === payload.revision &&
          Boolean(observed.editable_remix) === Boolean(payload.allow_editable_remix) && topicMatches(observed) : observed.listed === false;
        if (matches) showConfirmed(observed);
        else {
          renderDiscoverListing(observed, !selection.discoverSlugEdited);
          panelStatus('discover', `当前公开状态与本次${action}请求不一致。请核对后重试。`);
        }
        return;
      }

      const error = result.body?.error;
      const messages = {
        forbidden: '只有所有者或管理员可以将作品发布到发现页。',
        conflict: '这个短地址已经在用。',
        invalid: '请输入符合要求的公开短地址。',
        attachment_type_blocked: '这个文件格式无法公开发布。',
      };
      const code = typeof error === 'string' ? error : error?.code;
      if (publish && code === 'artifact_changed') displayEditorUpdate({dirty:hasEditorDraft()});
      const fallback = publish ? '无法发布到发现页，请重试。' : '无法从发现页撤回，请重试。';
      panelStatus('discover', messageFor(error, publish && Object.hasOwn(messages, code) ? messages[code] : fallback));
    } finally {
      selection.discoverWrite = false;
      if (isCurrent()) setDiscoverPending(false);
    }
  }

  function clearCreatedShare() {
    const once = document.getElementById('share-once');
    once.hidden = true;
    delete once.dataset.shareId;
    document.getElementById('share-url').value = '';
    document.getElementById('open-share').removeAttribute('href');
    document.getElementById('share-copy-status').textContent = '';
  }

  function showShareLink(share) {
    if (!/^\/share\/[A-Za-z0-9_-]{43}$/.test(share?.path)) return false;
    const value = new URL(share.path, document.defaultView.location.origin).href;
    const once = document.getElementById('share-once');
    document.getElementById('share-url').value = value;
    document.getElementById('open-share').href = value;
    document.getElementById('share-copy-status').textContent = '';
    once.dataset.shareId = share.id;
    once.hidden = false;
    return true;
  }

  async function copyShareLink() {
    const field = document.getElementById('share-url');
    const status = document.getElementById('share-copy-status');
    const value = field.value;
    if (!value) return;
    try {
      await document.defaultView.navigator.clipboard.writeText(value);
      if (field.value === value) status.textContent = '已复制链接。';
    } catch {
      if (field.value !== value) return;
      field.focus({preventScroll: true});
      field.select();
      status.textContent = '已选中链接，请手动复制。';
    }
  }

  async function recoverShareLink(selection, path, item, button) {
    if (!activeEditor(selection) || selection.shareWrite) return;
    selection.shareWrite = button.disabled = true;
    panelStatus('share', '正在读取分享链接…');
    try {
      const result = await request('POST', path + '/link', {}, undefined, selection.controller.signal)
        .catch(() => ({status:0,body:{}}));
      if (!activeEditor(selection)) return;
      const share = result.body?.share;
      if (result.status === 200 && share?.id === item.id && showShareLink(share)) {
        panelStatus('share', '');
        await copyShareLink();
      } else {
        if (result.status === 404 && document.getElementById('share-once').dataset.shareId === item.id) clearCreatedShare();
        panelStatus('share', messageFor(result.body?.error, '暂时无法读取分享链接，请重试。'));
      }
    } finally {
      selection.shareWrite = false;
      if (activeEditor(selection)) button.disabled = false;
    }
  }

  async function changeShare(selection, path, {create = false, item, button}) {
    if (!activeEditor(selection) || selection.shareWrite) return;
    const restoreFocus = document.activeElement === button;
    selection.shareWrite = true;
    button.disabled = true;
    if (!create && document.getElementById('share-once').dataset.shareId === item.id) clearCreatedShare();
    const expires = Number(document.getElementById('share-expires').value);
    const payload = create ? {revision:current.revision,...(expires ? {expires_in:expires} : {})} : {};
    panelStatus('share', create ? '正在创建分享链接…' : '正在撤销分享链接…');
    try {
      const result = await request('POST', path, payload,
        undefined, selection.controller.signal).catch(() => ({status: 0, body: {}}));
      if (!activeEditor(selection)) return;
      const share = result.body?.share;
      if (create && result.body?.error?.code === 'artifact_changed') {
        displayEditorUpdate({dirty:hasEditorDraft()});
        panelStatus('share', '已保存的作品版本已更新，请查看后再创建分享链接。');
        return;
      }
      if (create && result.status === 201 && showShareLink(share)) {
        document.getElementById('copy-share').focus({preventScroll: true});
        await loadShares();
        return;
      }
      if (!create && result.status === 200 && share?.revoked === true) {
        await loadShares();
        if (activeEditor(selection)) panelStatus('share', '分享链接已撤销。');
        return;
      }
      await loadShares();
      if (activeEditor(selection)) panelStatus('share', create
        ? '暂未确认创建结果。若列表已有有效分享，可直接复制链接。'
        : '撤销尚未确认，链接可能仍可访问。请重试撤销。');
    } finally {
      selection.shareWrite = false;
      if (activeEditor(selection)) {
        button.disabled = false;
        if (!create && restoreFocus && document.activeElement === document.body) {
          const row = [...document.getElementById('share-list').children].find(node => node.dataset.shareId === item.id);
          (row?.querySelector('button') || document.getElementById('create-share')).focus({preventScroll: true});
        }
      }
    }
  }

  async function loadShares() {
    const response = await readPanel('share', '/shares');
    if (!response) return;
    const {result: listed, item: artifact, selection} = response;
    if (listed.status !== 200) {
      panelStatus('share', '无法读取分享链接。关闭后重新展开可重试。');
      return;
    }
    panelStatus('share', '');
    const list = document.getElementById('share-list');
    const empty = document.getElementById('share-empty');
    list.textContent = '';
    const items = listed.body.items || [];
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      row.dataset.shareId = item.id;
      const meta = document.createElement('span');
      meta.className = 'note';
      const expired = item.expired === true;
      const state = item.revoked ? '已撤销' : expired ? '已过期' : item.revocation_pending ? '撤销待确认' : '有效';
      const expiry = item.expires ? ` · 到期 ${artifactTime(item.expires)}` : '';
      const revision = Number.isSafeInteger(item.revision) ? ` · 修订 ${item.revision}` : '';
      meta.textContent = `${state} · ${item.prefix}…${revision}${expiry}`;
      row.appendChild(meta);
      const path = editorPath(selection, artifact.id) + '/shares/' + item.id;
      if (item.recoverable && !item.revoked && !expired && !item.revocation_pending) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = '复制链接';
        copy.addEventListener('click', () => recoverShareLink(selection, path, item, copy));
        row.appendChild(copy);
      }
      if (!item.revoked && !expired) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = item.revocation_pending ? '重试撤销' : '撤销';
        revoke.addEventListener('click', () => changeShare(selection, path + '/revoke', {item, button: revoke}));
        row.appendChild(revoke);
      }
      list.appendChild(row);
    }
  }

  function exportHref(revision) {
    const base = `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`;
    if(revision)return `${base}/versions/${revision}/export`;
    const format=document.getElementById('export-format')?.value;
    return `${base}/export`+(format && format!=='original'?'?format='+encodeURIComponent(format):'');
  }

  async function openWorkVersion(selection, artifact, revision, trigger) {
    const currentSelection = () => activeEditor(selection) && current?.id === artifact.id;
    if (!currentSelection() || !Number.isSafeInteger(revision) || revision < 1 || revision > 99_999_999) return;
    try {
      await workVersion.prepare();
    } catch {
      if (currentSelection()) show('error', '无法加载版本预览，请重试。');
      return;
    }
    if (!currentSelection() || !workVersion.instance) return;
    const workspace = selection.workspace;
    const href = worksPath() + '?' + new URLSearchParams({workspace, artifact:artifact.id, revision:String(revision)});
    writeSpaceAddress(href, {fromCatalog:Boolean(spaceAddress?.entry.fromCatalog)});
    const canRestore = () => nativeCatalog && currentSelection() && current.revision !== revision;
    workVersion.instance.open({current:currentSelection, id:artifact.id, workspace, revision, title:artifact.title, href, trigger,
      path:editorPath(selection,artifact.id) + '/versions/' + revision,
      latestPath:editorPath(selection,artifact.id),
      canRestore,
      reviewRestore: () => restoreReviewMessage(selection) || {revision:current.revision, key:idempotencyKey()},
      submitRestore: review => restoreWorkVersion(selection, artifact.id, revision, review),
    });
  }

  function restoreReviewMessage(selection) {
    if (selection.saving || form.inert) return '作品正在保存，请稍候。';
    if (hasEditorDraft()) return '请先保存当前草稿，再恢复历史版本。';
    return '';
  }

  async function restoreWorkVersion(selection, id, to, {revision, key}) {
    const ownsSelection = () => activeEditor(selection) && current?.id === id;
    const changed = {conflict:true, message:'当前修订已更新。关闭预览后查看最新版本，再确认恢复。'};
    if (!ownsSelection() || current.revision !== revision) return changed;
    const blocked = restoreReviewMessage(selection);
    if (blocked) return {message:blocked};
    selection.saving = true;
    form.inert = true;
    setSaving(true);
    try {
      const path = editorPath(selection, id) + '/restore';
      const send = () => request('POST', path, {revision,to}, {'Idempotency-Key':key},
        AbortSignal.any([selection.controller.signal, AbortSignal.timeout(8000)]))
        .catch(() => ({status:0,body:{}}));
      const receipt = result => {
        const {artifact,restore} = result.body || {};
        return result.status === 200 && artifact?.id === id && artifact.workspace_id === selection.workspace
          && restore?.base_revision === revision && restore.source_revision === to
          && [revision, revision+1].includes(restore.result_revision)
          && Number.isSafeInteger(artifact.revision) && artifact.revision >= restore.result_revision;
      };
      const uncertain = result => !result.status || result.status >= 500 || (result.status === 200 && !receipt(result));
      let result = await send();
      if (!ownsSelection()) return changed;
      if (uncertain(result)) result = await send();
      if (!ownsSelection()) return changed;
      if (revealRevisionConflict(result)) return changed;
      if (uncertain(result)) return {uncertain:true, message:'暂未确认服务器是否已恢复。重试会核对同一次请求。'};
      if (!receipt(result)) return {message:messageFor(result.body?.error, '无法恢复此版本，请重试。')};
      const next = result.body.artifact;
      const tools = editorTools(next);
      if (tools && !tools.instance) {
        try { await tools.prepare(); }
        catch {
          if (ownsSelection()) displayEditorUpdate({failed:true});
          return {message:'服务器已确认恢复。关闭预览后重新打开作品以查看最新内容。'};
        }
      }
      if (!ownsSelection()) return changed;
      if (next.revision > current.revision) {
        current = next;
        catalog = null;
        fillEditor(current);
        readEditorRecovery();
        liveBanner.hidden = true;
      }
      const applied = result.body.restore.result_revision;
      show('ok', current.revision > applied ? `已恢复为修订 ${applied}。当前为修订 ${current.revision}。`
        : applied === revision ? `当前修订 ${revision} 已包含所选版本的内容。` : `已恢复为修订 ${applied}。`);
      if (editorPanels.get('version')?.open) void loadVersions();
      return {saved:true};
    } finally {
      selection.saving = false;
      if (ownsSelection()) {
        form.inert = false;
        setSaving(false);
      }
    }
  }

  async function loadVersions() {
    const response = await readPanel('version', '/versions');
    if (!response) return;
    const {result: listed, item: artifact, selection} = response;
    if (listed.status !== 200) {
      panelStatus('version', '无法读取版本历史。关闭后重新展开可重试。');
      return;
    }
    panelStatus('version', '');
    const list = document.getElementById('version-list');
    const empty = document.getElementById('version-empty');
    list.textContent = '';
    const items = listed.body.items || [];
    empty.hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('li');
      const meta = document.createElement('span');
      row.dataset.revision = String(item.revision);
      meta.className = 'note';
      meta.textContent = `修订 ${item.revision} · ${item.title || ''} · ${item.created_by || ''}`;
      if (Number.isSafeInteger(item.restored_from)) meta.textContent += ' · 恢复自修订 ' + item.restored_from;
      row.appendChild(meta);
      if (typeof document.getElementById('work-version-dialog')?.showModal === 'function') {
        const preview = document.createElement('button');
        preview.type = 'button';
        preview.textContent = '查看';
        preview.setAttribute('aria-haspopup','dialog');
        preview.setAttribute('aria-label','查看修订 ' + item.revision);
        preview.addEventListener('click',()=>{ void openWorkVersion(selection,artifact,item.revision,preview); });
        row.appendChild(preview);
      }
      const download = document.createElement('a');
      download.href = exportHref(item.revision);
      download.textContent = '导出';
      row.appendChild(download);
      const copySource = {...artifact,title:item.title || artifact.title,revision:item.revision};
      if (canDuplicate(copySource)) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = '复制为新作品';
        copy.addEventListener('click', () => {
          if (activeEditor(selection) && current.id === artifact.id) openDuplicateDialog(copySource,copy);
        });
        row.appendChild(copy);
      }
      list.appendChild(row);
    }
  }

  const panelLoads = {version: loadVersions, share: loadShares, discover: loadDiscover};
  for (const [name, panel] of editorPanels) {
    panel.addEventListener('toggle', () => {
      if (panel.open && !panel.hidden) void panelLoads[name]();
    });
  }

  const activityStatus = document.getElementById('workspace-events-status');
  const activityRetry = document.getElementById('workspace-events-retry');
  const activity = createArtifactActivity({
    ...activityTimers,
    visible: () => document.visibilityState !== 'hidden',
    report(state) {
      if (!activityStatus) return;
      const message = {
        ready: '自动更新已开启',
        error: '自动更新暂不可用，可手动检查。',
        idle: '',
      }[state];
      if (activityStatus.textContent !== message) activityStatus.textContent = message;
      activityStatus.dataset.state = state;
    },
    async read(workspace, signal) {
      const account = currentUser;
      const selection = activeEditor(editor) && current?.id ? editor : null;
      const artifact = selection ? current.id : '';
      const result = await request('GET', `/v1/workspaces/${workspace}/artifacts/activity${artifact ? '?artifact=' + artifact : ''}`,
        undefined, undefined, signal);
      if (result.status !== 200) return null;
      const {version, revision} = result.body;
      if (artifact && revision !== null && !(Number.isSafeInteger(revision) && revision > 0)) return null;
      return {version, revision, selection, artifact, account};
    },
    async apply(snapshot, {workspace, changed, signal}) {
      if (workspace !== workspaceId() || snapshot.account !== currentUser || catalogKind === 'meetings') return 'defer';
      if (!listPanel.hidden) {
        if (!changed || catalog?.activityVersion === snapshot.version) return snapshot.version;
        if (pendingBookmarks.size || itemMenuOpen() || document.getElementById('filter-button')?.getAttribute('aria-expanded') === 'true' ||
            catalog?.state === 'loading' || catalog?.more) return 'defer';
        facets = null;
        return loadList({background: true, signal});
      }
      if (catalog?.state === 'ready' && catalog.activityVersion !== snapshot.version) catalog.state = 'stale';
      const selection = snapshot.selection;
      if (!activeEditor(selection) || snapshot.artifact !== current?.id || selection.saving || selection.loadingRevision) {
        return snapshot.version;
      }
      if (snapshot.revision === null) displayEditorUpdate({missing: true});
      else if (snapshot.revision === current.revision) liveBanner.hidden = true;
      else if (snapshot.revision > current.revision) {
        const dirty = hasEditorDraft();
        if (dirty || !canRefreshEditor()) displayEditorUpdate({dirty});
        else {
          const outcome = await loadEditorRevision(selection, {revision: snapshot.revision, signal});
          if (outcome === 'failed') return false;
        }
      }
      return snapshot.version;
    },
  });
  document.addEventListener?.('visibilitychange', activity.resume);
  activityRetry?.addEventListener('click', activity.check);

  function canRefreshEditor() {
    // Replacing the editor can move the caret, interrupt a stroke or reset media.
    return !form.inert && !drawing && !websiteInteractive && current.kind !== 'media' &&
      !document.activeElement?.closest?.('#editor-form :is(input,textarea,select,[contenteditable="true"])');
  }

  function displayEditorUpdate({missing = false, dirty = false, failed = false} = {}) {
    const message = missing ? '这件作品已无法访问，当前内容仍保留在此页。'
      : failed ? '暂未读取到服务器版本，请重试。'
      : dirty ? '服务器有新版本，当前草稿仍保留。'
      : '服务器有新版本。';
    if (liveMessage.textContent !== message) liveMessage.textContent = message;
    liveLoad.hidden = missing || Boolean(dirty && !draftKey());
    liveCompare.hidden = missing;
    if (!missing) liveCompare.href = worksPath() + '?workspace=' + editor.workspace + '&artifact=' + current.id;
    liveBanner.hidden = false;
  }

  async function loadEditorRevision(selection, {revision, signal, manual = false} = {}) {
    if (!activeEditor(selection) || !current?.id || selection.saving || selection.loadingRevision || form.inert) return;
    const prior = current;
    const isCurrent = () => activeEditor(selection) && current === prior && !selection.saving;
    // A separate tab remains available when the current draft cannot be recovered here.
    if (manual && hasEditorDraft()) {
      persistDraft();
      const entry = readDraft(draftKey());
      if (entry?.revision !== prior.revision ||
          entry.title !== form.elements.title.value || entry.body !== form.elements.body.value) {
        displayEditorUpdate({dirty: true});
        liveLoad.hidden = true;
        liveCompare.focus();
        return;
      }
      if (!document.defaultView?.confirm?.('切换后，可以在草稿恢复区查看并复制当前草稿。继续？')) return;
    }
    selection.loadingRevision = true;
    if (manual) {
      liveLoad.disabled = true;
      form.inert = true;
    }
    try {
      const signals = [selection.controller.signal, AbortSignal.timeout(6000)];
      if (signal) signals.push(signal);
      const result = await request('GET', editorPath(selection), undefined, undefined, AbortSignal.any(signals))
        .catch(() => ({status: 0, body: {}}));
      if (!isCurrent() || signal?.aborted) return;
      if (result.status === 404) {
        displayEditorUpdate({missing: true});
        return;
      }
      const latest = result.body.artifact;
      if (result.status !== 200 || latest?.id !== prior.id || latest.workspace_id !== selection.workspace ||
          !Number.isSafeInteger(latest.revision) || latest.revision < (revision ?? prior.revision + 1)) {
        displayEditorUpdate({dirty: hasEditorDraft(), failed: true});
        return 'failed';
      }
      const tools = editorTools(latest);
      if (tools && !tools.instance) await tools.prepare();
      if (!isCurrent() || signal?.aborted) return;
      if (!manual) {
        const dirty = hasEditorDraft();
        if (dirty || !canRefreshEditor()) {
          displayEditorUpdate({dirty});
          return;
        }
      }
      current = latest;
      fillEditor(current);
      readEditorRecovery();
      liveBanner.hidden = true;
      if (manual) {
        form.inert = false;
        form.elements.title.focus({preventScroll: true});
        show('ok', '已切换到服务器版本。');
      }
      for (const [name, panel] of editorPanels) {
        if (panel.open) void panelLoads[name]();
      }
    } catch {
      if (!isCurrent() || signal?.aborted) return;
      displayEditorUpdate({dirty: hasEditorDraft(), failed: true});
      return 'failed';
    } finally {
      selection.loadingRevision = false;
      if (manual && activeEditor(selection)) {
        form.inert = false;
        liveLoad.disabled = false;
      }
    }
  }

  liveLoad.addEventListener('click', () => void loadEditorRevision(editor, {manual: true}));

  function revealRevisionConflict(result) {
    const latest = result.body.error?.current;
    if (result.status !== 409 || !current?.id || latest?.id !== current.id ||
        latest.workspace_id !== editor.workspace || !Number.isSafeInteger(latest.revision) ||
        latest.revision <= current.revision) return false;
    persistDraft();
    displayEditorUpdate({dirty: hasEditorDraft()});
    return true;
  }

  function listStatus(text = '', retry = false) {
    document.getElementById('artifact-list-status').hidden = !text;
    document.getElementById('artifact-list-note').textContent = text;
    document.getElementById('retry-artifact-list').hidden = !retry;
  }

  function catalogQuery() {
    return listQuery(search.value, nativeCatalog ? {
      kind: catalogKind,
      scope: catalogScope,
      types: filterTypes,
      creators: filterCreators,
      sessions: filterSessions,
      updated: filterUpdated,
    } : undefined);
  }

  function sameSelection(page) {
    return page && page.workspace === workspaceId() && page.account === currentUser && page.query === catalogQuery();
  }

  function renderPageFooter(visible) {
    if (!pageFooter || !pageMore || !pageNote) return;
    const canPage = catalogKind !== 'meetings' && sameSelection(catalog) && catalog.state === 'ready' && catalog.cursor;
    pageFooter.hidden = !canPage;
    if (!canPage) return;
    pageMore.setAttribute('aria-disabled', String(Boolean(catalog.more)));
    pageMore.textContent = catalog.more ? '正在加载…' : catalog.moreError ? '重试加载更多' : '加载更多作品';
    pageNote.textContent = catalog.moreError ||
      (!visible && !catalog.more ? '已加载的作品中没有符合条件的结果。' : '');
    pageNote.hidden = !pageNote.textContent;
  }

  async function fetchCatalogPage(workspace, query, {cursor = '', limit = CATALOG_PAGE_SIZE, signal} = {}) {
    const options = [];
    if (nativeCatalog) options.push('order=recent');
    if (cursor) options.push('cursor=' + encodeURIComponent(cursor));
    if (limit !== CATALOG_PAGE_SIZE) options.push('limit=' + limit);
    const tail = options.length ? (query ? '&' : '?') + options.join('&') : '';
    const result = await request('GET', `/v1/workspaces/${workspace}/artifacts${query}${tail}`, undefined, undefined, signal)
      .catch(() => ({status: 0, body: {}}));
    if (result.status === 200 && !Array.isArray(result.body?.items)) return {status: 502, body: {}};
    return result;
  }

  function followingCursor(body, previous = '') {
    return body.cursor !== previous && CATALOG_CURSOR.test(body.cursor || '') ? body.cursor : '';
  }

  async function readCatalogDepth(workspace, query, depth, signal) {
    let remaining = depth;
    let cursor = '';
    let version;
    const items = [];
    const seen = new Set();
    while (remaining > 0 && !signal.aborted) {
      const limit = Math.min(remaining, CATALOG_READ_LIMIT);
      const result = await fetchCatalogPage(workspace, query, {limit, cursor, signal});
      if (result.status !== 200) return result;
      if (version && result.body.activity_version && result.body.activity_version !== version) {
        return {status: 409, body: {error: {message: '作品列表已更新，请重试。'}}};
      }
      version = result.body.activity_version;
      items.push(...result.body.items);
      remaining -= limit;
      cursor = followingCursor(result.body, cursor);
      if (!cursor || !result.body.items.length || seen.has(cursor)) break;
      seen.add(cursor);
    }
    return {status: 200, body: {items, cursor, activity_version: version}};
  }

  function replaceCatalogItems(items, preserve) {
    const prior = new Map(preserve ? allItems.map(item => [item.id, item]) : []);
    allItems = items.map(item => {
      const old = prior.get(item.id);
      return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
    });
  }

  async function loadMoreArtifacts() {
    // Give an explicit pagination click priority over a quiet refresh.
    if (catalog?.background && sameSelection(catalog) && catalog.before?.cursor) {
      catalog.controller.abort();
      catalog = catalog.before;
    }
    const page = catalog;
    if (!sameSelection(page) || page.state !== 'ready' || !page.cursor || page.more || catalogKind === 'meetings') return;
    const controller = new AbortController();
    const {signal} = controller;
    page.more = controller;
    page.moreError = '';
    renderPageFooter(matchingArtifacts().length);
    const initialCursor = page.cursor;
    const depth = page.depth + CATALOG_PAGE_SIZE;
    let listed = await fetchCatalogPage(page.workspace, page.query, {cursor: initialCursor, signal});
    const valid = () => catalog === page && sameSelection(page) && !signal.aborted && page.more === controller;
    if (!valid()) {
      if (page.more === controller) page.more = null;
      return;
    }
    let replace = listed.status === 400 || listed.status === 404;
    if (listed.status === 200 && page.activityVersion && listed.body.activity_version &&
        page.activityVersion !== listed.body.activity_version) replace = true;
    if (replace) {
      let before;
      do {
        before = bookmarkRevision;
        listed = await readCatalogDepth(page.workspace, page.query, depth, signal);
      } while (valid() && before !== bookmarkRevision);
    }
    if (!valid()) {
      if (page.more === controller) page.more = null;
      return;
    }
    page.more = null;
    if (listed.status !== 200) {
      page.moreError = '无法加载更多作品，请重试。';
      renderPageFooter(matchingArtifacts().length);
      return;
    }
    const earlierIds = new Set(allItems.map(item => item.id));
    if (replace) replaceCatalogItems(listed.body.items, true);
    else allItems = [...allItems, ...listed.body.items.filter(item => !earlierIds.has(item.id))];
    page.depth = depth;
    page.cursor = followingCursor(listed.body, replace ? '' : initialCursor);
    page.activityVersion = listed.body.activity_version;
    activity.seed(page.workspace, page.activityVersion);
    if (listPanel.hidden || catalogKind === 'meetings') return;
    const focusNewRow = document.activeElement === pageMore;
    showCatalog({preserve: true});
    if (focusNewRow) {
      const firstAdded = [...document.getElementById('artifact-list').children]
        .find(row => row.dataset.artifactId && !earlierIds.has(row.dataset.artifactId));
      if (firstAdded) firstAdded.firstElementChild?.focus();
      else if (!page.cursor) search.focus();
    }
  }

  async function loadList({reuse = false, background = false, signal, initial, minDepth = CATALOG_PAGE_SIZE} = {}) {
    if (background && searchTimer !== null) return 'defer';
    if (!background) cancelScheduledSearch();
    if (catalogKind === 'meetings') {
      if (background) return 'defer';
      catalog?.more?.abort();
      if (catalog) catalog.more = null;
      listStatus();
      activity.setScope('');
      await openMeetingArchive();
      return;
    }
    const workspace = workspaceId();
    if (!workspace || !currentUser) return;
    activity.setScope(workspace);
    const query = catalogQuery();
    const sameCatalog = sameSelection(catalog);
    if (reuse && sameCatalog && catalog.depth >= minDepth && catalog.state !== 'stale' && !catalog.controller?.signal.aborted) {
      listStatus(catalog.message, catalog.state === 'error');
      if (!listPanel.hidden) showCatalog();
      return;
    }
    const before = catalog;
    before?.controller?.abort();
    before?.more?.abort();
    if (before) before.more = null;
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const bookmarkBefore = bookmarkRevision;
    if (!sameCatalog) allItems = [];
    const depth = Math.max(minDepth, sameCatalog ? before.depth : CATALOG_PAGE_SIZE);
    const loading = {
      workspace, account: currentUser, query, depth, controller, state: 'loading',
      message: search.value.trim() ? '正在搜索作品…' : '正在加载资料…',
      ...(background ? {background, before} : {}),
    };
    catalog = loading;
    if (!background) {
      listStatus(loading.message);
      if (!listPanel.hidden && (!sameCatalog || !allItems.length)) showCatalog();
      else renderPageFooter(matchingArtifacts().length);
    }
    const listed = initial && !query && depth === CATALOG_PAGE_SIZE ? {status: 200, body: initial} :
      await readCatalogDepth(workspace, query, depth, requestSignal);
    if (catalog !== loading || !sameSelection(loading)) return 'defer';
    if (background && (signal?.aborted || listPanel.hidden || catalogKind === 'meetings' || itemMenuOpen() ||
        bookmarkBefore !== bookmarkRevision ||
        document.getElementById('filter-button')?.getAttribute('aria-expanded') === 'true')) {
      catalog = before;
      return signal?.aborted ? false : 'defer';
    }
    if (!background && bookmarkBefore !== bookmarkRevision) return loadList();
    if (listed.status !== 200) {
      if (background) { catalog = before; return false; }
      loading.state = 'error';
      loading.message = messageFor(listed.body.error, search.value.trim() ? '搜索作品失败，请重试。' : '无法读取作品库。');
      if (catalogKind !== 'meetings') {
        listStatus(loading.message, true);
        if (!listPanel.hidden) showCatalog({preserve: true});
      }
      return;
    }
    loading.state = 'ready';
    loading.message = '';
    loading.controller = null;
    delete loading.background;
    delete loading.before;
    loading.cursor = followingCursor(listed.body);
    loading.activityVersion = listed.body.activity_version;
    activity.seed(workspace, loading.activityVersion);
    replaceCatalogItems(listed.body.items || [], sameCatalog);
    if (catalogKind !== 'meetings') listStatus();
    if (!listPanel.hidden && catalogKind !== 'meetings') showCatalog({preserve: sameCatalog});
    return loading.activityVersion;
  }

  function fillWorkspaces(items, selected, {exact = false} = {}) {
    workspaceSelect.textContent = '';
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      workspaceSelect.appendChild(option);
    }
    if (items.some(item => item.id === selected)) workspaceSelect.value = selected;
    else if (exact) workspaceSelect.value = '';
    workspaceResolved = true;
    workspacePending.hidden = true;
    syncWorkspaceCreation();
    notifications.setWorkspace(workspaceId());
    studioWorkspaces = items;
    syncStudioWorkspace();
  }

  function cancelStudioPreload() {
    studioPreload?.controller.abort();
    studioPreload = null;
  }

  function nextWorkspaceLoad() {
    cancelStudioPreload();
    return ++workspaceLoad;
  }

  async function load() {
    const seq = nextWorkspaceLoad();
    workspaceResolved = false;
    workspacePending.hidden = false;
    syncWorkspaceCreation();
    activity.setScope('');
    notifications.setWorkspace('');
    const location = document.defaultView?.location;
    const sharedWork = !location?.search && sharedWorkCopyToken(location?.hash);
    const linkedStudio = studioTargetFromSearch(location?.search);
    const requested = linkedStudio ? null : artifactTargetFromSearch(location?.search);
    const fragment = new URLSearchParams((location?.hash || '').slice(1));
    const newKind = newKindFromSearch(location?.search);
    const linkedWorkspace = linkedStudio?.workspace || requested?.workspace || workspaceFromFragment(location?.hash);
    const startup = nativeCatalog ? takeSpaceStartup(document) ||
      (requested?.artifact ? startSavedArtifactReads(path => request('GET', path), requested.workspace) : null) : null;
    const sessionRequest = startup?.sessionRequest || request('GET', '/v1/auth/session').catch(() => ({status: 0, body: {}}));
    const sharedPath = '/v1/workspaces?limit=100';
    const namedStudio = nativeCatalog && linkedStudio?.workspace;
    const studioDirectory = namedStudio ? request('GET', sharedPath)
      .catch(() => ({status: 0, body: {}})).then(initial => ({initial, supplemental: null})) : null;
    const linkedDirectory = studioDirectory || startup?.linkedDirectory;
    const studioCode = nativeCatalog && linkedStudio?.workspace ? studio.prepare().then(() => true, () => false) : null;
    const sharedCopyCode = sharedWork ? sharedWorkCopy.prepare().then(() => true, () => false) : null;
    const initialCatalog = nativeCatalog && catalogKind !== 'meetings' && !newKind &&
      !linkedStudio && !requested?.artifact && !requested?.invalid && !catalogQuery()
      ? request('GET', '/v1/workspaces?scope=personal&include=artifacts&order=recent' +
          (linkedWorkspace ? '&workspace=' + linkedWorkspace : '')).catch(() => null)
      : null;
    const session = await sessionRequest;
    if (seq !== workspaceLoad) return;
    if (session.status === 401) {
      workspacePending.hidden = true;
      hideEditor();
      currentUser = null;
      resetMeetings();
      syncStudioWorkspace();
      catalog = null;
      facets = null;
      clearFilters();
      allItems = [];
      listStatus();
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      show('', '');
      await renderProviders();
      return;
    }
    if (session.status !== 200) {
      workspacePending.hidden = true;
      show('error', messageFor(session.body.error, '无法读取会话。'));
      return;
    }
    if (currentUser?.id !== session.body.user.id) resetMeetings();
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = currentUser.username;
    whoami.textContent = currentUser.username;
    // The native Studio GET checks team membership itself. Start it alongside
    // the workspace directory, and use it only for the verified selected team.
    const prepared = namedStudio ? preloadStudio(studioRequest, namedStudio, linkedStudio.id, currentUser.id) : null;
    if (prepared) studioPreload = prepared;
    const personalRequest = initialCatalog?.then(result => {
      const items = result?.body?.items;
      if (result?.status !== 200 || !Array.isArray(items) || items.length !== 1) return null;
      const owner = items[0]?.owner_id;
      const viewer = result.body.viewer_username;
      if ((!owner && !viewer) || (owner && owner !== session.body.user.id) ||
          (viewer && viewer !== session.body.user.username)) return null;
      return result;
    });
    let {initial: space, supplemental} = await (linkedDirectory || readWorkspaceChoices(request, sharedPath, personalRequest));
    if (linkedWorkspace && !space.body.items?.some(item => item.id === linkedWorkspace) && supplemental) {
      const shared = await supplemental;
      if (shared.status === 200) space = shared;
      supplemental = null;
    }
    if (seq !== workspaceLoad) return;
    if (space.status !== 200) {
      cancelStudioPreload();
      workspacePending.hidden = true;
      show('error', '无法读取工作区。');
      return;
    }
    const workspaces = space.body.items || [];
    const personal = sharedWork && workspaces.find(item => item.kind === 'personal');
    fillWorkspaces(workspaces, personal?.id || linkedWorkspace || workspaceId(), {exact: Boolean(linkedWorkspace)});
    void supplemental?.then(shared => {
      if (seq === workspaceLoad && shared.status === 200) fillWorkspaces(shared.body.items, workspaceId());
    });
    if (!workspaces.length) {
      cancelStudioPreload();
      hideEditor();
      catalog = null;
      allItems = [];
      listStatus();
      document.getElementById('artifact-list').textContent = '';
      const emptyMessage = document.getElementById('list-empty-message');
      if (emptyMessage) emptyMessage.textContent = '还没有工作区。';
      renderCatalog();
      if (requested || linkedStudio) show('error', '文档链接无效，或你没有访问该工作区的权限。');
      return;
    }
    const emptyMessage = document.getElementById('list-empty-message');
    if (emptyMessage) emptyMessage.textContent = '这个工作区还没有作品。';
    hideEditor();
    if (sharedWork) {
      void loadList();
      const ready = await sharedCopyCode;
      if (seq !== workspaceLoad) return;
      if (ready && personal && personal.id === workspaceId() && sharedWorkCopy.instance) {
        sharedWorkCopy.instance.open(personal.id, sharedWork);
      }
      else show('error', '无法打开个人空间，请重试。');
      return;
    }
    if (linkedStudio) {
      if (linkedStudio.invalid || workspaceId() !== linkedStudio.workspace) {
        cancelStudioPreload();
        void loadList();
        show('error', '团队文档链接无效，或你没有访问权限。');
        return;
      }
      void loadList();
      const codeReady = await studioCode;
      if (seq !== workspaceLoad) return;
      if (!codeReady) {
        cancelStudioPreload();
        show('error', '无法加载团队协作，请刷新页面重试。');
        return;
      }
      const opening = studio.instance?.open(linkedStudio.id, linkedStudio.revision,
        linkedStudio.catalog ? spaceAddress?.entry.studioFocus : undefined, prepared);
      studioPreload = null;
      if (!await opening) {
        prepared?.controller.abort();
        if (seq === workspaceLoad) show('error', '团队文档链接无效，或你没有访问权限。');
      }
      return;
    }
    if (linkedWorkspace && workspaceId() !== linkedWorkspace && !requested?.artifact) {
      catalog?.controller?.abort();
      catalog?.more?.abort();
      catalog = null;
      allItems = [];
      resetMeetings();
      meetingError = catalogKind === 'meetings' ? '无法打开此工作区的会议资料。请选择其他工作区。' : '';
      listStatus();
      showCatalog();
      if (!meetingError) show('error', newKind || catalogScope === 'automation'
        ? '你没有访问此工作区的权限。请选择可以访问的工作区。'
        : '无法访问此工作区。请选择其他工作区。');
      return;
    }
    if (requested) {
      if (requested.invalid || !workspaces.some(item => item.id === requested.workspace)) {
        show('error', '文档链接无效，或你没有访问该工作区的权限。');
        void loadList();
        return;
      }
      if (requested.artifact) {
        const opening = openEditor({id: requested.artifact}, {workspace: requested.workspace});
        void loadList();
        if (await opening && requested.revision) await openWorkVersion(editor,current,requested.revision);
        return;
      }
    }
    if (newKind) {
      const view = document.defaultView;
      const params = new URLSearchParams(view.location.search);
      params.delete('new');
      const rest = params.toString();
      document.getElementById(newKindButtonId(newKind))?.click();
      if (newKind === 'media' && nativeCatalog) void loadList();
      const conversation = fragment.get('conversation');
      if (current?.kind === newKind && linkedWorkspace && workspaceId() === linkedWorkspace && /^[A-Za-z0-9_-]{1,128}$/.test(conversation || '')) {
        artifactSendOrigin = {wid: linkedWorkspace, conversation, item: current, allowed: false};
        if (newKind === 'slides') void revealSlideContext(artifactSendOrigin);
      }
      writeSpaceAddress(view.location.pathname + (rest ? '?' + rest : '') + view.location.hash);
      return;
    }
    const initial = workspaces.length === 1 && workspaces[0].id === workspaceId() &&
      Array.isArray(space.body.catalog?.items) ? space.body.catalog : undefined;
    await loadList({initial});
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

  workspaceSelect.addEventListener('change', () => {
    if (!canLeaveEditor()) {
      if (editor) workspaceSelect.value = editor.workspace;
      return;
    }
    nextWorkspaceLoad();
    syncWorkspaceCreation();
    closeSendDialog({force:true,restoreFocus:false});
    notifications.setWorkspace(workspaceId());
    syncStudioWorkspace();
    hideEditor();
    show('', '');
    resetMeetings();
    facets = null;
    filterCreators = [];
    filterSessions = [];
    renderFilterControls();
    syncViewUrl();
    void loadList();
  });
  function cancelScheduledSearch() {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = null;
  }

  function updateSearch(immediate = false) {
    cancelScheduledSearch();
    if (clearSearch) clearSearch.hidden = !search.value;
    if (catalogKind === 'meetings') {
      renderMeetings();
      return expandMeetingSearch();
    }
    if (immediate || !search.value.trim() || sameSelection(catalog)) {
      return loadList({reuse: !immediate || catalog?.state !== 'error'});
    }
    catalog?.controller?.abort();
    catalog?.more?.abort();
    const expected = {workspace: workspaceId(), account: currentUser, query: catalogQuery()};
    searchTimer = setTimeout(() => {
      searchTimer = null;
      if (sameSelection(expected) && catalogKind !== 'meetings') void loadList({reuse: true});
    }, CATALOG_SEARCH_DELAY);
    if (!listPanel.hidden) {
      listStatus('正在搜索作品…');
      showCatalog();
    }
  }
  search.addEventListener('input', event => {
    if (!event.isComposing) updateSearch();
  });
  search.addEventListener('compositionend', () => updateSearch());
  function resetSearch() {
    search.value = '';
    search.focus();
    return updateSearch(true);
  }
  clearSearch?.addEventListener('click', resetSearch);
  resetArtifactSearch?.addEventListener('click', () => {
    clearFilters();
    return resetSearch();
  });
  search.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && search.value) {
      event.preventDefault();
      event.stopPropagation?.();
      return resetSearch();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      return updateSearch(true);
    }
  });
  document.getElementById('retry-artifact-list').addEventListener('click', () => loadList());
  pageMore?.addEventListener('click', loadMoreArtifacts);
  document.getElementById('retry-meetings')?.addEventListener('click', () =>
    loadMeetings({append: meetingRetryLimit > 0, limit: meetingRetryLimit || undefined}));
  document.getElementById('more-shared-meetings')?.addEventListener('click', () => loadMeetings({append:true}));

  document.getElementById('new-website').addEventListener('click', () => {
    draftKind = 'website';
    openEditor({kind: 'website'});
  });

  sendSpreadsheet?.addEventListener('click', () => openSendDialog(current));
  sendSlides?.addEventListener('click', () => openSendDialog(current));
  downloadSpreadsheet?.addEventListener('click', () => {
    if (current?.kind === 'spreadsheet' && current.id) {
      globalThis.location.assign(exportHref(current.revision));
    }
  });
  downloadSlides?.addEventListener('click', () => {
    if (current?.kind === 'slides' && current.id) {
      globalThis.location.assign(exportHref(current.revision) + '?format=pptx');
    }
  });
  for (const backId of ['sheet-back', 'slides-back']) {
    document.getElementById(backId)?.addEventListener('click', () => {
      document.getElementById('cancel-editor').click();
    });
  }

  document.getElementById('add-widget').addEventListener('click', () => {
    if (dashboardState.widgets.length >= 20) return;
    dashboardState.widgets.push(widgetDefault('metric'));
    renderDashboardEditor();
  });

  document.getElementById('add-slide').addEventListener('click', () => {
    if (slidesState.slides.length >= 30) return;
    slidesState.slides.push({title: '', bullets: []});
    slideEditCount++;
    renderSlidesEditor(slidesState.slides.length - 1);
  });

  function bindCreate(id, start) {
    const button = document.getElementById(id);
    button?.addEventListener('click', event => {
      if (canCreateInWorkspace()) start(event);
    });
  }

  treeOpen?.addEventListener('click', showDocumentTree);
  document.getElementById('editor-document-tree')?.addEventListener('click', showDocumentTree);
  moveDocument?.addEventListener('click', () => void showDocumentTree({move:true}));
  moveDestination?.addEventListener('change', () => { moveSubmit.disabled = !moveDestination.value; });
  moveDocumentForm?.addEventListener('submit', submitDocumentMove);
  document.getElementById('close-document-tree')?.addEventListener('click', closeDocumentTree);
  treeRetry?.addEventListener('click', () => void showDocumentTree({move:Boolean(documentMove)}));
  treeDialog?.addEventListener('close', () => { if (!treeDialog.open) discardDocumentTree(); });
  editorParentDocument?.addEventListener('click', event => {
    if (!documentClick(event) || !current?.parent) return;
    event.preventDefault();
    void openTreeDocument(current.parent);
  });
  newChildDocument?.addEventListener('click', () => {
    if (current?.id && current.kind === 'document') void startChildDocument(current);
  });

  for (const [id, kind] of [
    ['new-artifact', 'document'], ['new-slides', 'slides'], ['new-spreadsheet', 'spreadsheet'],
    ['new-dashboard', 'dashboard'], ['new-board', 'whiteboard'],
  ]) bindCreate(id, event => {
    draftKind = kind;
    void openEditor({kind}, {focusTitle: event.isTrusted && event.detail === 0});
  });

  const uploadScope = () => canCreateInWorkspace() ? {owner:currentUser.id, workspace:workspaceId()} : null;
  bindCreate('new-media', async event => {
    if (!nativeCatalog) {
      draftKind = 'media';
      void openEditor({kind:'media'}, {focusTitle:event.isTrusted && event.detail === 0});
      return;
    }
    const requested = uploadScope();
    if (!requested || !canLeaveEditor()) return;
    closeNewMenu();
    const sameScope = () => {
      const live = uploadScope();
      return live?.owner === requested.owner && live.workspace === requested.workspace;
    };
    try {
      fileUploadModule ??= import('./upload-files.mjs');
      const {mountSpaceFileUpload} = await fileUploadModule;
      if (!sameScope()) return;
      fileUpload ??= mountSpaceFileUpload(document, {
        scope: uploadScope,
        key: idempotencyKey,
        refresh: () => void loadList({background:true}),
        save(workspace, file, attempt, signal) {
          const formData = new FormData();
          formData.append('title', attempt.title);
          formData.append('kind', 'media');
          formData.append('allow_file', '1');
          formData.append('file', file);
          return sendFile(`/v1/workspaces/${workspace}/artifacts`, formData, attempt.key,
            AbortSignal.any([signal, AbortSignal.timeout(30000)]));
        },
      });
      fileUpload.open();
    } catch {
      fileUploadModule = null;
      if (sameScope()) show('error', '无法打开上传窗口，请重试。');
    }
  });

  bindCreate('empty-new-document', () => {
    draftKind = 'document';
    openEditor({kind: 'document'});
  });

  for (const kind of ['document', 'website']) {
    bindCreate('resume-draft-' + kind, () => document.getElementById(newKindButtonId(kind))?.click());
  }

  bindCreate('empty-agent-website', () => { closeNewMenu(); openWebsiteBriefDialog(); });
  const createAgentDocument = document.getElementById('new-agent-document');
  if (createAgentDocument) createAgentDocument.hidden = !nativeCatalog;
  bindCreate('new-agent-document', async () => {
    if (await openEditor({kind:'document'}) && acceptsDocumentDraft(editor)) {
      documentDraftPanel.open = true;
      documentDraftPrompt.focus();
    }
  });
  bindCreate('new-agent-website', () => { closeNewMenu(); openWebsiteBriefDialog(); });
  bindCreate('empty-save-message', () => { closeNewMenu(); openSaveMessageDialog(); });
  bindCreate('empty-starred-save-message', () => { closeNewMenu(); openSaveMessageDialog(); });
  bindCreate('new-save-message', () => { closeNewMenu(); openSaveMessageDialog(); });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) closeFilterPanel({focus: true});
  });

  for (const button of document.querySelectorAll('.artifact-kinds [data-kind]')) {
    button.addEventListener('click', async () => {
      if (editor && !canLeaveEditor()) return;
      if (editor) hideEditor();
      const kind = button.getAttribute('data-kind') || 'all';
      const scope = kind === 'meetings' ? 'all' : catalogScope;
      applyView(kind, scope);
      await loadList({reuse: true});
    });
  }
  for (const button of document.querySelectorAll('.artifact-scopes [data-scope]')) {
    button.addEventListener('click', async () => {
      if (editor && !canLeaveEditor()) return;
      if (editor) hideEditor();
      applyView('all', button.getAttribute('data-scope') || 'all');
      await loadList({reuse: true});
    });
  }
  function selectMeetingScope(scope) {
    meetingScope = scope;
    focusedMeeting = '';
    syncMeetingScope();
    syncViewUrl();
    renderCatalog();
  }
  meetingTabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectMeetingScope(tab.dataset.meetingScope));
    tab.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      let next;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = meetingTabs.length - 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        next = (index + direction + meetingTabs.length) % meetingTabs.length;
      }
      else return;
      event.preventDefault();
      selectMeetingScope(meetingTabs[next].dataset.meetingScope);
      meetingTabs[next].focus();
    });
  });
  document.getElementById('meetings-show-all')?.addEventListener('click', () => {
    selectMeetingScope('all');
    meetingTabs.find(tab => tab.dataset.meetingScope === 'all')?.focus();
  });
  const layoutTabs = [...document.querySelectorAll('#layout-toggle [data-layout]')];
  function selectLayout(button) {
    catalogLayout = applyArtifactLayout(document.getElementById('artifact-list'), button.dataset.layout);
    for (const tab of layoutTabs) {
      const selected = tab === button;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
  }
  layoutTabs.forEach((button, index) => {
    button.addEventListener('click', () => selectLayout(button));
    button.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const last = layoutTabs.length - 1;
      let next;
      switch (event.key) {
        case 'Home': next = 0; break;
        case 'End': next = last; break;
        case 'ArrowLeft': next = index === 0 ? last : index - 1; break;
        case 'ArrowRight': next = index === last ? 0 : index + 1; break;
        default: return;
      }
      event.preventDefault();
      selectLayout(layoutTabs[next]);
      layoutTabs[next].focus();
    });
  });
  const collapseButton = document.getElementById('dir-collapse');
  const expandButton = document.getElementById('dir-expand');
  if (collapseButton) {
    collapseButton.addEventListener('click', (event) => {
      event.stopPropagation();
      applyDirectoryCollapsed(document, true);
    });
  }
  if (expandButton) {
    expandButton.addEventListener('click', (event) => {
      event.stopPropagation();
      applyDirectoryCollapsed(document, false);
    });
  }
  if (filterButton && filterPanel) {
    filterButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!filterPanel.hidden) {
        closeFilterPanel();
        return;
      }
      filterPanel.hidden = false;
      filterButton.setAttribute('aria-expanded', 'true');
      void loadFacets();
    });
  }
  for (const button of document.querySelectorAll('.filter-accordion')) {
    button.addEventListener('click', () => {
      const section = button.closest('.filter-section');
      const open = button.getAttribute('aria-expanded') !== 'true';
      for (const other of document.querySelectorAll('.filter-section')) {
        const accordion = other.querySelector('.filter-accordion');
        const body = other.querySelector('.filter-body');
        const expanded = open && other === section;
        if (accordion) accordion.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (body) body.hidden = !expanded;
      }
    });
  }
  filterPanel?.addEventListener('change', ({target}) => {
    if (['file-type', 'creator', 'session', 'modified', 'modified-start', 'modified-end'].includes(target?.name)) {
      return applyFilters({dates: target.name.startsWith('modified')});
    }
  });
  filterReset?.addEventListener('click', () => {
    const previous = catalogQuery();
    clearFilters();
    return refreshFilters(previous);
  });
  document.addEventListener('click', (event) => {
    const wrap = document.querySelector('.filter-wrap');
    if (wrap && !wrap.contains(event.target)) closeFilterPanel();
    if (mobileMenu?.open && !mobileMenu.contains(event.target)) {
      pendingDeleteCancel?.();
      mobileMenu.open = false;
    }
  });

  mobileMenu?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !mobileMenu.open || pendingDeleteCancel) return;
    event.preventDefault();
    mobileMenu.open = false;
    mobileMore?.focus();
  });
  for (const [name, button] of mobilePanels) {
    button?.addEventListener('click', () => {
      const panel = editorPanels.get(name);
      if (!activeEditor(editor) || !current?.id || !panel || panel.hidden) return;
      pendingDeleteCancel?.();
      mobileMenu.open = false;
      panel.open = true;
      panel.querySelector?.('summary')?.focus?.();
    });
  }
  mobileMarkdown?.addEventListener('click', () => {
    if (!activeEditor(editor) || current?.kind !== 'document') return;
    pendingDeleteCancel?.();
    mobileMenu.open = false;
    document.getElementById('document-source-toggle')?.click();
  });
  document.getElementById('mobile-editor-reconnect')?.addEventListener('click', () => {
    if (!activeEditor(editor)) return;
    pendingDeleteCancel?.();
    mobileMenu.open = false;
    mobileMore?.focus();
    document.getElementById('workspace-events-retry')?.click();
  });

  function returnToCatalog() {
    if (approvedBack || !canLeaveEditor()) return false;
    const focusNew = editor?.focusTitle && !editor?.catalogView?.focus;
    const history = document.defaultView?.history;
    if (spaceAddress?.entry.fromCatalog && typeof history?.back === 'function') {
      approvedBack = true;
      history.back();
      return true;
    }
    hideEditor();
    show('', '');
    if (artifactTargetFromSearch(document.defaultView?.location?.search)) syncViewUrl();
    void loadList({reuse: true});
    if (focusNew) newMenuButton?.focus({preventScroll: true});
    return true;
  }

  document.getElementById('cancel-editor').addEventListener('click', returnToCatalog);
  document.getElementById('cancel-editor-load').addEventListener('click', () => {
    if (returnToCatalog()) document.getElementById('new-menu-button')?.focus?.({preventScroll: true});
  });

  async function sendFile(path, body, key, signal) {
    const headers = {'Accept':'application/json', 'X-CSRF-Token':csrfCookie(document.cookie)};
    if (key) headers['Idempotency-Key'] = key;
    const response = await fetcher(path, {method:'POST', headers, credentials:'same-origin', body, signal});
    return {status:response.status, body:await response.json().catch(() => ({}))};
  }

  async function uploadMedia(path, extraFields) {
    const file = document.getElementById('media-file').files[0];
    const title = form.elements.title.value.trim();
    if (!title) {
      show('error', '请填写标题。');
      return null;
    }
    if (!file && !(current && current.id)) {
      show('error', '请选择一个媒体文件。');
      return null;
    }
    if (!file && current && current.id) {
      return request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                     {revision: current.revision, changes: {title}});
    }
    const body = new FormData();
    body.append('title', title);
    body.append('kind', 'media');
    body.append('file', file);
    if (extraFields) Object.entries(extraFields).forEach(([key, value]) => body.append(key, value));
    return sendFile(path, body, current?.id ? null : idempotencyKey());
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const selection = editor;
    if (!activeEditor(selection) || !current || form.hidden || selection.saving || form.inert) return;
    if (websiteInteractive) renderWebsitePreview();
    selection.saving = true;
    setSaving(true);
    try {
    if (!workspaceId()) {
      show('error', '先选择一个工作区。');
      return;
    }
    const submitted = editorDraft();
    const title = form.elements.title.value.trim();
    const body = form.elements.body.value;
    const kind = (current && current.kind) || draftKind;
    if (!title) {
      show('error', '请填写标题。');
      return;
    }
    let result;
    if (kind === 'media') {
      result = await uploadMedia(
        current && current.id
          ? `/v1/workspaces/${workspaceId()}/artifacts/${current.id}/file`
          : `/v1/workspaces/${workspaceId()}/artifacts`,
        current && current.id ? {revision: String(current.revision)} : null,
      );
      if (!result) return;
    } else if (kind === 'slides') {
      const slides = slidesDeck();
      if (!slides.slides.length) {
        show('error', '至少添加一页幻灯片。');
        return;
      }
      for (const [index, slide] of slides.slides.entries()) {
        if (!slide.title && !slide.bullets.length) {
          show('error', '请填写第 ' + (index + 1) + ' 页的标题或要点。');
          return;
        }
        if (slide.bullets.length > 10 || slide.bullets.some(bullet => bullet.length > 200)) {
          show('error', '第 ' + (index + 1) + ' 页最多 10 条要点，每条最多 200 字。');
          return;
        }
      }
      form.inert = true;
      if (current && current.id) {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                               {revision: current.revision, changes: {title, slides}});
      } else {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                               {title, kind: 'slides', slides},
                               {'Idempotency-Key': idempotencyKey()});
      }
    } else if (kind === 'spreadsheet') {
      form.inert = true;
      const workbook = spreadsheet.instance.value();
      if (current?.id) {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                               {revision: current.revision, changes: {title, spreadsheet: workbook}});
      } else {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                               {title, kind, spreadsheet: workbook}, {'Idempotency-Key': idempotencyKey()});
      }
    } else if (kind === 'dashboard') {
      const value = dashboardValue();
      if (!value.widgets.length) {
        show('error', '至少添加一个看板组件。');
        return;
      }
      for (const widget of value.widgets) {
        if (!widget.title.trim()) {
          show('error', '每个看板组件都需要标题。');
          return;
        }
        if (widget.type === 'table'
            && (!widget.columns.length || widget.rows.some(row => row.length !== widget.columns.length))) {
          show('error', '表格的列名和每行单元格数量需要一致。');
          return;
        }
        if (widget.type === 'bar'
            && (!widget.labels.length || widget.labels.length !== widget.values.length)) {
          show('error', '条形图的标签和数值数量需要一致。');
          return;
        }
      }
      if (current && current.id) {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                               {revision: current.revision, changes: {title, dashboard: value}});
      } else {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                               {title, kind: 'dashboard', dashboard: value},
                               {'Idempotency-Key': idempotencyKey()});
      }
    } else if (kind === 'whiteboard') {
      if (current && current.id) {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                               {revision: current.revision, changes: {title, board: boardState}});
      } else {
        result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                               {title, kind: 'whiteboard', board: boardState},
                               {'Idempotency-Key': idempotencyKey()});
      }
    } else if (current && current.id) {
      result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts/${current.id}`,
                             {revision: current.revision, changes: {title, body}});
    } else {
      const payload = {title, body, kind};
      if (current?.parent) payload.parent_id = current.parent.id;
      const fingerprint = JSON.stringify(payload);
      if (selection.createReceipt?.fingerprint !== fingerprint) {
        selection.createReceipt = {fingerprint, key:idempotencyKey()};
      }
      result = await request('POST', `/v1/workspaces/${workspaceId()}/artifacts`,
                             payload, {'Idempotency-Key':selection.createReceipt.key});
    }
    if (result.status === 200 || result.status === 201) {
      if (catalog?.workspace === selection.workspace && catalog.account === selection.account) {
        catalog = null;
        if (!listPanel.hidden && workspaceId() === selection.workspace) void loadList();
      }
    }
    if (!activeEditor(selection)) return;
    if (revealRevisionConflict(result)) {
      show('error', '保存遇到新版本，请先查看服务器版本。');
      return;
    }
    if (result.body.error?.code === 'title_conflict' ||
        result.body.error?.message === 'A document with this title already exists') {
      show('error', '这个工作区已有同名作品，请修改标题后保存。');
      form.inert = false;
      form.elements.title.focus();
      return;
    }
    if (result.status !== 200 && result.status !== 201) {
      show('error', messageFor(result.body.error, '保存失败。'));
      return;
    }
    const isNew = !current?.id;
    const recoveryKey = draftKey();
    if (readDraft(recoveryKey)?.revision === (current.revision ?? null)) removeDraft(recoveryKey);
    if (artifactSendOrigin?.item === current) artifactSendOrigin.item = result.body.artifact;
    current = result.body.artifact;
    draftKind = current.kind || draftKind;
    const newerDraft = editorDraftChanged(submitted);
    if (newerDraft) {
      selection.cleanDraft = submitted;
      updateEditorMeta(current, kind);
    } else {
      if (kind === 'media') document.getElementById('media-file').value = '';
      fillEditor(current);
    }
    if (newerDraft) persistDraft();
    readEditorRecovery();
    if (isNew) recordEditorAddress(selection, current);
    document.getElementById('artifact-live-update').hidden = true;
    updateMobileActions();
    document.getElementById('remove-artifact').hidden = false;
    if (isNew) resetEditorPanels();
    for (const [name, panel] of editorPanels) {
      if (panel.open) void panelLoads[name]();
    }
    show('ok', newerDraft ? '已保存。编辑器内还有新的未保存修改。' : '已保存。');
    } catch {
      if (activeEditor(selection)) show('error', '网络错误，未能确认保存结果。请重新打开作品检查后再重试。');
    } finally {
      selection.saving = false;
      if (activeEditor(selection)) {
        form.inert = false;
        setSaving(false);
      }
    }
  });

  function askDeleteConfirmation(trigger) {
    const target = {workspace: workspaceId(), id: current && current.id};
    const prompt = artifactDeletePrompt(current);
    const box = document.createElement('div');
    box.className = 'inline-confirm';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-labelledby', 'remove-artifact-question');
    const question = document.createElement('span');
    question.id = 'remove-artifact-question';
    question.textContent = prompt.question;
    const detail = document.createElement('span');
    detail.className = 'note';
    detail.textContent = prompt.detail;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = prompt.cancelLabel;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = prompt.confirmLabel;
    box.appendChild(question);
    box.appendChild(detail);
    box.appendChild(cancel);
    box.appendChild(confirm);
    trigger.hidden = true;
    const parent = trigger.parentNode;
    if (parent && typeof parent.insertBefore === 'function') parent.insertBefore(box, trigger.nextSibling || null);
    else form.appendChild(box);
    if (typeof cancel.focus === 'function') cancel.focus();

    return new Promise(resolve => {
      let settled = false;
      const finish = answer => {
        if (settled) return;
        settled = true;
        pendingDeleteCancel = null;
        document.removeEventListener('keydown', onKey);
        box.remove();
        trigger.hidden = false;
        if (!answer && typeof trigger.focus === 'function') trigger.focus();
        resolve(answer ? target : null);
      };
      const onKey = event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      };
      pendingDeleteCancel = () => finish(false);
      cancel.addEventListener('click', () => finish(false));
      confirm.addEventListener('click', () => finish(true));
      document.addEventListener('keydown', onKey);
    });
  }


  let spaceActionDialog = null;

  function closeSpaceActionDialog() {
    if (spaceActionDialog && spaceActionDialog.parentNode) spaceActionDialog.parentNode.removeChild(spaceActionDialog);
    spaceActionDialog = null;
  }

  function spaceDialogHost() {
    return mainPanel || listPanel || form;
  }

  function openSpaceDialog(id, titleText) {
    closeSpaceActionDialog();
    closeAgentTaskDialog();
    const dialog = document.createElement('div');
    dialog.id = id;
    dialog.className = 'send-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', id + '-title');
    const card = document.createElement('div');
    card.className = 'send-dialog-card';
    const heading = document.createElement('h2');
    heading.id = id + '-title';
    heading.textContent = titleText;
    const note = document.createElement('p');
    note.className = 'note';
    note.hidden = true;
    card.appendChild(heading);
    card.appendChild(note);
    dialog.appendChild(card);
    const host = spaceDialogHost();
    if (host && typeof host.appendChild === 'function') host.appendChild(dialog);
    spaceActionDialog = dialog;
    return {dialog, card, note, heading};
  }

  async function openWebsiteBriefDialog() {
    const workspace = workspaceId();
    if (!workspace || !currentUser) { show('error', '先选择一个工作区。'); return; }
    const account = currentUser;
    const ui = openSpaceDialog('website-brief-dialog', '让智能体搭建网站');
    const active = () => spaceActionDialog === ui.dialog && currentUser === account && workspaceId() === workspace;
    const base = `/v1/workspaces/${workspace}`;
    const failed = () => ({status: 0, body: {}});
    const brief = document.createElement('textarea');
    brief.id = 'website-brief';
    brief.rows = 6;
    brief.maxLength = 4000;
    brief.placeholder = '描述网站要做什么、给谁看、需要哪些栏目。';
    const agentLabel = document.createElement('label');
    agentLabel.textContent = '智能体';
    const agentSelect = document.createElement('select');
    agentSelect.id = 'website-brief-agent';
    agentLabel.appendChild(agentSelect);
    const actions = document.createElement('div');
    actions.className = 'space-action-row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => closeSpaceActionDialog());
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = '创建并发送请求';
    actions.append(cancel, submit);
    ui.card.append(brief, agentLabel, actions);
    const [agents, personal] = await Promise.all([
      request('GET', base + '/agents?limit=100').catch(failed),
      request('GET', '/v1/personal-agent').catch(failed),
    ]);
    if (!active()) return;
    const options = [];
    const personalAgent = personal.status === 200 ? personal.body.personal_agent : null;
    if (personalAgent && personalAgent.agent && personalAgent.workspace && personalAgent.workspace.id === workspace) {
      const agent = personalAgent.agent;
      options.push({id: agent.id, name: (agent.name || '个人智能体') + '（个人）'});
    }
    if (agents.status === 200) {
      for (const agent of agents.body.items || []) {
        if (options.some((row) => row.id === agent.id)) continue;
        options.push({id: agent.id, name: agent.name || '智能体'});
      }
    }
    if (!options.length) {
      ui.note.hidden = false;
      ui.note.textContent = '这个工作区还没有可选用的智能体，无法发出搭建请求。';
      submit.disabled = true;
    }
    for (const option of options) {
      const row = document.createElement('option');
      row.value = option.id;
      row.textContent = option.name;
      agentSelect.append(row);
    }
    submit.addEventListener('click', async () => {
      if (!active()) return;
      const text = brief.value.trim();
      if (!text) { ui.note.hidden = false; ui.note.textContent = '请先填写网站需求。'; return; }
      const agent = agentSelect.value;
      if (!agent) { ui.note.hidden = false; ui.note.textContent = '请选择一个智能体。'; return; }
      submit.disabled = true;
      const title = websiteTitle(text);
      const created = await request('POST', base + '/artifacts', {
        title, kind: 'website', body: websiteStub(text),
      }, {'Idempotency-Key': idempotencyKey('site-brief-')}).catch(failed);
      if (!active()) return;
      if (created.status !== 201 && created.status !== 200) {
        submit.disabled = false;
        ui.note.hidden = false;
        ui.note.textContent = messageFor(created.body.error, '无法创建网站作品。');
        return;
      }
      const artifact = created.body.artifact;
      const finish = (kind, text) => {
        closeSpaceActionDialog();
        if (catalogScope !== 'all') { catalogScope = 'all'; syncViewUrl(); }
        if (artifact?.id) void openEditor(artifact, {workspace, notice: {kind, text}});
        else show(kind, text);
        void loadList();
      };
      const conversations = base + '/agents/' + encodeURIComponent(agent) + '/conversations';
      const conversation = await request('POST', conversations, {title},
        {'Idempotency-Key': idempotencyKey('site-conv-')}).catch(failed);
      if (!active()) return;
      if (conversation.status !== 201 && conversation.status !== 200) {
        finish('error', '网站作品已创建，但未能打开智能体会话：' + messageFor(conversation.body.error, '请稍后重试。'));
        return;
      }
      const conv = conversation.body.conversation;
      const sent = await request('POST', conversations + '/' + encodeURIComponent(conv.id) + '/messages', {
        body: websitePrompt(title, text),
      }, {'Idempotency-Key': idempotencyKey('site-msg-')}).catch(failed);
      if (!active()) return;
      if (sent.status !== 201 && sent.status !== 200) {
        finish('error', '网站作品已创建，但搭建请求发送失败：' + messageFor(sent.body.error, '请打开对话后重试。'));
      } else {
        finish('ok', describeWebsiteDispatch(sent.body.reply || sent.body.message));
      }
    });
    if (typeof brief.focus === 'function') brief.focus();
  }

  async function openSaveMessageDialog() {
    const workspace = workspaceId();
    if (!workspace) { show('error', '先选择一个工作区。'); return; }
    const ui = openSpaceDialog('save-message-dialog', '保存聊天中的消息');
    const account = currentUser;
    const current = () => spaceActionDialog === ui.dialog && currentUser === account && workspaceId() === workspace;
    const feedback = text => {
      ui.note.hidden = !text;
      ui.note.textContent = text;
    };
    ui.note.setAttribute('role', 'status');

    const label = document.createElement('label');
    label.textContent = '会话';
    const select = document.createElement('select');
    select.id = 'save-message-conversation';
    select.disabled = true;
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = '选择要查看的会话';
    select.append(prompt);
    label.append(select);
    const list = document.createElement('ul');
    list.id = 'save-message-list';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.addEventListener('click', closeSpaceActionDialog);
    ui.card.append(label, list, close);
    feedback('正在加载会话…');

    const base = `/v1/workspaces/${workspace}`;
    const get = suffix => request('GET', base + suffix).catch(() => ({status: 0, body: {}}));
    const [social, agents] = await Promise.all([
      get('/social/conversations?limit=100'),
      get('/agents?limit=100&include=conversations'),
    ]);
    if (!current()) return;
    const conversations = [
      ...(social.body.items || []).map(row => ({...row, label: conversationLabel(row), social: true})),
      ...agentConversations(agents.body, {includeArchived: true}),
    ].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    const incomplete = social.status !== 200 || agents.status !== 200 || !Array.isArray(agents.body.conversations);
    feedback(incomplete ? '部分会话无法加载。' : (conversations.length ? '' : '这个工作区还没有会话。'));
    if (!conversations.length) return;
    conversations.forEach((row, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = row.label;
      select.append(option);
    });
    select.disabled = false;
    select.focus();

    let search = 0;
    select.addEventListener('change', async () => {
      const selected = ++search;
      list.replaceChildren();
      const conversation = conversations[select.value === '' ? -1 : Number(select.value)];
      if (!conversation) { feedback(''); return; }
      feedback('正在加载消息…');
      const path = conversation.social ? `/social/conversations/${conversation.id}/messages?limit=20`
        : `/agents/${conversation.agent_id}/conversations/${conversation.id}`;
      const result = await get(path);
      if (!current() || selected !== search) return;
      if (result.status !== 200) { feedback('无法加载消息，请重试。'); return; }
      const items = (result.body.items || []).filter(conversation.social ? saveableSocialMessage : saveableAgentMessage);
      feedback(items.length ? '' : '这段会话还没有可保存的文字消息。');
      for (const item of items.slice(-20).reverse()) {
        const row = document.createElement('li');
        const preview = document.createElement('span');
        preview.textContent = defaultSaveTitle(item.body);
        const save = document.createElement('button');
        save.type = 'button';
        save.textContent = '保存';
        save.addEventListener('click', async () => {
          const endpoint = conversation.social ? socialSavePath(workspace, conversation.id, item.id)
            : agentSavePath(workspace, conversation.agent_id, conversation.id, item.id);
          const body = {title: preview.textContent};
          if (conversation.social) body.revision = item.revision || 1;
          save.disabled = true;
          feedback('');
          try {
            const saved = await request('POST', endpoint, body);
            if (!current() || selected !== search) return;
            if (saved.status !== 200 && saved.status !== 201) {
              feedback(messageFor(saved.body.error, '保存失败，请重试。'));
              return;
            }
            closeSpaceActionDialog();
            const text = saved.status === 201 ? '已保存为文档。' : '已打开已有副本。';
            if (catalogScope !== 'all') { catalogScope = 'all'; syncViewUrl(); }
            if (saved.body.artifact) void openEditor(saved.body.artifact, {workspace, notice: {kind: 'ok', text}});
            else show('ok', text);
            void loadList();
          } catch {
            if (current() && selected === search) feedback('无法确认保存结果，请重试。');
          } finally {
            save.disabled = false;
          }
        });
        row.append(preview, save);
        list.append(row);
      }
    });
  }


  let agentTaskDialog = null;

  function closeAgentTaskDialog() {
    if (agentTaskDialog && agentTaskDialog.parentNode) agentTaskDialog.parentNode.removeChild(agentTaskDialog);
    agentTaskDialog = null;
    const opener = document.getElementById('empty-save-agent');
    if (opener) opener.disabled = false;
    if (opener && typeof opener.focus === 'function') opener.focus();
  }

  async function openAgentTaskDialog() {
    const opener = document.getElementById('empty-save-agent');
    const workspace = workspaceId();
    const account = currentUser;
    if (agentTaskDialog || !workspace || !account) return;
    if (opener) opener.disabled = true;
    const dialog = document.createElement('div');
    dialog.id = 'agent-task-dialog';
    dialog.className = 'send-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'agent-task-title');
    const card = document.createElement('div');
    card.className = 'send-dialog-card';
    const heading = document.createElement('h2');
    heading.id = 'agent-task-title';
    heading.textContent = '保存智能体成果';
    const note = document.createElement('p');
    note.id = 'agent-task-note';
    note.className = 'note';
    note.hidden = true;
    const taskList = document.createElement('ul');
    taskList.id = 'agent-task-list';
    const close = document.createElement('button');
    close.id = 'agent-task-close';
    close.type = 'button';
    close.textContent = '关闭';
    close.addEventListener('click', () => closeAgentTaskDialog());
    card.appendChild(heading);
    card.appendChild(note);
    card.appendChild(taskList);
    card.appendChild(close);
    dialog.appendChild(card);
    const host = mainPanel || listPanel || form.parentNode;
    if (host && typeof host.appendChild === 'function') host.appendChild(dialog);
    else if (form && typeof form.appendChild === 'function') form.appendChild(dialog);
    agentTaskDialog = dialog;
    const active = () => agentTaskDialog === dialog && currentUser === account && workspaceId() === workspace;
    const failed = () => ({status: 0, body: {}});
    if (typeof close.focus === 'function') close.focus();

    const listed = await request('GET', '/v1/skills/runs').catch(failed);
    if (!active()) return;
    if (listed.status !== 200) {
      note.hidden = false;
      note.textContent = taskArtifactError(listed.status, listed.body, '读取任务列表失败。');
      if (opener) opener.disabled = false;
      return;
    }
    const tasks = savableTaskArtifacts(listed.body && listed.body.items);
    if (!tasks.length) {
      note.hidden = false;
      note.textContent = '没有可保存的已完成任务：任务需要有成功的文本结果。';
    }
    for (const task of tasks) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = taskArtifactTitle(task);
      const save = document.createElement('button');
      save.type = 'button';
      save.textContent = '保存';
      save.addEventListener('click', async () => {
        if (!active()) return;
        save.disabled = true;
        note.hidden = true;
        const saved = await request('POST', `/v1/skills/runs/${task.id}/artifact`, {workspace_id: workspace}).catch(failed);
        if (!active()) return;
        if (saved.status === 200 || saved.status === 201) {
          closeAgentTaskDialog();
          show('ok', '已保存。');
          if (catalogScope !== 'all') { catalogScope = 'all'; syncViewUrl(); }
          await loadList();
          return;
        }
        save.disabled = false;
        note.hidden = false;
        note.textContent = taskArtifactError(saved.status, saved.body);
      });
      row.appendChild(label);
      row.appendChild(save);
      taskList.appendChild(row);
    }
  }

  document.getElementById('empty-save-agent').addEventListener('click', async () => {
    await openAgentTaskDialog();
  });

  async function removeArtifact(trigger) {
    const selection = editor;
    if (!activeEditor(selection) || !current?.id || pendingDeleteCancel) return;
    const target = await askDeleteConfirmation(trigger);
    if (!target || editor !== selection) return;
    if (trigger === mobileDelete) {
      mobileMenu.open = false;
      mobileMore?.focus();
    }
    const result = await request('POST', editorPath(selection, target.id) + '/remove', {})
      .catch(() => ({status: 0, body: {}}));
    if (result.status === 200 && catalog?.workspace === target.workspace && catalog.account === selection.account) {
      catalog = null;
      if (!listPanel.hidden && workspaceId() === target.workspace) void loadList();
    }
    if (!activeEditor(selection)) return;
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '删除失败。'));
      return;
    }
    returnToCatalog();
    show('ok', '已删除。');
  }
  const desktopDelete = document.getElementById('remove-artifact');
  desktopDelete.addEventListener('click', () => removeArtifact(desktopDelete));
  mobileDelete?.addEventListener('click', () => removeArtifact(mobileDelete));

  const canvas = document.getElementById('board-canvas');
  canvas.addEventListener('pointerdown', event => {
    if (document.getElementById('board-editor').hidden) return;
    event.preventDefault();
    const point = canvasPoint(event);
    const color = document.getElementById('board-color').value || '#111111';
    if (boardTool === 'text') {
      const text = globalThis.prompt('文字', '');
      if (text) {
        boardState.strokes = boardState.strokes.concat([{id: strokeId(), type: 'text', color, x: point[0], y: point[1], size: 16, text: text.slice(0, 200)}]);
        drawBoard();
      }
      return;
    }
    drawing = {id: strokeId(), type: boardTool, color, width: 2, x: point[0], y: point[1], points: [point]};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drawing) return;
    const point = canvasPoint(event);
    if (drawing.type === 'path') drawing.points.push(point);
    else {
      drawing.width = Math.max(1, point[0] - drawing.x);
      drawing.height = Math.max(1, point[1] - drawing.y);
    }
    const live = boardState.strokes.concat([drawing]);
    const saved = boardState.strokes;
    boardState.strokes = live;
    drawBoard();
    boardState.strokes = saved;
  });
  canvas.addEventListener('pointerup', event => {
    if (!drawing) return;
    const point = canvasPoint(event);
    let stroke = drawing;
    if (drawing.type === 'path') {
      drawing.points.push(point);
      if (drawing.points.length >= 2) stroke = {id: drawing.id, type: 'path', color: drawing.color, width: 2, points: drawing.points};
      else stroke = null;
    } else {
      stroke = {id: drawing.id, type: 'rect', color: drawing.color, x: drawing.x, y: drawing.y, width: Math.max(1, point[0] - drawing.x), height: Math.max(1, point[1] - drawing.y)};
    }
    drawing = null;
    if (stroke) boardState.strokes = boardState.strokes.concat([stroke]);
    drawBoard();
  });
  document.getElementById('board-draw').addEventListener('click', () => { boardTool = 'path'; });
  document.getElementById('board-rect').addEventListener('click', () => { boardTool = 'rect'; });
  document.getElementById('board-text').addEventListener('click', () => { boardTool = 'text'; });
  document.getElementById('board-clear').addEventListener('click', () => {
    boardState.strokes = [];
    drawBoard();
  });

  // The publish controls live inside #editor-form; a nested <form> would be
  // dropped by the HTML parser and close the editor form early, so this is a
  // plain group with a button handler (Enter in the slug field publishes too).
  discoverSlug?.addEventListener('input', () => {
    if (activeEditor(editor)) editor.discoverSlugEdited = true;
  });
  discoverTopic?.addEventListener('change', () => {
    if (activeEditor(editor)) editor.discoverTopicEdited = true;
  });
  discoverEditable?.addEventListener('change', () => {
    if (activeEditor(editor)) editor.discoverEditableEdited = true;
  });
  discoverSlug?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      publishDiscover?.click();
    }
  });
  publishDiscover?.addEventListener('click', () => changeDiscoverListing(true));
  revokeDiscover?.addEventListener('click', () => changeDiscoverListing(false));

  const createShareButton = document.getElementById('create-share');
  createShareButton.addEventListener('click', () => {
    if (!current || !current.id || !workspaceId()) {
      show('error', '请先保存作品，再创建分享链接。');
      return;
    }
    if (!activeEditor(editor)) return;
    void changeShare(editor, editorPath(editor) + '/shares', {create: true, button: createShareButton});
  });
  document.getElementById('copy-share').addEventListener('click', copyShareLink);

  document.getElementById('export-artifact').addEventListener('click', () => {
    if (!current || !current.id || !workspaceId()) {
      show('error', '请先保存作品，再导出。');
      return;
    }
    const format=document.getElementById('export-format')?.value||'original';
    if((format==='docx'&&current.kind!=='document')||(format==='xlsx'&&!['dashboard','spreadsheet'].includes(current.kind))||(format==='pdf'&&!['document','slides','dashboard'].includes(current.kind))){
      show('error','此格式不支持当前作品类型；请按格式说明选择，或使用原格式。');return;
    }
    globalThis.location.assign(exportHref());
  });

  document.getElementById('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!canLeaveEditor()) return;
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '退出失败。'));
      return;
    }
    nextWorkspaceLoad();
    hideEditor();
    currentUser = null;
    syncStudioWorkspace();
    workspaceSelect.textContent = '';
    catalog = null;
    facets = null;
    clearFilters();
    allItems = [];
    resetMeetings();
    activity.setScope('');
    mainPanel.hidden = true;
    await load();
  });

  const view = document.defaultView;
  const initial = viewFromSearch(view && view.location && view.location.search);
  readFilterDates();
  renderFilterControls();
  applyView(initial.kind, initial.scope, {sync: false});
  if (view) {
    if (restoredSpaceEntry) spaceAddress = {url:spaceLocation(), state:previousSpaceState, entry:restoredSpaceEntry};
    else writeSpaceAddress(spaceLocation());
    view.addEventListener('popstate', async event => {
      if (restoringAddress) {
        restoringAddress = false;
        return;
      }
      const next = event?.state?.flybotWorkspaceSpace;
      const tracked = next?.session === spaceHistoryId;
      const approved = approvedBack;
      approvedBack = false;
      if (!approved && (!canLeaveEditor() || studio.instance?.canLeave() === false)) {
        if (spaceAddress) {
          const delta = tracked ? spaceAddress.entry.position - next.position : 0;
          if (delta && typeof view.history?.go === 'function') {
            restoringAddress = true;
            view.history.go(delta);
          } else view.history?.replaceState(spaceAddress.state, '', spaceAddress.url);
        }
        return;
      }
      if (tracked) spaceAddress = {url:spaceLocation(), state:event.state, entry:next};
      else writeSpaceAddress(spaceLocation());
      const address = spaceAddress;
      nextWorkspaceLoad();
      hideEditor();
      sharedWorkCopy.instance?.close();
      studio.instance?.leaveForNavigation();
      show('', '');
      const catalogView = tracked && currentUser?.id && next.catalogView?.account === currentUser.id
        ? next.catalogView : null;
      const {kind, scope} = catalogView || viewFromSearch(view.location.search);
      applyView(kind, scope, {sync: false});
      const studioTarget = studioTargetFromSearch(view.location.search);
      if (studio.instance && studioTarget && !studioTarget.invalid && workspaceResolved && workspaceId() === studioTarget.workspace) {
        void studio.instance.open(studioTarget.id, studioTarget.revision, studioTarget.catalog ? address?.entry.studioFocus : undefined);
        return;
      }
      const requested = artifactTargetFromSearch(view.location.search);
      if (studioTarget || requested?.artifact || requested?.invalid ||
          newKindFromSearch(view.location.search) || sharedWorkCopyToken(view.location.hash)) {
        void load();
        return;
      }
      const targetWorkspace = requested?.workspace || catalogView?.workspace || workspaceFromFragment(view.location.hash);
      if (targetWorkspace && ![...workspaceSelect.options].some(option => option.value === targetWorkspace)) {
        void load();
        return;
      }
      if (targetWorkspace && workspaceId() !== targetWorkspace) {
        workspaceSelect.value = targetWorkspace;
        notifications.setWorkspace(workspaceId());
        syncStudioWorkspace();
      }
      const returningToCatalog = catalogView?.workspace === workspaceId();
      if (returningToCatalog) restoreCatalogFilters(catalogView);
      await loadList({reuse: true, minDepth:returningToCatalog ? catalogView.depth : undefined});
      if (returningToCatalog && spaceAddress === address && !listPanel.hidden) {
        catalogScrollers.forEach((node, index) => {
          if (node) node.scrollTop = catalogView.scroll[index];
        });
        const rows = document.getElementById('artifact-list').children;
        const row = [...rows].find(node => node.dataset.artifactId === catalogView.focus);
        row?.firstElementChild?.focus?.({preventScroll: true});
      }
    });
  }
  return load();

}

if (globalThis.document && globalThis.document.getElementById('editor-form')) {
  mount(globalThis.document);
}
