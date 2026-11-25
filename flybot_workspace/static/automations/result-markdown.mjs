import {renderMarkdown} from '../shell/markdown.mjs';
import {tableMarkdownOptions} from '../shell/markdown-table.mjs';

function renderCode(document, block) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = block.text;
  pre.append(code);
  if (block.language !== 'mermaid' || !block.closed) return pre;

  const diagram = document.createElement('div');
  diagram.append(pre);
  queueMicrotask(async () => {
    try {
      if (!diagram.isConnected) return;
      const {replaceMermaidSource} = await import('../shell/flowchart.mjs');
      await replaceMermaidSource(document, diagram, pre, block.text);
    } catch { /* Keep the source when the optional renderer is unavailable. */ }
  });
  return diagram;
}

export function renderRunMarkdown(document, root, source) {
  const formatted = document.createElement('div');
  renderMarkdown(document, formatted, source, {...tableMarkdownOptions, renderCode, headingOffset:3});
  root.replaceChildren(...formatted.childNodes);
  root.dataset.rendered = 'true';
}
