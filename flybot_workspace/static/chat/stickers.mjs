import { idempotencyKey } from '../shell/chat-utils.mjs';

const STICKERS = '/v1/stickers';
const MAX_STICKER_BYTES = 8 * 1024 * 1024;
const STICKER_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const STICKER_ID = /^[a-f0-9]{32}$/;
const STICKER_CURSOR = /^\d{1,15}\.[a-f0-9]{32}$/;
const SOCIAL_IMAGE = /^\/v1\/workspaces\/[a-f0-9]{32}\/social\/conversations\/[A-Za-z0-9._-]{1,80}\/messages\/[A-Za-z0-9._-]{1,80}\/file$/;
const AGENT_IMAGE = /^\/v1\/workspaces\/[a-f0-9]{32}\/agents\/[a-f0-9]{32}\/conversations\/[a-f0-9]{32}\/messages\/[a-f0-9]{32}\/files\/[0-3]$/;

function stickerItem(row) {
  return typeof row?.id === 'string' && STICKER_ID.test(row.id) && row.path === `${STICKERS}/${row.id}/file` &&
    typeof row.title === 'string' && Number.isSafeInteger(row.bytes) && row.bytes > 0 &&
    row.bytes <= MAX_STICKER_BYTES && STICKER_MIMES.has(row.mime) ? row : null;
}

function imageFileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function uploadSticker(request, file, title, key, signal) {
  return imageFileData(file).then(data => {
    if (signal?.aborted) throw signal.reason;
    return request('POST', STICKERS, {title, mime: file.type, data}, {'Idempotency-Key': key}, signal);
  });
}

async function readStickerImage(response, mime) {
  if (Number(response.headers.get('Content-Length')) > MAX_STICKER_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_STICKER_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return bytes ? new Blob(chunks, {type: mime}) : null;
  } finally { reader.releaseLock(); }
}

export async function saveChatSticker({request, attachment, fetcher = globalThis.fetch, signal}) {
  const path = attachment?.path || '';
  if (!(SOCIAL_IMAGE.test(path) || AGENT_IMAGE.test(path)) || /\/\.{1,2}\//.test(path) ||
      !STICKER_MIMES.has(attachment.mime)) return {status: 400, body: {}};
  if (attachment.bytes > MAX_STICKER_BYTES) return {status: 413, body: {}};
  const response = await fetcher(path, {credentials: 'same-origin', redirect: 'error', signal});
  if (!response.ok) return {status: response.status, body: {}};
  const mime = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
  if (!STICKER_MIMES.has(mime) || mime !== attachment.mime) {
    await response.body?.cancel();
    return {status: 400, body: {}};
  }
  const file = await readStickerImage(response, mime);
  if (!file) return {status: 413, body: {}};
  return uploadSticker(request, file, attachment.title || attachment.filename || 'Sticker', idempotencyKey('sticker'), signal);
}

