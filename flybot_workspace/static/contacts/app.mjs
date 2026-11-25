import {conversationChatHref} from '../shell/thumb.mjs';
import {servedByDsBot} from '../shell/dsbot-api.mjs';

const byId = id => document.getElementById(id);
const root = '/v1/contacts';
const list = byId('contacts-list');
const state = byId('contacts-state');
const retry = byId('reload-contacts');
const search = byId('contact-search');
const tabs = [...document.querySelectorAll('[data-section]')];
const dialog = byId('add-contact-dialog');
const handleField = byId('contact-handle');
const lookupState = byId('lookup-state');
const lookupResult = byId('lookup-result');
const lookupButton = byId('lookup-contact');
const sendRequest = byId('request-contact');
const lookupRelationship = byId('lookup-relationship');
const native = servedByDsBot(document);
const ownerPattern = /^[0-9a-f]{32}$/;
const contactPattern = /^otcpt_[A-Za-z0-9_-]{1,80}$/;

let section = 'accepted';
let workspace = '';
let records = [];
let loaded = false;
let loading = false;
let failed = false;
let located = null;
let lookupSequence = 0;
let submitting = false;
let version = 0;
let confirmRemove = '';
let owner = '';
let epoch = 0;
let returnFocus = '';
let browsingChanged = false;
const busy = new Map();

async function request(path, body) {
  const scope = epoch;
  const headers = {Accept: 'application/json'};
  const method = body === undefined ? 'GET' : 'POST';
  if (body !== undefined) {
    const token = /(?:^|;\s*)(?:__Host-ot_csrf|ot_dev_csrf)=([^;]+)/.exec(document.cookie)?.[1];
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = decodeURIComponent(token || '');
  }
  const response = await fetch(path, {method, headers, credentials: 'same-origin', body: JSON.stringify(body)});
  if (response.status === 401) {
    if (scope === epoch) location.assign('/login');
    throw new Error('请先登录。');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = response.status === 404 && path.startsWith(root + '/lookup')
      ? '没有找到这个用户名。' : data.error?.message;
    throw new Error(message || '暂时无法完成操作，请重试。');
  }
  return data;
}

function notify(message, error = false) {
  const status = byId('status');
  status.dataset.kind = error ? 'error' : 'ok';
  status.textContent = message;
}

function replaceRecord(item) {
  ++version;
  records = records.filter(row => row.id !== item.id);
  if (item.status === 'accepted' || item.status === 'pending') records.unshift(item);
}

function rememberDirectory(contact = '') {
  if (!ownerPattern.test(owner)) return;
  try {
    history.replaceState({...history.state, contactsDirectory: {
      owner, section, query:search.value.slice(0, 80), contact,
    }}, '');
  } catch {}
}

function restoreDirectory() {
  const saved = history.state?.contactsDirectory;
  const matching = ownerPattern.test(owner) && saved?.owner === owner;
  section = matching && saved.section === 'pending' ? 'pending' : 'accepted';
  search.value = matching && typeof saved.query === 'string' ? saved.query.slice(0, 80) : '';
  returnFocus = matching && contactPattern.test(saved.contact || '') ? saved.contact : '';
}

function avatarText(peer) {
  return [...(peer.display_name || peer.handle || '?')][0].toUpperCase();
}

function updateTabs() {
  for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.section === section));
  const count = records.filter(row => row.status === 'pending' && row.incoming).length;
  const badge = byId('request-count');
  badge.textContent = count ? String(count) : '';
  badge.hidden = count === 0;
}

