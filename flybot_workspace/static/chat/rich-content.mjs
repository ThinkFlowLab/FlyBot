import { markdownToBlocks, renderMarkdown, renderMarkdownBlocks } from '../shell/markdown.mjs';
import { readMarkdownTable, renderMarkdownTable } from '../shell/markdown-table.mjs';
import { renderChatCodeBlock } from './code-block.mjs';
import { richPreviewButton } from './rich-preview.mjs';

let flowchartModule;
const streamingBlocks = new WeakMap();

export function hasExplicitRichContent(source) {
  if (!/[|]|\x60{3}|~{3}/.test(source)) return false;
  return markdownToBlocks(source, {readTable:readMarkdownTable}).some(block =>
    block.type === 'table' || (block.type === 'code' && (block.closed || block.language === 'mermaid')));
}

function renderCode(document, block) {
  const code = renderChatCodeBlock(document, block);
  const english = document.documentElement?.lang === 'en';
  const label = english ? 'Code' : '代码';
  code.dataset.summary = block.language ? `${label} · ${block.language}` : label;
  if (block.language !== 'mermaid' || !block.closed) return code;

  const container = document.createElement('div');
  container.className = 'chat-diagram';
  container.dataset.summary = english ? 'Mermaid diagram' : 'Mermaid 图表';
  container.append(code);
  queueMicrotask(() => {
    if (!container.isConnected) return;
    const fold = container.closest('details:not([open])');
    if (!fold) void showFlowchart(document, container, code, block.text);
    else fold.addEventListener('toggle', function onOpen() {
      if (!fold.open) return;
      fold.removeEventListener('toggle', onOpen);
      void showFlowchart(document, container, code, block.text);
    });
  });
  return container;
}

async function showFlowchart(document, container, code, text) {
  flowchartModule ??= import('../shell/flowchart.mjs').catch(() => {
    flowchartModule = undefined;
    return null;
  });
  try {
    const module = await flowchartModule;
    const diagram = await module?.replaceMermaidSource(document, container, code, text);
    if (diagram?.firstElementChild && container.isConnected) {
      const english = document.documentElement?.lang === 'en';
      const name = diagram.getAttribute('aria-label') || (english ? 'Diagram' : '图表');
      const actions = document.createElement('div');
      actions.className = 'chat-diagram-actions';
      actions.append(richPreviewButton(document, 'diagram', () => diagram.firstElementChild, name));
      container.append(actions);
    }
  } catch {
    // Leave the original code visible if the chart renderer fails.
  }
}

function renderChatTable(document, block, appendCell) {
  const english = document.documentElement?.lang === 'en';
  const label = (zh,en) => english ? en : zh;
  const card = document.createElement('div');
  card.className = 'chat-table-block';
  const region = renderMarkdownTable(document, block, appendCell);
  const toolbar = document.createElement('div');
  toolbar.className = 'chat-table-toolbar';
  const status = document.createElement('span');
  status.className = 'chat-table-status';
  status.setAttribute('role', 'status');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'chat-table-copy';
  copy.textContent = label('复制表格', 'Copy table');
  copy.addEventListener('click', async () => {
    const table = region.firstElementChild;
    const view = document.defaultView;
    const text = Array.from(table.rows, row => Array.from(row.cells, cell =>
      (cell.innerText ?? cell.textContent ?? '').replace(/[\r\n\t]+/g, ' ').trim()).join('\t')).join('\n');
    try {
      await view.navigator.clipboard.writeText(text);
      status.textContent = label('表格已复制。', 'Table copied.');
    } catch {
      if (!region.isConnected) return;
      const selection = view?.getSelection?.();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(region.firstElementChild);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      status.textContent = selection ? label('已选中表格，请手动复制。', 'Table selected. Copy it manually.')
        : label('无法访问剪贴板。', 'Clipboard unavailable.');
    }
  });
  const preview = richPreviewButton(document, 'table', () => region.firstElementChild, label('表格', 'Table'));
  toolbar.append(status, copy, preview);
  card.append(toolbar, region);
  return card;
}

const markdownOptions = {readTable:readMarkdownTable, renderTable:renderChatTable, renderCode};

export function renderChatMarkdown(document, node, source) {
  node.className = 'chat-markdown';
  renderMarkdown(document, node, source, markdownOptions);
}

function renderStreamingCode(document, block) {
  if (block.language !== 'mermaid' || block.closed) return renderCode(document, block);
  const pending = document.createElement('p');
  pending.className = 'chat-diagram-pending';
  pending.textContent = document.documentElement?.lang === 'en' ? 'Writing diagram…' : '正在生成图表…';
  return pending;
}

export function renderStreamingMarkdown(document, node, source, {complete = false} = {}) {
  const blocks = markdownToBlocks(source, markdownOptions);
  const previous = streamingBlocks.get(node) || [];
  const signatures = blocks.map(block => !complete && block.type === 'code' && block.language === 'mermaid' && !block.closed
    ? 'pending diagram' : JSON.stringify(block));
  let unchanged = 0;
  while (unchanged < signatures.length && previous[unchanged] === signatures[unchanged]) unchanged += 1;

  const tail = node.children[unchanged];
  const region = blocks[unchanged]?.type === 'table' && tail?.classList.contains('chat-table-block')
    ? tail.querySelector('.chat-markdown-table-scroll') : null;
  const keep = region ? unchanged + 1 : unchanged;
  while (node.children.length > keep) node.children[node.children.length - 1].remove();
  if (region) {
    const replacement = document.createElement('div');
    renderMarkdownBlocks(document, replacement, [blocks[unchanged]], {...markdownOptions, renderTable:renderMarkdownTable});
    const left = region.scrollLeft;
    region.replaceChildren(...replacement.firstElementChild.children);
    region.scrollLeft = left;
    tail.querySelector('.chat-table-status').textContent = '';
  }
  renderMarkdownBlocks(document, node, blocks.slice(keep), complete ? markdownOptions : {...markdownOptions, renderCode:renderStreamingCode});
  streamingBlocks.set(node, signatures);
}
