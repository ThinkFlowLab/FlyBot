import {renderSequenceDiagram} from './sequence-diagram.mjs';

const MAX_SOURCE = 12000;
const MAX_NODES = 36;
const MAX_EDGES = 60;
const MAX_LABEL = 140;
const DIRECTIONS = new Set(['TB', 'TD', 'BT', 'LR', 'RL']);
const NODE_ID = /^[\p{L}\p{N}_]+(?:-[\p{L}\p{N}_]+)*/u;
const UNSUPPORTED = /^(?:subgraph|direction|click|style|classDef|class|linkStyle|accTitle|accDescr)(?:\s|:|$)/i;
const SHAPES = [
  ['(((', ')))', 'double-circle'], ['([', '])', 'round'], ['((', '))', 'round'],
  ['[(', ')]', 'database'], ['[[', ']]', 'subroutine'], ['[/', '/]', 'slant'],
  ['[\\', '\\]', 'slant-back'], ['[', ']', 'rect'], ['(', ')', 'round'],
  ['{{', '}}', 'hexagon'], ['{', '}', 'diamond'],
];
const CONNECTORS = [
  ['-.->', 'dashed', true], ['==>', 'thick', true], ['-->', 'solid', true], ['---', 'solid', false],
];
const NAMED_CONNECTORS = [
  [/^--\s+(.{1,180}?)\s*-->/, 'solid'],
  [/^-\.\s+(.{1,180}?)\s*\.->/, 'dashed'],
  [/^==\s+(.{1,180}?)\s*==>/, 'thick'],
];

function shapeAt(text, index) {
  return SHAPES.find(([open]) => text.startsWith(open, index));
}

function delimited(text, start, open, close) {
  let quoted = false;
  const valueStart = start + open.length;
  for (let i = valueStart; i < text.length; i += 1) {
    if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === close[0])) {
      i += 1;
      continue;
    }
    if (text[i] === '"') quoted = !quoted;
    if (!quoted && text.startsWith(close, i)) {
      return {text:text.slice(valueStart, i), end:i + close.length};
    }
  }
  return null;
}

