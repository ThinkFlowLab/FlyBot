// Shared Markdown rendering and rich-text serialization.
// The page body is still stored as markdown through the existing save API;
// this module only renders it into safe DOM (createElement + textContent, never
// innerHTML) and serialises the edited DOM back. Self-written, no upstream.

const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;
const ESCAPABLE = '\\`*_~[]#>-+.!|';

export function safeHref(url) {
  const value = String(url || '').trim();
  return SAFE_HREF.test(value) ? value : '';
}

// ---- markdown -> blocks -------------------------------------------------
export function markdownToBlocks(source, {readTable} = {}) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const tableAt = index => lines[index]?.includes('|') ? readTable?.(lines, index) : null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const fence = /^(`{3,}|~{3,})\s*([\w+.#-]{0,30})\s*$/.exec(line.trim());
    if (fence) {
      const body = [];
      const marker = fence[1];
      const closes = value => value.length >= marker.length && !Array.from(value).some(character => character !== marker[0]);
      i += 1;
      while (i < lines.length && !closes(lines[i].trim())) { body.push(lines[i]); i += 1; }
      const closed = i < lines.length;
      if (closed) i += 1;
      blocks.push({type: 'code', text: body.join('\n'), language:fence[2].toLowerCase(), closed});
      continue;
    }
    const table = tableAt(i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({type: 'h' + heading[1].length, text: heading[2].trim()}); i += 1; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push({type: 'hr'}); i += 1; continue; }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      blocks.push({type: 'quote', text: body.join('\n')});
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const number = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || number.test(line)) {
      const ordered = !bullet.test(line);
      const pattern = ordered ? number : bullet;
      const items = [];
      while (i < lines.length && pattern.test(lines[i])) { items.push(pattern.exec(lines[i])[1]); i += 1; }
      blocks.push({type: ordered ? 'ol' : 'ul', items});
      continue;
    }
    const body = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !tableAt(i) && !/^(#{1,3})\s|^\s*(?:`{3,}|~{3,})|^\s*>|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])) {
      body.push(lines[i]); i += 1;
    }
    blocks.push({type: 'p', text: body.join('\n')});
  }
  return blocks;
}

// ---- inline markdown -> token tree -------------------------------------
const MARKS = [
  {mark: '**', type: 'b'},
  {mark: '~~', type: 's'},
  {mark: '*', type: 'i'},
  {mark: '_', type: 'i', word: true},
];

function isWord(ch) { return Boolean(ch) && /[\p{L}\p{N}]/u.test(ch); }

export function inlineTokens(text, {cellBreaks = false} = {}) {
  const src = String(text || '');
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({type: 'text', text: buf}); buf = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && (ESCAPABLE.includes(src[i + 1]) || (cellBreaks && src[i + 1] === '<'))) {
      buf += src[i + 1]; i += 2; continue;
    }
    if (ch === '\n') { flush(); out.push({type: 'br'}); i += 1; continue; }
    if (cellBreaks && ch === '<') {
      const lineBreak = /^<br[ \t]*\/?>/i.exec(src.slice(i));
      if (lineBreak) {
        flush();
        out.push({type:'br'});
        i += lineBreak[0].length;
        continue;
      }
    }
    if (ch === '`') {
      let start = i + 1;
      while (src[start] === '`') start += 1;
      const length = start - i;
      let end = src.indexOf('`', start);
      while (end !== -1) {
        let after = end + 1;
        while (src[after] === '`') after += 1;
        if (after - end === length) break;
        end = src.indexOf('`', after);
      }
      if (end > start) {
        flush();
        out.push({type:'code', text:src.slice(start, end)});
        i = end + length;
        continue;
      }
      buf += src.slice(i, start);
      i = start;
      continue;
    }
    if (ch === '[' && src[i + 1] !== '[') {
      const close = src.indexOf('](', i + 1);
      const end = close > i ? src.indexOf(')', close + 2) : -1;
      if (close > i && end > close && !src.slice(i + 1, close).includes('\n')) {
        const href = safeHref(src.slice(close + 2, end));
        if (href) {
          flush();
          out.push({type: 'link', href, children: inlineTokens(src.slice(i + 1, close), {cellBreaks})});
          i = end + 1;
          continue;
        }
      }
    }
    let matched = false;
    for (const {mark, type, word} of MARKS) {
      if (!src.startsWith(mark, i)) continue;
      const after = src[i + mark.length];
      if (!after || /\s/.test(after)) continue;
      if (word && isWord(src[i - 1])) continue;
      let end = src.indexOf(mark, i + mark.length);
      while (end > -1 && (/\s/.test(src[end - 1]) || (word && isWord(src[end + mark.length])) || src[end - 1] === '\\')) {
        end = src.indexOf(mark, end + 1);
      }
      if (end <= i + mark.length - 1 || end === -1) continue;
      const inner = src.slice(i + mark.length, end);
      if (!inner || inner.includes('\n\n')) continue;
      flush();
      out.push({type, children: inlineTokens(inner, {cellBreaks})});
      i = end + mark.length;
      matched = true;
      break;
    }
    if (matched) continue;
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

