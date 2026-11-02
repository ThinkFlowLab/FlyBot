// Settings → Workflows (#1364). The page lists the factory pipelines and the
// workflows saved on this machine, and opens the same drag-drop flowchart the
// sidebar run uses. A read always settles: a host that never answers becomes
// an error, an empty store says so, and the file path is not the page.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

export const READ_MS = 8000

// The room's Workflow drawer re-reads a live run on this beat; Settings shows the
// same data, so it moves at the same speed instead of freezing at mount (#1810).
export const POLL_MS = 2000

// Shown when @flybot/workflow is not registered. A default install includes it;
// the page says so instead of the host's "Unknown FlyBot endpoint workflow/…" string.
const WORKFLOW_PLUGIN_HINT = 'The Workflow plugin is not installed or not enabled. A default install includes @flybot/workflow.'

const COLORS = { Planner: '#8b5cf6', Writer: '#f0509a', Coder: '#1fbf6a', Reviewer: '#f5a524', Tester: '#14b8a6', Deployer: '#2f7cf6' }

// Social maps bot/not-found and "Unknown FlyBot endpoint social/…" the same way.
// A workflow call uses that shape when the plugin is missing or switched off.
function workflowCallMissing(failure) {
  const code = failure && typeof failure === 'object' ? String(failure.code ?? '') : ''
  const message = typeof failure === 'string' ? failure : String(failure?.message ?? '')
  return code === 'bot/not-found' || /Unknown FlyBot endpoint workflow\//i.test(message)
}

function workflowCallError(failure, fallback = 'Could not read workflows') {
  if (workflowCallMissing(failure)) return WORKFLOW_PLUGIN_HINT
  if (typeof failure === 'string' && failure.trim()) return failure.trim()
  const message = typeof failure?.message === 'string' ? failure.message.trim() : ''
  return message || fallback
}

export function settleWorkflowRead(value, fallback = 'Could not read workflows') {
  if (!value || value.ok === false || !Array.isArray(value.workflows)) {
    const raw = typeof value?.error === 'string' && value.error.trim() ? value.error : ''
    const error = workflowCallMissing(value) || workflowCallMissing(raw) ? WORKFLOW_PLUGIN_HINT : (raw || fallback)
    return { phase: 'error', error, pack: null }
  }
  const templates = Array.isArray(value.templates) ? value.templates : []
  const workflows = value.workflows
  const pack = { ...value, templates, workflows }
  if (templates.length === 0 && workflows.length === 0) return { phase: 'empty', error: '', pack }
  return { phase: 'ready', error: '', pack }
}

// One read of workflow/state. A call that throws, rejects, or never returns
// settles as an error, so the page cannot stay on "Reading workflows…".
// A missing plugin is bot/not-found, so that failure names the plugin.
export function readWorkflows(call, { timeoutMs = READ_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(settleWorkflowRead(null)), timeoutMs)
    Promise.resolve()
      .then(() => call('workflow/state'))
      .then((value) => finish(settleWorkflowRead(value)))
      .catch((failure) => finish({ phase: 'error', error: workflowCallError(failure), pack: null }))
  })
}

export function moveNode(nodes, id, x, y) {
  return nodes.map((node) => (node.id === id ? { ...node, x, y } : node))
}

export function connectNodes(edges, from, to) {
  if (!from || !to || from === to) return edges
  if (edges.some((edge) => edge.from === from && edge.to === to)) return edges
  return edges.concat([{ from, to }])
}

export function dropBot(nodes, bot, x, y) {
  const ids = new Set(nodes.map((node) => node.id))
  let n = nodes.length + 1
  while (ids.has(`n${n}`)) n += 1
  return nodes.concat([{ id: `n${n}`, name: bot.name, botId: bot.id, role: bot.role ?? '', x, y }])
}

export function removeNode(nodes, edges, id) {
  return {
    nodes: nodes.filter((node) => node.id !== id),
    edges: edges.filter((edge) => edge.from !== id && edge.to !== id),
  }
}

function chainOf(item) {
  if (typeof item?.chain === 'string' && item.chain) return item.chain
  if (!Array.isArray(item?.layers) || !Array.isArray(item?.nodes)) return ''
  const name = (id) => item.nodes.find((node) => node.id === id)?.name ?? id
  return item.layers.map((layer) => layer.map(name).join(' ‖ ')).join(' → ')
}