function normalizedLabel(value) {
  const trimmed = value.trim();
  const inner = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return inner.replace(/\\"/g, '"').replace(/<br\s*\/?\s*>/gi, '\n').trim();
}

function statements(source) {
  const result = [];
  for (const line of source.split(/\r?\n/)) {
    let start = 0;
    let end = line.length;
    for (let i = 0; i < line.length; i += 1) {
      if (line.startsWith('%%', i)) {
        if (line.startsWith('%%{', i)) return null;
        end = i;
        break;
      }
      if (line[i] === ';') {
        result.push(line.slice(start, i).trim());
        start = i + 1;
        continue;
      }
      const delimiters = line[i] === '|' ? ['|', '|'] : shapeAt(line, i);
      if (delimiters) {
        const label = delimited(line, i, ...delimiters.slice(0, 2));
        if (!label) return null;
        i = label.end - 1;
      }
    }
    result.push(line.slice(start, end).trim());
  }
  return result.filter(Boolean);
}

function readNode(text) {
  const id = NODE_ID.exec(text)?.[0];
  if (!id || id.length > 80) return null;
  const remainder = text.slice(id.length).trimStart();
  const shape = shapeAt(remainder, 0);
  if (!shape) return {id, rest:remainder};
  const value = delimited(remainder, 0, shape[0], shape[1]);
  if (!value) return null;
  const label = normalizedLabel(value.text);
  if (!label || label.length > MAX_LABEL) return null;
  return {id, label, shape:shape[2], rest:remainder.slice(value.end).trimStart()};
}

function readNodeGroup(text) {
  const nodes = [];
  let rest = text;
  while (nodes.length < MAX_NODES) {
    const node = readNode(rest);
    if (!node || nodes.some(({id}) => id === node.id)) return null;
    nodes.push(node);
    if (!node.rest.startsWith('&')) return {nodes, rest:node.rest};
    rest = node.rest.slice(1).trimStart();
  }
  return null;
}

function readEdge(text) {
  const connector = CONNECTORS.find(([symbol]) => text.startsWith(symbol));
  if (!connector) {
    for (const [pattern, line] of NAMED_CONNECTORS) {
      const match = pattern.exec(text);
      if (match) {
        const label = normalizedLabel(match[1]);
        if (label && label.length <= MAX_LABEL) return {line, directed:true, label, rest:text.slice(match[0].length).trimStart()};
      }
    }
    return null;
  }
  const [symbol, line, directed] = connector;
  let rest = text.slice(symbol.length).trimStart();
  let label = '';
  if (rest.startsWith('|')) {
    const value = delimited(rest, 0, '|', '|');
    if (!value) return null;
    label = normalizedLabel(value.text);
    if (label.length > MAX_LABEL) return null;
    rest = rest.slice(value.end).trimStart();
  }
  return {line, directed, label, rest};
}

export function parseFlowchart(source) {
  if (typeof source !== 'string' || source.length > MAX_SOURCE) return null;
  const lines = statements(source);
  const header = /^(?:flowchart|graph)\s+([A-Z]{2})$/i.exec(lines?.[0] || '');
  const direction = header?.[1].toUpperCase();
  if (!DIRECTIONS.has(direction)) return null;
  const nodes = new Map();
  const edges = [];
  const addNode = ({id, label, shape}) => {
    if (shape || !nodes.has(id)) nodes.set(id, {id, label:label || id, shape:shape || 'rect'});
    return nodes.size <= MAX_NODES;
  };
  for (const line of lines.slice(1)) {
    if (line === 'end' || UNSUPPORTED.test(line)) return null;
    let before = readNodeGroup(line);
    if (!before || !before.nodes.every(addNode)) return null;
    while (before.rest) {
      const connector = readEdge(before.rest);
      if (!connector) return null;
      const after = readNodeGroup(connector.rest);
      if (!after || !after.nodes.every(addNode) || edges.length + before.nodes.length * after.nodes.length > MAX_EDGES) return null;
      const {line, directed, label} = connector;
      for (const from of before.nodes) {
        for (const to of after.nodes) edges.push({from:from.id, to:to.id, line, directed, label});
      }
      before = after;
    }
  }
  if (!nodes.size) return null;
  return {direction, nodes:[...nodes.values()], edges};
}

function findFeedbackEdges(nodes, edges) {
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.from).push(edge);
  const visited = new Set();
  const path = new Set();
  const feedback = new Set();
  function visit(id) {
    visited.add(id);
    path.add(id);
    for (const edge of outgoing.get(id)) {
      if (path.has(edge.to)) feedback.add(edge);
      else if (!visited.has(edge.to)) visit(edge.to);
    }
    path.delete(id);
  }
  for (const node of nodes) if (!visited.has(node.id)) visit(node.id);
  return feedback;
}

function rankNodes(nodes, edges) {
  const incoming = new Map(nodes.map(node => [node.id, []]));
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  const levels = new Map(nodes.map(node => [node.id, 0]));
  for (const {from, to} of edges) {
    incoming.get(to).push(from);
    outgoing.get(from).push(to);
  }
  const pending = new Map(nodes.map(node => [node.id, incoming.get(node.id).length]));
  const queue = nodes.filter(node => pending.get(node.id) === 0).map(node => node.id);
  for (let i = 0; i < queue.length; i += 1) {
    const before = queue[i];
    for (const after of outgoing.get(before)) {
      levels.set(after, Math.max(levels.get(after), levels.get(before) + 1));
      pending.set(after, pending.get(after) - 1);
      if (pending.get(after) === 0) queue.push(after);
    }
  }
  if (queue.length !== nodes.length) return null;

  const ranks = Array.from({length:1 + Math.max(...levels.values())}, () => []);
  for (const node of nodes) ranks[levels.get(node.id)].push(node);
  const positions = new Map();
  function barycenter(node) {
    const parents = incoming.get(node.id);
    return parents.length ? parents.reduce((sum, id) => sum + positions.get(id), 0) / parents.length : 0.5;
  }
  for (const rank of ranks) {
    rank.sort((a, b) => barycenter(a) - barycenter(b));
    rank.forEach((node, position) => positions.set(node.id, (position + 0.5) / rank.length));
  }
  return {ranks, levels, incoming, outgoing};
}

