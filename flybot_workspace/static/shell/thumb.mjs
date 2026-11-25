// Work thumbnails drawn from the server's text-only preview model.
// Text goes through textContent and shapes through SVG attributes, so stored
// HTML is never interpreted. Self-written; no Teamily assets.
const SVG = 'http://www.w3.org/2000/svg';
const COLOR = /^#[0-9a-fA-F]{6}$/;

function num(value, lo, hi, fallback = lo) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function text(value, max = 90) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Normalise whatever the API sent into the small shape renderThumb draws.
export function thumbModel(preview) {
  if (!preview || typeof preview !== 'object') return null;
  const type = preview.type;
  if (type === 'document' || type === 'website') {
    const lines = Array.isArray(preview.lines) ? preview.lines.map(line => text(line)).filter(Boolean).slice(0, 4) : [];
    const heading = text(preview.heading);
    if (!heading && !lines.length) return {type, heading: '', lines: [], empty: true};
    const blocks = type === 'document' && Array.isArray(preview.blocks) ? preview.blocks.slice(0, 6)
      .filter(block => block && ['text', 'heading', 'list', 'code', 'quote'].includes(block.type))
      .map(block => ({type: block.type, text: text(block.text)})).filter(block => block.text) : [];
    return blocks.length ? {type, heading, lines, blocks} : {type, heading, lines};
  }
  if (type === 'slides') {
    const bullets = Array.isArray(preview.bullets) ? preview.bullets.map(item => text(item)).filter(Boolean).slice(0, 3) : [];
    return {type, title: text(preview.title), bullets, count: num(preview.count, 0, 999, 0), empty: !text(preview.title) && !bullets.length};
  }
  if (type === 'board') {
    const width = num(preview.width, 100, 2000, 800);
    const height = num(preview.height, 100, 2000, 600);
    const shapes = (Array.isArray(preview.shapes) ? preview.shapes : []).slice(0, 24).filter(shape => shape && COLOR.test(shape.color || ''));
    return {type, width, height, shapes, empty: shapes.length === 0};
  }
  if (type === 'dashboard') {
    const widgets = (Array.isArray(preview.widgets) ? preview.widgets : []).slice(0, 4).map(widget => ({
      type: widget.type,
      title: text(widget.title, 40),
      value: text(widget.value, 24),
      bars: Array.isArray(widget.bars) ? widget.bars.slice(0, 8).map(bar => num(bar, 0, 100, 0)) : [],
      columns: Array.isArray(widget.columns) ? widget.columns.slice(0, 4).map(column => text(column, 24)) : [],
    }));
    return {type, widgets, empty: widgets.length === 0};
  }
  return null;
}

function el(document, tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = content;
  return node;
}

function svg(document, tag, attrs) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
  return node;
}

