import {artifactKindLabel} from '../shell/thumb.mjs';
import {renderMarkdown} from '../shell/markdown.mjs';
import {tableMarkdownOptions} from '../shell/markdown-table.mjs';
import {compareDocumentLines} from './studio-merge.mjs';

const FORMATS = {
  document: [['docx','Word DOCX'], ['pdf','文本 PDF']],
  slides: [['pptx','PowerPoint PPTX'], ['pdf','提纲 PDF']],
  spreadsheet: [['xlsx','Excel XLSX']],
  dashboard: [['xlsx','Excel XLSX'], ['pdf','数据 PDF']],
};

function appendText(parent, tag, text) {
  const element = parent.ownerDocument.createElement(tag);
  element.textContent = String(text ?? '');
  parent.append(element);
  return element;
}

function previewWorkbook(root, sheets) {
  const chooser = appendText(root,'select','');
  chooser.setAttribute('aria-label','预览工作表');
  const contents = appendText(root,'div','');
  for (const [index, sheet] of sheets.entries()) {
    const option = appendText(chooser,'option',sheet.name);
    option.value = String(index);
  }
  function display() {
    contents.replaceChildren();
    const rows = sheets[Number(chooser.value)]?.rows || [];
    const width = Math.max(0, ...rows.map(row => row.length));
    if (rows.length > 20 || width > 10) appendText(contents,'p','显示前 20 行、前 10 列。导出可查看完整工作表。');
    const table = appendText(contents,'table','');
    for (const row of rows.slice(0,20)) {
      const line = appendText(table,'tr','');
      for (const value of row.slice(0,10)) appendText(line,'td',value);
    }
  }
  chooser.addEventListener('change',display);
  display();
}

export function renderWorkVersion(root, version, exportPath, {source = false} = {}) {
  root.replaceChildren();
  if (version.kind === 'document' && typeof version.body === 'string' && version.body.trim() && !source) {
    renderMarkdown(root.ownerDocument, root, version.body, tableMarkdownOptions);
  } else if (typeof version.body === 'string') {
    if (version.kind === 'website') appendText(root,'p','已保存的网站源代码');
    appendText(root,'pre',version.body || '此版本的正文为空。');
  } else if (version.slides?.slides?.length) {
    for (const slide of version.slides.slides) {
      appendText(root,'h3',slide.title);
      const list = appendText(root,'ul','');
      for (const bullet of slide.bullets) appendText(list,'li',bullet);
    }
  } else if (version.spreadsheet?.sheets?.length) {
    previewWorkbook(root, version.spreadsheet.sheets);
  } else if (version.dashboard?.widgets?.length) {
    for (const widget of version.dashboard.widgets) {
      appendText(root,'h3',widget.title);
      if (widget.type === 'metric') {
        appendText(root,'p',widget.value);
        if (widget.note) appendText(root,'p',widget.note);
      } else if (widget.type === 'table') {
        const table = appendText(root,'table','');
        for (const row of [widget.columns,...widget.rows]) {
          const line = appendText(table,'tr','');
          for (const value of row) appendText(line,'td',value);
        }
      } else if (widget.type === 'bar') {
        const list = appendText(root,'ul','');
        for (const [index, label] of widget.labels.entries()) appendText(list,'li',label + ' · ' + widget.values[index]);
      }
    }
  } else if (version.kind === 'whiteboard' || /^image\/(?:png|jpeg|webp|gif)$/.test(version.media?.mime || '')) {
    const image = appendText(root,'img','');
    image.src = exportPath;
    image.alt = version.title;
  } else if (/^(?:video\/(?:mp4|webm)|audio\/(?:mpeg|mp4|ogg|wav|webm))$/.test(version.media?.mime || '')) {
    const media = appendText(root,version.media.mime.startsWith('video/') ? 'video' : 'audio','');
    media.controls = true;
    media.preload = 'none';
    media.src = exportPath;
  } else {
    appendText(root,'p',version.media?.filename || '此版本可导出查看。');
  }
}

