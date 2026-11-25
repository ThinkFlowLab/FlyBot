import {studioDocumentHref} from '../shell/studio-link.mjs';
import {mountStudioHistory} from './studio-history.mjs';
import {mountStudioDiscussion} from './studio-discussion.mjs';
import {mountStudioPersonalCopy} from './studio-personal-copy.mjs';
import {mergeStudioDraft} from './studio-merge.mjs';
import {requestStudio, studioScope} from './entry.mjs';

const ID = /^[a-f0-9]{32}$/;
const UPDATE_INTERVAL = 4000;
const WATCH_INTERVAL = 200;
const WATCH_BACKOFF = 20000;
const PRESENCE_INTERVAL = 6500;
const DRAFT_LIFETIME = 12 * 60 * 60 * 1000;
const displayedBody = body => body.replace(/\r\n?/g, '\n');
const validDraftText = value => typeof value?.title === 'string' && value.title.length <= 120 &&
  typeof value.body === 'string' && value.body.length <= 60000;

function setEditorValue(input, value) {
  const previous = input.value;
  if (previous === value) return;
  const selected = input === input.ownerDocument.activeElement;
  const {selectionStart, selectionEnd, selectionDirection, scrollTop} = input;
  input.value = value;
  if (!selected || !Number.isInteger(selectionStart) || !Number.isInteger(selectionEnd)) return;
  let prefix = 0, suffix = 0;
  const edge = Math.min(previous.length, value.length);
  while (prefix < edge && previous[prefix] === value[prefix]) prefix += 1;
  while (suffix < edge - prefix && previous.at(-1 - suffix) === value.at(-1 - suffix)) suffix += 1;
  const offset = index => index <= prefix ? index
    : index >= previous.length - suffix ? index + value.length - previous.length
      : Math.min(index, value.length - suffix);
  input.setSelectionRange(offset(selectionStart), offset(selectionEnd), selectionDirection);
  input.scrollTop = scrollTop;
}