function render() {
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.closest('li')?.dataset.contactId;
  const focusAction = focused?.dataset.action;
  updateTabs();
  byId('contacts-results').setAttribute('aria-busy', String(loading));
  retry.hidden = !failed;
  const query = search.value.trim().replace(/^@/, '').toLocaleLowerCase();
  const visible = records.filter(row => row.status === section &&
    [row.peer.display_name, row.peer.handle].some(value => value?.toLocaleLowerCase().includes(query)));
  state.textContent = !loaded && loading ? '正在加载联系人…'
    : failed ? '联系人加载失败。'
      : visible.length ? '' : query ? '没有匹配的联系人。'
        : section === 'pending' ? '暂无联系人申请。' : '暂无联系人。';

  list.replaceChildren(...visible.map(row => {
    const item = document.createElement('li');
    item.className = 'contact-person';
    item.dataset.contactId = row.id;
    const avatar = document.createElement('span');
    avatar.className = 'contact-avatar';
    avatar.setAttribute('aria-hidden','true');
    avatar.textContent = avatarText(row.peer);
    const info = document.createElement('div');
    info.className = 'contact-info';
    const name = document.createElement('strong');
    name.textContent = row.peer.display_name || row.peer.handle;
    const handle = document.createElement('span');
    handle.textContent = '@' + row.peer.handle;
    info.append(name, handle);
    const actions = document.createElement('div');
    actions.className = 'contact-actions';
    const button = (action, label, callback, secondary = false) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.dataset.action = action;
      element.textContent = busy.get(row.id) === action ? (action === 'chat' ? '正在打开…' : '处理中…') : label;
      element.disabled = busy.has(row.id);
      if (secondary) element.className = 'secondary';
      element.addEventListener('click', callback);
      actions.append(element);
    };
    if (row.status === 'accepted') {
      if (confirmRemove === row.id) {
        button('remove', '确认移除', () => void change(row, 'remove'));
        button('cancel-remove', '取消', () => { confirmRemove = ''; render(); }, true);
      } else {
        button('chat', '聊天', () => void chat(row));
        button('confirm-remove', '移除', () => { confirmRemove = row.id; render(); }, true);
      }
    } else if (row.incoming) {
      button('accept', '接受', () => void change(row, 'accept'));
      button('decline', '拒绝', () => void change(row, 'decline'), true);
    } else {
      handle.textContent += ' · 等待确认';
      button('cancel', '撤回', () => void change(row, 'cancel'), true);
    }
    item.append(avatar, info, actions);
    return item;
  }));
  if (focusId) {
    const controls = [...list.querySelectorAll('button:not(:disabled)')]
      .filter(button => button.closest('li')?.dataset.contactId === focusId);
    const next = controls.find(button => button.dataset.action === focusAction) || controls[0]
      || tabs.find(tab => tab.dataset.section === section);
    next?.focus({preventScroll:true});
  } else if (returnFocus && loaded && !loading) {
    const row = [...list.children].find(item => item.dataset.contactId === returnFocus);
    const target = row?.querySelector('button[data-action="chat"]') || search;
    target.scrollIntoView({block:'nearest'});
    target.focus({preventScroll:true});
    returnFocus = '';
  }
}

async function load() {
  if (loading) return;
  loading = true;
  failed = false;
  if (!loaded) render();
  const started = version;
  const reading = epoch;
  try {
    const [session, data] = await Promise.all([request('/v1/auth/session'), request(root)]);
    if (reading !== epoch) return;
    const user = session.user;
    if (!user?.username || (native && data.viewer_username !== user.username)) {
      records = [];
      workspace = owner = '';
      throw new Error('联系人会话已变化。');
    }
    const nextOwner = user.id || '';
    if (!loaded || owner !== nextOwner) {
      const interactedBeforeLoad = !loaded && !owner && browsingChanged;
      owner = nextOwner;
      if (interactedBeforeLoad) rememberDirectory();
      else restoreDirectory();
    }
    byId('whoami').textContent = user.username;
    workspace = data.workspace_id || '';
    if (started === version) records = data.items || [];
    loaded = true;
  } catch {
    if (reading === epoch) failed = true;
  } finally {
    if (reading === epoch) {
      loading = false;
      render();
    }
  }
}

async function change(row, action) {
  if (busy.has(row.id)) return;
  const writing = epoch;
  busy.set(row.id, action);
  render();
  try {
    const updated = await request(root + '/' + encodeURIComponent(row.id), {action});
    if (writing !== epoch) return;
    replaceRecord(updated);
    confirmRemove = '';
    if (action === 'accept') section = 'accepted';
    rememberDirectory();
    notify({accept:'已添加联系人。',decline:'已拒绝申请。',remove:'已移除联系人。',cancel:'已撤回申请。'}[action]);
  } catch (error) {
    if (writing === epoch) {
      notify(error.message, true);
      void load();
    }
  } finally {
    if (writing === epoch) {
      busy.delete(row.id);
      render();
    }
  }
}

async function chat(row) {
  if (busy.has(row.id)) return;
  if (!/^[0-9a-f]{32}$/.test(workspace)) {
    notify('个人工作区正在准备，请稍后重试。', true);
    void load();
    return;
  }
  busy.set(row.id, 'chat');
  const opening = epoch;
  render();
  try {
    const data = await request('/v1/workspaces/' + workspace + '/social/conversations', {kind:'dm', member_ids:[row.peer.handle]});
    if (opening !== epoch) return;
    rememberDirectory(row.id);
    location.assign(conversationChatHref(workspace, {...data.conversation, source:'social'}));
  } catch (error) {
    if (opening !== epoch) return;
    notify(error.message, true);
    busy.delete(row.id);
    render();
  }
}

function clearLookup() {
  ++lookupSequence;
  located = null;
  lookupResult.hidden = true;
  lookupState.textContent = '';
  lookupButton.disabled = false;
}

function readLookup(handle) {
  return request(root + '/lookup?' + new URLSearchParams({handle}));
}

