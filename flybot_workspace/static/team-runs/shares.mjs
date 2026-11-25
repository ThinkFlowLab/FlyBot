const ID = /^[0-9a-f]{32}$/;
const SHARE_ID = /^otsr_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const LABELS = {
  succeeded: '已完成', failed: '未完成', cancelled: '已取消', blocked: '等待前序修复',
  waiting: '等待前序', queued: '等待执行', running: '执行中',
};

export function createTeamRunShares({document, request, selectAddress, adopt}) {
  const panel = document.getElementById('team-shared-runs');
  const actions = document.getElementById('share-team-run');
  if (!panel || !actions) return {selectWorkspace() {}, selectRun() {}, openTarget() {}};
  const view = document.defaultView;
  let scope, run, selection, summaries = [];
  let detailTarget = '';
  let listRequest = 0;
  let detailRequest = 0;
  let pending = false;
  let denied = false;

  function element(tag, text, cls) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }

  function button(text, action) {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  const heading = element('h2', '团队共享');
  const head = element('div', null, 'shared-runs-heading');
  const feedback = element('p', '', 'shared-runs-feedback');
  feedback.setAttribute('role', 'status');
  const detailFeedback = element('p', '', 'shared-runs-feedback');
  detailFeedback.setAttribute('role', 'status');
  const list = element('ul', null, 'shared-runs-list');
  const detail = element('article', null, 'shared-run-detail');
  detail.id = 'team-shared-run-detail';
  detail.hidden = true;
  const refresh = button('刷新团队共享', () => load());
  head.append(heading, refresh);
  panel.append(head, feedback, detailFeedback, detail, list);

  function path(id = '') {
    return '/v1/workspaces/' + scope.id + '/shared-runs' + (id ? '/' + id : '');
  }

  async function send(method, url, body) {
    try { return await request(method, url, body); } catch { return {status: 0}; }
  }

  function renderList() {
    const focused = document.activeElement?.dataset.sharedRun;
    list.replaceChildren();
    for (const share of summaries) {
      if (!SHARE_ID.test(share.id)) continue;
      const row = element('li');
      const open = button(share.title, () => openTarget(share.id, {address: true}));
      open.dataset.sharedRun = share.id;
      open.setAttribute('aria-expanded', String(selection?.id === share.id));
      open.setAttribute('aria-controls', detail.id);
      row.append(open, element('small', [share.author, LABELS[share.status]].filter(Boolean).join(' · ')));
      list.append(row);
      if (focused === share.id) open.focus({preventScroll: true});
    }
  }

  async function load({refreshSelection = true} = {}) {
    if (!scope) return;
    const owner = scope, requestId = ++listRequest;
    refresh.disabled = true;
    feedback.textContent = '正在读取团队共享…';
    const result = await send('GET', path());
    if (owner !== scope || requestId !== listRequest) return;
    refresh.disabled = false;
    if (result.status !== 200 || !Array.isArray(result.body?.items)) {
      if ([401, 403, 404].includes(result.status)) {
        denied = true;
        summaries = [];
        clearDetail();
        renderActions();
      }
      feedback.textContent = '无法读取团队共享，请重试。';
      return;
    }
    denied = false;
    summaries = result.body.items;
    feedback.textContent = summaries.length ? '' : '团队还没有共享的协作结果。';
    renderList();
    renderActions();
    if (refreshSelection && detailTarget) await openShare(detailTarget);
  }

  function clearDetail() {
    detailRequest += 1;
    detailTarget = '';
    selection = null;
    detailFeedback.textContent = '';
    detail.hidden = true;
    detail.replaceChildren();
    renderList();
  }

  function shareHref(id) {
    return '/team-runs#' + new URLSearchParams({workspace: scope.id, shared: id});
  }

  function linkControls(id, includeOpen = false) {
    const links = element('div', null, 'shared-run-links');
    const href = shareHref(id);
    if (includeOpen) {
      const open = element('a', '查看团队快照', 'team-run-link');
      open.href = href;
      links.append(open);
    }
    const status = element('p', '', 'shared-runs-feedback');
    status.setAttribute('role', 'status');
    const fallback = element('input', null, 'shared-run-link-fallback');
    fallback.setAttribute('aria-label', '团队快照链接');
    fallback.readOnly = true;
    fallback.hidden = true;
    const copy = button('复制团队链接', async () => {
      const url = new URL(href, view.location.origin).href;
      try {
        await view.navigator.clipboard.writeText(url);
        status.textContent = '团队快照链接已复制。';
      } catch {
        fallback.value = url;
        fallback.hidden = false;
        status.textContent = '可手动复制下方的团队快照链接。';
        if (document.activeElement === copy) {
          fallback.focus();
          fallback.select();
        }
      }
    });
    links.append(copy, status, fallback);
    return links;
  }

  function renderDetail(share, focus) {
    const title = element('h3', share.title);
    title.tabIndex = -1;
    const close = button('关闭快照', () => {
      clearDetail();
      selectAddress();
      list.querySelector('[data-shared-run="' + share.id + '"]')?.focus();
    });
    const toolbar = element('div', null, 'shared-runs-heading');
    toolbar.append(title, close);
    const metadata = [share.author, LABELS[share.status]].filter(Boolean);
    const recent = new Date(share.updated_at);
    if (Number.isFinite(share.updated_at) && !Number.isNaN(recent.valueOf())) {
      metadata.push('更新于 ' + recent.toLocaleString());
    }
    detail.replaceChildren(toolbar, element('p', metadata.join(' · '), 'shared-run-meta'),
      linkControls(share.id), element('p', share.goal, 'shared-run-goal'));
    if (share.own) {
      const revoke = button('撤回团队共享', () => confirm(revoke, '撤回后，团队成员将无法查看这份快照。', '确认撤回',
        () => revokeShare(share.id)));
      toolbar.append(revoke);
    }
    const steps = element('ol', null, 'shared-run-steps');
    const checks = new Map();
    const canFollow = adopt && /^[a-f0-9]{64}$/.test(share.source_version || '');
    for (const step of share.snapshot?.steps ?? []) {
      const row = element('li');
      row.append(element('strong', [step.agent_name, LABELS[step.status]].filter(Boolean).join(' · ')));
      if (step.output) row.append(element('p', step.output));
      if (canFollow && Number.isInteger(step.position) && step.position >= 0 && step.position < 8 &&
          step.status === 'succeeded' && typeof step.output === 'string' && step.output.trim()) {
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        const label = element('label', null, 'shared-run-choice');
        label.append(checkbox, `引用第 ${step.position + 1} 步结果摘要`);
        row.append(label);
        checks.set(step.position, checkbox);
      }
      steps.append(row);
    }
    if (checks.size) {
      detail.append(element('p', '可选最多 3 个已完成的步骤。每步引用开头 400 字。', 'shared-run-meta'));
    }
    detail.append(steps);
    if (checks.size) {
      const workspaceId = scope.id;
      const follow = button('发起后续任务', () => openDraft());
      follow.disabled = true;
      function openDraft(replace = false) {
        if (selection?.id !== share.id || selection.source_version !== share.source_version) return;
        const positions = [...checks.keys()].filter(position => checks.get(position).checked);
        if (!positions.length) return;
        const result = adopt({workspaceId, name: share.title,
          source: {id: share.id, version: share.source_version, positions}}, {replace});
        if (result === 'replace') {
          confirm(follow, '发起后续任务将替换当前工作区的草稿。', '替换草稿', () => openDraft(true));
        } else if (result === 'pending') {
          detailFeedback.textContent = '请先继续草稿，确认上次启动结果。';
        } else if (result === 'opened') {
          clearDetail();
        }
      }
      for (const checkbox of checks.values()) {
        checkbox.addEventListener('change', () => {
          const selected = [...checks.values()].filter(input => input.checked).length;
          follow.disabled = selected === 0;
          for (const input of checks.values()) input.disabled = selected >= 3 && !input.checked;
        });
      }
      detail.append(follow);
    }
    detail.hidden = false;
    if (focus) title.focus();
  }

  async function openShare(id, focus = false) {
    if (!scope || !SHARE_ID.test(id)) return;
    const owner = scope, requestId = ++detailRequest;
    const result = await send('GET', path(id));
    if (owner !== scope || requestId !== detailRequest) return;
    const share = result.body?.share;
    if (result.status !== 200 || share?.id !== id) {
      if ([401, 403, 404].includes(result.status)) {
        const hadFocus = detail.contains(document.activeElement);
        clearDetail();
        if (hadFocus) refresh.focus();
      }
      detailFeedback.textContent = [401, 403, 404].includes(result.status) ? '这份共享快照已不可用。' : '无法打开共享快照，请重试。';
      return;
    }
    const same = selection?.id === share.id && JSON.stringify(selection) === JSON.stringify(share);
    selection = share;
    detailFeedback.textContent = '';
    renderList();
    if (!same || focus) renderDetail(share, focus);
  }

  function openTarget(id, {address = false} = {}) {
    if (!scope) return;
    clearDetail();
    if (!SHARE_ID.test(id || '')) return;
    detailTarget = id;
    if (address) selectAddress(id);
    detailFeedback.textContent = '正在读取共享快照…';
    return openShare(id, true);
  }

  function confirm(trigger, message, label, action) {
    const box = element('div', null, 'shared-run-confirm');
    const accept = button(label, async () => {
      accept.disabled = true;
      await action();
      box.remove();
      if (trigger.isConnected && !trigger.parentElement.closest('[hidden]')) {
        trigger.hidden = false;
        trigger.focus();
      } else if (!trigger.isConnected && !actions.closest('[hidden]')) actions.querySelector('button')?.focus();
    });
    const cancel = button('取消', () => {
      box.remove();
      trigger.hidden = false;
      trigger.focus();
    });
    trigger.hidden = true;
    box.append(element('p', message), accept, cancel);
    trigger.after(box);
    accept.focus();
  }

  function renderActions() {
    const available = scope && !denied && run?.workspace_id === scope.id && TERMINAL.has(run.status);
    const existing = available && summaries.find(share => share.own && share.run_id === run.id && SHARE_ID.test(share.id));
    const signature = available ? run.id + ':' + (existing?.id ?? '') + ':' + pending : '';
    if (signature === (actions.dataset.runActions ?? '')) return;
    actions.dataset.runActions = signature;
    actions.hidden = !available;
    actions.replaceChildren();
    if (!available) return;
    const id = run.id;
    const share = button(existing ? '更新团队快照' : '共享结果给团队', () =>
      confirm(share, '共享后，团队成员可以查看任务目标、步骤状态和输出摘要。', '确认共享', () => publish(id)));
    share.disabled = pending;
    actions.append(share);
    if (existing) actions.append(linkControls(existing.id, true));
  }

  function report(message) {
    feedback.textContent = message;
    const actionFeedback = element('span', message, 'shared-runs-feedback shared-runs-action-feedback');
    actionFeedback.setAttribute('role', 'status');
    actions.querySelector('.shared-runs-action-feedback')?.remove();
    if (!actions.hidden) actions.append(actionFeedback);
  }

  async function publish(id) {
    if (!scope || pending) return;
    const owner = scope;
    pending = true;
    const result = await send('POST', '/v1/workspaces/' + owner.id + '/team-runs/' + id + '/share', {});
    if (owner !== scope) return;
    pending = false;
    if (result.status !== 200 || !SHARE_ID.test(result.body?.share?.id || '')) {
      report('无法共享结果，请重试。');
      return;
    }
    await load();
    if (owner === scope) report('已共享给团队。');
  }

  async function revokeShare(id) {
    if (!scope || pending) return;
    const owner = scope;
    pending = true;
    const result = await send('POST', path(id) + '/revoke', {});
    if (owner !== scope) return;
    pending = false;
    if (result.status !== 200) {
      report('无法撤回共享，请重试。');
      return;
    }
    if (selection?.id === id) {
      clearDetail();
      selectAddress();
      refresh.focus();
    }
    await load();
    if (owner === scope) report('已撤回团队共享。');
  }

  function selectWorkspace(workspace) {
    const valid = workspace && ID.test(workspace.id) && ['team', 'workspace'].includes(workspace.kind);
    if (valid && scope?.id === workspace.id) return;
    scope = valid ? {...workspace} : null;
    run = null;
    summaries = [];
    pending = false;
    denied = false;
    panel.hidden = !scope;
    clearDetail();
    renderActions();
    if (scope) void load({refreshSelection: false});
  }

  function selectRun(next) {
    run = next;
    renderActions();
  }

  return {selectWorkspace, selectRun, openTarget};
}
