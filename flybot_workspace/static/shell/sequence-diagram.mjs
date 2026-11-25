const MAX_SOURCE = 12000;
const MAX_PARTICIPANTS = 12;
const MAX_EVENTS = 60;
const MAX_LABEL = 220;
const MAX_DEPTH = 4;
const ID = String.raw`[\p{L}\p{N}_](?:[.-]?[\p{L}\p{N}_]){0,63}`;
const PARTICIPANT = new RegExp(`^(participant|actor)\\s+(${ID})(?:\\s+as\\s+(.+))?$`, 'iu');
const MESSAGE = new RegExp(`^(${ID})\\s*(<<-->>|<<->>|-->>|->>|--x|-x|--\\)|-\\)|-->|->)\\s*([+-]?)\\s*(${ID})\\s*:\\s*(.*)$`, 'u');
const NOTE = new RegExp(`^note\\s+(left of|right of|over)\\s+(${ID})(?:\\s*,\\s*(${ID}))?\\s*:\\s*(.*)$`, 'iu');
const BLOCK = /^(alt|opt|loop|par|critical|break)(?:\s+(.+))?$/i;
const BRANCH = /^(else|and|option)(?:\s+(.+))?$/i;
const BRANCHES = {alt:'else', par:'and', critical:'option'};

function labelText(value) {
  return value.replace(/<br\s*\/?\s*>/gi, '\n').trim();
}

export function parseSequenceDiagram(source) {
  if (typeof source !== 'string' || source.length > MAX_SOURCE) return null;
  const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.some(line => line.startsWith('%%{'))) return null;
  const content = lines.filter(line => !line.startsWith('%%'));
  if (!/^sequenceDiagram$/i.test(content[0] || '')) return null;
  const participants = new Map();
  const events = [];
  const blocks = [];
  let autonumber = false;

  function addParticipant(id, label = id, kind = 'participant', explicit = false) {
    if (!participants.has(id) || explicit) participants.set(id, {id, label, kind});
    return participants.size <= MAX_PARTICIPANTS;
  }

  for (const line of content.slice(1)) {
    const declaration = PARTICIPANT.exec(line);
    if (declaration) {
      const [, kind, id, alias] = declaration;
      const label = labelText(alias || id);
      if (label.length > MAX_LABEL || !addParticipant(id, label, kind.toLowerCase(), true)) return null;
      continue;
    }
    if (/^autonumber$/i.test(line)) {
      autonumber = true;
      continue;
    }
    if (events.length >= MAX_EVENTS) return null;
    const message = MESSAGE.exec(line);
    if (message) {
      const [, from, arrow, activation, to, value] = message;
      const label = labelText(value);
      if (label.length > MAX_LABEL || !addParticipant(from) || !addParticipant(to)) return null;
      events.push({type:'message', from, to, label, arrow, activation});
      continue;
    }
    const note = NOTE.exec(line);
    if (note) {
      const [, position, from, other, value] = note;
      const side = position.toLowerCase();
      const label = labelText(value);
      if ((other && side !== 'over') || label.length > MAX_LABEL || !addParticipant(from) || (other && !addParticipant(other))) return null;
      events.push({type:'note', side, from, to:other || from, label});
      continue;
    }
    const activation = /^(activate|deactivate)\s+(.+)$/i.exec(line);
    if (activation) {
      const [, action, id] = activation;
      if (!participants.has(id)) return null;
      events.push({type:'activation', id, action:action.toLowerCase()});
      continue;
    }
    const block = BLOCK.exec(line);
    if (block) {
      const kind = block[1].toLowerCase();
      const label = labelText(block[2] || '');
      if (blocks.length >= MAX_DEPTH || label.length > MAX_LABEL) return null;
      blocks.push(kind);
      events.push({type:'block-start', kind, label});
      continue;
    }
    const branch = BRANCH.exec(line);
    if (branch) {
      const kind = branch[1].toLowerCase();
      const label = labelText(branch[2] || '');
      if (BRANCHES[blocks.at(-1)] !== kind || label.length > MAX_LABEL) return null;
      events.push({type:'branch', kind, label});
      continue;
    }
    if (/^end$/i.test(line) && blocks.length) {
      blocks.pop();
      events.push({type:'block-end'});
      continue;
    }
    return null;
  }
  if (blocks.length || !participants.size) return null;
  return {participants:[...participants.values()], events, autonumber};
}

function estimateLines(label, width) {
  return label.split('\n').reduce((lines, line) => {
    const pixels = Array.from(line).reduce((sum, char) => sum + (char.codePointAt(0) > 0x2ff ? 13 : 8), 0);
    return lines + Math.max(1, Math.ceil(pixels / Math.max(8, width - 16)));
  }, 0);
}

function place(document, container, tag, className, left, top, width, height) {
  const item = document.createElement(tag);
  item.className = className;
  Object.assign(item.style, {left:`${left}px`, top:`${top}px`, width:`${width}px`, height:`${height}px`});
  container.append(item);
  return item;
}

