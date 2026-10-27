// The running layer's pure half (#1316, #1272 step 4): a job becomes node cards, and a node card
// exists only when `workflow.js`'s `enterNode` says the node may open on the facts somebody just
// read. Nothing here writes a record, wakes a Bot, or looks at a clock: the host owns the card, the
// pull queue (#1247) owns who does a card, and `task-drive.js` `driveOnce` is the only beat. A planner
// that could also dispatch would be the second engine #1272 exists to remove.
//
// What a caller gets is a card the board already places (`workflow`, `node`) plus the fields the
// queue reads (`parentId`, `role`, `queueRole`), so the host writer needs no translation table.
//
// Three promises live here, and nowhere else:
//   - **no card for a node that may not open.** Every decision is `enterNode`'s, and a refusal is
//     `enterNode`'s own sentence, byte for byte — the runtime never writes one of its own about a
//     node's inputs (#1316 pin 2).
//   - **one card per `(job, node)`, answered from state.** The cards the job already has are the
//     record, so a replayed tick, a restart or a re-read of the same facts opens nothing twice; a
//     process-local flag would forget on restart (#1316 pin 4).
//   - **hold stops the job, not a node** (#1316 pin 7), and the sentence is not written here. A
//     definition that guards a held pull request already carries it — `repo-dev`'s `gate.guards[0]`
//     (`no-hold`), which is the merge gate's own wording, pinned byte for byte in
//     `.github/scripts/fixtures/workflow-cases.json` — so the planner renders that guard through
//     `renderRefusal` with the fact it expects (`pr: hold`) and every refused node gets that one
//     sentence. A definition with no such guard gets `refusal: null` and the holder's name rather than
//     a sentence this layer made up: one sentence too few beats a new one.

import { canonicalSpec, consumersOf, enterNode, normaliseWorkflow, nodeById, renderRefusal, topologicalOrder } from './workflow.js'
import { freshness } from './artifact.js'

// A fact map is keyed by the spelling `artifact()` gives a spec, and a definition may spell the same
// fact with a space (#1298). The lookup goes through the parsed spec first, exactly like the one in
// `workflow.js`, so a card and the planner cannot read two different facts.
function factAt(map, spec) {
  const key = canonicalSpec(spec) ?? spec
  if (!key) return null
  if (Array.isArray(map)) return map.find((item) => item?.spec === key) ?? map.find((item) => item?.spec === spec) ?? null
  return map?.[key] ?? map?.[spec] ?? null
}

// The one sentence a held job is refused with, rendered from the definition's own guard: a
// workflow that guards a held pull request (`no-hold`, `pr equals none`) already carries the merge
// gate's wording, and `renderRefusal` hands it back byte for byte. No such guard, no sentence.
function heldSentence(def) {
  for (const node of def.nodes) {
    for (const guard of node.guards) {
      const namesHold = guard.id === 'no-hold' || (guard.spec === 'pr' && guard.is === 'equals' && String(guard.value) === 'none')
      if (namesHold) return renderRefusal(node, { spec: guard.spec, guard, input: { value: 'hold' } })
    }
  }
  return null
}

const heldBy = (hold) => {
  if (hold === null || hold === undefined || hold === false) return null
  if (typeof hold === 'string') return hold.trim() === '' ? '' : hold.trim()
  return typeof hold.by === 'string' ? hold.by.trim() : ''
}