export function openedGraph(pack, opened) {
  if (!pack || !opened) return null
  if (opened.source === 'own') return (pack.workflows ?? []).find((item) => item.id === opened.id) ?? null
  return (pack.templates ?? []).find((item) => item.id === opened.id)
    ?? (pack.workflows ?? []).find((item) => item.id === opened.id)
    ?? null
}

function statusLabel(status) {
  if (status === 'running') return t('Running')
  if (status === 'done') return t('Done')
  if (status === 'failed') return t('Failed')
  if (status === 'idle') return t('Idle')
  if (status === 'skipped') return t('Skipped')
  return t('Queued')
}

function hitNode(event) {
  const direct = event.target?.dataset?.node ? event.target : null
  const nested = event.target?.closest?.('[data-node]')
  return (nested ?? direct)?.dataset?.node || ''
}

// The plane is a zero-width center line, so node x is a center offset and can
// be negative. The wire box is shifted by SPAN so those points stay inside the
// SVG viewport; overflow:visible is not reliable for a stroke on the edge.
const WIRE_SPAN = 480
// A back edge leaves its source downwards and comes back above the target, so the
// wire layer carries a small bleed over the top of the plane (#2122).
const WIRE_BLEED = 24
// The plane keeps its authored 960px coordinates; only the display is scaled to
// the canvas (#1752), and cards, frames and wires share that one transform.
const CARD_HALF = 84
// Authored fallback only: the run cards are taller than this and each one is
// measured, so the frame and the wire ports use the real box (#2122, #1752, #1693).
const CARD_H = 72
const FRAME_SIDE = 108
const FRAME_MARGIN = FRAME_SIDE - CARD_HALF
const MIN_FIT = 0.5
// A port sits inside the card's edge; siblings fan out along it so two wires never
// leave one node from the same point.
const PORT_SPAN = 48
const LANE_STEP = 8
const EDGE_CLEAR = 4

function cardHeight(heights, node) {
  const measured = heights?.[node.id]
  return Number.isFinite(measured) && measured > 0 ? measured : CARD_H
}

function cardBox(node, heights) {
  const x = node.x ?? 0
  const y = node.y ?? 0
  return { left: x - CARD_HALF, right: x + CARD_HALF, top: y, bottom: y + cardHeight(heights, node) }
}

function portX(centre, index, count) {
  if (count <= 1) return centre
  return centre - PORT_SPAN / 2 + (PORT_SPAN * index) / (count - 1)
}

function spanOverlap(a1, a2, b1, b2) {
  return Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2))
}

function horizontalBlocked(boxes, x1, x2, y) {
  return boxes.some((box) => y > box.top + EDGE_CLEAR && y < box.bottom - EDGE_CLEAR
    && spanOverlap(x1, x2, box.left, box.right) > 0)
}

function verticalBlocked(boxes, x, y1, y2) {
  return boxes.some((box) => x > box.left + EDGE_CLEAR && x < box.right - EDGE_CLEAR
    && spanOverlap(y1, y2, box.top, box.bottom) > 0)
}

function laneClear(placed, y, x1, x2) {
  return placed.every((lane) => Math.abs(lane.y - y) > 3 || spanOverlap(x1, x2, lane.x1, lane.x2) <= 20)
}

function verticalLaneClear(placed, x, y1, y2) {
  return placed.every((lane) => Math.abs(lane.x - x) > 3 || spanOverlap(y1, y2, lane.y1, lane.y2) <= 20)
}

function wireChannel(boxes, x1, x2, start, step, limit) {
  for (let y = start; step > 0 ? y <= limit : y >= limit; y += step) {
    if (!horizontalBlocked(boxes, x1, x2, y)) return y
  }
  return start
}

// An edge that cannot cross the gap between two rows goes around the graph on its
// measured side; a back edge always takes that loop (#2122).
function sideRoute(boxes, sx, sy, tx, ty, lane) {
  const right = Math.max(...boxes.map((box) => box.right))
  const left = Math.min(...boxes.map((box) => box.left))
  const roomRight = WIRE_SPAN - 16 - right
  const roomLeft = left + WIRE_SPAN - 16
  const goRight = roomRight >= roomLeft
  const laneX = Math.min(WIRE_SPAN - 16, Math.max(-WIRE_SPAN + 16,
    goRight ? right + 12 + lane * LANE_STEP : left - 12 - lane * LANE_STEP))
  const outY = wireChannel(boxes, sx, laneX, sy + 8, 2, sy + 64)
  const inY = wireChannel(boxes, tx, laneX, ty - 8, -2, ty - 64)
  return [[sx, sy], [sx, outY], [laneX, outY], [laneX, inY], [tx, inY], [tx, ty]]
}

