import {mountCandidates, sourceHref} from './candidates.mjs';
import {ACTION_EDIT_FIELDS, actionSaveAttempt, encodeActionReview, decodeActionReview, decodeNewActionAttempt,
  actionEditCommitted, advanceActionEdit, decodeActionEdit, reconcileActionEdit} from './action-review.mjs';
import { domToMarkdown, renderMarkdown, safeHref } from './rich.mjs';
import { editRichTable, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, readMarkdownTable, renderMarkdownTable } from '../shell/markdown-table.mjs';
import { readWorkspaceChoices, servedByDsBot } from '../shell/dsbot-api.mjs';
import { actionFollowupChannel } from '../shell/action-followup-events.mjs';
export function csrfCookie(source) {
  const match = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(source || '');
  return match ? decodeURIComponent(match[1]) : '';
}

export function memoryDirectoryQuery({needle, topic, updatedAfter, unread, pinned, cursor} = {}) {
  const params = new URLSearchParams({order: 'recent', limit: '20'});
  if (needle) params.set('q', needle);
  if (topic) params.set('topic', topic);
  if (updatedAfter != null) params.set('updated_after', String(updatedAfter));
  if (unread) params.set('unread', '1');
  if (pinned) params.set('pinned', '1');
  if (cursor) params.set('cursor', cursor);
  return '?' + params.toString();
}

const ACTION_DUE_CURSOR = /^[012]:-?\d{1,11}:[0-9a-f]{32}$/;

export function actionQuery(needle, status, cursor, limit, order) {
  const params = new URLSearchParams();
  if (needle) params.set('q', needle);
  if (status) params.set('status', status);
  if (cursor) params.set(order === 'due' ? 'after' : 'cursor', cursor);
  if (limit) params.set('limit', String(limit));
  if (order) params.set('order', order);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function actionChatHref(source) {
  if (!['agent', 'social'].includes(source?.kind)) return '';
  return sourceHref(source.workspace_id, source.kind === 'social' ? {...source, kind:'group'} : source);
}

function actionFollowupHref(workspace, action) {
  if (action?.status !== 'open' || action.workspace_id !== workspace ||
      ![workspace, action.id].every(id => /^[0-9a-f]{32}$/.test(id || '')) ||
      !Number.isInteger(action.revision) || action.revision < 1 || action.revision > 2 ** 31) return '';
  return '/automations?' + new URLSearchParams({workspace, memory_action:action.id, revision:action.revision});
}

export function dueDateValue(dueAt) {
  if (dueAt == null || dueAt === '') return '';
  const date = new Date(Number(dueAt) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function dueAtFromDate(value) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 1000;
}

export function parseTopics(value) {
  const names = [];
  const seen = new Set();
  for (const part of String(value || '').split(/[,，\n]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}


function memoryBlock(kind, selection) {
  if (kind === 'table') return '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |';
  if (kind === 'tasks') return (selection.trim() || '待办事项').split(/\r?\n/)
    .map(line => line.trim()).filter(Boolean).map(line => '- [ ] ' + line).join('\n');
  return '';
}

export function applyMarkdown(textarea, kind) {
  if (!textarea) return '';
  const value = textarea.value;
  const start = textarea.selectionStart ?? value.length;
  const end = textarea.selectionEnd ?? value.length;
  const selected = value.slice(start, end);
  const wraps = {
    bold: ['**', '**', '粗体'],
    italic: ['_', '_', '斜体'],
    strike: ['~~', '~~', '删除线'],
    code: ['`', '`', '代码'],
    h1: ['# ', '', '标题'],
    h2: ['## ', '', '小标题'],
    h3: ['### ', '', '小标题'],
    ul: ['- ', '', '列表项'],
    ol: ['1. ', '', '列表项'],
    hr: ['\n---\n', '', ''],
    quote: ['> ', '', '引用'],
    link: ['[', '](https://)', '链接文字'],
  };
  const block = memoryBlock(kind, selected);
  const offset = kind === 'table' ? end : start;
  const before = value.slice(0, offset);
  const after = value.slice(end);
  const prefix = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const suffix = !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const [pre, post, fallback] = block ? [prefix, suffix, ''] : wraps[kind] || ['', '', '文本'];
  const body = block || selected || fallback;
  const next = before + pre + body + post + after;
  textarea.value = next;
  if (typeof textarea.setSelectionRange === 'function') {
    textarea.setSelectionRange(offset + pre.length, offset + pre.length + body.length);
  }
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return next;
}

export function formatTopics(topics) {
  return (topics || []).join('，');
}

export function memoryUpdatedLabel(updated) {
  if (updated == null || updated === '') return '';
  const date = new Date(Number(updated) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

export function topicTag(name) {
  const label = String(name || '').trim();
  if (!label) return '';
  return label.startsWith('#') ? label : `#${label}`;
}

export function memoryPageMeta(item) {
  const topics = (item && item.topics) || [];
  const parts = [memoryUpdatedLabel(item && item.updated), ...topics.map(topicTag)].filter(Boolean);
  return parts.join(' · ');
}

export function memoryPagePreview(item) {
  return String((item && item.preview) || '').trim();
}

export const GRAPH_HOVER_DELAY_MS = 300;
export const GRAPH_HOVER_NARROW_MAX = 390;

export function graphPreviewModel(node) {
  const title = String((node && node.title) || '').trim();
  const summary = memoryPagePreview(node);
  const tags = ((node && node.topics) || []).map(topicTag).filter(Boolean);
  return {title, summary, tags};
}

export function graphHoverAllowed({pointerCoarse = false, viewportWidth = 1440} = {}) {
  if (pointerCoarse) return false;
  if (Number(viewportWidth) <= GRAPH_HOVER_NARROW_MAX) return false;
  return true;
}

export function fillGraphHoverCard(card, model) {
  if (!card) return card;
  const titleEl = card.querySelector('.graph-hover-title');
  const summaryEl = card.querySelector('.graph-hover-summary');
  const tagsEl = card.querySelector('.graph-hover-tags');
  if (titleEl) titleEl.textContent = (model && model.title) || '';
  if (summaryEl) {
    summaryEl.textContent = (model && model.summary) || '';
    summaryEl.hidden = !(model && model.summary);
  }
  if (tagsEl) {
    tagsEl.textContent = ((model && model.tags) || []).join(' ');
    tagsEl.hidden = !((model && model.tags && model.tags.length));
  }
  return card;
}

export function hideGraphHoverCard(card) {
  if (!card) return card;
  card.hidden = true;
  if (card.removeAttribute) card.removeAttribute('data-id');
  return card;
}

export function showGraphHoverCard(card, model, position, id) {
  fillGraphHoverCard(card, model);
  if (id && card.setAttribute) card.setAttribute('data-id', id);
  if (position && Number.isFinite(position.left) && Number.isFinite(position.top) && card.style) {
    card.style.left = `${position.left}px`;
    card.style.top = `${position.top}px`;
  }
  card.hidden = false;
  return card;
}

export function bindGraphNodeGestures(target, node, options = {}) {
  if (!target || !target.addEventListener) return () => {};
  const openPage = options.openPage || (() => {});
  const card = options.card;
  const delay = options.delayMs == null ? GRAPH_HOVER_DELAY_MS : options.delayMs;
  const allowed = options.hoverAllowed != null
    ? Boolean(options.hoverAllowed)
    : graphHoverAllowed({
      pointerCoarse: options.pointerCoarse,
      viewportWidth: options.viewportWidth,
    });
  const model = graphPreviewModel(node);
  let timer = 0;
  if (target.setAttribute) {
    target.setAttribute('tabindex', '0');
    target.setAttribute('role', 'button');
    if (model.title) target.setAttribute('aria-label', model.title);
  }
  const open = () => openPage(node && node.id);
  const hide = () => {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    hideGraphHoverCard(card);
  };
  const startHover = () => {
    if (!allowed || !card) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      const position = options.positionFor ? options.positionFor(target, node) : options.position;
      showGraphHoverCard(card, model, position, node && node.id);
    }, delay);
  };
  target.addEventListener('click', open);
  target.addEventListener('dblclick', open);
  target.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.preventDefault) event.preventDefault();
      if (!event.repeat) open();
      return;
    }
    if (event.key === 'Escape') hide();
  });
  target.addEventListener('pointerenter', startHover);
  target.addEventListener('pointerleave', hide);
  return hide;
}

