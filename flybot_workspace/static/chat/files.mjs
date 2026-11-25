import { artifactVersionLabel } from '../shell/thumb.mjs';

export function deferModule(path) {
  let promise;
  let failures = 0;
  // A failed module URL can stay cached in the document. Retry with a new URL.
  return () => promise ??= import(failures ? path + '?retry=' + failures : path).catch(error => {
    failures += 1;
    promise = null;
    throw error;
  });
}

const loadModelPreview = deferModule('../shell/model3d-preview.mjs');

export const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024;
export const AGENT_FILE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,.pdf,.txt,.md,.csv,.tsv,.json,.docx,.xlsx,.pptx';
const AGENT_FILE_EXT = new Set(['png','jpg','jpeg','gif','webp','pdf','txt','md','csv','tsv','json','docx','xlsx','pptx']);

const MEDIA_TYPES = {
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
  mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg', ogg:'audio/ogg', wav:'audio/wav', m4a:'audio/mp4',
};

function fileType(file) {
  const extension = file.name.toLowerCase().split('.').at(-1);
  return Object.hasOwn(MEDIA_TYPES, extension) ? MEDIA_TYPES[extension] : file.type;
}
const formatBytes = bytes => bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB'
  : bytes >= 1024 ? Math.round(bytes / 1024) + ' KB' : bytes + ' B';

function mediaElement(document, mime, url, title, pending) {
  if (!url) return null;
  if (mime?.startsWith('image/')) {
    const image = document.createElement('img');
    image.src = url;
    image.alt = title;
    if (!pending) image.loading = 'lazy';
    image.decoding = 'async';
    return image;
  }
  if (mime?.startsWith('video/') || mime?.startsWith('audio/')) {
    const media = document.createElement(mime.startsWith('video/') ? 'video' : 'audio');
    media.src = url;
    media.controls = !pending;
    media.preload = pending ? 'metadata' : 'none';
    media.playsInline = true;
    media.setAttribute('aria-label', title);
    return media;
  }
  return null;
}

export function chatFileDownload(document, attachment) {
  if (!attachment.path) return null;
  const title = attachment.title || '附件';
  const link = document.createElement('a');
  const separator = attachment.path.includes('?') ? '&' : '?';
  link.href = attachment.path + (attachment.bytes === undefined ? '' : separator + 'download=1');
  if (attachment.bytes !== undefined) link.download = title;
  link.textContent = '下载';
  link.setAttribute('aria-label', '下载' + title);
  return link;
}

export function renderChatFile(document, attachment, {pending = false} = {}) {
  const card = document.createElement('article');
  card.className = 'chat-file';
  if (!pending && attachment.path) card.dataset.chatFilePath = attachment.path;
  const title = attachment.resource?.title || attachment.title || '附件';
  const media = mediaElement(document, attachment.mime, attachment.path, title, pending);
  if (media) card.append(media);
  if (attachment.sticker === true && media) {
    card.classList.add('chat-file-sticker');
    return card;
  }
  const details = document.createElement('div');
  details.className = 'chat-file-details';
  const info = document.createElement('span');
  info.className = 'chat-file-info';
  const name = document.createElement('strong');
  name.textContent = title;
  info.append(name);
  const version = artifactVersionLabel(attachment.resource, attachment.mime);
  if (version) {
    const meta = document.createElement('small');
    meta.textContent = version;
    info.append(meta);
  }
  if (Number.isSafeInteger(attachment.bytes)) {
    const size = document.createElement('small');
    size.textContent = formatBytes(attachment.bytes);
    info.append(size);
  }
  details.append(info);
  const download = pending ? null : chatFileDownload(document, attachment);
  if (download) details.append(download);
  card.append(details);
  if (!pending && attachment.path && attachment.mime === 'model/gltf-binary') {
    card.classList.add('chat-file-model3d');
    card.dataset.model3dSource = attachment.path;
    const button = document.createElement('button');
    button.className = 'chat-file-model3d-toggle';
    button.type = 'button';
    button.textContent = '预览 3D 模型';
    button.setAttribute('aria-expanded', 'false');
    const status = document.createElement('p');
    status.className = 'model3d-preview-status';
    status.setAttribute('role', 'status');
    const preview = document.createElement('div');
    preview.className = 'chat-file-model3d-preview model3d-preview-frame';
    preview.hidden = true;
    details.append(button);
    card.append(status, preview);
    let loading = false;
    async function initializePreview() {
      if (loading) return;
      loading = true;
      button.setAttribute('aria-busy', 'true');
      status.textContent = '正在加载模型预览…';
      try {
        const {bindModel3dPreview} = await loadModelPreview();
        if (!card.isConnected) return;
        button.removeEventListener('click', initializePreview);
        const viewer = bindModel3dPreview(button, preview, status);
        viewer.setSource(attachment.path);
        void viewer.toggle();
      } catch {
        status.textContent = '无法打开预览，可重试或下载 GLB 文件。';
      } finally {
        loading = false;
        button.removeAttribute('aria-busy');
      }
    }
    button.addEventListener('click', initializePreview);
  }
  return card;
}

