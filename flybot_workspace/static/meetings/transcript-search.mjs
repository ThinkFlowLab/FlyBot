export function renderTranscriptMatch(document, element, match, label = '') {
  const highlight = document.createElement('mark');
  highlight.textContent = match.match;
  element.replaceChildren(document.createTextNode(label + match.before), highlight, document.createTextNode(match.after));
}

export function mountTranscriptSearch(document, transcript) {
  const panel = document.getElementById('meeting-transcript-find');
  const input = document.getElementById('meeting-transcript-search');
  const previous = document.getElementById('meeting-transcript-prev');
  const next = document.getElementById('meeting-transcript-next');
  const status = document.getElementById('meeting-transcript-search-status');
  const passage = document.getElementById('meeting-transcript-hit');
  const location = document.getElementById('meeting-transcript-location');
  let matches = [];
  let index = 0;

  function render() {
    const match = matches[index];
    previous.disabled = next.disabled = matches.length < 2;
    passage.hidden = location.hidden = !match;
    status.textContent = match ? `第 ${index + 1} 处，共 ${matches.length} 处` : (input.value.trim() ? '没有找到匹配的转写。' : '');
    if (!match) {
      passage.replaceChildren();
      return;
    }
    const {value} = transcript;
    const start = Math.max(0, match.index - 100);
    const end = match.index + match[0].length;
    const stop = Math.min(value.length, end + 100);
    renderTranscriptMatch(document, passage, {
      before:(start ? '…' : '') + value.slice(start, match.index).toWellFormed(),
      match:match[0],
      after:value.slice(end, stop).toWellFormed() + (stop < value.length ? '…' : ''),
    });
  }

  function refresh() {
    const needle = input.value.trim();
    panel.hidden = !transcript.value.trim() && !needle;
    const pattern = needle && new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    matches = pattern ? [...transcript.value.matchAll(pattern)] : [];
    index = 0;
    render();
  }

  function step(offset) {
    if (matches.length < 2) return;
    index = (index + offset + matches.length) % matches.length;
    render();
  }

  transcript.addEventListener('input', refresh);
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  });
  previous.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  location.addEventListener('click', () => {
    const match = matches[index];
    if (!match) return;
    transcript.focus({preventScroll:true});
    transcript.setSelectionRange(match.index, match.index + match[0].length);
    transcript.scrollIntoView({block:'nearest'});
  });

  return {
    reset() {
      input.value = '';
      refresh();
    },
    open(query) {
      input.value = query;
      refresh();
      if (!passage.hidden) passage.focus();
      else status.scrollIntoView({block:'nearest'});
    },
    refresh,
  };
}
