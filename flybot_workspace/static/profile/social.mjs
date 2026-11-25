const SOCIAL = '/v1/profile/social';
const FOLLOW_WORK = '/v1/profile/follow-work';
export const FOLLOW_WORK_EMPTY = '还没有关注任何人。先在发现页关注作者，再回来打开作品通知。';

export function followWorkNotice(enabled) {
  return enabled ? '已打开作品通知。' : '已关闭作品通知。';
}

export function followWorkSwitchLabel(name) {
  return name ? name + ' 的作品通知' : '这个账号的作品通知';
}

const FEEDS = {
  published: {id: 'tab-posts', empty: '还没有公开作品。', href: '/space', label: '前往资料空间'},
  collected: {id: 'tab-saved', empty: '还没有收藏，遇到喜欢的作品可以先收录。', href: '/discover', label: '探索作品',
    action: 'collect', remove: '取消收藏'},
  liked: {id: 'tab-liked', empty: '还没有点赞，给喜欢的作品点个赞吧。', href: '/discover', label: '探索作品',
    action: 'like', remove: '取消点赞'},
};
const CONNECTIONS = {
  following: {id: 'dialog-tab-following', label: '关注', empty: '你还没有关注任何人。'},
  followers: {id: 'dialog-tab-followers', label: '粉丝', empty: '还没有人关注你。'},
};
const WORK_KINDS = {
  document: '文档', image: '图片', website: '网页', slides: '幻灯片', audio: '音频',
  video: '视频', model3d: '3D 作品', whiteboard: '白板', dashboard: '看板', media: '媒体',
};
const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const CREATOR = /^[a-z0-9][a-z0-9._-]{1,79}$/i;
const LISTING_ID = /^otl_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const SEARCH_DELAY = 200;

function workHref(item) {
  if (!SLUG.test(item.slug || '')) return '';
  if (item.kind === 'work') return '/discover?work=' + item.slug;
  if (item.kind !== 'agent') return '';
  const path = '/a/' + item.slug;
  return item.path === '/social' + path ? item.path : path;
}

function profileCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Activate tabs with arrow keys while keeping a single tab in the Tab order.
function selectTab(byId, choices, view, panel) {
  for (const [key, {id}] of Object.entries(choices)) {
    const tab = byId(id);
    tab.setAttribute('aria-selected', String(key === view));
    tab.tabIndex = key === view ? 0 : -1;
  }
  panel.setAttribute('aria-labelledby', choices[view].id);
}

function bindTabs(byId, choices, activate) {
  const views = Object.keys(choices);
  for (const [index, view] of views.entries()) {
    const tab = byId(choices[view].id);
    tab.addEventListener('click', () => activate(view));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % views.length;
      if (event.key === 'ArrowLeft') next = (index + views.length - 1) % views.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = views.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      byId(choices[views[next]].id).focus();
      activate(views[next]);
    });
  }
}