function renderVersionComparison(root, historical, current) {
  root.replaceChildren();
  appendText(root, 'p', `历史修订 ${historical.revision} → 当前已保存修订 ${current.revision}`);
  if (historical.title !== current.title) {
    appendText(root, 'h3', '标题变化');
    appendText(root, 'p', '历史 · ' + historical.title);
    appendText(root, 'p', '当前 · ' + current.title);
  }
  const {before, after, edits} = compareDocumentLines(historical.body, current.body);
  if (!edits || edits.length > 120) {
    appendText(root, 'p', '显示两份完整正文。');
    appendText(root, 'h3', '历史正文');
    appendText(root, 'pre', before.join(''));
    appendText(root, 'h3', '当前正文');
    appendText(root, 'pre', after.join(''));
    return;
  }
  if (!edits.length) {
    appendText(root, 'p', '正文相同。');
    return;
  }
  for (const {from, to, items} of edits) {
    const group = appendText(root, 'section', '');
    group.className = 'work-version-diff';
    appendText(group, 'h3', `历史正文第 ${from + 1} 行附近`);
    if (to > from) {
      appendText(group, 'p', '仅在历史版本');
      appendText(group, 'pre', before.slice(from, to).join('')).dataset.change = 'historical';
    }
    if (items.length) {
      appendText(group, 'p', '仅在当前版本');
      appendText(group, 'pre', items.join('')).dataset.change = 'current';
    }
  }
}

