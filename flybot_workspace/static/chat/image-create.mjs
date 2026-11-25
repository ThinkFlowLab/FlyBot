const HEX = /^[0-9a-f]{32}$/;
const activeJob = job => job?.state === 'queued' || job?.state === 'running';

export function mountImageCreator(document,{request,context,key,attach,onOpen,notify}) {
  const trigger = document.getElementById('composer-image-create');
  const dialog = document.getElementById('image-create-dialog');
  if (!trigger || !dialog) return {open() {}, sync() {}};
  const view = document.defaultView;
  const element = key => document.getElementById('image-create-' + key);
  const form = element('form');
  const submit = element('submit');
  const status = element('status');
  const result = element('result');
  const preview = element('preview');
  const attachButton = element('attach');
  const settings = element('settings');
  const attempts = new Map();
  let session;
  let timer;
  let previewUrl;

  const current = draft => dialog.open && session === draft && context()?.scope === draft.scope;
  const send = (method,path,body,headers) => request(method,path,body,headers).catch(() => ({status:0,body:{}}));

  function setForm(draft,busy) {
    submit.disabled = busy || !draft.configured;
    form.elements.prompt.disabled = form.elements.shape.disabled = busy;
  }

  function showSubmitError(draft,response) {
    if (response.body.error?.code === 'image_unconfigured') {
      draft.configured = false;
      settings.hidden = false;
    }
    setForm(draft,false);
    status.textContent = response.body.error?.message || '暂未确认提交，请重试。';
  }

  function clearAttempt(draft,attempt) {
    if (attempts.get(draft.scope) === attempt) attempts.delete(draft.scope);
  }

  function clearPreview() {
    if (previewUrl) view.URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    preview.removeAttribute('src');
    result.hidden = true;
    attachButton.disabled = true;
  }

  async function loadPreview(draft,artifact) {
    const path = `/v1/workspaces/${draft.workspace}/artifacts/${artifact}/file`;
    element('space').href = '/space?' + new URLSearchParams({workspace:draft.workspace,artifact});
    try {
      const response = await view.fetch(path,{credentials:'same-origin'});
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      if (!blob.size || blob.type.split(';')[0] !== 'image/png') throw new Error();
      if (!current(draft) || draft.job?.artifact_id !== artifact) return;
      draft.blob = blob;
      previewUrl = view.URL.createObjectURL(blob);
      preview.src = previewUrl;
      result.hidden = false;
      attachButton.disabled = false;
    } catch {
      if (current(draft) && draft.job?.artifact_id === artifact) {
        status.textContent = '图片已保存，暂时无法读取预览。';
        result.hidden = false;
      }
    }
  }

  function render(draft,job) {
    clearTimeout(timer);
    draft.job = job;
    const working = activeJob(job);
    setForm(draft,working);
    settings.hidden = draft.configured && job?.state !== 'failed';
    if (!job) {
      status.textContent = draft.configured ? '' : '请先配置支持文生图的模型。';
      return;
    }
    if (working) {
      status.textContent = job.state === 'queued' ? '正在排队…' : '正在生成，可以关闭窗口。';
      timer = setTimeout(() => void poll(draft,job.id),1200);
    } else if (job.state === 'failed') {
      status.textContent = job.message || '生成失败，请重试。';
    } else if (job.state === 'succeeded' && HEX.test(job.artifact_id || '')) {
      status.textContent = '图片已保存到资料空间。';
      if (!draft.blob) void loadPreview(draft,job.artifact_id);
    }
  }

  async function poll(draft,id) {
    const response = await send('GET',draft.path+'/'+encodeURIComponent(id));
    if (!current(draft)) return;
    if ([401,403,404].includes(response.status)) {
      status.textContent = '现在无法查看这个图片任务。';
      form.elements.prompt.disabled = form.elements.shape.disabled = false;
      return;
    }
    if (response.status !== 200) {
      status.textContent = '暂时无法读取进度，任务仍在后台运行。';
      timer = setTimeout(() => void poll(draft,id),5000);
      return;
    }
    render(draft,response.body.job);
  }

  async function open(text = document.getElementById('chat-body').value.trim()) {
    const where = context();
    if (!where || dialog.open) return;
    const draft = session = {...where,path:`/v1/workspaces/${where.workspace}/images`};
    const attempt = attempts.get(draft.scope);
    onOpen();
    clearPreview();
    setForm(draft,true);
    settings.hidden = true;
    form.elements.prompt.value = attempt?.values.prompt ?? text;
    form.elements.shape.value = attempt?.values.shape ?? 'square';
    attachButton.textContent = draft.attachLabel;
    status.textContent = attempt?.pending ? '正在提交…' : '正在读取图片任务…';
    dialog.showModal();
    if (attempt?.pending) {
      const response = await attempt.pending;
      if (!current(draft)) return;
      if (response.status === 202 && response.body.job) {
        draft.configured = true;
        render(draft,response.body.job);
        return;
      }
    }
    const response = await send('GET',draft.path,undefined,attempt && {'Idempotency-Key':attempt.key});
    if (!current(draft)) return;
    if (response.status !== 200) {
      status.textContent = response.body.error?.message || '无法读取图片任务，请重新打开。';
      return;
    }
    draft.configured = response.body.configured === true;
    const job = response.body.job;
    if (job && attempt) clearAttempt(draft,attempt);
    if (activeJob(job) || !form.elements.prompt.value) {
      form.elements.prompt.value = job?.prompt || '';
      form.elements.shape.value = job?.shape || 'square';
    }
    render(draft,job);
    if (!job && attempt?.failure) showSubmitError(draft,attempt.failure);
  }

  form.addEventListener('submit',async event => {
    event.preventDefault();
    const draft = session;
    if (!draft || !current(draft) || submit.disabled) return;
    const values = {prompt:form.elements.prompt.value.trim(),shape:form.elements.shape.value};
    if (!values.prompt) return;
    const prior = attempts.get(draft.scope);
    const attempt = prior?.values.prompt === values.prompt && prior.values.shape === values.shape
      ? prior : {values,key:key()};
    attempts.set(draft.scope,attempt);
    setForm(draft,true);
    status.textContent = '正在提交…';
    clearPreview();
    draft.job = draft.blob = null;
    attempt.pending = send('POST',draft.path,values,{'Idempotency-Key':attempt.key});
    const response = await attempt.pending;
    delete attempt.pending;
    const accepted = response.status === 202 && response.body.job;
    if (accepted) clearAttempt(draft,attempt);
    else attempt.failure = response;
    if (!current(draft)) return;
    if (accepted) render(draft,response.body.job);
    else showSubmitError(draft,response);
  });

  attachButton.addEventListener('click',() => {
    const draft = session;
    if (!draft?.blob || !current(draft)) return;
    const file = new view.File([draft.blob],`图片-${draft.job.id.slice(0,8)}.png`,{type:'image/png'});
    if (attach(file,draft.scope)) {
      dialog.close();
      if (draft.private) notify('ok','图片已添加到输入框。',{announceOnly:true});
    } else status.textContent = '无法添加图片，请检查当前会话和附件容量。';
  });
  element('close').addEventListener('click',() => dialog.close());
  dialog.addEventListener('close',() => {
    if (dialog.open) return;
    session = null;
    clearTimeout(timer);
    clearPreview();
  });

  return {open, sync() {
    trigger.disabled = !context();
    if (dialog.open && session && !current(session)) dialog.close();
  }};
}
