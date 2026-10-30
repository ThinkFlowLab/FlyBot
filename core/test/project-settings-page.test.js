// Settings → Projects (#1766): a fresh install has no Project, so the page *is* the way to make
// one. The page calls `project-create` and then reads `projects` again; a binding is the member's
// own field, so binding and unbinding both go through `project-bind`; and the working folder comes
// from the folder picker every other "where does this happen" control uses, not a typed path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  stdin: {
    contents: "export { SettingsDialog, ProjectsPage, ProjectsList } from './src/client/settings.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } })
// A small hook runtime: the pages are plain functions, so a slot array that survives a re-render is
// enough to type a name and press the button the way a person would.
let slots = []
let index = 0
let effects = []
const react = {
  createElement: h, Component: class {}, Fragment: Symbol('F'),
  useMemo: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn(); return slots[at] },
  useState: (initial) => {
    const at = index++
    if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial
    return [slots[at], (value) => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }]
  },
  useCallback: (fn) => { const at = index++; if (!(at in slots)) slots[at] = fn; return slots[at] },
  useRef: (value) => { const at = index++; if (!(at in slots)) slots[at] = { current: value }; return slots[at] },
  useEffect: (fn) => { const at = index++; if (!(at in slots)) { slots[at] = true; effects.push(fn) } },
  useLayoutEffect() {},
  useSyncExternalStore: (_subscribe, get) => get(),
}
const win = { location: { hash: '' }, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, console, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  navigator: { language: 'en' },
  localStorage: { getItem: () => null, setItem() {} },
  window: win,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { SettingsDialog, ProjectsPage, ProjectsList } = module.exports

const render = (component, props) => { index = 0; return component(props) }
const flush = async () => {
  const queued = effects
  effects = []
  for (const fn of queued) await fn()
  await new Promise(resolve => setTimeout(resolve, 0))
}
const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.props?.children, out) }
  return out
}
const text = (node) => {
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string') return node
  if (node && typeof node === 'object') return text(node.props?.children)
  return ''
}
const roster = {
  bots: [{ id: 'a', name: 'Chief' }, { id: 'b', name: 'Writer' }],
  rooms: [{ id: 'r1', name: 'Ops', projectId: 'project-1' }],
  byId: {}, roomsById: {}, prefs: {}, mainBotIds: [], connectors: [],
}
const actions = { openSettings() {}, closeSettings() {} }

test('Settings lists a Projects page beside Bots and group chats, and draws it', () => {
  const tree = SettingsDialog({ page: 'projects', id: null, roster, actions, useUpdate: () => ({}) })
  const nodes = all(tree)
  const items = nodes.filter(node => node.type === 'button' && node.props.className === 'bt-settings-item').map(text)
  assert.deepEqual(items.slice(0, 4), ['General', 'Bots', 'Group chats', 'Projects'])
  assert.equal(text(nodes.find(node => node.type === 'h2')), 'Projects')
  const page = nodes.find(node => typeof node.type === 'function' && typeof node.props?.call === 'function' && node.props?.roster === roster)
  assert.ok(page, 'the Projects page is the one rendered for the page key')
})

test('an install with no Project says so, and creating one re-reads the list', async () => {
  const calls = []
  const call = async (endpoint, body) => {
    // The body is built inside the bundle, so it is copied across the realm before comparing.
    calls.push(body === undefined ? [endpoint] : [endpoint, JSON.parse(JSON.stringify(body))])
    if (endpoint === 'projects') return { projects: [] }
    if (endpoint === 'project-create') return { project: { id: 'project-1', name: body.name, workDir: body.workDir ?? null } }
    return {}
  }
  slots = []
  effects = []
  let page = render(ProjectsPage, { roster, actions, run: fn => fn, call })
  await flush()
  page = render(ProjectsPage, { roster, actions, run: fn => fn, call })
  let nodes = all(page)
  assert.match(nodes.map(text).join(' '), /No Project yet — create one/)

  // The folder is chosen, not typed: the one text input is the name.
  const inputs = nodes.filter(node => node.type === 'input')
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].props['aria-label'], 'Project name')
  const folderRow = nodes.find(node => node.props?.label === 'Working folder')
  assert.ok(folderRow, 'the create form has a working folder row')
  const picker = all(folderRow).find(node => typeof node.type === 'function' && typeof node.props?.onPick === 'function')
  assert.ok(picker, 'the working folder comes from the folder picker')

  inputs[0].props.onChange({ target: { value: 'Website' } })
  page = render(ProjectsPage, { roster, actions, run: fn => fn, call })
  nodes = all(page)
  picker.props.onPick('/work/site')
  page = render(ProjectsPage, { roster, actions, run: fn => fn, call })
  nodes = all(page)
  const create = nodes.find(node => node.type === 'button' && /New Project/.test(text(node)))
  assert.ok(create)
  create.props.onClick()
  await flush()

  assert.deepEqual(calls, [
    ['projects'],
    ['project-create', { name: 'Website', workDir: '/work/site' }],
    ['projects'],
  ], 'a new Project is created and the list is read again')
})

test('a row opens its board, a Bot binds with its Project id, and unbinding sends null', async () => {
  const calls = []
  const call = async (endpoint, body) => { calls.push([endpoint, JSON.parse(JSON.stringify(body))]) }
  const reload = async () => { calls.push(['projects']) }
  const project = { id: 'project-1', name: 'Site', workDir: '/work/site' }
  const nodes = all(ProjectsList({ projects: [project], roster, call, reload }))
  assert.ok(nodes.some(node => node.props?.label === 'Site'), 'the Project is listed by name')

  const open = nodes.find(node => node.type === 'button' && text(node) === 'Open board')
  assert.ok(open, 'a row opens the board')
  win.location.hash = ''
  open.props.onClick()
  assert.equal(win.location.hash, '#project=project-1', 'the row opens the hash the board already reads')

  const select = nodes.find(node => node.type === 'select')
  assert.ok(select, 'a Bot or group can be bound from the row')
  select.props.onChange({ target: { value: 'bot:a' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls[0], ['project-bind', { kind: 'bot', id: 'a', projectId: 'project-1' }])
  assert.deepEqual(calls[1], ['projects'], 'the binding is read back, not assumed')

  const unbind = nodes.find(node => node.type === 'button' && text(node) === 'Unbind')
  assert.ok(unbind, 'a bound group is listed with an unbind control')
  unbind.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls[2], ['project-bind', { kind: 'group', id: 'r1', projectId: null }])
})