export function mountWorkVersion(document, {read, closeAddress}) {
  const get = name => document.getElementById('work-version-' + name);
  const dialog = get('dialog');
  if (typeof dialog?.showModal !== 'function') return null;
  const title = get('title'), meta = get('meta'), preview = get('preview'), status = get('status');
  const tools = get('tools'), format = get('format'), download = get('download');
  const field = get('link'), copy = get('copy'), retry = get('retry');
  const source = get('source'), compare = get('compare');
  const closeButton = get('close'), restore = get('restore'), review = get('restore-review');
  const restoreSummary = get('restore-summary'), cancelRestore = get('restore-cancel'), confirmRestore = get('restore-confirm');
  const view = document.defaultView;
  let state;

  function close({user = false} = {}) {
    const previous = state;
    if (user && previous?.restoring) return;
    state = null;
    previous?.controller.abort();
    previous?.comparison?.abort();
    if (dialog.open) dialog.close();
    preview.replaceChildren();
    field.value = status.textContent = '';
    field.hidden = true;
    review.hidden = true;
    if (user && previous?.current()) {
      closeAddress(previous);
      const focus = previous.trigger?.isConnected ? previous.trigger : document.getElementById('editor-title');
      focus?.focus({preventScroll:true});
    }
  }

  function showSnapshot(target, raw = false) {
    target.comparison?.abort();
    target.comparison = null;
    target.mode = raw ? 'source' : 'preview';
    source.setAttribute('aria-pressed', String(raw));
    compare.setAttribute('aria-pressed', 'false');
    preview.setAttribute('aria-label', '历史版本内容');
    restore.disabled = Boolean(target.restoring);
    status.textContent = '';
    renderWorkVersion(preview, target.version, target.path + '/export', {source:raw});
    preview.scrollTop = 0;
  }

  function syncExport(target) {
    const selected = format.value;
    download.href = target.path + '/export' + (selected === 'original' ? '' : '?format=' + encodeURIComponent(selected));
  }

  async function load(target) {
    status.textContent = '正在读取此版本…';
    tools.hidden = retry.hidden = true;
    source.hidden = compare.hidden = true;
    const signal = AbortSignal.any([target.controller.signal, AbortSignal.timeout(12000)]);
    const result = await read(target.path, signal).catch(() => ({status:0,body:{}}));
    if (state !== target || !target.current()) return;
    const version = result.body?.version;
    if (result.status !== 200 || version?.revision !== target.revision || typeof version.title !== 'string') {
      retry.hidden = result.status === 404;
      status.textContent = result.status === 404 ? '此版本已不存在，或你没有访问权限。' : '无法读取此版本，请重试。';
      return;
    }
    title.textContent = version.title;
    meta.textContent = '只读 · 修订 ' + version.revision + ' · ' + artifactKindLabel(version.kind,version.media?.mime);
    if (Number.isSafeInteger(version.restored_from)) meta.textContent += ' · 恢复自修订 ' + version.restored_from;
    format.replaceChildren();
    const choices = Object.hasOwn(FORMATS,version.kind) ? FORMATS[version.kind] : [];
    for (const [value, label] of [['original','原格式'],...choices]) {
      const option = appendText(format,'option',label);
      option.value = value;
    }
    target.version = version;
    showSnapshot(target);
    const documentVersion = version.kind === 'document' && typeof version.body === 'string';
    source.hidden = !documentVersion;
    compare.hidden = !documentVersion || !target.latestPath;
    syncExport(target);
    status.textContent = '';
    tools.hidden = false;
    restore.hidden = !target.canRestore?.();
  }

  source.addEventListener('click', () => {
    const target = state;
    if (target?.current() && review.hidden && target.version?.kind === 'document') showSnapshot(target, target.mode !== 'source');
  });
  compare.addEventListener('click', async () => {
    const target = state;
    if (!target?.current() || !review.hidden || target.version?.kind !== 'document' || !target.latestPath) return;
    if (target.mode === 'comparison') return showSnapshot(target);
    target.mode = 'comparison';
    target.comparedRevision = null;
    source.setAttribute('aria-pressed', 'false');
    compare.setAttribute('aria-pressed', 'true');
    restore.disabled = true;
    const controller = new AbortController();
    target.comparison = controller;
    status.textContent = '正在读取当前已保存版本…';
    const signal = AbortSignal.any([target.controller.signal, controller.signal, AbortSignal.timeout(12000)]);
    const result = await read(target.latestPath, signal).catch(() => ({status:0}));
    if (state !== target || target.comparison !== controller || !target.current()) return;
    target.comparison = null;
    const current = result.body?.artifact;
    if (result.status !== 200 || current?.id !== target.id || current.workspace_id !== target.workspace ||
        current.kind !== 'document' || !Number.isSafeInteger(current.revision) ||
        typeof current.title !== 'string' || typeof current.body !== 'string') {
      showSnapshot(target);
      status.textContent = '无法读取当前已保存版本，请重试对比。';
      return;
    }
    target.comparedRevision = current.revision;
    restore.disabled = false;
    preview.setAttribute('aria-label', '与当前已保存版本的对比');
    renderVersionComparison(preview, target.version, current);
    preview.scrollTop = 0;
    status.textContent = '';
  });

  closeButton.addEventListener('click',()=>close({user:true}));
  dialog.addEventListener('cancel',event=>{
    event.preventDefault();
    close({user:true});
  });
  format.addEventListener('change',()=>{ if (state?.current()) syncExport(state); });
  retry.addEventListener('click',()=>{ if (state?.current()) void load(state); });
  copy.addEventListener('click',async ()=>{
    const target = state;
    const link = field.value;
    try {
      await view.navigator.clipboard.writeText(link);
      if (state === target) status.textContent = '已复制版本链接。';
    } catch {
      if (state !== target) return;
      field.hidden = false;
      field.focus();
      field.select();
      status.textContent = '已选中版本链接，可手动复制。';
    }
  });
  restore.addEventListener('click',() => {
    const target = state;
    if (!target?.current() || target.comparison || target.restoring || !target.canRestore?.()) return;
    const initial = target.reviewRestore();
    if (typeof initial === 'string') {
      status.textContent = initial;
      return;
    }
    if (target.comparedRevision != null && initial.revision !== target.comparedRevision) {
      status.textContent = '当前已保存修订已变化。关闭预览并查看最新版本后，再恢复。';
      return;
    }
    target.restoreReview ??= initial;
    restoreSummary.textContent = `从修订 ${target.revision} 创建新修订。当前修订 ${target.restoreReview.revision} 会保留在版本历史中。`;
    review.hidden = false;
    status.textContent = '';
    confirmRestore.textContent = '确认恢复';
    confirmRestore.focus();
  });
  cancelRestore.addEventListener('click', () => {
    if (!state || state.restoring) return;
    if (!state.uncertainRestore) state.restoreReview = null;
    review.hidden = true;
    restore.focus();
  });
  confirmRestore.addEventListener('click', async () => {
    const target = state;
    if (!target?.current() || target.restoring || !target.restoreReview || review.hidden) return;
    target.restoring = true;
    closeButton.disabled = restore.disabled = confirmRestore.disabled = cancelRestore.disabled = true;
    status.textContent = '正在恢复已选版本…';
    let result;
    try {
      result = await target.submitRestore(target.restoreReview);
    } catch {
      result = {uncertain:true, message:'暂未确认服务器是否已恢复。可重试确认或重新打开作品查看。'};
    } finally {
      target.restoring = false;
      if (state === target || !state) {
        closeButton.disabled = restore.disabled = confirmRestore.disabled = cancelRestore.disabled = false;
      }
    }
    if (state !== target || !target.current()) return;
    if (result.saved) return close({user:true});
    target.uncertainRestore = result.uncertain;
    status.textContent = result.message;
    if (result.uncertain) {
      confirmRestore.textContent = '重试确认';
      confirmRestore.focus();
      return;
    }
    target.restoreReview = null;
    review.hidden = true;
    restore.hidden = result.conflict || !target.canRestore();
    (restore.hidden ? closeButton : restore).focus();
  });

  return {
    close,
    open(target) {
      close();
      state = {...target,controller:new AbortController()};
      closeButton.disabled = restore.disabled = confirmRestore.disabled = cancelRestore.disabled = false;
      title.textContent = target.title;
      meta.textContent = '只读 · 修订 ' + target.revision;
      field.value = new URL(target.href, view.location.origin).href;
      dialog.showModal();
      void load(state);
    },
  };
}
