// The Workflows page (#1272 step 3, acceptance 3, 4, 5 and 6): the node table, the flowchart drawn
// from it, a guard's live refusal, and a preset that is read-only until it is customized.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { WorkflowsPage, applyNodeField, formatList, guardLines, parseGuards, parseList } from './src/client/workflows.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
let states = []
const react = {
  createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useMemo: (fn) => fn(), useCallback: (fn) => fn(),
  useRef: (current) => ({ current }), useSyncExternalStore: (_s, get) => get(), useState: (value) => [states.length > 0 ? states.shift() : value, () => {}],
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (node) => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { WorkflowsPage, applyNodeField, guardLines, parseGuards, parseList } = module.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const all = (node, out = []) => {
  if (node && typeof node === 'object') {
    if (Array.isArray(node)) node.forEach((child) => all(child, out))
    else { out.push(node); all(node.props?.children, out) }
  }
  return out
}
const text = (node) => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))

const node = (id, name, role, over = {}) => ({ id, name, role, column: null, inputs: [], outputs: [], guards: [], refusal: `${name} cannot start.`, ...over })
const definition = {
  id: 'content',
  name: 'Content',
  version: 1,
  inputs: ['text:topic'],
  deliverables: ['link:published'],
  nodes: [
    node('选题', '选题', 'Writer', { inputs: ['text:topic'], outputs: ['text:draft'] }),
    node('草稿', '草稿', 'Writer', { inputs: ['text:draft'], outputs: ['text:edited'] }),
    node('审稿', '审稿', 'Editor', { inputs: ['text:edited'], outputs: ['verdict'], guards: [{ id: 'verdict-at-tip', spec: 'verdict', is: 'fresh', value: null, refusal: '' }] }),
    node('发布', '发布', 'Publisher', { inputs: ['verdict'], outputs: ['link:published'] }),
    node('归档', '归档', 'Publisher', { inputs: ['link:published'] }),
  ],
  edges: [
    { from: '选题.text:draft', to: '草稿.text:draft' },
    { from: '草稿.text:edited', to: '审稿.text:edited' },
    { from: '审稿.verdict', to: '发布.verdict' },
    { from: '发布.link:published', to: '归档.link:published' },
  ],
  loops: [],
}
const layout = {
  id: 'content',
  name: 'Content',
  boxes: definition.nodes.map((entry, at) => ({ id: entry.id, name: entry.name, role: entry.role, rank: at, row: 0, inputs: entry.inputs, outputs: entry.outputs, x: at * 250, y: 0, width: 220, height: 120 })),
  edges: definition.edges.map((edge) => ({ from: edge.from, to: edge.to, artifact: edge.from, fromBox: '选题', toBox: '草稿', points: [{ x: 220, y: 60 }, { x: 250, y: 60 }] })),
  width: 1250,
  height: 120,
}
const list = {
  ok: true,
  presets: [{ id: 'repo-dev', name: 'Repository change', source: 'preset', nodes: 7 }, { id: 'blank', name: 'Blank', source: 'preset', nodes: 3 }],
  own: [{ id: 'content', name: 'Content', source: 'workspace', nodes: 5 }],
  default: 'repo-dev',
}
const preview = {
  node: '审稿',
  facts: 'read',
  rows: [
    { id: 'verdict-at-tip', spec: 'verdict', is: 'fresh', value: null, state: 'refuse', sentence: '审稿 refuses: its input verdict@abc1234 is stale', unreadable: false },
    { id: 'no-hold', spec: 'pr', is: 'equals', value: 'none', state: 'holds', sentence: null, unreadable: false },
  ],
  refusal: '审稿 refuses: its input verdict@abc1234 is stale',
}
const opened = {
  ok: true,
  ...list,
  workflow: { id: 'content', name: 'Content', source: 'workspace', editable: true, definition, bytes: '{}\n' },
  layout,
  preview,
}
const render = (props, given) => { states = [...given]; const tree = expand(h(WorkflowsPage, props)); states = []; return tree }

test('the table is one row per node with its seven fields, and the edges are listed', () => {
  const tree = render({ actions: {} }, [list, opened, definition, '审稿', preview, '', ''])
  const rows = all(tree).filter((entry) => entry.props?.className === 'bt-wf-row' && entry.props['data-node'] !== undefined)
  assert.equal(rows.length, 5)
  assert.deepEqual(rows.map((row) => row.props['data-node']), ['选题', '草稿', '审稿', '发布', '归档'])
  const head = all(tree).find((entry) => entry.props?.className === 'bt-wf-row bt-wf-row-head')
  assert.deepEqual(all(head).filter((entry) => entry.type === 'span').map(text), ['id', 'name', 'role', 'inputs', 'outputs', 'guards', 'refusal'])
  const edges = all(tree).filter((entry) => entry.props?.className === 'bt-wf-edge-row').map(text)
  assert.equal(edges.length, 4)
  assert.equal(edges[0], '选题.text:draft → 草稿.text:draft')
})