export function localChatFile(document, file) {
  const mime = fileType(file);
  const previewable = mime?.startsWith('image/') || mime?.startsWith('video/');
  const preview = previewable ? document.defaultView?.URL?.createObjectURL?.(file) || '' : '';
  const card = renderChatFile(document, {title:file.name, bytes:file.size, mime, path:preview}, {pending:true});
  return {card, preview};
}

export function chatUploadProgress(document, label) {
  const progress = document.createElement('progress');
  progress.className = 'chat-upload-progress';
  progress.hidden = true;
  progress.max = 100;
  progress.setAttribute('aria-label', label);
  return progress;
}

function uploadForm(view, url, headers, body, onProgress, timeout = 180_000) {
  return new Promise((resolve, reject) => {
    const xhr = new view.XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'json';
    xhr.timeout = timeout;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(99, Math.round(event.loaded * 100 / event.total)));
    };
    xhr.upload.onload = () => onProgress(100);
    xhr.onload = () => resolve({status: xhr.status, body: xhr.response || {}});
    xhr.onerror = xhr.ontimeout = () => reject(new Error('Upload interrupted'));
    xhr.send(body);
  });
}

export function sendPrivateAttachmentMessage(view, path, message, files, headers, onProgress) {
  const form = new view.FormData();
  form.set('body', message.body || '');
  if (message.chat_language) form.set('chat_language', message.chat_language);
  if (message.reply_language) form.set('reply_language', message.reply_language);
  for (const file of files) form.append('file',file);
  return uploadForm(view,path,headers,form,onProgress,240_000);
}

export function sendSocialAttachmentMessage(view, path, message, file, headers, onProgress) {
  const form = new view.FormData();
  form.append('file', file);
  if (message.body) form.set('body', message.body);
  if (message.reply_to) form.set('reply_to', message.reply_to);
  if (message.agent_mentions?.length) form.set('agent_mentions', JSON.stringify(message.agent_mentions));
  return uploadForm(view, path, headers, form, onProgress);
}

export function unclearSocialDelivery(status) {
  return !status || status === 408 || status >= 500 || [200, 201].includes(status);
}

export function ownSocialReceipt(message, destination, key) {
  return Boolean(message?.id && message.client_key === key && message.user_id === destination.owner &&
    message.workspace_id === destination.wid && message.conversation_id === destination.conversationId);
}

function errorText(result) {
  const code = result.body?.error?.code;
  if (code === 'reply_unavailable') return '原消息已不可回复，请取消引用后重新选择文件。';
  if (code === 'attachment_storage_full') return '附件存储空间已满。';
  if (code === 'attachment_type_blocked') return '文件格式不受支持，或内容与扩展名不符。';
  if (result.status === 413) return '文件太大，最大支持 8 MB。';
  if ([401, 403, 404].includes(result.status)) return '无法访问这段会话。';
  return '发送失败，点击重试。';
}

