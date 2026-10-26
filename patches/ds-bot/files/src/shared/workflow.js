// The pure half of the workflow engine (#1272): a workflow is data — nodes, each naming the Bot
// that does it and the artifacts it takes in and hands out, wired by edges — and everything below is
// a function of that data. Validation, the node order a board draws its columns from, the flowchart
// layout, and the refusal a node gives when an input is missing or stale. No I/O, no clock, no
// GitHub, no model: a guard is a predicate over facts somebody else read.

import { formatArtifact, formatArtifactSpec, freshness, parseArtifactSpec } from './artifact.js'

export const WORKFLOW_VERSION = 1

const text = (value) => (typeof value === 'string' ? value.trim() : '')
const textList = (value) => (Array.isArray(value) ? value.map(text).filter(Boolean) : [])
const GUARD_CHECKS = ['present', 'fresh', 'equals']

function normaliseGuard(raw) {
  const spec = text(raw?.spec)
  const is = text(raw?.is)
  return {
    id: text(raw?.id) || spec,
    spec,
    is: GUARD_CHECKS.includes(is) ? is : 'present',
    value: raw?.value === undefined ? null : raw.value,
  }
}

function normaliseNode(raw) {
  return {
    id: text(raw?.id),
    name: text(raw?.name) || text(raw?.id),
    bot: text(raw?.bot),
    inputs: textList(raw?.inputs),
    outputs: textList(raw?.outputs),
    guards: Array.isArray(raw?.guards) ? raw.guards.map(normaliseGuard) : [],
    refusal: text(raw?.refusal),
  }
}

// A definition as the engine reads it: every field the functions below touch exists, and nothing is
// invented. Callers may keep the object they passed in; nothing here mutates it.
export function normaliseWorkflow(raw) {
  const def = raw && typeof raw === 'object' ? raw : {}
  return {
    id: text(def.id),
    name: text(def.name) || text(def.id),
    version: Number.isInteger(def.version) ? def.version : WORKFLOW_VERSION,
    inputs: textList(def.inputs),
    deliverables: textList(def.deliverables),
    nodes: Array.isArray(def.nodes) ? def.nodes.map(normaliseNode) : [],
    edges: Array.isArray(def.edges)
      ? def.edges.map((edge) => ({ from: text(edge?.from), to: text(edge?.to) }))
      : [],
    loops: Array.isArray(def.loops)
      ? def.loops.map((loop) => ({ from: text(loop?.from), to: text(loop?.to) })).filter((loop) => loop.from && loop.to)
      : [],
  }
}

export function nodeById(def, id) {
  return def.nodes.find((node) => node.id === id) ?? null
}

// `build.branch` -> `{ node: 'build', artifact: 'branch' }`. A node id that contains a dot is
// matched as the longest prefix, so `release.v2.text:note` still resolves against `release.v2`.
export function splitEndpoint(endpoint, nodeIds) {
  const raw = text(endpoint)
  if (raw === '') return null
  const ids = [...nodeIds].sort((a, b) => b.length - a.length)
  for (const id of ids) {
    if (id !== '' && raw.startsWith(`${id}.`)) {
      const spec = raw.slice(id.length + 1)
      if (parseArtifactSpec(spec)) return { node: id, artifact: formatArtifactSpec(parseArtifactSpec(spec)) }
    }
  }
  return null
}

export function producersOf(def) {
  const producers = {}
  for (const node of def.nodes) {
    for (const spec of node.outputs) {
      if (!parseArtifactSpec(spec)) continue
      producers[spec] = producers[spec] ?? []
      if (!producers[spec].includes(node.id)) producers[spec].push(node.id)
    }
  }
  return producers
}

export function consumersOf(def) {
  const consumers = {}
  for (const node of def.nodes) {
    for (const spec of node.inputs) {
      if (!parseArtifactSpec(spec)) continue
      consumers[spec] = consumers[spec] ?? []
      if (!consumers[spec].includes(node.id)) consumers[spec].push(node.id)
    }
  }
  return consumers
}

// One row of `edges[]` resolved against the definition. An unresolvable row keeps its place with
// nulls: the flowchart still draws one edge per entry, and validation is what says it is wrong.
export function resolvedEdges(raw) {
  const def = normaliseWorkflow(raw)
  const nodeIds = def.nodes.map((node) => node.id)
  return def.edges.map((edge) => {
    const from = splitEndpoint(edge.from, nodeIds)
    const to = splitEndpoint(edge.to, nodeIds)
    return {
      from: edge.from,
      to: edge.to,
      fromNode: from?.node ?? null,
      toNode: to?.node ?? null,
      artifact: from?.artifact ?? null,
      carries: from?.artifact ?? null,
    }
  })
}

