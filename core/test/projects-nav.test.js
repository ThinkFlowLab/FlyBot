// #1828: Projects in the sidebar. The list is the host's answer — a Project's role and the ranks
// the caller may switch to both come from the endpoint's own policy — so these tests draw what the
// host said and never guess a rank.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #1854: `client/api.js` is replaced by a stub that records the endpoint name it was handed. The
// sidebar used to send `flybot/projects`, a namespace the host has no endpoint for, so the list came
// back empty on every deployment and no assertion could see why. A `flybot/` prefix on the way back
// makes this suite red instead of a quietly empty list.
const STUB = `
export const call = async (endpoint, payload) => {
  globalThis.__flybotHostCalls.push({ endpoint, payload })
  if (endpoint === 'projects') {
    return { projects: [
      { id: 'p1', name: 'FlyBot 开发', role: 'owner', choices: [] },
      { id: 'p2', name: 'Side board', role: 'maintainer', choices: ['member'] },
    ] }
  }
  if (endpoint === 'project-role') return { changed: true, role: payload?.role ?? '' }
  const failure = new Error('Unknown FlyBot endpoint ' + endpoint)
  failure.code = 'bot/not-found'
  throw failure
}
`
const recordApi = {
  name: 'record-host-calls',
  setup(context) {
    context.onResolve({ filter: /(^|\/)api\.js$/ }, () => ({ path: 'flybot-api-stub', namespace: 'stub' }))
    context.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }))
  },
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/projects-nav.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
  plugins: [recordApi],
})

// A render pass over the hook shim below: `values` survives a re-render, `index` and `effects` are
// per pass, so a component that sets state and re-renders reads its own new state.
let pass = null
const sandbox = {
  module: { exports: {} }, exports: null, setTimeout: () => 0, clearTimeout: () => {}, Date, Promise, console,
  window: { addEventListener: () => {}, removeEventListener: () => {}, location: { hash: '' } },
  document: { body: {} },
  __flybotHostCalls: [],
  require: (name) => {
    const platform = {
      react: {
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: (initial) => {
          if (pass === null) return [typeof initial === 'function' ? initial() : initial, () => {}]
          const index = pass.index++
          if (!(index in pass.values)) pass.values[index] = typeof initial === 'function' ? initial() : initial
          return [pass.values[index], (next) => { pass.values[index] = typeof next === 'function' ? next(pass.values[index]) : next }]
        },
        useEffect: (fn) => { if (pass !== null) pass.effects.push(fn) },
        useLayoutEffect: (fn) => { if (pass !== null) pass.effects.push(fn) },
        useRef: current => ({ current }), useCallback: fn => fn, useMemo: fn => fn(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: element => element },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
}
sandbox.exports = sandbox.module.exports
runInNewContext(bundle.outputFiles[0].text, sandbox)
const module = sandbox.module
const hostCalls = sandbox.__flybotHostCalls
const { ProjectList, ProjectRoleMenu, ProjectsNav, projectHash, projectMenuItems, projectName, roleNote, roleText } = module.exports

const renderNode = (node) => {
  if (Array.isArray(node)) return node.map(renderNode)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return renderNode(node.type({ ...node.props, children: node.children }))
  return { ...node, children: (node.children ?? []).map(renderNode) }
}
const openPass = () => ({ index: 0, values: [], effects: [] })
const draw = (element, store) => {
  store.index = 0
  store.effects = []
  pass = store
  return renderNode(element())
}
// Effects run after the tree is drawn, as React does, and the promises they start get one turn to land.
const settle = async (store) => {
  const running = store.effects
  store.effects = []
  for (const effect of running) effect()
  await new Promise(resolve => setTimeout(resolve, 0))
}

const textOf = node => (node?.children ?? []).flat(Infinity).filter(child => typeof child === 'string').join('')
const buttons = node => (node?.children ?? []).flat(Infinity).filter(child => child && child.type === 'button')
const find = (node, className) => {
  if (node === null || typeof node !== 'object') return null
  if (String(node.props?.className ?? '').split(' ').includes(className)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, className)
    if (hit) return hit
  }
  return null
}
const project = (extra = {}) => ({ id: 'p1', name: 'Alpha', role: 'member', choices: [], ...extra })
// Values built inside the vm carry that realm's prototypes; compare the data, not the origin.
const plain = value => JSON.parse(JSON.stringify(value))

test('the list draws each Project with the role the host answered (#1828)', () => {
  const view = ProjectList({ projects: [project(), project({ id: 'p2', name: '', role: 'owner' })], error: '', note: '' })
  const rows = buttons(view)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.props['data-project-id']), ['p1', 'p2'])
  const roles = rows.map(row => (find(row, 'bt-project-entry-role') ?? {}).children?.join(''))
  assert.deepEqual(roles, ['Member', 'Owner'])
  // A Project with no name reads by id, never blank.
  assert.equal(projectName({ id: 'x9' }), '#x9')
})

test('an empty list and an unreadable one say so instead of drawing nothing (#1828)', () => {
  assert.equal(textOf(find(ProjectList({ projects: [], error: '', note: '' }), 'bt-projects-empty')), 'No Projects yet')
  assert.equal(textOf(find(ProjectList({ projects: null, error: '', note: '' }), 'bt-projects-note')), 'Reading Projects…')
  assert.equal(textOf(find(ProjectList({ projects: [], error: 'No permission', note: '' }), 'bt-projects-note')), 'No permission')
})

