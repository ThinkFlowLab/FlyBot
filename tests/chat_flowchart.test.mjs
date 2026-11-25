import assert from 'node:assert/strict';
import test from 'node:test';
import {observeDiagramSize, parseFlowchart, renderFlowchart, renderMermaidDiagram} from '../flybot_workspace/static/shell/flowchart.mjs';
import {parseSequenceDiagram} from '../flybot_workspace/static/shell/sequence-diagram.mjs';

function createElement(tag) {
  return {
    tag, children:[], dataset:{}, style:{}, attributes:{},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
  };
}
const document = {createElement};

test('parses Mermaid-style directions, shapes, comments, branches and chained edges', () => {
  const graph = parseFlowchart([
    '%% release checklist',
    'graph TD; Start([开始]) --> Check{已确认？}',
    'Check -->|是| Ship["发布; 通知"] --> End((结束))',
    'Check -. 稍后 .-> Note[待定 %% 保留] %% trailing comment',
    'Note --- End',
  ].join('\n'));
  assert.equal(graph.direction, 'TD');
  assert.deepEqual(graph.nodes, [
    {id:'Start', label:'开始', shape:'round'}, {id:'Check', label:'已确认？', shape:'diamond'},
    {id:'Ship', label:'发布; 通知', shape:'rect'}, {id:'End', label:'结束', shape:'round'},
    {id:'Note', label:'待定 %% 保留', shape:'rect'},
  ]);
  assert.deepEqual(graph.edges, [
    {from:'Start', to:'Check', line:'solid', directed:true, label:''},
    {from:'Check', to:'Ship', line:'solid', directed:true, label:'是'},
    {from:'Ship', to:'End', line:'solid', directed:true, label:''},
    {from:'Check', to:'Note', line:'dashed', directed:true, label:'稍后'},
    {from:'Note', to:'End', line:'solid', directed:false, label:''},
  ]);
});

test('renders labels as text, accessible graph relations, and deterministic reversed directions', () => {
  for (const direction of ['TB', 'TD', 'BT', 'LR', 'RL']) {
    const source = `flowchart ${direction}\n A["Before<br/><img src=https://example.invalid>"] ==>|next| B(after)`;
    const chart = renderFlowchart(document, source);
    const [stage] = chart.children;
    const [a, b] = stage.children.filter(item => item.className === 'chat-flowchart-node');
    assert.equal(chart.tabIndex, 0);
    assert.equal(stage.attributes.role, 'img');
    assert.match(stage.attributes['aria-label'], /到 after（next）/);
    assert.equal(a.children[0].textContent, 'Before\n<img src=https://example.invalid>');
    assert.ok(stage.children.some(item => item.dataset.line === 'thick'));
    assert.ok(stage.children.some(item => item.className === 'chat-flowchart-arrow'));
    const axis = ['LR', 'RL'].includes(direction) ? 'left' : 'top';
    assert.equal(parseFloat(a.style[axis]) < parseFloat(b.style[axis]), !['BT', 'RL'].includes(direction));
    assert.equal(JSON.stringify(chart), JSON.stringify(renderFlowchart(document, source)));
  }
});

test('renders feedback arrows on an exterior lane without changing the primary flow ranks', () => {
  const source = 'flowchart TB\nA[提交] --> B{审核} --> C[通过]\nB -->|退回| A\nC -->|重试| C';
  const chart = renderFlowchart(document, source);
  const [stage] = chart.children;
  const nodes = stage.children.filter(item => item.className === 'chat-flowchart-node');
  const arrows = stage.children.filter(item => item.className === 'chat-flowchart-arrow');
  const labels = stage.children.filter(item => item.className === 'chat-flowchart-edge-label');
  assert.equal(arrows.length, 4);
  assert.equal(labels.length, 2);
  assert.match(stage.attributes['aria-label'], /审核 到 提交（退回）.*通过 到 通过（重试）/);
  const rightmost = Math.max(...nodes.map(node => parseFloat(node.style.left) + parseFloat(node.style.width)));
  assert.ok(labels.every(label => parseFloat(label.style.left) > rightmost));
  assert.ok(parseFloat(nodes[0].style.top) < parseFloat(nodes[1].style.top));
  assert.ok(parseFloat(nodes[1].style.top) < parseFloat(nodes[2].style.top));
});