export function mountChatFiles(document, {context, ownerId, csrfToken, createKey, confirmDelivery, sent, onDraftChange,
  uiLabel = zh => zh}) {
  const input = document.getElementById('chat-attachment');
  if (!input) return {render() {}, reset() {}};
  const view = document.defaultView;
  const messageList = document.getElementById('message-list');
  const empty = document.getElementById('chat-empty');
  const scroller = document.getElementById('message-scroller');
  const status = document.getElementById('chat-upload-error');
  const jobs = new Set();
  const drafts = new Map();
  const draftRail = document.getElementById('agent-file-draft');
  const field = document.getElementById('chat-body');
  const form = document.getElementById('chat-form');
  const dropHint = document.getElementById('composer-file-drop');
  let dragDepth = 0;
  let dragScope;
  let feedbackScope;
  const draftFiles = scope => (drafts.get(scope) || []).map(item => item.file);
  const make = (tag, text) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    return el;
  };

  function render() {
    const current = context();
    if (dropHint) dropHint.hidden = !dragDepth || !canDrop(current);
    if (feedbackScope !== current?.scope) {
      feedbackScope = current?.scope;
      status.textContent = '';
    }
    for (const job of jobs) {
      if (current?.scope === job.destination.scope) messageList.append(job.node);
      else job.node.remove();
    }
    if (messageList.children.length) empty.hidden = true;
    if (draftRail) {
      const items = current ? drafts.get(current.scope) || [] : [];
      draftRail.hidden = items.length === 0;
      draftRail.replaceChildren(...items.map(item => item.card));
      field.required = items.length === 0;
    }
  }

  function remove(job) {
    jobs.delete(job);
    job.node.remove();
    if (job.preview) view.URL.revokeObjectURL(job.preview);
    empty.hidden = messageList.children.length > 0;
  }

  function confirmFromHistory(scope, messages) {
    let confirmed = false;
    for (const job of jobs) {
      if (job.destination.scope !== scope || !messages.some(message =>
        ownSocialReceipt(message, job.destination, job.key) &&
        (message.attachment || message.retracted))) continue;
      remove(job);
      sent(job.destination);
      confirmed = true;
    }
    if (confirmed) void drain();
  }

  async function drain() {
    const waiting = [...jobs].find(job => job.phase === 'waiting');
    if (!waiting || [...jobs].some(job => job.phase === 'sending')) return;
    const job = waiting;
    job.phase = 'sending';
    job.feedback.textContent = '正在上传…';
    job.progress.removeAttribute('value');
    job.progress.hidden = false;
    job.actions.hidden = true;
    try {
      if (ownerId() !== job.destination.owner) {
        remove(job);
        return;
      }
      const result = await sendSocialAttachmentMessage(view, job.destination.path,
        {reply_to:job.destination.reply?.message_id}, job.file, {
        Accept: 'application/json',
        'X-CSRF-Token': csrfToken(), 'Idempotency-Key': job.key,
      }, percentage => {
        if (percentage < 100) {
          job.progress.value = percentage;
        } else {
          job.progress.hidden = true;
          job.feedback.textContent = '附件已上传，正在确认发送…';
        }
      }).catch(() => null);
      if (!jobs.has(job)) return;
      let message = [200, 201].includes(result?.status) && result.body?.message;
      if (!(message?.attachment || message?.retracted) && unclearSocialDelivery(result?.status) && confirmDelivery) {
        job.progress.hidden = true;
        job.feedback.textContent = document.documentElement?.lang?.startsWith('en') ? 'Checking delivery…' : '正在核对发送结果…';
        message = await confirmDelivery(job.destination, job.key, () => jobs.has(job));
        if (!jobs.has(job)) return;
      }
      if (!(message?.attachment || message?.retracted)) {
        throw new Error(result ? errorText(result) : '连接中断，点击重试。');
      }
      remove(job);
      sent(job.destination, message);
    } catch (error) {
      if (!jobs.has(job)) return;
      job.phase = 'failed';
      job.progress.hidden = true;
      job.feedback.textContent = error instanceof Error ? error.message : '发送失败，点击重试。';
      job.actions.hidden = false;
    } finally {
      void drain();
    }
  }

  function enqueue(file, destination) {
    const {card, preview} = localChatFile(document, file);
    const node = make('li');
    node.className = 'mine';
    node.dataset.filePending = '1';
    const feedback = make('p', '等待上传…');
    feedback.setAttribute('role', 'status');
    const progress = chatUploadProgress(document, '上传进度');
    const actions = make('div');
    actions.className = 'chat-file-actions';
    actions.hidden = true;
    const retry = make('button', '重试');
    const discard = make('button', '移除');
    retry.type = discard.type = 'button';
    const job = {destination, key:createKey(), file, preview, node, feedback, progress, actions, phase:'waiting'};
    retry.addEventListener('click', () => {
      job.phase = 'waiting';
      job.actions.hidden = true;
      job.feedback.textContent = '等待上传…';
      void drain();
    });
    discard.addEventListener('click', () => remove(job));
    actions.append(retry, discard);
    card.append(feedback, progress, actions);
    node.append(card);
    jobs.add(job);
  }

  function clearDraft(scope, files = draftFiles(scope)) {
    const kept = [];
    for (const item of drafts.get(scope) || []) {
      if (files.includes(item.file)) {
        if (item.preview) view.URL.revokeObjectURL(item.preview);
      } else kept.push(item);
    }
    if (kept.length) drafts.set(scope,kept);
    else drafts.delete(scope);
    render();
    onDraftChange?.();
  }

  function stageFiles(scope, files, privateChat, issues) {
    const existing = drafts.get(scope) || [];
    const valid = privateChat ? files.filter(file => AGENT_FILE_EXT.has(file.name.toLowerCase().split('.').at(-1))) : files;
    if (valid.length !== files.length) issues.push(uiLabel('智能体私聊支持图片、PDF、Office 文档和文本文件。',
      'Private agent chat supports images, PDFs, Office documents and text files.'));
    let bytes = existing.reduce((sum,item) => sum + item.file.size,0);
    const before = existing.length;
    let reachedLimit = false;
    for (const file of valid) {
      if (existing.length >= 4) {
        reachedLimit = true;
        break;
      }
      if (privateChat && bytes + file.size > MAX_CHAT_FILE_BYTES) {
        reachedLimit = true;
        continue;
      }
      bytes += file.size;
      const {card, preview} = localChatFile(document, file);
      const remove = make('button','×');
      remove.type = 'button';
      remove.setAttribute('aria-label', uiLabel('移除 ', 'Remove ') + file.name);
      remove.className = 'agent-file-remove';
      remove.addEventListener('click',() => {
        const current = context();
        if (current && draftFiles(current.scope).includes(file)) clearDraft(current.scope,[file]);
      });
      card.append(remove);
      existing.push({file,card,preview});
    }
    if (reachedLimit) issues.push(privateChat
      ? uiLabel('每条消息最多 4 个附件，合计 8 MB。', 'Use up to 4 attachments totaling 8 MB per message.')
      : uiLabel('一次最多选择 4 个附件。', 'Choose up to 4 attachments at a time.'));
    if (existing.length) drafts.set(scope,existing);
    render();
    onDraftChange?.();
    return existing.length - before;
  }

  function addFiles(picked, scope, {stage = false} = {}) {
    const destination = context();
    if (!destination || destination.blocked || !picked.length || (scope !== undefined && destination.scope !== scope)) return 0;
    const issues = [];
    const accepted = picked.filter(file => file.size > 0 && file.size <= MAX_CHAT_FILE_BYTES);
    if (accepted.length !== picked.length) issues.push(uiLabel('空文件和超过 8 MB 的文件无法发送。',
      'Choose nonempty files no larger than 8 MB each.'));
    feedbackScope = destination.scope;
    if (destination.private || stage) {
      const added = stageFiles(destination.scope, accepted, destination.private, issues);
      status.textContent = issues.join(' ');
      return added;
    }
    status.textContent = issues.join(' ');
    for (const file of accepted) enqueue(file, destination);
    render();
    if (accepted.length) scroller.scrollTop = scroller.scrollHeight;
    void drain();
    return accepted.length;
  }

  input.addEventListener('change', () => {
    const picked = [...input.files];
    input.value = '';
    addFiles(picked, undefined, {stage:true});
  });

  field?.addEventListener('paste', event => {
    const destination = context();
    const clipboard = event.clipboardData;
    if (event.defaultPrevented || !destination || destination.blocked || !clipboard?.files?.length) return;
    // A textarea can still insert the text part of a mixed clipboard item normally.
    if (!clipboard.getData('text/plain')) event.preventDefault();
    addFiles([...clipboard.files], destination.scope, {stage:true});
  });

  const fileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  function canDrop(destination) {
    return Boolean(dragScope != null && destination && !destination.blocked && destination.scope === dragScope);
  }
  function clearFileDrag() {
    dragDepth = 0;
    dragScope = undefined;
    if (dropHint) dropHint.hidden = true;
  }
  form?.addEventListener('dragenter', event => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    const destination = context();
    if (dragDepth === 0) dragScope = destination && !destination.blocked ? destination.scope : null;
    dragDepth += 1;
    if (dropHint) dropHint.hidden = !canDrop(destination);
  });
  form?.addEventListener('dragover', event => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canDrop(context()) ? 'copy' : 'none';
  });
  form?.addEventListener('dragleave', () => {
    if (dragDepth && --dragDepth === 0) clearFileDrag();
  });
  form?.addEventListener('drop', event => {
    if (!fileDrag(event)) return;
    event.preventDefault();
    if (canDrop(context())) addFiles([...event.dataTransfer.files], dragScope, {stage:true});
    clearFileDrag();
  });

  return {render,confirmFromHistory,draftFiles,clearDraft,addFiles, forget(scope) {
    clearDraft(scope);
    for (const job of jobs) if (job.destination.scope === scope) remove(job);
  }, moveDraft(from,to) {
    const saved = drafts.get(from);
    if (saved) {
      drafts.set(to,saved);
      drafts.delete(from);
    }
    render();
  }, reset() {
    clearFileDrag();
    for (const scope of drafts.keys()) clearDraft(scope);
    for (const job of jobs) remove(job);
    status.textContent = '';
  }};
}