test('a row opens its board by id, and the hash is the board entry point (#1828)', () => {
  const opened = []
  const view = ProjectList({ projects: [project()], error: '', note: '', onOpen: id => opened.push(id) })
  buttons(view)[0].props.onClick({})
  assert.deepEqual(opened, ['p1'])
  assert.equal(projectHash('p 1'), '#project=p%201')
})

test('the menu lists only switchable roles and marks the current one (#1828)', () => {
  // A Member sees only the rank they hold: nothing to pick.
  const member = plain(projectMenuItems(project()))
  assert.deepEqual(member, [{ role: 'member', label: 'Member', current: true, pick: false }])
  // An Owner cannot demote themselves, so the menu is the current item alone.
  assert.deepEqual(plain(projectMenuItems(project({ role: 'owner', choices: [] }))), [{ role: 'owner', label: 'Owner', current: true, pick: false }])
  // A Maintainer may drop to Member, and the current rank is not repeated.
  assert.deepEqual(plain(projectMenuItems(project({ role: 'maintainer', choices: ['member'] }))), [
    { role: 'maintainer', label: 'Maintainer', current: true, pick: false },
    { role: 'member', label: 'Member', current: false, pick: true },
  ])
  // A record written before roles existed carries none, and the menu does not invent owner-only.
  assert.deepEqual(plain(projectMenuItems({ id: 'old', role: null, choices: [] })), [])
  assert.equal(roleText(null), '')
})

test('the menu draws the current rank checked and disabled, and picking calls back (#1828)', () => {
  const picked = []
  const view = ProjectRoleMenu({
    project: project({ id: 'p3', role: 'maintainer', choices: ['member'], name: 'Beta' }),
    x: 10, y: 20, onPick: role => picked.push(role), onClose: () => {},
  })
  const items = (view.children ?? []).flat(Infinity).filter(child => child && child.type === 'button')
  assert.equal(items.length, 2)
  assert.equal(items[0].props['aria-checked'], 'true')
  assert.equal(items[0].props.disabled, true)
  assert.equal(items[1].props['aria-checked'], 'false')
  items[1].props.onClick()
  assert.deepEqual(picked, ['member'])
})

test('a refusal is quoted with the host reason, and a switch says so (#1828)', () => {
  assert.equal(roleNote({ changed: false, reason: 'last-owner' }), 'Role unchanged: last-owner')
  assert.equal(roleNote({ changed: false, reason: 'cannot-self-promote' }), 'Role unchanged: cannot-self-promote')
  assert.equal(roleNote({ changed: true }), 'Role changed.')
})

test('the sidebar row carries the expand arrow and reports its state (#1828)', () => {
  const row = ProjectsNav({ wide: true })
  const button = buttons(row)[0]
  assert.equal(button.props['aria-expanded'], 'false')
  assert.ok(find(row, 'bt-projects-chevron'), 'the expand arrow is drawn')
  assert.equal(textOf(find(row, 'bt-projects-label')), 'Projects')
})

// #1854: the sidebar sent `flybot/projects`, which the host has no endpoint for, so expanding the
// row always failed. These names are the ones `core/src/host/channel.js` dispatches, with no prefix.
test('the sidebar asks the host for `projects` and `project-role`, unprefixed (#1854)', async () => {
  hostCalls.length = 0
  sandbox.window.location.hash = ''
  const store = openPass()
  let view = draw(() => ProjectsNav({ wide: true }), store)
  buttons(view)[0].props.onClick() // expand the row
  view = draw(() => ProjectsNav({ wide: true }), store)
  await settle(store)
  view = draw(() => ProjectsNav({ wide: true }), store)

  assert.deepEqual(hostCalls.map(call => call.endpoint), ['projects'],
    'expanding the row reads the bare `projects` endpoint, not `flybot/projects`')

  const rows = buttons(find(view, 'bt-projects-list'))
  assert.equal(rows.length, 2, 'every Project the host listed is drawn under the row')
  assert.equal(textOf(find(rows[0], 'bt-project-entry-name')), 'FlyBot 开发', 'a row says the Project it opens')
  assert.equal(textOf(find(rows[0], 'bt-project-entry-role')), 'Owner', 'a row carries the role the caller holds there')

  rows[0].props.onClick({})
  assert.equal(sandbox.window.location.hash, '#project=p1', 'a row opens its board through the one hash the overlay reads')

  rows[1].props.onContextMenu({ preventDefault: () => {}, clientX: 4, clientY: 8 })
  view = draw(() => ProjectsNav({ wide: true }), store)
  const items = buttons(find(view, 'bt-project-menu'))
  assert.equal(items.length, 2, 'the right-click menu opens on the row')
  items[1].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))

  const switched = hostCalls.find(call => call.endpoint === 'project-role')
  assert.ok(switched, 'picking a rank sends `project-role`, not `flybot/project-role`')
  assert.deepEqual(plain(switched.payload), { id: 'p2', role: 'member' })
  for (const call of hostCalls) {
    assert.ok(!String(call.endpoint).startsWith('flybot/'), `the sidebar sent ${call.endpoint}, which the host cannot dispatch`)
  }
})