function directRoute(boxes, sx, sy, tx, ty, placed) {
  const mid = (sy + ty) / 2
  const candidates = [mid]
  if (ty - sy > 12) {
    for (let y = sy + 6; y <= ty - 6; y += 4) candidates.push(y)
  }
  candidates.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))
  for (const y of candidates) {
    if (horizontalBlocked(boxes, sx, tx, y)) continue
    if (verticalBlocked(boxes, sx, sy, y) || verticalBlocked(boxes, tx, y, ty)) continue
    if (!laneClear(placed.horizontal, y, sx, tx)) continue
    if (!verticalLaneClear(placed.vertical, sx, sy, y) || !verticalLaneClear(placed.vertical, tx, y, ty)) continue
    return [[sx, sy], [sx, y], [tx, y], [tx, ty]]
  }
  return null
}

// The route lives in the plane's own coordinates; only the rendered `d` is shifted
// into the SVG box, so callers can reason about the cards and the wires together.
function pathOf(points, radius = 10) {
  if (points.length < 2) return ''
  const round = (value) => Math.round((value + WIRE_SPAN) * 10) / 10
  const plain = (value) => Math.round(value * 10) / 10
  let d = `M ${round(points[0][0])} ${plain(points[0][1])}`
  for (let at = 1; at < points.length; at += 1) {
    const point = points[at]
    if (at === points.length - 1) {
      d += ` L ${round(point[0])} ${plain(point[1])}`
      continue
    }
    const previous = points[at - 1]
    const next = points[at + 1]
    const inLength = Math.hypot(point[0] - previous[0], point[1] - previous[1])
    const outLength = Math.hypot(next[0] - point[0], next[1] - point[1])
    const bend = Math.min(radius, inLength / 2, outLength / 2)
    if (bend < 1) {
      d += ` L ${round(point[0])} ${plain(point[1])}`
      continue
    }
    const beforeX = point[0] - ((point[0] - previous[0]) / inLength) * bend
    const beforeY = point[1] - ((point[1] - previous[1]) / inLength) * bend
    const afterX = point[0] + ((next[0] - point[0]) / outLength) * bend
    const afterY = point[1] + ((next[1] - point[1]) / outLength) * bend
    d += ` L ${round(beforeX)} ${plain(beforeY)} Q ${round(point[0])} ${plain(point[1])} ${round(afterX)} ${plain(afterY)}`
  }
  return d
}

// One route per edge: out of the source's bottom port, through a lane in the gap
// between the rows, into the target's top port. A target above its source is a loop
// around the cards, and an edge that cannot cross the gap goes around as well (#2122).
export function routeWires(nodes, edges, heights = {}) {
  const list = nodes ?? []
  const byId = new Map(list.map((node) => [node.id, node]))
  const boxes = list.map((node) => cardBox(node, heights))
  const outgoing = new Map()
  const incoming = new Map()
  for (const edge of edges ?? []) {
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }
  const seenOut = new Map()
  const seenIn = new Map()
  const placed = { horizontal: [], vertical: [] }
  let sideLane = 0
  const routes = []
  for (const edge of edges ?? []) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const outIndex = seenOut.get(edge.from) ?? 0
    seenOut.set(edge.from, outIndex + 1)
    const inIndex = seenIn.get(edge.to) ?? 0
    seenIn.set(edge.to, inIndex + 1)
    const source = cardBox(from, heights)
    const target = cardBox(to, heights)
    const sx = portX((source.left + source.right) / 2, outIndex, outgoing.get(edge.from) ?? 1)
    const tx = portX((target.left + target.right) / 2, inIndex, incoming.get(edge.to) ?? 1)
    const sy = source.bottom
    const ty = target.top
    const back = ty < source.top - 1
    let points = back ? null : directRoute(boxes, sx, sy, tx, ty, placed)
    if (!points) points = sideRoute(boxes, sx, sy, tx, ty, sideLane++)
    points = points.filter((point, at) => at === 0
      || Math.abs(point[0] - points[at - 1][0]) > 0.001 || Math.abs(point[1] - points[at - 1][1]) > 0.001)
    for (let at = 1; at < points.length; at += 1) {
      const [x1, y1] = points[at - 1]
      const [x2, y2] = points[at]
      if (Math.abs(y1 - y2) < 0.001 && Math.abs(x1 - x2) > 0) placed.horizontal.push({ y: y1, x1, x2 })
      if (Math.abs(x1 - x2) < 0.001 && Math.abs(y1 - y2) > 0) placed.vertical.push({ x: x1, y1, y2 })
    }
    routes.push({ from: edge.from, to: edge.to, back, points, d: pathOf(points) })
  }
  return routes
}

