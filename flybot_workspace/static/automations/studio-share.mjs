import {studioDocumentHref} from '../shell/studio-link.mjs';

export function mountStudioShare(document, {request, isCurrent}) {
  const get = id => document.getElementById('automation-studio-' + id);
  const dialog = get('dialog');
  if (typeof dialog?.showModal !== 'function') return null;
  const close = get('close'), refresh = get('refresh'), confirm = get('confirm');
  const review = get('review'), link = get('link'), status = get('status');
  let selection = null;

  function reset() {
    review.hidden = confirm.hidden = refresh.hidden = link.hidden = true;
    link.removeAttribute('href');
    get('title').textContent = get('body').textContent = '';
  }

  function current(state) {
    return selection === state && dialog.open && isCurrent(state.target);
  }

  function stop() {
    const trigger = selection?.trigger;
    const target = selection?.target;
    selection?.controller.abort();
    selection = null;
    reset();
    if (trigger?.isConnected) trigger.focus();
    else if (target && isCurrent(target)) document.getElementById('run-heading')?.focus();
  }

  function send(method, state, body) {
    const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(12000)]);
    return request(method, state.path, body, signal).catch(() => ({status:0,body:{}}));
  }

  function showLink(state, id, message) {
    const href = studioDocumentHref(state.target.workspace, id);
    if (!href) return false;
    review.hidden = confirm.hidden = refresh.hidden = true;
    get('title').textContent = get('body').textContent = '';
    link.href = href;
    link.hidden = false;
    status.textContent = message;
    link.focus();
    return true;
  }

  async function load(state) {
    reset();
    state.review = null;
    status.textContent = '正在读取本次运行结果…';
    const result = await send('GET', state);
    if (!current(state)) return;
    if (result.status === 200) {
      if (showLink(state, result.body?.document_id, '本次运行已共享。')) return;
      const {title, body, review: token} = result.body ?? {};
      if (typeof title === 'string' && typeof body === 'string' && /^[a-f0-9]{64}$/.test(token || '')) {
        state.review = token;
        get('title').textContent = title;
        get('body').textContent = body;
        review.hidden = confirm.hidden = false;
        confirm.disabled = false;
        status.textContent = '请核对将共享的标题和输出。团队成员可在资料空间编辑副本。';
        return;
      }
    }
    status.textContent = result.status === 403 ? '你已无法访问这个团队的协作文档。' : '暂时无法读取共享预览。';
    refresh.hidden = result.status === 403;
  }

  confirm.addEventListener('click', async () => {
    const state = selection;
    if (!state || !current(state) || !state.review || confirm.disabled) return;
    confirm.disabled = true;
    status.textContent = '正在共享结果…';
    const result = await send('POST', state, {review: state.review});
    if (!current(state)) return;
    if (result.status === 200 && showLink(state, result.body?.document_id, '已共享到团队协作。')) return;
    if (result.body?.error?.code === 'review_changed') {
      reset();
      refresh.hidden = false;
      status.textContent = '共享状态已变化，请重新查看。';
      return;
    }
    if (result.status === 403) {
      reset();
      status.textContent = '你已无法访问这个团队的协作文档。';
      return;
    }
    status.textContent = result.body?.error?.code === 'document_limit'
      ? '团队文档已达到上限。' : '暂时无法确认共享是否成功，可以重试。';
    confirm.disabled = false;
  });
  refresh.addEventListener('click', () => { if (selection && current(selection)) void load(selection); });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', stop);

  return {
    open(trigger, target, run, team) {
      if (dialog.open || !isCurrent(target)) return;
      const path = `/v1/workspaces/${target.workspace}/automations/${target.automation}/runs/${run}/studio`;
      selection = {trigger, target, path, controller: new AbortController()};
      get('team').textContent = team;
      dialog.showModal();
      void load(selection);
    },
  };
}
