export {sharedWorkCopyToken} from './entry.mjs';

const ID = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function mountSharedWorkCopy(document, {request, dismissLink, openArtifact}) {
  const find = name => document.getElementById('shared-work-copy-' + name);
  const dialog = find('dialog');
  if (typeof dialog?.showModal !== 'function') return null;
  const preview = find('preview'), title = find('title'), body = find('body'), status = find('status');
  const cancel = find('cancel'), retry = find('retry'), confirm = find('confirm');
  let operation;

  function render(text = '', {busy = false, canRetry = false} = {}) {
    status.textContent = text;
    preview.hidden = !operation?.fingerprint;
    if (preview.hidden) title.textContent = body.textContent = '';
    confirm.disabled = busy || preview.hidden;
    confirm.hidden = preview.hidden;
    cancel.disabled = busy && Boolean(operation?.fingerprint);
    retry.hidden = !canRetry;
    dialog.setAttribute('aria-busy', String(busy));
  }

  function close() {
    operation?.controller.abort();
    operation = null;
    render();
    if (dialog.open) dialog.close();
  }

  function dismiss() {
    close();
    dismissLink();
  }

  async function read(state, confirmed = false) {
    const fingerprint = confirmed ? state.fingerprint : undefined;
    render(confirmed ? '正在保存副本…' : '正在读取共享文字…', {busy:true});
    const endpoint = '/v1/workspaces/' + state.workspace + '/artifacts/shared-copy';
    const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(18000)]);
    const result = await request('POST',endpoint,{token:state.token,...(fingerprint ? {fingerprint} : {})},signal)
      .catch(() => ({status:0,body:{}}));
    if (operation !== state) return;
    const received = result.body?.snapshot;
    const artifact = result.body?.artifact;
    if (!confirmed && result.status === 200 && typeof received?.title === 'string' &&
        typeof received.body === 'string' && DIGEST.test(received.fingerprint || '')) {
      state.fingerprint = received.fingerprint;
      title.textContent = received.title;
      body.textContent = received.body;
      render();
    } else if (confirmed && [200,201].includes(result.status) &&
        ID.test(artifact?.id || '') && artifact.workspace_id === state.workspace) {
      dismiss();
      openArtifact(state.workspace,artifact);
    } else if (result.status === 404 || result.status === 409) {
      state.fingerprint = null;
      render(result.status === 404 ? '共享链接不可用，可能已过期或被撤销。' : '分享内容已变化，请重新查看。',
        {canRetry:result.status === 409});
    } else if (result.status === 429) {
      render('个人空间的作品已达上限。清理后可重试。');
    } else {
      render(confirmed ? '暂时无法确认副本已保存，请重试。' : '暂时无法读取共享文字，请重试。',
        {canRetry:!confirmed});
    }
  }

  cancel.addEventListener('click',dismiss);
  dialog.addEventListener('cancel',event => {
    event.preventDefault();
    if (!cancel.disabled) dismiss();
  });
  retry.addEventListener('click',() => { if (operation) void read(operation); });
  confirm.addEventListener('click',() => { if (operation?.fingerprint) void read(operation,true); });

  return {
    close,
    open(workspace, token) {
      close();
      operation = {workspace,token,controller:new AbortController()};
      dialog.showModal();
      void read(operation);
    },
  };
}
