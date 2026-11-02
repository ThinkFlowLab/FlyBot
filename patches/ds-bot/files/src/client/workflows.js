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
// The plane keeps its authored 960px coordinates; only the display is scaled to
// the canvas (#1752), and cards, frames and wires share that one transform.
const CARD_HALF = 84
const CARD_H = 72
const FRAME_SIDE = 108
const MIN_FIT = 0.5
// #2122: a wire is routed on its own lane. Each edge leaves its port, turns onto a
// lane no other wire holds, and joins the target's port; a back edge (its target
// above its source) leaves and lands on the right edges and loops outside every
// card, so it is a visible return path instead of a flattened stub. A parallel frame
// is the union of the measured cards plus one margin on every side; 72px is a floor.
const WIRE_GAP = 14
const WIRE_LANE = 12
const FRAME_PAD = 16
// #2122: a lane has to clear half a card plus the gap, or it runs along the card's
// own edge. The search used to stop at ±5 lanes (±60px), inside a 168px card, so a
// card on the wire's column covered every candidate and the route fell back onto it.
const LANE_REACH = Math.ceil((CARD_HALF + WIRE_GAP) / WIRE_LANE) + 1
const LANE_STEPS = [0]
for (let step = 1; step <= LANE_REACH; step += 1) LANE_STEPS.push(step, -step)

export function cardBoxes(nodes, heights = {}) {
  const boxes = new Map()
  for (const node of nodes ?? []) {
    const height = Number(heights?.[node.id]) > 0 ? Number(heights[node.id]) : CARD_H
    const top = node.y ?? 0
    boxes.set(node.id, { id: node.id, cx: node.x ?? 0, top, bottom: top + height, height })
  }
  return boxes
}

const rightOf = (box) => box.cx + CARD_HALF
const leftOf = (box) => box.cx - CARD_HALF

function cutsCard(boxes, x1, y1, x2, y2, from, to) {
  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  const minY = Math.min(y1, y2)
  const maxY = Math.max(y1, y2)
  return boxes.some((box) => box !== from && box !== to
    && maxX > leftOf(box) + 1 && minX < rightOf(box) - 1 && maxY > box.top + 1 && minY < box.bottom - 1)
}

// #2126 turned a back edge at the two cards' centres: one run left the source's right
// edge and one landed on the target's. A parallel layer seats a card on that same row,
// so either run crossed it — and the card, drawn on top, hid the wire, which then read
// as a link to the neighbour. Each turn now runs in the gap just outside its own card's
// row, and walks further out until nothing sits on it.
function clearRun(boxes, id, y, xa, xb, dir) {
  const lo = Math.min(xa, xb)
  const hi = Math.max(xa, xb)
  let level = y
  for (let step = 0; step < LANE_REACH * 4; step += 1) {
    const blocked = boxes.some((box) => box.id !== id
      && hi > leftOf(box) + 1 && lo < rightOf(box) - 1
      && level > box.top + 1 && level < box.bottom - 1)
    if (!blocked) return level
    level += dir * WIRE_LANE
  }
  return level
}

function rowGap(boxes, box, dir) {
  const edge = dir < 0 ? box.top : box.bottom
  const others = boxes.filter((one) => one.id !== box.id
    && (dir < 0 ? one.bottom <= box.top + 1 : one.top >= box.bottom - 1))
  if (!others.length) return edge + dir * WIRE_GAP
  const near = dir < 0
    ? Math.max(...others.map((one) => one.bottom))
    : Math.min(...others.map((one) => one.top))
  return (near + edge) / 2
}

function laneFor(base, yA, yB, boxes, from, to, taken) {
  const open = (x) => !taken.some((lane) => Math.abs(lane.x - x) < WIRE_LANE - 0.5 && lane.yA < yB && yA < lane.yB)
    && !boxes.some((box) => box !== from && box !== to
      && Math.abs(x - box.cx) < CARD_HALF + WIRE_GAP && yA < box.bottom && yB > box.top)
  for (const step of LANE_STEPS) if (open(base + step * WIRE_LANE)) return base + step * WIRE_LANE
  // Every lane within reach is held by another wire; walk further out rather than
  // dropping this one back onto the column the cards sit on.
  for (let step = LANE_REACH + 1; step <= LANE_REACH * 3; step += 1) {
    if (open(base + step * WIRE_LANE)) return base + step * WIRE_LANE
    if (open(base - step * WIRE_LANE)) return base - step * WIRE_LANE
  }
  return base
}

