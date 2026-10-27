// The Workflows page (#1272 step 3): the factory presets, the owner's own workflows, which one the
// project uses, and the node table that edits one. The page is a reader of the engine: the columns a
// definition draws, the flowchart's layout and the sentence a guard would print all come from
// `shared/workflow*.js` through the host, so nothing here re-decides what a workflow is.
//
// Three things the page is careful about:
//   - a preset is copied, never edited: its fields are read-only and `Customize` is the only button
//     that changes one into something editable;
//   - a guard row shows the sentence this definition would print right now, or says the fact could
//     not be read — a row with no sentence means the guard was read and holds, never a guess;
//   - the flowchart is drawn from the table, so a box per node and an edge per edge row are what the
//     page shows, not a second copy of the definition.
import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { WorkflowIcon } from './icons.js'

// What `inputs` / `outputs` are: one comma-separated line, the spelling the definition itself uses.
export function parseList(text) {
  return String(text ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export const formatList = (list) => (Array.isArray(list) ? list.join(', ') : '')

// A guard as the page writes it: `spec is value` — `check:tests-ok is fresh`, `verdict is equals PASS`.
// The id and the per-guard refusal are kept from the guard that was already there, so editing a
// value does not silently drop the sentence the definition refuses with.
export function guardLines(guards) {
  return (Array.isArray(guards) ? guards : [])
    .map((guard) => `${guard.spec} is ${guard.is}${guard.value === null || guard.value === undefined ? '' : ` ${guard.value}`}`)
    .join('\n')
}

export function parseGuards(text, previous = []) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const found = /^(\S+)\s+is\s+(\S+)(?:\s+(.+))?$/.exec(line)
      if (found === null) return null
      const [, spec, is, value] = found
      const before = previous.find((guard) => guard.spec === spec && guard.is === is)
      return {
        id: before?.id ?? `${spec}-${is}`,
        spec,
        is,
        value: value === undefined ? null : value.trim(),
        refusal: before?.refusal ?? '',
      }
    })
    .filter(Boolean)
}

// One field of one node, from a text input. The node id is not one of them: changing it would leave
// every edge naming a node that no longer exists, and a definition that cannot be drawn is exactly
// what the save refuses.
export function applyNodeField(definition, nodeId, field, value) {
  if (definition === null || definition === undefined) return definition
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.id !== nodeId) return node
      if (field === 'inputs' || field === 'outputs') return { ...node, [field]: parseList(value) }
      if (field === 'guards') return { ...node, guards: parseGuards(value, node.guards) }
      return { ...node, [field]: value }
    }),
  }
}

const field = (label, value, onChange, options = {}) => h('label', { className: 'bt-wf-field', key: label },
  h('span', { className: 'bt-wf-label' }, label),
  h('input', {
    className: 'bt-wf-input', value: value ?? '', disabled: options.disabled === true,
    placeholder: options.placeholder ?? '', onChange: (event) => onChange(event.target.value),
  }))

const guardState = (row) => (row.state === 'holds' ? t('holds') : row.state === 'unreadable' ? t('cannot read') : t('refuses'))

function Flow({ layout }) {
  if (!layout || !Array.isArray(layout.boxes) || layout.boxes.length === 0) return null
  return h('svg', {
    className: 'bt-wf-flow', viewBox: `0 0 ${Math.max(layout.width, 1)} ${Math.max(layout.height, 1)}`,
    role: 'img', 'aria-label': t('The flowchart, drawn from the node table'),
    'data-boxes': String(layout.boxes.length), 'data-edges': String(layout.edges.length),
  },
  layout.edges.map((edge, index) => h('line', {
    key: `e${index}`, className: 'bt-wf-edge', x1: edge.points?.[0]?.x ?? 0, y1: edge.points?.[0]?.y ?? 0,
    x2: edge.points?.[1]?.x ?? 0, y2: edge.points?.[1]?.y ?? 0,
  })),
  layout.boxes.map((box) => h('g', { key: box.id, className: 'bt-wf-box', 'data-node': box.id, transform: `translate(${box.x} ${box.y})` },
    h('rect', { width: box.width, height: box.height, rx: 12 }),
    h('text', { x: 14, y: 26, className: 'bt-wf-box-name' }, box.name),
    h('text', { x: 14, y: 48, className: 'bt-wf-box-role' }, box.role),
    h('text', { x: 14, y: 72, className: 'bt-wf-box-rails' }, `${box.inputs.join(', ') || '—'} → ${box.outputs.join(', ') || '—'}`))))
}

