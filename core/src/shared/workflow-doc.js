// A workflow definition as a file (#1272 step 3): `workflows/<id>.json` in the workspace, written
// once and read back byte for byte. The two rules that live here are the ones a page cannot keep
// for itself —
//
//   - **saving an unedited definition changes nothing.** `workflowBytes` is canonical: a fixed key
//     order, two spaces, a trailing newline, and fields a definition does not state left out. So a
//     load → save round trip is byte-identical, a definition can be diffed in git, and a save that
//     reorders keys is a defect here rather than a surprise in someone's review.
//   - **a preset is copied, never mutated.** `PRESET_IDS` names the definitions FlyBot ships; a
//     workspace file may not take one of those ids, and a copy differs from its preset only in
//     `id` / `name` — which is the assertion `workflow-doc.test.js` makes before any page exists.
//
// Nothing here does I/O: the host writes the bytes this module produces (`host/workflow-store.js`).
import { normaliseWorkflow } from './workflow.js'

// The folder in the workspace, and the shipped ids a workspace file may not claim.
export const WORKFLOW_DIR = 'workflows'
export const PRESET_IDS = Object.freeze(['repo-dev', 'blank'])

// A file name, not a title: lowercase, no spaces, no path separators, so `workflows/<id>.json` can
// never leave its folder and two workflows cannot share one file.
const ID_RULE = /^[a-z0-9][a-z0-9-]{0,62}$/

export const isWorkflowId = (id) => typeof id === 'string' && ID_RULE.test(id)
export const isPresetId = (id) => PRESET_IDS.includes(id)

const guardDoc = (guard) => {
  const doc = { id: guard.id, spec: guard.spec, is: guard.is }
  if (guard.value !== null) doc.value = guard.value
  if (guard.refusal !== '') doc.refusal = guard.refusal
  return doc
}

const nodeDoc = (node) => {
  const doc = { id: node.id, name: node.name, role: node.role }
  // `column: false` is a decision ("this node draws no column"), and a missing one is the other
  // decision ("the node id is the column"), so the two are written differently (#1265).
  if (node.column !== null) doc.column = node.column
  doc.inputs = node.inputs.slice()
  doc.outputs = node.outputs.slice()
  doc.guards = node.guards.map(guardDoc)
  doc.refusal = node.refusal
  return doc
}

// The canonical document of a definition, as an object with a fixed key order.
export function workflowDocument(raw) {
  const def = normaliseWorkflow(raw)
  return {
    id: def.id,
    name: def.name,
    version: def.version,
    inputs: def.inputs.slice(),
    deliverables: def.deliverables.slice(),
    nodes: def.nodes.map(nodeDoc),
    edges: def.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    loops: def.loops.map((loop) => ({ from: loop.from, to: loop.to })),
  }
}

// The bytes a save writes and a load compares against. Same definition in, same bytes out.
export function workflowBytes(raw) {
  return `${JSON.stringify(workflowDocument(raw), null, 2)}\n`
}

// What a `Customize` writes: the preset's own nodes and edges, with a new id and name. Everything
// else is the preset's, which is what makes "the copy differs only in id/name" checkable.
export function copyOfPreset(preset, { id, name } = {}) {
  const def = normaliseWorkflow(preset)
  return normaliseWorkflow({
    ...workflowDocument(def),
    id,
    name: name === undefined || name === null || String(name).trim() === '' ? def.name : String(name).trim(),
  })
}

// The fields in which two definitions differ, by name — `['id', 'name']` for a preset and its copy.
// Used by the store to refuse a save that would rewrite a shipped preset, and by the test that
// holds acceptance 6.
export function differingFields(left, right) {
  const a = workflowDocument(left)
  const b = workflowDocument(right)
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort()
}
