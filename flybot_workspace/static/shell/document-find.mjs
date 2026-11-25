const blockSelector = 'p, div, li, h1, h2, h3, h4, h5, h6, pre, blockquote, th, td';
const highlightName = 'space-document-match';

function matchesInBody(document, body, term) {
  if (!term || !document.createTreeWalker) return [];
  const literal = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(literal, 'giu');
  const pieces = [];
  const walker = document.createTreeWalker(body, 4); // SHOW_TEXT
  let text = '';
  let block;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.data) continue;
    const next = node.parentElement?.closest(blockSelector);
    if (pieces.length && next !== block) text += '\n';
    block = next;
    pieces.push({node,start:text.length,end:text.length + node.length});
    text += node.data;
  }
  let piece = 0;
  return Array.from(text.matchAll(expression), match => {
    const start = match.index;
    const end = start + match[0].length;
    while (pieces[piece].end <= start) piece++;
    const first = pieces[piece];
    while (pieces[piece].end < end) piece++;
    const last = pieces[piece];
    return {first:first.node,start:start - first.start,last:last.node,end:end - last.start};
  });
}

export function bindDocumentFind(document, root, form) {
  const button = document.getElementById('document-find-open');
  const panel = document.getElementById('document-find');
  const query = document.getElementById('document-find-query');
  const status = document.getElementById('document-find-status');
  const previous = document.getElementById('document-find-previous');
  const next = document.getElementById('document-find-next');
  const closeButton = document.getElementById('document-find-close');
  const view = document.defaultView;
  const highlights = view?.CSS?.highlights;
  let enabled = false;
  let matches = [];
  let position = 0;
  let fallback;

  function clearHighlight() {
    highlights?.delete(highlightName);
    fallback?.removeAttribute('data-document-find-active');
    fallback = null;
  }

  function showMatch(reveal) {
    clearHighlight();
    previous.disabled = next.disabled = matches.length < 2;
    const match = matches[position];
    status.textContent = match ? `${position + 1} / ${matches.length}` : query.value.trim() ? '无匹配' : '';
    if (!match) return;
    const range = document.createRange();
    range.setStart(match.first, match.start);
    range.setEnd(match.last, match.end);
    if (highlights && view.Highlight) highlights.set(highlightName, new view.Highlight(range));
    else {
      fallback = match.first.parentElement;
      fallback?.setAttribute('data-document-find-active', '');
    }
    if (reveal) {
      const hit = range.getBoundingClientRect();
      const scroller = [form, document.getElementById('main')].find(node =>
        node && node.scrollHeight > node.clientHeight && /auto|scroll/.test(view.getComputedStyle(node).overflowY));
      const viewport = scroller?.getBoundingClientRect();
      const top = viewport?.top ?? 0;
      const height = viewport?.height ?? view.innerHeight;
      const scroll = scroller || document.scrollingElement;
      if (scroll) scroll.scrollTop += hit.top - top - height * .35;
    }
  }

  function update({clearPosition = true, reveal = true} = {}) {
    if (panel.hidden) return;
    matches = matchesInBody(document, root, query.value.trim());
    position = clearPosition ? 0 : Math.max(0, Math.min(position, matches.length - 1));
    showMatch(reveal);
  }

  function move(delta) {
    if (!matches.length) return;
    position = (position + delta + matches.length) % matches.length;
    showMatch(true);
  }

  function open(text, {focus = false} = {}) {
    if (!enabled) return;
    const refresh = panel.hidden || text !== undefined;
    if (text !== undefined) query.value = text;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    if (focus) query.focus({preventScroll:true});
    if (refresh) update();
  }

  function close({focus = false} = {}) {
    const match = matches[position];
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    query.value = '';
    matches = [];
    clearHighlight();
    if (focus) {
      root.focus({preventScroll:true});
      if (match?.first.isConnected) document.getSelection()?.collapse(match.first, match.start);
    }
  }

  button.addEventListener('click', () => open(undefined, {focus:true}));
  closeButton.addEventListener('click', () => close({focus:true}));
  query.addEventListener('input', event => { if (!event.isComposing) update(); });
  query.addEventListener('compositionend', () => update());
  previous.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  root.addEventListener('input', () => update({clearPosition:false,reveal:false}));
  form.addEventListener('keydown', event => {
    if (!enabled) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      open(undefined, {focus:true});
    } else if (!panel.hidden && event.key === 'Escape' && panel.contains(event.target)) {
      event.preventDefault();
      close({focus:true});
    } else if (event.target === query && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  });

  return {
    open, close,
    setEnabled(value) {
      enabled = value;
      button.disabled = !enabled;
      if (!enabled) close();
    },
  };
}
