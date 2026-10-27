// A workflow is a directed graph of local Bots. An edge is a hand-off.
// Nodes that share a rank run together; a node starts only when every Bot
// that points at it is done (a join). A failed Bot holds its successors.
// The same nodes, edges and positions are what the canvas edits and what a
// run paints: x/y are the owner's layout, ranks are derived from the edges.

const STATUSES = new Set(['queued', 'running', 'done', 'failed'])
const ID_RE = /^[a-z][a-z0-9-]{0,40}$/
const GAP_X = 188
const GAP_Y = 108

function stripControls(value) {
  let out = ''
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0)
    out += code <= 0x1f || code === 0x7f ? ' ' : ch
  }
  return out
}

export function cleanLine(value, max = 300) {
  return stripControls(value).replace(/\s+/g, ' ').trim().slice(0, max)
}

function coord(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(-2000, Math.min(4000, Math.round(number)))
}

export function edgesFromLayers(layers) {
  const edges = []
  for (let index = 0; index < layers.length - 1; index += 1) {
    for (const from of layers[index]) {
      for (const to of layers[index + 1]) edges.push({ from, to })
    }
  }
  return edges
}

// Longest-path ranks. A cycle is refused. Nodes keep their list order inside a rank.
export function ranksOf(nodes, edges) {
  const ids = nodes.map(node => node.id)
  const known = new Set(ids)
  const preds = new Map(ids.map(id => [id, []]))
  const succs = new Map(ids.map(id => [id, []]))
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) throw new Error(`Link names an unknown Bot ${edge.from} → ${edge.to}`)
    if (edge.from === edge.to) throw new Error('A Bot cannot connect to itself')
    preds.get(edge.to).push(edge.from)
    succs.get(edge.from).push(edge.to)
  }
  const indegree = new Map(ids.map(id => [id, preds.get(id).length]))
  const queue = ids.filter(id => indegree.get(id) === 0)
  const order = []
  while (queue.length > 0) {
    const id = queue.shift()
    order.push(id)
    for (const to of succs.get(id)) {
      indegree.set(to, indegree.get(to) - 1)
      if (indegree.get(to) === 0) queue.push(to)
    }
  }
  if (order.length !== ids.length) throw new Error('A workflow graph cannot contain a cycle')
  const rank = new Map(ids.map(id => [id, 0]))
  for (const id of order) {
    const incoming = preds.get(id)
    rank.set(id, incoming.length === 0 ? 0 : 1 + Math.max(...incoming.map(pred => rank.get(pred))))
  }
  const index = new Map(ids.map((id, place) => [id, place]))
  const layers = []
  for (const id of order) {
    const place = rank.get(id)
    if (place > 11) throw new Error('A workflow has at most 12 steps')
    layers[place] ??= []
    layers[place].push(id)
  }
  for (const layer of layers) {
    if (layer.length > 6) throw new Error('A parallel step seats at most 6 Bots')
    layer.sort((a, b) => index.get(a) - index.get(b))
  }
  return { layers, preds }
}

function layoutNodes(nodes, layers) {
  const place = new Map()
  layers.forEach((layer, row) => {
    layer.forEach((id, column) => {
      place.set(id, {
        x: Math.round((column - (layer.length - 1) / 2) * GAP_X),
        y: row * GAP_Y,
      })
    })
  })
  return nodes.map(node => {
    const fallback = place.get(node.id) ?? { x: 0, y: 0 }
    return { ...node, x: coord(node.x, fallback.x), y: coord(node.y, fallback.y) }
  })
}

function checkNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('A workflow needs at least one Bot')
  if (nodes.length > 24) throw new Error('A workflow seats at most 24 Bots')
  const ids = new Set()
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !ID_RE.test(node.id)) throw new Error('A node id is a short lowercase name')
    if (ids.has(node.id)) throw new Error(`Node ${node.id} is listed twice`)
    ids.add(node.id)
    if (cleanLine(node.name, 80) === '') throw new Error(`Node ${node.id} needs a name`)
  }
  return ids
}

function checkLayers(layers, ids) {
  if (!Array.isArray(layers) || layers.length === 0) throw new Error('A workflow needs at least one step')
  if (layers.length > 12) throw new Error('A workflow has at most 12 steps')
  const seen = new Set()
  for (const layer of layers) {
    if (!Array.isArray(layer) || layer.length === 0) throw new Error('A step needs at least one Bot')
    if (layer.length > 6) throw new Error('A parallel step seats at most 6 Bots')
    for (const id of layer) {
      if (!ids.has(id)) throw new Error(`Step names an unknown Bot ${id}`)
      if (seen.has(id)) throw new Error(`Bot ${id} is in more than one step`)
      seen.add(id)
    }
  }
  if (seen.size !== ids.size) throw new Error('Every Bot belongs to one step')
}