function estimatedTextWidth(text) {
  return [...text].reduce((size, char) => size + (char.codePointAt(0) > 0x2ff ? 13 : 8), 0);
}

function estimatedLineCount(label, width) {
  return label.split('\n').reduce((total, line) => {
    // Reserve room for wide CJK glyphs and for wrapping at word boundaries.
    return total + Math.max(1, Math.ceil(estimatedTextWidth(line) / (width - 12)));
  }, 0);
}

function layoutFlowchart({direction, nodes, edges}, {nodeWidth = 144, gap = 78, inset = 16} = {}) {
  const feedback = findFeedbackEdges(nodes, edges);
  const ranked = rankNodes(nodes, edges.filter(edge => !feedback.has(edge)));
  if (!ranked) return null;
  const {ranks, levels, incoming, outgoing} = ranked;
  const horizontal = direction === 'LR' || direction === 'RL';
  const reverse = direction === 'RL' || direction === 'BT';
  const nodeHeight = Math.max(52, ...nodes.map(node => {
    const diamond = node.shape === 'diamond';
    return estimatedLineCount(node.label, nodeWidth - (diamond ? 58 : 24)) * 19 + (diamond ? 35 : 18);
  }));
  const nodeMain = horizontal ? nodeWidth : nodeHeight;
  const nodeCross = horizontal ? nodeHeight : nodeWidth;
  const labelGap = nodeWidth < 144 ? Math.max(gap, ...edges.map(edge => Math.min(154, estimatedTextWidth(edge.label) + 16))) : gap;
  const mainGap = horizontal ? labelGap : 62;
  const crossGap = 32;
  const mainInset = feedback.size ? 48 : inset;
  const flowLength = ranks.length * (nodeMain + mainGap) - mainGap + 2 * mainInset;
  const crossLength = Math.max(...ranks.map(rank => rank.length)) * (nodeCross + crossGap) - crossGap + 32;
  const detours = edges.filter(edge => feedback.has(edge) || levels.get(edge.to) - levels.get(edge.from) > 1);
  const lanePadding = detours.some(edge => edge.label) ? 72 : 20;
  const crossExtent = crossLength + (detours.length ? lanePadding + (Math.min(detours.length, 6) - 1) * 12 : 0);
  const nodeCenters = new Map();
  const project = (main, cross) => horizontal
    ? [reverse ? flowLength - main : main, cross] : [cross, reverse ? flowLength - main : main];
  for (const [index, rank] of ranks.entries()) {
    const main = mainInset + index * (nodeMain + mainGap) + nodeMain / 2;
    rank.forEach((node, position) => {
      const cross = crossLength / 2 + (position - (rank.length - 1) / 2) * (nodeCross + crossGap);
      nodeCenters.set(node.id, {main, cross});
    });
  }
  const routedEdges = edges.map((edge) => {
    const from = nodeCenters.get(edge.from);
    const to = nodeCenters.get(edge.to);
    const start = from.main + nodeMain / 2;
    const end = to.main - nodeMain / 2;
    const detourIndex = detours.indexOf(edge);
    if (detourIndex !== -1) {
      const lane = crossLength + 12 * (detourIndex % 6);
      return {
        ...edge,
        points:[
          project(start, from.cross), project(start + mainGap / 3, from.cross),
          project(start + mainGap / 3, lane), project(end - mainGap / 3, lane),
          project(end - mainGap / 3, to.cross), project(end, to.cross),
        ],
        labelAt:project((start + end) / 2, lane),
      };
    }
    const halfway = (start + end) / 2;
    const labelCross = outgoing.get(edge.from).length > 1 ? to.cross
      : incoming.get(edge.to).length > 1 ? from.cross : (from.cross + to.cross) / 2;
    return {
      ...edge,
      points:[project(start, from.cross), project(halfway, from.cross), project(halfway, to.cross), project(end, to.cross)],
      labelAt:project(halfway, labelCross),
    };
  });
  return {
    width:horizontal ? flowLength : crossExtent,
    height:horizontal ? crossExtent : flowLength,
    nodeWidth, nodeHeight,
    nodes:nodes.map(node => ({...node, center:project(nodeCenters.get(node.id).main, nodeCenters.get(node.id).cross)})),
    edges:routedEdges,
  };
}