function boardSvg(document, model) {
  const root = svg(document, 'svg', {viewBox: `0 0 ${model.width} ${model.height}`, preserveAspectRatio: 'xMidYMid meet', 'aria-hidden': 'true', class: 'thumb-board-svg'});
  for (const shape of model.shapes) {
    if (shape.type === 'path' && Array.isArray(shape.points) && shape.points.length > 1) {
      const d = shape.points.map((p, i) => (i ? 'L' : 'M') + num(p[0], 0, 2000) + ' ' + num(p[1], 0, 2000)).join(' ');
      root.append(svg(document, 'path', {d, fill: 'none', stroke: shape.color, 'stroke-width': num(shape.width, 1, 40, 3) * 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'}));
    } else if (shape.type === 'rect') {
      root.append(svg(document, 'rect', {x: num(shape.x, 0, 2000), y: num(shape.y, 0, 2000), width: num(shape.width, 1, 2000), height: num(shape.height, 1, 2000), rx: 8, fill: 'none', stroke: shape.color, 'stroke-width': 4}));
    } else if (shape.type === 'ellipse') {
      const w = num(shape.width, 1, 2000), h = num(shape.height, 1, 2000);
      root.append(svg(document, 'ellipse', {cx: num(shape.x, 0, 2000) + w / 2, cy: num(shape.y, 0, 2000) + h / 2, rx: w / 2, ry: h / 2, fill: 'none', stroke: shape.color, 'stroke-width': 4}));
    } else if (shape.type === 'text') {
      const label = svg(document, 'text', {x: num(shape.x, 0, 2000), y: num(shape.y, 0, 2000), fill: shape.color, 'font-size': num(shape.size, 8, 96, 16) * 1.2, 'font-family': 'system-ui, sans-serif'});
      label.textContent = text(shape.text, 40);
      root.append(label);
    }
  }
  return root;
}

const EMPTY_LABEL = {document: '空白文档', website: '空白网页', slides: '空白幻灯片', board: '空白白板', dashboard: '空看板'};

// Returns an element to put inside a cover, or null when there is no preview.
export function renderThumb(document, preview) {
  const model = thumbModel(preview);
  if (!model) return null;
  const root = el(document, 'div', 'thumb thumb-' + model.type);
  root.setAttribute('aria-hidden', 'true');
  if (model.empty) {
    root.classList.add('thumb-empty');
    root.append(el(document, 'span', 'thumb-empty-label', EMPTY_LABEL[model.type] || '空白'));
    return root;
  }
  if (model.type === 'document' || model.type === 'website') {
    const page = el(document, 'div', 'thumb-page');
    if (model.type === 'website') {
      const bar = el(document, 'div', 'thumb-browser');
      bar.append(el(document, 'i'), el(document, 'i'), el(document, 'i'));
      page.append(bar);
    }
    if (model.blocks) {
      for (const block of model.blocks) page.append(el(document, 'p', 'thumb-block thumb-block-' + block.type, block.text));
    } else {
      if (model.heading) page.append(el(document, 'p', 'thumb-heading', model.heading));
      for (const line of model.lines) page.append(el(document, 'p', 'thumb-line', line));
    }
    root.append(page);
    return root;
  }
  if (model.type === 'slides') {
    const slide = el(document, 'div', 'thumb-slide');
    if (model.title) slide.append(el(document, 'p', 'thumb-slide-title', model.title));
    if (model.bullets.length) {
      const list = el(document, 'ul', 'thumb-slide-bullets');
      for (const bullet of model.bullets) list.append(el(document, 'li', '', bullet));
      slide.append(list);
    }
    root.append(slide);
    if (model.count > 1) root.append(el(document, 'span', 'thumb-count', '共 ' + model.count + ' 页'));
    return root;
  }
  if (model.type === 'board') {
    root.append(boardSvg(document, model));
    return root;
  }
  const grid = el(document, 'div', 'thumb-dash');
  for (const widget of model.widgets) {
    const cell = el(document, 'div', 'thumb-widget thumb-widget-' + (widget.type || 'metric'));
    cell.append(el(document, 'p', 'thumb-widget-title', widget.title));
    if (widget.type === 'metric') cell.append(el(document, 'p', 'thumb-widget-value', widget.value));
    else if (widget.type === 'bar') {
      const bars = el(document, 'div', 'thumb-bars');
      for (const bar of widget.bars) {
        const b = el(document, 'i');
        b.dataset.h = String(Math.round(bar / 10) * 10);
        bars.append(b);
      }
      cell.append(bars);
    } else {
      const head = el(document, 'div', 'thumb-table-head');
      for (const column of widget.columns) head.append(el(document, 'span', '', column));
      const rows = el(document, 'div', 'thumb-table-rows');
      rows.append(el(document, 'i'), el(document, 'i'), el(document, 'i'));
      cell.append(head, rows);
    }
    grid.append(cell);
  }
  root.append(grid);
  return root;
}

export function firstLine(text, limit = 40) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length <= limit ? value : value.slice(0, limit).trim();
}

export function websiteTitle(brief) {
  const line = firstLine(brief, 40);
  return line ? `网站：${line}` : '新网站';
}

export function escapeHtml(text) {
  return String(text || '').replace(/[&<>"]/g, (ch) => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch]
  ));
}

export function websiteStub(brief) {
  const body = escapeHtml(String(brief || '').trim() || '尚未填写需求。');
  return `<h1>待搭建的网站</h1>\n<p>需求：</p>\n<p>${body.replace(/\n/g, '<br>')}</p>\n`;
}

export function websitePrompt(title, brief) {
  return (
    `请根据下列需求搭建一个完整的静态网站，直接给出可保存的 HTML。`
    + `作品标题：${String(title || '').trim() || '新网站'}。\n\n`
    + String(brief || '').trim()
  );
}

export function saveableSocialMessage(item) {
  return Boolean(item && !item.retracted && !item.voice && !item.attachment && typeof item.body === 'string' && item.body.trim());
}

export function saveableAgentMessage(item) {
  return Boolean(item && item.status === 'succeeded' && typeof item.body === 'string' && item.body.trim());
}

export function artifactKindLabel(kind, mime) {
  if (kind === 'media' && mime === 'application/octet-stream') return '文件';
  if (kind === 'media') return mime === 'model/gltf-binary' ? '3D 模型' : '媒体';
  const labels = {website: '网站', whiteboard: '白板', slides: '幻灯片', dashboard: '看板', spreadsheet: '电子表格'};
  return Object.hasOwn(labels, kind) ? labels[kind] : '文档';
}

export function artifactVersionLabel(resource, mime) {
  if (!resource?.kind) return '';
  const kind = artifactKindLabel(resource.kind, mime);
  return Number.isSafeInteger(resource.revision) && resource.revision > 0
    ? `${kind} · 版本 ${resource.revision}` : kind;
}

export function socialSavePath(workspaceId, conversationId, messageId) {
  return `/v1/workspaces/${workspaceId}/social/conversations/${conversationId}/messages/${messageId}/save`;
}

export function agentSavePath(workspaceId, agentId, conversationId, messageId) {
  return `/v1/workspaces/${workspaceId}/agents/${agentId}/conversations/${conversationId}/messages/${messageId}/artifact`;
}

export function defaultSaveTitle(body) {
  return firstLine(body, 40) || '保存的消息';
}

export function conversationChatHref(workspaceId, item) {
  if (!workspaceId || !item) return '/chat';
  const message = item.message_id ? '&message=' + encodeURIComponent(item.message_id) : '';
  if (item.source === 'agent' && item.agent_id) {
    return '/chat#workspace=' + encodeURIComponent(workspaceId)
      + '&agent=' + encodeURIComponent(item.agent_id)
      + '&conversation=' + encodeURIComponent(item.id) + message;
  }
  return '/chat#workspace=' + encodeURIComponent(workspaceId)
    + '&social=' + encodeURIComponent(item.id) + message;
}

export function describeWebsiteDispatch(result) {
  if (!result) return '已创建网站作品，但未能发出搭建请求。';
  if (result.status === 'queued' && result.task_id) {
    return '已创建网站作品，并向智能体发出搭建请求。结果返回后请在对话里保存或手动写入作品。';
  }
  if (result.error_code === 'no_agent') {
    return '已创建网站作品，也已写进对话，但这个智能体目前没有在线运行时，不会开始搭建。可以在作品里先改草稿，或先连接运行时再重试。';
  }
  if (result.error_code) {
    return '已创建网站作品，但搭建请求未能开始：' + result.error_code + '。';
  }
  return '已创建网站作品，并向智能体发出搭建请求。';
}

export function spaceHref(workspaceId, artifactId) {
  const params = new URLSearchParams();
  if (workspaceId) params.set('workspace', workspaceId);
  if (artifactId) params.set('artifact', artifactId);
  const query = params.toString();
  return query ? '/space?' + query : '/space';
}