// ---- render into DOM ----------------------------------------------------
const INLINE_TAG = {b: 'strong', i: 'em', s: 's', code: 'code'};

function appendInline(document, parent, tokens) {
  for (const token of tokens) {
    if (token.type === 'text') parent.appendChild(document.createTextNode(token.text));
    else if (token.type === 'br') parent.appendChild(document.createElement('br'));
    else if (token.type === 'code') { const el = document.createElement('code'); el.textContent = token.text; parent.appendChild(el); }
    else if (token.type === 'link') {
      const el = document.createElement('a');
      el.setAttribute('href', token.href);
      el.setAttribute('rel', 'noreferrer');
      appendInline(document, el, token.children);
      parent.appendChild(el);
    } else {
      const el = document.createElement(INLINE_TAG[token.type]);
      appendInline(document, el, token.children);
      parent.appendChild(el);
    }
  }
}

export function renderMarkdownBlocks(document, root, blocks, {renderTable, renderCode, headingOffset = 0, interactiveTasks = false} = {}) {
  for (const block of blocks) {
    let el;
    if (block.type === 'table') {
      el = renderTable(document, block, (cell, text) => appendInline(document, cell, inlineTokens(text, {cellBreaks:true})));
    } else if (block.type === 'code' && renderCode) el = renderCode(document, block);
    else if (block.type === 'hr') el = document.createElement('hr');
    else if (block.type === 'code') {
      el = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = block.text;
      el.appendChild(code);
    } else if (block.type === 'ul' || block.type === 'ol') {
      el = document.createElement(block.type);
      for (const item of block.items) {
        const li = document.createElement('li');
        const task = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(item);
        if (task) {
          li.className = 'markdown-task-item';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.setAttribute('data-markdown-task', '');
          checkbox.setAttribute('contenteditable', 'false');
          checkbox.disabled = !interactiveTasks;
          checkbox.defaultChecked = task[1] !== ' ';
          const label = document.createElement('span');
          appendInline(document, label, inlineTokens(task[2] || ''));
          checkbox.setAttribute('aria-label', label.textContent || (document.documentElement?.lang?.startsWith('zh') ? '任务' : 'Task'));
          li.append(checkbox, label);
        } else appendInline(document, li, inlineTokens(item));
        el.appendChild(li);
      }
    } else {
      const tag = block.type === 'quote' ? 'blockquote'
        : block.type.startsWith('h') ? 'h' + Math.min(6, Number(block.type.slice(1)) + headingOffset) : block.type;
      el = document.createElement(tag);
      appendInline(document, el, inlineTokens(block.text));
    }
    root.appendChild(el);
  }
}

export function renderMarkdown(document, root, source, options = {}) {
  if (!root) return;
  while (root.firstChild) root.removeChild(root.firstChild);
  renderMarkdownBlocks(document, root, markdownToBlocks(source, {readTable:options.readTable}), options);
  if (!root.firstChild) root.appendChild(document.createElement('p')).appendChild(document.createElement('br'));
}