function positioned(document, tag, className, x, y) {
  const element = document.createElement(tag);
  element.className = className;
  element.style.position = 'absolute';
  element.style.left = `${x}px`;
  element.style.top = `${y}px`;
  return element;
}

function renderEdges(document, stage, edges) {
  for (const edge of edges) {
    for (let i = 1; i < edge.points.length; i += 1) {
      const [x1, y1] = edge.points[i - 1];
      const [x2, y2] = edge.points[i];
      const length = Math.hypot(x2 - x1, y2 - y1);
      if (!length) continue;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const segment = positioned(document, 'span', 'chat-flowchart-segment', x1, y1);
      segment.dataset.line = edge.line;
      segment.style.width = `${length}px`;
      segment.style.transform = `rotate(${angle}rad)`;
      stage.append(segment);
      if (edge.directed && i === edge.points.length - 1) {
        const arrow = positioned(document, 'span', 'chat-flowchart-arrow', x2, y2);
        arrow.style.transform = `rotate(${angle}rad)`;
        stage.append(arrow);
      }
    }
  }
  for (const {label, labelAt} of edges) {
    if (!label) continue;
    const element = positioned(document, 'span', 'chat-flowchart-edge-label', ...labelAt);
    element.textContent = label;
    stage.append(element);
  }
}

function drawFlowchart(document, stage, layout) {
  stage.style.width = `${layout.width}px`;
  stage.style.height = `${layout.height}px`;
  renderEdges(document, stage, layout.edges);
  for (const node of layout.nodes) {
    const [x, y] = node.center;
    const tile = positioned(document, 'div', 'chat-flowchart-node', x - layout.nodeWidth / 2, y - layout.nodeHeight / 2);
    tile.dataset.shape = node.shape;
    tile.style.width = `${layout.nodeWidth}px`;
    tile.style.height = `${layout.nodeHeight}px`;
    const text = document.createElement('span');
    text.textContent = node.label;
    tile.append(text);
    stage.append(tile);
  }
}

const fitFlowchart = new WeakMap();

export function observeDiagramSize(diagram, hint) {
  const ResizeObserver = diagram.ownerDocument?.defaultView?.ResizeObserver;
  if (!ResizeObserver) return;
  const observer = new ResizeObserver(([entry]) => {
    if (!diagram.isConnected) {
      observer.disconnect();
      return;
    }
    const width = entry.contentRect.width;
    if (!width) return;
    const scroller = diagram.closest('#message-scroller');
    const followsLatest = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
    const resized = fitFlowchart.get(diagram)?.(width);
    const overflows = diagram.scrollWidth > diagram.clientWidth;
    const wasOverflowing = !hint.hidden;
    if (wasOverflowing !== overflows || resized) {
      hint.hidden = !overflows;
      if (followsLatest) scroller.scrollTop = scroller.scrollHeight;
    }
    diagram.tabIndex = overflows ? 0 : -1;
    if (overflows) {
      const english = diagram.ownerDocument.documentElement.lang === 'en';
      diagram.setAttribute('aria-description', english ? 'Use the Left and Right Arrow keys to scroll.' : '可使用左右方向键横向滚动。');
    } else diagram.removeAttribute('aria-description');
  });
  observer.observe(diagram);
}