export function wireRoutes(nodes, edges, heights = {}) {
  const boxes = [...cardBoxes(nodes, heights).values()]
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const drawn = (edges ?? [])
    .map((edge, index) => ({ index, from: byId.get(edge.from), to: byId.get(edge.to) }))
    .filter((item) => item.from && item.to)
  const rightMost = boxes.length ? Math.max(...boxes.map(rightOf)) : 0
  const taken = []
  const routes = []
  drawn.filter((item) => item.to.top < item.from.top)
    .sort((a, b) => a.from.top - b.from.top || a.index - b.index)
    .forEach((item, at) => {
      const x1 = rightOf(item.from)
      const x2 = rightOf(item.to)
      const y1 = item.from.top + item.from.height / 2
      const y2 = item.to.top + item.to.height / 2
      const lane = rightMost + WIRE_GAP + at * WIRE_LANE
      const yA = clearRun(boxes, item.from.id, rowGap(boxes, item.from, -1), x1, lane, -1)
      const yB = clearRun(boxes, item.to.id, rowGap(boxes, item.to, 1), x2, lane, 1)
      routes.push({
        key: `${item.from.id}>${item.to.id}`,
        back: true,
        d: `M ${x1} ${y1} L ${x1} ${yA} L ${lane} ${yA} L ${lane} ${yB} L ${x2} ${yB} L ${x2} ${y2}`,
      })
      taken.push({ x: lane, yA: Math.min(yA, yB), yB: Math.max(yA, yB) })
    })
  // A back edge turns at its cards' centres; a forward edge keeps clear of them.
  const centres = []
  for (const item of drawn.filter((one) => one.to.top < one.from.top)) centres.push(item.from.top + item.from.height / 2, item.to.top + item.to.height / 2)
  const clearOf = (y, push) => (centres.some((centre) => Math.abs(centre - y) < 4) ? y + push * 8 : y)
  for (const item of drawn.filter((one) => one.to.top >= one.from.top)) {
    const x1 = item.from.cx
    const x2 = item.to.cx
    const y1 = item.from.bottom
    const y2 = item.to.top
    const gap = Math.max(0, Math.min(WIRE_GAP, (y2 - y1) / 2))
    const yA = clearOf(y1 + gap, 1)
    const yB = clearOf(y2 - gap, -1)
    const lane = laneFor((x1 + x2) / 2, yA, yB, boxes, item.from, item.to, taken)
    taken.push({ x: lane, yA, yB })
    // Round a card on the column even when the lane search found nothing: a straight
    // run between two cards that share an x is only allowed when nothing sits between.
    const straight = Math.abs(lane - x1) < 0.5 && Math.abs(lane - x2) < 0.5
      && !cutsCard(boxes, x1, y1, x2, y2, item.from, item.to)
    routes.push({
      key: `${item.from.id}>${item.to.id}`,
      back: false,
      d: straight
        ? `M ${x1} ${y1} L ${x1} ${y2}`
        : `M ${x1} ${y1} L ${x1} ${yA} L ${lane} ${yA} L ${lane} ${yB} L ${x2} ${yB} L ${x2} ${y2}`,
    })
  }
  return routes
}

export function parallelFrames(nodes, layers, heights = {}) {
  const boxes = cardBoxes(nodes, heights)
  const frames = []
  for (const layer of layers ?? []) {
    if (!Array.isArray(layer) || layer.length < 2) continue
    const members = layer.map((id) => boxes.get(id)).filter(Boolean)
    if (members.length < 2) continue
    const left = Math.min(...members.map(leftOf)) - FRAME_PAD
    const right = Math.max(...members.map(rightOf)) + FRAME_PAD
    const top = Math.min(...members.map((box) => box.top)) - FRAME_PAD
    const bottom = Math.max(...members.map((box) => box.bottom)) + FRAME_PAD
    frames.push({ key: layer.join('+'), left, top, width: right - left, height: bottom - top })
  }
  return frames
}