function Preview({ preview }) {
  if (!preview) return null
  return h('div', { className: 'bt-wf-preview', 'data-facts': preview.facts },
    preview.facts === 'unavailable'
      ? h('div', { className: 'bt-wf-hint' }, t('This host could not read the facts, so these guards say what they could not read — none of them is a pass.'))
      : null,
    (preview.rows ?? []).map((row) => h('div', { key: row.id, className: 'bt-wf-guard', 'data-state': row.state },
      h('span', { className: 'bt-wf-badge', 'data-state': row.state }, guardState(row)),
      h('span', { className: 'bt-wf-guard-spec' }, `${row.spec} is ${row.is}${row.value === null || row.value === undefined ? '' : ` ${row.value}`}`),
      row.sentence ? h('span', { className: 'bt-wf-guard-line' }, row.sentence) : null)))
}

export function WorkflowsPage({ actions }) {
  const [list, setList] = useState(null)
  const [opened, setOpened] = useState(null)
  const [draft, setDraft] = useState(null)
  const [node, setNode] = useState(null)
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const load = () => Promise.resolve(actions.workflows({ op: 'list' }))
    .then((value) => { setList(value); return value })
    .catch((failure) => { setError(failure?.message ?? String(failure)); return null })

  useEffect(() => { load() }, [])

  const open = (id, target) => Promise.resolve(actions.workflows({ op: 'open', id, node: target ?? null }))
    .then((value) => {
      if (value?.ok === false) { setError(value.message ?? t('Could not open this workflow')); return value }
      setOpened(value)
      setDraft(value.workflow.definition)
      setNode(value.preview?.node ?? value.workflow.definition.nodes[0]?.id ?? null)
      setPreview(value.preview)
      setError('')
      setSaved('')
      return value
    })
    .catch((failure) => { setError(failure?.message ?? String(failure)); return null })

  const showNode = (id) => {
    setNode(id)
    if (!opened) return
    Promise.resolve(actions.workflows({ op: 'preview', id: opened.workflow.id, node: id }))
      .then((value) => setPreview(value?.preview ?? null))
      .catch((failure) => setError(failure?.message ?? String(failure)))
  }

  const save = () => Promise.resolve(actions.workflowSave({ op: 'save', definition: draft }))
    .then((value) => {
      if (value?.ok === false) { setError(value.message ?? t('This definition cannot be saved')); return value }
      setSaved(t('Saved workflows/{id}.json', { id: value.id }))
      setError('')
      return load().then(() => open(value.id, node))
    })
    .catch((failure) => { setError(failure?.message ?? String(failure)); return null })

  const customize = () => {
    if (!opened) return null
    const base = opened.workflow.id
    const id = `${base}-copy`
    return Promise.resolve(actions.workflowSave({ op: 'customize', from: base, id, name: `${opened.workflow.name} (mine)` }))
      .then((value) => {
        if (value?.ok === false) { setError(value.message ?? t('This definition cannot be copied')); return value }
        return load().then(() => open(id))
      })
      .catch((failure) => { setError(failure?.message ?? String(failure)); return null })
  }

  const useDefault = () => {
    if (!opened) return null
    return Promise.resolve(actions.workflowSave({ op: 'default', id: opened.workflow.id }))
      .then((value) => { if (value?.ok !== false) setList(value); return value })
      .catch((failure) => { setError(failure?.message ?? String(failure)); return null })
  }

  const editable = opened?.workflow.editable === true
  const current = draft?.nodes?.find((entry) => entry.id === node) ?? null

  return h('div', { className: 'bt-wf-page' },
    h('div', { className: 'bt-wf-head' },
      h('h3', null, h(WorkflowIcon), t('Workflows')),
      h('span', { className: 'bt-wf-hint' }, t('A workflow is a file: workflows/<id>.json. Columns, the flowchart and the refusals are all drawn from it.'))),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    saved ? h('div', { className: 'bt-wf-saved', role: 'status' }, saved) : null,
    h('div', { className: 'bt-wf-list' },
      ['presets', 'own'].map((group) => h('div', { key: group, className: 'bt-wf-group' },
        h('span', { className: 'bt-wf-group-name' }, group === 'presets' ? t('Factory presets') : t('Yours')),
        (list?.[group] ?? []).map((entry) => h('button', {
          key: `${group}:${entry.id}`, type: 'button', className: 'bt-wf-pick',
          'aria-current': opened?.workflow.id === entry.id ? 'true' : undefined,
          'data-id': entry.id, 'data-source': entry.source,
          onClick: () => open(entry.id),
        }, entry.name, list?.default === entry.id ? h('span', { className: 'bt-wf-default' }, t('project default')) : null)))),
      list === null ? h('span', { className: 'bt-wf-hint' }, t('Reading workflows…')) : null),
    opened === null ? null : h('div', { className: 'bt-wf-doc' },
      h('div', { className: 'bt-wf-doc-head' },
        h('strong', null, opened.workflow.name),
        h('span', { className: 'bt-wf-path' }, `workflows/${opened.workflow.id}.json`),
        h('button', { type: 'button', className: 'bt-wf-action', onClick: customize }, t('Customize')),
        editable ? h('button', { type: 'button', className: 'bt-wf-action', onClick: save }, t('Save')) : null,
        h('button', { type: 'button', className: 'bt-wf-action', onClick: useDefault }, t('Use for this project'))),
      h(Flow, { layout: opened.layout }),
      h('div', { className: 'bt-wf-table' },
        h('div', { className: 'bt-wf-row bt-wf-row-head' },
          ['id', 'name', 'role', 'inputs', 'outputs', 'guards', 'refusal'].map((key) => h('span', { key }, key))),
        (draft?.nodes ?? []).map((entry) => h('div', {
          key: entry.id, className: 'bt-wf-row', 'data-node': entry.id,
          'aria-current': entry.id === node ? 'true' : undefined,
          onClick: () => showNode(entry.id),
        },
        h('span', { className: 'bt-wf-cell bt-wf-id' }, entry.id),
        editable ? field('name', entry.name, (value) => setDraft(applyNodeField(draft, entry.id, 'name', value))) : h('span', null, entry.name),
        editable ? field('role', entry.role, (value) => setDraft(applyNodeField(draft, entry.id, 'role', value))) : h('span', null, entry.role),
        editable ? field('inputs', formatList(entry.inputs), (value) => setDraft(applyNodeField(draft, entry.id, 'inputs', value))) : h('span', null, formatList(entry.inputs)),
        editable ? field('outputs', formatList(entry.outputs), (value) => setDraft(applyNodeField(draft, entry.id, 'outputs', value))) : h('span', null, formatList(entry.outputs)),
        editable
          ? h('textarea', { className: 'bt-wf-guards-input', value: guardLines(entry.guards), onChange: (event) => setDraft(applyNodeField(draft, entry.id, 'guards', event.target.value)) })
          : h('span', null, guardLines(entry.guards)),
        editable ? field('refusal', entry.refusal, (value) => setDraft(applyNodeField(draft, entry.id, 'refusal', value))) : h('span', null, entry.refusal)))),
      h('div', { className: 'bt-wf-edges' },
        h('span', { className: 'bt-wf-group-name' }, t('Edges')),
        (draft?.edges ?? []).map((edge) => h('span', { key: `${edge.from}->${edge.to}`, className: 'bt-wf-edge-row' }, `${edge.from} → ${edge.to}`))),
      h('div', { className: 'bt-wf-node' },
        h('span', { className: 'bt-wf-group-name' }, node === null ? t('Guards') : t('Guards of {node}', { node: current?.name ?? node })),
        current === null || current.guards.length === 0
          ? h('span', { className: 'bt-wf-hint' }, t('This node has no guards, so nothing refuses it but its inputs.'))
          : h(Preview, { preview }))))
}