export function listPager({document, list, status, more, retry, discover, endpoint = SOCIAL, request, render, empty}) {
  let controller;
  let view = '';
  let query = '';
  let cursor = '';
  let appendFailure = false;

  function reset() {
    controller?.abort();
    controller = null;
    cursor = '';
    list.replaceChildren();
    list.hidden = true;
    list.removeAttribute('aria-busy');
    status.textContent = '';
    more.hidden = true;
    retry.hidden = true;
    if (discover) discover.hidden = true;
  }

  function showEmpty() {
    status.textContent = empty(view, query);
    if (discover) {
      discover.href = FEEDS[view].href;
      discover.textContent = FEEDS[view].label;
      discover.hidden = false;
    }
  }

  async function load(append = false) {
    if (append && (!cursor || controller)) return;
    if (!append) reset();
    const params = new URLSearchParams({limit: '12'});
    if (view) params.set('view', view);
    if (query) params.set('q', query);
    if (append) params.set('cursor', cursor);
    const pending = new AbortController();
    controller = pending;
    const focused = document.activeElement;
    list.setAttribute('aria-busy', 'true');
    status.textContent = '正在加载…';
    more.disabled = true;
    retry.hidden = true;
    retry.disabled = true;
    try {
      const result = await request('GET', endpoint + '?' + params, undefined, {signal: pending.signal});
      if (pending.signal.aborted) return;
      if (result.status !== 200 || !Array.isArray(result.body.items)) throw new Error();
      const rows = result.body.items.map(render).filter(Boolean);
      list.append(...rows);
      list.hidden = list.childElementCount === 0;
      if (list.hidden) showEmpty();
      else status.textContent = '';
      const next = result.body.next_cursor;
      cursor = typeof next === 'string' && next !== cursor ? next : '';
      more.hidden = !cursor;
      if (document.activeElement === focused && (focused === retry || (focused === more && more.hidden))) {
        (rows[0]?.querySelector('a,button') || list.parentElement)?.focus?.();
      }
    } catch {
      if (pending.signal.aborted) return;
      status.textContent = '暂时无法加载，请重试。';
      appendFailure = append;
      retry.hidden = false;
      if (focused === more && document.activeElement === more) retry.focus?.();
      more.hidden = true;
    } finally {
      if (!pending.signal.aborted) {
        controller = null;
        list.removeAttribute('aria-busy');
        more.disabled = false;
        retry.disabled = false;
      }
    }
  }

  more.addEventListener('click', () => load(true));
  retry.addEventListener('click', () => load(appendFailure));
  return {
    reset,
    select(nextView, nextQuery = '') {
      view = nextView;
      query = nextQuery;
      return load();
    },
    remove(row) {
      row.remove();
      if (!list.childElementCount && !cursor && !controller) {
        list.hidden = true;
        showEmpty();
      }
    },
  };
}

