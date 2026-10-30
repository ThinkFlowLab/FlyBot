// Settings → Workflows (#1364). The page lists the factory pipelines and the
// workflows saved on this machine, and opens the same drag-drop flowchart the
// sidebar run uses. A read always settles: a host that never answers becomes
// an error, an empty store says so, and the file path is not the page.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

export const READ_MS = 8000

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
const NODE_WIRE_OUT = 56
// The plane keeps its authored 960px coordinates; only the display is scaled to
// the canvas (#1752), and cards, frames and wires share that one transform.
const CARD_HALF = 84
const CARD_H = 72
const FRAME_SIDE = 108
const FRAME_LABEL = 18
const FRAME_FOOT = 10
const MIN_FIT = 0.5

function wirePath(from, to) {
  const x1 = from.x + WIRE_SPAN
  const y1 = from.y + NODE_WIRE_OUT
  const x2 = to.x + WIRE_SPAN
  const y2 = to.y
  const mid = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
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
        width: WIRE_SPAN * 2, height, viewBox: `0 0 ${WIRE_SPAN * 2} ${height}`,
      },
      h('defs', null,
        h('marker', {
          id: 'bt-wf-arrow', viewBox: '0 0 10 10', refX: '8', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto',
        }, h('path', { d: 'M0 0 10 5 0 10z' }))),
      edges.map((edge) => {
        const from = nodes.find((node) => node.id === edge.from)
        const to = nodes.find((node) => node.id === edge.to)
        if (!from || !to) return null
        return h('path', { key: `${edge.from}>${edge.to}`, d: wirePath(from, to), markerEnd: 'url(#bt-wf-arrow)' })
      })),
      (graph.layers ?? []).filter((layer) => layer.length > 1).map((layer) => {
        const members = layer.map((id) => nodes.find((node) => node.id === id)).filter(Boolean)
        if (members.length < 2) return null
        const left = Math.min(...members.map((node) => node.x ?? 0)) - FRAME_SIDE
        const right = Math.max(...members.map((node) => node.x ?? 0)) + FRAME_SIDE
        const top = Math.min(...members.map((node) => node.y ?? 0)) - FRAME_LABEL
        const bottom = Math.max(...members.map((node) => node.y ?? 0)) + CARD_H + FRAME_FOOT
        return h('div', {
          key: layer.join('+'), className: 'bt-wf-par',
          style: { left, top, width: right - left, height: bottom - top },
        }, h('div', { className: 'bt-wf-plabel' }, t('Parallel branch, then join')))
      }),
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
        h('span', { className: 'bt-wf-av', style: { background: COLORS[node.name] ?? '#4d6bfe' } }, (node.name ?? '?').slice(0, 1)),
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