export function mountSharedStudio(document, {request, personalWorkspace, onClose, onOpenCatalog, onCatalog, onDocument}) {
  const get = id => document.getElementById('studio-' + id);
  const button = get('open');
  const dialog = get('dialog');
  if (!button || typeof dialog?.showModal !== 'function') return null;

  const catalog = get('catalog');
  const list = get('list');
  const catalogQuery = get('catalog-query');
  const catalogClear = get('catalog-clear');
  const catalogNoMatch = get('catalog-no-match');
  const form = get('form');
  const titleInput = get('title');
  const bodyInput = get('body');
  const compare = get('compare');
  const save = get('save');
  const remove = get('delete');
  const closeButton = get('close');
  const openActions = get('open-actions');
  const openRetry = get('open-retry');
  const add = get('add');
  const copyLink = get('copy-link');
  const discuss = get('discuss');
  const savePersonal = get('save-personal');
  const linkWrap = get('link-wrap');
  const view = document.defaultView;
  let scope = null;
  let screen;
  let catalogSignature = '';

  const searchable = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const catalogQueryKey = () => 'flybot-workspace.studio-query:' + JSON.stringify([scope.account, scope.id]);

  function filterCatalog() {
    if (!catalogQuery || !catalogNoMatch) return;
    const query = searchable(catalogQuery.value);
    catalogClear.hidden = !catalogQuery.value;
    let matches = 0;
    for (const row of list.children) {
      row.hidden = !row.dataset.search.includes(query);
      if (!row.hidden) matches++;
    }
    catalogNoMatch.hidden = !query || !list.children.length || matches > 0;
  }

  function searchCatalog() {
    if (scope) {
      try {
        const key = catalogQueryKey();
        if (catalogQuery.value.trim()) view.sessionStorage.setItem(key, catalogQuery.value.slice(0, 80));
        else view.sessionStorage.removeItem(key);
      } catch {}
    }
    filterCatalog();
  }

  function show(text = '', kind = '') {
    const status = get('status');
    status.textContent = text;
    status.dataset.kind = kind;
  }

  const documentPath = (state, id = state.base?.id) => state.path + (id ? '/' + id : '');
  const isCurrent = state => dialog.open && screen === state;
  const isVisible = state => isCurrent(state) && state.base && !state.unavailable && document.visibilityState !== 'hidden';
  function content() {
    const body = bodyInput.value;
    if (body === screen?.displayBase) return {title: titleInput.value.trim(), body: screen.base.body};
    const withLineEndings = screen?.useCRLF ? body.replace(/\n/g, '\r\n') : body;
    return {title: titleInput.value.trim(), body: withLineEndings.length <= bodyInput.maxLength ? withLineEndings : body};
  }
  const sameContent = (left, right) => left.title === right.title && left.body === right.body;
  const isDirty = state => !form.hidden && (state?.base
    ? !sameContent(content(), state.base)
    : Boolean(titleInput.value.trim() || bodyInput.value));

  const draftKey = id => 'flybot-workspace.studio-draft:' + JSON.stringify([scope.account, scope.id, id]);
  function discardDraft(state) {
    if (!state?.draftKey) return;
    view.clearTimeout(state.draftTimer);
    try { view.sessionStorage.removeItem(state.draftKey); } catch {}
  }

  function readDraft(state) {
    try {
      const draft = JSON.parse(view.sessionStorage.getItem(state.draftKey) || 'null');
      if (!draft) return null;
      const validBase = state.mode === 'new' ? draft.base === null :
        validDraftText(draft.base) && Number.isSafeInteger(draft.base.revision) && draft.base.revision > 0;
      if (validBase && Number.isFinite(draft.expires) && draft.expires > Date.now() && validDraftText(draft.fields) &&
          (!draft.attempt || (state.mode === 'new' && validDraftText(draft.attempt) &&
            /^[0-9a-f-]{36}$/.test(draft.attempt.client_key || '')))) return draft;
      discardDraft(state);
    } catch { discardDraft(state); }
    return null;
  }

  function rememberDraft(state) {
    if (!state?.draftKey || !isCurrent(state) || form.hidden) return;
    view.clearTimeout(state.draftTimer);
    if (state.unavailable || (!isDirty(state) && !state.attempt)) return discardDraft(state);
    const fields = content();
    if (!validDraftText(fields)) return;
    const base = state.base && {revision:state.base.revision, title:state.base.title, body:state.base.body};
    try {
      view.sessionStorage.setItem(state.draftKey, JSON.stringify({
        expires:Date.now() + DRAFT_LIFETIME, fields, base, attempt:state.base ? null : state.attempt,
      }));
    } catch {}
  }
  const canDiscuss = state => state?.base && !state.busy && !state.remote && !state.blocked &&
    !state.unavailable && !isDirty(state);
  const discussion = mountStudioDiscussion(document, {
    request,
    source: () => dialog.open && scope && canDiscuss(screen)
      ? {owner:scope.account, workspace:scope.id, document:screen.base} : null,
    openChat: path => view.location.assign(path),
  });
  discuss?.addEventListener('click', () => discussion?.open());
  const personalCopy = mountStudioPersonalCopy(document, request);

  function saveToPersonal(revision = screen?.base?.revision) {
    const state = screen, wid = scope?.id, owner = scope?.account, id = state?.base?.id;
    if (!state || !isCurrent(state) || state.unavailable || !id || !Number.isSafeInteger(revision)) return;
    personalCopy?.open({workspace:wid, workspaceName:scope.name, personal:personalWorkspace?.(), id, revision,
      current:()=>isCurrent(state) && scope?.id === wid && scope?.account === owner && state.base?.id === id && !state.unavailable});
  }
  savePersonal?.addEventListener('click',()=>saveToPersonal());

  function send(method, path, body, signal) {
    return requestStudio(request, method, path, body, signal);
  }

  async function readOpening(state, path) {
    const pending = state.opening;
    state.opening = null;
    const response = pending && await pending;
    if (response && (response.status || !isCurrent(state))) return response;
    return send('GET', path, undefined, state.controller.signal);
  }

  const history = mountStudioHistory(document, {
    context: () => screen?.base && isCurrent(screen) ? {
      path:documentPath(screen), revision:screen.base.revision, dirty:isDirty(screen),
      busy:screen.busy, blocked:screen.blocked || Boolean(screen.remote), unavailable:screen.unavailable,
      personalCopy:Boolean(personalWorkspace?.()),
    } : null,
    send,
    savePersonal:saveToPersonal,
    async restoreVersion(path, revision, to) {
      const state = screen;
      if (!state?.base || !isCurrent(state) || state.busy || state.blocked || state.remote ||
          state.unavailable || isDirty(state) || state.base.revision !== revision || documentPath(state) !== path) {
        return 'conflict';
      }
      state.busy = true;
      stopWatch(state);
      controls(state);
      const result = await send('POST', path + '/restore', {revision,to}, state.controller.signal);
      if (!isCurrent(state)) return '';
      state.busy = false;
      const item = responseDocument(result, state.base.id);
      if (item) {
        showForm(state, item);
        show('已恢复为版本 ' + item.revision + '。', 'success');
        queueUpdate(state);
        return 'restored';
      }
      const conflict = result.status === 409;
      if (conflict) state.blocked = true;
      controls(state);
      void checkUpdates(state, true);
      return conflict ? 'conflict' : '';
    },
  });

  function controls(state) {
    const {base, busy, remote, blocked, unavailable} = state;
    closeButton.disabled = busy;
    add.disabled = busy;
    titleInput.readOnly = bodyInput.readOnly = busy;
    save.disabled = busy || state.composing || Boolean(remote || blocked || unavailable) || !titleInput.value.trim() || !isDirty(state);
    remove.hidden = !base?.can_delete || unavailable;
    remove.disabled = busy || Boolean(remote || blocked);
    copyLink.hidden = !base || unavailable;
    if (savePersonal) savePersonal.hidden = !base || unavailable || !personalWorkspace?.();
    if (discuss) {
      discuss.hidden = !base || unavailable;
      discuss.disabled = !canDiscuss(state);
    }
    get('conflict').hidden = !remote;
    get('use-server').disabled = get('rebase').disabled = busy || unavailable;
    get('revision').textContent = base
      ? '版本 ' + base.revision + (base.updated_by ? ' · ' + base.updated_by : '')
      : '保存后，此工作区成员可一起编辑。';
    history.sync();
  }

  function stopScreen() {
    personalCopy?.close();
    discussion?.close();
    history.dismiss();
    const previous = screen;
    screen = null;
    stopWatch(previous);
    view.clearTimeout(previous?.draftTimer);
    previous?.controller.abort();
    refreshPresence(previous);
    titleInput.value = bodyInput.value = get('link').value = '';
    clearComparison();
    renderPresence([]);
  }

  function newScreen(mode, id, prepared) {
    stopScreen();
    const opening = prepared?.workspace === scope.id && prepared?.id === id && prepared?.account === scope.account
      && !prepared.controller.signal.aborted ? prepared : null;
    screen = {
      path: '/v1/workspaces/' + scope.id + '/studio/documents',
      mode, id, controller: opening?.controller || new AbortController(),
      opening: opening?.response,
      draftKey:mode === 'catalog' ? null : draftKey(id || 'new'),
      base: null, remote: null, attempt: null, busy: false, blocked: false, unavailable: false, composing: false,
    };
    catalog.hidden = mode !== 'catalog';
    form.hidden = true;
    openActions.hidden = true;
    linkWrap.hidden = true;
    compare.open = false;
    get('heading').textContent = mode === 'catalog' ? '团队协作' : mode === 'new' ? '新建团队文档' : '团队文档';
    show();
    controls(screen);
    return screen;
  }

  function mayLeave() {
    if (screen?.busy) return false;
    return !isDirty(screen) || view.confirm('要放弃团队文档中未保存的修改吗？');
  }

  function showForm(state, item, fields = item) {
    state.base = item;
    state.remote = null;
    state.blocked = false;
    state.unavailable = false;
    state.displayBase = item ? displayedBody(item.body) : undefined;
    state.useCRLF = Boolean(item?.body.includes('\r\n') && !/[\r\n]/.test(item.body.replaceAll('\r\n', '')));
    setEditorValue(titleInput, fields?.title || '');
    setEditorValue(bodyInput, displayedBody(fields?.body || ''));
    get('link').value = item ? new URL(studioDocumentHref(scope.id, item.id), view.location.origin).href : '';
    form.hidden = false;
    compare.open = false;
    clearComparison();
    controls(state);
    rememberDraft(state);
  }

  function responseDocument(result, id) {
    const item = result.body?.document;
    return (result.status === 200 || result.status === 201) && ID.test(item?.id || '')
      && (!id || item.id === id) && typeof item.title === 'string' && typeof item.body === 'string'
      && Number.isSafeInteger(item.revision) && item.revision >= 1 ? item : null;
  }

  function unavailable(state) {
    personalCopy?.close();
    state.unavailable = true;
    discardDraft(state);
    state.remote = state.deferred = null;
    stopWatch(state);
    refreshPresence(state);
    renderPresence([]);
    clearComparison();
    controls(state);
    show('已无法读取此文档。你仍可以复制当前内容。', 'error');
  }

  function clearComparison() {
    get('server-title').textContent = get('server-body').textContent = '';
    get('local-title').textContent = get('local-body').textContent = '';
  }

  function updateLocalComparison(state) {
    if (!state.remote) return;
    const draft = content();
    get('local-title').textContent = draft.title || '未填写标题';
    get('local-body').textContent = draft.body;
  }

  function applyRemote(state, latest) {
    if (latest.revision < (state.remote?.revision || state.base.revision)) return;
    if (state.composing) {
      state.deferred = latest;
      return;
    }
    if (latest.revision === state.base.revision) {
      state.base = latest;
      controls(state);
      return;
    }
    if (!isDirty(state) || sameContent(content(), latest)) {
      showForm(state, latest);
      show('已同步团队文档。', 'success');
      return;
    }
    const merged = mergeStudioDraft(state.base, content(), latest);
    if (merged) {
      showForm(state, latest, merged);
      show(sameContent(merged, latest)
        ? '你的修改已包含在团队版本中。'
        : '已合并团队更新。请检查草稿后保存。', 'success');
      refreshPresence(state);
      return;
    }
    if (!state.remote) compare.open = true;
    state.remote = latest;
    updateLocalComparison(state);
    get('server-title').textContent = '版本 ' + latest.revision + ' · ' + latest.title;
    get('server-body').textContent = latest.body;
    controls(state);
    show();
  }

  function renderPresence(editors) {
    const others = editors.filter(row => typeof row?.name === 'string' && row.name.trim());
    const labels = others.slice(0, 3).map(row => row.name.trim().slice(0, 80) + (row.editing ? ' 正在编辑' : ' 正在查看'));
    if (others.length > labels.length) labels.push('另有 ' + (others.length - labels.length) + ' 人在线');
    const indicator = get('presence');
    const text = labels.join(' · ');
    if (text !== indicator.textContent) indicator.textContent = text;
    indicator.hidden = !text;
  }

  function refreshPresence(state, heartbeat = false) {
    const active = Boolean(state && isVisible(state));
    if (active && !state.presence) state.presence = {id: view.crypto.randomUUID()};
    const presence = state?.presence;
    if (!presence || presence.request) return;
    const editing = active && isDirty(state);
    if (!heartbeat && presence.active === active && presence.editing === editing) return;
    if (!active && presence.active !== true) return;
    view.clearTimeout(presence.timer);
    presence.active = active;
    presence.editing = editing;
    presence.request = send('POST', documentPath(state) + '/live', {
      session_id: presence.id, active, editing,
    });
    void presence.request.then(result => {
      presence.request = null;
      if (Boolean(isVisible(state)) !== active || (active && isDirty(state) !== editing)) {
        refreshPresence(state);
      } else if (active) {
        const delay = result.status === 200 ? PRESENCE_INTERVAL : WATCH_BACKOFF;
        presence.timer = view.setTimeout(() => refreshPresence(state, true), delay);
      }
    });
  }

  function stopWatch(state) {
    if (!state) return;
    view.clearTimeout(state.watchTimer);
    const watch = state.watch;
    state.watch = null;
    watch?.abort();
  }

  function queueUpdate(state) {
    view.clearTimeout(state.watchTimer);
    if (!isVisible(state) || state.busy || state.watch) return;
    const interval = Date.now() < state.watchBackoff ? UPDATE_INTERVAL : WATCH_INTERVAL;
    state.watchTimer = view.setTimeout(() => void checkUpdates(state), interval);
  }

  async function checkUpdates(state, force = false) {
    if (!isVisible(state) || state.busy) return;
    if (force) stopWatch(state);
    if (state.watch) return;
    const controller = new AbortController();
    state.watch = controller;
    const path = documentPath(state);
    const known = state.deferred?.revision || state.remote?.revision || state.base.revision;
    const query = '?revision=' + known;
    let result;
    if (!force && !state.blocked && !(Date.now() < state.watchBackoff)) {
      result = await send('GET', path + '/live' + query, undefined, controller.signal);
      if (state.watch !== controller) return;
      if (result.status === 200 && Array.isArray(result.body?.editors)) {
        renderPresence(result.body.editors);
      } else if (![401, 403, 410].includes(result.status)) {
        state.watchBackoff = Date.now() + WATCH_BACKOFF;
        renderPresence([]);
        result = null;
      }
    }
    result ??= await send('GET', path + (force || state.blocked ? '' : query), undefined, controller.signal);
    if (state.watch !== controller) return;
    state.watch = null;
    if (!isVisible(state)) return;
    const latest = responseDocument(result, state.base.id);
    if (latest) applyRemote(state, latest);
    else if ([401, 403, 404, 410].includes(result.status)) {
      unavailable(state);
      return;
    }
    refreshPresence(state);
    queueUpdate(state);
  }

  async function openDocument(id, revision, prepared) {
    if (!ID.test(id || '')) return;
    const openedFrom = document.activeElement;
    const state = newScreen('edit', id, prepared);
    state.revision = revision;
    show('正在打开团队文档…');
    const result = await readOpening(state, documentPath(state, id));
    if (!isCurrent(state)) return;
    const item = responseDocument(result, id);
    if (!item) {
      if ([401,403,404,410].includes(result.status)) {
        discardDraft(state);
        onCatalog?.(scope.id);
        await loadCatalog('团队文档不存在，或你没有访问权限。');
      } else {
        show('暂时无法打开团队文档。', 'error');
        openActions.hidden = false;
        if ([openedFrom, closeButton, document.body].includes(document.activeElement)) openRetry.focus();
      }
      return;
    }
    show();
    const restored = readDraft(state);
    if (restored && restored.base.revision <= item.revision && !sameContent(restored.fields, item)) {
      const storedBase = restored.base.revision < item.revision ? {...item, ...restored.base} : item;
      showForm(state, storedBase, restored.fields);
      show('已恢复本标签页的未保存草稿。');
      if (item.revision > storedBase.revision) applyRemote(state, item);
    } else showForm(state, item);
    onDocument?.(scope.id, item.id, revision);
    refreshPresence(state);
    queueUpdate(state);
    if (revision) history.showVersion(revision);
    else get('back').focus();
  }

  function clearCatalog() {
    catalogSignature = '';
    list.replaceChildren();
    if (catalogNoMatch) catalogNoMatch.hidden = true;
  }

  function focusCatalogDocument(id, fallback) {
    const row = [...list.children].find(candidate => candidate.dataset.document === id && !candidate.hidden);
    (row?.firstElementChild || fallback)?.focus();
  }

  function renderCatalogItems(items) {
    const documents = items.filter(item => ID.test(item?.id || '') && typeof item.title === 'string');
    const signature = JSON.stringify(documents.map(({id,title,revision,updated_by}) => [id,title,revision,updated_by]));
    if (catalogSignature === signature) return;
    catalogSignature = signature;
    const focused = list.contains(document.activeElement) ? document.activeElement.parentElement.dataset.document : '';
    const rows = documents.map(item => {
      const row = document.createElement('li');
      row.dataset.search = searchable(item.title + ' ' + (item.updated_by || ''));
      row.dataset.document = item.id;
      const open = document.createElement('button');
      open.className = 'secondary';
      open.type = 'button';
      open.textContent = item.title;
      open.addEventListener('click', () => void openDocument(item.id));
      const meta = document.createElement('span');
      meta.className = 'note';
      meta.textContent = '版本 ' + item.revision + (item.updated_by ? ' · ' + item.updated_by : '');
      row.append(open, meta);
      return row;
    });
    list.replaceChildren(...rows);
    filterCatalog();
    if (focused) focusCatalogDocument(focused, catalogQuery);
  }

  async function loadCatalog(failure = '', returnTo = '', prepared) {
    const state = newScreen('catalog', undefined, prepared);
    add.textContent = readDraft({mode:'new',draftKey:draftKey('new')}) ? '继续新建团队文档' : '新建团队文档';
    if (!returnTo) clearCatalog();
    filterCatalog();
    if (returnTo) focusCatalogDocument(returnTo, add);
    const refresh = get('refresh');
    refresh.disabled = true;
    list.setAttribute('aria-busy', 'true');
    if (!list.children.length) show('正在读取团队文档…');
    const result = await readOpening(state, state.path);
    if (!isCurrent(state)) return;
    refresh.disabled = false;
    list.setAttribute('aria-busy', 'false');
    if (result.status !== 200 || !Array.isArray(result.body?.items)) {
      const denied = [401,403,404,410].includes(result.status);
      if (denied) {
        if (list.contains(document.activeElement)) refresh.focus();
        clearCatalog();
      }
      show(denied ? '你已无法访问此工作区的团队文档。' : '暂时无法读取团队文档，请刷新列表。', 'error');
      add.disabled = true;
      return;
    }
    renderCatalogItems(result.body.items);
    show(failure || (list.children.length ? '' : '还没有团队文档。'), failure ? 'error' : '');
    if (returnTo && document.activeElement === add) focusCatalogDocument(returnTo);
  }

  async function open(id, revision, returnTo, prepared) {
    if (!scope || dialog.open) return false;
    get('workspace-name').textContent = scope.name;
    dialog.showModal();
    closeButton.focus();
    if (id) await openDocument(id, revision, prepared);
    else {
      onOpenCatalog?.(scope.id);
      await loadCatalog('', returnTo, prepared);
    }
    return true;
  }

  function leaveForNavigation() {
    if (!dialog.open) return;
    discardDraft(screen);
    stopScreen();
    dialog.close();
  }

  function close() {
    if (!mayLeave()) return;
    leaveForNavigation();
    clearCatalog();
    onClose?.();
    if (!button.hidden) button.focus();
  }

  catalogQuery?.addEventListener('input', searchCatalog);
  catalogClear?.addEventListener('click', () => {
    catalogQuery.value = '';
    searchCatalog();
    catalogQuery.focus();
  });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  function backToCatalog() {
    if (!mayLeave()) return;
    const last = screen?.base?.id || screen?.id;
    discardDraft(screen);
    if (onCatalog?.(scope.id, {back:Boolean(screen?.base)})) return;
    void loadCatalog('', last);
    if (!last) add.focus();
  }
  get('back').addEventListener('click', backToCatalog);
  get('open-back').addEventListener('click', backToCatalog);
  openRetry.addEventListener('click', () => {
    if (screen?.id && !openActions.hidden) void openDocument(screen.id, screen.revision);
  });
  add.addEventListener('click', () => {
    const state = newScreen('new');
    const restored = readDraft(state);
    state.attempt = restored?.attempt || null;
    showForm(state, null, restored?.fields);
    if (restored) show('已恢复本标签页的未保存草稿。');
    titleInput.focus();
  });
  get('refresh').addEventListener('click', () => void loadCatalog());
  form.addEventListener('input', () => {
    if (!screen) return;
    const state = screen;
    view.clearTimeout(state.draftTimer);
    state.draftTimer = view.setTimeout(() => rememberDraft(state), 150);
    if (compare.open) updateLocalComparison(screen);
    controls(screen);
    refreshPresence(screen);
  });
  compare.addEventListener('toggle', () => {
    if (screen && compare.open) updateLocalComparison(screen);
  });
  form.addEventListener('compositionstart', () => {
    if (!screen?.base) return;
    screen.composing = true;
    controls(screen);
  });
  form.addEventListener('compositionend', () => {
    const state = screen;
    if (!state?.base) return;
    view.setTimeout(() => {
      if (!isCurrent(state)) return;
      state.composing = false;
      const latest = state.deferred;
      state.deferred = null;
      if (latest) applyRemote(state, latest);
      controls(state);
      refreshPresence(state);
    }, 0);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const state = screen;
    if (!isCurrent(state) || save.disabled) return;
    const draft = content();
    const creating = !state.base;
    const payload = creating ? (state.attempt ??= {...draft, client_key: view.crypto.randomUUID()})
      : {...draft, revision: state.base.revision};
    rememberDraft(state);
    state.busy = true;
    stopWatch(state);
    controls(state);
    show('正在保存…');
    const result = await send('POST', documentPath(state), payload, state.controller.signal);
    if (!isCurrent(state)) return;
    state.busy = false;
    const item = responseDocument(result, state.base?.id);
    if (item) {
      const retainedDraft = creating && !sameContent(draft, payload);
      if (creating) {
        discardDraft(state);
        state.draftKey = draftKey(item.id);
        state.mode = 'edit';
        state.attempt = null;
        onDocument?.(scope.id, item.id);
      }
      showForm(state, item, retainedDraft ? draft : item);
      get('heading').textContent = '团队文档';
      show(retainedDraft ? '文档已创建，后续修改仍待保存。' : '已保存。', 'success');
    } else if (result.status === 409 && !creating && result.body?.error?.code === 'revision_conflict') {
      state.blocked = true;
      show('服务器有新版本。正在读取更新…', 'error');
      void checkUpdates(state, true);
    } else if (!creating && [401, 403, 404].includes(result.status)) {
      unavailable(state);
    } else {
      if (creating && [400, 401, 403, 404, 422].includes(result.status)) {
        state.attempt = null;
        rememberDraft(state);
      }
      const error = result.body?.error?.code;
      show(error === 'document_deleted' ? '之前创建的团队文档已被删除。请返回列表重新新建。'
        : error === 'idempotency_conflict' ? '无法确认文档是否已经创建。请返回列表查看。'
        : '暂时无法确认保存，当前草稿仍保留。请重试。', 'error');
    }
    controls(state);
    refreshPresence(state);
    queueUpdate(state);
  });

  get('use-server').addEventListener('click', () => {
    const state = screen;
    if (!state?.remote || state.busy || state.unavailable || !view.confirm('要放弃当前草稿并采用团队版本吗？')) return;
    showForm(state, state.remote);
    show('已采用团队版本。', 'success');
    refreshPresence(state);
    titleInput.focus();
  });
  get('rebase').addEventListener('click', () => {
    const state = screen;
    if (!state?.remote || state.busy || state.unavailable) return;
    showForm(state, state.remote, content());
    show('已保留草稿。请确认修改，保存后会成为新的团队版本。');
    refreshPresence(state);
    bodyInput.focus();
  });

  remove.addEventListener('click', async () => {
    const state = screen;
    if (!state?.base?.can_delete || state.busy || state.remote || state.blocked || state.unavailable ||
        !view.confirm('要删除此团队文档吗？此操作会影响所有团队成员。')) return;
    state.busy = true;
    stopWatch(state);
    controls(state);
    const result = await send('POST', documentPath(state) + '/remove',
      {revision: state.base.revision}, state.controller.signal);
    if (!isCurrent(state)) return;
    state.busy = false;
    if (result.status === 200 || result.status === 204) {
      discardDraft(state);
      onCatalog?.(scope.id);
      await loadCatalog();
      return;
    }
    if (result.status === 409 && result.body?.error?.code === 'revision_conflict') {
      state.blocked = true;
      show('服务器有新版本。正在读取更新…', 'error');
      void checkUpdates(state, true);
    } else if ([401, 403, 404].includes(result.status)) {
      show('无法删除此文档。正在检查当前权限…', 'error');
      await checkUpdates(state, true);
      if (!isCurrent(state)) return;
      if (!state.unavailable) show('无法删除此文档，请检查权限。', 'error');
    } else show('暂时无法确认删除，请检查团队文档。', 'error');
    controls(state);
    queueUpdate(state);
  });

  copyLink.addEventListener('click', async () => {
    const state = screen;
    if (!state?.base || !scope) return;
    const input = get('link');
    try {
      await view.navigator.clipboard.writeText(input.value);
      if (isCurrent(state)) show('已复制文档链接。', 'success');
    } catch {
      if (!isCurrent(state)) return;
      linkWrap.hidden = false;
      input.select();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      rememberDraft(screen);
      stopWatch(screen);
    }
    else if (screen?.base) void checkUpdates(screen);
    refreshPresence(screen);
  });
  view.addEventListener('beforeunload', event => {
    if (!dialog.open || (!screen?.busy && !isDirty(screen))) return;
    rememberDraft(screen);
    event.preventDefault();
    event.returnValue = '';
  });

  return {
    setWorkspace(team, account) {
      const next = studioScope(team, account);
      const changed = next?.id !== scope?.id || next?.account !== scope?.account;
      if (changed) {
        if (dialog.open) {
          rememberDraft(screen);
          stopScreen();
          dialog.close();
          onClose?.();
        }
        clearCatalog();
      }
      scope = next;
      if (changed && catalogQuery) {
        catalogQuery.value = '';
        if (scope) {
          try { catalogQuery.value = (view.sessionStorage.getItem(catalogQueryKey()) || '').slice(0, 80); } catch {}
        }
        filterCatalog();
      }
      button.hidden = !scope;
    },
    canLeave: () => !dialog.open || mayLeave(),
    leaveForNavigation,
    open,
  };
}
