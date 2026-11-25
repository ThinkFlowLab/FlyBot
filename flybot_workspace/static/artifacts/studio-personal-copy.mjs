import {spaceHref} from '../shell/thumb.mjs';

const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;

export function mountStudioPersonalCopy(document, request) {
  const get = name => document.getElementById('studio-personal-' + name);
  const dialog = get('dialog');
  if (typeof dialog?.showModal !== 'function') return null;
  const view = document.defaultView, title = get('title'), body = get('body'), meta = get('meta');
  const preview = get('preview'), download = get('download'), confirm = get('confirm');
  const retry = get('retry'), result = get('result'), status = get('status'), closeButton = get('close');
  let active;

  function clearPreview(state) {
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = '';
    state.fingerprint = null;
    title.textContent = body.textContent = '';
    preview.hidden = download.hidden = true;
    download.removeAttribute('href');
  }

  function close() {
    if (active) {
      active.controller.abort();
      clearPreview(active);
    }
    active = null;
    result.removeAttribute('href');
    result.hidden = confirm.hidden = retry.hidden = true;
    status.textContent = '';
    if (dialog.open) dialog.close();
  }

  async function send(state, saving) {
    confirm.disabled = retry.disabled = true;
    closeButton.disabled = saving;
    status.textContent = saving ? '正在保存到个人空间…' : '正在读取团队文档版本…';
    const signal = AbortSignal.any([state.controller.signal, AbortSignal.timeout(15000)]);
    const payload = {source_workspace_id:state.workspace, document_id:state.id, revision:state.revision,
      ...(saving ? {fingerprint:state.fingerprint} : {})};
    const response = await request('POST', '/v1/workspaces/' + state.personal + '/artifacts/studio-personal-copy',
      payload, {signal}).catch(() => ({status:0,body:{}}));
    if (active !== state || !state.current()) return;
    retry.disabled = closeButton.disabled = false;
    const {snapshot, artifact} = response.body || {};
    if (!saving && response.status === 200 && snapshot?.revision === state.revision && HASH.test(snapshot.fingerprint || '') &&
        typeof snapshot.title === 'string' && typeof snapshot.body === 'string') {
      title.textContent = snapshot.title;
      body.textContent = snapshot.body;
      state.fingerprint = snapshot.fingerprint;
      state.url = URL.createObjectURL(new Blob([snapshot.body], {type:'text/markdown;charset=utf-8'}));
      download.href = state.url;
      download.download = 'studio-r' + state.revision + '.md';
      preview.hidden = download.hidden = false;
      confirm.hidden = confirm.disabled = snapshot.can_copy !== true;
      retry.hidden = true;
      status.textContent = snapshot.can_copy ? '' : '标题或正文超过资料空间的文档上限，可下载完整正文。';
    } else if (saving && [200,201].includes(response.status) && ID.test(artifact?.id || '') && artifact.workspace_id === state.personal) {
      confirm.hidden = retry.hidden = true;
      result.href = new URL(spaceHref(state.personal,artifact.id),view.location.origin).href;
      result.hidden = false;
      status.textContent = '已保存到个人空间。';
      result.focus();
    } else if (response.status === 404 || response.status === 409) {
      clearPreview(state);
      confirm.hidden = true;
      retry.hidden = response.status === 404;
      status.textContent = response.status === 404 ? '此版本已不可用，或你没有访问权限。' : '版本内容已变化，请重新查看。';
    } else {
      confirm.disabled = false;
      retry.hidden = saving;
      status.textContent = response.status === 429 ? '个人空间的作品已达上限，整理后可重试。'
        : saving ? '暂时无法确认保存结果，请重试。' : '暂时无法读取这个版本，请重试。';
    }
  }

  closeButton.addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{
    event.preventDefault();
    if (!closeButton.disabled) close();
  });
  confirm.addEventListener('click',()=>{ if (active?.fingerprint) void send(active,true); });
  retry.addEventListener('click',()=>{ if (active) void send(active,false); });

  return {
    close,
    open(target) {
      if (dialog.open || !ID.test(target?.personal || '')) return;
      active = {...target,controller:new AbortController()};
      meta.textContent = '版本 ' + target.revision + ' · 来自 ' + target.workspaceName;
      closeButton.disabled = false;
      dialog.showModal();
      void send(active,false);
    },
  };
}
