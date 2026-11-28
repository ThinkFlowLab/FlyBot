import {conversationChatHref} from '../shell/thumb.mjs';
import {servedByDsBot} from '../shell/dsbot-api.mjs';

export function mountContactsDirectory(document, {
  hostDialog,
  currentOwner,
  openChat,
  onChange = () => {},
  label = zh => zh,
  fetcher = (...args) => globalThis.fetch(...args),
} = {}) {
  const view = document.defaultView || globalThis;
  const byId = id => document.getElementById(id);
  const root = '/v1/contacts';
  const list = byId('contacts-list');
  const state = byId('contacts-state');
  const retry = byId('reload-contacts');
  const search = byId('contact-search');
  const tabs = [...(hostDialog ?? document).querySelectorAll('.contacts-tabs [data-section]')];
  const dialog = byId('add-contact-dialog');
  const handleField = byId('contact-handle');
  const lookupState = byId('lookup-state');
  const lookupResult = byId('lookup-result');
  const lookupButton = byId('lookup-contact');
  const sendRequest = byId('request-contact');
  const lookupRelationship = byId('lookup-relationship');
  const native = servedByDsBot(document);
  const status = byId(hostDialog ? 'chat-contacts-status' : 'status');
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
    const response = await fetcher(path, {method, headers, credentials: 'same-origin', body: JSON.stringify(body)});
    if (response.status === 401) {
      if (scope === epoch) view.location.assign('/login');
      throw new Error(label('请先登录。', 'Sign in to continue.'));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = response.status === 404 && path.startsWith(root + '/lookup')
        ? label('没有找到这个用户名。', 'No account found with that username.') : data.error?.message;
      throw new Error(message || label('暂时无法完成操作，请重试。', 'Could not finish. Try again.'));
    }
    return data;
  }

  function notify(message, error = false) {
    status.dataset.kind = error ? 'error' : 'ok';
    status.textContent = message;
  }

  function replaceRecord(item) {
    ++version;
    records = records.filter(row => row.id !== item.id);
    if (item.status === 'accepted' || item.status === 'pending') records.unshift(item);
  }

  function rememberDirectory(contact = '') {
    if (hostDialog || !ownerPattern.test(owner)) return;
    try {
      view.history.replaceState({...view.history.state, contactsDirectory: {
        owner, section, query:search.value.slice(0, 80), contact,
      }}, '');
    } catch {}
  }

  function restoreDirectory() {
    if (hostDialog) return;
    const saved = view.history.state?.contactsDirectory;
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
    state.textContent = !loaded && loading ? label('正在加载联系人…', 'Loading contacts…')
      : failed ? label('联系人加载失败。', 'Could not load contacts.')
        : visible.length ? '' : query ? label('没有匹配的联系人。', 'No matching contacts.')
          : section === 'pending' ? label('暂无联系人申请。', 'No contact requests.') : label('暂无联系人。', 'No contacts yet.');

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
      const button = (action, title, callback, secondary = false) => {
        const element = document.createElement('button');
        element.type = 'button';
        element.dataset.action = action;
        element.textContent = busy.get(row.id) === action ? (action === 'chat' ? label('正在打开…', 'Opening…') : label('处理中…', 'Working…')) : title;
        element.disabled = busy.has(row.id);
        if (secondary) element.className = 'secondary';
        element.addEventListener('click', callback);
        actions.append(element);
      };
      if (row.status === 'accepted') {
        if (confirmRemove === row.id) {
          button('remove', label('确认移除', 'Confirm removal'), () => void change(row, 'remove'));
          button('cancel-remove', label('取消', 'Cancel'), () => { confirmRemove = ''; render(); }, true);
        } else {
          button('chat', label('聊天', 'Chat'), () => void chat(row));
          button('confirm-remove', label('移除', 'Remove'), () => { confirmRemove = row.id; render(); }, true);
        }
      } else if (row.incoming) {
        button('accept', label('接受', 'Accept'), () => void change(row, 'accept'));
        button('decline', label('拒绝', 'Decline'), () => void change(row, 'decline'), true);
      } else {
        handle.textContent += label(' · 等待确认', ' · Awaiting confirmation');
        button('cancel', label('撤回', 'Cancel request'), () => void change(row, 'cancel'), true);
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
    if (loading || (hostDialog && !hostDialog.open)) return;
    loading = true;
    failed = false;
    if (!loaded) render();
    const started = version;
    const reading = epoch;
    try {
      const [session, data] = await Promise.all([request('/v1/auth/session'), request(root)]);
      if (reading !== epoch) return;
      const user = session.user;
      if (!user?.username || (currentOwner && user.id !== currentOwner()) ||
          (native && data.viewer_username !== user.username)) {
        records = [];
        workspace = owner = '';
        throw new Error(label('联系人会话已变化。', 'Your account changed. Reopen Contacts.'));
      }
      const nextOwner = user.id || '';
      if (!loaded || owner !== nextOwner) {
        const interactedBeforeLoad = !loaded && !owner && browsingChanged;
        owner = nextOwner;
        if (interactedBeforeLoad) rememberDirectory();
        else restoreDirectory();
      }
      if (!hostDialog) byId('whoami').textContent = user.username;
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
      onChange();
      confirmRemove = '';
      if (action === 'accept') section = 'accepted';
      rememberDirectory();
      notify({accept:label('已添加联系人。', 'Contact added.'),decline:label('已拒绝申请。', 'Request declined.'),remove:label('已移除联系人。', 'Contact removed.'),cancel:label('已撤回申请。', 'Request cancelled.')}[action]);
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
      notify(label('个人工作区正在准备，请稍后重试。', 'Your personal workspace is getting ready. Try again shortly.'), true);
      void load();
      return;
    }
    busy.set(row.id, 'chat');
    const opening = epoch;
    const targetWorkspace = workspace;
    render();
    try {
      const {conversation} = await request('/v1/workspaces/' + targetWorkspace + '/social/conversations', {kind:'dm', member_ids:[row.peer.handle]});
      if (opening !== epoch || (hostDialog && !hostDialog.open)) return;
      if (typeof conversation?.id !== 'string' || !conversation.id) throw new Error(label('会话暂时无法打开。', 'This chat could not be opened.'));
      rememberDirectory(row.id);
      const href = conversationChatHref(targetWorkspace, {...conversation, source:'social'});
      if (hostDialog) hostDialog.close();
      if (openChat) openChat(href, targetWorkspace, conversation);
      else view.location.assign(href);
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
    lookupRelationship.textContent = accepted ? label('已添加', 'Added') : received ? label('对方已发送申请', 'They sent you a request') : pending ? label('等待对方确认', 'Awaiting confirmation') : '';
    lookupRelationship.hidden = !relationship;
    sendRequest.textContent = accepted ? label('聊天', 'Chat') : received ? label('接受申请', 'Accept request') : label('发送申请', 'Send request');
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
    lookupState.textContent = label('正在查找…', 'Searching…');
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
      onChange();
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
      notify(accepting ? label('已添加联系人。', 'Contact added.') : item.status === 'accepted' ? label('已经是联系人。', 'Already a contact.') : label('已发送申请。', 'Request sent.'));
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
      onChange();
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
  if (!hostDialog) byId('logout-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await request('/v1/auth/logout', {});
      view.location.assign('/login');
    } catch (error) {
      notify(error.message, true);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void load();
  });
  function reset() {
    ++epoch;
    loaded = loading = failed = false;
    browsingChanged = false;
    workspace = owner = confirmRemove = returnFocus = '';
    records = [];
    busy.clear();
    section = 'accepted';
    search.value = '';
    if (!hostDialog) byId('whoami').textContent = '';
    notify('');
    clearLookup();
    if (dialog.open) dialog.close();
    submitting = false;
    sendRequest.disabled = false;
    render();
  }
  view.addEventListener('pagehide', reset);
  view.addEventListener('pageshow', event => { if (event.persisted) void load(); });
  hostDialog?.addEventListener('close', () => { if (!hostDialog.open) reset(); });
  void load();
  return {load};
}
