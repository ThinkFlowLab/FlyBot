// Project board's two management buttons (#1749). The board drew "Project settings" and "Members"
// with no handler at all, so clicking either only moved focus. These pin the three surfaces a
// reader now gets: each button opens its panel, the settings panel saves only through the write
// paths the host already has, and the members panel lists who the record and the board name.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/project-board.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})
// A hook runtime: every panel is a plain function, so a slot array that survives a re-render is
// enough to type into a field, press a button, and read the tree it draws next.
let slots = []
let index = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useCallback: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn; return slots[at] },
  useMemo: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useEffect: () => { const at = index++; if (!(at in slots)) slots[at] = true },
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useState: (initial) => {
    const at = index++
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
}
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, Date, Promise, console,
  window: { location: { hash: '' }, addEventListener() {}, removeEventListener() {} },
  require: (name) => {
    if (name === 'react') return react
    throw new Error(`no platform module ${name}`)
  },
})
const { ProjectBoardPane, ProjectSettingsPanel, ProjectMembersPanel } = module.exports

const render = (component, props) => { index = 0; return component(props) }
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function') return all(node.type(node.props), out)
  out.push(node)
  all(node.children, out)
  return out
}
const byAction = (tree, action) => all(tree).find(node => node.props?.['data-action'] === action)
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string') return node
  if (node && typeof node === 'object') return text(node.children)
  return ''
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

const rows = [{ id: 'task-1', source: 'bot', column: 'in-progress', assignee: 'Dev4' }]

test('both management buttons open their panel, owner or not', () => {
  const opened = []
  const tree = render(ProjectBoardPane, {
    project: { id: 'project-1', name: 'FlyBot' }, rows, canManage: false,
    onSettings: () => opened.push('settings'), onMembers: () => opened.push('members'),
  })
  const settings = byAction(tree, 'project-settings')
  const members = byAction(tree, 'project-members')
  assert.ok(settings, 'Project settings is drawn for a non-owner too — the host refuses, not the page')
  assert.ok(members, 'Members is drawn for a non-owner too')
  settings.props.onClick()
  members.props.onClick()
  assert.deepEqual(opened, ['settings', 'members'])
})

test('the settings panel saves through project-bind, project-assistant-owner and project-memory-write', async () => {
  const sent = []
  const save = async (endpoint, payload) => { sent.push({ endpoint, payload }); return { ok: true } }
  let tree = render(ProjectSettingsPanel, { project: { id: 'project-1', name: 'FlyBot' }, call: save, onClose() {} })
  const memberInput = all(tree).find(node => node.props?.id === 'bt-project-member-id')
  memberInput.props.onChange({ target: { value: 'bot-9' } })
  tree = render(ProjectSettingsPanel, { project: { id: 'project-1', name: 'FlyBot' }, call: save, onClose() {} })
  byAction(tree, 'project-bind').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { endpoint: 'project-bind', payload: { kind: 'bot', id: 'bot-9', projectId: 'project-1' } })

  tree = render(ProjectSettingsPanel, { project: { id: 'project-1', name: 'FlyBot' }, call: save, onClose() {} })
  byAction(tree, 'project-assistant-save').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { endpoint: 'project-assistant-owner', payload: { id: 'project-1', settings: { off: false } } })

  tree = render(ProjectSettingsPanel, { project: { id: 'project-1', name: 'FlyBot' }, call: save, onClose() {} })
  const note = all(tree).find(node => node.props?.id === 'bt-project-note')
  note.props.onChange({ target: { value: 'ship on Friday' } })
  tree = render(ProjectSettingsPanel, { project: { id: 'project-1', name: 'FlyBot' }, call: save, onClose() {} })
  byAction(tree, 'project-memory-save').props.onClick()
  await tick()
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { endpoint: 'project-memory-write', payload: { id: 'project-1', kind: 'note', text: 'ship on Friday' } })
})

test("the settings panel shows the host's refusal instead of pretending the save landed", async () => {
  const refused = Object.assign(new Error('Only the owner of this Project may change it'), { code: 'bot/forbidden' })
  const save = async () => { throw refused }
  let tree = render(ProjectSettingsPanel, { project: { id: 'project-1' }, call: save, onClose() {} })
  byAction(tree, 'project-memory-save').props.onClick()
  await tick()
  tree = render(ProjectSettingsPanel, { project: { id: 'project-1' }, call: save, onClose() {} })
  const status = all(tree).find(node => node.props?.role === 'status')
  assert.match(text(status), /Only the owner of this Project/)
})

test('the members panel lists the owners and the members the board names, and offers no write', () => {
  const tree = render(ProjectMembersPanel, {
    project: { id: 'project-1', ownerUserId: 'owner-1', ownerUserIds: ['owner-1', 'owner-2'] },
    rows, onClose() {},
  })
  const members = all(tree).filter(node => node.props?.['data-member-role'] !== undefined)
  assert.deepEqual(members.map(node => node.props['data-member-id']), ['owner-1', 'owner-2', 'Dev4'])
  assert.deepEqual(members.map(node => node.props['data-member-role']), ['owner', 'owner', 'board'])
  assert.equal(byAction(tree, 'project-bind'), undefined, 'membership management is a later slice, not a dead button here')
})