// ---- DOM -> markdown ----------------------------------------------------
function escapeText(text) {
  return String(text).replace(/\u00a0/g, ' ').replace(/([\\`*]|~~)/g, '\\$1');
}

function tagOf(node) { return node && node.nodeType === 1 ? String(node.tagName || node.nodeName).toLowerCase() : ''; }

function inlineMarkdown(node, cellBreaks = false) {
  let out = '';
  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType === 3) {
      const text = escapeText(child.nodeValue || '');
      out += cellBreaks ? text.replace(/<(?=br[ \t]*\/?>)/gi, '\\<') : text;
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = tagOf(child);
    if (tag === 'br') { out += '\n'; continue; }
    if (tag === 'code') { out += '`' + String(child.textContent || '').replace(/`/g, '') + '`'; continue; }
    const inner = inlineMarkdown(child, cellBreaks);
    if (cellBreaks && (tag === 'div' || tag === 'p')) {
      out += (out && !out.endsWith('\n') ? '\n' : '') + inner + '\n';
      continue;
    }
    if (!inner.trim()) { out += inner; continue; }
    const lead = inner.match(/^\s*/)[0], trail = inner.match(/\s*$/)[0], core = inner.trim();
    if (tag === 'b' || tag === 'strong') out += lead + '**' + core + '**' + trail;
    else if (tag === 'i' || tag === 'em') out += lead + '_' + core + '_' + trail;
    else if (tag === 's' || tag === 'strike' || tag === 'del') out += lead + '~~' + core + '~~' + trail;
    else if (tag === 'a') {
      const href = safeHref(child.getAttribute && child.getAttribute('href'));
      out += href ? lead + '[' + core + '](' + href + ')' + trail : inner;
    } else out += inner;
  }
  return out;
}

function guardLineStart(text) {
  return text.split('\n').map(line => line.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+[.)]\s|```)/, '$1\\$2')).join('\n');
}

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'hr', 'table']);

function tableMarkdown(table) {
  const [header, ...rows] = Array.from(table.rows || []);
  const cells = Array.from(header?.cells || []);
  if (!cells.length) return '';
  const cellText = cell => {
    if (!cell) return '';
    return inlineMarkdown(cell, true).trim().replace(/\n+/g, '<br>').replace(/\|/g, '\\|');
  };
  const line = values => '| ' + values.join(' | ') + ' |';
  const separator = {left:':---', center:':---:', right:'---:'};
  return [line(cells.map(cellText)), line(cells.map(cell => separator[cell.getAttribute('data-align')] || '---')),
    ...rows.map(row => line(cells.map((_, i) => cellText(row.cells[i]))))].join('\n');
}

function blockMarkdown(node) {
  const tag = tagOf(node);
  if (tag === 'hr') return '---';
  if (tag === 'pre') return '```\n' + String(node.textContent || '').replace(/\n$/, '') + '\n```';
  if (tag === 'table') return tableMarkdown(node);
  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(3, Number(tag[1]));
    const text = inlineMarkdown(node).replace(/\n+/g, ' ').trim();
    return text ? '#'.repeat(level) + ' ' + text : '';
  }
  if (tag === 'ul' || tag === 'ol') {
    const items = Array.from(node.childNodes || []).filter(child => tagOf(child) === 'li');
    return items.map((li, index) => {
      const task = Array.from(li.childNodes).find(child => tagOf(child) === 'input' && child.hasAttribute('data-markdown-task'));
      const marker = task ? (task.checked ? '[x] ' : '[ ] ') : '';
      return (tag === 'ol' ? (index + 1) + '. ' : '- ') + marker + inlineMarkdown(li).replace(/\n+/g, ' ').trim();
    }).join('\n');
  }
  if (tag === 'blockquote') {
    const nested = Array.from(node.childNodes || []).some(child => BLOCK_TAGS.has(tagOf(child)));
    const text = nested ? childrenMarkdown(node) : inlineMarkdown(node).trim();
    return text ? text.split('\n').map(line => '> ' + line).join('\n') : '';
  }
  const text = inlineMarkdown(node).replace(/^\n+|\n+$/g, '');
  return text.trim() ? guardLineStart(text) : '';
}

function childrenMarkdown(root) {
  const parts = [];
  let inline = null;
  const flushInline = () => {
    if (inline) {
      const text = inlineMarkdown(inline).replace(/^\n+|\n+$/g, '');
      if (text.trim()) parts.push(guardLineStart(text));
      inline = null;
    }
  };
  for (const child of Array.from(root.childNodes || [])) {
    const tag = tagOf(child);
    if (BLOCK_TAGS.has(tag)) {
      flushInline();
      if ((tag === 'div' || tag === 'p') && Array.from(child.childNodes || []).some(item => BLOCK_TAGS.has(tagOf(item)))) {
        const nested = childrenMarkdown(child);
        if (nested) parts.push(nested);
      } else {
        const text = blockMarkdown(child);
        if (text) parts.push(text);
      }
      continue;
    }
    if (!inline) inline = {childNodes: []};
    inline.childNodes.push(child);
  }
  flushInline();
  return parts.join('\n\n');
}

export function domToMarkdown(root) {
  return root ? childrenMarkdown(root) : '';
}
