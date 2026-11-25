import { bindModel3dPreview } from '../shell/model3d-preview.mjs';

const HEX = /^[0-9a-f]{32}$/;
const running = job => job?.state === 'queued' || job?.state === 'running';
const MODEL3D_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function readPrompt(prompt) {
  const value = prompt.value.trim();
  if (!value || value.length > prompt.maxLength) throw new Error('请输入有效的生成描述。');
  return value;
}

function matchingInputs(previous, values) {
  if (!previous) return false;
  if (values.image) return previous.image?.mime === values.image.mime && previous.image.data === values.image.data;
  return Object.keys(values).every(name => previous[name] === values[name]);
}

async function readModel3dValues({prompt, image, source}) {
  if (source.value !== 'image') return {prompt: readPrompt(prompt)};
  const file = image.files[0];
  if (!file?.size) throw new Error('请选择一张参考图。');
  if (!MODEL3D_IMAGE_TYPES.has(file.type) || file.size > 2 * 1024 * 1024) {
    throw new Error('请选择 2 MB 以内的 PNG、JPG 或 WebP 图片。');
  }
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reader.onabort = () => reject(new Error('无法读取参考图，请重新选择。'));
    reader.readAsDataURL(file);
  });
  return {image: {mime: file.type, data: url.slice(url.indexOf(',') + 1)}};
}

export function mountVideoCreator(document, options) {
  return mountMediaCreator(document, options, {
    type: 'video', noun: '视频', endpoint: 'videos',
    fields: ['shape'],
    read: ({prompt, shape}) => ({prompt: readPrompt(prompt), shape: shape.value}),
    fill: ({shape}, values) => { shape.value = values?.shape || 'landscape'; },
  });
}

export function mountMusicCreator(document, options) {
  return mountMediaCreator(document, options, {
    type: 'music', noun: '音乐', endpoint: 'music',
    fields: ['duration', 'instrumental'],
    read: ({prompt, duration, instrumental}) => ({prompt: readPrompt(prompt),
      duration: Number(duration.value), instrumental: instrumental.checked}),
    fill: ({duration, instrumental}, values) => {
      duration.value = String(values?.duration ?? 30);
      instrumental.checked = values?.instrumental ?? true;
    },
  });
}

export function mountModel3dCreator(document, options) {
  return mountMediaCreator(document, options, {
    type: 'model3d', noun: '3D 模型', endpoint: 'models-3d', configuration: '3D 模型',
    fields: ['source', 'image'], read: readModel3dValues,
    bindPreview: element => bindModel3dPreview(element('open-preview'), element('preview'), element('preview-status')),
    fill: ({source, image}, values) => {
      source.value = values?.source === 'image' || values?.image ? 'image' : 'text';
      image.value = '';
    },
    sync: ({source, prompt, image}, busy) => {
      const fromImage = source.value === 'image';
      prompt.closest('label').hidden = fromImage;
      image.closest('label').hidden = !fromImage;
      prompt.disabled = busy || fromImage;
      image.disabled = busy || !fromImage;
    },
    runningLabel: ({stage, progress}) => {
      const label = stage === 'refine' ? '正在添加材质' : '正在生成模型';
      const percent = Number.isInteger(progress) && progress > 0 && progress <= 100 ? `（${progress}%）` : '';
      return label + percent + '，可以关闭窗口。';
    },
  });
}

export function mountWebsiteCreator(document, options) {
  return mountMediaCreator(document, options, {
    type: 'website', noun: '网站', endpoint: 'websites',
    manual: 'website', focusPrompt: true,
    read: ({prompt}) => ({prompt: readPrompt(prompt)}),
    bindPreview: bindWebsitePreview, previewPath: '',
    queuedLabel: '网站任务已排队，可以关闭窗口。',
    savedLabel: '网站已私密保存到资料空间。',
    unavailableLabel: '暂时无法生成网站，可以新建空白网站。',
  });
}

