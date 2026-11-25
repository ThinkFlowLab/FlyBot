// Original, dependency-free markdown document surface. No stored HTML is executed.
import { renderMarkdown, domToMarkdown } from './markdown.mjs';
import { editRichTable, insertRichTable, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, tableMarkdownOptions } from './markdown-table.mjs';
import { bindDocumentFind } from './document-find.mjs';

export function bindDocumentEditor(document, form) {
  const root = document.getElementById('document-rich');
  const panel = document.getElementById('document-editor');
  const source = document.getElementById('document-source');
  const toggle = document.getElementById('document-source-toggle');
  const count = document.getElementById('document-length');
  const tableActions = document.getElementById('document-table-actions');
  const find = bindDocumentFind(document, root, form);
  let active = false, sourceMode = false, dirty = false;
  let activeCell;
  const render = markdown => renderMarkdown(document, root, markdown, tableMarkdownOptions);
  const flush = () => {
    if (!active) return;
    if (sourceMode) form.elements.body.value = source.value;
    else if (dirty) form.elements.body.value = domToMarkdown(root);
    if (count) {
      const size = form.elements.body.value.length;
      count.hidden = size <= 8000;
      count.textContent = `正文 ${size} / 8000 字符，超出上限时不能保存。`;
    }
  };
  const updateMode = () => {
    if (root) root.hidden = sourceMode;
    if (source) source.hidden = !sourceMode;
    if (toggle) toggle.setAttribute('aria-pressed', String(sourceMode));
    for (const button of document.querySelectorAll('[data-doc-format]')) button.disabled = sourceMode;
    find.setEnabled(active && !sourceMode);
    syncTableActions();
  };

  function syncTableActions() {
    if (!tableActions || !root) return;
    const focus = document.getSelection?.()?.focusNode;
    const cell = (focus?.nodeType === 1 ? focus : focus?.parentElement)?.closest('th, td');
    if (active && !sourceMode && cell && root.contains(cell) && cell.closest('.chat-markdown-table')) activeCell = cell;
    else if (!active || sourceMode || !activeCell || !root.contains(activeCell) || !tableActions.contains(document.activeElement)) activeCell = null;
    tableActions.hidden = !activeCell;
    if (!activeCell) {
      tableActions.open = false;
      return;
    }
    const table = activeCell.closest('table');
    const columns = table.rows[0].cells.length;
    tableActions.querySelector('[data-doc-table="add-row"]').disabled = table.rows.length - 1 >= MAX_TABLE_ROWS;
    tableActions.querySelector('[data-doc-table="add-column"]').disabled = columns >= MAX_TABLE_COLUMNS;
    tableActions.querySelector('[data-doc-table="remove-row"]').disabled = activeCell.parentElement.rowIndex === 0;
    tableActions.querySelector('[data-doc-table="remove-column"]').disabled = columns <= 1;
  }

  function insertTable() {
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    const block = Array.from(root.children).find(node => node.contains(selection?.focusNode));
    if (block) range.setStartAfter(block);
    else if (selection?.focusNode === root) range.setStart(root, selection.focusOffset);
    range.collapse(true);
    const markdown = '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |';
    if (insertRichTable(document, root, markdown, range)) {
      dirty = true;
      flush();
      syncTableActions();
    }
  }

  if (tableActions && root) {
    document.addEventListener('selectionchange', syncTableActions);
    panel.addEventListener('focusout', event => {
      if (panel.contains(event.relatedTarget)) return;
      activeCell = null;
      tableActions.hidden = true;
      tableActions.open = false;
    });
    tableActions.addEventListener('click', event => {
      const command = event.target.closest('[data-doc-table]');
      if (!command || command.disabled || !active || sourceMode || !root.contains(activeCell)) return;
      if (!editRichTable(document, root, activeCell, command.dataset.docTable)) return;
      dirty = true;
      flush();
      tableActions.open = false;
      syncTableActions();
    });
    tableActions.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !tableActions.open) return;
      event.preventDefault();
      tableActions.open = false;
      tableActions.querySelector('summary').focus();
    });
  }
  if (root) {
    root.addEventListener('input', () => { dirty = true; flush(); });
    root.addEventListener('paste', event => {
      const text = event.clipboardData && event.clipboardData.getData('text/plain');
      if (text == null) return;
      event.preventDefault();
      document.execCommand('insertText', false, text);
    });
  }
  if (source) source.addEventListener('input', flush);
  if (toggle) toggle.addEventListener('click', () => {
    flush();
    sourceMode = !sourceMode;
    if (sourceMode) source.value = form.elements.body.value;
    else { render(form.elements.body.value); dirty = false; }
    updateMode();
    (sourceMode ? source : root).focus();
  });
  for (const button of document.querySelectorAll('[data-doc-format]')) {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      if (!active || sourceMode || !root) return;
      const kind = button.dataset.docFormat;
      if (kind === 'table') return insertTable();
      root.focus();
      const selection = document.getSelection();
      if (!selection || !root.contains(selection.anchorNode)) return;
      const command = {undo: 'undo', redo: 'redo', bold: 'bold', italic: 'italic', strike: 'strikeThrough',
        ul: 'insertUnorderedList', ol: 'insertOrderedList', hr: 'insertHorizontalRule'}[kind];
      if (command) document.execCommand(command, false, null);
      else {
        const tag = {h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', code: 'pre'}[kind];
        if (tag) document.execCommand('formatBlock', false,
          String(document.queryCommandValue('formatBlock')).toLowerCase() === tag ? 'p' : tag);
      }
      dirty = true; flush();
    });
  }
  return {
    flush,
    find: find.open,
    closeFind: find.close,
    load(markdown, enabled) {
      active = enabled; dirty = false; sourceMode = false;
      activeCell = null;
      find.close();
      if (panel) panel.hidden = !enabled;
      if (!enabled) syncTableActions();
      if (!enabled || !root || !source) return;
      render(markdown);
      source.value = markdown;
      if (count) count.hidden = true;
      updateMode();
    },
  };
}