// The dashed frame takes the same measured card box as the wires, so its margin is
// equal on all four sides (#2122) instead of the authored 72px metric.
export function parallelFrame(members, heights = {}) {
  const list = (members ?? []).filter(Boolean)
  if (list.length === 0) return null
  const boxes = list.map((node) => cardBox(node, heights))
  const left = Math.min(...boxes.map((box) => box.left)) - FRAME_MARGIN
  const right = Math.max(...boxes.map((box) => box.right)) + FRAME_MARGIN
  const top = Math.min(...boxes.map((box) => box.top)) - FRAME_MARGIN
  const bottom = Math.max(...boxes.map((box) => box.bottom)) + FRAME_MARGIN
  return { left, top, width: right - left, height: bottom - top }
}

// A canvas narrower than the graph shrinks the whole plane, so the frame, the
// cards and the wire into them stay inside it. Authored coordinates do not move.
export function fitScale(nodes, width) {
  const reach = Math.max(0, ...(nodes ?? []).map((node) => Math.abs(node.x ?? 0) + FRAME_SIDE))
  if (!(width > 0) || reach === 0) return 1
  return Math.min(1, Math.max(MIN_FIT, (width / 2) / reach))
}

// #1769: the plane is centred on the canvas, so a graph that does not fit spilled out of
// BOTH edges. The left half of a scroller cannot be reached — `scrollLeft` stops at 0 — so
// the cards and the frame there were cut off and could not be scrolled back into view.
// Once the scale hits MIN_FIT the plane is wider than the canvas by design, so the stage
// reserves that overflow on its left: everything then sits at x >= 0 and the rest of the
// plane scrolls to the right. A graph that fits keeps the #1752 scale and gets no pad, so
// its coordinates do not move.
export function fitLayout(nodes, width) {
  const reach = Math.max(0, ...(nodes ?? []).map((node) => Math.abs(node.x ?? 0) + FRAME_SIDE))
  const scale = fitScale(nodes, width)
  const spare = width > 0 && reach > 0 ? reach * scale - width / 2 : 0
  const pad = spare > 1e-6 ? Math.ceil(spare) : 0
  const centre = width > 0 ? pad + width / 2 : 0
  return {
    reach, scale, pad,
    left: centre - reach * scale,
    right: centre + reach * scale,
    scrollWidth: Math.max(width + pad, centre + reach * scale),
  }
}

// The pad is a padding-box question, and `clientWidth` answers it in the same coordinates as
// `scrollWidth`: border excluded, padding included. The border box would be 1px wider and
// would push the whole plane right, so this reads `clientWidth` alone and never mixes the two.
export function measureCanvasWidth(el) {
  const width = el?.clientWidth
  return Number.isFinite(width) && width > 0 ? width : 0
}

