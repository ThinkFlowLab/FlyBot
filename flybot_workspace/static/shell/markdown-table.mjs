import { domToMarkdown, renderMarkdown } from './markdown.mjs';

export const MAX_TABLE_COLUMNS = 24;
export const MAX_TABLE_ROWS = 120;
const MAX_LINE_LENGTH = 16_384;
const SEPARATOR = /^:?-+:?$/;
const BLOCK_START = /^(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|~~~)/;

// Match equal backtick runs in one pass. An unmatched run is ordinary text.
function codeClosers(line) {
  const runs = Array.from(line.matchAll(/`+/g));
  const byLength = new Map();
  const closers = new Map();
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    const length = run[0].length;
    const next = byLength.get(length);
    if (next !== undefined) closers.set(run.index, next + length);
    byLength.set(length, run.index);
  }
  return closers;
}

function pipeRow(source, {separator = false} = {}) {
  if (!source || source.length > MAX_LINE_LENGTH || !source.includes('|')) return null;
  const line = source.trim();
  if (!separator && BLOCK_START.test(line)) return null;
  const closers = codeClosers(line);
  if (line.startsWith('```') && !closers.has(0)) return null;
  const cells = [];
  let field = '';
  let firstPipe = -1;
  let lastPipe = -1;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      const escaped = line[i + 1];
      field += escaped === '|' ? '|' : char + escaped;
      i += 1;
      continue;
    }
    const codeEnd = closers.get(i);
    if (codeEnd !== undefined) {
      field += line.slice(i, codeEnd).replace(/\\\|/g, '|');
      i = codeEnd - 1;
      continue;
    }
    if (char === '|') {
      if (firstPipe === -1) firstPipe = i;
      lastPipe = i;
      cells.push(field.trim());
      if (cells.length > MAX_TABLE_COLUMNS + 1) return null;
      field = '';
    } else field += char;
  }
  if (firstPipe === -1) return null;
  cells.push(field.trim());
  if (firstPipe === 0) cells.shift();
  if (lastPipe === line.length - 1) cells.pop();
  return cells.length && cells.length <= MAX_TABLE_COLUMNS ? cells : null;
}

export function readMarkdownTable(lines, index) {
  if (!lines[index + 1]?.includes('-')) return null;
  const header = pipeRow(lines[index]);
  const separator = header && pipeRow(lines[index + 1], {separator:true});
  if (!separator || header.length !== separator.length || !separator.every(cell => SEPARATOR.test(cell))) return null;

  const alignments = separator.map(cell => {
    if (cell.startsWith(':')) return cell.endsWith(':') ? 'center' : 'left';
    return cell.endsWith(':') ? 'right' : null;
  });
  const rows = [];
  let next = index + 2;
  while (next < lines.length && rows.length < MAX_TABLE_ROWS) {
    const row = pipeRow(lines[next]);
    if (!row) break;
    rows.push(header.map((_, column) => row[column] ?? ''));
    next += 1;
  }
  return {next, block: {type:'table', alignments, header, rows}};
}

export function renderMarkdownTable(document, block, appendCell) {
  const scroll = document.createElement('div');
  scroll.className = 'chat-markdown-table-scroll';
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', document.documentElement?.lang?.startsWith('zh') ? '表格' : 'Table');
  const table = document.createElement('table');
  table.className = 'chat-markdown-table';
  const head = document.createElement('thead');
  const body = document.createElement('tbody');

  function addRow(section, contents, cellTag) {
    const row = document.createElement('tr');
    contents.forEach((text, column) => {
      const cell = document.createElement(cellTag);
      if (cellTag === 'th') cell.setAttribute('scope', 'col');
      if (block.alignments[column]) cell.setAttribute('data-align', block.alignments[column]);
      appendCell(cell, text);
      row.append(cell);
    });
    section.append(row);
  }

  addRow(head, block.header, 'th');
  for (const row of block.rows) addRow(body, row, 'td');
  table.append(head, body);
  scroll.append(table);
  return scroll;
}

export const tableMarkdownOptions = {readTable:readMarkdownTable, renderTable:renderMarkdownTable};

// Replace only with markup from the safe renderer. Using the native editing
// command keeps structural changes in the editor's undo history.
export function insertRichTable(document, editor, markdown, range, row = 0, column = 0) {
  const replacement = document.createElement('div');
  renderMarkdown(document, replacement, markdown, tableMarkdownOptions);
  const rendered = replacement.firstElementChild;
  if (!rendered?.querySelector('table')) return false;
  rendered.setAttribute('data-table-editing', '');
  const selection = document.getSelection();
  editor.focus();
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand('insertHTML', false, replacement.innerHTML);
  const updated = editor.querySelector('[data-table-editing]');
  if (!updated) return false;
  updated.removeAttribute('data-table-editing');
  const cell = updated.querySelector('table')?.rows[row]?.cells[column];
  if (cell) {
    range.selectNodeContents(cell);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  return true;
}

export function editRichTable(document, editor, activeCell, action) {
  const current = activeCell.closest('.chat-markdown-table-scroll');
  const snapshot = document.createElement('div');
  const wrapper = current.cloneNode(true);
  snapshot.append(wrapper);
  const table = wrapper.querySelector('table');
  const originalRow = activeCell.parentElement.rowIndex;
  const column = activeCell.cellIndex;
  const header = table.rows[0];
  const rowCount = table.rows.length - 1;
  const columnCount = header.cells.length;
  let nextRow = originalRow;
  let nextColumn = column;

  if (action === 'add-row' && rowCount < MAX_TABLE_ROWS) {
    const body = table.tBodies[0] || table.createTBody();
    const row = body.insertRow(originalRow);
    for (const source of header.cells) {
      const cell = row.insertCell();
      const alignment = source.getAttribute('data-align');
      if (alignment) cell.setAttribute('data-align', alignment);
    }
    nextRow += 1;
  } else if (action === 'add-column' && columnCount < MAX_TABLE_COLUMNS) {
    nextColumn += 1;
    const cell = document.createElement('th');
    cell.setAttribute('scope', 'col');
    cell.textContent = '列 ' + (columnCount + 1);
    header.insertBefore(cell, header.cells[nextColumn] ?? null);
    for (const row of Array.from(table.rows).slice(1)) row.insertCell(nextColumn);
  } else if (action === 'remove-row' && originalRow > 0) {
    table.deleteRow(originalRow);
    nextRow = Math.min(originalRow, table.rows.length - 1);
  } else if (action === 'remove-column' && columnCount > 1) {
    for (const row of table.rows) row.deleteCell(column);
    nextColumn = Math.min(column, header.cells.length - 1);
  } else return false;

  const range = document.createRange();
  range.selectNode(current);
  return insertRichTable(document, editor, domToMarkdown(snapshot), range, nextRow, nextColumn);
}