export function renderFlowchart(document, source) {
  const graph = parseFlowchart(source);
  const layout = graph && layoutFlowchart(graph);
  if (!layout) return null;

  const frame = document.createElement('div');
  frame.className = 'chat-flowchart';
  frame.tabIndex = 0;
  frame.setAttribute('role', 'region');
  const english = document.documentElement?.lang === 'en';
  frame.setAttribute('aria-label', english ? 'Flowchart' : '流程图');
  const stage = document.createElement('div');
  stage.className = 'chat-flowchart-stage';
  stage.setAttribute('role', 'img');
  const labels = new Map(graph.nodes.map(node => [node.id, node.label.replace(/\s+/g, ' ')]));
  const connected = new Set(graph.edges.flatMap(({from, to}) => [from, to]));
  const arrowWords = english ? {directed:'to', plain:'connected to'} : {directed:'到', plain:'连接'};
  const summary = graph.edges.map(({from, to, label, directed}) =>
    `${labels.get(from)} ${directed ? arrowWords.directed : arrowWords.plain} ${labels.get(to)}${label ? `（${label}）` : ''}`);
  for (const [id, label] of labels) if (!connected.has(id)) summary.push(label);
  stage.setAttribute('aria-label', summary.join('；'));
  drawFlowchart(document, stage, layout);
  frame.append(stage);
  if (graph.direction === 'LR' || graph.direction === 'RL') {
    // Preserve the frame's natural width so it can expand after a compact render.
    frame.style.width = `calc(${layout.width}px + 2 * var(--diagram-padding) + 2px)`;
    let active = layout;
    let compactLayouts;
    fitFlowchart.set(frame, width => {
      let best = layout;
      if (width < layout.width) {
        compactLayouts ??= [
          layoutFlowchart(graph, {nodeWidth:104, gap:40, inset:8}),
          layoutFlowchart(graph, {nodeWidth:92, gap:28, inset:4}),
        ];
        best = compactLayouts.find(candidate => candidate?.width <= width) ?? layout;
      }
      if (best === active) return false;
      active = best;
      stage.replaceChildren();
      drawFlowchart(document, stage, best);
      return true;
    });
  }
  return frame;
}

export function renderMermaidDiagram(document, source) {
  if (typeof source !== 'string' || source.length > MAX_SOURCE) return null;
  const header = source.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('%%'));
  return /^sequenceDiagram$/i.test(header || '') ? renderSequenceDiagram(document, source) : renderFlowchart(document, source);
}

const diagramStyles = new WeakMap();

function readyDiagramStyles(document) {
  let ready = diagramStyles.get(document);
  if (!ready) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./diagram.css', import.meta.url).href;
    ready = new Promise(resolve => {
      link.onload = () => resolve(true);
      link.onerror = () => {
        diagramStyles.delete(document);
        link.remove();
        resolve(false);
      };
    });
    diagramStyles.set(document, ready);
    document.head.append(link);
  }
  return ready;
}

export async function replaceMermaidSource(document, container, code, text) {
  if (!container.isConnected) return;
  const diagram = renderMermaidDiagram(document, text);
  if (!diagram || !await readyDiagramStyles(document) || !container.isConnected) return;
  const english = document.documentElement?.lang === 'en';
  const scroller = container.closest('#message-scroller');
  const atBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 32;
  const source = document.createElement('details');
  const summary = document.createElement('summary');
  const hint = document.createElement('p');
  hint.className = 'chat-diagram-scroll-hint';
  hint.hidden = true;
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = english ? 'Scroll sideways to see the full diagram' : '横向滚动查看完整图表';
  const focused = code.contains(document.activeElement) ? document.activeElement : null;
  source.className = 'chat-diagram-source';
  source.open = Boolean(focused);
  summary.textContent = english ? 'Diagram source' : '图表源码';
  source.append(summary, code);
  container.replaceChildren(diagram, hint, source);
  observeDiagramSize(diagram, hint);
  focused?.focus({preventScroll:true});
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  return diagram;
}