function GraphCanvas({ graph, editing, roster, onCommit, width: knownWidth = 0 }) {
  const gesture = useRef(null)
  const canvasRef = useRef(null)
  const [measuredWidth, setCanvasWidth] = useState(0)
  const nodes = graph.nodes ?? []
  const edges = graph.edges ?? []
  // A live run names every seat. A definition with no run is idle, the way the
  // flowchart looks before anyone presses play — not a queue of work.
  const status = graph.run?.nodeStatus ?? null
  const locals = (roster?.bots ?? []).filter((bot) => bot && bot.remote !== true && !nodes.some((node) => node.botId === bot.id))
  const height = Math.max(420, ...nodes.map((node) => (node.y ?? 0) + 150), 0)
  // The run card is taller than the authored 72px metric and its height changes with
  // the chip and the two text lines, so the frame and the wire ports read the rendered
  // boxes (#2122) instead of assuming a row height.
  const cardElements = useRef(null)
  if (!cardElements.current) cardElements.current = new Map()
  const [cardHeights, setCardHeights] = useState({})
  const nodeKey = nodes.map((node) => node.id).join('|')
  useEffect(() => {
    const measure = () => {
      const next = {}
      for (const [id, el] of cardElements.current) {
        // offsetHeight is the untransformed layout box; getBoundingClientRect would
        // return it times the fitted scale and shrink the frame on a scaled graph.
        const size = el?.offsetHeight || el?.getBoundingClientRect?.().height
        if (Number.isFinite(size) && size > 0) next[id] = Math.round(size * 10) / 10
      }
      setCardHeights((previous) => {
        const ids = Object.keys(next)
        if (ids.length === 0) return previous
        if (ids.length === Object.keys(previous).length && ids.every((id) => previous[id] === next[id])) return previous
        return next
      })
    }
    measure()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(measure)
    for (const el of cardElements.current.values()) observer.observe(el)
    return () => observer.disconnect()
  }, [nodeKey])
  const routes = routeWires(nodes, edges, cardHeights)
  // A host that already knows the width (the editor's tests, an embed) seeds it; the
  // measurement below still wins, so a resize is followed on the next frame.
  const canvasWidth = measuredWidth || knownWidth
  const { scale, pad } = fitLayout(nodes, canvasWidth)
  const drawnHeight = Math.round(height * scale)
  useEffect(() => {
    const el = canvasRef.current
    const measure = () => {
      const width = measureCanvasWidth(el)
      if (width > 0 && Math.abs(width - canvasWidth) > 0.5) setCanvasWidth(width)
    }
    measure()
    if (typeof ResizeObserver !== 'function' || !el) return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [canvasWidth])
  const end = (event) => {
    const current = gesture.current
    gesture.current = null
    if (!current || !editing) return
    if (current.kind === 'move') {
      const x = Math.round(current.x + (event.clientX - current.ox) / scale)
      const y = Math.round(current.y + (event.clientY - current.oy) / scale)
      onCommit?.({ nodes: moveNode(nodes, current.id, x, y), edges })
    } else if (current.kind === 'wire') {
      const next = connectNodes(edges, current.from, hitNode(event))
      if (next !== edges) onCommit?.({ nodes, edges: next })
    } else if (current.kind === 'add' && event.target?.dataset?.plane) {
      const x = Number.isFinite(event.offsetX) ? Math.round(event.offsetX / scale) : 24
      const y = Number.isFinite(event.offsetY) ? Math.round(event.offsetY / scale) : 24
      onCommit?.({ nodes: dropBot(nodes, current.bot, x, y), edges })
    }
  }
  return h('div', { className: 'bt-wf-canvas', ref: canvasRef, onPointerUp: end },
    editing ? h('div', { className: 'bt-wf-palette' },
      h('span', { className: 'bt-wf-hint' }, t('Drag a Bot here')),
      locals.map((bot) => h('button', {
        key: bot.id, type: 'button', 'data-bot': bot.id,
        onPointerDown: (event) => { event.preventDefault?.(); gesture.current = { kind: 'add', bot } },
      }, bot.name))) : null,
    // A node's system prompt is the run Bot's prompt (plugins/workflow
    // nodeConfig). The sidebar panel has this field, so the Settings editor
    // writes the same graph instead of only drawing it (#1393).
    editing ? h('div', { className: 'bt-wf-prompts' }, nodes.map((node) => h('label', { key: node.id, className: 'bt-wf-prompt' },
      h('span', null, `${node.name} · ${t('System prompt')}`),
      h('textarea', {
        'data-prompt': node.id,
        rows: 3,
        defaultValue: node.prompt || '',
        onPointerDown: (event) => event.stopPropagation?.(),
        onBlur: (event) => {
          const prompt = event.target?.value ?? ''
          if (prompt === (node.prompt || '')) return
          onCommit?.({ nodes: nodes.map((item) => (item.id === node.id ? { ...item, prompt } : item)), edges })
        },
      })))) : null,
    h('div', { className: 'bt-wf-stage', style: pad > 0 ? { height: drawnHeight, paddingLeft: pad } : { height: drawnHeight } },
      h('div', { className: 'bt-wf-fit', style: { height, transform: `scale(${scale})` } },
        h('div', { className: 'bt-wf-plane', 'data-plane': '1', style: { height, '--bt-wf-wire-span': `${WIRE_SPAN}px` } },
      h('svg', {
        className: 'bt-wf-wires', 'aria-hidden': true,
        width: WIRE_SPAN * 2, height: height + WIRE_BLEED,
        viewBox: `0 ${-WIRE_BLEED} ${WIRE_SPAN * 2} ${height + WIRE_BLEED}`,
        style: { top: -WIRE_BLEED },
      },
      h('defs', null,
        h('marker', {
          id: 'bt-wf-arrow', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto',
        }, h('path', { d: 'M0 0 10 5 0 10z' }))),
      routes.map((route) => h('path', {
        key: `${route.from}>${route.to}`, d: route.d,
        'data-wire': `${route.from}>${route.to}`,
        markerEnd: 'url(#bt-wf-arrow)',
      }))),
      (graph.layers ?? []).filter((layer) => layer.length > 1).map((layer) => {
        const members = layer.map((id) => nodes.find((node) => node.id === id)).filter(Boolean)
        if (members.length < 2) return null
        const frame = parallelFrame(members, cardHeights)
        return h('div', {
          key: layer.join('+'), className: 'bt-wf-par',
          style: { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
        }, h('div', { className: 'bt-wf-plabel' }, t('Parallel branch, then join')))
      }),
      nodes.map((node) => {
        const state = status ? (status[node.id] ?? 'queued') : 'idle'
        return h('div', {
          key: node.id, 'data-node': node.id, className: `bt-wf-node ${state}${editing ? ' editing' : ''}`,
          style: { left: (node.x ?? 0) - CARD_HALF, top: node.y ?? 0 },
          ref: (el) => {
            if (el) cardElements.current.set(node.id, el)
            else cardElements.current.delete(node.id)
          },
          onPointerDown: (event) => {
            if (!editing || event.target?.dataset?.port || event.target?.dataset?.remove) return
            gesture.current = { kind: 'move', id: node.id, ox: event.clientX, oy: event.clientY, x: node.x ?? 0, y: node.y ?? 0 }
          },
        },
        editing ? h('button', {
          type: 'button', className: 'bt-wf-port', 'data-port': 'out', 'aria-label': node.name,
          onPointerDown: (event) => { event.preventDefault?.(); event.stopPropagation?.(); gesture.current = { kind: 'wire', from: node.id } },
        }) : null,
        editing ? h('button', {
          type: 'button', className: 'bt-wf-remove', 'data-remove': node.id, 'aria-label': t('Remove'),
          onClick: (event) => {
            event.stopPropagation?.()
            const next = removeNode(nodes, edges, node.id)
            onCommit?.(next)
          },
        }, '×') : null,
        h('span', { className: `bt-wf-chip ${state}` }, statusLabel(state)),
        // #2017: one code point, not one UTF-16 unit — a name that starts with an emoji
        // would otherwise put half a surrogate pair in the circle.
        h('span', { className: 'bt-wf-av', style: { background: COLORS[node.name] ?? '#4d6bfe' } }, Array.from(String(node.name ?? '').trim())[0] ?? '?'),
        h('span', { className: 'bt-wf-copy' },
          h('span', { className: 'bt-wf-name' }, node.name),
          h('span', { className: 'bt-wf-role' }, node.role ?? '')))
      })))))
}

function Row({ item, source, onOpen, onRename, onDelete }) {
  return h('button', {
    type: 'button', className: 'bt-set-row', 'data-workflow': item.id, 'data-source': source,
    onClick: () => onOpen?.(item),
  },
  h('span', { className: 'bt-set-copy' },
    h('span', null, item.name),
    h('span', { className: 'bt-set-hint' }, item.preview || chainOf(item) || item.description || '')),
  source === 'own' ? h('span', { className: 'bt-set-actions' },
    h('button', {
      type: 'button', className: 'bt-set-action', 'aria-label': t('Rename'), title: t('Rename'),
      onClick: (event) => { event.stopPropagation(); onRename?.(item) },
    }, '✎'),
    h('button', {
      type: 'button', className: 'bt-set-action', 'aria-label': t('Delete'), title: t('Delete'),
      onClick: (event) => { event.stopPropagation(); onDelete?.(item) },
    }, '×')) : null,
  h('span', { className: 'bt-chevron', 'aria-hidden': true }, '›'))
}

function alertCopy(error) {
  if (error === WORKFLOW_PLUGIN_HINT) return t('The Workflow plugin is not installed or not enabled. A default install includes @flybot/workflow.')
  return error || t('Could not read workflows')
}

export function WorkflowsView({ phase = 'loading', pack = null, error = '', opened = null, editing = false, roster = null, canvasWidth = 0, onOpen, onBack, onEditing, onRetry, onUse, onCommit, onRename, onDelete }) {
  const graph = phase === 'ready' ? openedGraph(pack, opened) : null
  const templates = pack?.templates ?? []
  const templateIds = new Set(templates.map((item) => item.id))
  const yours = (pack?.workflows ?? []).filter((item) => !templateIds.has(item.id))
  const showUse = opened?.source === 'factory' || opened?.fromFactory !== undefined
  return h('div', { className: 'bt-wf-page' },
    h('p', { className: 'bt-wf-hint' }, t('A workflow is a group of your Bots. Drag the flowchart to change who hands work to whom.')),
    error ? h('div', { className: 'bt-error', role: 'alert' }, alertCopy(error),
      phase === 'error' ? h('button', { type: 'button', onClick: () => onRetry?.() }, t('Retry')) : null) : null,
    phase === 'loading' ? h('p', { className: 'bt-wf-status', role: 'status' }, t('Reading workflows…')) : null,
    phase === 'empty' ? h('p', { className: 'bt-wf-status' }, t('No workflows yet.')) : null,
    phase === 'ready' && !graph ? h('div', { className: 'bt-wf-lists' },
      h('section', { className: 'bt-set-section' },
        h('h3', null, t('Factory presets')),
        h('p', { className: 'bt-wf-hint' }, t('Ready-made pipelines. Use one to start your own.')),
        h('div', { className: 'bt-set-card' },
          templates.length === 0
            ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No workflows yet.')))
            : templates.map((item) => {
              const live = (pack.workflows ?? []).find((workflow) => workflow.id === item.id)
              const row = live ? { ...item, name: live.name, preview: live.preview || chainOf(live) || chainOf(item) } : item
              return h(Row, { key: item.id, item: row, source: 'factory', onOpen: () => onOpen?.(item, 'factory') })
            }))),
      h('section', { className: 'bt-set-section' },
        h('h3', null, t('Yours')),
        h('p', { className: 'bt-wf-hint' }, t('Workflows saved on this machine.')),
        h('div', { className: 'bt-set-card' },
          yours.length === 0
            ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No workflows of your own yet.')))
            : yours.map((item) => h(Row, { key: item.id, item, source: 'own', onOpen: () => onOpen?.(item, 'own'), onRename, onDelete }))))) : null,
    graph ? h('div', { className: 'bt-wf-editor' },
      h('div', { className: 'bt-wf-actions' },
        h('button', { type: 'button', onClick: () => onBack?.() }, t('Back')),
        showUse ? h('button', { type: 'button', onClick: () => onUse?.(opened.source === 'factory' ? opened.id : opened.fromFactory) }, t('Use this')) : null,
        opened?.source === 'own' ? h('button', { type: 'button', onClick: () => onEditing?.(!editing) }, editing ? t('Finish editing') : t('Edit')) : null),
      h('h3', { className: 'bt-wf-title' }, graph.name),
      graph.description ? h('p', { className: 'bt-wf-hint' }, graph.description) : null,
      (graph.nodes ?? []).length === 0
        ? h('p', { className: 'bt-wf-status' }, t('This workflow has no flowchart yet.'))
        : h(GraphCanvas, {
          graph, roster, onCommit, width: canvasWidth,
          editing: opened?.source === 'own' && editing === true,
        })) : null)
}

function RenameModal({ workflow, onClose, onConfirm }) {
  const [name, setName] = useState(workflow?.name ?? '')
  return h('div', { className: 'bt-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose?.() } },
    h('div', { className: 'bt-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('Rename workflow') },
      h('h3', null, t('Rename workflow')),
      h('label', { className: 'bt-field' },
        t('Name'),
        h('input', { type: 'text', value: name, onChange: (event) => setName(event.target.value), autoFocus: true })),
      h('div', { className: 'bt-modal-actions' },
        h('button', { type: 'button', onClick: onClose }, t('Cancel')),
        h('button', { type: 'button', onClick: () => onConfirm?.(name) }, t('Rename')))))
}

function DeleteModal({ workflow, onClose, onConfirm }) {
  return h('div', { className: 'bt-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose?.() } },
    h('div', { className: 'bt-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('Delete workflow') },
      h('h3', null, t('Delete workflow')),
      h('p', null, t('Are you sure you want to delete "{name}"? This cannot be undone.', { name: workflow?.name ?? '' })),
      h('div', { className: 'bt-modal-actions' },
        h('button', { type: 'button', onClick: onClose }, t('Cancel')),
        h('button', { type: 'button', className: 'bt-danger', onClick: onConfirm }, t('Delete')))))
}

export function WorkflowsPage({ call, roster }) {
  const [phase, setPhase] = useState('loading')
  const [pack, setPack] = useState(null)
  const [error, setError] = useState('')
  const [opened, setOpened] = useState(null)
  const [editing, setEditing] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const invoke = typeof call === 'function' ? call : () => Promise.reject(new Error('Could not read workflows'))

  const apply = (settled) => {
    setPhase(settled.phase)
    setPack(settled.pack)
    setError(settled.error)
  }

  useEffect(() => {
    let gone = false
    readWorkflows(invoke).then((settled) => { if (!gone) apply(settled) })
    return () => { gone = true }
  }, [])

  // The page used to read once, so a running step's chip kept the colour it had at
  // mount. While any workflow is live it asks again on the room's beat; an edit
  // suspends that, because a refresh would land in the middle of one (#1810).
  const live = (pack?.workflows ?? []).some((item) => (item.activeCount ?? 0) > 0)
  useEffect(() => {
    if (!live || editing) return undefined
    let gone = false
    const timer = setInterval(() => {
      readWorkflows(invoke).then((settled) => { if (!gone) apply(settled) })
    }, POLL_MS)
    return () => { gone = true; clearInterval(timer) }
  }, [live, editing])

  const retry = () => {
    setPhase('loading')
    setError('')
    setOpened(null)
    readWorkflows(invoke).then(apply)
  }

  const open = (item, source) => {
    if (source === 'factory') {
      const live = (pack?.workflows ?? []).find((workflow) => workflow.id === item.id)
      setOpened(live ? { source: 'own', id: live.id, fromFactory: item.id } : { source: 'factory', id: item.id })
      setEditing(false)
      return
    }
    setOpened({ source: 'own', id: item.id })
    setEditing(false)
  }

  const useTemplate = (id) => {
    const template = typeof id === 'string' ? id : ''
    if (!template) return
    Promise.resolve(invoke('workflow/create', { template }))
      .then((value) => {
        const settled = settleWorkflowRead(value)
        if (settled.phase === 'error') { setError(settled.error); return }
        const before = new Set((pack?.workflows ?? []).map((item) => item.id))
        const made = settled.pack.workflows.find((item) => !before.has(item.id))
        setPack(settled.pack)
        setPhase(settled.phase)
        setError('')
        if (made) { setOpened({ source: 'own', id: made.id }); setEditing(true) }
      })
      .catch((failure) => { setError(workflowCallError(failure, t('Could not copy this workflow'))) })
  }

  const rename = (item) => {
    setRenaming(item)
  }

  const confirmRename = (workflowId, name) => {
    if (!name.trim()) return
    Promise.resolve(invoke('workflow/rename', { workflowId, name: name.trim() }))
      .then((value) => {
        const settled = settleWorkflowRead(value)
        if (settled.phase === 'error') { setError(settled.error); return }
        setPack(settled.pack)
        setPhase('ready')
        setError('')
        setRenaming(null)
      })
      .catch((failure) => { setError(workflowCallError(failure, t('Could not rename this workflow'))) })
  }

  const deleteWorkflow = (item) => {
    setDeleting(item)
  }

  const confirmDelete = (workflowId) => {
    Promise.resolve(invoke('workflow/delete', { workflowId }))
      .then((value) => {
        const settled = settleWorkflowRead(value)
        if (settled.phase === 'error') { setError(settled.error); return }
        setPack(settled.pack)
        setPhase(settled.phase)
        setError('')
        setDeleting(null)
        if (opened?.id === workflowId) setOpened(null)
      })
      .catch((failure) => { setError(workflowCallError(failure, t('Could not delete this workflow'))) })
  }

  const commit = (graph) => {
    if (!opened || opened.source !== 'own') return
    Promise.resolve(invoke('workflow/graph', { workflowId: opened.id, nodes: graph.nodes, edges: graph.edges }))
      .then((value) => {
        const settled = settleWorkflowRead(value)
        if (settled.phase === 'error') { setError(settled.error); return }
        setPack(settled.pack)
        setPhase('ready')
        setError('')
      })
      .catch((failure) => { setError(workflowCallError(failure, t('Could not save this workflow'))) })
  }

  return h('div', null,
    h(WorkflowsView, {
      phase, pack, error, opened, editing, roster,
      onOpen: open, onBack: () => { setOpened(null); setEditing(false) }, onEditing: setEditing, onRetry: retry, onUse: useTemplate, onCommit: commit,
      onRename: rename, onDelete: deleteWorkflow,
    }),
    renaming ? h(RenameModal, {
      workflow: renaming,
      onClose: () => setRenaming(null),
      onConfirm: (name) => confirmRename(renaming.id, name),
    }) : null,
    deleting ? h(DeleteModal, {
      workflow: deleting,
      onClose: () => setDeleting(null),
      onConfirm: () => confirmDelete(deleting.id),
    }) : null)
}
