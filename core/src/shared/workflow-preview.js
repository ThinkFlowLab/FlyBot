// The guard preview an editor shows (#1272 step 3, acceptance 5): for one node, the sentence each
// of its guards would print under the facts somebody just read. Two rules, both of them the
// engine's, not the page's —
//
//   - the sentence is `renderRefusal`'s, produced from the definition, so the preview and the card's
//     own refusal cannot disagree;
//   - a fact nobody could read is `unreadable`, never a pass. When the caller read nothing at all,
//     every row says so; a row with no sentence means only "this guard was read and holds".
import { guardRows, normaliseWorkflow, nodeById } from './workflow.js'

// The row a guard gets when the fact source answered nothing. It names the fact it could not read
// and says what that means for the card; it never says the guard passes.
export const cannotRead = (node, spec) => `${node?.name || node?.id || 'this node'} refuses: its check on ${spec ?? 'a fact'} could not be read — no answer came back, so nothing here says it holds.`

// `answer` is `{ ok: true, facts }` from a reader that answered, or `{ ok: false, why }` from one that
// did not. The rows keep the definition's guard order.
export function previewNode(raw, nodeId, answer = {}) {
  const def = normaliseWorkflow(raw)
  const node = nodeById(def, nodeId)
  if (node === null) return { node: nodeId, facts: 'unknown', rows: [], refusal: `there is no node "${nodeId}" in this workflow` }
  if (answer?.ok !== true) {
    return {
      node: node.id,
      facts: 'unavailable',
      why: typeof answer?.why === 'string' && answer.why !== '' ? answer.why : null,
      rows: node.guards.map((guard) => ({
        id: guard.id,
        spec: guard.spec,
        is: guard.is,
        value: guard.value,
        state: 'unreadable',
        sentence: cannotRead(node, guard.spec),
        unreadable: true,
      })),
      refusal: node.guards.length === 0 ? null : cannotRead(node, node.guards[0].spec),
    }
  }
  const rows = guardRows(def, node.id, answer.facts ?? {})
  const first = rows.find((row) => row.state !== 'holds')
  return { node: node.id, facts: 'read', why: null, rows, refusal: first?.sentence ?? null }
}