test('the flowchart is drawn from the table: one box per node, one edge per edge row', () => {
  const tree = render({ actions: {} }, [list, opened, definition, '审稿', preview, '', ''])
  const svg = all(tree).find((entry) => entry.type === 'svg' && entry.props?.['data-boxes'] !== undefined)
  assert.equal(svg.props['data-boxes'], '5')
  assert.equal(svg.props['data-edges'], '4')
  assert.equal(all(tree).filter((entry) => entry.type === 'rect').length, 5)
  assert.equal(all(tree).filter((entry) => entry.type === 'line').length, 4)
  // The same definition draws the same picture twice: layout is the host's, computed, never stored.
  const again = render({ actions: {} }, [list, opened, definition, '审稿', preview, '', ''])
  assert.equal(all(again).find((entry) => entry.type === 'svg' && entry.props?.['data-boxes'] !== undefined).props.viewBox, svg.props.viewBox)
})

test('a guard row prints its refusal and never turns an unreadable fact into a pass', () => {
  const tree = render({ actions: {} }, [list, opened, definition, '审稿', preview, '', ''])
  const guards = all(tree).filter((entry) => entry.props?.className === 'bt-wf-guard')
  assert.equal(guards.length, 2)
  assert.equal(guards[0].props['data-state'], 'refuse')
  assert.match(text(guards[0]), /verdict@abc1234 is stale/)
  assert.equal(guards[1].props['data-state'], 'holds')
  const blind = render({ actions: {} }, [list, opened, definition, '审稿', { node: '审稿', facts: 'unavailable', rows: [{ id: 'g', spec: 'verdict', is: 'fresh', value: null, state: 'unreadable', sentence: 'could not be read', unreadable: true }], refusal: null }, '', ''])
  const row = all(blind).find((entry) => entry.props?.className === 'bt-wf-guard')
  assert.equal(row.props['data-state'], 'unreadable')
  assert.match(text(blind), /could not read the facts/)
  // The hint says none of them is a pass; no row claims the guard holds.
  assert.doesNotMatch(text(row), /holds/)
})

test('a preset is read-only until Customize, which copies it into a new file', () => {
  const calls = []
  const actions = {
    workflows: (payload) => { calls.push(['workflows', payload]); return Promise.resolve(payload.op === 'list' ? list : opened) },
    workflowSave: (payload) => { calls.push(['save', payload]); return Promise.resolve({ ok: true, id: 'repo-dev-copy', ...list }) },
  }
  const presetOpened = { ...opened, workflow: { id: 'repo-dev', name: 'Repository change', source: 'preset', editable: false, definition, bytes: '' } }
  const tree = render({ actions }, [list, presetOpened, definition, '审稿', preview, '', ''])
  const labels = all(tree).filter((entry) => entry.type === 'button').map(text)
  assert.ok(labels.includes('Customize'))
  assert.ok(!labels.includes('Save'))
  // Every editable field is disabled, so a preset has no save path at all.
  assert.equal(all(tree).filter((entry) => entry.type === 'input').length, 0)

  all(tree).filter((entry) => entry.type === 'button').find((button) => text(button) === 'Customize').props.onClick()
  const save = calls.find(([kind]) => kind === 'save')
  assert.equal(JSON.stringify(save[1]), JSON.stringify({ op: 'customize', from: 'repo-dev', id: 'repo-dev-copy', name: 'Repository change (mine)' }))
})

test('editing one field keeps the edges and the other nodes, and guards round-trip', () => {
  const edited = applyNodeField(definition, '审稿', 'name', 'Re-read')
  assert.equal(edited.nodes.find((entry) => entry.id === '审稿').name, 'Re-read')
  assert.equal(JSON.stringify(edited.nodes.map((entry) => entry.id)), JSON.stringify(definition.nodes.map((entry) => entry.id)))
  assert.equal(JSON.stringify(edited.edges), JSON.stringify(definition.edges))
  const listed = applyNodeField(definition, '审稿', 'inputs', 'text:edited, text:notes')
  assert.equal(JSON.stringify(listed.nodes.find((entry) => entry.id === '审稿').inputs), JSON.stringify(['text:edited', 'text:notes']))
  assert.equal(JSON.stringify(parseList('a, b ,,c')), JSON.stringify(['a', 'b', 'c']))
  // A guard keeps its id and its own refusal, so saving a table does not drop the sentence it refuses with.
  const guards = [{ id: 'verdict-at-tip', spec: 'verdict', is: 'fresh', value: null, refusal: 'the head is {now}' }]
  assert.equal(guardLines(guards), 'verdict is fresh')
  assert.equal(JSON.stringify(parseGuards('verdict is fresh\npr is equals none', guards)), JSON.stringify([
    { id: 'verdict-at-tip', spec: 'verdict', is: 'fresh', value: null, refusal: 'the head is {now}' },
    { id: 'pr-equals', spec: 'pr', is: 'equals', value: 'none', refusal: '' },
  ]))
})

test('the page names the file a definition is, and the project default', () => {
  const tree = render({ actions: {} }, [list, opened, definition, '审稿', preview, '', ''])
  assert.match(text(tree), /workflows\/content\.json/)
  assert.match(text(tree), /project default/)
  const picks = all(tree).filter((entry) => entry.props?.['data-id'] !== undefined).map((entry) => entry.props['data-id'])
  assert.deepEqual(picks, ['repo-dev', 'blank', 'content'])
})
