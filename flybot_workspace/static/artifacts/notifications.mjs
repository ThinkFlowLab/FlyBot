import {workNotificationSummary, workNotificationTarget} from '../shell/work-notification.mjs';

const HEX_ID = /^[0-9a-f]{32}$/;
const PUBLIC_WORK = /^\/w\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])$/;
const REFRESH_MS = 30_000;
const REQUEST_DEADLINE_MS = 8_000;
const READ_NAVIGATION_MS = 350;
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

export function artifactNoticeTarget(item, workspace) {
  const target = workNotificationTarget(item, workspace);
  const published = PUBLIC_WORK.exec(target || '');
  return published ? '/discover?' + new URLSearchParams({work: published[1]}) : target;
}

function unreadCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function mountArtifactNotifications(document, {request}) {
  const trigger = document.getElementById('artifact-notify');
  const dialog = document.getElementById('artifact-notifications');
  const view = document.defaultView;
  if (!trigger || !view || typeof dialog?.showModal !== 'function') return {setWorkspace() {}};
  const badge = document.getElementById('artifact-notify-count');
  const list = document.getElementById('artifact-notifications-list');
  const close = document.getElementById('artifact-notifications-close');
  const all = document.getElementById('artifact-notifications-read-all');
  const status = document.getElementById('artifact-notifications-status');
  const retry = document.getElementById('artifact-notifications-retry');
  const empty = document.getElementById('artifact-notifications-empty');
  let scope = null;
  let items = [];
  let unread = 0;
  let timer;
  let reading;
  let writing;

  function show(message = '', canRetry = false) {
    status.textContent = message;
    status.hidden = !message;
    retry.hidden = !canRetry;
    empty.hidden = Boolean(items.length || message);
  }

  function renderCount() {
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    trigger.setAttribute('aria-label', unread ? `作品通知（${unread} 条未读）` : '作品通知');
    all.disabled = unread === 0 || Boolean(writing);
  }

  function notificationLink(item) {
    const li = document.createElement('li');
    const target = artifactNoticeTarget(item, scope?.workspace);
    li.dataset.unread = String(item.read === false);
    const label = document.createElement(target ? 'a' : 'div');
    label.className = 'artifact-notification-row';
    if (target) {
      label.href = target;
      label.dataset.notificationId = item.id;
      if (item.read === false) {
        label.addEventListener('click', (event) => openUnread(event, item.id, target));
      }
    }
    const title = document.createElement('strong');
    title.textContent = item.title || '作品';
    const meta = document.createElement('span');
    meta.textContent = workNotificationSummary({...item, title: undefined});
    label.append(title, meta);
    if (item.read === false) {
      const unreadLabel = document.createElement('span');
      unreadLabel.className = 'visually-hidden';
      unreadLabel.textContent = '未读';
      label.append(unreadLabel);
    }
    const when = new Date(Number(item.created) * 1000);
    if (when.getTime() > 0 && Number.isFinite(when.getTime())) {
      const time = document.createElement('time');
      time.dateTime = when.toISOString();
      time.textContent = timeFormat.format(when);
      label.append(time);
    }
    li.append(label);
    return li;
  }

  function renderList(next) {
    if (JSON.stringify(next) === JSON.stringify(items)) return;
    const focused = document.activeElement?.dataset?.notificationId;
    const rows = next.map(notificationLink);
    list.replaceChildren(...rows);
    items = next;
    empty.hidden = Boolean(items.length || !status.hidden);
    if (focused && dialog.open) {
      const previous = rows.find(row => row.firstElementChild?.dataset.notificationId === focused);
      (previous?.firstElementChild || close).focus({preventScroll: true});
    }
  }

  function stopTimer() {
    if (timer !== undefined) view.clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    stopTimer();
    if (scope && document.visibilityState !== 'hidden') {
      timer = view.setTimeout(() => void refresh(), REFRESH_MS);
    }
  }

  async function refresh({interactive = false} = {}) {
    if (!scope || writing || document.visibilityState === 'hidden') return;
    if (reading && !interactive) return;
    reading?.abort();
    stopTimer();
    const current = scope;
    const controller = new AbortController();
    reading = controller;
    const loadList = dialog.open;
    if (loadList && interactive) show('正在读取作品通知…');
    try {
      const limit = loadList ? 60 : 1;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_DEADLINE_MS)]);
      const response = await request('GET', current.path + '?kind=work&limit=' + limit, undefined, {signal});
      if (scope !== current || controller.signal.aborted) return;
      if (response.status !== 200) throw new Error('Work notifications unavailable');
      unread = unreadCount(response.body?.unread_count);
      renderCount();
      if (loadList && dialog.open) {
        renderList((response.body?.items || []).filter(item =>
          typeof item?.id === 'string' && item.id && workNotificationSummary(item)));
        show();
      }
    } catch {
      if (scope === current && !controller.signal.aborted && loadList && dialog.open) {
        show('暂时无法读取作品通知。', true);
      }
    } finally {
      if (reading === controller) {
        reading = null;
        schedule();
      }
    }
  }

  async function markRead(data, {keepalive = false} = {}) {
    const current = scope;
    if (!current || writing) return;
    const write = {};
    writing = write;
    reading?.abort();
    reading = null;
    stopTimer();
    renderCount();
    try {
      const signal = AbortSignal.timeout(REQUEST_DEADLINE_MS);
      const result = await request('POST', current.path + '/read', {...data, kind: 'work'}, {keepalive, signal});
      if (scope !== current) return;
      if (result.status !== 200) throw new Error('Could not mark work notifications');
      unread = unreadCount(result.body?.unread_count);
      renderList(items.map(item => data.all || item.id === data.notification_id ? {...item, read: true} : item));
      show(data.all ? '已将作品通知标为已读。' : '');
    } catch {
      if (scope === current && dialog.open) show('暂时无法标为已读，请重试。');
    } finally {
      if (writing === write) {
        writing = null;
        renderCount();
        schedule();
      }
    }
  }

  async function openUnread(event, id, target) {
    if (event.defaultPrevented || event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    if (writing) return;
    const current = scope;
    let deadline;
    try {
      const advance = new Promise(resolve => { deadline = view.setTimeout(resolve, READ_NAVIGATION_MS); });
      await Promise.race([markRead({notification_id: id}, {keepalive: true}), advance]);
      if (scope === current && dialog.open) view.location.assign(target);
    } finally {
      view.clearTimeout(deadline);
    }
  }

  trigger.addEventListener('click', () => {
    if (!scope || dialog.open) return;
    dialog.showModal();
    show();
    void refresh({interactive: true});
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (!dialog.open && !trigger.disabled) trigger.focus();
  });
  retry.addEventListener('click', () => {
    close.focus();
    void refresh({interactive: true});
  });
  all.addEventListener('click', () => {
    close.focus();
    void markRead({all: true});
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopTimer();
      reading?.abort();
      reading = null;
    } else void refresh();
  });
  view.addEventListener('pageshow', event => { if (event.persisted) void refresh(); });

  return {
    setWorkspace(workspace) {
      if ((scope?.workspace || '') === workspace) return;
      stopTimer();
      reading?.abort();
      reading = null;
      writing = null;
      scope = HEX_ID.test(workspace) ? {workspace, path: `/v1/workspaces/${workspace}/notifications`} : null;
      trigger.disabled = !scope;
      if (dialog.open) dialog.close();
      renderList([]);
      unread = 0;
      renderCount();
      show();
      if (scope) void refresh();
    },
  };
}