// Edges are the source of truth once they exist. A layers-only graph (the
// templates, and a create call that sends steps) grows the bipartite edges
// between consecutive steps, which is the same join the ranks then recover.
export function normalizeGraph(graph) {
  if (!graph || typeof graph !== 'object') throw new Error('A workflow needs a graph')
  const ids = checkNodes(graph.nodes)
  let edges
  if (Array.isArray(graph.edges)) {
    if (graph.edges.length > 64) throw new Error('A workflow has at most 64 links')
    const seen = new Set()
    edges = graph.edges.map(edge => {
      const from = String(edge?.from ?? '')
      const to = String(edge?.to ?? '')
      const key = `${from}>${to}`
      if (seen.has(key)) throw new Error(`Link ${from} → ${to} is listed twice`)
      seen.add(key)
      return { from, to }
    })
  } else {
    checkLayers(graph.layers, ids)
    edges = edgesFromLayers(graph.layers)
  }
  const { layers } = ranksOf(graph.nodes, edges)
  const nodes = layoutNodes(graph.nodes.map(node => ({ ...node })), layers)
  return { ...graph, nodes, edges, layers }
}

export function validateGraph(graph) {
  return normalizeGraph(graph)
}

function ensure(graph) {
  if (Array.isArray(graph?.edges) && Array.isArray(graph?.layers) && graph.nodes?.every(node => Number.isFinite(node.x) && Number.isFinite(node.y))) return graph
  const next = normalizeGraph(graph)
  graph.nodes = next.nodes
  graph.edges = next.edges
  graph.layers = next.layers
  return graph
}

function cloneGraph(graph) {
  const ready = ensure(graph)
  return {
    ...ready,
    nodes: ready.nodes.map(node => ({ ...node })),
    edges: ready.edges.map(edge => ({ ...edge })),
    layers: ready.layers.map(layer => [...layer]),
  }
}

export function moveNode(graph, nodeId, x, y) {
  const next = cloneGraph(graph)
  const node = next.nodes.find(item => item.id === nodeId)
  if (!node) throw new Error(`Unknown Bot ${nodeId}`)
  node.x = coord(x, node.x)
  node.y = coord(y, node.y)
  return normalizeGraph(next)
}

export function connectNodes(graph, from, to) {
  const next = cloneGraph(graph)
  if (!next.nodes.some(node => node.id === from) || !next.nodes.some(node => node.id === to)) throw new Error(`Unknown Bot ${from} → ${to}`)
  if (next.edges.some(edge => edge.from === from && edge.to === to)) return next
  next.edges.push({ from, to })
  return normalizeGraph(next)
}

export function reconnectEdge(graph, from, to, newTo) {
  const next = cloneGraph(graph)
  const index = next.edges.findIndex(edge => edge.from === from && edge.to === to)
  if (index < 0) throw new Error('No such link')
  next.edges.splice(index, 1)
  if (!next.edges.some(edge => edge.from === from && edge.to === newTo)) next.edges.push({ from, to: newTo })
  return normalizeGraph(next)
}

export function removeEdge(graph, from, to) {
  const next = cloneGraph(graph)
  const index = next.edges.findIndex(edge => edge.from === from && edge.to === to)
  if (index < 0) throw new Error('No such link')
  next.edges.splice(index, 1)
  return normalizeGraph(next)
}

export function addNode(graph, node) {
  const next = cloneGraph(graph)
  const id = cleanLine(node?.id, 40).toLowerCase()
  if (!ID_RE.test(id)) throw new Error('A node id is a short lowercase name')
  if (next.nodes.some(item => item.id === id)) throw new Error(`Node ${id} is listed twice`)
  if (node?.botId && next.nodes.some(item => item.botId === node.botId)) throw new Error('That Bot is already in this workflow')
  next.nodes.push({
    id,
    name: cleanLine(node.name, 80),
    role: cleanLine(node.role, 80),
    instructions: cleanLine(node.instructions, 500),
    ...(node.botId ? { botId: String(node.botId) } : {}),
    ...(node.failOnce === true ? { failOnce: true } : {}),
    ...(Number.isFinite(Number(node.x)) ? { x: coord(node.x, 0) } : {}),
    ...(Number.isFinite(Number(node.y)) ? { y: coord(node.y, 0) } : {}),
  })
  return normalizeGraph(next)
}

export function removeNode(graph, nodeId) {
  const next = cloneGraph(graph)
  if (!next.nodes.some(node => node.id === nodeId)) throw new Error(`Unknown Bot ${nodeId}`)
  next.nodes = next.nodes.filter(node => node.id !== nodeId)
  next.edges = next.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId)
  if (next.nodes.length === 0) throw new Error('A workflow needs at least one Bot')
  return normalizeGraph(next)
}

export function freshStatus(graph) {
  ensure(graph)
  return Object.fromEntries(graph.nodes.map(node => [node.id, 'queued']))
}

export function nodeById(graph, id) {
  return graph.nodes.find(node => node.id === id)
}

export function layerIndex(graph, nodeId) {
  ensure(graph)
  const index = graph.layers.findIndex(layer => layer.includes(nodeId))
  if (index < 0) throw new Error(`Unknown Bot ${nodeId}`)
  return index
}