test('fits a short horizontal diagram without changing its relations and announces real overflow', () => {
  const chart = renderFlowchart(document, 'flowchart RL\nA[发送消息] --> B[收到回复]');
  const [stage] = chart.children;
  const hint = {hidden:true};
  const label = stage.attributes['aria-label'];
  let resized, disconnected;
  chart.ownerDocument = {
    documentElement:{lang:'zh-CN'},
    defaultView:{ResizeObserver:class {
      constructor(callback) { resized = callback; }
      observe(node) { assert.equal(node, chart); }
      disconnect() { disconnected = true; }
    }},
  };
  chart.isConnected = true;
  chart.closest = () => null;
  Object.defineProperty(chart, 'scrollWidth', {get:() => parseFloat(stage.style.width)});
  const resize = width => {
    chart.clientWidth = width;
    resized([{contentRect:{width}}]);
  };

  observeDiagramSize(chart, hint);
  resize(280);
  assert.equal(stage.style.width, '264px');
  assert.equal(label, stage.attributes['aria-label']);
  assert.equal(hint.hidden, true);
  assert.equal(chart.tabIndex, -1);
  const [from,to] = stage.children.filter(item => item.className === 'chat-flowchart-node');
  assert.ok(parseFloat(from.style.left) > parseFloat(to.style.left));
  assert.equal(stage.children.filter(item => item.className === 'chat-flowchart-arrow').length, 1);

  resize(230);
  assert.equal(stage.style.width, '220px');
  assert.equal(hint.hidden, true);
  resize(210);
  assert.equal(hint.hidden, false);
  assert.equal(chart.tabIndex, 0);
  assert.match(chart.attributes['aria-description'], /左右方向键/);
  resize(420);
  assert.equal(stage.style.width, '398px');
  assert.equal(hint.hidden, true);
  assert.equal(chart.attributes['aria-description'], undefined);

  chart.isConnected = false;
  resize(0);
  assert.equal(disconnected, true);
});

test('returns the original-code fallback sentinel for unsupported, malformed and oversized graphs', () => {
  for (const source of [
    'sequenceDiagram\nA->>B: hi',
    'flowchart LR\nsubgraph cluster\nA-->B\nend',
    'flowchart TB\nA["unclosed]-->B',
    'flowchart TB\nA-->B\nclick A javascript:alert(1)',
    '%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\nA-->B',
    'flowchart TB\n' + Array.from({length:37}, (_, index) => `n${index}`).join('-->'),
  ]) assert.equal(renderFlowchart(document, source), null);
});

test('handles common process symbols and a grouped fan-out while preserving labels', () => {
  const source = [
    'flowchart LR',
    'IN[/读入输入/] --> API[[数据规范化]]',
    'API --> Route{{分流}}',
    'Route --> Left & Right',
    'Left & Right --> Store[(数据库)] & Mirror(((副本)))',
    String.raw`Mirror --> Export[\导出\]`,
  ].join('\n');
  const graph = parseFlowchart(source);
  assert.deepEqual(graph.nodes.map(node => node.shape), [
    'slant', 'subroutine', 'hexagon', 'rect', 'rect', 'database', 'double-circle', 'slant-back',
  ]);
  assert.deepEqual(graph.edges.slice(4, 8).map(({from, to}) => [from, to]), [
    ['Left', 'Store'], ['Left', 'Mirror'], ['Right', 'Store'], ['Right', 'Mirror'],
  ]);
  assert.equal(JSON.stringify(renderMermaidDiagram(document, source)), JSON.stringify(renderFlowchart(document, source)));
});

test('renders sequence requests, replies, notes, activation bars and branch controls', () => {
  const source = [
    '%% Checkout',
    'sequenceDiagram',
    'actor A as 买家',
    'participant API as 订单服务',
    'autonumber',
    'A->>+API: 创建订单',
    'Note over A,API: 审核<br/>订单',
    'alt 库存充足',
    'API->>API: 持久化',
    'API-->>-A: 返回订单编号',
    'else 库存不足',
    'API--xA: <img src=https://example.invalid>',
    'end',
  ].join('\n');
  const parsed = parseSequenceDiagram(source);
  assert.deepEqual(parsed.participants, [
    {id:'A', label:'买家', kind:'actor'}, {id:'API', label:'订单服务', kind:'participant'},
  ]);
  assert.equal(parsed.events.filter(event => event.type === 'message')[2].arrow, '-->>');
  const frame = renderMermaidDiagram(document, source);
  const [stage] = frame.children;
  assert.equal(frame.attributes['aria-label'], '时序图');
  assert.match(stage.attributes['aria-label'], /买家 到 订单服务 · 1\. 创建订单.*订单服务 到 买家 · 3\. 返回订单编号/s);
  const matching = className => stage.children.filter(item => item.className === className);
  assert.equal(matching('chat-sequence-note')[0].textContent, '审核\n订单');
  assert.equal(matching('chat-sequence-message')[3].textContent, '4. <img src=https://example.invalid>');
  assert.equal(matching('chat-sequence-activation').length, 1);
  assert.equal(matching('chat-sequence-group').length, 1);
  assert.deepEqual(matching('chat-sequence-line').map(item => [item.dataset.direction, item.dataset.style, item.dataset.tip]), [
    ['right', 'solid', 'arrow'], ['self', 'solid', 'arrow'], ['left', 'dashed', 'arrow'], ['left', 'dashed', 'cross'],
  ]);
});

test('preserves code fallback for malformed, oversized or executable-looking Mermaid syntax', () => {
  for (const source of [
    'sequenceDiagram\n%%{init: {}}%%\nA->>B: hi',
    'sequenceDiagram\nA->>B: hi\nclick A javascript:alert(1)',
    'sequenceDiagram\nA->>B: hi\nalt missing end',
    'sequenceDiagram\nA->>B: hi\nand bad branch\nend',
    'sequenceDiagram\n' + Array.from({length:13}, (_, i) => `participant p${i}`).join('\n'),
  ]) assert.equal(renderMermaidDiagram(document, source), null);
});