function sameHeights(one, two) {
  if (!one || !two) return false
  const keys = Object.keys(two)
  return keys.length === Object.keys(one).length && keys.every((key) => one[key] === two[key])
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

function GraphCanvas({ graph, editing, roster, onCommit, width: knownWidth = 0, cardHeights: knownHeights = null }) {
  const gesture = useRef(null)
  const canvasRef = useRef(null)
  const [measuredWidth, setCanvasWidth] = useState(0)
  const [measuredHeights, setCardHeights] = useState(null)
  const nodes = graph.nodes ?? []
  const edges = graph.edges ?? []
  // A live run names every seat. A definition with no run is idle, the way the
  // flowchart looks before anyone presses play — not a queue of work.
  const status = graph.run?.nodeStatus ?? null
  const locals = (roster?.bots ?? []).filter((bot) => bot && bot.remote !== true && !nodes.some((node) => node.botId === bot.id))
  // A host that already knows the width (the editor's tests, an embed) seeds it; the
  // measurement below still wins, so a resize is followed on the next frame. Card
  // heights work the same way: the authored 72px is a floor until a card is measured.
  const canvasWidth = measuredWidth || knownWidth
  const heights = measuredHeights ?? knownHeights ?? {}
  const boxes = cardBoxes(nodes, heights)
  const height = Math.max(420, ...nodes.map((node) => (node.y ?? 0) + (boxes.get(node.id)?.height ?? CARD_H) + 78), 0)
  const { scale, pad } = fitLayout(nodes, canvasWidth)
  const drawnHeight = Math.round(height * scale)
  const routes = wireRoutes(nodes, edges, heights)
  const frames = parallelFrames(nodes, graph.layers, heights)
  const nodeKey = nodes.map((node) => node.id).join(',')
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
  // The frame and the wires follow the card as it really is: a status chip and two
  // text lines make it taller than the authored 72px, and a wire that leaves the
  // authored bottom cuts through the card below it (#2122).
  useEffect(() => {
    const el = canvasRef.current
    if (!el || typeof el.querySelectorAll !== 'function') return undefined
    const measure = () => {
      const next = {}
      for (const card of el.querySelectorAll('[data-node]')) {
        const cardHeight = card.offsetHeight
        if (cardHeight > 0) next[card.dataset.node] = cardHeight
      }
      setCardHeights((previous) => (sameHeights(previous, next) ? previous : next))
    }
    measure()
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(measure)
    for (const card of el.querySelectorAll('[data-node]')) observer.observe(card)
    return () => observer.disconnect()
  }, [nodeKey, scale])
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
        width: WIRE_SPAN * 2, height, viewBox: `0 0 ${WIRE_SPAN * 2} ${height}`,
      },
      h('defs', null,
        h('marker', {
          id: 'bt-wf-arrow', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto',
        }, h('path', { d: 'M0 0 10 5 0 10z' }))),
      h('g', { transform: `translate(${WIRE_SPAN} 0)` }, routes.map((route) => h('path', {
        key: route.key, d: route.d, markerEnd: 'url(#bt-wf-arrow)',
        'data-route': route.back ? 'back' : 'forward',
      })))),
      frames.map((frame) => h('div', {
        key: frame.key, className: 'bt-wf-par',
        style: { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
      }, h('div', { className: 'bt-wf-plabel' }, t('Parallel branch, then join')))),
      nodes.map((node) => {
        const state = status ? (status[node.id] ?? 'queued') : 'idle'
        return h('div', {
          key: node.id, 'data-node': node.id, className: `bt-wf-node ${state}${editing ? ' editing' : ''}`,
          style: { left: (node.x ?? 0) - CARD_HALF, top: node.y ?? 0 },
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

export function WorkflowsView({ phase = 'loading', pack = null, error = '', opened = null, editing = false, roster = null, canvasWidth = 0, cardHeights = null, onOpen, onBack, onEditing, onRetry, onUse, onCommit, onRename, onDelete }) {
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
          graph, roster, onCommit, width: canvasWidth, cardHeights,
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
