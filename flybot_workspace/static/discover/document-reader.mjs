import { renderMarkdown } from '../shell/markdown.mjs';
import { readMarkdownTable, renderMarkdownTable } from '../shell/markdown-table.mjs';

export function mountDocumentReader(document, parent, {read, stillShowing}) {
  const disclosure = document.createElement('details');
  disclosure.className = 'work-document-reader';
  const summary = document.createElement('summary');
  summary.textContent = '展开完整文档';
  const status = document.createElement('p');
  status.className = 'work-document-status';
  status.setAttribute('role', 'status');
  const body = document.createElement('div');
  body.className = 'work-document-body';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重试读取正文';
  retry.hidden = true;
  disclosure.append(summary, status, body, retry);
  parent.append(disclosure);

  const controller = new AbortController();
  let state = 'idle';

  async function load() {
    if (controller.signal.aborted || state === 'loading') return;
    const retryHadFocus = document.activeElement === retry;
    state = 'loading';
    retry.disabled = true;
    body.setAttribute('aria-busy', 'true');
    status.textContent = '正在读取正文…';
    try {
      const result = await read(controller.signal);
      if (controller.signal.aborted || !stillShowing()) return;
      if (result.status === 404) status.textContent = '这件文档已下架或不可访问。';
      else if (result.status !== 200 || typeof result.source !== 'string') throw new Error('Document unavailable');
      else if (!result.source.trim()) status.textContent = '这件文档没有公开正文。';
      else {
        renderMarkdown(document, body, result.source, {readTable:readMarkdownTable, renderTable:renderMarkdownTable, headingOffset:2});
        status.textContent = '';
      }
      state = 'loaded';
      if (retryHadFocus && document.activeElement === retry) summary.focus({preventScroll:true});
      retry.hidden = true;
    } catch {
      if (controller.signal.aborted || !stillShowing()) return;
      body.replaceChildren();
      state = 'failed';
      status.textContent = '暂时无法读取正文。';
      retry.hidden = false;
      retry.disabled = false;
    } finally {
      body.setAttribute('aria-busy', 'false');
    }
  }

  disclosure.addEventListener('toggle', () => {
    summary.textContent = disclosure.open ? '收起完整文档' : '展开完整文档';
    if (disclosure.open && state === 'idle') void load();
  });
  retry.addEventListener('click', load);
  return () => controller.abort();
}