export function mountProfileSocial({document, request, avatarTone, monogram}) {
  const byId = id => document.getElementById(id);
  const feedPanel = byId('profile-feed');
  const feedList = byId('profile-feed-list');
  const feedActionStatus = byId('profile-feed-action-status');
  const dialog = byId('followers-dialog');
  const noticesDialog = byId('follow-work-dialog');
  const noticesStatus = byId('follow-work-status');
  const noticesSearch = byId('follow-work-search');
  const connectionPanel = byId('followers-dialog-panel');
  const search = byId('followers-search');
  const actionStatus = byId('followers-action-status');
  const countFields = {
    following: byId('stat-following-count'),
    followers: byId('stat-followers-count'),
    received: byId('stat-likes-count'),
  };
  let activeFeed = 'published';
  let activeConnection = 'followers';
  let owner = '';
  let countRequest;
  let initiatingControl;
  const changing = new Map();
  const removing = new Map();
  const removed = new Set();
  const changingNotices = new Map();
  const noticeReads = new Set();

  function element(tag, css, text) {
    const node = document.createElement(tag);
    if (css) node.className = css;
    if (text) node.textContent = text;
    return node;
  }

  function renderWork(item) {
    if (!item?.title) return null;
    const view = activeFeed;
    const settings = FEEDS[view];
    const key = view + '/' + item.id;
    if (removed.has(key)) return null;
    const row = element('li', 'profile-work-item');
    const href = workHref(item);
    const card = element(href ? 'a' : 'div', 'profile-work-card');
    if (href) card.href = href;
    const kind = item.kind === 'agent' ? '智能体' : WORK_KINDS[item.work_kind] || '作品';
    card.append(
      element('span', 'profile-work-kind', kind),
      element('strong', 'profile-work-title', item.title),
    );
    if (item.summary) card.append(element('span', 'profile-work-summary', item.summary));
    const author = item.creator?.display_name || item.creator?.handle;
    if (author) card.append(element('span', 'profile-work-author', author));
    row.append(card);
    if (settings.action && typeof item.id === 'string' && LISTING_ID.test(item.id) && item[view] === true) {
      row.dataset.listingId = item.id;
      const button = element('button', 'profile-work-action', settings.remove);
      button.type = 'button';
      button.setAttribute('aria-label', settings.remove + ' ' + item.title);
      button.disabled = removing.get(key) === owner;
      button.addEventListener('click', () => removeReaction(view, item, key));
      row.append(button);
    }
    return row;
  }

  async function removeReaction(view, item, key) {
    const account = owner;
    if (!account || view !== activeFeed || removing.get(key) === account) return;
    const {action, remove} = FEEDS[view];
    const row = () => Array.from(feedList.children).find(entry => entry.dataset.listingId === item.id);
    const button = () => row()?.querySelector('button');
    const control = button();
    if (!control) return;
    const hadFocus = document.activeElement === control;
    removing.set(key, account);
    control.disabled = true;
    feedActionStatus.textContent = '';
    try {
      const result = await request('POST', SOCIAL, {listing_id: item.id, action});
      if (owner !== account) return;
      if (result.status !== 200 || result.body[view] !== false) throw new Error();
      removed.add(key);
      if (activeFeed === view) {
        const itemRow = row();
        if (itemRow) {
          const focus = document.activeElement;
          const focused = focus && itemRow.contains(focus) || hadFocus && focus === document.body;
          const next = itemRow.nextElementSibling || itemRow.previousElementSibling;
          feed.remove(itemRow);
          if (focused) {
            const more = byId('profile-feed-more');
            (next?.querySelector('a,button') || (more.hidden ? feedPanel : more)).focus();
          }
        }
        feedActionStatus.textContent = '已' + remove + '。';
      }
      void refreshCounts();
    } catch {
      if (owner === account && activeFeed === view) feedActionStatus.textContent = '无法' + remove + '，请重试。';
    } finally {
      if (removing.get(key) === account) removing.delete(key);
      if (owner === account && activeFeed === view) {
        const current = button();
        if (current) {
          current.disabled = false;
          if (hadFocus && document.activeElement === document.body) current.focus();
        }
      }
    }
  }

  async function refreshCounts() {
    countRequest?.abort();
    const pending = new AbortController();
    countRequest = pending;
    try {
      const result = await request('GET', SOCIAL + '?view=counts', undefined, {signal: pending.signal});
      if (result.status !== 200 || pending.signal.aborted) return;
      const {following, followers, likes_received: likes, collections_received: collections} = result.body;
      const received = profileCount(likes) !== null && profileCount(collections) !== null ? likes + collections : null;
      for (const [key, value] of Object.entries({following, followers, received})) {
        const count = profileCount(value);
        countFields[key].textContent = count === null ? '—' : String(count);
        if (key !== 'received') byId(CONNECTIONS[key].id).textContent = formattedConnection(key, count);
      }
    } catch { /* Keep the last verified counts if refreshing fails. */ }
  }

  function formattedConnection(view, count) {
    const label = CONNECTIONS[view].label;
    return count === null ? label : label + ' ' + count;
  }

  function paintFollow(button, name, following) {
    const label = following ? '取消关注' : '关注';
    button.textContent = label;
    button.setAttribute('aria-label', label + ' ' + name);
    button.setAttribute('aria-pressed', String(following));
  }

  function renderConnection(item) {
    if (!item?.handle || !CREATOR.test(item.handle)) return null;
    const name = item.display_name || item.handle;
    const row = element('li', 'profile-connection-row');
    row.dataset.handle = item.handle;
    const person = element('a', 'profile-connection-person');
    person.href = '/discover?' + new URLSearchParams({creator: item.handle});
    person.title = '查看 ' + name + ' 的公开作品';
    const avatar = element('span', 'profile-connection-avatar avatar', monogram(name));
    avatar.dataset.tone = avatarTone(name);
    avatar.setAttribute('aria-hidden', 'true');
    const copy = element('span', 'profile-connection-copy');
    copy.append(
      element('strong', 'profile-connection-name', name),
      element('span', 'profile-connection-handle', '@' + item.handle),
    );
    person.append(avatar, copy);
    const follow = element('button', 'profile-follow-button');
    follow.type = 'button';
    paintFollow(follow, name, item.following === true);
    follow.addEventListener('click', () => changeFollow(item.handle, name, follow));
    row.append(person, follow);
    return row;
  }

  async function changeFollow(handle, name, button) {
    const account = owner;
    if (changing.get(handle) === account) return;
    const on = button.getAttribute('aria-pressed') !== 'true';
    changing.set(handle, account);
    button.disabled = true;
    actionStatus.textContent = '';
    try {
      const result = await request('POST', SOCIAL, {handle, on});
      if (owner !== account) return;
      if (result.status !== 200 || typeof result.body.following !== 'boolean') throw new Error();
      const following = result.body.following;
      for (const row of byId('followers-dialog-list').children) {
        if (row.dataset.handle !== handle) continue;
        const target = row.querySelector('button');
        if (activeConnection === 'following' && !following) {
          if (document.activeElement === target) byId(CONNECTIONS.following.id).focus();
          connections.remove(row);
        } else paintFollow(target, name, following);
        break;
      }
      if (dialog.open) actionStatus.textContent = following ? '已关注 ' + name : '已取消关注 ' + name;
      void refreshCounts();
    } catch {
      if (owner === account && dialog.open) actionStatus.textContent = '无法更新关注，请重试。';
    } finally {
      if (changing.get(handle) === account) changing.delete(handle);
      button.disabled = false;
    }
  }

  function renderNotice(item) {
    if (!item?.handle || !CREATOR.test(item.handle)) return null;
    const name = item.display_name || item.handle;
    const row = element('li', 'follow-work-row');
    const label = element('label', 'follow-work-label');
    const copy = element('span', 'follow-work-copy');
    copy.append(element('strong', '', name), element('span', 'follow-work-handle', '@' + item.handle));
    const input = element('input');
    input.type = 'checkbox';
    const pending = changingNotices.get(item.handle);
    input.checked = pending?.account === owner ? pending.enabled : item.enabled === true;
    input.disabled = pending?.account === owner;
    input.setAttribute('aria-label', followWorkSwitchLabel(name));
    input.addEventListener('change', async () => {
      if (input.disabled || !owner) return;
      const account = owner;
      const next = input.checked;
      const change = {account, enabled: next};
      changingNotices.set(item.handle, change);
      input.disabled = true;
      noticesStatus.textContent = '';
      let verified = !next;
      let feedback = '无法更新作品通知，请重试。';
      try {
        const result = await request('POST', FOLLOW_WORK, {handle: item.handle, enabled: next});
        if (result.status === 200 && typeof result.body.enabled === 'boolean') {
          verified = result.body.enabled;
          feedback = followWorkNotice(verified);
          for (const read of noticeReads) {
            if (read.account === account) read.changes.set(item.handle, verified);
          }
        }
      } catch { /* Roll back an unconfirmed preference. */ }
      finally {
        if (changingNotices.get(item.handle) === change) changingNotices.delete(item.handle);
        if (owner === account && noticesDialog.open) {
          const row = Array.from(byId('follow-work-list').children).find(entry => entry.dataset.handle === item.handle);
          const current = row?.querySelector('input') || input;
          current.checked = verified;
          current.disabled = false;
          noticesStatus.textContent = feedback;
        }
      }
    });
    label.append(copy, input);
    row.dataset.handle = item.handle;
    row.append(label);
    return row;
  }

  const feed = listPager({
    document, list: byId('profile-feed-list'), status: byId('profile-feed-empty'),
    more: byId('profile-feed-more'), retry: byId('profile-feed-retry'),
    discover: byId('profile-feed-explore'), request, render: renderWork,
    empty: view => FEEDS[view].empty,
  });
  const connections = listPager({
    document, list: byId('followers-dialog-list'), status: byId('followers-dialog-empty'),
    more: byId('followers-dialog-more'), retry: byId('followers-dialog-retry'),
    request, render: renderConnection,
    empty: (view, query) => query ? '没有匹配的人。' : CONNECTIONS[view].empty,
  });
  async function readNotices(method, path, body, options) {
    const read = {account: owner, changes: new Map()};
    noticeReads.add(read);
    try {
      const result = await request(method, path, body, options);
      if (!read.changes.size || !Array.isArray(result.body.items)) return result;
      const items = result.body.items.map(item => read.changes.has(item.handle)
        ? {...item, enabled: read.changes.get(item.handle)} : item);
      return {...result, body: {...result.body, items}};
    } finally {
      noticeReads.delete(read);
    }
  }

  const notices = listPager({
    document, list: byId('follow-work-list'), status: byId('follow-work-empty'),
    more: byId('follow-work-more'), retry: byId('follow-work-retry'),
    endpoint: FOLLOW_WORK, request: readNotices, render: renderNotice,
    empty: (_view, query) => query ? '没有匹配的作者。' : FOLLOW_WORK_EMPTY,
  });

  function setFeed(view) {
    activeFeed = view;
    removed.clear();
    feedActionStatus.textContent = '';
    selectTab(byId, FEEDS, activeFeed, feedPanel);
    if (owner) return feed.select(view);
  }

  function setConnection(view) {
    activeConnection = view;
    cancelConnectionSearch();
    selectTab(byId, CONNECTIONS, view, connectionPanel);
    actionStatus.textContent = '';
    search.value = '';
    search.placeholder = '搜索' + CONNECTIONS[view].label;
    void connections.select(view);
  }

  function openConnections(view, trigger) {
    if (!owner) return;
    initiatingControl = trigger;
    setConnection(view);
    if (!dialog.open) dialog.showModal();
  }

  bindTabs(byId, FEEDS, setFeed);
  bindTabs(byId, CONNECTIONS, setConnection);
  for (const view of Object.keys(CONNECTIONS)) {
    const trigger = byId('stat-' + view);
    trigger.addEventListener('click', () => openConnections(view, trigger));
  }
  byId('followers-dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    connections.reset();
    cancelConnectionSearch();
    initiatingControl?.focus?.();
    initiatingControl = null;
  });
  function bindSearch(input, pager, selectedView) {
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      pager.reset();
      const query = input.value.trim().replace(/^@/, '');
      if (!query) void pager.select(selectedView());
      else timer = setTimeout(() => pager.select(selectedView(), query), SEARCH_DELAY);
    });
    return () => clearTimeout(timer);
  }

  const cancelConnectionSearch = bindSearch(search, connections, () => activeConnection);
  const cancelNoticesSearch = bindSearch(noticesSearch, notices, () => '');
  byId('profile-notify-open').addEventListener('click', () => {
    if (!owner || noticesDialog.open) return;
    noticesStatus.textContent = '';
    noticesSearch.value = '';
    noticesDialog.showModal();
    void notices.select('');
  });
  byId('follow-work-dialog-close').addEventListener('click', () => noticesDialog.close());
  noticesDialog.addEventListener('click', event => {
    if (event.target === noticesDialog) noticesDialog.close();
  });
  noticesDialog.addEventListener('close', () => {
    if (noticesDialog.open) return;
    cancelNoticesSearch();
    notices.reset();
  });

  return {
    load(account) {
      owner = account;
      void setFeed(activeFeed);
      void refreshCounts();
    },
    reset() {
      owner = '';
      countRequest?.abort();
      if (dialog.open) dialog.close();
      if (noticesDialog.open) noticesDialog.close();
      feed.reset();
      connections.reset();
      notices.reset();
      for (const field of Object.values(countFields)) field.textContent = '—';
      for (const [view, {id}] of Object.entries(CONNECTIONS)) byId(id).textContent = formattedConnection(view, null);
      cancelConnectionSearch();
      cancelNoticesSearch();
      removing.clear();
      removed.clear();
      changingNotices.clear();
      feedActionStatus.textContent = '';
      activeFeed = 'published';
    },
  };
}
