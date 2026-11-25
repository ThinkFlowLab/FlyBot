const DOCUMENT_LIMIT = 60_000;
const DIFF_BUDGET = 1_500_000;
const lines = text => text.match(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g) || [];
const characters = text => text.match(/\r\n|[\s\S]/gu) || [];

function simpleMerge(base, local, remote) {
  if (local === remote || base === remote) return local;
  if (base === local) return remote;
  return null;
}

function uniquePositions(tokens, start, end) {
  const positions = new Map();
  for (let i = start; i < end; i++) {
    const token = tokens[i];
    positions.set(token, positions.has(token) ? -1 : i);
  }
  return positions;
}

function lineAnchors(base, other, start, end, otherEnd) {
  const matches = [];
  const left = uniquePositions(base, start, end);
  const right = uniquePositions(other, start, otherEnd);
  let previous = -1;
  for (const [line, index] of left) {
    const at = right.get(line);
    if (index < 0 || at === undefined || at < 0) continue;
    // An edit that moves unique lines can change which text a second edit
    // refers to. Leave competing changes in this case for explicit review.
    if (at <= previous) return null;
    matches.push([index, at]);
    previous = at;
  }
  return matches;
}

function diffRange(base, other, start, end, otherStart, otherEnd, edits, budget) {
  const rows = end - start;
  const columns = otherEnd - otherStart;
  if (!rows || !columns) {
    if (rows || columns) edits.push({from:start, to:end, items:other.slice(otherStart, otherEnd)});
    return true;
  }

  const stride = columns + 1;
  const cells = (rows + 1) * stride;
  if (cells > budget.remaining) return false;
  budget.remaining -= cells;
  const lengths = new Uint16Array(cells);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      const offset = i * stride + j;
      lengths[offset] = base[start + i] === other[otherStart + j]
        ? lengths[offset + stride + 1] + 1
        : Math.max(lengths[offset + stride], lengths[offset + 1]);
    }
  }

  let i = 0, j = 0, from = 0, insertedFrom = 0;
  function flush() {
    if (from !== i || insertedFrom !== j) {
      edits.push({from:start + from, to:start + i, items:other.slice(otherStart + insertedFrom, otherStart + j)});
    }
  }
  while (i < rows && j < columns) {
    if (base[start + i] === other[otherStart + j]) {
      flush();
      from = ++i;
      insertedFrom = ++j;
    } else if (lengths[(i + 1) * stride + j] >= lengths[i * stride + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  i = rows;
  j = columns;
  flush();
  return true;
}

function changes(base, other, budget, useLineAnchors) {
  let start = 0, end = base.length, otherEnd = other.length;
  while (start < end && start < otherEnd && base[start] === other[start]) start++;
  while (end > start && otherEnd > start && base[end - 1] === other[otherEnd - 1]) {
    end--;
    otherEnd--;
  }
  const anchors = useLineAnchors ? lineAnchors(base, other, start, end, otherEnd) : [];
  if (!anchors) return null;
  anchors.push([end, otherEnd]);
  const edits = [];
  let from = start, otherFrom = start;
  for (const [to, otherTo] of anchors) {
    if (!diffRange(base, other, from, to, otherFrom, otherTo, edits, budget)) return null;
    from = to + 1;
    otherFrom = otherTo + 1;
  }
  return edits;
}

export function compareDocumentLines(historical, current) {
  const before = lines(historical), after = lines(current);
  const budget = () => ({remaining:DIFF_BUDGET});
  const edits = changes(before, after, budget(), true) ?? changes(before, after, budget(), false);
  return {before, after, edits};
}

function reversedChanges(base, other, budget, useLineAnchors) {
  const edits = changes(base.toReversed(), other.toReversed(), budget, useLineAnchors);
  return edits?.reverse().map(({from, to, items}) => ({
    from:base.length - to, to:base.length - from, items:items.reverse(),
  })) ?? null;
}

function overlaps(a, b, refine) {
  if (!a || !b) return false;
  if (a.from === a.to && b.from === b.to) return a.from === b.from;
  if (a.from < b.to && b.from < a.to) return true;
  // A line replacement may contain the same added line as the other draft.
  // Refine a boundary insertion when the replacement added extra lines.
  if (refine && (a.from === a.to || b.from === b.to)) {
    const [insertion, replacement] = a.from === a.to ? [a, b] : [b, a];
    return replacement.items.length > replacement.to - replacement.from &&
      (insertion.from === replacement.from || insertion.from === replacement.to);
  }
  return false;
}

function render(base, edits, start, end) {
  const parts = [];
  for (const {from, to, items} of edits) {
    parts.push(base.slice(start, from).join(''), items.join(''));
    start = to;
  }
  parts.push(base.slice(start, end).join(''));
  return parts.join('');
}

function combine(base, local, remote, budget, refine) {
  const parts = [];
  let start = 0, i = 0, j = 0;
  while (i < local.length || j < remote.length) {
    const a = local[i];
    const b = remote[j];
    if (!overlaps(a, b, refine)) {
      // An insertion on the edge of a replacement stays on that edge.
      const first = !b || (a && (a.from < b.from || (a.from === b.from && a.to < b.to)));
      const edit = first ? local[i++] : remote[j++];
      parts.push(base.slice(start, edit.from).join(''), edit.items.join(''));
      start = edit.to;
      continue;
    }

    const left = [local[i++]];
    const right = [remote[j++]];
    while (overlaps(local[i], right.at(-1), refine) || overlaps(remote[j], left.at(-1), refine)) {
      if (overlaps(local[i], right.at(-1), refine)) left.push(local[i++]);
      else right.push(remote[j++]);
    }
    const from = Math.min(a.from, b.from);
    const to = Math.max(left.at(-1).to, right.at(-1).to);
    const original = base.slice(from, to).join('');
    const own = render(base, left, from, to);
    const incoming = render(base, right, from, to);
    const merged = refine ? mergeText(original, own, incoming, budget, false) : simpleMerge(original, own, incoming);
    if (merged === null) return null;
    parts.push(base.slice(start, from).join(''), merged);
    start = to;
  }
  parts.push(base.slice(start).join(''));
  return parts.join('');
}

function mergeText(original, own, incoming, budget, useLines) {
  const simple = simpleMerge(original, own, incoming);
  if (simple !== null) return simple;
  const tokenize = useLines ? lines : characters;
  const base = tokenize(original);
  const local = tokenize(own);
  const remote = tokenize(incoming);
  const left = changes(base, local, budget, useLines);
  const right = changes(base, remote, budget, useLines);
  if (!left || !right) return null;
  const merged = combine(base, left, right, budget, useLines);
  if (merged === null) return null;

  // Identical neighbouring text can make LCS align a change on either side.
  // A merge is only safe when each pairing of both alignments agrees.
  const laterLeft = reversedChanges(base, local, budget, useLines);
  const laterRight = reversedChanges(base, remote, budget, useLines);
  if (!laterLeft || !laterRight) return null;
  return combine(base, laterLeft, right, budget, useLines) === merged &&
    combine(base, left, laterRight, budget, useLines) === merged &&
    combine(base, laterLeft, laterRight, budget, useLines) === merged ? merged : null;
}

export function mergeStudioDraft(base, local, remote) {
  if (![base, local, remote].every(draft => typeof draft?.title === 'string' &&
      draft.title.length <= 120 && typeof draft.body === 'string' && draft.body.length <= DOCUMENT_LIMIT)) return null;
  const title = simpleMerge(base.title, local.title, remote.title);
  if (title === null) return null;
  const body = mergeText(base.body, local.body, remote.body, {remaining:DIFF_BUDGET}, true);
  return body !== null && body.length <= DOCUMENT_LIMIT ? {title, body} : null;
}