export function mountChatStickers(document, {request, send, context}) {
  const element = id => document.getElementById(`composer-sticker-${id}`);
  const dialog = document.getElementById('composer-emoji-dialog');
  const panel = element('panel');
  const library = element('library');
  const list = element('list');
  const empty = element('empty');
  const upload = element('upload');
  const fileInput = element('file');
  const manage = element('manage');
  const more = element('more');
  const preview = element('preview');
  const previewImage = element('preview-image');
  const previewTitle = element('preview-title');
  const previewClose = element('preview-close');
  const sendButton = element('send');
  const status = element('status');
  const retryButton = element('retry');
  const text = (zh, en) => document.documentElement.lang.startsWith('en') ? en : zh;
  let state = null;

  function current(view) {
    const live = context();
    return Boolean(view && view === state && dialog.open && live &&
      live.owner === view.target.owner && live.scope === view.target.scope);
  }

  function notice(message = '', retry = null) {
    status.textContent = message;
    if (state) state.retry = retry;
    retryButton.hidden = !retry;
  }

  function enterPreview(view, row) {
    if (!current(view) || view.busy) return;
    view.selected = row;
    previewImage.src = row.path;
    previewTitle.textContent = row.title;
    library.hidden = true;
    preview.hidden = false;
    notice();
    sendButton.focus();
  }

  function exitPreview(view) {
    view.selected = null;
    preview.hidden = true;
    previewImage.removeAttribute('src');
    previewTitle.textContent = '';
    library.hidden = false;
  }

  function makeChoice(row, id, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset[id] = row.id;
    button.setAttribute('aria-label', `${label} ${row.title}`);
    return button;
  }

  function render(view) {
    list.replaceChildren();
    for (const row of view.rows.values()) {
      const item = document.createElement('li');
      const tile = makeChoice(row, 'stickerId', view.managing ? text('预览', 'Preview') : text('发送', 'Send'));
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.src = row.path;
      const title = document.createElement('span');
      title.textContent = row.title;
      tile.className = 'composer-sticker-tile';
      tile.append(image, title);
      const secondary = view.managing ? makeChoice(row, 'removeSticker', text('移除', 'Remove'))
        : makeChoice(row, 'previewSticker', text('预览', 'Preview'));
      secondary.className = 'composer-sticker-secondary';
      secondary.textContent = view.managing ? text('移除', 'Remove') : text('预览', 'Preview');
      item.append(tile, secondary);
      list.append(item);
    }
    manage.hidden = !view.rows.size;
    manage.setAttribute('aria-pressed', String(view.managing));
    more.hidden = !view.cursor;
    empty.hidden = !view.loaded || view.rows.size > 0 || Boolean(view.cursor);
  }

  function busy(view, active) {
    view.busy = active;
    list.setAttribute('aria-busy', String(active));
    upload.disabled = manage.disabled = more.disabled = sendButton.disabled = active;
  }

  async function load(view, append = false) {
    if (!current(view) || view.busy) return;
    const cursor = append ? view.cursor : '';
    if (append && !cursor) return;
    const focusNew = append && document.activeElement === more;
    busy(view, true);
    notice(text('正在读取贴纸…', 'Loading stickers…'));
    try {
      const query = new URLSearchParams({limit: '24'});
      if (cursor) query.set('cursor', cursor);
      const result = await request('GET', `${STICKERS}?${query}`, undefined, undefined, view.abort.signal);
      if (!current(view)) return;
      if ([401, 403].includes(result.status)) {
        view.rows.clear();
        view.cursor = '';
        render(view);
      }
      if (result.status !== 200 || !Array.isArray(result.body.items)) throw new Error('list');
      const offset = view.rows.size;
      if (!append) view.rows.clear();
      for (const row of result.body.items) if (stickerItem(row)) view.rows.set(row.id, row);
      view.cursor = STICKER_CURSOR.test(result.body.cursor || '') && result.body.cursor !== cursor ? result.body.cursor : '';
      view.loaded = true;
      render(view);
      notice();
      busy(view, false);
      if (focusNew) (list.children[offset]?.firstElementChild || upload).focus();
    } catch {
      if (current(view)) notice(text('贴纸读取失败，请重试。', 'Stickers could not load. Try again.'), () => load(view, append));
    } finally { if (current(view)) busy(view, false); }
  }

  async function add(view, file, key = idempotencyKey('sticker')) {
    if (!current(view) || view.busy) return;
    if (!STICKER_MIMES.has(file.type) || !file.size) {
      notice(text('请选择 PNG、JPEG、GIF 或 WebP 图片。', 'Choose a PNG, JPEG, GIF, or WebP image.'));
      return;
    }
    if (file.size > MAX_STICKER_BYTES) {
      notice(text('贴纸最大为 8 MB。', 'Stickers can be up to 8 MB.'));
      return;
    }
    busy(view, true);
    notice(text('正在添加贴纸…', 'Adding sticker…'));
    try {
      const result = await uploadSticker(request, file, file.name, key, view.abort.signal);
      if (!current(view)) return;
      const sticker = stickerItem(result.body.sticker);
      if (result.status === 400 || result.status === 413) {
        notice(text('无法添加这张图片。请换一张不超过 8 MB 的有效图片。', 'Choose a valid image up to 8 MB.'));
        return;
      }
      if (result.status === 410) {
        notice(text('此贴纸已移除。可以重新选择图片添加。', 'This sticker was removed. Choose the image again to add it.'));
        return;
      }
      if (![200, 201].includes(result.status) || !sticker) throw new Error('upload');
      view.rows.delete(sticker.id);
      view.rows = new Map([[sticker.id, sticker], ...view.rows]);
      render(view);
      notice(text('贴纸已添加。', 'Sticker added.'));
    } catch {
      if (current(view)) notice(text('贴纸添加失败，请重试。', 'Could not add the sticker. Try again.'), () => add(view, file, key));
    } finally { if (current(view)) busy(view, false); }
  }

  async function remove(view, row) {
    if (!current(view) || view.busy) return;
    const index = [...view.rows.keys()].indexOf(row.id);
    busy(view, true);
    notice();
    try {
      const result = await request('POST', `${STICKERS}/${row.id}`, {action: 'remove'}, undefined, view.abort.signal);
      if (!current(view)) return;
      if (result.status !== 200 || result.body.removed !== true) throw new Error('remove');
      const restoreFocus = document.activeElement?.dataset.removeSticker === row.id;
      view.rows.delete(row.id);
      if (!view.rows.size) view.managing = false;
      render(view);
      notice(text('已从贴纸库移除。', 'Sticker removed from your library.'));
      busy(view, false);
      if (restoreFocus) {
        const buttons = list.querySelectorAll('[data-remove-sticker]');
        (buttons[Math.min(index, buttons.length - 1)] || upload).focus();
      }
    } catch {
      if (current(view)) notice(text('移除失败，请重试。', 'Could not remove the sticker. Try again.'), () => remove(view, row));
    } finally { if (current(view)) busy(view, false); }
  }

  async function sendSelected(view, row) {
    if (!current(view) || view.busy || !row) return;
    busy(view, true);
    notice();
    try {
      if (await send(row, view.target) !== true) throw new Error('send');
      if (!current(view)) return;
      dialog.close();
      document.getElementById('chat-body').focus();
    } catch {
      if (current(view)) notice(text('无法发送贴纸，请重试。', 'Could not send the sticker. Try again.'), () => sendSelected(view, row));
    } finally { if (current(view)) busy(view, false); }
  }

  upload.addEventListener('click', () => { if (current(state)) fileInput.click(); });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void add(state, file);
  });
  manage.addEventListener('click', () => {
    if (!current(state) || state.busy) return;
    state.managing = !state.managing;
    render(state);
  });
  more.addEventListener('click', () => void load(state, true));
  retryButton.addEventListener('click', () => state?.retry?.());
  list.addEventListener('click', event => {
    if (!current(state) || state.busy) return;
    const action = event.target.closest('button');
    const {stickerId, previewSticker, removeSticker} = action?.dataset || {};
    const row = state.rows.get(stickerId || previewSticker || removeSticker);
    if (!row) return;
    if (removeSticker) void remove(state, row);
    else if (previewSticker || state.managing) enterPreview(state, row);
    else void sendSelected(state, row);
  });
  previewClose.addEventListener('click', () => {
    if (!current(state)) return;
    const id = state.selected?.id;
    exitPreview(state);
    (list.querySelector(`[data-preview-sticker="${id}"]`) || list.querySelector(`[data-sticker-id="${id}"]`) || upload).focus();
  });
  sendButton.addEventListener('click', () => void sendSelected(state, state?.selected));

  function close() {
    if (!state) return;
    state.abort.abort();
    exitPreview(state);
    busy(state, false);
    state = null;
    notice();
    list.replaceChildren();
    fileInput.value = '';
  }

  function sync() {
    if (state && !current(state)) {
      close();
      if (dialog.open) dialog.close();
    }
  }

  return {
    open() {
      if (panel.hidden || !dialog.open) return;
      sync();
      const target = context();
      if (!target || !dialog.open || state) return;
      state = {target, rows: new Map(), abort: new AbortController(), cursor: ''};
      render(state);
      void load(state);
    },
    close,
    sync,
  };
}
