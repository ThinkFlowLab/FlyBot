// The board the definition draws (#1272 step 3, acceptance 1 and 2): which columns a workflow has,
// in which order, and which of them a card sits in. Today's five fixed columns (`raw`, `ready`,
// `working`, `review`, `done-today`) stay for cards that name no workflow — a card without a
// `node` renders exactly as it did (#1299 acceptance 8) — and a card that does name one is laid in
// a column of its own workflow, so two workflows never share a column and every header can name the
// workflow it belongs to.
//
// Pure: definitions in, sections out. The host assembles the payload, the client draws it.
import { normaliseWorkflow, nodeById, workflowColumns } from './workflow.js'

// One workflow's columns, in the order the definition puts its nodes: a node's `column` is the lane
// its cards sit in and the node id is the lane when the definition states none. `column: false`
// draws no lane at all. Two nodes may share a lane (`build` and `verify` are one "in-progress"
// lane); the lane is then named by its id, because naming it after one of the two would say the
// other node's cards belong elsewhere.
export function columnPlan(raw) {
  const def = normaliseWorkflow(raw)
  const plan = []
  const byLane = new Map()
  for (const column of workflowColumns(def)) {
    let lane = byLane.get(column.column)
    if (lane === undefined) {
      lane = { id: column.column, label: column.name, nodes: [] }
      byLane.set(column.column, lane)
      plan.push(lane)
    }
    lane.nodes.push(column.id)
    if (lane.nodes.length > 1) lane.label = lane.id
  }
  return plan
}

// Which lane a card sits in, or `null` when this definition cannot place it: the card names another
// workflow, names no node, or names a node that draws no column. `null` is not "drop it" — the
// caller keeps the card where it draws today.
export function placeCard(raw, card) {
  const def = normaliseWorkflow(raw)
  if (!card || typeof card !== 'object') return null
  if (card.workflow !== def.id) return null
  const node = card.node ? nodeById(def, card.node) : null
  if (node === null) return null
  if (node.column === false) return null
  return node.column ?? node.id
}

// The board's workflow sections: one per definition that has a card, its columns in definition
// order, and a card in the column its node names. Cards this definition cannot place are in
// `unplaced` so a caller can show them instead of losing them; cards naming no workflow come back
// as `legacy`, which is what keeps a board of today's cards looking exactly like today's board.
export function boardSections(definitions, cards) {
  const defs = (Array.isArray(definitions) ? definitions : []).map(normaliseWorkflow).filter((def) => def.id !== '')
  const list = Array.isArray(cards) ? cards.filter((card) => card && typeof card === 'object') : []
  const claimed = new Set()
  const sections = []
  for (const def of defs) {
    const plan = columnPlan(def)
    const lanes = new Map(plan.map((column) => [column.id, []]))
    const unplaced = []
    for (const card of list) {
      if (card.workflow !== def.id) continue
      const lane = placeCard(def, card)
      if (lane === null) {
        // A card this definition cannot place is the section's `unplaced`, not a card the legacy
        // columns draw a second time.
        claimed.add(card)
        unplaced.push(card)
        continue
      }
      claimed.add(card)
      if (!lanes.has(lane)) lanes.set(lane, [])
      lanes.get(lane).push(card)
    }
    if (unplaced.length === 0 && [...lanes.values()].every((lane) => lane.length === 0)) continue
    sections.push({
      id: def.id,
      name: def.name,
      columns: [...lanes].map(([id, laneCards]) => ({
        id,
        label: plan.find((column) => column.id === id)?.label ?? id,
        cards: laneCards,
      })),
      unplaced,
    })
  }
  const legacy = list.filter((card) => !claimed.has(card))
  return { sections, legacy }
}