// The plan for one job on one read of the facts:
//
//   `open`     the node cards to create now, in dependency order — `parentId` is the job card, the
//              queue role is `node.role`, and the card carries no assignee, because who does it is the
//              claim's answer and not the planner's (#1316 pins 1 and 3).
//   `refused`  one entry per node that may not open, with `enterNode`'s sentence and whether it was
//              refused because a fact could not be read at all (#1316 pins 2 and 8). For a held job
//              every node is here with `heldBy` set and the definition's own hold sentence, or
//              `refusal: null` when the definition guards no held pull request.
//
// A node that already has a card is in neither list: it is open work, and the planner never touches a
// card it did not create.
export function planJob({ definition, job = {}, cards = [], facts = {}, hold = null } = {}) {
  const def = normaliseWorkflow(definition)
  const jobId = job?.id ?? null
  const holder = heldBy(hold)
  const sentence = holder === null ? null : heldSentence(def)
  const existing = new Set()
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card && typeof card.node === 'string' && card.node !== '') existing.add(card.node)
  }
  const open = []
  const refused = []
  for (const nodeId of topologicalOrder(def)) {
    // `(job, node)` has at most one card, and the cards already on the job are what says so.
    if (existing.has(nodeId)) continue
    const node = nodeById(def, nodeId)
    if (holder !== null) {
      refused.push({ node: nodeId, refusal: sentence, heldBy: holder, unreadable: false })
      continue
    }
    const verdict = enterNode(def, nodeId, facts)
    if (!verdict.ok) {
      refused.push({
        node: nodeId,
        refusal: verdict.refusal,
        heldBy: null,
        // A fact nobody could read is not a fact that was missing: the caller may say so instead of
        // drawing the card as merely blocked (#1211, #1316 pin 8).
        unreadable: verdict.stale.some((entry) => entry.reason === 'unreadable') || verdict.guardRefusals.some((entry) => entry.unreadable),
      })
      continue
    }
    open.push({
      parentId: jobId,
      workflow: def.id,
      node: nodeId,
      role: node.role,
      queueRole: node.role,
      // Who does it is the queue's answer: the claimer becomes the assignee (#1247), so the card is
      // created unassigned and no second dispatch path exists (#1316 pin 3).
      assignee: null,
    })
  }
  return { jobId, workflow: def.id, open, refused }
}

// Pin 6: a job is done when its terminal node's outputs exist **and are current** — never because a
// card was moved to done, and never by claiming something the source did not say. A node is terminal
// when no other node takes in what it hands out; `waiting` names every deliverable-shaped output that
// is missing, stale or unreadable, so a caller can say which one holds the job open.
export function jobDone({ definition, facts = {} } = {}) {
  const def = normaliseWorkflow(definition)
  const consumers = consumersOf(def)
  const waiting = []
  let terminals = 0
  for (const node of def.nodes) {
    const handing = node.outputs.filter((spec) => (consumers[canonicalSpec(spec) ?? spec] ?? []).length === 0)
    if (handing.length === 0) continue
    terminals += 1
    for (const spec of handing) {
      const key = canonicalSpec(spec) ?? spec
      const state = freshness(factAt(facts.present, spec), factAt(facts.current, spec))
      if (state.fresh) continue
      waiting.push({ node: node.id, spec: key, reason: state.reason, have: state.have, now: state.now })
    }
  }
  return { done: terminals > 0 && waiting.length === 0, waiting }
}

// Step (c)'s pure half (#1316): a node's card is done and its declared outputs are current, so the
// caller appends the node's completion — and the next node's card opens on its own facts, because
// opening is a fact and not a follow-up action (pin 5). Append-only: an entry already in `history` is
// not returned again, and no record is rewritten — the history is what says a node finished, so a
// definition edited later cannot rewrite what already happened (#1316 pin 9).
export function completions({ definition, job = {}, cards = [], history = [], facts = {} } = {}) {
  const def = normaliseWorkflow(definition)
  const recorded = new Set()
  for (const entry of Array.isArray(history) ? history : []) {
    const node = typeof entry === 'string' ? entry : entry?.node
    if (typeof node === 'string' && node !== '') recorded.add(node)
  }
  const list = Array.isArray(cards) ? cards : []
  const out = []
  for (const nodeId of topologicalOrder(def)) {
    if (recorded.has(nodeId)) continue
    const node = nodeById(def, nodeId)
    if (node === null) continue
    const card = list.find((entry) => entry?.node === nodeId)
    if (!card || card.column !== 'done') continue
    const outputs = node.outputs.map((spec) => {
      const key = canonicalSpec(spec) ?? spec
      const state = freshness(factAt(facts.present, spec), factAt(facts.current, spec))
      const have = factAt(facts.present, spec)
      return { spec: key, state: state.reason, revision: have?.revision ?? null }
    })
    if (outputs.some((entry) => entry.state !== 'current')) continue
    out.push({
      parentId: job?.id ?? null,
      workflow: def.id,
      node: nodeId,
      outputs: outputs.map(({ spec, revision }) => ({ spec, revision })),
    })
  }
  return out
}