export function renderSequenceDiagram(document, source) {
  const diagram = parseSequenceDiagram(source);
  if (!diagram) return null;
  const {participants, events, autonumber} = diagram;
  const english = document.documentElement?.lang === 'en';
  const regionLabel = english ? 'Sequence diagram' : '时序图';
  const frame = document.createElement('div');
  frame.className = 'chat-flowchart chat-sequence';
  frame.tabIndex = 0;
  frame.setAttribute('role', 'region');
  frame.setAttribute('aria-label', regionLabel);
  const stage = document.createElement('div');
  stage.className = 'chat-flowchart-stage chat-sequence-stage';
  stage.setAttribute('role', 'img');
  frame.append(stage);

  const first = participants[0].id;
  const last = participants.at(-1).id;
  const leftInset = events.some(event => event.type === 'note' && event.side === 'left of' && event.from === first) ? 188 : 84;
  const rightInset = events.some(event => (event.type === 'note' && event.side === 'right of' && event.from === last) ||
    (event.type === 'message' && event.from === last && event.to === last)) ? 188 : 84;
  const laneGap = 180;
  const width = leftInset + rightInset + (participants.length - 1) * laneGap;
  const lanes = new Map(participants.map(({id}, index) => [id, leftInset + index * laneGap]));
  const names = new Map(participants.map(({id, label}) => [id, label]));
  const headerHeight = Math.max(42, ...participants.map(({label}) => estimateLines(label, 138) * 18 + 12));
  const headerY = 10;
  const bodyY = headerY + headerHeight;
  const summary = [];
  const groups = [];
  const active = new Map();
  let row = bodyY + 18;
  let messageNumber = 0;

  function activate(id, y) {
    const stack = active.get(id) || [];
    stack.push(y);
    active.set(id, stack);
  }

  function deactivate(id, y) {
    const stack = active.get(id);
    if (!stack?.length) return;
    const top = stack.pop();
    place(document, stage, 'span', 'chat-sequence-activation', lanes.get(id) - 5 + stack.length * 4, top, 10, Math.max(4, y - top));
  }

  for (const event of events) {
    if (event.type === 'activation') {
      (event.action === 'activate' ? activate : deactivate)(event.id, row - 6);
      continue;
    }
    if (event.type === 'block-start' || event.type === 'branch') {
      const label = event.label ? `${event.kind} · ${event.label}` : event.kind;
      const inset = 6 + Math.max(0, groups.length - (event.type === 'branch' ? 1 : 0)) * 10;
      const labelWidth = width - 2 * inset;
      const height = estimateLines(label, labelWidth) * 17 + 12;
      if (event.type === 'block-start') groups.push({row, inset});
      const title = place(document, stage, 'div', `chat-sequence-group-label is-${event.type}`, inset, row, labelWidth, height);
      title.textContent = label;
      summary.push(label);
      row += height + 8;
      continue;
    }
    if (event.type === 'block-end') {
      const group = groups.pop();
      place(document, stage, 'div', 'chat-sequence-group', group.inset, group.row, width - 2 * group.inset, row - group.row - 3);
      row += 8;
      continue;
    }

    const from = lanes.get(event.from);
    const to = lanes.get(event.to);
    const span = Math.abs(from - to);
    const left = Math.min(from, to);
    if (event.type === 'note') {
      const noteWidth = Math.max(150, span + 48);
      const x = event.side === 'left of' ? from - noteWidth - 8
        : event.side === 'right of' ? from + 8 : left + span / 2 - noteWidth / 2;
      const height = estimateLines(event.label, noteWidth) * 17 + 14;
      const note = place(document, stage, 'div', 'chat-sequence-note', x, row, noteWidth, height);
      note.textContent = event.label;
      summary.push(event.label);
      row += height + 12;
      continue;
    }

    const self = from === to;
    const textWidth = self ? 150 : span - 10;
    const label = autonumber ? `${++messageNumber}. ${event.label}` : event.label;
    const labelHeight = estimateLines(label, textWidth) * 17;
    const text = place(document, stage, 'span', 'chat-sequence-message', left + (self ? 10 : 5), row, textWidth, labelHeight);
    text.textContent = label;
    const arrowY = row + labelHeight + 5;
    const line = place(document, stage, 'span', 'chat-sequence-line', left, arrowY, self ? 46 : span, self ? 16 : 0);
    line.dataset.direction = self ? 'self' : from < to ? 'right' : 'left';
    line.dataset.style = event.arrow.includes('--') ? 'dashed' : 'solid';
    line.dataset.tip = event.arrow.endsWith('x') ? 'cross' : event.arrow.endsWith(')') ? 'open' : 'arrow';
    if (event.arrow.startsWith('<<')) line.dataset.both = '';
    if (event.activation === '+') activate(event.to, arrowY);
    if (event.activation === '-') deactivate(event.from, arrowY);
    summary.push(`${names.get(event.from)} ${english ? 'to' : '到'} ${names.get(event.to)}${label ? ` · ${label}` : ''}`);
    row = arrowY + (self ? 31 : 17);
  }
  const bottom = row + 4;
  for (const {id, label, kind} of participants) {
    const x = lanes.get(id);
    while (active.get(id)?.length) deactivate(id, bottom);
    place(document, stage, 'span', 'chat-sequence-lifeline', x, bodyY, 0, bottom - bodyY);
    const tile = place(document, stage, 'div', 'chat-sequence-participant', x - 69, headerY, 138, headerHeight);
    tile.dataset.kind = kind;
    tile.textContent = label;
  }
  stage.setAttribute('aria-label', [participants.map(({label}) => label).join(', '), ...summary].join('；'));
  stage.style.width = `${width}px`;
  stage.style.height = `${bottom + 6}px`;
  return frame;
}