function bindWebsitePreview(element, call) {
  const button = element('open-preview');
  const dialog = element('dialog');
  const preview = element('preview');
  const status = element('preview-status');
  let source = '';
  let sequence = 0;

  function collapse() {
    sequence += 1;
    preview.hidden = true;
    preview.removeAttribute('src');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = '预览网站';
    status.textContent = '';
  }

  button.addEventListener('click', async () => {
    if (!source || !dialog.open) return;
    if (button.getAttribute('aria-expanded') === 'true') {
      collapse();
      return;
    }
    const request = ++sequence;
    status.textContent = '正在加载预览…';
    button.setAttribute('aria-expanded', 'true');
    button.textContent = '关闭预览';
    const response = await call('GET', source);
    if (request !== sequence || !dialog.open) return;
    const revision = response.body.artifact?.revision;
    if (response.status !== 200 || !Number.isSafeInteger(revision) || revision < 1) {
      collapse();
      status.textContent = '暂时无法打开预览，可在资料空间查看。';
      return;
    }
    preview.src = source + '/preview?revision=' + revision;
    preview.hidden = false;
    status.textContent = '';
  });

  return {setSource(url) {
    source = url;
    collapse();
  }};
}

function mountMediaCreator(document, {request, context, key, share, onOpen, notify}, media) {
  const {type, noun, endpoint} = media;
  const trigger = document.getElementById('composer-' + type + '-create');
  const element = name => document.getElementById(type + '-create-' + name);
  const dialog = element('dialog');
  if (!trigger || typeof dialog?.showModal !== 'function') return {open() {}, sync() {}};

  const form = element('form');
  const {prompt} = form.elements;
  const inputs = [prompt, ...(media.fields || []).map(name => form.elements[name])];
  const submit = element('submit');
  const status = element('status');
  const settings = element('settings');
  const result = element('result');
  const preview = element('preview');
  const close = element('close');
  const download = element('download');
  const sendButton = element('send');
  const attempts = new Map();
  const sent = new Set();
  let session;
  let timer;

  const current = draft => dialog.open && session === draft && context()?.scope === draft.scope;
  const call = (method, path, body, headers) => request(method, path, body, headers)
    .catch(() => ({status: 0, body: {}}));
  const viewer = media.bindPreview?.(element, call);

  function setForm(draft, busy) {
    submit.disabled = busy || !draft.configured;
    for (const input of inputs) input.disabled = busy;
    media.sync?.(form.elements, busy);
  }

  function setPreview(url) {
    if (viewer) viewer.setSource(url);
    else if (url) preview.src = url;
    else {
      preview.removeAttribute('src');
      preview.load();
    }
  }

  function clearResult() {
    result.hidden = true;
    if (sendButton) sendButton.hidden = true;
    setPreview('');
  }

  function renderResult(draft, artifact) {
    const base = `/v1/workspaces/${draft.workspace}/artifacts/${artifact}`;
    setPreview(base + (media.previewPath ?? '/file'));
    element('space').href = '/space?' + new URLSearchParams({workspace: draft.workspace, artifact});
    if (download) download.href = base + '/export';
    if (sendButton) {
      sendButton.hidden = !draft.sendLabel;
      sendButton.disabled = sent.has(draft.scope + artifact);
      sendButton.textContent = sendButton.disabled ? '已发送' : (draft.sendLabel || '发送到会话');
    }
    result.hidden = false;
  }

  function render(draft, job) {
    clearTimeout(timer);
    draft.job = job;
    setForm(draft, running(job));
    settings.hidden = draft.configured;
    if (running(job)) {
      status.textContent = job.state === 'queued' ? media.queuedLabel || '正在排队…'
        : media.runningLabel?.(job) || '正在生成，可以关闭窗口。';
      timer = setTimeout(() => void poll(draft, job.id), 1800);
    } else if (job?.state === 'failed') {
      status.textContent = job.message || noun + '生成失败，请重试。';
      settings.hidden = false;
    } else if (job?.state === 'succeeded' && HEX.test(job.artifact_id || '')) {
      status.textContent = media.savedLabel || noun + '已保存到资料空间。';
      renderResult(draft, job.artifact_id);
    } else {
      status.textContent = draft.configured ? ''
        : media.unavailableLabel || '请先配置' + (media.configuration || noun + '模型') + '。';
    }
  }

  async function poll(draft, id) {
    const response = await call('GET', draft.path + '/' + encodeURIComponent(id));
    if (!current(draft)) return;
    if (response.status === 200 && response.body.job) {
      render(draft, response.body.job);
    } else if ([401, 403, 404].includes(response.status)) {
      status.textContent = '无法查看这个' + noun + '任务，请重新打开。';
    } else {
      status.textContent = '暂时无法读取进度，任务仍在后台运行。';
      timer = setTimeout(() => void poll(draft, id), 5000);
    }
  }

  async function open(text = document.getElementById('chat-body').value.trim()) {
    const target = context();
    if (!target || dialog.open) return;
    const draft = session = {...target, path: `/v1/workspaces/${target.workspace}/${endpoint}`};
    const prior = attempts.get(draft.scope);
    prompt.value = prior?.values.prompt ?? (text.length <= prompt.maxLength ? text : '');
    media.fill?.(form.elements, prior?.values);
    if (media.manual) {
      element('manual').href = '/space?new=' + media.manual + '#' + new URLSearchParams({workspace: draft.workspace});
    }
    onOpen();
    clearResult();
    setForm(draft, true);
    settings.hidden = true;
    status.textContent = prior?.pending ? '正在提交…' : '正在读取' + noun + '任务…';
    dialog.showModal();
    if (prior?.pending) await prior.pending;
    if (!current(draft)) return;
    const response = await call('GET', draft.path);
    if (!current(draft)) return;
    if (response.status !== 200) {
      status.textContent = response.body.error?.message || '无法读取' + noun + '任务，请重新打开。';
      return;
    }
    draft.configured = response.body.configured === true;
    const job = response.body.job;
    if (running(job) || !prompt.value) {
      prompt.value = job?.prompt || '';
      media.fill?.(form.elements, job);
    }
    render(draft, job);
    if (media.focusPrompt && draft.configured && !running(job) && document.activeElement === close) {
      prompt.focus({preventScroll: true});
    }
  }

  if (media.sync) form.addEventListener('change', () => media.sync(form.elements, false));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const draft = session;
    if (!draft || !current(draft) || submit.disabled) return;
    setForm(draft, true);
    status.textContent = '正在提交…';
    let values;
    try {
      values = await media.read(form.elements);
    } catch (error) {
      if (current(draft)) {
        setForm(draft, false);
        status.textContent = error.message;
      }
      return;
    }
    if (!current(draft)) return;
    const prior = attempts.get(draft.scope);
    const attempt = matchingInputs(prior?.values, values) ? prior : {values, key: key()};
    attempts.set(draft.scope, attempt);
    clearResult();
    attempt.pending = call('POST', draft.path, values, {'Idempotency-Key': attempt.key});
    const response = await attempt.pending;
    delete attempt.pending;
    const accepted = response.status === 202 && response.body.job;
    if (accepted && attempts.get(draft.scope) === attempt) attempts.delete(draft.scope);
    if (!current(draft)) return;
    if (accepted) {
      render(draft, response.body.job);
      return;
    }
    if (response.body.error?.code === type + '_unconfigured') {
      draft.configured = false;
      settings.hidden = false;
    }
    setForm(draft, false);
    status.textContent = response.body.error?.message || '尚未确认提交，请重试。';
  });

  sendButton?.addEventListener('click', async () => {
    const draft = session;
    const artifact = draft?.job?.artifact_id;
    if (!draft?.sendLabel || !current(draft) || sendButton.disabled || draft.job?.state !== 'succeeded' || !HEX.test(artifact || '')) return;
    const sendKey = draft.scope + artifact;
    sendButton.disabled = true;
    status.textContent = '正在发送' + noun + '…';
    const response = await share(artifact, draft.scope).catch(() => ({status: 0, body: {}}));
    const delivered = [200, 201].includes(response.status);
    if (delivered) sent.add(sendKey);
    if (!current(draft)) return;
    if (delivered) {
      dialog.close();
      notify('ok', noun + '已发送。', {announceOnly: true});
    } else {
      sendButton.disabled = false;
      status.textContent = response.body.error?.message || '尚未确认发送，请重试。';
    }
  });

  if (!viewer) preview.addEventListener('error', () => {
    if (!result.hidden && session && current(session)) status.textContent = noun + '已保存，暂时无法预览。';
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    session = null;
    clearTimeout(timer);
    clearResult();
  });

  return {open, sync() {
    trigger.disabled = !context();
    if (dialog.open && session && !current(session)) dialog.close();
  }};
}