function showLookup(peer, relationship) {
  located = {peer, relationship};
  const accepted = relationship?.status === 'accepted';
  const pending = relationship?.status === 'pending';
  const received = pending && relationship.incoming;
  lookupRelationship.textContent = accepted ? '已添加' : received ? '对方已发送申请' : pending ? '等待对方确认' : '';
  lookupRelationship.hidden = !relationship;
  sendRequest.textContent = accepted ? '聊天' : received ? '接受申请' : '发送申请';
  sendRequest.hidden = pending && !received;
  byId('lookup-avatar').textContent = avatarText(peer);
  byId('lookup-name').textContent = peer.display_name || peer.handle;
  byId('lookup-handle').textContent = '@' + peer.handle;
  lookupResult.hidden = false;
}

byId('add-contact').addEventListener('click', () => {
  byId('contact-lookup-form').reset();
  clearLookup();
  dialog.showModal();
  handleField.focus();
});
byId('close-add-contact').addEventListener('click', () => dialog.close());
handleField.addEventListener('input', clearLookup);
byId('contact-lookup-form').addEventListener('submit', async event => {
  event.preventDefault();
  clearLookup();
  const sequence = lookupSequence;
  lookupButton.disabled = true;
  lookupState.textContent = '正在查找…';
  try {
    const {peer, relationship} = await readLookup(handleField.value.trim());
    if (sequence !== lookupSequence || !dialog.open) return;
    lookupState.textContent = '';
    showLookup(peer, relationship);
  } catch (error) {
    if (sequence === lookupSequence) lookupState.textContent = error.message;
  } finally {
    if (sequence === lookupSequence) lookupButton.disabled = false;
  }
});
sendRequest.addEventListener('click', async () => {
  if (!located || submitting || sendRequest.hidden) return;
  const {peer, relationship} = located;
  if (relationship?.status === 'accepted') {
    dialog.close();
    return chat({...relationship, peer});
  }
  const sequence = lookupSequence;
  const writing = epoch;
  const accepting = relationship?.status === 'pending' && relationship.incoming;
  const stillLooking = () => writing === epoch && sequence === lookupSequence && dialog.open;
  let recovered = false;
  submitting = true;
  sendRequest.disabled = true;
  try {
    const item = accepting
      ? await request(root + '/' + encodeURIComponent(relationship.id), {action:'accept'})
      : await request(root, {handle:peer.handle});
    if (writing !== epoch) return;
    replaceRecord(item);
    if (!stillLooking()) {
      render();
      return;
    }
    if (item.status === 'pending' && item.incoming) {
      showLookup(item.peer, item);
      render();
      return;
    }
    section = item.status;
    search.value = '';
    rememberDirectory();
    dialog.close();
    notify(accepting ? '已添加联系人。' : item.status === 'accepted' ? '已经是联系人。' : '已发送申请。');
    render();
  } catch (error) {
    if (!stillLooking()) return;
    lookupState.textContent = error.message;
    if (!accepting) return;
    // Approval can commit before its receipt reaches the browser. Confirm the
    // exact relationship so an already accepted request becomes a Chat action.
    const confirmed = await readLookup(peer.handle).catch(() => null);
    if (!stillLooking() || confirmed?.relationship?.status !== 'accepted' ||
        confirmed.relationship.id !== relationship.id || confirmed.peer?.handle !== peer.handle) return;
    replaceRecord({...confirmed.relationship,peer:confirmed.peer});
    showLookup(confirmed.peer, confirmed.relationship);
    lookupState.textContent = '';
    section = 'accepted';
    search.value = '';
    rememberDirectory();
    recovered = true;
    render();
  } finally {
    if (writing === epoch) {
      submitting = false;
      sendRequest.disabled = false;
      if (recovered) sendRequest.focus({preventScroll:true});
    }
  }
});
for (const tab of tabs) tab.addEventListener('click', () => {
  browsingChanged = true;
  section = tab.dataset.section;
  confirmRemove = '';
  rememberDirectory();
  render();
  if (section === 'pending') void load();
});
search.addEventListener('input', () => {
  browsingChanged = true;
  rememberDirectory();
  render();
});
retry.addEventListener('click', () => void load());
byId('logout-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await request('/v1/auth/logout', {});
    location.assign('/login');
  } catch (error) {
    notify(error.message, true);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void load();
});
window.addEventListener('pagehide', () => {
  ++epoch;
  loaded = loading = failed = false;
  browsingChanged = false;
  workspace = owner = confirmRemove = returnFocus = '';
  records = [];
  busy.clear();
  section = 'accepted';
  search.value = '';
  byId('whoami').textContent = '';
  notify('');
  clearLookup();
  if (dialog.open) dialog.close();
  submitting = false;
  sendRequest.disabled = false;
  render();
});
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
void load();
