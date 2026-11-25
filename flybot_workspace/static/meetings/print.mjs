function renderMinutes(document, {meeting, shared}, formatTime) {
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const paper = node('div', '', 'meeting-minutes-paper');
  const header = node('div', '', 'meeting-minutes-header');
  const metadata = [formatTime(meeting.started_at), '版本 ' + meeting.revision,
    shared && meeting.organizer && '组织者 ' + meeting.organizer].filter(Boolean).join(' · ');
  header.append(node('p', shared ? '共享纪要' : '会议纪要', 'meeting-minutes-kicker'),
    node('h2', meeting.title), node('p', metadata, 'meeting-minutes-meta'));
  const summary = node('section');
  summary.append(node('h3', '摘要'), node('p', meeting.summary || '没有摘要。', 'meeting-minutes-text'));
  const actions = node('section');
  actions.append(node('h3', '行动项'));
  if (meeting.action_items?.length) {
    const list = node('ol');
    for (const item of meeting.action_items) {
      const row = node('li');
      const details = [item.done ? '已完成' : '待完成', item.owner && '负责人 ' + item.owner];
      const meta = node('p', details.filter(Boolean).join(' · '), 'meeting-minutes-meta');
      if (item.due_date) {
        const date = node('time', ' · 截止日期 ' + item.due_date);
        date.dateTime = item.due_date;
        meta.append(date);
      }
      row.append(node('p', item.text, 'meeting-minutes-text'), meta);
      list.append(row);
    }
    actions.append(list);
  } else actions.append(node('p', '没有行动项。'));
  paper.append(header, summary, actions);
  return paper;
}

export function mountMeetingPrint(document, {context, formatTime}) {
  const owned = document.getElementById('print-meeting');
  const shared = document.getElementById('print-shared-meeting');
  const dialog = document.getElementById('meeting-print-dialog');
  const preview = document.getElementById('meeting-print-preview');
  const paper = document.getElementById('meeting-print-paper');
  const print = document.getElementById('meeting-print-confirm');
  const cancel = document.getElementById('meeting-print-close');
  if (!owned || !shared || !dialog || !preview || !paper || !print || !cancel) return {sync() {}, close() {}};
  let selection;

  function clear() {
    if (!selection) return;
    document.title = selection.previousTitle;
    selection = undefined;
    document.body.removeAttribute('data-meeting-print');
    preview.replaceChildren();
    paper.replaceChildren();
  }

  function close() {
    if (dialog.open) dialog.close();
    clear();
  }

  function sync(pending = false) {
    const entry = context();
    owned.hidden = !entry || entry.shared;
    owned.disabled = pending;
    shared.hidden = !entry?.shared;
    if (selection && (!entry || entry.owner !== selection.owner || entry.workspace !== selection.workspace ||
        entry.meeting !== selection.meeting || entry.meeting.revision !== selection.revision)) close();
  }

  function open(trigger) {
    const entry = context();
    if (!entry || trigger.hidden || trigger.disabled || dialog.open) return;
    selection = {...entry, trigger, revision:entry.meeting.revision, previousTitle:document.title};
    const content = renderMinutes(document, entry, formatTime);
    preview.replaceChildren(content);
    paper.replaceChildren(content.cloneNode(true));
    document.title = entry.meeting.title;
    document.body.setAttribute('data-meeting-print', '');
    dialog.showModal();
    dialog.scrollTop = 0;
  }

  owned.addEventListener('click', () => open(owned));
  shared.addEventListener('click', () => open(shared));
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const trigger = selection?.trigger;
    clear();
    if (trigger && !trigger.hidden) trigger.focus({preventScroll:true});
  });
  print.addEventListener('click', () => {
    sync();
    if (selection && dialog.open) document.defaultView.print();
  });
  return {sync, close};
}