// Every dependency the graph implies, whether it was written as an edge[] row or only by one node
// taking in what another hands out. A declared loop is taken out here: it is how work goes back,
// not what has to be finished first.
export function dependencyEdges(raw) {
  const def = normaliseWorkflow(raw)
  const producers = producersOf(def)
  const seen = new Set()
  const edges = []
  const add = (from, to) => {
    if (from === to) return
    const key = `${from}\u0000${to}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to })
  }
  for (const edge of resolvedEdges(def)) {
    if (edge.fromNode && edge.toNode && !isLoopEdge(def, edge.fromNode, edge.toNode)) add(edge.fromNode, edge.toNode)
  }
  for (const node of def.nodes) {
    for (const spec of node.inputs) {
      for (const from of producers[spec] ?? []) {
        if (!isLoopEdge(def, from, node.id)) add(from, node.id)
      }
    }
  }
  return edges
}

export function isLoopEdge(def, from, to) {
  return def.loops.some((loop) => loop.from === from && loop.to === to)
}

// Node ids in dependency order; ties keep the definition's own order, so the result is stable and
// two runs of the same file draw the same board. A definition with an undeclared cycle still gets
// an order (the remaining nodes in declaration order) so that a broken file can be read while it is
// being fixed; validation is what refuses it.
export function topologicalOrder(raw) {
  const def = normaliseWorkflow(raw)
  const ids = def.nodes.map((node) => node.id).filter(Boolean)
  const outgoing = new Map(ids.map((id) => [id, []]))
  const incoming = new Map(ids.map((id) => [id, 0]))
  for (const edge of dependencyEdges(def)) {
    if (!outgoing.has(edge.from) || !incoming.has(edge.to)) continue
    outgoing.get(edge.from).push(edge.to)
    incoming.set(edge.to, incoming.get(edge.to) + 1)
  }
  const queue = ids.filter((id) => incoming.get(id) === 0)
  const order = []
  while (queue.length > 0) {
    const id = queue.shift()
    order.push(id)
    for (const next of outgoing.get(id)) {
      incoming.set(next, incoming.get(next) - 1)
      if (incoming.get(next) === 0) queue.push(next)
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id)
  return order
}

// The board's columns, drawn from the definition alone (#1272 acceptance 1): the node id is the
// state, and there is no built-in list of them anywhere in this file.
export function workflowColumns(raw) {
  const def = normaliseWorkflow(raw)
  return topologicalOrder(def).map((id) => {
    const node = nodeById(def, id)
    return {
      id: node.id,
      name: node.name,
      bot: node.bot,
      inputs: node.inputs.slice(),
      outputs: node.outputs.slice(),
      guards: node.guards.map((guard) => ({ ...guard })),
      refusal: node.refusal,
    }
  })
}

// Who does this node: the definition's Bot, which is also the card's assignee while the card sits
// there, so the two cannot disagree.
export function holderOf(raw, nodeId) {
  return nodeById(normaliseWorkflow(raw), nodeId)?.bot ?? null
}

function ranksOf(def, edges) {
  const rank = new Map(def.nodes.map((node) => [node.id, 0]))
  for (let round = 0; round <= def.nodes.length; round++) {
    let moved = false
    for (const edge of edges) {
      if (!rank.has(edge.from) || !rank.has(edge.to)) continue
      const next = rank.get(edge.from) + 1
      if (rank.get(edge.to) < next) {
        rank.set(edge.to, next)
        moved = true
      }
    }
    if (!moved) break
  }
  return rank
}

// The flowchart as a pure function of the definition (#1272 acceptance 2): one box per node, each
// carrying the Bot that does it and its inputs and outputs on the rails, and one edge per edges[]
// entry, labelled with the artifact it carries. Left to right in dependency order, rows within a
// rank keep the definition's order. Layout is computed, never stored.
export function layoutWorkflow(raw, options = {}) {
  const def = normaliseWorkflow(raw)
  const boxWidth = Number.isFinite(options.boxWidth) ? options.boxWidth : 220
  const boxHeight = Number.isFinite(options.boxHeight) ? options.boxHeight : 120
  const gapX = Number.isFinite(options.gapX) ? options.gapX : 64
  const gapY = Number.isFinite(options.gapY) ? options.gapY : 24
  const rank = ranksOf(def, dependencyEdges(def))
  const byRank = new Map()
  for (const node of def.nodes) {
    const r = rank.get(node.id) ?? 0
    byRank.set(r, [...(byRank.get(r) ?? []), node])
  }
  const boxes = []
  for (const r of [...byRank.keys()].sort((a, b) => a - b)) {
    byRank.get(r).forEach((node, row) => {
      boxes.push({
        id: node.id,
        name: node.name,
        bot: node.bot,
        rank: r,
        row,
        inputs: node.inputs.slice(),
        outputs: node.outputs.slice(),
        x: r * (boxWidth + gapX),
        y: row * (boxHeight + gapY),
        width: boxWidth,
        height: boxHeight,
      })
    })
  }
  const byId = new Map(boxes.map((box) => [box.id, box]))
  const edges = resolvedEdges(def).map((edge) => {
    const fromBox = edge.fromNode ? byId.get(edge.fromNode) ?? null : null
    const toBox = edge.toNode ? byId.get(edge.toNode) ?? null : null
    return {
      from: edge.from,
      to: edge.to,
      artifact: edge.artifact,
      fromBox: fromBox?.id ?? null,
      toBox: toBox?.id ?? null,
      points: fromBox && toBox
        ? [
            { x: fromBox.x + fromBox.width, y: fromBox.y + fromBox.height / 2 },
            { x: toBox.x, y: toBox.y + toBox.height / 2 },
          ]
        : [],
    }
  })
  const width = boxes.reduce((max, box) => Math.max(max, box.x + box.width), 0)
  const height = boxes.reduce((max, box) => Math.max(max, box.y + box.height), 0)
  return { id: def.id, name: def.name, boxes, edges, width, height }
}

function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in values ? values[key] : whole))
}

// A refusal is a sentence naming the input, the node and the fix (#1272). A node may carry its own
// wording in `refusal`; the placeholders are `{node}`, `{input}`, `{spec}`, `{now}` and `{want}`.
// Nothing here decides anything: it renders the answer a check already reached.
export function renderRefusal(node, details = {}) {
  const name = node?.name || node?.id || 'this node'
  const spec = details.spec ?? null
  const input = details.input ? formatArtifact(details.input) : details.have ? `${spec}@${details.have}` : spec
  const unreadable = details.unreadable === true || (details.stale === true && details.now === null)
  const values = {
    node: name,
    spec: spec ?? '',
    input: input ?? '',
    have: details.have ?? 'no revision',
    // A revision that could not be read is never written as an empty slot, and never as `null`.
    now: unreadable ? 'an unreadable revision' : (details.now ?? 'no revision'),
    want: String(details.want ?? ''),
  }
  if (unreadable) {
    // The node's own wording knows "has not been produced" and "is stale"; neither is this answer,
    // so the engine names what it read and that the source could not be read at all.
    return `${name} refuses: its input ${input ?? spec} could not be checked against the source — it reads ${details.have ?? 'no revision'} and the source revision is unreadable, so the card must be read before it starts.`
  }
  if (node?.refusal) return fill(node.refusal, values)
  if (details.want !== undefined && details.want !== null) {
    return `${name} refuses: its input ${input ?? spec} does not say ${details.want}.`
  }
  if (details.stale) {
    return `${name} refuses: its input ${input} is stale (it read ${details.have ?? 'an older revision'}, the source is now at ${details.now}).`
  }
  return `${name} refuses: its input ${spec} has not been produced yet.`
}

// What a card in this node would show: every input with the revision it has, or the one that is
// missing, so a blocked card reads without asking anyone (acceptance 6).
export function inputStates(raw, nodeId, facts = {}) {
  const node = nodeById(normaliseWorkflow(raw), nodeId)
  if (!node) return []
  const present = facts.present ?? {}
  const current = facts.current ?? {}
  return node.inputs.map((spec) => {
    const have = artifactAt(present, spec)
    if (!have) return { spec, present: false, revision: null, stale: false, now: null, reason: 'missing', unreadable: false }
    // A card draws `stale` as a refusal, so an input `enterNode` refuses must never read
    // `stale: false` here: a source nobody could read is stale until it is read.
    const state = freshness(have, current[spec])
    return { spec, present: true, revision: have.revision, stale: !state.fresh, now: state.now, reason: state.reason, unreadable: state.reason === 'unreadable' }
  })
}

function artifactAt(present, spec) {
  if (!spec) return null
  if (Array.isArray(present)) return present.find((item) => item?.spec === spec) ?? null
  return present?.[spec] ?? null
}

function guardRefusals(node, facts) {
  const present = facts.present ?? {}
  const current = facts.current ?? {}
  const refusals = []
  for (const guard of node.guards) {
    const spec = parseArtifactSpec(guard.spec) ? formatArtifactSpec(parseArtifactSpec(guard.spec)) : null
    if (!spec) {
      refusals.push({ guard, refusal: renderRefusal(node, { spec: guard.spec }) })
      continue
    }
    const have = artifactAt(present, spec)
    const state = freshness(have, current[spec])
    if (!have) {
      refusals.push({ guard, refusal: renderRefusal(node, { spec }) })
      continue
    }
    if (guard.is === 'fresh' && !state.fresh) {
      refusals.push({ guard, refusal: renderRefusal(node, { spec, input: have, stale: true, have: state.have, now: state.now }) })
      continue
    }
    if (guard.is === 'equals' && String(have.value ?? '') !== String(guard.value ?? '')) {
      refusals.push({ guard, refusal: renderRefusal(node, { spec, input: have, want: guard.value }) })
    }
  }
  return refusals
}

// Whether this node may start: every input present, every one of them current, and every guard
// satisfied. The first failure is returned as the node's own sentence, with both revisions named —
// a refusal moves nothing.
export function enterNode(raw, nodeId, facts = {}) {
  const def = normaliseWorkflow(raw)
  const node = nodeById(def, nodeId)
  if (!node) {
    return { ok: false, missing: [], stale: [], guardRefusals: [], refusal: `there is no node "${nodeId}" in this workflow` }
  }
  const present = facts.present ?? {}
  const current = facts.current ?? {}
  const missing = []
  const stale = []
  for (const spec of node.inputs) {
    const have = artifactAt(present, spec)
    if (!have) {
      missing.push(spec)
      continue
    }
    // A revision nobody could read is asked as `unreadable`, never skipped: a key missing from
    // `current` is not evidence that the fact is current, and `null` is the same answer.
    const state = freshness(have, current[spec])
    if (!state.fresh) stale.push({ spec, have: state.have, now: state.now, reason: state.reason })
  }
  if (missing.length > 0) {
    return { ok: false, missing, stale, guardRefusals: [], refusal: renderRefusal(node, { spec: missing[0] }) }
  }
  if (stale.length > 0) {
    const first = stale[0]
    const have = artifactAt(present, first.spec)
    return {
      ok: false,
      missing,
      stale,
      guardRefusals: [],
      refusal: renderRefusal(node, {
        spec: first.spec,
        input: have,
        stale: true,
        unreadable: first.reason === 'unreadable',
        have: first.have,
        now: first.now,
      }),
    }
  }
  const refused = guardRefusals(node, facts)
  if (refused.length > 0) {
    return { ok: false, missing, stale, guardRefusals: refused, refusal: refused[0].refusal }
  }
  return { ok: true, missing, stale, guardRefusals: [], refusal: null }
}

const message = (code, sentence, extra = {}) => ({ code, message: sentence, ...extra })

// Every way a definition cannot run, each with its own sentence (#1272 acceptance 3). The list is
// returned whole: a definition with two defects gets two answers, not the first one.
export function validateWorkflow(raw, options = {}) {
  const def = normaliseWorkflow(raw)
  const problems = []
  const team = Array.isArray(options.team) ? options.team.map(text).filter(Boolean) : null

  if (def.nodes.length === 0) problems.push(message('workflow/empty', 'the workflow has no nodes, so there is nothing to run'))

  const ids = new Set()
  for (const node of def.nodes) {
    if (node.id === '') {
      problems.push(message('node/without-id', `node "${node.name}" has no id, so no edge can name it`))
      continue
    }
    if (ids.has(node.id)) {
      problems.push(message('node/duplicate-id', `two nodes share the id "${node.id}"`, { node: node.id }))
    }
    ids.add(node.id)
    if (node.bot === '') {
      problems.push(message('node/without-bot', `node "${node.id}" names no Bot; every node is done by one`, { node: node.id }))
    } else if (team && !team.includes(node.bot) && node.bot !== 'system' && !node.bot.startsWith('human:')) {
      problems.push(
        message('node/unknown-bot', `node "${node.id}" names "${node.bot}", who is not on this team`, { node: node.id }),
      )
    }
    for (const spec of [...node.inputs, ...node.outputs]) {
      if (!parseArtifactSpec(spec)) {
        problems.push(
          message('artifact/unknown-kind', `node "${node.id}" names "${spec}", which is not a kind of fact this engine knows`, {
            node: node.id,
          }),
        )
      }
    }
  }

  const producers = producersOf(def)
  const consumers = consumersOf(def)
  const declaredInputs = new Set(def.inputs)
  const deliverables = new Set(def.deliverables)

  for (const node of def.nodes) {
    if (!ids.has(node.id)) continue
    for (const spec of node.inputs) {
      if (!parseArtifactSpec(spec)) continue
      if ((producers[spec] ?? []).length === 0 && !declaredInputs.has(spec)) {
        problems.push(
          message('input/without-producer', `node "${node.id}" takes in "${spec}", but no node hands it out`, {
            node: node.id,
            artifact: spec,
          }),
        )
      }
    }
    for (const spec of node.outputs) {
      if (!parseArtifactSpec(spec)) continue
      if ((consumers[spec] ?? []).length === 0 && !deliverables.has(spec)) {
        problems.push(
          message(
            'output/without-consumer',
            `node "${node.id}" hands out "${spec}", and nothing takes it in; add it to deliverables if it ends the workflow`,
            { node: node.id, artifact: spec },
          ),
        )
      }
    }
  }

  for (const [spec, from] of Object.entries(producers)) {
    if (from.length > 1) {
      problems.push(
        message('artifact/two-producers', `"${spec}" is handed out by ${from.map((id) => `"${id}"`).join(' and ')}; a fact has one producer`, {
          artifact: spec,
          nodes: from.slice(),
        }),
      )
    }
  }

  const nodeIds = def.nodes.map((node) => node.id)
  for (const edge of def.edges) {
    if (!edge.from || !edge.to) {
      problems.push(message('edge/without-both-ends', 'an edge names only one end', { edge }))
      continue
    }
    const from = splitEndpoint(edge.from, nodeIds)
    const to = splitEndpoint(edge.to, nodeIds)
    if (!from || !to) {
      problems.push(
        message('edge/unknown-end', `the edge "${edge.from} -> ${edge.to}" names a node or artifact that is not in this workflow`, {
          edge,
        }),
      )
      continue
    }
    const fromNode = nodeById(def, from.node)
    const toNode = nodeById(def, to.node)
    if (!fromNode.outputs.includes(from.artifact) || !toNode.inputs.includes(to.artifact)) {
      problems.push(
        message(
          'edge/misaligned',
          `the edge "${edge.from} -> ${edge.to}" does not line up: "${from.node}" does not hand out "${from.artifact}" or "${to.node}" does not take it in`,
          { edge },
        ),
      )
    } else if (from.artifact !== to.artifact) {
      problems.push(
        message('edge/crossed-artifacts', `the edge "${edge.from} -> ${edge.to}" carries "${from.artifact}" into "${to.artifact}"`, {
          edge,
        }),
      )
    }
  }

  for (const loop of def.loops) {
    if (!nodeIds.includes(loop.from) || !nodeIds.includes(loop.to)) {
      problems.push(message('loop/unknown-node', `the loop "${loop.from} -> ${loop.to}" names a node that is not in this workflow`))
    } else if (!dependencyEdges({ ...def, loops: [] }).some((edge) => edge.from === loop.from && edge.to === loop.to)) {
      problems.push(message('loop/not-an-edge', `the loop "${loop.from} -> ${loop.to}" is declared, but no input makes that dependency`))
    }
  }
  const cycle = findCycle(def.nodes.map((node) => node.id), dependencyEdges(def))
  if (cycle) {
    problems.push(
      message(
        'graph/cycle',
        `the nodes loop (${cycle.concat(cycle[0]).map((id) => `"${id}"`).join(' -> ')}) and the workflow declares no loop for it`,
        { cycle },
      ),
    )
  }
  return { ok: problems.length === 0, problems, errors: problems, definition: def }
}

function findCycle(nodeIds, edges) {
  const outgoing = new Map(nodeIds.map((id) => [id, []]))
  for (const edge of edges) if (outgoing.has(edge.from) && outgoing.has(edge.to)) outgoing.get(edge.from).push(edge.to)
  const state = new Map()
  const stack = []
  const walk = (id) => {
    state.set(id, 'open')
    stack.push(id)
    for (const next of outgoing.get(id) ?? []) {
      if (state.get(next) === 'open') return stack.slice(stack.indexOf(next))
      if (!state.has(next)) {
        const found = walk(next)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }
  for (const id of nodeIds) {
    if (state.has(id)) continue
    const found = walk(id)
    if (found) return found
  }
  return null
}
