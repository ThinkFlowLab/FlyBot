const WORKSPACE_ID = /^[0-9a-f]{32}$/;
const TASK_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const STATUS = {scheduled:'待运行',overdue:'已到运行时间',paused:'已暂停',finished:'已完成'};
const FREQUENCY = {once:'单次',daily:'每天',weekdays:'工作日',weekly:'每周',monthly:'每月',rrule:'重复运行'};

function nextRun(item) {
  if (typeof item.next_run !== 'string') return '';
  const date = new Date(item.next_run);
  if (!Number.isFinite(date.getTime())) return '';
  const options = {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'};
  if (typeof item.time_zone === 'string') {
    try { return new Intl.DateTimeFormat('zh-CN',{...options,timeZone:item.time_zone,timeZoneName:'short'}).format(date); }
    catch { /* On an unrecognized time zone, use the browser's own zone. */ }
  }
  return new Intl.DateTimeFormat('zh-CN',options).format(date);
}

export function mountBotSchedules(document, {request}) {
  const list = document.getElementById('bot-schedule-list');
  if (!list) return null;
  const status = document.getElementById('bot-schedule-status');
  const empty = document.getElementById('bot-schedule-empty');
  const retry = document.getElementById('bot-schedule-retry');
  let current;

  function close() {
    current?.controller.abort();
    current = undefined;
  }

  function render(scope, body) {
    list.replaceChildren();
    const items = (body.available && Array.isArray(body.items) ? body.items : []).filter(item =>
      TASK_ID.test(item?.id || '') && typeof item.title === 'string' && Object.hasOwn(STATUS,item.state));
    empty.hidden = body.available && Boolean(items.length);
    empty.textContent = body.available ? '还没有 Bot 计划。可以在私聊里请智能体安排定时执行。' : '当前运行环境未提供 Bot 计划。';
    for (const item of items) {
      const row = document.createElement('li');
      row.className = 'bot-schedule-item';
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = item.title;
      const meta = document.createElement('p');
      const time = ['scheduled','overdue'].includes(item.state) ? nextRun(item) : '';
      const timeLabel = item.state === 'overdue' ? '计划' : '下次';
      meta.textContent = [item.bot_name, Object.hasOwn(FREQUENCY, item.kind) && FREQUENCY[item.kind],STATUS[item.state],
        time && `${timeLabel} ${time}`].filter(Boolean).join(' · ');
      copy.append(title,meta);
      if (WORKSPACE_ID.test(item.agent_id || '') && WORKSPACE_ID.test(item.conversation_id || '')) {
        const link = document.createElement('a');
        link.href = '/chat#' + new URLSearchParams({workspace:scope.workspace,agent:item.agent_id,conversation:item.conversation_id});
        link.textContent = '打开私聊';
        copy.append(link);
      }
      row.append(copy);
      if (body.can_pause === true && item.state !== 'finished') {
        const control = document.createElement('button');
        const paused = item.state === 'paused';
        control.type = 'button';
        control.className = 'secondary';
        control.dataset.botScheduleId = item.id;
        control.disabled = scope.pending.has(item.id);
        control.textContent = paused ? '恢复' : '暂停';
        control.setAttribute('aria-label', `${control.textContent}计划 ${item.title}`);
        control.addEventListener('click', () => void change(scope,item,paused,control));
        row.append(control);
      }
      list.append(row);
    }
  }

  const path = workspace => `/v1/workspaces/${workspace}/automations/bot-schedules`;
  const signalFor = scope => AbortSignal.any([scope.controller.signal,AbortSignal.timeout(8000)]);

  async function refresh(scope, notice = '', focusId = '') {
    if (!scope || current !== scope) return;
    const revision = ++scope.read;
    status.textContent = notice || '正在读取 Bot 计划…';
    list.setAttribute('aria-busy', 'true');
    retry.hidden = true;
    const result = await request('GET',path(scope.workspace),undefined,undefined,signalFor(scope)).catch(() => null);
    if (current !== scope || revision !== scope.read) return;
    list.setAttribute('aria-busy', 'false');
    if (result?.status !== 200 || typeof result.body?.available !== 'boolean') {
      status.textContent = '无法读取 Bot 计划。请重试。';
      retry.hidden = false;
      return;
    }
    status.textContent = notice;
    render(scope,result.body);
    if (focusId) list.querySelector(`[data-bot-schedule-id="${focusId}"]`)?.focus({preventScroll:true});
  }

  async function change(scope, item, active, control) {
    if (current !== scope || scope.pending.has(item.id)) return;
    scope.pending.add(item.id);
    control.disabled = true;
    const result = await request('POST',path(scope.workspace),{id:item.id,active},undefined,signalFor(scope)).catch(() => null);
    scope.pending.delete(item.id);
    if (current !== scope) return;
    control.disabled = false;
    const focus = document.activeElement === control || document.activeElement === document.body ? item.id : '';
    const updated = Array.isArray(result?.body?.items) && result.body.items.find(row => row.id === item.id);
    const confirmed = result?.status === 200 && updated && (active ? ['scheduled','overdue'].includes(updated.state) : updated.state === 'paused');
    await refresh(scope,confirmed ? (active ? '计划已恢复。' : '计划已暂停。') : '未能确认更新，请查看当前状态。',focus);
  }

  retry.addEventListener('click', () => void refresh(current));
  return {close, show(workspace, owner) {
    if (current?.workspace === workspace && current.owner === owner) return;
    close();
    list.replaceChildren();
    empty.hidden = true;
    if (!WORKSPACE_ID.test(workspace || '') || !owner) return;
    return refresh(current = {workspace,owner,controller:new AbortController(),read:0,pending:new Set()});
  }};
}
