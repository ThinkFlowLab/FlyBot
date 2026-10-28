// A workflow is a directed graph of local Bots. An edge is a hand-off.
// Nodes that share a rank run together; a node starts only when every Bot
// that points at it is done (a join). A failed Bot holds its successors.
// The same nodes, edges and positions are what the canvas edits and what a
// run paints: x/y are the owner's layout, ranks are derived from the edges.

const STATUSES = new Set(['queued', 'running', 'done', 'failed', 'skipped'])
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

// A node prompt keeps line breaks. Other controls become spaces.
export function cleanPrompt(value, max = 4000) {
  let out = ''
  for (const ch of String(value ?? '')) {
    const code = ch.codePointAt(0)
    if (code === 0x0a || code === 0x09) { out += ch; continue }
    out += code <= 0x1f || code === 0x7f ? ' ' : ch
  }
  return out.replace(/[ \t]+\n/g, '\n').trim().slice(0, max)
}

export function cleanTools(value) {
  if (!Array.isArray(value)) return []
  const tools = []
  for (const item of value) {
    const name = cleanLine(item, 64).toLowerCase()
    if (name && !tools.includes(name)) tools.push(name)
    if (tools.length === 16) break
  }
  return tools
}

const PORT_RE = /^[a-z][a-z0-9-]{0,40}$/
// A root node's required input is filled from the task when it uses one of these names.
export const TASK_INPUTS = new Set(['task', 'title', 'brief'])

export function cleanPorts(value, kind) {
  if (!Array.isArray(value)) return []
  const ports = []
  const seen = new Set()
  for (const item of value) {
    const name = cleanLine(typeof item === 'string' ? item : item?.name, 40).toLowerCase()
    if (!PORT_RE.test(name) || seen.has(name)) continue
    seen.add(name)
    const type = cleanLine(typeof item === 'object' && item ? item.type : '', 40) || 'text'
    if (kind === 'in' && item?.required === true) ports.push({ name, type, required: true })
    else ports.push({ name, type })
    if (ports.length === 8) break
  }
  return ports
}

// The Bot's reply is the step result. `OUTPUT name: value` lines are that
// node's declared outputs; a node with one output may put it in the reply body.
export function readStepResult(text, node) {
  const outputs = {}
  const kept = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^OUTPUT\s+([a-z][a-z0-9-]{0,40})\s*:\s*(.*)$/i.exec(line.trim())
    if (!match) { kept.push(line); continue }
    outputs[match[1].toLowerCase()] = cleanLine(match[2], 2000)
  }
  const body = kept.join('\n').trim().slice(0, 2000)
  const declared = node?.outputs ?? []
  if (declared.length === 1 && !outputs[declared[0].name] && body) outputs[declared[0].name] = body
  if (declared.length > 0) {
    const allowed = new Set(declared.map(port => port.name))
    for (const name of Object.keys(outputs)) if (!allowed.has(name)) delete outputs[name]
  }
  return { text: body, outputs }
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

function cleanWhen(value, allowElse) {
  if (!value || typeof value !== 'object') return null
  if (allowElse && value.else === true) return { else: true }
  const output = cleanLine(value.output, 40).toLowerCase()
  if (!PORT_RE.test(output)) return null
  return { output, eq: cleanLine(value.eq, 200) }
}

// A loop is the only edge that may cycle. max is how many times the body runs
// (1–8, default 3). until stops early when that output equals eq.
// An onFail edge recovers from failure by returning to the from node.
function cleanEdge(edge) {
  const from = String(edge?.from ?? '')
  const to = String(edge?.to ?? '')
  if (edge?.loop === true) {
    const max = Number(edge.max)
    const until = cleanWhen(edge.until, false)
    return {
      from,
      to,
      loop: true,
      max: Number.isInteger(max) && max >= 1 && max <= 8 ? max : 3,
      ...(until ? { until } : {}),
    }
  }
  if (edge?.onFail === true) {
    const max = Number(edge.max)
    return {
      from,
      to,
      onFail: true,
      max: Number.isInteger(max) && max >= 1 && max <= 8 ? max : 3,
    }
  }
  const when = cleanWhen(edge.when, true)
  return { from, to, ...(when ? { when } : {}) }
}

function edgeKey(edge) {
  return `${edge.from}>${edge.to}`
}