function currentPointerIsCoarse() {
  return Boolean(typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(pointer: coarse)').matches);
}

function currentViewportWidth() {
  return (typeof window !== 'undefined' && window.innerWidth) || 1440;
}

function graphHoverCardPosition(stage, target) {
  if (!stage || !stage.getBoundingClientRect || !target || !target.getBoundingClientRect) {
    return {left: 16, top: 16};
  }
  const stageBox = stage.getBoundingClientRect();
  const box = (target.querySelector && target.querySelector('.graph-node') || target).getBoundingClientRect();
  return {
    left: Math.max(8, box.left - stageBox.left + (box.width / 2) - 16),
    top: Math.max(8, box.top - stageBox.top + box.height + 10),
  };
}


function topicKey(name) {
  return String(name || '').trim().toLocaleLowerCase();
}

export function directoryGroups(pages, topicCatalog) {
  const rows = [...(pages || [])];
  const byId = new Map(rows.map((page) => [page.id, page]));
  const catalog = [];
  const seen = new Set();
  const addTopic = (name) => {
    const label = String(name || '').trim();
    const key = topicKey(label);
    if (!label || seen.has(key)) return;
    seen.add(key);
    catalog.push(label);
  };
  for (const topic of topicCatalog || []) {
    addTopic(topic && topic.name);
  }
  for (const page of rows) {
    for (const name of page.topics || []) addTopic(name);
  }
  const used = new Set();
  const groups = [];
  for (const name of catalog) {
    const key = topicKey(name);
    const items = [];
    const seenIds = new Set();
    const catalogTopic = (topicCatalog || []).find((topic) => topicKey(topic && topic.name) === key);
    const hinted = (catalogTopic && catalogTopic.pages ? catalogTopic.pages : []).map((page) => page && page.id);
    for (const page of rows) {
      const tagged = (page.topics || []).some((item) => topicKey(item) === key);
      const listed = hinted.includes(page.id);
      if (!tagged && !listed) continue;
      if (seenIds.has(page.id) || !byId.has(page.id)) continue;
      seenIds.add(page.id);
      items.push(page);
      used.add(page.id);
    }
    if (!items.length) continue;
    groups.push({name, count: items.length, pages: items});
  }
  return {groups, ungrouped: rows.filter((page) => !used.has(page.id))};
}

export function applyDirectoryCollapsed(root, collapsed) {
  const next = Boolean(collapsed);
  const dir = root.getElementById('memory-dir');
  const workspace = root.getElementById('list-panel');
  const collapse = root.getElementById('dir-collapse');
  const expand = root.getElementById('dir-expand');
  if (workspace) workspace.classList.toggle('dir-collapsed', next);
  if (dir) dir.hidden = next;
  if (collapse) collapse.setAttribute('aria-expanded', next ? 'false' : 'true');
  if (expand) expand.hidden = !next;
  return next;
}


export const MEMORY_EMPTY_WORKSPACE = '这个工作区还没有记忆页。';
export const PREFERENCES_EMPTY = '还没有偏好，加一条试试';
export const MEMORY_EMPTY_NO_MATCH = '没有匹配的记忆页。试试其他关键词。';
export const GRAPH_EMPTY_MESSAGE = '创建两个或更多记忆页后，这里会把它们连成图谱';

export function graphEmptyStateVisible({nodeCount = 0, query = ''} = {}) {
  if (String(query || '').trim()) return false;
  return Number(nodeCount) < 2;
}

export function memoryPageFromSearch(search) {
  const value = new URLSearchParams(search || '').get('page');
  if (value === 'profile') return 'profile';
  if (value === 'candidates') return 'candidates';
  if (value === 'todos') return 'actions';
  return 'overview';
}

const MEMORY_ID = /^[0-9a-f]{32}$/;

function memoryRevisionFromSearch(params) {
  const revision = params.get('revision');
  return /^[1-9][0-9]{0,7}$/.test(revision || '') ? Number(revision) : undefined;
}

export function memoryCitationFromSearch(search) {
  const params = new URLSearchParams(search || '');
  const [from] = params.getAll('from');
  const [chatWorkspace, agent, conversation, message, extra] = (from || '').split('.');
  if (params.getAll('from').length !== 1 || extra !== undefined
      || ![chatWorkspace, agent, conversation].every(id => MEMORY_ID.test(id || ''))
      || (message !== undefined && !MEMORY_ID.test(message))) return null;
  const workspace = params.get('workspace');
  const page = params.get('page');
  const action = params.get('action');
  if (!MEMORY_ID.test(workspace || '') || params.getAll('workspace').length !== 1 || params.getAll('page').length !== 1) return null;
  if (page === 'todos' ? !MEMORY_ID.test(action || '') || params.getAll('action').length !== 1
    : (page !== 'profile' && !MEMORY_ID.test(page || '')) || params.has('action')) return null;
  const target = new URLSearchParams({workspace: chatWorkspace, agent, conversation});
  if (message) target.set('message', message);
  return {from, workspace, page, action, message, href: '/chat#' + target};
}

export function queryForMemoryPage(view) {
  if (view === 'profile') return '?page=profile';
  if (view === 'candidates') return '?page=candidates';
  if (view === 'actions') return '?page=todos';
  return '';
}

export function exportDownloadName(title) {
  const flat = String(title == null ? '' : title).replace(/[\s\u0000-\u001f]+/g, ' ').trim();
  const safe = flat.replace(/[\\/:*?"<>|]+/g, '-').replace(/^[.\s-]+|[.\s-]+$/g, '');
  const limited = safe.slice(0, 60).replace(/[.\s-]+$/, '');
  return (limited || '记忆页') + '.md';
}

export function graphLayout(nodes, width = 640, height = 400, padding = 56) {
  const list = [...(nodes || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const cx = width / 2;
  const cy = height / 2;
  if (list.length === 0) return [];
  if (list.length === 1) return [{id: list[0].id, x: cx, y: cy}];
  const radius = Math.max(0, Math.min(cx, cy) - padding);
  return list.map((node, index) => {
    const angle = ((Math.PI * 2 * index) / list.length) - (Math.PI / 2);
    return {
      id: node.id,
      x: Number((cx + radius * Math.cos(angle)).toFixed(2)),
      y: Number((cy + radius * Math.sin(angle)).toFixed(2)),
    };
  });
}

function messageFor(error, fallback) {
  if (error && error.message) return error.message;
  return fallback;
}

export function mount(document, {fetcher = globalThis.fetch.bind(globalThis)} = {}) {
  const nativePins = servedByDsBot(document);
  const status = document.getElementById('status');
  const loginPanel = document.getElementById('login-panel');
  const mainPanel = document.getElementById('main-panel');
  const workspaceSelect = document.getElementById('workspace');
  const listEl = document.getElementById('memory-list');
  const emptyEl = document.getElementById('list-empty');
  const searchInput = document.getElementById('search');
  const clearSearch = document.getElementById('memory-search-clear');
  const resetFilters = document.getElementById('memory-directory-reset');
  const directoryStatus = document.getElementById('memory-directory-status');
  const directoryMore = document.getElementById('memory-load-more');
  const directoryRetry = document.getElementById('memory-directory-retry');
  const editor = document.getElementById('editor-form');
  const pagePin = document.getElementById('page-pin');
  const pinnedFilter = document.getElementById('filter-pinned');
  if (pinnedFilter) pinnedFilter.hidden = !nativePins;
  const pinWrites = new Set();
  const actionEditor = document.getElementById('action-editor-form');
  const actionSearch = document.getElementById('action-search');
  const actionFilter = document.getElementById('action-filter');
  const actionQuickStatus = document.getElementById('action-quick-status');
  const actionMore = document.getElementById('action-list-more');
  const actionRetry = document.getElementById('action-list-retry');
  const actionFollowup = document.getElementById('action-follow-up');
  const actionFollowupHistory = document.getElementById('action-follow-up-history');
  const actionFollowupList = document.getElementById('action-follow-up-list');
  const newActionForm = document.getElementById('new-action-form');
  const newActionButton = document.getElementById('new-action');
  const newActionStatus = document.getElementById('new-action-status');
  const newActionFields = Object.fromEntries(['title', 'notes', 'due', 'page'].map(name => [name, document.getElementById('new-action-' + name)]));
  let personalWorkspaces = new Set();
  const newPageButton = document.getElementById('new-page');
  const listPanel = document.getElementById('list-panel');
  const mobileGraph = document.getElementById('memory-mobile-graph');
  const mobileRefresh = document.getElementById('memory-mobile-refresh');
  const citationHeader = document.getElementById('memory-citation');
  const citationReturn = document.getElementById('memory-citation-return');
  const citationStatus = document.getElementById('memory-citation-status');
  const citationPreview = document.getElementById('memory-citation-preview');
  const citationTitle = document.getElementById('memory-citation-title');
  const citationVersion = document.getElementById('memory-citation-version');
  const citationBody = document.getElementById('memory-citation-body');
  const citationEdit = document.getElementById('memory-citation-edit');
  const citationRetry = document.getElementById('memory-citation-retry');
  let currentUser = null;
  let activeCitation = null;
  let citationRevision;
  let sessionRequest = 0;
  let currentPage = null;
  let currentAction = null;
  let actionFollowupRequest = 0;
  let pageChoices = [];
  let browseDirectory = null;
  let activeDirectory = null;
  let unreadCount = null;
  let readGeneration = 0;
  let pageReadQueue = Promise.resolve();
  const readRevisions = new Map();
  let directoryTimer;
  let workspaceRequest = 0;
  let pageRequest = 0;
  let currentView = 'overview';
  let listFilter = 'all';
  let topicFilter = '';
  let sideTab = 'topics';
  let graphZoom = 1;
  let topicQuery = '';
  let pendingDelete = null;

  function show(kind, text) {
    status.dataset.kind = kind;
    status.textContent = text;
  }

  async function request(method, path, body, extra = {}, signal) {
    const headers = {'Accept': 'application/json', 'X-CSRF-Token': csrfCookie(document.cookie), ...extra};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetcher(path, {
      method, headers, credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(signal ? {signal} : {}),
    });
    let parsed = {};
    try { parsed = await response.json(); } catch { parsed = {}; }
    return {status: response.status, body: parsed};
  }

  function workspaceId() {
    return workspaceSelect.value;
  }

  function directoryAddress() {
    const saved = document.defaultView?.history?.state?.memoryDirectory;
    return currentUser?.id && workspaceId() && saved?.owner === currentUser.id && saved.workspace === workspaceId()
      ? saved : null;
  }

  function writeDirectoryAddress(url, {push = false, result = directoryAddress()?.result === true,
    reopenPage = directoryAddress()?.reopenPage === true, returnPage = push ? '' : directoryAddress()?.returnPage} = {}) {
    const view = document.defaultView;
    const history = view?.history;
    if (!history?.replaceState || !view.location) return;
    const method = push && history.pushState ? 'pushState' : 'replaceState';
    const memoryDirectory = currentUser?.id && workspaceId() ? {
      owner: currentUser.id, workspace: workspaceId(), query: searchInput.value,
      filter: listFilter, topic: topicFilter, result: result && (!push || method === 'pushState'),
      ...(reopenPage && !push ? {reopenPage:true} : {}),
      ...(MEMORY_ID.test(returnPage || '') && (!push || method === 'pushState') ? {returnPage} : {}),
    } : null;
    if (!url) {
      const previous = history.state?.memoryDirectory;
      if (!memoryDirectory || (previous && Object.keys(memoryDirectory).every(key => previous[key] === memoryDirectory[key]))) return;
      const {pathname, search, hash} = view.location;
      url = (pathname || '/memory') + (search || '') + (hash || '');
    }
    history[method]({...history.state, memoryDirectory}, '', url);
  }

  function restoreDirectoryAddress() {
    const saved = directoryAddress();
    searchInput.value = typeof saved?.query === 'string' ? saved.query.slice(0, 80) : '';
    topicFilter = saved?.filter === 'topics' && typeof saved.topic === 'string' ? saved.topic : '';
    const filters = nativePins ? ['unread', 'updated', 'topics', 'pinned'] : ['unread', 'updated', 'topics'];
    setDirectoryFilter(filters.includes(saved?.filter) ? saved.filter : 'all');
  }

  function setCitationStatus(message) {
    if (citationStatus) citationStatus.textContent = message;
  }

  function hideCitationPreview() {
    if (citationPreview) citationPreview.hidden = true;
    citationRevision = undefined;
  }

  function setCitation(citation) {
    if (activeCitation !== citation) hideCitationPreview();
    activeCitation = citation;
    if (citationHeader) citationHeader.hidden = !citation;
    if (citationReturn) {
      if (citation) {
        citationReturn.href = citation.href;
        citationReturn.textContent = citation.message ? '返回引用消息' : '返回原对话';
      } else citationReturn.removeAttribute('href');
    }
    setCitationStatus('');
  }

  function citationFor(page, action = null) {
    return activeCitation?.workspace === workspaceId() && activeCitation.page === page && activeCitation.action === action
      ? activeCitation : null;
  }

  function syncCitationUrl(params, citation = activeCitation, address = {result: false}) {
    if (citation) params.set('from', citation.from);
    writeDirectoryAddress('/memory?' + params, address);
  }

  function randomKey() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const actionDrafts = new Map();
  const actionDraftOpener = document.getElementById('dream-actions');
  const actionDraftPanel = document.getElementById('action-draft-panel');
  const actionDraftSources = document.getElementById('action-draft-sources');
  const actionDraftItems = document.getElementById('action-draft-items');
  const actionDraftGenerate = document.getElementById('action-draft-generate');
  const actionDraftSave = document.getElementById('action-draft-save');
  let actionDraftPageScope = '';

  function actionDraftScope() {
    const id = workspaceId();
    return currentUser?.id && id ? currentUser.id + ':' + id : '';
  }

  function actionDraftState() {
    const scope = actionDraftScope();
    if (!scope) return null;
    if (!actionDrafts.has(scope)) {
      let restored;
      try { restored = decodeActionReview(document.defaultView.sessionStorage.getItem('flybot-workspace.memory-action-review:' + scope)); } catch {}
      actionDrafts.set(scope, restored || null);
    }
    return actionDrafts.get(scope);
  }

  function persistActionDraft(scope, state) {
    if (!scope || actionDrafts.get(scope) !== state) return;
    try {
      const storage = document.defaultView.sessionStorage;
      const key = 'flybot-workspace.memory-action-review:' + scope;
      if (state.open || state.selected.size || state.items.length || state.generateAttempt || state.saveAttempt) {
        storage.setItem(key, encodeActionReview(state));
      } else storage.removeItem(key);
    } catch {}
  }

  function updateActionDraftControls(state) {
    const blocked = Boolean(state.busy || state.saveAttempt);
    const choices = Array.from(actionDraftSources.children).map(label => label.children[0]);
    for (const box of choices) box.disabled = blocked || (!box.checked && state.selected.size >= 5);
    actionDraftGenerate.disabled = blocked || (!state.generateAttempt && !choices.some(box => box.checked));
    actionDraftGenerate.textContent = state.generateAttempt && !state.busy ? '继续生成建议' : '生成建议';
    actionDraftSave.disabled = Boolean(state.busy) ||
      (!state.saveAttempt && (!state.items.some(item => item.selected)
        || state.items.some(item => item.selected && (!item.title.trim() || item.title.trim().length > 80))));
    actionDraftSave.textContent = state.saveAttempt && !state.busy ? '重新保存所选行动' : '保存所选行动';
  }

  function renderActionDrafts() {
    if (!actionDraftPanel) return;
    const scope = actionDraftScope();
    const state = actionDraftState();
    const pagesReady = scope && actionDraftPageScope === scope;
    const opened = currentView === 'actions' && Boolean(state?.open);
    actionDraftOpener.disabled = !pagesReady && !state;
    actionDraftOpener.setAttribute('aria-expanded', String(opened));
    actionDraftPanel.hidden = !opened;
    actionDraftSources.replaceChildren();
    actionDraftItems.replaceChildren();
    if (!opened) return;

    const pages = new Map((pagesReady ? pageChoices : []).map(page => [page.id, page]));
    for (const [id, selected] of state.selected) {
      if (pages.has(id)) state.selected.set(id, pages.get(id));
      else pages.set(id, selected);
    }
    document.getElementById('action-draft-empty').hidden = !pagesReady || pages.size > 0;
    for (const page of [...pages.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0))) {
      const label = document.createElement('label');
      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.value = page.id;
      pick.checked = state.selected.has(page.id);
      pick.addEventListener('change', () => {
        if (actionDraftState() !== state || pick.disabled) return;
        if (pick.checked) state.selected.set(page.id, page);
        else state.selected.delete(page.id);
        if (state.generateAttempt) {
          state.generateAttempt = null;
          state.message = '';
          document.getElementById('action-draft-status').textContent = '';
        }
        persistActionDraft(scope, state);
        updateActionDraftControls(state);
      });
      label.append(pick, document.createTextNode(page.title));
      actionDraftSources.append(label);
    }
    const locked = Boolean(state.busy || state.saveAttempt);
    for (const item of state.items) {
      const row = document.createElement('li');
      const include = document.createElement('label');
      include.className = 'action-draft-pick';
      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.checked = item.selected;
      pick.disabled = locked;
      pick.addEventListener('change', () => {
        if (actionDraftState() !== state || pick.disabled) return;
        item.selected = pick.checked;
        persistActionDraft(scope, state);
        updateActionDraftControls(state);
      });
      include.append(pick, document.createTextNode('保存此行动'));
      const heading = document.createElement('label');
      const title = document.createElement('input');
      title.type = 'text';
      title.maxLength = 80;
      title.value = item.title;
      title.disabled = locked;
      title.addEventListener('input', () => {
        if (actionDraftState() !== state || title.disabled) return;
        item.title = title.value;
        persistActionDraft(scope, state);
        updateActionDraftControls(state);
      });
      heading.append(document.createTextNode('标题'), title);
      const label = document.createElement('label');
      const source = document.createElement('select');
      source.disabled = locked;
      for (const page of state.sources) {
        const option = document.createElement('option');
        option.value = page.id;
        option.textContent = page.title;
        source.append(option);
      }
      source.value = item.memory_page_id;
      source.addEventListener('change', () => {
        if (actionDraftState() !== state || source.disabled) return;
        item.memory_page_id = source.value;
        persistActionDraft(scope, state);
      });
      label.append(document.createTextNode('关联记忆页'), source);
      row.append(include, heading, label);
      actionDraftItems.append(row);
    }
    document.getElementById('action-draft-review').hidden = !state.items.length;
    document.getElementById('action-draft-status').textContent = state.message;
    updateActionDraftControls(state);
  }

  actionDraftOpener?.addEventListener('click', () => {
    const scope = actionDraftScope();
    if (!scope) return;
    let state = actionDraftState();
    if (!state) actionDrafts.set(scope, state = {selected:new Map(), items:[], sources:[], message:''});
    state.open = !state.open;
    persistActionDraft(scope, state);
    renderActionDrafts();
  });
  document.getElementById('action-draft-close')?.addEventListener('click', () => {
    const state = actionDraftState();
    if (state) {
      state.open = false;
      persistActionDraft(actionDraftScope(), state);
    }
    renderActionDrafts();
    actionDraftOpener.focus?.();
  });
  document.getElementById('action-draft-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const state = actionDraftState();
    const scope = actionDraftScope();
    const workspace = workspaceId();
    if (!state?.open || actionDraftGenerate.disabled) return;
    const sources = state.generateAttempt?.sources || [...state.selected.values()].map(({id, revision}) => ({id, revision}));
    if (!sources.length || sources.length > 5) return;
    state.generateAttempt ??= {sources, key:randomKey()};
    state.busy = true;
    state.message = '正在根据所选记忆页生成行动建议…';
    persistActionDraft(scope, state);
    renderActionDrafts();
    const result = await request('POST', `/v1/workspaces/${workspace}/memory/actions/draft`, {sources},
      {'Idempotency-Key':state.generateAttempt.key}).catch(() => ({status:0, body:{}}));
    state.busy = false;
    if (result.status === 200 && Array.isArray(result.body.sources) && Array.isArray(result.body.suggestions)) {
      state.generateAttempt = null;
      state.sources = result.body.sources;
      state.items = result.body.suggestions.map(item => ({...item, selected:true}));
      state.message = state.items.length ? '' : '所选记忆页中没有明确的下一步行动。';
    } else {
      if ([400, 404, 409].includes(result.status)) state.generateAttempt = null;
      state.message = messageFor(result.body.error, '无法生成行动建议，请重试。');
    }
    persistActionDraft(scope, state);
    if (actionDraftState() === state) renderActionDrafts();
  });
  actionDraftSave?.addEventListener('click', async () => {
    const state = actionDraftState();
    const scope = actionDraftScope();
    const workspace = workspaceId();
    if (!state?.open || actionDraftSave.disabled) return;
    state.saveAttempt ??= actionSaveAttempt(state, randomKey());
    const attempt = state.saveAttempt;
    if (!attempt) return;
    state.busy = true;
    state.message = '正在保存所选行动…';
    persistActionDraft(scope, state);
    renderActionDrafts();
    const result = await request('POST', `/v1/workspaces/${workspace}/memory/actions/draft/save`, {items:attempt.items},
      {'Idempotency-Key':attempt.key}).catch(() => ({status:0, body:{}}));
    state.busy = false;
    const confirmed = [200, 201].includes(result.status) && Array.isArray(result.body.items);
    if (confirmed) {
      state.saveAttempt = null;
      state.items = state.items.filter(item => !attempt.chosen.includes(item));
      state.message = `已保存 ${attempt.items.length} 条行动。`;
    } else {
      if ([400, 404, 409].includes(result.status)) state.saveAttempt = null;
      state.message = messageFor(result.body.error, '无法确认保存结果，请重试保存。');
    }
    persistActionDraft(scope, state);
    if (actionDraftState() !== state) return;
    renderActionDrafts();
    if (confirmed) await loadActions();
  });

  function appendMatch(node, {text, start, end}) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) {
      node.textContent = text;
      return;
    }
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    node.append(document.createTextNode(text.slice(0, start)), mark, document.createTextNode(text.slice(end)));
  }

  function pageButton(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'memory-page-link';
    button.dataset.id = item.id;
    if (item.id === currentPage?.id && !editor.hidden) button.setAttribute('aria-current', 'page');
    const icon = document.createElement('span');
    icon.className = 'memory-page-icon';
    icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M7 3h7l5 5v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm6 1.5V9h4.5L13 4.5z');
    svg.appendChild(path);
    icon.appendChild(svg);
    button.appendChild(icon);
    const text = document.createElement('span');
    text.className = 'memory-page-text';
    const title = document.createElement('span');
    title.className = 'memory-page-title';
    const match = typeof item.match?.text === 'string' && item.match.text ? item.match : null;
    const titleMatch = match?.kind === 'title' && match.text === item.title;
    if (titleMatch) appendMatch(title, match);
    else title.textContent = item.title;
    text.appendChild(title);
    const preview = memoryPagePreview(item);
    if (match && !titleMatch) {
      const excerpt = document.createElement('span');
      excerpt.className = 'memory-page-preview memory-page-match';
      if (match.kind === 'topic') {
        const topic = document.createElement('span');
        topic.textContent = '标签 · ';
        excerpt.appendChild(topic);
      }
      const fragment = document.createElement('span');
      appendMatch(fragment, match);
      excerpt.appendChild(fragment);
      text.appendChild(excerpt);
    } else if (preview) {
      const snippet = document.createElement('span');
      snippet.className = 'memory-page-preview';
      snippet.textContent = preview;
      text.appendChild(snippet);
    }
    const meta = document.createElement('span');
    meta.className = 'memory-page-meta';
    meta.textContent = memoryPageMeta(item);
    if (meta.textContent) text.appendChild(meta);
    button.appendChild(text);
    if (item.unread) {
      const badge = document.createElement('span');
      badge.className = 'memory-unread-badge';
      badge.textContent = '未读';
      button.appendChild(badge);
    }
    if (item.pinned === true) {
      const badge = document.createElement('span');
      badge.className = 'memory-pin-badge';
      badge.textContent = '已置顶';
      button.append(badge);
    }
    button.addEventListener('click', () => openPage(item.id, undefined, undefined, {fromDirectory: true}));
    return button;
  }

  function appendPage(parent, item) {
    const li = document.createElement('li');
    li.appendChild(pageButton(item));
    parent.appendChild(li);
  }

  function renderDirectory() {
    const state = activeDirectory;
    const rows = state?.items || [];
    const busy = Boolean(state && (state.controller || state.total === null && !state.error));
    const selectedRow = listEl.contains?.(document.activeElement) ? document.activeElement.dataset.id : undefined;
    listEl.replaceChildren();
    if (listFilter === 'topics' && !state?.topic && !state?.needle) {
      const directory = directoryGroups(rows, currentGraph.topics);
      for (const item of directory.ungrouped) appendPage(listEl, item);
      for (const group of directory.groups) {
        const li = document.createElement('li');
        li.className = 'memory-topic-group';
        const details = document.createElement('details');
        details.open = true;
        const summary = document.createElement('summary');
        summary.textContent = `${group.name} ${group.count}`;
        details.appendChild(summary);
        const nested = document.createElement('ul');
        for (const item of group.pages) appendPage(nested, item);
        details.appendChild(nested);
        li.appendChild(details);
        listEl.appendChild(li);
      }
    } else {
      for (const item of rows) appendPage(listEl, item);
    }
    listEl.setAttribute('aria-busy', String(busy));
    emptyEl.hidden = !state || rows.length > 0 || busy || Boolean(state.error);
    emptyEl.textContent = state?.needle ? MEMORY_EMPTY_NO_MATCH : state?.topic
      ? '这个标签下还没有记忆页。'
      : state?.unread ? '没有未读的记忆更新。'
      : state?.pinned ? '还没有置顶的记忆页。'
      : state?.updatedAfter != null ? '最近 7 天没有更新过的记忆页。' : MEMORY_EMPTY_WORKSPACE;
    if (resetFilters) resetFilters.hidden = emptyEl.hidden || (!state?.topic && !state?.unread && !state?.pinned && state?.updatedAfter == null);
    if (clearSearch) clearSearch.hidden = !searchInput.value;
    if (directoryStatus) {
      directoryStatus.textContent = state?.error || (busy ? (state.needle ? '正在搜索…' : '正在加载记忆…')
        : state?.needle && rows.length && state.total != null ? `找到 ${state.total} 条记忆` : '');
    }
    if (directoryMore) {
      directoryMore.hidden = !state?.cursor || Boolean(state.error);
      directoryMore.disabled = busy;
    }
    if (directoryRetry) directoryRetry.hidden = !state?.error;
    const count = document.getElementById('filter-all-count');
    if (count) {
      count.hidden = browseDirectory?.total == null;
      count.textContent = browseDirectory?.total == null ? '' : String(browseDirectory.total);
    }
    const badge = document.getElementById('filter-unread-count');
    if (badge?.parentElement) {
      badge.parentElement.hidden = unreadCount == null;
      badge.hidden = !(unreadCount > 0);
      badge.textContent = unreadCount > 0 ? String(unreadCount) : '';
    }
    if (selectedRow) focusDirectoryRow(selectedRow);
  }

  function directoryRow(id) {
    if (!id) return;
    return [...(listEl.querySelectorAll?.('[data-id]') || [])].find(button => button.dataset.id === id);
  }

  function focusDirectoryRow(id) {
    directoryRow(id)?.focus();
  }

  function syncDirectorySelection() {
    for (const button of listEl.querySelectorAll?.('[data-id]') || []) {
      if (button.dataset.id === currentPage?.id && !editor.hidden) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }

  function directoryWindow(options = {}) {
    return {
      workspace: workspaceId(), owner: currentUser,
      needle: '', topic: '', updatedAfter: null, ...options,
      items: [], total: null, cursor: null, controller: null, error: '',
    };
  }

  function ownsDirectoryWindow(state) {
    return (browseDirectory === state || activeDirectory === state) &&
      state.owner === currentUser && state.workspace === workspaceId();
  }

  async function loadDirectoryPage(state, cursor = null, moveFocus = false) {
    if (!state?.workspace || state.controller || !ownsDirectoryWindow(state)) return false;
    const controller = new AbortController();
    const generation = readGeneration;
    state.controller = controller;
    state.error = '';
    if (activeDirectory === state) renderDirectory();
    const response = await request('GET', `/v1/workspaces/${state.workspace}/memory${memoryDirectoryQuery({...state, cursor})}`,
      undefined, undefined, controller.signal).catch(() => null);
    if (controller.signal.aborted || !ownsDirectoryWindow(state)) return false;
    state.controller = null;
    if (response?.status !== 200 || !Array.isArray(response.body?.items)) {
      state.error = cursor ? '无法加载更多记忆，请重试。' : state.needle ? '搜索失败，请重试。' : '无法加载记忆页，请重试。';
      if (activeDirectory === state) renderDirectory();
      return false;
    }
    const {items, total} = response.body;
    if (generation === readGeneration && Number.isSafeInteger(response.body.unread_total) && response.body.unread_total >= 0) {
      unreadCount = response.body.unread_total;
    }
    for (const item of items) {
      if ((readRevisions.get(item.id) ?? 0) >= item.revision) item.unread = false;
    }
    const seen = new Set(cursor ? state.items.map(item => item.id) : []);
    const added = items.filter(item => {
      if (seen.has(item.id) || (state.unread && item.unread === false)) return false;
      seen.add(item.id);
      return true;
    });
    state.items = cursor ? [...state.items, ...added] : added;
    const next = response.body.cursor;
    state.cursor = typeof next === 'string' && next && next !== cursor ? next : null;
    state.total = Number.isSafeInteger(total) && total >= 0 ? total : state.items.length;
    if (browseDirectory === state) {
      pageChoices = state.items;
      renderRecent(pageChoices.slice(0, 20));
      actionDraftPageScope = actionDraftScope();
      renderActionDrafts();
      const actionPage = document.getElementById('new-action-page');
      if (actionPage) fillPageSelect(actionPage, actionPage.value);
      newPageButton.disabled = false;
    }
    if (activeDirectory === state || browseDirectory === state) renderDirectory();
    if (moveFocus && activeDirectory === state && added.length) focusDirectoryRow(added[0].id);
    return true;
  }

  function cancelDirectorySearch() {
    clearTimeout(directoryTimer);
    directoryTimer = null;
    if (activeDirectory !== browseDirectory) activeDirectory?.controller?.abort();
  }

  function searchDirectory({delay = 0, force = false} = {}) {
    if (!browseDirectory?.workspace || browseDirectory.owner !== currentUser) return;
    writeDirectoryAddress();
    const needle = searchInput.value.trim();
    const topic = listFilter === 'topics' ? topicFilter : '';
    const recent = listFilter === 'updated';
    const unread = listFilter === 'unread';
    const pinned = nativePins && listFilter === 'pinned';
    if (!needle && !topic && !recent && !unread && !pinned) {
      cancelDirectorySearch();
      activeDirectory = browseDirectory;
      renderDirectory();
      return;
    }
    const current = activeDirectory;
    if (!force && current?.needle === needle && current.topic === topic && (current.updatedAfter != null) === recent &&
        Boolean(current.unread) === unread && Boolean(current.pinned) === pinned) return;
    cancelDirectorySearch();
    const updatedAfter = recent ? Math.floor(Date.now() / 1000) - 7 * 86400 : null;
    const state = directoryWindow({needle, topic, updatedAfter, unread, pinned});
    activeDirectory = state;
    renderDirectory();
    if (delay) {
      directoryTimer = setTimeout(() => {
        directoryTimer = null;
        void loadDirectoryPage(state);
      }, delay);
    } else {
      void loadDirectoryPage(state);
    }
  }

  function renderRecent(items) {
    const list = document.getElementById('recent-list');
    const empty = document.getElementById('recent-empty');
    if (!list || !empty) return;
    const rows = [...(items || [])].sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0) || String(a.id).localeCompare(String(b.id)));
    list.replaceChildren();
    for (const item of rows) {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const updated = item.updated ? new Date(Number(item.updated) * 1000) : null;
      const when = updated && !Number.isNaN(updated.getTime()) ? updated.toISOString().slice(0, 10) : '';
      button.textContent = when ? `${item.title} · ${when}` : item.title;
      button.addEventListener('click', () => openPage(item.id));
      li.appendChild(button);
      list.appendChild(li);
    }
    empty.hidden = rows.length > 0;
  }

  function renderTopicFilters() {
    const box = document.getElementById('topic-filter-chips');
    if (!box) return;
    box.replaceChildren();
    for (const topic of currentGraph.topics || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${topic.name} · ${topic.page_count}`;
      button.setAttribute('aria-pressed', topic.name === topicFilter ? 'true' : 'false');
      button.addEventListener('click', () => {
        topicFilter = topicFilter === topic.name ? '' : topic.name;
        renderTopicFilters();
        searchDirectory();
      });
      box.appendChild(button);
    }
  }

  function syncViewUrl() {
    const view = document.defaultView;
    const params = new URLSearchParams(queryForMemoryPage(currentView));
    const id = workspaceId();
    if (currentView === 'profile' && citationFor('profile')) {
      syncCitationUrl(new URLSearchParams({workspace: id, page: 'profile'}));
      return;
    }
    if (/^[0-9a-f]{32}$/.test(id)) params.set('workspace', id);
    const query = params.toString();
    writeDirectoryAddress((view?.location?.pathname || '/memory') + (query ? '?' + query : ''), {result: false});
  }

  let profileRevision = null;
  let profileRequest = 0;
  const profileFields = {professional:'职业背景', work_style:'工作方式', communication:'沟通与写作'};
  const profileInputs = Object.fromEntries(Object.keys(profileFields).map(field => [field, document.getElementById('profile-' + field)]));
  const profileForm = document.getElementById('memory-profile-form');
  const profileSave = document.getElementById('save-memory-profile');
  const profileStatus = document.getElementById('memory-profile-status');
  const profileDream = document.getElementById('dream-profile');
  const profilePreview = document.getElementById('profile-dream-dialog');
  const profileApply = document.getElementById('profile-dream-apply');
  let profileSuggestion = null;

  const profileDraft = () => ({revision:profileRevision,
    ...Object.fromEntries(Object.entries(profileInputs).map(([field, input]) => [field, input?.value || '']))});

  function closeProfilePreview() {
    profileSuggestion = null;
    if (profilePreview?.open) profilePreview.close();
    if (profileDream) profileDream.disabled = profileRevision === null || Boolean(profileSave?.disabled);
  }

  function showProfilePreview(operation, changes) {
    const list = document.getElementById('profile-dream-changes');
    list.replaceChildren();
    for (const {field, text} of changes) {
      const section = document.createElement('section');
      section.className = 'profile-dream-change';
      const label = document.createElement('label');
      const choice = document.createElement('input');
      choice.type = 'checkbox';
      choice.checked = true;
      label.append(choice, document.createTextNode(profileFields[field]));
      const comparison = document.createElement('div');
      comparison.className = 'profile-dream-comparison';
      for (const [heading, value] of [['当前内容', operation.draft[field]], ['建议内容', text]]) {
        const block = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = heading;
        const paragraph = document.createElement('p');
        paragraph.textContent = value || '（空）';
        block.append(title, paragraph);
        comparison.append(block);
      }
      operation.choices.push({field, text, choice});
      choice.addEventListener('change', () => {
        profileApply.disabled = !operation.choices.some(entry => entry.choice.checked);
      });
      section.append(label, comparison);
      list.append(section);
    }
    profileApply.disabled = false;
    profilePreview.showModal();
    document.getElementById('profile-dream-title').focus();
  }

  profileDream?.addEventListener('click', async () => {
    if (profileRevision === null || profileDream.disabled || !profilePreview) return;
    const wid = workspaceId();
    const owner = currentUser?.id;
    const operation = {draft:profileDraft(), choices:[]};
    const isCurrent = () => profileSuggestion === operation && currentUser?.id === owner && workspaceId() === wid;
    profileSuggestion = operation;
    profileDream.disabled = true;
    profileStatus.textContent = '正在整理资料…';
    try {
      const result = await request('POST', `/v1/workspaces/${wid}/memory/profile/dream`, operation.draft);
      if (!isCurrent()) return;
      if (result.status !== 200) {
        profileStatus.textContent = messageFor(result.body.error, '资料整理失败，请重试。');
        return;
      }
      const changes = result.body.changes || [];
      if (!changes.length) {
        profileStatus.textContent = '当前资料已整理妥当。';
        return;
      }
      profileStatus.textContent = '';
      showProfilePreview(operation, changes);
    } catch {
      if (isCurrent()) profileStatus.textContent = '资料整理失败，请重试。';
    } finally {
      if (profileSuggestion === operation && !profilePreview.open) closeProfilePreview();
    }
  });

  function cancelProfilePreview() {
    closeProfilePreview();
    profileDream?.focus();
  }
  document.getElementById('profile-dream-cancel')?.addEventListener('click', cancelProfilePreview);
  profilePreview?.addEventListener('cancel', event => {
    event.preventDefault();
    cancelProfilePreview();
  });
  profileApply?.addEventListener('click', () => {
    if (!profileSuggestion || profileApply.disabled) return;
    for (const {field, text, choice} of profileSuggestion.choices) {
      if (choice.checked) profileInputs[field].value = text;
    }
    closeProfilePreview();
    profileStatus.textContent = '已应用到编辑框，保存后生效。';
    profileSave?.focus();
  });
  profileForm?.addEventListener('input', () => {
    if (profileSuggestion && !profilePreview?.open) {
      closeProfilePreview();
      profileStatus.textContent = '';
    }
  });

  async function loadMemoryProfile() {
    profileRevision = null;
    const token = ++profileRequest, wid = workspaceId();
    if (profileSave) profileSave.disabled = true;
    closeProfilePreview();
    for (const input of Object.values(profileInputs)) if (input) input.value = '';
    if (!wid) return;
    const result = await request('GET', `/v1/workspaces/${wid}/memory/profile`).catch(() => ({status:0, body:{}}));
    if (token !== profileRequest || workspaceId() !== wid) return;
    const status = document.getElementById('memory-profile-status');
    if (result.status !== 200 || !result.body.profile) {
      if (status) status.textContent = '无法读取画像。';
      return;
    }
    const profile = result.body.profile;
    profileRevision = profile.revision;
    if (profileSave) profileSave.disabled = false;
    if (profileDream) profileDream.disabled = false;
    for (const [field, input] of Object.entries(profileInputs)) if (input) input.value = profile[field];
    if (status) status.textContent = '';
  }
  const candidates = mountCandidates(document, {request, workspaceId});

  function setMobileGraph(open) {
    listPanel.dataset.mobileGraph = String(open);
    if (!mobileGraph) return;
    mobileGraph.setAttribute('aria-expanded', String(open));
    mobileGraph.textContent = open ? '列表' : '图谱';
  }

  mobileGraph?.addEventListener('click', () => {
    if (listPanel.dataset.view !== 'overview') return;
    setMobileGraph(listPanel.dataset.mobileGraph !== 'true');
    listPanel.scrollTop = 0;
  });
  mobileRefresh?.addEventListener('click', async () => {
    if (!workspaceId() || mobileRefresh.disabled || listPanel.dataset.view !== 'overview') return;
    mobileRefresh.disabled = true;
    try { await loadWorkspace(); }
    finally { mobileRefresh.disabled = false; }
  });

  function showView(name, {sync = true} = {}) {
    persistPageDraft();
    currentView = name || 'overview';
    if (currentView !== 'overview') setMobileGraph(false);
    if (mobileGraph) mobileGraph.hidden = currentView !== 'overview';
    if (mobileRefresh) mobileRefresh.hidden = currentView !== 'overview';
    pageRequest += 1;
    setCitation(currentView === 'profile' ? citationFor('profile') : null);
    hideCitationPreview();
    closeProfilePreview();
    if (editor) editor.hidden = true;
    if (actionEditor) actionEditor.hidden = true;
    const workspace = document.getElementById('list-panel');
    if (workspace) workspace.dataset.view = currentView;
    const title = document.getElementById('view-title');
    const labels = {overview: '总览', profile: '我的资料', actions: '下一步行动', candidates:'记忆建议'};
    if (title) title.textContent = labels[currentView] || '总览';
    const overview = document.getElementById('overview-panel');
    const side = document.getElementById('memory-side');
    const actions = document.getElementById('actions-panel');
    const profile = document.getElementById('profile-panel');
    if (overview) overview.hidden = currentView !== 'overview';
    if (side) side.hidden = currentView !== 'overview';
    if (actions) actions.hidden = currentView !== 'actions';
    if (profile) profile.hidden = currentView !== 'profile';
    renderActionDrafts();
    candidates.show(currentView === 'candidates');
    if (currentView === 'profile') loadMemoryProfile();
    if (currentView === 'profile') loadPreferences();
    for (const button of document.querySelectorAll('.memory-views [data-view]')) {
      if (button.getAttribute('data-view') === currentView) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (sync) syncViewUrl();
  }

  function unusedTitle(base) {
    const taken = new Set((pageChoices || []).map((item) => String(item.title || '').toLocaleLowerCase()));
    if (!taken.has(base.toLocaleLowerCase())) return base;
    for (let index = 2; index < 100; index += 1) {
      const title = `${base} ${index}`;
      if (!taken.has(title.toLocaleLowerCase())) return title;
    }
    return `${base} ${Date.now()}`;
  }

  function fillPageSelect(select, selected) {
    const pages = new Map(pageChoices.map(page => [page.id, page.title]));
    if (graphWorkspace === workspaceId() && graphOwner === currentUser) {
      for (const node of currentGraph.nodes || []) {
        if (!pages.has(node.id)) pages.set(node.id, node.title);
      }
    }
    // An action may reference a page past the first directory page while the
    // graph is still loading. Keep the stored link selected in the meantime.
    if (selected && !pages.has(selected)) {
      if (currentAction?.memory_page_id === selected) pages.set(selected, currentAction.memory_page_title || '已关联的记忆页');
      else if (select === newActionFields.page && newActionAttempt()?.payload.memory_page_id === selected) pages.set(selected, '已选择的记忆页');
      else if (select === actionEditor.elements.memory_page_id && MEMORY_ID.test(selected)) pages.set(selected, '已选择的记忆页');
    }
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '不关联';
    select.appendChild(empty);
    for (const [id, title] of pages) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = title;
      select.appendChild(option);
    }
    select.value = selected || '';
  }

  function renderActions(items) {
    const list = document.getElementById('action-list');
    const focus = list.contains?.(document.activeElement) ? document.activeElement.dataset || {} : {};
    const scope = actionDraftScope();
    const now = new Date();
    const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    list.replaceChildren();
    for (const item of items) {
      const li = document.createElement('li');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'action-row-toggle';
      toggle.dataset.actionToggle = item.id;
      toggle.dataset.status = item.status;
      toggle.setAttribute('aria-label', `${item.status === 'done' ? '重新打开' : '标记完成'}：${item.title}`);
      const busy = pendingQuickActions.has(quickActionKey(scope, item.id));
      toggle.setAttribute('aria-busy', String(busy));
      toggle.setAttribute('aria-disabled', String(busy));
      toggle.addEventListener('click', () => changeActionStatus(item));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'action-row-detail';
      const title = document.createElement('strong');
      title.textContent = item.title;
      const meta = document.createElement('span');
      meta.className = 'action-row-meta';
      const due = dueDateValue(item.due_at);
      meta.textContent = [item.status === 'done' ? '已完成' : '未完成',
        due && `截止 ${due}`, item.memory_page_title].filter(Boolean).join(' · ');
      if (item.status === 'open' && due && due < today) {
        const overdue = document.createElement('span');
        overdue.className = 'action-row-overdue';
        overdue.textContent = '已逾期';
        meta.append(document.createTextNode(' · '), overdue);
      }
      const copy = document.createElement('span');
      copy.className = 'action-row-copy';
      copy.append(title, meta);
      const arrow = document.createElement('span');
      arrow.className = 'action-row-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '›';
      button.append(copy, arrow);
      button.dataset.status = item.status;
      button.dataset.id = item.id;
      button.addEventListener('click', () => openAction(item.id));
      li.append(toggle, button);
      list.appendChild(li);
      if (focus.id === item.id) button.focus({preventScroll: true});
      if (focus.actionToggle === item.id) toggle.focus({preventScroll: true});
    }
    syncActionComposer();
  }

  function syncActionComposer() {
    const form = document.getElementById('new-action-form');
    const opener = document.getElementById('new-action-open');
    if (!form) return;
    form.hidden = form.dataset.open !== 'true';
    if (opener) {
      opener.setAttribute('aria-expanded', String(!form.hidden));
      opener.textContent = form.hidden ? '新建行动' : '收起表单';
    }
  }

  let actionListing;
  let actionSearchTimer;
  const pendingQuickActions = new Set();
  const quickActionKey = (scope, id) => JSON.stringify([scope, id]);

  async function changeActionStatus(item) {
    const state = actionListing;
    const scope = actionDraftScope();
    const key = quickActionKey(scope, item.id);
    if (!state || !scope || pendingQuickActions.has(key) || !state.items.includes(item)) return;
    const status = item.status === 'done' ? 'open' : 'done';
    const path = `/v1/workspaces/${state.workspace}/memory/actions/${item.id}`;
    pendingQuickActions.add(key);
    actionQuickStatus.textContent = '正在更新行动…';
    renderActions(state.items);
    const timeout = () => globalThis.AbortSignal?.timeout?.(8000);
    const result = await request('POST', path, {revision: item.revision, changes: {status}}, undefined, timeout())
      .catch(() => ({status:0, body:{}}));
    let updated = result.status === 200 ? result.body.action : result.body.error?.current;
    if (!updated && actionDraftScope() === scope &&
      (result.status === 0 || result.status === 408 || result.status >= 500)) {
      const checked = await request('GET', path, undefined, undefined, timeout()).catch(() => ({status:0, body:{}}));
      if (checked.status === 200) updated = checked.body.action;
    }
    pendingQuickActions.delete(key);
    if (actionDraftScope() !== scope) return;
    const active = actionListing;
    if (!active) return;
    const index = active.items.findIndex(row => row.id === item.id);
    const keepFocus = document.activeElement?.dataset.actionToggle === item.id;
    const valid = updated?.id === item.id && updated.workspace_id === state.workspace && updated.revision >= item.revision;
    const confirmed = valid && updated.status === status && updated.revision > item.revision;
    const current = valid && index >= 0 && updated.revision >= active.items[index].revision;
    const removed = current && active.status && active.status !== updated.status;
    if (removed) active.items.splice(index, 1);
    else if (current) active.items[index] = updated;
    renderActions(active.items);
    renderActionListing(active);
    if (keepFocus && removed) {
      const toggles = document.querySelectorAll('#action-list .action-row-toggle');
      (toggles[Math.min(index, toggles.length - 1)] || actionSearch).focus({preventScroll:true});
    }
    actionQuickStatus.textContent = confirmed ? (status === 'done' ? '行动已完成。' : '行动已重新打开。')
      : valid && updated.revision > item.revision ? '行动已在别处更新。请核对最新状态。'
        : '无法确认更新，请重试。';
    if (current && updated.revision > item.revision && !removed) {
      const limit = Math.max(20, active.items.length);
      const refresh = loadActions({limit: Math.min(100, limit)});
      const refreshed = actionListing;
      await refresh;
      if (limit > 100 && ownsActionListing(refreshed) && refreshed.cursor) {
        await readActionPage(refreshed, refreshed.cursor, false, limit - 100);
      }
    }
  }

  function renderActionListing(state) {
    const list = document.getElementById('action-list');
    const empty = document.getElementById('action-empty');
    const count = state?.items.length || 0;
    list.setAttribute('aria-busy', String(Boolean(state?.busy)));
    empty.hidden = !state || Boolean(count || state.busy || state.error);
    empty.textContent = state?.needle ? '没有符合搜索条件的行动。'
      : state?.status === 'done' ? '暂无已完成的行动。'
        : state?.status === 'open' ? '暂无未完成的行动。' : '暂无行动。';
    document.getElementById('action-list-count').textContent = state?.error ? '无法读取行动，请重试。'
      : state?.busy ? '正在读取行动…' : count ? `已显示 ${count} 项行动` : '';
    actionMore.hidden = !state?.cursor || Boolean(state.error);
    actionMore.disabled = Boolean(state?.busy);
    actionRetry.hidden = !state?.error;
    actionRetry.disabled = Boolean(state?.busy);
  }

  function stopActionListing() {
    clearTimeout(actionSearchTimer);
    actionSearchTimer = undefined;
    actionListing?.controller?.abort();
  }

  const ownsActionListing = state => actionListing === state && state.owner === currentUser && state.workspace === workspaceId();

  async function readActionPage(state, cursor, focusResults = false, limit) {
    if (!ownsActionListing(state) || state.controller) return;
    const controller = state.controller = new AbortController();
    state.busy = true;
    state.error = false;
    renderActionListing(state);
    const path = `/v1/workspaces/${state.workspace}/memory/actions${actionQuery(state.needle, state.status, cursor, limit, 'due')}`;
    const listed = await request('GET', path, undefined, undefined, controller.signal).catch(() => ({status:0, body:{}}));
    if (!ownsActionListing(state)) return;
    state.controller = null;
    state.busy = false;
    if (listed.status !== 200 || !Array.isArray(listed.body.items)) {
      state.error = true;
      state.retryCursor = cursor;
      renderActionListing(state);
      return;
    }
    const seen = new Set(cursor ? state.items.map(item => item.id) : []);
    const items = listed.body.items.filter(item => {
      if (!item?.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    state.items = cursor ? [...state.items, ...items] : items;
    const next = listed.body.cursor;
    state.cursor = next !== cursor && ACTION_DUE_CURSOR.test(next || '') ? next : '';
    renderActions(state.items);
    renderActionListing(state);
    if (focusResults) {
      const row = [...(document.getElementById('action-list').querySelectorAll?.('[data-id]') || [])]
        .find(button => button.dataset.id === items[0]?.id);
      (row || actionSearch).focus?.();
    }
  }

  function loadActions({delay = 0, limit} = {}) {
    stopActionListing();
    const workspace = workspaceId();
    const owner = currentUser;
    const previous = actionListing;
    const sameScope = previous && previous.workspace === workspace && previous.owner === owner;
    if (!sameScope) {
      actionSearch.value = '';
      if (actionQuickStatus) actionQuickStatus.textContent = '';
    }
    const needle = actionSearch.value.trim(), status = actionFilter.value;
    const keep = sameScope && previous.needle === needle && previous.status === status;
    const state = actionListing = workspace ? {workspace, owner, needle, status, items:keep ? previous.items : [], busy:true} : null;
    if (!keep) renderActions([]);
    renderActionListing(state);
    if (!state) return;
    if (!delay) return readActionPage(state, '', false, limit);
    actionSearchTimer = setTimeout(() => {
      actionSearchTimer = undefined;
      void readActionPage(state, '');
    }, delay);
  }


  function svgNode(name, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
    return node;
  }

  function truncateLabel(title) {
    const text = String(title || '');
    return text.length > 18 ? `${text.slice(0, 17)}…` : text;
  }

  function renderGraph(graph) {
    hideGraphHoverCard(document.getElementById('graph-hover-card'));
    const canvas = document.getElementById('graph-canvas');
    const counts = document.getElementById('graph-counts');
    const topicList = document.getElementById('topic-list');
    const topicEmpty = document.getElementById('topic-empty');
    const payload = graph || {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
    const stats = payload.counts || {nodes: 0, edges: 0, topics: 0};
    if (counts) {
      const linked = new Set();
      for (const edge of payload.edges || []) {
        if (edge.source) linked.add(edge.source);
        if (edge.target) linked.add(edge.target);
      }
      const unconnected = (payload.nodes || []).filter((node) => !linked.has(node.id)).length;
      counts.replaceChildren();
      for (const [value, label] of [[stats.nodes, '节点'], [stats.edges, '连接'], [unconnected, '未连接'], [stats.topics, '话题']]) {
        const item = document.createElement('span');
        item.className = 'memory-count';
        const strong = document.createElement('strong');
        strong.textContent = String(value ?? 0);
        const caption = document.createElement('span');
        caption.textContent = label;
        item.append(strong, caption);
        counts.appendChild(item);
      }
    }
    const empty = document.getElementById('graph-empty');
    if (empty) {
      empty.hidden = !graphEmptyStateVisible({
        nodeCount: (payload.nodes || []).length,
        query: topicQuery,
      });
    }
    if (canvas) {
      canvas.replaceChildren();
      const world = svgNode('g', {id: 'graph-world', transform: `translate(320 200) scale(${graphZoom}) translate(-320 -200)`});
      const placed = graphLayout(payload.nodes);
      const byId = new Map(placed.map((node) => [node.id, node]));
      const needle = topicQuery.trim().toLocaleLowerCase();
      const matches = (node) => {
        if (!needle) return true;
        if (String(node.title || '').toLocaleLowerCase().includes(needle)) return true;
        return (payload.topics || []).some((topic) => String(topic.name || '').toLocaleLowerCase().includes(needle)
          && (topic.pages || []).some((page) => page.id === node.id));
      };
      for (const edge of payload.edges || []) {
        const from = byId.get(edge.source);
        const to = byId.get(edge.target);
        if (!from || !to) continue;
        world.appendChild(svgNode('line', {
          class: 'graph-edge', x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        }));
      }
      for (const node of payload.nodes || []) {
        const point = byId.get(node.id);
        if (!point) continue;
        const group = svgNode('g', {'data-id': node.id, class: matches(node) ? 'graph-item' : 'graph-item is-muted'});
        const button = svgNode('circle', {class: 'graph-node', cx: point.x, cy: point.y, r: 8});
        const label = svgNode('text', {
          class: 'graph-label', x: point.x, y: point.y + 22, 'text-anchor': 'middle',
        });
        label.textContent = truncateLabel(node.title);
        group.appendChild(button);
        group.appendChild(label);
        const stage = canvas.parentElement;
        const card = document.getElementById('graph-hover-card');
        bindGraphNodeGestures(group, node, {
          openPage: id => openPage(id, undefined, id),
          card,
          pointerCoarse: currentPointerIsCoarse(),
          viewportWidth: currentViewportWidth(),
          positionFor: () => graphHoverCardPosition(stage, group),
        });
        world.appendChild(group);
      }
      canvas.appendChild(world);
    }
    if (topicList) {
      topicList.replaceChildren();
      for (const topic of payload.topics || []) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        const pages = (topic.pages || []).map((page) => page.title).filter(Boolean);
        button.textContent = pages.length
          ? `${topic.name} · ${topic.page_count} · ${pages.slice(0, 3).join('，')}`
          : `${topic.name} · ${topic.page_count}`;
        button.addEventListener('click', () => {
          const first = topic.pages && topic.pages[0];
          if (first) openPage(first.id);
        });
        item.appendChild(button);
        topicList.appendChild(item);
      }
    }
    if (topicEmpty) topicEmpty.hidden = sideTab !== 'topics' || !!(payload.topics && payload.topics.length);
    renderTopicFilters();
  }

  const emptyMemoryGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
  let currentGraph = emptyMemoryGraph;
  let graphRequest = 0;
  let graphWorkspace, graphOwner;
  const linkSearch = document.getElementById('link-search');
  const linkTarget = document.getElementById('link-target');
  const addLink = document.getElementById('add-link');
  const linksEmpty = document.getElementById('page-links-empty');
  const linkWrites = new Set();
  const linkAttempts = new Map();
  const linkScope = () => JSON.stringify([currentUser?.id, workspaceId(), currentPage?.id]);

  async function loadGraph() {
    const id = workspaceId();
    const owner = currentUser;
    const token = ++graphRequest;
    if (id !== graphWorkspace || owner !== graphOwner) {
      graphWorkspace = id;
      graphOwner = owner;
      currentGraph = emptyMemoryGraph;
      renderGraph(currentGraph);
    }
    if (!id) return;
    const seen = await request('GET', `/v1/workspaces/${id}/memory/graph`)
      .catch(() => ({status:0, body:{}}));
    if (token !== graphRequest || owner !== currentUser || workspaceId() !== id) return;
    if (seen.status !== 200) {
      currentGraph = emptyMemoryGraph;
      renderGraph(currentGraph);
      renderPageLinks();
      show('error', messageFor(seen.body.error, '无法加载记忆图谱。'));
      return;
    }
    currentGraph = seen.body;
    renderGraph(currentGraph);
    renderPageLinks();
    const createPage = document.getElementById('new-action-page');
    if (createPage) fillPageSelect(createPage, createPage.value);
    if (currentAction && actionEditor?.elements.memory_page_id) {
      const selectedPage = actionEditor.elements.memory_page_id;
      fillPageSelect(selectedPage, selectedPage.value);
    }
  }

  function pageLinks() {
    if (!currentPage || graphOwner !== currentUser || graphWorkspace !== workspaceId()) return [];
    return (currentGraph.edges || []).filter(edge => edge.source === currentPage.id || edge.target === currentPage.id);
  }

  const linkedPageId = edge => edge.source === currentPage.id ? edge.target : edge.source;

  function renderLinkChoices(edges = pageLinks()) {
    if (!currentPage || !linkTarget) return;
    const selection = linkTarget.value;
    const needle = (linkSearch?.value || '').trim().normalize('NFKC').toLowerCase();
    const used = new Set(edges.map(linkedPageId));
    used.add(currentPage.id);
    const candidates = graphOwner === currentUser && graphWorkspace === workspaceId() ? currentGraph.nodes || [] : [];
    const choices = candidates.filter(page => !used.has(page.id) && typeof page.title === 'string' &&
      page.title.normalize('NFKC').toLowerCase().includes(needle));
    linkTarget.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = choices.length ? '选择记忆页' : needle ? '没有匹配的记忆页' : '暂无可连接的记忆页';
    linkTarget.append(empty);
    for (const page of choices) {
      const option = document.createElement('option');
      option.value = page.id;
      option.textContent = page.title;
      linkTarget.append(option);
    }
    linkTarget.value = choices.some(page => page.id === selection) ? selection : '';
    const pending = linkWrites.has(linkScope());
    linkTarget.disabled = !choices.length || pending;
    if (addLink) addLink.disabled = !linkTarget.value || pending;
  }

  function renderPageLinks() {
    const box = document.getElementById('page-links');
    if (!box || !currentPage) return;
    box.replaceChildren();
    const edges = pageLinks();
    for (const edge of edges) {
      const otherId = linkedPageId(edge);
      const other = (currentGraph.nodes || []).find((node) => node.id === otherId);
      if (!other || !MEMORY_ID.test(otherId)) continue;
      const row = document.createElement('li');
      const link = document.createElement('a');
      const workspace = workspaceId();
      const owner = currentUser;
      const sourceId = currentPage.id;
      link.href = '/memory?' + new URLSearchParams({workspace, page:otherId});
      link.textContent = other.title;
      link.addEventListener('click', event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        event.preventDefault();
        if (workspaceId() === workspace && currentPage?.id === sourceId && currentUser === owner) {
          return openPage(otherId, undefined, undefined, {fromConnection:true});
        }
      });
      const label = document.createElement('span');
      label.className = 'note';
      label.textContent = edge.kind === 'manual' ? '手动连接' : '正文提及';
      row.append(link, label);
      if (edge.kind === 'manual' && edge.id) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = '删除连接';
        button.addEventListener('click', () => removeLink(edge.id));
        row.appendChild(button);
      }
      box.appendChild(row);
    }
    if (linksEmpty) linksEmpty.hidden = box.children.length > 0;
    renderLinkChoices(edges);
  }

  async function removeLink(linkId) {
    const id = workspaceId();
    const owner = currentUser;
    const scope = linkScope();
    if (!id || !linkId) return;
    const removed = await request('POST', `/v1/workspaces/${id}/memory/links/${linkId}/remove`, {}, undefined,
      AbortSignal.timeout(8000)).catch(() => ({status:0,body:{}}));
    if (workspaceId() !== id || currentUser !== owner) return;
    if (removed.status !== 200) {
      if (linkScope() === scope) show('error', messageFor(removed.body.error, '无法删除连接。'));
      return;
    }
    if (linkScope() === scope) show('ok', '已删除连接。');
    await loadGraph();
  }

  function fillWorkspaces(items) {
    const previous = workspaceId();
    personalWorkspaces = new Set(items.filter(space => space.kind === 'personal').map(space => space.id));
    workspaceSelect.replaceChildren();
    for (const space of items) {
      const option = document.createElement('option');
      option.value = space.id;
      option.textContent = space.name;
      workspaceSelect.appendChild(option);
    }
    if (items.some(item => item.id === previous)) workspaceSelect.value = previous;
    if (!workspaceSelect.value && items[0]) workspaceSelect.value = items[0].id;
    if (currentAction) syncActionFollowup();
  }

  async function loadSession() {
    persistPageDraft();
    const seq = ++sessionRequest;
    const session = await request('GET', '/v1/auth/session');
    if (seq !== sessionRequest) return;
    if (session.status !== 200 || !session.body.user) {
      persistPageDraft();
      currentUser = null;
      currentPage = null;
      currentAction = null;
      syncNewActionWorkspace();
      stopActionListing();
      actionListing = null;
      setCitation(null);
      cancelDirectorySearch();
      browseDirectory?.controller?.abort();
      browseDirectory = activeDirectory = null;
      pageChoices = [];
      actionDrafts.clear();
      actionDraftPageScope = '';
      renderActionDrafts();
      candidates.show(false);
      loginPanel.hidden = false;
      mainPanel.hidden = true;
      editor.hidden = true;
      if (actionEditor) actionEditor.hidden = true;
      await renderProviders();
      return;
    }
    if (currentUser?.id !== session.body.user.id) {
      persistPageDraft();
      currentPage = null;
      currentAction = null;
      editor.hidden = true;
      actionEditor.hidden = true;
      actionDrafts.clear();
      actionDraftPageScope = '';
    }
    currentUser = session.body.user;
    loginPanel.hidden = true;
    mainPanel.hidden = false;
    const whoami = document.getElementById('whoami');
    whoami.dataset.username = currentUser.username;
    whoami.textContent = '已登录：' + currentUser.username;
    const linked = new URLSearchParams(document.defaultView?.location?.search || '');
    const citation = memoryCitationFromSearch(linked);
    const workspace = linked.get('workspace'), pageId = linked.get('page');
    const scopedLink = /^[0-9a-f]{32}$/.test(workspace || '');
    const deepLink = scopedLink && /^[0-9a-f]{32}$/.test(pageId || '');
    const actionId = linked.get('action');
    const deepAction = scopedLink && pageId === 'todos' && /^[0-9a-f]{32}$/.test(actionId || '');
    const revision = memoryRevisionFromSearch(linked);
    let {initial, supplemental} = await readWorkspaceChoices(request, '/v1/workspaces');
    if (scopedLink && !initial.body.items?.some(item => item.id === workspace) && supplemental) {
      const shared = await supplemental;
      if (shared.status === 200) initial = shared;
      supplemental = null;
    }
    if (seq !== sessionRequest) return;
    const workspaces = initial.status === 200 ? (initial.body.items || []) : [];
    fillWorkspaces(workspaces);
    const missingWorkspace = scopedLink && !workspaces.some(item => item.id === workspace);
    if (scopedLink && !missingWorkspace) workspaceSelect.value = workspace;
    if (missingWorkspace) currentView = 'overview';
    if (initial.status !== 200) show('error', '无法读取工作区，请刷新重试。');
    void supplemental?.then(result => {
      if (seq === sessionRequest && result.status === 200) fillWorkspaces(result.body.items);
    });
    const openingPage = deepLink && !missingWorkspace;
    const openingAction = deepAction && !missingWorkspace;
    const directory = loadWorkspace({syncView: !openingPage && !openingAction && !missingWorkspace && !citation});
    setCitation(citation);
    if (citation && !missingWorkspace && citation.page === 'profile') syncViewUrl();
    if (openingPage || openingAction) {
      await Promise.all([directory, openingAction ? openAction(actionId) : openPage(pageId,revision)]);
    } else {
      await directory;
      if (missingWorkspace && seq === sessionRequest) {
        if (citation && activeCitation === citation) setCitationStatus('此工作区的记忆已无法访问。');
        else if (!citation) show('error', '无法打开此工作区的记忆。');
      }
    }
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

  async function loadWorkspace({syncView = true} = {}) {
    persistPageDraft();
    directoryReturn = null;
    closeDeleteConfirm({restoreFocus: false});
    const id = workspaceId();
    const switched = browseDirectory?.workspace !== id || browseDirectory?.owner !== currentUser;
    ++workspaceRequest;
    cancelDirectorySearch();
    browseDirectory?.controller?.abort();
    browseDirectory = id ? directoryWindow() : null;
    activeDirectory = browseDirectory;
    if (switched) {
      unreadCount = null;
      readRevisions.clear();
      restoreDirectoryAddress();
      currentGraph = {nodes: [], edges: [], topics: [], counts: {nodes: 0, edges: 0, topics: 0}};
      renderGraph(currentGraph);
      renderActions([]);
    }
    pageChoices = [];
    renderRecent([]);
    syncNewActionWorkspace();
    fillPageSelect(newActionFields.page, newActionFields.page.value);
    actionDraftPageScope = '';
    renderActionDrafts();
    newPageButton.disabled = true;
    currentPage = null;
    currentAction = null;
    syncExportButton();
    editor.hidden = true;
    if (actionEditor) actionEditor.hidden = true;
    listPanel.hidden = false;
    showView(currentView, {sync:syncView});
    renderDirectory();
    if (!id) return loadActions();
    searchDirectory();
    await Promise.allSettled([loadDirectoryPage(browseDirectory), loadActions(), loadGraph()]);
  }

  let directoryReturn = null;

  // While a page or action is open the directory column stays visible (as in
  // the recorded editor); only the overview/side/actions/profile panels hide.
  function showPageMode(graphId) {
    if (listPanel.dataset.view !== 'page') {
      const scrollers = [document.scrollingElement, document.getElementById('main'), listPanel,
        document.getElementById('memory-dir'), listEl].filter(Boolean);
      directoryReturn = {
        state: activeDirectory,
        scroll: scrollers.map(node => [node, node.scrollTop]),
        graphId,
        mobileGraph: listPanel.dataset.mobileGraph === 'true',
      };
    }
    closeProfilePreview();
    candidates.show(false);
    listPanel.hidden = false;
    listPanel.dataset.view = 'page';
    for (const id of ['overview-panel', 'memory-side', 'actions-panel', 'profile-panel']) {
      const panel = document.getElementById(id);
      if (panel) panel.hidden = true;
    }
    if (document.defaultView?.matchMedia?.('(max-width: 700px)').matches) listPanel.scrollTop = 0;
  }

  function focusDetailBack(id) {
    const back = document.getElementById(id);
    back?.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
    back?.focus?.({preventScroll: true});
  }

  const rich = document.getElementById('editor-rich');
  const sourceToggle = document.getElementById('editor-source-toggle');
  let sourceMode = false;
  // Only an edited rich body is re-serialised, so opening and saving a page
  // without touching the text keeps its stored markdown byte-for-byte.
  let richDirty = false;
  const tableActions = document.getElementById('editor-table-actions');
  let activeTableCell;
  function syncTableActions() {
    if (!tableActions || !rich) return;
    const focus = document.getSelection?.()?.focusNode;
    const cell = (focus?.nodeType === 1 ? focus : focus?.parentElement)?.closest('th, td');
    if (sourceMode || (activeTableCell && !rich.contains(activeTableCell))) activeTableCell = null;
    if (!sourceMode && cell && rich.contains(cell) && cell.closest('.chat-markdown-table')) activeTableCell = cell;
    else if (activeTableCell && !tableActions.contains(document.activeElement)) activeTableCell = null;
    tableActions.hidden = !activeTableCell;
    if (!activeTableCell) {
      tableActions.open = false;
      return;
    }
    const table = activeTableCell.closest('table');
    const bodyRows = table.tBodies[0]?.rows.length || 0;
    const columns = table.rows[0].cells.length;
    tableActions.querySelector('[data-table-edit="add-row"]').disabled = bodyRows >= MAX_TABLE_ROWS;
    tableActions.querySelector('[data-table-edit="add-column"]').disabled = columns >= MAX_TABLE_COLUMNS;
    tableActions.querySelector('[data-table-edit="remove-row"]').disabled = activeTableCell.parentElement.rowIndex === 0;
    tableActions.querySelector('[data-table-edit="remove-column"]').disabled = columns <= 1;
  }

  function syncBodyFromRich() {
    if (!rich || sourceMode || !richDirty) return;
    const markdown = domToMarkdown(rich);
    richDirty = false;
    editor.elements.body.value = markdown;
    const length = document.getElementById('editor-length');
    if (length) {
      const over = markdown.length > 8000;
      length.hidden = !over;
      length.textContent = over ? `正文 ${markdown.length} / 8000 字符，超出上限，保存会被拒绝。` : '';
    }
  }
  function loadRichBody(markdown) {
    if (!rich) return;
    renderMarkdown(document, rich, markdown, {readTable:readMarkdownTable, renderTable:renderMarkdownTable, interactiveTasks:true});
    richDirty = false;
    syncTableActions();
  }
  function setSourceMode(next) {
    if (!rich) return;
    if (next === sourceMode) return;
    if (next) syncBodyFromRich();
    sourceMode = next;
    const field = editor.querySelector('.editor-body-field');
    if (field) field.hidden = !next;
    rich.hidden = next;
    if (!next) loadRichBody(editor.elements.body.value);
    if (next) syncTableActions();
    if (sourceToggle) sourceToggle.setAttribute('aria-pressed', next ? 'true' : 'false');
  }
  if (rich) {
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* older engines */ }
    rich.addEventListener('input', () => { richDirty = true; syncBodyFromRich(); });
    if (tableActions) {
      document.addEventListener('selectionchange', syncTableActions);
      editor.addEventListener('focusout', event => {
        if (!editor.contains(event.relatedTarget)) {
          activeTableCell = null;
          tableActions.hidden = true;
          tableActions.open = false;
        }
      });
    }
    rich.addEventListener('paste', (event) => {
      // Paste as plain text so foreign HTML never enters the page.
      const text = event.clipboardData && event.clipboardData.getData('text/plain');
      if (text == null) return;
      event.preventDefault();
      document.execCommand('insertText', false, text);
    });
  }
  if (sourceToggle) sourceToggle.addEventListener('click', () => setSourceMode(!sourceMode));

  const draftPanel = document.getElementById('memory-page-draft');
  const draftStatus = document.getElementById('memory-page-draft-status');
  const draftDetails = document.getElementById('memory-page-draft-details');
  const draftCopy = document.getElementById('memory-page-draft-copy');
  const draftDiscard = document.getElementById('memory-page-draft-discard');
  const savePageButton = document.getElementById('save-page');
  const savingPages = new Set();
  let draftTimer;

  function pageDraftKey(page = currentPage, owner = currentUser) {
    if (!page?.workspace_id || !page.id || !owner?.id) return '';
    return 'flybot-workspace.memory-draft:' + JSON.stringify([owner.id, page.workspace_id, page.id]);
  }

  function pageDraft(key) {
    if (!key) return null;
    try {
      const value = JSON.parse(document.defaultView.sessionStorage.getItem(key));
      if (Number.isSafeInteger(value?.revision) && value.revision > 0 &&
          ['title','body','topics'].every(field => typeof value[field] === 'string')) return value;
    } catch {}
    return null;
  }

  function clearPageDraft(key) {
    if (!key) return;
    try { document.defaultView.sessionStorage.removeItem(key); } catch {}
  }

  function writePageDraft(key, {title, body, topics}, revision) {
    try { document.defaultView.sessionStorage.setItem(key, JSON.stringify({title, body, topics, revision})); } catch {}
  }

  function syncPageSaveButton() {
    if (!savePageButton) return;
    const saving = savingPages.has(pageDraftKey());
    savePageButton.disabled = saving;
    savePageButton.textContent = saving ? '正在保存…' : '保存';
  }

  function editorFields() {
    syncBodyFromRich();
    const {title, body, topics} = editor.elements;
    return {title: title.value, body: body.value, topics: topics.value};
  }

  function sameFields(left, right) {
    return Boolean(left && left.title === right.title && left.body === right.body && left.topics === right.topics);
  }

  function pageMatchesDraft(page, draft) {
    const savedTopics = new Set(page.topics || []);
    const topics = parseTopics(draft.topics);
    return page.title === draft.title.trim() && (page.body || '') === draft.body &&
      savedTopics.size === topics.length && topics.every(topic => savedTopics.has(topic));
  }

  function fillEditorFields(fields) {
    editor.elements.title.value = fields.title;
    editor.elements.body.value = fields.body;
    editor.elements.topics.value = fields.topics;
    loadRichBody(fields.body);
  }

  function updatePageSaveHint(page, dirty = false) {
    const hint = document.getElementById('editor-saved');
    if (!hint) return;
    const when = memoryUpdatedLabel(page.updated);
    hint.hidden = false;
    hint.textContent = dirty ? '有未保存的修改' : '已保存 · ' + (when || '修订 ' + page.revision);
  }

  function showPageDraft({restore = false} = {}) {
    if (!draftPanel) return;
    const key = pageDraftKey();
    const entry = pageDraft(key);
    draftPanel.hidden = true;
    draftDetails.open = false;
    draftCopy.value = '';
    if (!entry || pageMatchesDraft(currentPage, entry)) {
      if (entry) clearPageDraft(key);
      return;
    }
    const conflict = entry.revision !== currentPage.revision;
    if (restore && !conflict) {
      fillEditorFields(entry);
      updatePageSaveHint(currentPage, true);
    }
    draftPanel.hidden = false;
    draftDetails.hidden = !conflict;
    draftStatus.textContent = conflict ? '此页已更新。旧草稿可复制，清除后可继续保存新的草稿。'
      : '此标签页已保留草稿。点击保存后会更新记忆页。';
    if (conflict) draftCopy.value = [entry.title, entry.body, entry.topics].join('\n\n');
  }

  function persistPageDraft() {
    clearTimeout(draftTimer);
    const key = pageDraftKey();
    if (!key || editor.hidden) return;
    const fields = editorFields();
    const entry = pageDraft(key);
    if (entry && entry.revision !== currentPage.revision) return;
    if (pageMatchesDraft(currentPage, fields)) {
      clearPageDraft(key);
    } else writePageDraft(key, fields, currentPage.revision);
    // Leave an expanded revision-conflict preview alone while the user copies it.
    if (!draftDetails?.open) showPageDraft();
  }

  function pageDraftChanged() {
    if (!currentPage || editor.hidden) return;
    updatePageSaveHint(currentPage, !pageMatchesDraft(currentPage, editorFields()));
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistPageDraft, 200);
  }

  editor.addEventListener('input', pageDraftChanged);
  document.defaultView?.addEventListener?.('pagehide', persistPageDraft);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistPageDraft();
  });
  draftDiscard?.addEventListener('click', () => {
    const key = pageDraftKey();
    const entry = pageDraft(key);
    if (!entry) return;
    clearTimeout(draftTimer);
    clearPageDraft(key);
    if (entry.revision === currentPage.revision) applyPageToEditor(currentPage);
    else persistPageDraft();
    showPageDraft();
    editor.elements.title.focus();
  });

  function applyTableEdit(action) {
    if (sourceMode || !rich?.contains(activeTableCell)) return;
    if (!editRichTable(document, rich, activeTableCell, action)) return;
    tableActions.open = false;
    syncTableActions();
  }

  tableActions?.addEventListener('click', event => {
    const button = event.target.closest('[data-table-edit]');
    if (button) applyTableEdit(button.dataset.tableEdit);
  });
  tableActions?.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !tableActions.open) return;
    event.preventDefault();
    tableActions.open = false;
    tableActions.querySelector('summary').focus();
  });

  function richCommand(kind) {
    if (!rich) return;
    rich.focus();
    const block = (tag) => {
      const current = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
      document.execCommand('formatBlock', false, current === tag ? 'p' : tag);
    };
    const simple = {undo: 'undo', redo: 'redo', bold: 'bold', italic: 'italic', strike: 'strikeThrough',
      ul: 'insertUnorderedList', ol: 'insertOrderedList', hr: 'insertHorizontalRule'};
    if (simple[kind]) document.execCommand(simple[kind], false, null);
    else if (kind === 'h1' || kind === 'h2' || kind === 'h3') block(kind);
    else if (kind === 'quote') block('blockquote');
    else if (kind === 'code') {
      const selection = document.getSelection();
      if (selection && selection.rangeCount && rich.contains(selection.anchorNode)) {
        const range = selection.getRangeAt(0);
        const code = document.createElement('code');
        code.textContent = range.toString() || '代码';
        range.deleteContents();
        range.insertNode(code);
        selection.removeAllRanges();
        const after = document.createRange();
        after.selectNodeContents(code);
        selection.addRange(after);
      }
    } else if (kind === 'tasks' || kind === 'table') {
      const selection = document.getSelection();
      if (!selection?.rangeCount || !rich.contains(selection.anchorNode) || !rich.contains(selection.focusNode)) return;
      const selected = selection.toString();
      const generated = document.createElement('div');
      renderMarkdown(document, generated, memoryBlock(kind, selected),
        {readTable:readMarkdownTable, renderTable:renderMarkdownTable, interactiveTasks:true});
      if (kind === 'table') {
        const range = selection.getRangeAt(0);
        const block = Array.from(rich.children).find(child => child.contains(range.endContainer));
        const next = block ? block.nextSibling : rich.childNodes[range.endOffset];
        const table = generated.firstChild;
        rich.insertBefore(table, next ?? null);
        range.selectNodeContents(table.querySelector('th'));
      } else {
        // Only the markup produced by the safe Markdown renderer enters the editor.
        document.execCommand('insertHTML', false, generated.innerHTML);
      }
    } else if (kind === 'link') {
      const answer = globalThis.prompt ? globalThis.prompt('链接地址（https://、mailto: 或站内 /路径）', 'https://') : '';
      const href = safeHref(answer);
      if (href) document.execCommand('createLink', false, href);
      else if (answer) show('error', '只支持 https://、http://、mailto: 或站内路径的链接。');
    }
    richDirty = true;
    syncBodyFromRich();
    if (kind === 'table') pageDraftChanged();
  }

  const exportButton = document.getElementById('page-export');
  const exportStatus = document.getElementById('page-export-status');

  // Export reads the saved page from the server, so it never ships an unsaved
  // draft and it stays identical to what a later reader would find.
  function syncExportButton() {
    if (!exportButton) return;
    const ready = Boolean(currentPage && workspaceId());
    exportButton.disabled = !ready;
    exportButton.title = ready
      ? '把这页已保存的标题、话题和正文导出为 Markdown 文件。'
      : '打开一页记忆后才能导出为 Markdown。';
    if (!ready && exportStatus) {
      exportStatus.hidden = true;
      exportStatus.textContent = '';
    }
  }

  async function exportCurrentPage() {
    if (!currentPage) return;
    const id = workspaceId();
    if (!id) return;
    const url = `/v1/workspaces/${id}/memory/${currentPage.id}/export`;
    const name = exportDownloadName(currentPage.title);
    exportButton.disabled = true;
    try {
      const response = await fetcher(url, {
        method: 'GET', headers: {'Accept': 'text/markdown'}, credentials: 'same-origin',
      });
      if (response.status !== 200) {
        let parsed = {};
        try { parsed = await response.json(); } catch { parsed = {}; }
        show('error', messageFor(parsed.error, '无法导出这页记忆。'));
        return;
      }
      const markdown = await response.text();
      if (exportStatus) {
        exportStatus.hidden = false;
        exportStatus.textContent = '已导出 ' + name + ' · 修订 ' + currentPage.revision;
      }
      const objectUrl = globalThis.URL && globalThis.URL.createObjectURL
        ? globalThis.URL.createObjectURL(new Blob([markdown], {type: 'text/markdown;charset=utf-8'}))
        : '';
      if (!objectUrl) {
        globalThis.location.assign(url);
        show('ok', '已开始下载 ' + name + '。');
        return;
      }
      const download = document.createElement('a');
      download.href = objectUrl;
      download.download = name;
      download.rel = 'noopener';
      document.body.appendChild(download);
      download.click();
      download.remove();
      globalThis.URL.revokeObjectURL(objectUrl);
      show('ok', '已导出 ' + name + '。');
    } finally {
      syncExportButton();
    }
  }

  if (exportButton) exportButton.addEventListener('click', exportCurrentPage);
  // 做梦 asks the server for one consolidation of this page. Accept is the only
  // path that writes the page; ignore and an empty answer leave the text alone.
  const dreamPanel = document.getElementById('dream-panel');
  const dreamButton = document.getElementById('dream-page');
  const dreamSummary = document.getElementById('dream-summary');
  const dreamStatus = document.getElementById('dream-status');
  let dreamSuggestion = null;

  function resetDream(summary = '', status = '') {
    if (dreamSummary) dreamSummary.textContent = summary;
    if (dreamStatus) dreamStatus.textContent = status;
  }

  async function dreamDecide(action) {
    const pageId = currentPage && currentPage.id;
    const wid = workspaceId();
    if (!pageId || !wid || !dreamSuggestion) return;
    const suggestion = dreamSuggestion;
    const originalBody = editor.elements.body.value;
    if (action === 'accept' && originalBody !== (currentPage.body || '')) {
      resetDream(suggestion.summary, '请先保存编辑中的正文，然后重新生成建议。');
      return;
    }
    const result = await request('POST', `/v1/workspaces/${wid}/memory/${pageId}/dream/${suggestion.id}`, {action});
    if (workspaceId() !== wid || currentPage?.id !== pageId || dreamSuggestion !== suggestion) return;
    if (result.status !== 200) {
      if (dreamStatus) dreamStatus.textContent = messageFor(result.body.error, '整理建议没有保存成功。');
      return;
    }
    dreamSuggestion = null;
    if (result.body.suggestion?.status === 'accepted' && result.body.page) {
      const title = editor.elements.title.value;
      const topics = editor.elements.topics.value;
      const editedBody = editor.elements.body.value !== originalBody ? editor.elements.body.value : null;
      applyPageToEditor(result.body.page);
      editor.elements.title.value = title;
      editor.elements.topics.value = topics;
      if (editedBody !== null) {
        editor.elements.body.value = editedBody;
        loadRichBody(editedBody);
      }
      rememberPage(currentPage);
      syncPageUrl();
      if (historyPanel && !historyPanel.hidden) void loadPageHistory();
      resetDream('已合并重复段落。', editedBody === null ? '原文可在历史中查看。' : '已保留编辑框中尚未保存的内容。');
      return;
    }
    resetDream('', '已忽略，原文没有改动。');
  }

  if (dreamButton) dreamButton.addEventListener('click', async () => {
    const pageId = currentPage && currentPage.id;
    const wid = workspaceId();
    if (!pageId || !wid) return;
    if (dreamPanel) dreamPanel.hidden = false;
    const result = await request('POST', `/v1/workspaces/${wid}/memory/${pageId}/dream`, {});
    if (workspaceId() !== wid || currentPage?.id !== pageId) return;
    if (result.status !== 200) {
      if (dreamStatus) dreamStatus.textContent = messageFor(result.body.error, '这一页暂时不能整理。');
      return;
    }
    if (!result.body.suggestion) {
      dreamSuggestion = null;
      resetDream(result.body.message || '这一页现在没有可以合并的重复段落。', '原文没有改动。');
      return;
    }
    dreamSuggestion = result.body.suggestion;
    resetDream(dreamSuggestion.summary, '接受后会保存一份合并后的新版本。');
  });
  for (const [id, action] of [['dream-accept', 'accept'], ['dream-ignore', 'ignore']]) {
    const button = document.getElementById(id);
    if (button) button.addEventListener('click', () => dreamDecide(action));
  }

  const groupShareButton = document.getElementById('memory-share-group');
  const groupShareDialog = document.getElementById('memory-share-dialog');
  const groupShareStatus = document.getElementById('memory-share-status');
  const groupShareSubmit = document.getElementById('memory-share-submit');
  let groupShare = null;
  groupShareButton?.addEventListener('click', () => {
    if (currentPage?.source?.kind !== 'group') return;
    groupShare = {user:currentUser?.id, workspace:workspaceId(), page:currentPage, pending:false};
    document.getElementById('memory-share-title').textContent = currentPage.title;
    document.getElementById('memory-share-body').textContent = currentPage.body;
    groupShareStatus.textContent = '';
    groupShareSubmit.disabled = false;
    groupShareDialog.showModal();
  });
  document.getElementById('memory-share-cancel')?.addEventListener('click', () => groupShareDialog.close());
  groupShareDialog?.addEventListener('close', () => {
    if (!groupShareDialog.open) groupShare = null;
  });
  document.getElementById('memory-share-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = groupShare;
    if (!draft || draft.pending) return;
    if (draft.user !== currentUser?.id || draft.workspace !== workspaceId() ||
        draft.page.id !== currentPage?.id || draft.page.revision !== currentPage.revision) {
      groupShareDialog.close();
      return;
    }
    draft.pending = groupShareSubmit.disabled = true;
    groupShareStatus.textContent = '正在分享…';
    const result = await request('POST', `/v1/workspaces/${draft.workspace}/memory/${draft.page.id}/share-group`,
      {revision:draft.page.revision}).catch(() => ({status:0,body:{}}));
    if (groupShare !== draft || !groupShareDialog.open) return;
    draft.pending = groupShareSubmit.disabled = false;
    if (result.status !== 200) {
      groupShareStatus.textContent = messageFor(result.body.error,'分享失败，请重试。');
      return;
    }
    groupShareDialog.close();
    show('ok', '已分享到来源群。');
  });

  function unavailableCitation(status, message) {
    const unavailable = [403, 404, 410].includes(status);
    setCitationStatus(unavailable ? message : '暂时无法读取引用的记忆。请重试。');
    if (unavailable) citationBody?.replaceChildren();
    if (unavailable && citationEdit) citationEdit.hidden = true;
    if (citationRetry) citationRetry.hidden = unavailable;
  }

  async function openCitedRevision(citation, revision, isCurrent) {
    persistPageDraft();
    showPageMode();
    currentPage = currentAction = null;
    editor.hidden = true;
    if (actionEditor) actionEditor.hidden = true;
    citationRevision = revision;
    citationPreview.hidden = false;
    citationTitle.textContent = '引用的记忆';
    citationVersion.textContent = '引用版本 · 修订 ' + revision;
    citationBody.replaceChildren();
    citationEdit.hidden = citationRetry.hidden = true;
    setCitationStatus('正在读取引用版本…');
    const path = `/v1/workspaces/${citation.workspace}/memory/${citation.page}`;
    const seen = await request('GET', path + '/versions/' + revision).catch(() => ({status: 0, body: {}}));
    if (!isCurrent()) return;
    let version = seen.status === 200 ? seen.body.version : null;
    let latest = seen.body.current;
    if (seen.status === 404) {
      const current = await request('GET', path).catch(() => ({status: 0, body: {}}));
      if (!isCurrent()) return;
      if (current.status !== 200 || current.body.page?.id !== citation.page) {
        unavailableCitation(current.status, '这条记忆已删除或无法访问。');
        citationTitle.focus?.();
        return;
      }
      latest = current.body.page.revision;
      if (latest === revision) version = current.body.page;
      else {
        citationEdit.hidden = false;
        setCitationStatus('引用版本已无法读取。可以编辑当前版本。');
        citationTitle.focus?.();
        return;
      }
    }
    if (version?.revision !== revision || typeof version.body !== 'string' || typeof version.title !== 'string') {
      unavailableCitation(seen.status, '这条记忆已删除或无法访问。');
      citationTitle.focus?.();
      return;
    }
    citationTitle.textContent = version.title;
    if (Number.isSafeInteger(latest) && latest > revision) {
      citationVersion.textContent += ' · 当前修订 ' + latest;
    }
    if (version.body.trim()) renderMarkdown(document, citationBody, version.body,
      {readTable:readMarkdownTable, renderTable:renderMarkdownTable});
    else citationBody.textContent = '（空白正文）';
    citationEdit.hidden = false;
    setCitationStatus('');
    citationTitle.focus?.();
  }

  async function openPage(pageId, revision, graphId, {fromDirectory = false, fromConnection = false} = {}) {
    if (groupShareDialog?.open) groupShareDialog.close();
    closeDeleteConfirm({restoreFocus: false});
    closePageHistory({restoreFocus: false});
    hideGraphHoverCard(document.getElementById('graph-hover-card'));
    const id = workspaceId();
    if (!id) return;
    const seq = workspaceRequest;
    const token = ++pageRequest;
    const owner = currentUser;
    const returnPage = fromConnection ? currentPage?.id : undefined;
    const citation = citationFor(pageId);
    if (activeCitation !== citation) setCitation(citation);
    const isCurrent = () => seq === workspaceRequest && token === pageRequest && owner === currentUser &&
      (!fromConnection || (!editor.hidden && returnPage === currentPage?.id));
    if (citation && revision && citationPreview) return openCitedRevision(citation, revision, isCurrent);
    const seen = await request('GET', `/v1/workspaces/${id}/memory/${pageId}`).catch(() => ({status: 0, body: {}}));
    if (!isCurrent()) return;
    if (seen.status !== 200 || seen.body.page?.id !== pageId || (seen.body.page.workspace_id && seen.body.page.workspace_id !== id)) {
      if (citation) unavailableCitation(seen.status, '这条记忆已删除或无法访问。');
      else show('error', messageFor(seen.body.error, '无法打开记忆页。'));
      return;
    }
    const page = seen.body.page;
    hideCitationPreview();
    if (returnPage) writeDirectoryAddress(undefined,{reopenPage:true});
    showPage(page, revision, graphId, fromConnection || (fromDirectory && listPanel.dataset.view === 'overview'), returnPage);
    if (!revision || revision === page.revision) markPageRead(page);
    if (citation) setCitationStatus('');
    if (revision && revision !== page.revision && historyPanel) {
      const listing = openPageHistory({focus:false});
      const preview = historyPreviewToken;
      await listing;
      if (seq === workspaceRequest && token === pageRequest && currentPage?.id === pageId
          && !historyPanel.hidden && preview === historyPreviewToken) await previewPageVersion(revision);
    }
  }

  function markPageRead(page) {
    const workspace = workspaceId();
    const owner = currentUser;
    const sequence = workspaceRequest;
    pageReadQueue = pageReadQueue.then(() => savePageRead(page, {workspace, owner, sequence}));
  }

  async function savePageRead(page, {workspace, owner, sequence}) {
    const current = () => sequence === workspaceRequest && owner === currentUser && workspace === workspaceId();
    if (!current()) return;
    if (unreadCount == null || !MEMORY_ID.test(page.id) || page.workspace_id !== workspace ||
        !Number.isSafeInteger(page.revision) || page.revision <= (readRevisions.get(page.id) ?? 0)) return;
    if (browseDirectory?.items.some(item => item.id === page.id && item.revision === page.revision && item.unread === false)) return;
    const response = await request('POST', `/v1/workspaces/${workspace}/memory/${page.id}/read`,
      {revision: page.revision}, undefined, AbortSignal.timeout(6000)).catch(() => null);
    const body = response?.body;
    if (!current() || response?.status !== 200 ||
        body?.page_id !== page.id || !Number.isSafeInteger(body.read_revision) || body.read_revision < page.revision ||
        !Number.isSafeInteger(body.unread_total) || body.unread_total < 0) return;
    ++readGeneration;
    unreadCount = body.unread_total;
    const lastRead = Math.max(body.read_revision, readRevisions.get(page.id) ?? 0);
    readRevisions.set(page.id, lastRead);
    for (const state of new Set([browseDirectory, activeDirectory])) {
      const row = state?.items.find(item => item.id === page.id);
      if (!row || row.revision > lastRead || row.unread === false) continue;
      row.unread = false;
      if (state.unread) {
        state.items = state.items.filter(item => item !== row);
        if (state.total > 0) state.total -= 1;
      }
    }
    renderDirectory();
  }

  function showPage(page, revision, graphId, push = false, returnPage) {
    persistPageDraft();
    if (activeCitation && !citationFor(page.id)) setCitation(null);
    hideCitationPreview();
    const source = document.getElementById('memory-page-chat-source');
    const href = sourceHref(workspaceId(), page.source);
    if (source) source.hidden = !href;
    if (groupShareButton) groupShareButton.hidden = !href || page.source.kind !== 'group';
    if (href) {
      const link = document.getElementById('memory-page-chat-link');
      link.href = href;
      link.textContent = page.source.kind === 'meeting' ? '查看原会议纪要' : '查看来源消息';
    }
    currentAction = null;
    if (dreamPanel) dreamPanel.hidden = true;
    dreamSuggestion = null;
    resetDream();
    showPageMode(graphId);
    if (actionEditor) actionEditor.hidden = true;
    editor.hidden = false;
    applyPageToEditor(page);
    showPageDraft({restore: true});
    syncExportButton();
    syncPageUrl(revision, push, returnPage);
    const back = document.getElementById('close-editor');
    if (back) back.textContent = directoryAddress()?.returnPage ? '‹ 返回上一页' : '‹ 返回列表';
    syncDirectorySelection();
    focusDetailBack('close-editor');
  }

  function syncPageUrl(revision, push = false, returnPage) {
    const id = workspaceId();
    if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{32}$/.test(currentPage?.id || '')) return;
    const params = new URLSearchParams({workspace:id, page:currentPage.id});
    if (revision) params.set('revision', String(revision));
    const citation = citationFor(currentPage.id);
    syncCitationUrl(params, citation, {push, returnPage, result: !citation && (push || directoryAddress()?.result === true)});
  }

  citationEdit?.addEventListener('click', async () => {
    const citation = activeCitation;
    if (!citation || citationEdit.disabled) return;
    citationEdit.disabled = true;
    setCitationStatus('正在打开当前版本…');
    try {
      await openPage(citation.page);
      if (activeCitation === citation && currentPage?.id === citation.page && !editor.hidden) {
        editor.elements.title.focus?.();
      }
    } finally {
      citationEdit.disabled = false;
    }
  });
  citationRetry?.addEventListener('click', () => {
    if (activeCitation) return openPage(activeCitation.page, citationRevision);
  });

  function rememberPage(page, {created = false} = {}) {
    pageChoices = [page, ...pageChoices.filter(item => item.id !== page.id)]
      .sort((a, b) => Number(b.updated || 0) - Number(a.updated || 0) || String(a.id).localeCompare(String(b.id)));
    if (browseDirectory) {
      browseDirectory.items = pageChoices;
      if (created && browseDirectory.total != null) browseDirectory.total += 1;
      if (browseDirectory.controller && browseDirectory.total == null) {
        browseDirectory.controller.abort();
        browseDirectory.controller = null;
        void loadDirectoryPage(browseDirectory);
      }
    }
    if (activeDirectory === browseDirectory) renderDirectory();
    else searchDirectory({force: true});
    renderRecent(pageChoices.slice(0, 20));
  }

  const historyPanel = document.getElementById('page-history');
  const historyOpen = document.getElementById('page-history-open');
  const historyTitle = document.getElementById('page-history-title');
  const historyBrowse = document.getElementById('page-history-browse');
  const historyList = document.getElementById('page-history-list');
  const historyMore = document.getElementById('page-history-more');
  const historyRetry = document.getElementById('page-history-retry');
  const historyEmpty = document.getElementById('page-history-empty');
  const historyListStatus = document.getElementById('page-history-list-status');
  const historyPreview = document.getElementById('page-history-preview');
  const historyPreviewTitle = document.getElementById('page-history-preview-title');
  const historyPreviewBody = document.getElementById('page-history-preview-body');
  const historyPreviewBack = document.getElementById('page-history-preview-back');
  const historyPreviewRetry = document.getElementById('page-history-preview-retry');
  const historyRestore = document.getElementById('page-history-restore');
  const historyRestoreNote = document.getElementById('page-history-restore-note');
  const historyStatus = document.getElementById('page-history-status');
  let historyCursor = null;
  let historyTarget = 0;
  let historySelection = 0;
  let historyTokens = 0;
  let historyPreviewToken = 0;
  let historyLoading = false;
  let historyRestoring = null;

  function closePageHistory({restoreFocus = true} = {}) {
    if (!historyPanel || historyPanel.hidden) return;
    historyPanel.hidden = true;
    historyOpen?.setAttribute('aria-expanded','false');
    historyTokens += 1;
    historyPreviewToken += 1;
    historyLoading = false;
    historySelection = 0;
    if (restoreFocus) {
      syncPageUrl();
      historyOpen?.focus();
    }
  }

  function applyPageToEditor(page) {
    if (linkSearch && currentPage?.id !== page.id) linkSearch.value = '';
    if (page.pinned === undefined && currentPage?.id === page.id && typeof currentPage.pinned === 'boolean') {
      page = {...page,pinned:currentPage.pinned};
    }
    currentPage = page;
    syncPagePin();
    syncPageSaveButton();
    fillEditorFields({title: page.title, body: page.body || '', topics: formatTopics(page.topics)});
    document.getElementById('editor-meta').textContent =
      `修订 ${page.revision} · 作者 ${page.created_by} · 最近更新 ${page.updated_by}`;
    updatePageSaveHint(page);
    renderPageLinks();
  }

  const pinScope = () => JSON.stringify([currentUser?.id, workspaceId(), currentPage?.id]);

  function syncPagePin() {
    if (!pagePin) return;
    pagePin.hidden = !nativePins || !currentPage?.id;
    pagePin.disabled = pinWrites.has(pinScope());
    pagePin.setAttribute('aria-pressed', String(currentPage?.pinned === true));
    pagePin.textContent = currentPage?.pinned ? '取消置顶' : '置顶';
  }

  pagePin?.addEventListener('click', async () => {
    if (!nativePins || !currentUser || !currentPage || editor.hidden) return;
    const owner = currentUser, workspace = workspaceId(), id = currentPage.id;
    const scope = pinScope();
    if (!MEMORY_ID.test(workspace) || !MEMORY_ID.test(id) || pinWrites.has(scope)) return;
    const pinned = currentPage.pinned !== true;
    const path = `/v1/workspaces/${workspace}/memory/${id}`;
    const activeWorkspace = () => owner === currentUser && workspaceId() === workspace;
    pinWrites.add(scope);
    syncPagePin();
    let result = await request('POST', path + '/pin', {pinned}, undefined, AbortSignal.timeout(8000))
      .catch(() => ({status:0,body:{}}));
    let confirmed = result.status === 200 && result.body?.page_id === id && result.body.workspace_id === workspace && result.body.pinned === pinned;
    if (!confirmed && activeWorkspace() && (!result.status || result.status >= 500 || result.status === 200)) {
      result = await request('GET', path, undefined, undefined, AbortSignal.timeout(6000)).catch(() => ({status:0,body:{}}));
      const found = result.body?.page;
      confirmed = result.status === 200 && found?.id === id && found.workspace_id === workspace && found.pinned === pinned;
    }
    pinWrites.delete(scope);
    if (!activeWorkspace()) return;
    if (currentPage?.id === id) {
      if (confirmed) currentPage.pinned = pinned;
      syncPagePin();
      show(confirmed ? 'ok' : 'error', confirmed ? (pinned ? '已置顶。' : '已取消置顶。') : '未能确认置顶状态，请重试。');
    }
    if (!confirmed || !browseDirectory) return;
    const wasBrowsing = activeDirectory === browseDirectory;
    cancelDirectorySearch();
    browseDirectory.controller?.abort();
    browseDirectory = directoryWindow();
    if (wasBrowsing) activeDirectory = browseDirectory;
    else searchDirectory({force:true});
    await loadDirectoryPage(browseDirectory);
  });

  async function loadPageHistory({append = false} = {}) {
    const wid = workspaceId(), id = currentPage?.id, owner = currentUser?.id;
    if (!wid || !id || !historyList || (append && (!historyCursor || historyLoading))) return;
    const cursor = append ? historyCursor : null;
    const paging = append && document.activeElement === historyMore;
    const token = ++historyTokens;
    historyLoading = true;
    historyList.setAttribute('aria-busy','true');
    historyMore.disabled = true;
    historyRetry.hidden = true;
    historyListStatus.textContent = '正在读取版本…';
    if (!append) {
      historyCursor = null;
      historyList.replaceChildren();
      historyMore.hidden = true;
      historyEmpty.hidden = true;
    }
    const result = await request('GET', `/v1/workspaces/${wid}/memory/${id}/versions${cursor ? '?cursor=' + cursor : ''}`)
      .catch(() => ({status:0,body:{}}));
    if (token !== historyTokens || workspaceId() !== wid || currentPage?.id !== id || currentUser?.id !== owner) return;
    historyLoading = false;
    historyList.setAttribute('aria-busy','false');
    historyMore.disabled = false;
    if (result.status !== 200 || !Array.isArray(result.body.items)) {
      historyRetry.hidden = append;
      historyListStatus.textContent = append ? '更早的版本没有读取成功，请重试。' : '历史没有读取成功，请重试。';
      return;
    }
    const boundary = cursor ?? result.body.current;
    const items = result.body.items.filter(item => Number.isSafeInteger(item?.revision) &&
      item.revision > 0 && item.revision < boundary && typeof item.summary === 'string');
    const next = result.body.cursor;
    historyCursor = Number.isSafeInteger(next) && next > 0 && next < boundary && next === items.at(-1)?.revision ? next : null;
    const firstNew = historyList.children.length;
    for (const item of items) {
      const row = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'page-history-item';
      open.dataset.revision = String(item.revision);
      const title = document.createElement('strong');
      const when = memoryUpdatedLabel(item.created);
      title.textContent = `修订 ${item.revision}${when ? ' · ' + when : ''}`;
      const summary = document.createElement('span');
      summary.textContent = item.summary;
      open.append(title,summary);
      open.addEventListener('click', () => previewPageVersion(item.revision));
      row.appendChild(open);
      historyList.appendChild(row);
    }
    const focusNew = paging && (document.activeElement === historyMore || document.activeElement === document.body);
    historyMore.hidden = !historyCursor;
    historyEmpty.hidden = historyList.children.length > 0;
    historyListStatus.textContent = '';
    if (focusNew) {
      (historyList.children[firstNew]?.firstElementChild || historyList.lastElementChild?.firstElementChild || historyTitle).focus();
    }
  }

  function showHistoryList({focus = true} = {}) {
    historyPreviewToken += 1;
    historySelection = 0;
    historyPreview.hidden = true;
    historyBrowse.hidden = false;
    if (focus) {
      syncPageUrl();
      (historyList.querySelector(`button[data-revision="${historyTarget}"]`) || historyTitle).focus();
    }
  }

  async function openPageHistory({focus = true} = {}) {
    if (!currentPage || !historyPanel) return;
    historyPanel.hidden = false;
    historyOpen.setAttribute('aria-expanded','true');
    historyTarget = 0;
    showHistoryList({focus});
    await loadPageHistory();
  }

  async function previewPageVersion(revision) {
    const wid = workspaceId();
    if (!wid || !currentPage) return;
    const id = currentPage.id, owner = currentUser?.id;
    const token = ++historyPreviewToken;
    historyTarget = revision;
    historySelection = 0;
    historyBrowse.hidden = true;
    historyPreview.hidden = false;
    historyPreviewTitle.textContent = `修订 ${revision}`;
    historyPreviewBody.textContent = '';
    historyRestore.hidden = historyRestoreNote.hidden = historyPreviewRetry.hidden = true;
    historyStatus.textContent = '正在读取此版本…';
    historyPreviewTitle.focus();
    const result = await request('GET', `/v1/workspaces/${wid}/memory/${id}/versions/${revision}`)
      .catch(() => ({status:0,body:{}}));
    if (workspaceId() !== wid || currentPage?.id !== id || currentUser?.id !== owner || token !== historyPreviewToken) return;
    const version = result.body.version;
    if (result.status !== 200 || version?.revision !== revision || typeof version.body !== 'string' || typeof version.title !== 'string') {
      historyPreviewRetry.hidden = result.status === 404;
      historyStatus.textContent = result.status === 404 ? '此版本已不在保留范围内。' : '此版本没有读取成功，请重试。';
      return;
    }
    historySelection = version.revision;
    historyPreviewTitle.textContent = `修订 ${version.revision} · ${version.title}`;
    historyPreviewBody.textContent = version.body || '（空白正文）';
    historyRestore.hidden = historyRestoreNote.hidden = false;
    historyRestore.disabled = historyRestoring?.id === id;
    syncPageUrl(revision);
    historyStatus.textContent = '';
  }

  async function restorePageVersion() {
    const wid = workspaceId();
    const owner = currentUser;
    const editing = currentPage;
    if (!wid || !editing || !historySelection || historyRestoring?.id === editing.id) return;
    const revision = historySelection;
    if (!pageMatchesDraft(editing, editorFields())) {
      historyStatus.textContent = '请先保存或清除当前草稿，再恢复历史版本。';
      return;
    }
    const pending = historyRestoring = {id:editing.id};
    historyRestore.disabled = true;
    historyStatus.textContent = '正在恢复版本…';
    const result = await request(
      'POST', `/v1/workspaces/${wid}/memory/${editing.id}/versions/${revision}/restore`,
      {revision: editing.revision}).catch(() => ({status:0, body:{}}));
    if (historyRestoring === pending) historyRestoring = null;
    if (workspaceId() !== wid || currentUser !== owner) return;
    if (currentPage !== editing) {
      if (result.status === 200 && result.body.page) {
        rememberPage(result.body.page);
        void loadGraph();
      }
      return;
    }
    if (result.status !== 200 || !result.body.page) {
      historyRestore.disabled = false;
      if (!historyPreview.hidden) historyStatus.textContent = result.status === 409
        ? '这一页已在别处更新，重新打开后再恢复。'
        : '没有恢复成功，请重试。';
      return;
    }
    persistPageDraft();
    applyPageToEditor(result.body.page);
    showPageDraft();
    rememberPage(result.body.page);
    syncPageUrl();
    if (!historyPanel.hidden) {
      historyTarget = 0;
      showHistoryList();
      await Promise.all([loadPageHistory(),loadGraph()]);
    } else await loadGraph();
    if (currentPage === result.body.page && currentUser === owner && workspaceId() === wid) {
      show('ok', `已恢复修订 ${revision}，保存为修订 ${currentPage.revision}。`);
    }
  }

  if (historyOpen) historyOpen.addEventListener('click', openPageHistory);
  const historyClose = document.getElementById('page-history-close');
  if (historyClose) historyClose.addEventListener('click', () => closePageHistory());
  if (historyRestore) historyRestore.addEventListener('click', restorePageVersion);
  historyMore?.addEventListener('click', () => loadPageHistory({append:true}));
  historyRetry?.addEventListener('click', () => loadPageHistory());
  historyPreviewBack?.addEventListener('click', () => showHistoryList());
  historyPreviewRetry?.addEventListener('click', () => previewPageVersion(historyTarget));

  function savedActionFollowups() {
    const workspace = workspaceId();
    if (!personalWorkspaces.has(workspace) || currentAction?.workspace_id !== workspace ||
        !Array.isArray(currentAction?.automation_followups)) return [];
    return currentAction.automation_followups.filter(item => /^[0-9a-f]{32}$/.test(item?.id || '') &&
      Number.isSafeInteger(item.revision) && item.revision > 0 && typeof item.title === 'string');
  }

  function renderActionFollowups() {
    if (!actionFollowupHistory || !actionFollowupList) return;
    const rows = savedActionFollowups();
    actionFollowupList.replaceChildren(...rows.map(row => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = '/automations?' + new URLSearchParams({workspace: workspaceId(), automation: row.id});
      link.target = '_blank';
      link.rel = 'noopener';
      const title = document.createElement('strong');
      title.textContent = row.title;
      const meta = document.createElement('small');
      meta.className = 'note';
      meta.textContent = `行动项修订 ${row.revision} · ${row.enabled ? '已启用' : '已暂停'}`;
      link.append(title, meta);
      item.append(link);
      return item;
    }));
    actionFollowupHistory.hidden = !rows.length;
  }

  async function refreshActionFollowups() {
    const action = currentAction;
    const workspace = workspaceId();
    if (!action || actionEditor.hidden || action.workspace_id !== workspace ||
        !personalWorkspaces.has(workspace)) return;
    const owner = currentUser;
    const token = ++actionFollowupRequest;
    try {
      const response = await request('GET', `/v1/workspaces/${workspace}/memory/actions/${action.id}`);
      if (token !== actionFollowupRequest || owner !== currentUser || workspace !== workspaceId() || currentAction !== action) return;
      const fresh = response.body?.action;
      if (response.status !== 200 || fresh?.id !== action.id || fresh.workspace_id !== workspace ||
          !Array.isArray(fresh.automation_followups) ||
          JSON.stringify(fresh.automation_followups) === JSON.stringify(action.automation_followups)) return;
      action.automation_followups = fresh.automation_followups;
      renderActionFollowups();
      syncActionFollowup();
    } catch { /* Reopening the action also refreshes the list. */ }
  }

  document.defaultView?.addEventListener?.('focus', refreshActionFollowups);
  const actionFollowupEvents = actionFollowupChannel(document.defaultView);
  actionFollowupEvents?.addEventListener('message', ({data}) => {
    if (data?.workspace === workspaceId() && data?.action === currentAction?.id) void refreshActionFollowups();
  });

  function syncActionFollowup() {
    const workspace = workspaceId();
    const linked = savedActionFollowups();
    const hasCurrentFollowup = linked.some(item => item.revision === currentAction?.revision);
    const href = !hasCurrentFollowup && personalWorkspaces.has(workspace) && actionFollowupHref(workspace, currentAction);
    actionFollowup.hidden = !href;
    actionFollowup.textContent = linked.length ? '跟进当前修订' : '跟进自动化';
    const note = document.getElementById('action-follow-up-status');
    if (!href) {
      actionFollowup.removeAttribute('href');
      actionFollowup.removeAttribute('aria-disabled');
      note.textContent = '';
      return;
    }
    const fields = actionEditor.elements;
    const dirty = actionEditConflict || actionEditsSaving.has(actionEditKey()) ||
      fields.title.value.trim() !== currentAction.title || fields.notes.value !== (currentAction.notes || '') ||
      fields.status.value !== currentAction.status || fields.due.value !== dueDateValue(currentAction.due_at) ||
      (fields.memory_page_id.value || null) !== (currentAction.memory_page_id || null);
    if (dirty) {
      actionFollowup.removeAttribute('href');
      actionFollowup.setAttribute('aria-disabled', 'true');
      note.textContent = '保存修改后可准备跟进。';
    } else {
      actionFollowup.href = href;
      actionFollowup.removeAttribute('aria-disabled');
      note.textContent = '';
    }
  }

  const actionSave = document.getElementById('save-action');
  const actionEditHint = document.getElementById('action-edit-hint');
  const actionConflictPanel = document.getElementById('action-edit-conflict');
  const actionConflictPreview = document.getElementById('action-edit-conflict-preview');
  const actionEditsSaving = new Set();
  let actionEditConflict = null;

  function actionEditKey(action = currentAction, user = currentUser) {
    if (![user?.id, action?.workspace_id, action?.id].every(value => MEMORY_ID.test(value || ''))) return '';
    return 'flybot-workspace.memory-action-edit:' + JSON.stringify([user.id, action.workspace_id, action.id]);
  }

  function readActionEdit(key) {
    try { return decodeActionEdit(key && document.defaultView.sessionStorage.getItem(key)); }
    catch { return null; }
  }

  function writeActionEdit(key, {base, fields, pending}) {
    if (!key) return;
    try {
      const storage = document.defaultView.sessionStorage;
      if (pending || ACTION_EDIT_FIELDS.some(name => fields[name] !== base[name])) {
        storage.setItem(key, JSON.stringify({base, fields, pending}));
      } else storage.removeItem(key);
    } catch {}
  }

  function actionFields(action) {
    if (!action) return Object.fromEntries(ACTION_EDIT_FIELDS.map(name => [name, actionEditor.elements[name].value]));
    return {title:action.title, notes:action.notes || '', status:action.status, due:dueDateValue(action.due_at),
      memory_page_id:action.memory_page_id || ''};
  }

  function showActionEdit() {
    const draft = actionFields();
    const saved = actionFields(currentAction);
    const dirty = ACTION_EDIT_FIELDS.some(name => draft[name] !== saved[name]);
    const pending = actionEditsSaving.has(actionEditKey());
    actionSave.disabled = Boolean(actionEditConflict || pending);
    for (const name of ACTION_EDIT_FIELDS) actionEditor.elements[name].disabled = Boolean(actionEditConflict);
    actionConflictPanel.hidden = !actionEditConflict;
    actionEditHint.textContent = pending ? '正在确认保存…' : dirty && !actionEditConflict ? '有未保存的行动草稿。' : '';
    syncActionFollowup();
  }

  function storeActionEdit() {
    if (!currentAction || actionEditor.hidden || actionEditConflict) return;
    const key = actionEditKey();
    writeActionEdit(key, {base:actionFields(currentAction), fields:actionFields(), pending:readActionEdit(key)?.pending});
    showActionEdit();
  }

  function fillActionEdit(fields) {
    for (const name of ACTION_EDIT_FIELDS) {
      if (name === 'memory_page_id') fillPageSelect(actionEditor.elements[name], fields[name]);
      else actionEditor.elements[name].value = fields[name];
    }
  }

  function restoreActionEdit(draft) {
    const saved = actionFields(currentAction);
    const active = draft && advanceActionEdit(draft, saved, currentAction.revision);
    const result = active && reconcileActionEdit(active.base, active.fields, saved);
    actionEditConflict = result?.conflicts.length ? {...result, local:active.fields} : null;
    actionConflictPreview.textContent = '';
    if (actionEditConflict) {
      const names = {title:'标题', notes:'备注', status:'状态', due:'截止日期', memory_page_id:'关联记忆页'};
      const display = (field, value) => !value ? '空' : field === 'status' ? (value === 'done' ? '已完成' : '未完成')
        : field === 'memory_page_id' ? (pageChoices.find(page => page.id === value)?.title || value) : value;
      actionConflictPreview.textContent = result.conflicts.map(name =>
        `${names[name]}\n我的草稿：${display(name,active.fields[name])}\n已保存：${display(name,saved[name])}`).join('\n\n');
    }
    fillActionEdit(result?.fields || saved);
    if (!actionEditConflict) {
      writeActionEdit(actionEditKey(), {base:saved, fields:actionFields(), pending:active?.pending});
    } else writeActionEdit(actionEditKey(), active);
    showActionEdit();
  }

  function resolveActionEdit(keepLocal) {
    if (!actionEditConflict) return;
    const {fields, conflicts, local} = actionEditConflict;
    if (keepLocal) for (const name of conflicts) fields[name] = local[name];
    actionEditConflict = null;
    actionConflictPreview.textContent = '';
    fillActionEdit(fields);
    storeActionEdit();
    actionEditor.elements.title.focus();
  }

  document.getElementById('action-edit-keep')?.addEventListener('click', () => resolveActionEdit(true));
  document.getElementById('action-edit-use-saved')?.addEventListener('click', () => resolveActionEdit(false));

  async function resolveActionMeetingSource(action, meeting, status) {
    const workspace = workspaceId();
    const user = currentUser;
    status.textContent = '正在核对来源行动项…';
    const result = await request('GET', `/v1/workspaces/${workspace}/memory/actions/${action.id}/meeting-source`)
      .catch(() => ({status:0}));
    if (currentUser !== user || workspaceId() !== workspace || currentAction !== action || actionEditor.hidden) return;
    if ([403, 404].includes(result.status)) {
      status.textContent = '原会议已删除或无法访问。';
      return;
    }
    const original = action.source;
    const source = result.body?.source;
    const link = new URLSearchParams({workspace:original.workspace_id, meeting:original.meeting_id});
    const resolved = result.status === 200 && source?.workspace_id === original.workspace_id &&
      source.meeting_id === original.meeting_id && Number.isSafeInteger(source.revision) &&
      source.revision >= original.revision;
    const hasAction = resolved && Number.isInteger(source.action_index) && source.action_index >= 0 && source.action_index < 50;
    if (hasAction) {
      link.set('action', source.action_index);
      link.set('revision', source.revision);
    }
    meeting.href = '/meetings#' + link;
    meeting.textContent = hasAction ? '查看来源行动项' : '查看原会议';
    meeting.hidden = false;
    status.textContent = hasAction ? '' : resolved
      ? '来源行动项已变更，可在最新纪要中核对。' : '暂时无法定位行动项，可直接打开会议。';
  }

  function renderActionDetail() {
    document.getElementById('action-editor-meta').textContent =
      `修订 ${currentAction.revision} · 作者 ${currentAction.created_by} · 最近更新 ${currentAction.updated_by}`;
    const source = currentAction.source;
    const meeting = document.getElementById('action-source-meeting');
    const meetingStatus = document.getElementById('action-source-meeting-status');
    const ownedMeeting = source?.kind === 'meeting' && /^[0-9a-f]{32}$/.test(source.workspace_id || '') &&
      /^[0-9a-f]{32}$/.test(source.meeting_id || '') && Number.isSafeInteger(source.revision) && source.revision > 0 &&
      Number.isInteger(source.action_index) && source.action_index >= 0 && source.action_index < 50;
    meeting.hidden = source?.kind !== 'shared_meeting';
    meeting.removeAttribute('href');
    meetingStatus.textContent = '';
    if (ownedMeeting) {
      void resolveActionMeetingSource(currentAction, meeting, meetingStatus);
    } else if (!meeting.hidden) {
      meeting.href = '/meetings#' + new URLSearchParams({workspace:source.workspace_id, shared:source.share_id});
      meeting.textContent = `查看来源纪要 · 版本 ${source.revision}`;
    }
    const chat = document.getElementById('action-source-chat');
    const chatLink = actionChatHref(currentAction.source_chat);
    chat.hidden = !chatLink;
    if (chatLink) chat.href = chatLink;
    else chat.removeAttribute('href');
    document.getElementById('action-editor-source').hidden = !ownedMeeting && meeting.hidden && chat.hidden;
    renderActionFollowups();
    syncActionFollowup();
  }

  async function openAction(actionId) {
    closeDeleteConfirm({restoreFocus: false});
    const id = workspaceId();
    if (!id) return;
    const citation = citationFor('todos', actionId);
    if (citation !== activeCitation) setCitation(citation);
    hideCitationPreview();
    const seq = workspaceRequest;
    const token = ++pageRequest;
    const seen = await request('GET', `/v1/workspaces/${id}/memory/actions/${actionId}`).catch(() => ({status: 0, body: {}}));
    if (seq !== workspaceRequest || token !== pageRequest) return;
    if (seen.status !== 200 || !seen.body.action) {
      if (citation) setCitationStatus([403, 404, 410].includes(seen.status)
        ? '引用的行动已删除或无法访问。' : '暂时无法读取引用的行动，请刷新后重试。');
      else show('error', messageFor(seen.body.error, '无法打开下一步行动。'));
      return;
    }
    persistPageDraft();
    currentAction = seen.body.action;
    currentPage = null;
    syncExportButton();
    showPageMode();
    editor.hidden = true;
    actionEditor.hidden = false;
    currentView = 'actions';
    restoreActionEdit(readActionEdit(actionEditKey()));
    renderActionDetail();
    if ([id, actionId].every(value => MEMORY_ID.test(value))) {
      syncCitationUrl(new URLSearchParams({workspace: id, page: 'todos', action: actionId}), citation);
    }
    syncDirectorySelection();
    focusDetailBack('close-action-editor');
  }

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '登录失败。'));
      return;
    }
    show('ok', '已登录。');
    await loadSession();
  });

  document.getElementById('logout-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = await request('POST', '/v1/auth/logout', {});
    if (result.status !== 200) {
      show('error', messageFor(result.body.error, '无法退出登录。'));
      return;
    }
    currentUser = null;
    candidates.show(false);
    currentPage = null;
    currentAction = null;
    closeProfilePreview();
    syncExportButton();
    show('ok', '已退出登录。');
    await loadSession();
  });

  if (profileForm) profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    const save = document.getElementById('save-memory-profile');
    if (profileRevision === null || save?.disabled) return;
    const wid = workspaceId();
    const token = profileRequest;
    const isCurrent = () => wid === workspaceId() && token === profileRequest;
    const payload = profileDraft();
    const status = profileStatus;
    if (save) save.disabled = true;
    closeProfilePreview();
    status.textContent = '正在保存…';
    try {
      const result = await request('POST', `/v1/workspaces/${wid}/memory/profile`, payload);
      if (!isCurrent()) return;
      if (result.status !== 200 || !result.body.profile) {
        status.textContent = result.status === 409 ? '画像已在别处更新，请重新打开后重试。' : '画像未保存，请重试。';
        return;
      }
      profileRevision = result.body.profile.revision;
      status.textContent = '画像已保存。';
    } catch {
      if (isCurrent()) status.textContent = '画像未保存，请重试。';
    } finally {
      if (isCurrent()) {
        if (save) save.disabled = false;
        if (profileDream) profileDream.disabled = false;
      }
    }
  });
  // 「偏好」 lives in the 我的资料 view. Rows come from and go back to the
  // workspace store per user, so a reload or a new conversation reads the same
  // list instead of starting from page state.
  const preferences = [];
  let preferenceRequest = 0;

  function preferenceStatus() {
    return document.getElementById('preference-status');
  }

  function renderPreferences() {
    const list = document.getElementById('preference-list');
    const empty = document.getElementById('preferences-empty');
    if (!list) return;
    list.replaceChildren();
    for (const item of preferences) {
      const row = document.createElement('li');
      row.className = 'preference-row';
      const text = document.createElement('span');
      text.className = 'preference-text';
      text.textContent = item.text;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'preference-remove';
      remove.textContent = '删除';
      remove.dataset.id = item.id;
      remove.addEventListener('click', async () => {
        const wid = workspaceId();
        if (!wid) return;
        const status = preferenceStatus();
        const result = await request(
          'POST', `/v1/workspaces/${wid}/memory/preferences/${encodeURIComponent(item.id)}/remove`, {});
        if (workspaceId() !== wid) return;
        if (result.status === 404) {
          await loadPreferences();
          if (status) status.textContent = '这条偏好已经不在列表里。';
          return;
        }
        if (result.status !== 200) {
          if (status) status.textContent = '偏好没有删除成功。';
          return;
        }
        const index = preferences.findIndex(entry => entry.id === item.id);
        if (index >= 0) preferences.splice(index, 1);
        renderPreferences();
        if (status) status.textContent = '已删除偏好。';
      });
      row.appendChild(text);
      row.appendChild(remove);
      list.appendChild(row);
    }
    if (empty) {
      empty.textContent = PREFERENCES_EMPTY;
      empty.hidden = preferences.length > 0;
    }
  }

  async function loadPreferences() {
    const wid = workspaceId();
    const token = ++preferenceRequest;
    const list = document.getElementById('preference-list');
    if (!wid || !list) return;
    // A workspace switch must not leave the other workspace's rows visible
    // while this one is still loading.
    preferences.length = 0;
    renderPreferences();
    const result = await request('GET', `/v1/workspaces/${wid}/memory/preferences`);
    if (token !== preferenceRequest || workspaceId() !== wid) return;
    if (result.status !== 200) {
      const status = preferenceStatus();
      if (status) status.textContent = '偏好没有读取成功。';
      return;
    }
    preferences.length = 0;
    preferences.push(...(result.body.items || []));
    renderPreferences();
  }

  const addPreference = document.getElementById('add-preference');
  if (addPreference) {
    addPreference.addEventListener('click', async () => {
      const wid = workspaceId();
      const input = document.getElementById('preference-input');
      const status = preferenceStatus();
      const text = String((input && input.value) || '').trim();
      if (!wid) return;
      if (!text) {
        status.textContent = '请先写一条偏好。';
        return;
      }
      const result = await request(
        'POST', `/v1/workspaces/${wid}/memory/preferences`, {text}, {'Idempotency-Key': randomKey()});
      if (workspaceId() !== wid) return;
      if (result.status !== 200 && result.status !== 201) {
        status.textContent = result.status === 429
          ? '这个工作区的偏好数量已到上限，先删掉几条再加。'
          : '偏好没有保存成功。';
        return;
      }
      const saved = result.body.preference;
      const known = preferences.some(entry => entry.id === saved.id);
      if (!known) preferences.push(saved);
      input.value = '';
      renderPreferences();
      status.textContent = (result.status === 200 && known) ? '这条偏好已经在列表里。' : '已添加偏好。';
    });
  }
  renderPreferences();

  function invalidateMemoryProfile() {
    // A workspace switch must not leave the previous workspace's revision or
    // an enabled Save button while the new workspace profile is still loading.
    profileRevision = null;
    profileRequest += 1;
    const save = document.getElementById('save-memory-profile'); if (save) save.disabled = true;
  }
  workspaceSelect.addEventListener('change', async () => {
    invalidateMemoryProfile();
    const historyFocus = {restoreFocus: false};
    closePageHistory(historyFocus);
    const input = document.getElementById('preference-input');
    if (input) input.value = '';
    await loadWorkspace();
  });
  function clearDirectorySearch() {
    searchInput.value = '';
    searchDirectory();
    searchInput.focus();
  }

  searchInput.addEventListener('input', event => {
    if (!event?.isComposing) searchDirectory({delay: 220});
  });
  searchInput.addEventListener('compositionend', () => searchDirectory({delay: 220}));
  searchInput.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault();
      clearDirectorySearch();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      searchDirectory({force: Boolean(directoryTimer || activeDirectory?.error)});
    }
  });
  clearSearch?.addEventListener('click', clearDirectorySearch);
  resetFilters?.addEventListener('click', () => {
    topicFilter = '';
    setDirectoryFilter('all');
    renderTopicFilters();
    clearDirectorySearch();
  });
  directoryMore?.addEventListener('click', () => {
    const state = activeDirectory;
    if (state?.cursor) return loadDirectoryPage(state, state.cursor, document.activeElement === directoryMore);
  });
  directoryRetry?.addEventListener('click', () => {
    const state = activeDirectory;
    if (state?.error) return loadDirectoryPage(state, state.cursor, document.activeElement === directoryRetry);
  });
  actionFilter.addEventListener('change', () => loadActions());
  actionSearch.addEventListener('input', event => {
    if (!event?.isComposing) void loadActions({delay:180});
  });
  actionSearch.addEventListener('compositionend', () => loadActions({delay:180}));
  document.getElementById('action-list-filters').addEventListener('submit', event => {
    event.preventDefault();
    return loadActions();
  });
  actionMore.addEventListener('click', () => {
    if (actionListing?.cursor && !actionListing.busy) return readActionPage(actionListing, actionListing.cursor,
      document.activeElement === actionMore);
  });
  actionRetry.addEventListener('click', () => {
    if (actionListing?.error) return readActionPage(actionListing, actionListing.retryCursor,
      document.activeElement === actionRetry);
  });

  for (const button of document.querySelectorAll('.memory-views [data-view]')) {
    button.addEventListener('click', (event) => {
      if (button.tagName === 'A') event.preventDefault();
      setMobileGraph(false);
      showView(button.getAttribute('data-view'));
    });
  }
  const memoryWindow = document.defaultView;
  let directoryBackPending = false;
  if (memoryWindow && memoryWindow.addEventListener) {
    memoryWindow.addEventListener('popstate', () => {
      directoryBackPending = false;
      const search = memoryWindow.location.search;
      const view = memoryPageFromSearch(search);
      const params = new URLSearchParams(search);
      const workspace = params.get('workspace');
      if (memoryCitationFromSearch(search) || (MEMORY_ID.test(workspace || '') && workspace !== workspaceId())) {
        currentView = view;
        void loadSession();
        return;
      }
      const saved = directoryAddress();
      if (view !== 'overview' || !saved || workspace !== workspaceId()) {
        showView(view, {sync: false});
        return;
      }
      currentView = view;
      restoreDirectoryAddress();
      renderTopicFilters();
      searchDirectory();
      const page = params.get('page');
      if ((saved.result || saved.reopenPage) && MEMORY_ID.test(page || '')) void openPage(page, memoryRevisionFromSearch(params));
      else returnToList({sync: false});
    });
  }
  function setDirectoryFilter(filter) {
    listFilter = filter;
    const box = document.getElementById('topic-filter-box');
    if (box) box.hidden = listFilter !== 'topics';
    for (const item of document.querySelectorAll('.memory-filters [data-filter]')) {
      item.setAttribute('aria-pressed', String(item.getAttribute('data-filter') === listFilter));
    }
  }
  for (const button of document.querySelectorAll('.memory-filters [data-filter]')) {
    button.addEventListener('click', () => {
      setDirectoryFilter(button.getAttribute('data-filter') || 'all');
      searchDirectory();
    });
  }
  for (const button of document.querySelectorAll('.side-tabs [data-side]')) {
    button.addEventListener('click', () => {
      sideTab = button.getAttribute('data-side') || 'topics';
      for (const item of document.querySelectorAll('.side-tabs [data-side]')) {
        item.setAttribute('aria-selected', item.getAttribute('data-side') === sideTab ? 'true' : 'false');
      }
      const topics = document.getElementById('topic-list');
      const topicEmpty = document.getElementById('topic-empty');
      const recent = document.getElementById('recent-list');
      const recentEmpty = document.getElementById('recent-empty');
      if (topics) topics.hidden = sideTab !== 'topics';
      if (topicEmpty) topicEmpty.hidden = sideTab !== 'topics' || !!(currentGraph.topics && currentGraph.topics.length);
      if (recent) recent.hidden = sideTab !== 'recent';
      if (recentEmpty) recentEmpty.hidden = sideTab !== 'recent' || pageChoices.length > 0;
    });
  }
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
  const topicSearch = document.getElementById('topic-search');
  if (topicSearch) {
    topicSearch.addEventListener('input', () => {
      topicQuery = topicSearch.value;
      renderGraph(currentGraph);
    });
  }
  const zoomIn = document.getElementById('graph-zoom-in');
  const zoomOut = document.getElementById('graph-zoom-out');
  const zoomReset = document.getElementById('graph-zoom-reset');
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && pendingDelete) {
      closeDeleteConfirm();
      return;
    }
    if (event.key === 'Escape') hideGraphHoverCard(document.getElementById('graph-hover-card'));
  });
  if (zoomIn) zoomIn.addEventListener('click', () => { graphZoom = Math.min(2.4, graphZoom + 0.2); renderGraph(currentGraph); });
  if (zoomOut) zoomOut.addEventListener('click', () => { graphZoom = Math.max(0.6, graphZoom - 0.2); renderGraph(currentGraph); });
  if (zoomReset) zoomReset.addEventListener('click', () => { graphZoom = 1; renderGraph(currentGraph); });

  const initialSearch = document.defaultView && document.defaultView.location
    ? document.defaultView.location.search
    : '';
  showView(memoryPageFromSearch(initialSearch), {sync: false});

  const graphEmptyNew = document.getElementById('graph-empty-new');
  if (graphEmptyNew) {
    graphEmptyNew.addEventListener('click', () => {
      const create = document.getElementById('new-page');
      if (create) create.click();
    });
  }

  newPageButton.addEventListener('click', async () => {
    const id = workspaceId();
    if (!id || newPageButton.disabled) return;
    const seq = workspaceRequest;
    newPageButton.disabled = true;
    const title = unusedTitle('未命名页面');
    try {
      const created = await request('POST', `/v1/workspaces/${id}/memory`, {title, body: ''}, {'Idempotency-Key': randomKey()});
      if (seq !== workspaceRequest) return;
      if (![200, 201].includes(created.status) || !created.body.page) {
        show('error', messageFor(created.body.error, '无法创建记忆页。'));
        return;
      }
      rememberPage(created.body.page, {created: created.status === 201});
      showPage(created.body.page);
      editor.elements.title.focus();
      show('ok', '已创建记忆页。');
    } catch {
      if (seq === workspaceRequest) show('error', '无法连接，请重试。');
    } finally {
      if (seq === workspaceRequest) newPageButton.disabled = false;
    }
  });

  const toolbar = editor.querySelector('.editor-toolbar');
  if (toolbar) {
    toolbar.addEventListener('mousedown', (event) => {
      // Keep the text selection inside the editor when a tool is pressed.
      if (event.target.closest('[data-rich]')) event.preventDefault();
    });
    toolbar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-rich]');
      if (!button) return;
      const kind = button.getAttribute('data-rich');
      if (sourceMode || !rich) {
        if (kind !== 'undo' && kind !== 'redo') applyMarkdown(editor.elements.body, kind);
        editor.elements.body.focus();
        pageDraftChanged();
        return;
      }
      richCommand(kind);
      pageDraftChanged();
    });
  }

  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    const owner = currentUser;
    const editing = currentPage;
    const key = pageDraftKey(editing, owner);
    if (!id || !editing || !key || editor.hidden || savingPages.has(key)) return;
    const submitted = editorFields();
    persistPageDraft();
    if (pageMatchesDraft(editing, submitted)) { show('ok', '已保存。'); return; }

    const path = `/v1/workspaces/${id}/memory/${editing.id}`;
    const sameOwner = () => currentUser?.id === owner.id;
    const visiblePage = () => sameOwner() && workspaceId() === id && !editor.hidden &&
      currentPage?.id === editing.id && currentPage.revision === editing.revision;
    const exactPage = page => page?.id === editing.id && page.workspace_id === id &&
      Number.isSafeInteger(page.revision) && page.revision >= editing.revision;
    const timeout = () => globalThis.AbortSignal?.timeout?.(8000);
    savingPages.add(key);
    syncPageSaveButton();
    let saved, page, confirmed, uncertain;
    try {
      saved = await request('POST', path, {
        revision: editing.revision, changes:{...submitted, topics:parseTopics(submitted.topics)},
      }, undefined, timeout()).catch(() => ({status:0, body:{}}));
      page = saved.body?.page;
      confirmed = saved.status === 200 && exactPage(page) && pageMatchesDraft(page, submitted);
      uncertain = saved.status === 0 || saved.status === 408 || saved.status >= 500 || (saved.status === 200 && !confirmed);
      if (!confirmed && sameOwner() && (uncertain || saved.status === 409)) {
        const checked = await request('GET', path, undefined, undefined, timeout()).catch(() => ({status:0, body:{}}));
        page = checked.status === 200 && exactPage(checked.body?.page) ? checked.body.page : null;
        confirmed = Boolean(page && page.revision > editing.revision && pageMatchesDraft(page, submitted));
      }
    } finally {
      savingPages.delete(key);
      syncPageSaveButton();
    }

    if (!sameOwner()) return;
    const visible = visiblePage();
    if (confirmed && !visible) {
      const entry = pageDraft(key);
      if (entry?.revision === editing.revision) {
        if (pageMatchesDraft(page, entry)) clearPageDraft(key);
        else writePageDraft(key, entry, page.revision);
      }
      if (workspaceId() === id) {
        rememberPage(page);
        void loadGraph();
      }
      return;
    }
    if (!visible) return;
    if (!confirmed) {
      if (page && exactPage(page) && page.revision > editing.revision && (uncertain || saved.status === 409)) {
        persistPageDraft();
        applyPageToEditor(page);
        showPageDraft();
        syncPageUrl();
        closeDeleteConfirm({restoreFocus: false});
        closePageHistory({restoreFocus: false});
        rememberPage(page);
        void loadGraph();
        show('note', '此页已在别处更新，旧草稿已保留。');
      } else if (uncertain) show('note', '尚未确认保存，草稿已保留。');
      else show('error', messageFor(saved.body?.error, '无法保存记忆页。'));
      return;
    }

    closeDeleteConfirm({restoreFocus: false});
    const fields = editorFields();
    if (pageDraft(key)?.revision === editing.revision) clearPageDraft(key);
    currentPage = page;
    if (sameFields(fields, submitted)) fillEditorFields({title: page.title, body: page.body || '', topics: formatTopics(page.topics)});
    persistPageDraft();
    updatePageSaveHint(page, !pageMatchesDraft(page, editorFields()));
    if (!historySelection) syncPageUrl();
    if (citationFor(currentPage.id)) setCitationStatus('已保存为修订 ' + currentPage.revision + '。');
    rememberPage(currentPage);
    syncExportButton();
    document.getElementById('editor-meta').textContent =
      `修订 ${currentPage.revision} · 作者 ${currentPage.created_by} · 最近更新 ${currentPage.updated_by}`;

    show('ok', '已保存。');
    void loadGraph();
    if (historyPanel && !historyPanel.hidden) void loadPageHistory();
  });

  const deleteParts = {
    page: {
      trigger: document.getElementById('delete-page'),
      dialog: document.getElementById('page-delete-confirm'),
      question: document.getElementById('page-delete-question'),
      confirm: document.getElementById('page-delete-confirm-submit'),
      cancel: document.getElementById('page-delete-confirm-cancel'),
    },
    action: {
      trigger: document.getElementById('delete-action'),
      dialog: document.getElementById('action-delete-confirm'),
      question: document.getElementById('action-delete-question'),
      confirm: document.getElementById('action-delete-confirm-submit'),
      cancel: document.getElementById('action-delete-confirm-cancel'),
    },
  };

  function deleteRemovePath(kind, workspace, id) {
    return kind === 'page'
      ? `/v1/workspaces/${workspace}/memory/${id}/remove`
      : `/v1/workspaces/${workspace}/memory/actions/${id}/remove`;
  }

  function closeDeleteConfirm({restoreFocus = true} = {}) {
    const pending = pendingDelete;
    if (!pending) return;
    pendingDelete = null;
    const parts = deleteParts[pending.kind];
    if (parts.question) parts.question.textContent = '';
    if (parts.dialog) parts.dialog.hidden = true;
    if (parts.trigger) {
      parts.trigger.hidden = false;
      if (restoreFocus && parts.trigger.focus) parts.trigger.focus();
    }
  }

  function openDeleteConfirm(kind, target) {
    const workspace = workspaceId();
    if (!workspace || !target || !target.id) return;
    const parts = deleteParts[kind];
    if (!parts.dialog || !parts.question) return;
    closeDeleteConfirm({restoreFocus: false});
    // The question owns the target it names: confirming must not re-read the
    // editor's current row or the current workspace.
    pendingDelete = {kind, workspace, id: target.id};
    parts.question.textContent =
      `${kind === 'page' ? '删除这条记忆页' : '删除这条下一步行动'}「${String(target.title || '')}」？`;
    if (parts.trigger) parts.trigger.hidden = true;
    parts.dialog.hidden = false;
    if (parts.cancel && parts.cancel.focus) parts.cancel.focus();
  }

  async function removePending(kind) {
    const pending = pendingDelete;
    if (!pending || pending.kind !== kind) return;
    const owner = currentUser;
    const citation = kind === 'page' ? citationFor(pending.id) : citationFor('todos', pending.id);
    closeDeleteConfirm({restoreFocus: false});
    const removed = await request('POST', deleteRemovePath(kind, pending.workspace, pending.id), {});
    if (currentUser !== owner || workspaceId() !== pending.workspace) return;
    if (removed.status !== 200) {
      show('error', messageFor(removed.body.error,
        kind === 'page' ? '无法删除记忆页。' : '无法删除下一步行动。'));
      return;
    }
    if (kind === 'page') {
      clearTimeout(draftTimer);
      if (currentPage?.id === pending.id) editor.hidden = true;
      clearPageDraft(pageDraftKey({workspace_id: pending.workspace, id: pending.id}, owner));
    } else {
      const key = actionEditKey({workspace_id:pending.workspace, id:pending.id}, owner);
      try { if (key) document.defaultView.sessionStorage.removeItem(key); } catch {}
    }
    show('ok', '已删除。');
    const restoreCitation = citation && activeCitation === citation;
    const directory = loadWorkspace({syncView: !restoreCitation});
    if (restoreCitation) {
      setCitation(citation);
      setCitationStatus(kind === 'page' ? '这条记忆已删除。' : '引用的行动已删除。');
    }
    await directory;
  }

  document.getElementById('delete-page').addEventListener('click', () => {
    openDeleteConfirm('page', currentPage);
  });
  for (const [kind, parts] of Object.entries(deleteParts)) {
    if (parts.confirm) parts.confirm.addEventListener('click', () => removePending(kind));
    if (parts.cancel) parts.cancel.addEventListener('click', () => closeDeleteConfirm());
  }

  linkSearch?.addEventListener('input', event => { if (!event.isComposing) renderLinkChoices(); });
  linkSearch?.addEventListener('compositionend', () => renderLinkChoices());
  linkSearch?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (!linkTarget?.disabled) linkTarget?.focus();
    }
  });
  linkTarget?.addEventListener('change', () => {
    if (addLink) addLink.disabled = !linkTarget.value || linkWrites.has(linkScope());
  });
  if (addLink) {
    addLink.addEventListener('click', async () => {
      const id = workspaceId(), owner = currentUser;
      const source = currentPage?.id, target = linkTarget?.value;
      const scope = linkScope();
      if (!id || !source || !target || linkWrites.has(scope)) return;
      const attempt = JSON.stringify([scope,target]);
      const key = linkAttempts.get(attempt) || randomKey();
      linkAttempts.set(attempt, key);
      if (linkAttempts.size > 32) linkAttempts.delete(linkAttempts.keys().next().value);
      linkWrites.add(scope);
      renderLinkChoices();
      const created = await request('POST', `/v1/workspaces/${id}/memory/links`, {source,target},
        {'Idempotency-Key':key}, AbortSignal.timeout(8000)).catch(() => ({status:0,body:{}}));
      const saved = created.status === 201 || created.status === 200;
      if (saved) {
        linkAttempts.delete(attempt);
        if (workspaceId() === id && currentUser === owner) await loadGraph();
      }
      linkWrites.delete(scope);
      if (workspaceId() !== id || currentUser !== owner) return;
      if (linkScope() === scope) {
        renderLinkChoices();
        show(saved ? 'ok' : 'error', saved ? '已添加连接。' : messageFor(created.body.error, '无法添加连接，请重试。'));
      }
    });
  }

  function returnToList({sync = true} = {}) {
    persistPageDraft();
    const page = currentPage?.id;
    const action = currentAction?.id;
    const previous = directoryReturn;
    directoryReturn = null;
    currentPage = null;
    currentAction = null;
    closeDeleteConfirm({restoreFocus: false});
    closePageHistory({restoreFocus: false});
    if (groupShareDialog?.open) groupShareDialog.close();
    const returnToGraph = currentView === 'overview' && previous?.mobileGraph === true;
    setMobileGraph(returnToGraph);
    showView(currentView, {sync});
    syncExportButton();
    syncDirectorySelection();
    if (previous?.state && previous.state === activeDirectory && ownsDirectoryWindow(previous.state)) {
      for (const [node, offset] of previous.scroll) node.scrollTop = offset;
    }
    const graphNode = currentView === 'overview' && previous?.graphId
      ? [...document.querySelectorAll('#graph-world [data-id]')].find(node => node.dataset.id === previous.graphId)
      : null;
    const result = currentView === 'actions' && action
      ? [...(document.getElementById('action-list').querySelectorAll?.('[data-id]') || [])]
        .find(button => button.dataset.id === action)
      : currentView === 'overview' && !returnToGraph ? directoryRow(page) : null;
    const target = graphNode || result || (currentView === 'overview' ? (returnToGraph ? mobileGraph : searchInput)
      : document.querySelector('.memory-views [aria-current="page"]'));
    target?.scrollIntoView?.({block: 'nearest', inline: 'nearest'});
    target?.focus?.({preventScroll: true});
  }

  document.getElementById('close-editor').addEventListener('click', () => {
    if (directoryAddress()?.result && memoryWindow?.history?.back) {
      if (directoryBackPending) return;
      directoryBackPending = true;
      memoryWindow.history.back();
    } else returnToList();
  });
  document.getElementById('close-memory-citation-preview')?.addEventListener('click', returnToList);

  const newActionAttempts = new Map();
  let newActionScope = '';

  function newActionAttempt(scope = actionDraftScope()) {
    if (!scope) return null;
    if (!newActionAttempts.has(scope)) {
      let attempt;
      try { attempt = decodeNewActionAttempt(document.defaultView.sessionStorage.getItem('flybot-workspace.memory-action-create:' + scope)); } catch {}
      newActionAttempts.set(scope, attempt || null);
    }
    return newActionAttempts.get(scope);
  }

  function saveNewActionAttempt(scope, attempt) {
    newActionAttempts.set(scope, attempt);
    try {
      const storage = document.defaultView.sessionStorage;
      const name = 'flybot-workspace.memory-action-create:' + scope;
      if (attempt) storage.setItem(name, JSON.stringify({key:attempt.key, payload:attempt.payload}));
      else storage.removeItem(name);
    } catch {}
  }

  function newActionPayload() {
    return {title:newActionFields.title.value.trim(), notes:newActionFields.notes.value,
      due_at:dueAtFromDate(newActionFields.due.value), memory_page_id:newActionFields.page.value || null};
  }

  function renderNewActionAttempt(attempt = newActionAttempt()) {
    const busy = attempt?.busy === true;
    const retry = attempt && JSON.stringify(attempt.payload) === JSON.stringify(newActionPayload());
    for (const field of Object.values(newActionFields)) field.disabled = busy;
    newActionButton.disabled = busy || !actionDraftScope();
    newActionButton.textContent = busy ? '正在保存…' : retry ? '重试保存' : '新建行动';
    newActionStatus.textContent = busy ? '正在保存行动。' : retry ? '上次保存尚未确认。重试会核对同一次请求。'
      : attempt ? '上次保存尚未确认。修改内容后将发起新的保存请求。' : '';
  }

  function applyNewActionDraft(payload) {
    newActionFields.title.value = payload?.title ?? '';
    newActionFields.notes.value = payload?.notes ?? '';
    newActionFields.due.value = dueDateValue(payload?.due_at);
    fillPageSelect(newActionFields.page, payload?.memory_page_id ?? '');
  }

  function syncNewActionWorkspace() {
    const scope = actionDraftScope();
    if (scope === newActionScope) return;
    newActionScope = scope;
    const attempt = newActionAttempt(scope);
    applyNewActionDraft(attempt?.payload);
    newActionForm.dataset.open = String(Boolean(attempt));
    renderNewActionAttempt(attempt);
    syncActionComposer();
  }

  const newActionOpen = document.getElementById('new-action-open');
  newActionForm.addEventListener('input', () => {
    newActionForm.dataset.open = 'true';
    renderNewActionAttempt();
  });
  newActionForm.addEventListener('change', () => renderNewActionAttempt());
  if (newActionOpen) {
    newActionOpen.addEventListener('click', () => {
      newActionForm.dataset.open = String(newActionForm.hidden);
      syncActionComposer();
      if (!newActionForm.hidden) newActionForm.elements.title.focus();
    });
  }
  newActionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const workspace = workspaceId(), scope = actionDraftScope(), visible = pageRequest;
    const previous = newActionAttempt(scope);
    const payload = newActionPayload();
    if (!scope || previous?.busy || !payload.title) return;
    const key = previous && JSON.stringify(previous.payload) === JSON.stringify(payload) ? previous.key : randomKey();
    const attempt = {key, payload, busy:true};
    saveNewActionAttempt(scope, attempt);
    newActionForm.dataset.open = 'true';
    renderNewActionAttempt(attempt);
    const result = await request('POST', `/v1/workspaces/${workspace}/memory/actions`, payload, {'Idempotency-Key':key})
      .catch(() => ({status:0, body:{}}));
    attempt.busy = false;
    const row = result.body?.action;
    const saved = [200,201].includes(result.status) && row?.workspace_id === workspace && MEMORY_ID.test(row.id || '');
    const definitiveFailure = result.status >= 400 && result.status < 500 && result.status !== 408;
    if (saved || definitiveFailure) saveNewActionAttempt(scope, null);
    if (actionDraftScope() !== scope) return;
    if (!saved) {
      renderNewActionAttempt();
      if (definitiveFailure) show('error', messageFor(result.body.error, '无法创建下一步行动。'));
      return;
    }
    applyNewActionDraft();
    newActionForm.dataset.open = 'false';
    renderNewActionAttempt();
    syncActionComposer();
    if (pageRequest !== visible || currentView !== 'actions') return;
    show('ok', '已创建下一步行动。');
    void loadActions();
    await openAction(row.id);
  });

  actionEditor.addEventListener('input', storeActionEdit);
  actionEditor.addEventListener('change', storeActionEdit);
  actionEditor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = workspaceId();
    const owner = currentUser;
    const editing = currentAction;
    const key = actionEditKey(editing, owner);
    if (!id || !editing || !key || actionEditor.hidden || actionEditConflict || actionEditsSaving.has(key)) return;
    const base = actionFields(editing), submitted = actionFields();
    submitted.title = submitted.title.trim();
    const changes = {};
    for (const name of ACTION_EDIT_FIELDS) {
      if (base[name] === submitted[name]) continue;
      if (name === 'due') changes.due_at = dueAtFromDate(submitted.due);
      else changes[name] = name === 'memory_page_id' ? (submitted[name] || null) : submitted[name];
    }
    if (!Object.keys(changes).length) {
      fillActionEdit(base);
      storeActionEdit();
      return;
    }
    const path = `/v1/workspaces/${id}/memory/actions/${editing.id}`;
    const pending = {revision:editing.revision, submitted};
    const isCurrent = () => workspaceId() === id && currentUser?.id === owner.id && actionEditKey() === key && !actionEditor.hidden;
    actionEditsSaving.add(key);
    writeActionEdit(key, {base, fields:actionFields(), pending});
    showActionEdit();
    const signal = () => globalThis.AbortSignal?.timeout?.(8000);
    const saved = await request('POST', path, {revision: editing.revision, changes}, undefined, signal())
      .catch(() => ({status:0, body:{}}));
    const uncertain = saved.status === 0 || saved.status === 408 || saved.status >= 500;
    let latest = saved.status === 200 ? saved.body.action : null;
    if (currentUser?.id === owner.id && (uncertain || saved.status === 409 || (saved.status === 200 && !latest))) {
      const checked = await request('GET', path, undefined, undefined, signal()).catch(() => ({status:0, body:{}}));
      latest = checked.status === 200 ? checked.body.action : null;
    }
    actionEditsSaving.delete(key);
    if (currentUser?.id !== owner.id) return;
    const valid = latest?.id === editing.id && latest.workspace_id === id &&
      Number.isSafeInteger(latest.revision) && latest.revision >= editing.revision;
    const confirmed = valid && actionEditCommitted(base, pending, actionFields(latest), latest.revision);
    const draft = readActionEdit(key);
    if (valid && workspaceId() === id) void loadActions();
    if (!isCurrent() || (valid && latest.revision < currentAction.revision)) {
      if (valid && draft?.pending?.revision === pending.revision) {
        writeActionEdit(key, advanceActionEdit(draft, actionFields(latest), latest.revision));
      }
      if (isCurrent()) showActionEdit();
      return;
    }
    if (!valid) {
      if (draft && !uncertain && saved.status !== 200 && saved.status !== 409) {
        writeActionEdit(key, {base:draft.base, fields:draft.fields});
      }
      showActionEdit();
      show('error', messageFor(saved.body.error, '无法保存下一步行动。'));
      return;
    }
    const fields = actionFields();
    fields.title = fields.title.trim();
    closeDeleteConfirm({restoreFocus: false});
    currentAction = latest;
    restoreActionEdit(draft?.pending ? {...draft, fields} : {base:confirmed ? submitted : base, fields});
    renderActionDetail();
    if (confirmed) show('ok', '已保存。');
    else if (latest.revision === editing.revision) show('note', '尚未确认保存，草稿已保留。');
    else show('note', actionEditConflict ? '此行动已在别处更新，请选择要保留的内容。' : '已载入最新版本，草稿仍可保存。');
  });

  document.getElementById('delete-action').addEventListener('click', () => {
    openDeleteConfirm('action', currentAction);
  });

  document.getElementById('close-action-editor').addEventListener('click', returnToList);

  loadSession();
  return {renderGraph};
}

if (typeof document !== 'undefined' && document.getElementById('login-form')) {
  mount(document);
}