function copyStatus(status) {
  const next = { ...status }
  for (const [id, value] of Object.entries(next)) {
    if (!STATUSES.has(value)) throw new Error(`Bad status for ${id}`)
  }
  return next
}

function predecessors(graph, nodeId) {
  ensure(graph)
  return graph.edges.filter(edge => edge.to === nodeId).map(edge => edge.from)
}

// The first rank that is not finished, or -1 when every rank is done.
export function frontierIndex(graph, status) {
  ensure(graph)
  for (let index = 0; index < graph.layers.length; index += 1) {
    if (graph.layers[index].some(id => status[id] !== 'done')) return index
  }
  return -1
}

// Start every queued Bot whose predecessors are all done.
export function startFrontier(graph, status) {
  ensure(graph)
  const next = copyStatus(status)
  const started = []
  for (const id of orderedIds(graph, next, 'queued')) {
    if (!predecessors(graph, id).every(pred => next[pred] === 'done')) continue
    next[id] = 'running'
    started.push(id)
  }
  const finished = graph.nodes.every(node => next[node.id] === 'done')
  return { status: next, started, finished }
}

export function completeNode(graph, status, nodeId) {
  ensure(graph)
  if (!nodeById(graph, nodeId)) throw new Error(`Unknown Bot ${nodeId}`)
  if (status[nodeId] !== 'running') throw new Error(`${nodeId} is not running`)
  const next = copyStatus(status)
  next[nodeId] = 'done'
  const index = layerIndex(graph, nodeId)
  const layer = graph.layers[index]
  const joined = layer.every(id => next[id] === 'done')
  const follow = startFrontier(graph, next)
  return { status: follow.status, started: follow.started, joined, finished: follow.finished, layerSize: layer.length }
}

export function failNode(graph, status, nodeId) {
  if (!nodeById(graph, nodeId)) throw new Error(`Unknown Bot ${nodeId}`)
  if (status[nodeId] !== 'running') throw new Error(`${nodeId} is not running`)
  const next = copyStatus(status)
  next[nodeId] = 'failed'
  return { status: next, started: [], joined: false, finished: false }
}

export function retryNode(graph, status, nodeId) {
  if (!nodeById(graph, nodeId)) throw new Error(`Unknown Bot ${nodeId}`)
  if (status[nodeId] !== 'failed') throw new Error(`${nodeId} is not failed`)
  const next = copyStatus(status)
  next[nodeId] = 'running'
  return { status: next, started: [nodeId], joined: false, finished: false }
}

export function orderedIds(graph, status, want) {
  ensure(graph)
  const ids = []
  for (const layer of graph.layers) {
    for (const id of layer) if (status[id] === want) ids.push(id)
  }
  return ids
}

// The demo player (and the "next" button) ask the graph what one step is.
// A node marked failOnce fails the first time it is the running choice, then
// a later step retries it. The join still waits until that node is done.
export function nextDemoOp(graph, status, memory = {}) {
  ensure(graph)
  const failed = orderedIds(graph, status, 'failed')
  if (failed.length > 0) return { type: 'retry', nodeId: failed[0] }
  const running = orderedIds(graph, status, 'running')
  if (running.length === 0) {
    if (frontierIndex(graph, status) < 0) return { type: 'restart' }
    return { type: 'start' }
  }
  const failOnce = running.find(id => nodeById(graph, id)?.failOnce === true && memory.failedOnce?.[id] !== true)
  if (failOnce) return { type: 'fail', nodeId: failOnce }
  return { type: 'complete', nodeId: running[0] }
}

export function layerMarks(graph, status) {
  ensure(graph)
  return graph.layers.map(layer => {
    if (layer.some(id => status[id] === 'failed')) return 'failed'
    if (layer.some(id => status[id] === 'running')) return 'running'
    if (layer.every(id => status[id] === 'done')) return 'done'
    return 'queued'
  })
}

export function doneCount(status) {
  return Object.values(status).filter(value => value === 'done').length
}

export function chainLabel(graph) {
  ensure(graph)
  return graph.layers.map(layer => layer.map(id => nodeById(graph, id)?.name ?? id).join(' ‖ ')).join(' → ')
}

export function rowPreview(workflow, run) {
  if (run?.status === 'running') {
    const id = orderedIds(workflow, run.nodeStatus, 'running')[0]
    const name = id ? nodeById(workflow, id)?.name : ''
    const task = run.task?.id ?? ''
    return name ? `${name} 正在处理 ${task}…` : '运行中'
  }
  if (workflow.trigger === 'schedule' && workflow.scheduleLabel) return `下次运行：${workflow.scheduleLabel}`
  return run?.status === 'done' && run.task?.id ? `✓ ${run.task.id} 已完成` : '等待任务'
}

export function stepLabel(graph, nodeId) {
  ensure(graph)
  return `${layerIndex(graph, nodeId) + 1}/${graph.layers.length}`
}