// Longest-path ranks. A forward cycle is refused. Loop and onFail edges are not ranked.
// Nodes keep their list order inside a rank.
export function ranksOf(nodes, edges) {
  const ids = nodes.map(node => node.id)
  const known = new Set(ids)
  const preds = new Map(ids.map(id => [id, []]))
  const succs = new Map(ids.map(id => [id, []]))
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) throw new Error(`Link names an unknown Bot ${edge.from} → ${edge.to}`)
    if (edge.loop === true || edge.onFail === true) continue
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
      const cleaned = cleanEdge(edge)
      const key = edgeKey(cleaned)
      if (seen.has(key)) throw new Error(`Link ${cleaned.from} → ${cleaned.to} is listed twice`)
      seen.add(key)
      return cleaned
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
  const prompt = cleanPrompt(node.prompt)
  const model = cleanLine(node.model, 80)
  const tools = cleanTools(node.tools)
  const inputs = cleanPorts(node.inputs, 'in')
  const outputs = cleanPorts(node.outputs, 'out')
  next.nodes.push({
    id,
    name: cleanLine(node.name, 80),
    role: cleanLine(node.role, 80),
    instructions: cleanLine(node.instructions, 500),
    ...(prompt ? { prompt } : {}),
    ...(model ? { model } : {}),
    ...(tools.length ? { tools } : {}),
    ...(inputs.length ? { inputs } : {}),
    ...(outputs.length ? { outputs } : {}),
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

function forwardEdges(graph) {
  return graph.edges.filter(edge => edge.loop !== true && edge.onFail !== true)
}

function predecessors(graph, nodeId) {
  ensure(graph)
  return forwardEdges(graph).filter(edge => edge.to === nodeId).map(edge => edge.from)
}

function forwardIncoming(graph, id) {
  return forwardEdges(graph).filter(edge => edge.to === id)
}

// A plain edge from a done node is open. A when edge is open only when this
// run recorded it. A skipped source closes the edge.
function edgeOpen(edge, status, fired) {
  if (status[edge.from] !== 'done') return false
  if (edge.when) return fired?.[edgeKey(edge)] === true
  return true
}

function ancestors(graph, nodeId, into = new Set()) {
  for (const from of predecessors(graph, nodeId)) {
    if (into.has(from)) continue
    into.add(from)
    ancestors(graph, from, into)
  }
  return into
}

// A required input must be produced by an upstream output of the same name.
// A root may take `task`, `title` or `brief` from the assignment instead.
export function missingProviders(graph) {
  ensure(graph)
  const missing = []
  for (const node of graph.nodes) {
    const roots = predecessors(graph, node.id).length === 0
    for (const input of node.inputs ?? []) {
      if (input.required !== true) continue
      const provided = [...ancestors(graph, node.id)].some(id => (nodeById(graph, id)?.outputs ?? []).some(port => port.name === input.name))
      if (!provided && !(roots && TASK_INPUTS.has(input.name))) missing.push({ nodeId: node.id, name: input.name })
    }
  }
  return missing
}

function producedValue(graph, nodeId, name, produced) {
  const direct = predecessors(graph, nodeId)
  for (const id of direct) {
    const value = produced?.[id]?.[name]
    if (typeof value === 'string' && value !== '') return value
  }
  for (const id of ancestors(graph, nodeId)) {
    if (direct.includes(id)) continue
    const value = produced?.[id]?.[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

export function resolveInputs(graph, nodeId, produced, task) {
  ensure(graph)
  const node = nodeById(graph, nodeId)
  const bag = {}
  const roots = predecessors(graph, nodeId).length === 0
  for (const input of node?.inputs ?? []) {
    let value = producedValue(graph, nodeId, input.name, produced)
    if (!value && roots && TASK_INPUTS.has(input.name)) {
      if (input.name === 'title' || input.name === 'brief') value = task?.title ?? ''
      else value = `${task?.id ?? ''} ${task?.title ?? ''}`.trim()
    }
    if (value) bag[input.name] = value
  }
  return bag
}

export function unmetRequired(graph, nodeId, produced, task) {
  const node = nodeById(graph, nodeId)
  const have = resolveInputs(graph, nodeId, produced, task)
  return (node?.inputs ?? []).filter(input => input.required === true && !have[input.name]).map(input => input.name)
}

function settled(value) {
  return value === 'done' || value === 'skipped'
}

// The first rank that is not finished, or -1 when every rank is done.
// A skipped node is settled: an untaken branch does not hold the rank open.
export function frontierIndex(graph, status) {
  ensure(graph)
  for (let index = 0; index < graph.layers.length; index += 1) {
    if (graph.layers[index].some(id => !settled(status[id]))) return index
  }
  return -1
}

function predSatisfied(graph, id, status, fired) {
  const incoming = forwardIncoming(graph, id)
  if (incoming.length === 0) return true
  if (!incoming.every(edge => settled(status[edge.from]))) return false
  return incoming.some(edge => edgeOpen(edge, status, fired))
}

// Start every queued Bot whose forward predecessors are settled, and at least
// one incoming edge was taken. fired is omitted for a graph with no conditions.
export function startFrontier(graph, status, fired) {
  ensure(graph)
  const next = copyStatus(status)
  const started = []
  for (const id of orderedIds(graph, next, 'queued')) {
    if (!predSatisfied(graph, id, next, fired)) continue
    next[id] = 'running'
    started.push(id)
  }
  const finished = graph.nodes.every(node => settled(next[node.id]))
  return { status: next, started, finished }
}

function takenFrom(graph, nodeId, outputs) {
  const out = forwardEdges(graph).filter(edge => edge.from === nodeId)
  const matched = out.some(edge => edge.when && edge.when.else !== true && outputs?.[edge.when.output] === edge.when.eq)
  const fired = {}
  for (const edge of out) {
    let take = false
    if (!edge.when) take = true
    else if (edge.when.else === true) take = !matched
    else take = outputs?.[edge.when.output] === edge.when.eq
    if (take) fired[edgeKey(edge)] = true
  }
  return fired
}

function loopDecision(graph, nodeId, outputs, loops) {
  const edges = graph.edges.filter(edge => edge.loop === true && edge.from === nodeId)
  for (const edge of edges) {
    const ran = (Number(loops?.[edgeKey(edge)]) || 0) + 1
    if (edge.until && outputs?.[edge.until.output] === edge.until.eq) continue
    const max = Number.isInteger(edge.max) ? edge.max : 3
    if (ran >= max) continue
    return { edge, ran }
  }
  return null
}

// Check if a failed node has an onFail edge and attempts remaining.
function failRecoveryDecision(graph, nodeId, failAttempts) {
  const edges = graph.edges.filter(edge => edge.onFail === true && edge.from === nodeId)
  for (const edge of edges) {
    const ran = (Number(failAttempts?.[edgeKey(edge)]) || 0) + 1
    const max = Number.isInteger(edge.max) ? edge.max : 3
    if (ran >= max) continue
    return { edge, ran }
  }
  return null
}

// Nodes the loop runs again: forward-reachable from the target that can still
// reach the source. A self-loop is that one node. The exit stays queued.
function loopBody(graph, source, target) {
  if (source === target) return new Set([source])
  const forward = new Map()
  for (const edge of forwardEdges(graph)) {
    if (!forward.has(edge.from)) forward.set(edge.from, [])
    forward.get(edge.from).push(edge.to)
  }
  const reach = new Set()
  const stack = [target]
  while (stack.length > 0) {
    const id = stack.pop()
    if (reach.has(id)) continue
    reach.add(id)
    for (const to of forward.get(id) ?? []) stack.push(to)
  }
  const rev = new Map()
  for (const [from, tos] of forward) {
    for (const to of tos) {
      if (!rev.has(to)) rev.set(to, [])
      rev.get(to).push(from)
    }
  }
  const can = new Set()
  const back = [source]
  while (back.length > 0) {
    const id = back.pop()
    if (can.has(id)) continue
    can.add(id)
    for (const from of rev.get(id) ?? []) back.push(from)
  }
  const body = new Set()
  for (const id of reach) if (can.has(id)) body.add(id)
  body.add(source)
  body.add(target)
  return body
}

function skipClosed(graph, status, fired) {
  const skipped = []
  let changed = true
  while (changed) {
    changed = false
    for (const node of graph.nodes) {
      if (status[node.id] !== 'queued') continue
      const incoming = forwardIncoming(graph, node.id)
      if (incoming.length === 0) continue
      const pending = incoming.some(edge => !settled(status[edge.from]))
      if (pending) continue
      if (incoming.some(edge => edgeOpen(edge, status, fired))) continue
      status[node.id] = 'skipped'
      skipped.push(node.id)
      changed = true
    }
  }
  return skipped
}

export function completeNode(graph, status, nodeId, ctx = {}) {
  ensure(graph)
  if (!nodeById(graph, nodeId)) throw new Error(`Unknown Bot ${nodeId}`)
  if (status[nodeId] !== 'running') throw new Error(`${nodeId} is not running`)
  const next = copyStatus(status)
  next[nodeId] = 'done'
  const index = layerIndex(graph, nodeId)
  const layer = graph.layers[index]
  const outputs = ctx.outputs && typeof ctx.outputs === 'object' ? ctx.outputs : {}
  const loops = { ...(ctx.loops ?? {}) }
  const fired = { ...(ctx.fired ?? {}) }
  const looping = loopDecision(graph, nodeId, outputs, ctx.loops)
  if (looping) {
    loops[edgeKey(looping.edge)] = looping.ran
    const body = loopBody(graph, nodeId, looping.edge.to)
    const reset = []
    for (const id of body) {
      next[id] = id === looping.edge.to ? 'running' : 'queued'
      reset.push(id)
    }
    // The previous pass's choice stays in `fired`, and a skipped sibling is
    // outside the body. skipClosed only moves queued nodes, so the old branch
    // would open again. Drop decisions the body made, and queue every skipped
    // node a reset node points at, so the next pass can take the other side.
    const opened = new Set(body)
    let grew = true
    while (grew) {
      grew = false
      for (const edge of forwardEdges(graph)) {
        if (!opened.has(edge.from) || next[edge.to] !== 'skipped') continue
        next[edge.to] = 'queued'
        reset.push(edge.to)
        opened.add(edge.to)
        grew = true
      }
    }
    for (const key of Object.keys(fired)) {
      const from = key.split('>')[0]
      if (opened.has(from)) delete fired[key]
    }
    return {
      status: next, started: [looping.edge.to], joined: false, finished: false, layerSize: layer.length,
      loops, fired, looped: true, reset, skipped: [],
    }
  }
  Object.assign(fired, takenFrom(graph, nodeId, outputs))
  const skipped = skipClosed(graph, next, fired)
  const follow = startFrontier(graph, next, fired)
  const joined = layer.every(id => settled(follow.status[id]))
  return {
    status: follow.status, started: follow.started, joined, finished: follow.finished, layerSize: layer.length,
    loops, fired, looped: false, reset: [], skipped,
  }
}

export function failNode(graph, status, nodeId, ctx = {}) {
  if (!nodeById(graph, nodeId)) throw new Error(`Unknown Bot ${nodeId}`)
  if (status[nodeId] !== 'running') throw new Error(`${nodeId} is not running`)
  
  const failAttempts = { ...(ctx.failAttempts ?? {}) }
  const recovery = failRecoveryDecision(graph, nodeId, failAttempts)
  
  if (recovery) {
    // Failure recovery: reset to the upstream target node
    failAttempts[edgeKey(recovery.edge)] = recovery.ran
    const body = loopBody(graph, recovery.edge.to, nodeId)
    const next = copyStatus(status)
    const reset = []
    
    for (const id of body) {
      next[id] = id === recovery.edge.to ? 'running' : 'queued'
      reset.push(id)
    }
    
    return {
      status: next,
      started: [recovery.edge.to],
      joined: false,
      finished: false,
      failAttempts,
      recovered: true,
      reset,
    }
  }
  
  // No recovery or attempts exhausted: fail normally
  const next = copyStatus(status)
  next[nodeId] = 'failed'
  return { status: next, started: [], joined: false, finished: false, failAttempts }
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

// Scripted step chooser for graph unit tests (failOnce retry ordering).
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
    if (layer.every(id => settled(status[id]))) return 'done'
    return 'queued'
  })
}

export function doneCount(status) {
  return Object.values(status).filter(value => value === 'done' || value === 'skipped').length
}

export function chainLabel(graph) {
  ensure(graph)
  return graph.layers.map(layer => layer.map(id => nodeById(graph, id)?.name ?? id).join(' ‖ ')).join(' → ')
}

export function summarizeTask(task, maxTitle = 72) {
  const id = cleanLine(task?.id, 80)
  const title = cleanLine(task?.title, maxTitle)
  if (!id && !title) return ''
  if (!title) return id
  if (!id) return title
  return `${id} · ${title}`
}

export function rowPreview(workflow, run) {
  const live = run?.live === true
  if (live && run?.status === 'running') {
    const id = orderedIds(workflow, run.nodeStatus, 'running')[0]
    const name = id ? nodeById(workflow, id)?.name : ''
    const task = run.task?.id ?? ''
    if (run.paused === true) {
      return name && task ? `已暂停 · ${name} · ${task}` : (task ? `已暂停 · ${task}` : '已暂停')
    }
    return name ? `${name} 正在处理 ${task}…` : '运行中'
  }
  if (workflow.trigger === 'schedule' && workflow.scheduleLabel) return `下次运行：${workflow.scheduleLabel}`
  if (live && run?.status === 'done' && run.task?.id) return `✓ ${run.task.id} 已完成`
  return '等待任务'
}

export function stepLabel(graph, nodeId) {
  ensure(graph)
  return `${layerIndex(graph, nodeId) + 1}/${graph.layers.length}`
}
