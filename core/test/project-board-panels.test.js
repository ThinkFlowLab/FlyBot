// Project board's two management buttons (#1749). The board drew "Project settings" and "Members"
// with no handler at all, so clicking either only moved focus. These pin the three surfaces a
// reader now gets: each button opens its panel, the settings panel saves only through the write
// paths the host already has, and the members panel lists who the record and the board name.
//
// The memory save goes through `rt.projectEndpoint` (#1820): the panel used to send a kind the host
// does not know, and a stub that only recorded the payload kept that wrong call green.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// The entry carries the dictionary beside the panels: `t` and `hostText` reach the panel only
// through the same copy of `i18n.js`, and that is true inside one bundle and nowhere else.
const bundle = await build({
  stdin: {
    contents: "export * from './src/client/project-board.js'\nexport { DICTIONARY, hostText, installLocale } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    sourcefile: 'project-board-panels-entry.js',
    loader: 'js',
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})
// A hook runtime: every panel is a plain function, so a slot array that survives a re-render is
// enough to type into a field, press a button, and read the tree it draws next. It survives one
// test only — `resetSlots` empties it before each one, so what a test clicks can never be the value
// the next test reads (#1843).
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
const { ProjectBoardPane, ProjectSettingsPanel, ProjectMembersPanel, hostText, installLocale } = module.exports

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
// #1843: a fixed number of ticks is not a wait. The host answers asynchronously and, on a loaded
// runner, ten ticks is not enough — the assertion then reads the line the previous test left in the
// slots. Poll for the drawn state instead, bounded so a real regression fails on the value it reads
// and never hangs (the same primitive as `retired-bot-paths.test.js`, kept local on purpose).
const settle = () => new Promise(resolve => setTimeout(resolve, 25))
const waitFor = async (check) => {
  for (let at = 0; at < 100; at += 1) {
    const value = check()
    if (value !== undefined) return value
    await settle()
  }
  return undefined
}
const resetSlots = () => { slots = []; index = 0 }
const drawnStatus = (draw) => text(all(draw()).find(node => node.props?.role === 'status'))
// Draw the panel until its status reads `expected`, then read it once more: the assertion keeps a
// stale line as the actual value instead of reporting a bare timeout.
const statusAfter = async (draw, expected) => {
  await waitFor(() => (drawnStatus(draw) === expected ? true : undefined))
  return drawnStatus(draw)
}

// The seeded Project is all the panel needs: the endpoint it calls is the app's own, and neither an
// assistant Session nor a scheduled digest is part of the write.
const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' } },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  projects: {
    'project-1': { id: 'project-1', name: 'FlyBot', repository: null, defaultBranch: 'main', ownerUserId: 'owner-1', createdAt: 1, updatedAt: 1, status: 'active' },
  },
})
const project = () => seed().projects['project-1']

async function startHost(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-panels-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) agents.set(sessionId, { session: { id: sessionId }, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } })
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async () => ({ id: 'w1' }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return rt
}

// The dictionary the client binds through `installLocale`: `hostText` reads the active language from
// the same service, so a refusal the panel quotes can be checked as the reader sees it.
function fakeLocale(active) {
  const dicts = new Map()
  return {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = (active === 'zh' ? dicts.get(`${ns}:zh`)?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active }),
  }
}

const rows = [{ id: 'task-1', source: 'bot', column: 'in-progress', assignee: 'Dev4' }]

test('both management buttons open their panel, owner or not', () => {
  resetSlots()
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

test('the settings panel saves through project-bind and project-assistant-owner', async () => {
  resetSlots()
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
})

// The memory save is checked against the host, not against the payload the panel thinks it sent —
// the old `kind: 'note'` was refused by `project-memory-write` and this test stayed green.
test('the settings panel memory save lands in the Project memory through the real endpoint', async (t) => {
  resetSlots()
  const rt = await startHost(t)
  const call = (endpoint, payload) => rt.projectEndpoint(endpoint, payload)
  const draw = () => render(ProjectSettingsPanel, { project: project(), call, onClose() {} })
  let tree = draw()
  const note = all(tree).find(node => node.props?.id === 'bt-project-note')
  note.props.onChange({ target: { value: 'ship on Friday' } })
  tree = draw()
  byAction(tree, 'project-memory-save').props.onClick()
  assert.equal(await statusAfter(draw, 'Memory saved.'), 'Memory saved.', 'the panel reports the state the host answered')
  const memory = (await rt.projectEndpoint('project-memory', { id: 'project-1' })).memory
  assert.deepEqual(memory.decisions.map(entry => entry.text), ['ship on Friday'], 'the text typed into the panel is in the Project memory')

  // The success line is localized as well: the same panel under a zh locale says so in Chinese.
  const off = installLocale(fakeLocale('zh'))
  try {
    tree = draw()
    byAction(tree, 'project-memory-save').props.onClick()
    assert.equal(await statusAfter(draw, '记忆已保存。'), '记忆已保存。')
  } finally {
    off()
  }
})

// The other half: a kind the host does not know is refused and writes nothing, the two kinds it
// does know land, and a refusal reaches the reader in the interface language.
test('a memory kind the host does not know writes nothing, and the panel quotes a refusal in Chinese', async (t) => {
  resetSlots()
  const rt = await startHost(t)
  await assert.rejects(() => rt.projectEndpoint('project-memory-write', { id: 'project-1', kind: 'note', text: 'ship on Friday' }),
    error => error.code === 'bot/invalid' && /Unknown Project memory kind note/.test(error.message))
  let memory = (await rt.projectEndpoint('project-memory', { id: 'project-1' })).memory
  assert.deepEqual(memory.decisions, [], 'a refused write leaves no entry behind')
  assert.deepEqual(memory.questions, [], 'and it does not land in the other list either')
  await rt.projectEndpoint('project-memory-write', { id: 'project-1', kind: 'decision', text: 'ship on Friday' })
  memory = (await rt.projectEndpoint('project-memory', { id: 'project-1' })).memory
  assert.deepEqual(memory.decisions.map(entry => entry.text), ['ship on Friday'], 'the kind the panel now sends is one the host accepts')

  const off = installLocale(fakeLocale('zh'))
  try {
    const refused = async () => { throw Object.assign(new Error('Only the owner of this Project may change it'), { code: 'bot/forbidden' }) }
    const draw = () => render(ProjectSettingsPanel, { project: project(), call: refused, onClose() {} })
    let tree = draw()
    byAction(tree, 'project-memory-save').props.onClick()
    assert.equal(await statusAfter(draw, '只有这个项目的主人可以修改'), '只有这个项目的主人可以修改')
    // Only the refusals this panel's three write paths can reach are translated (#1820): the owner
    // gate, an empty member id, and a stale Project id. The one-token id rule leaves a longer
    // sentence as the host wrote it instead of half-translating it.
    assert.equal(hostText('A binding needs the member id'), '绑定需要 member id')
    assert.equal(hostText('Unknown Project project-1'), '找不到项目 project-1')
    assert.equal(hostText('Unknown Project status active'), 'Unknown Project status active')
  } finally {
    off()
  }
})

test("the settings panel shows the host's refusal instead of pretending the save landed", async () => {
  resetSlots()
  const refused = Object.assign(new Error('Only the owner of this Project may change it'), { code: 'bot/forbidden' })
  const save = async () => { throw refused }
  const draw = () => render(ProjectSettingsPanel, { project: { id: 'project-1' }, call: save, onClose() {} })
  const tree = draw()
  byAction(tree, 'project-memory-save').props.onClick()
  await waitFor(() => (/Only the owner of this Project/.test(drawnStatus(draw)) ? true : undefined))
  assert.match(drawnStatus(draw), /Only the owner of this Project/)
})

test('the members panel lists the owners, the Project Chief and the members the board names, and offers no write', () => {
  resetSlots()
  const tree = render(ProjectMembersPanel, {
    project: { id: 'project-1', ownerUserId: 'owner-1', ownerUserIds: ['owner-1', 'owner-2'], chief: { botId: 'bot-chief', sessionId: 's-chief', createdAt: 1 } },
    rows, onClose() {},
  })
  const members = all(tree).filter(node => node.props?.['data-member-role'] !== undefined)
  assert.deepEqual(members.map(node => node.props['data-member-id']), ['owner-1', 'owner-2', 'bot-chief', 'Dev4'])
  assert.deepEqual(members.map(node => node.props['data-member-role']), ['owner', 'owner', 'chief', 'board'])
  assert.equal(byAction(tree, 'project-bind'), undefined, 'membership management is a later slice, not a dead button here')
})

// #1860: the Project team block. The board draws who runs the Project (its own Chief, #1859), the
// assistant that speaks for the caller (#1712) and the role pool (#1828), and each Bot row opens
// that chat from the board. A record written before `chief` landed keeps the row and reads "not set"
// instead of hiding it, so the two slices never have to merge together.
const team = () => ({
  id: 'project-1', name: 'FlyBot', ownerUserId: 'owner-1',
  chief: { botId: 'bot-chief', sessionId: 's-chief', createdAt: 1 },
  assistant: { botId: 'bot-assistant', sessionId: 's-assistant', createdAt: 1 },
  roles: { maintainers: ['bot-maint'], members: ['bot-member'] },
  role: 'maintainer', choices: ['member'],
})
const teamRow = (tree, role) => all(tree).find(node => node.props?.['data-team-role'] === role)

test('the Project team block draws the Chief, my agent and the pool, and opens a chat', () => {
  resetSlots()
  const opened = []
  const tree = render(ProjectBoardPane, { project: team(), rows, canManage: false, onOpenBot: id => opened.push(id) })
  const lines = all(tree).filter(node => node.props?.['data-team-role'] !== undefined)
  assert.deepEqual(lines.map(node => node.props['data-team-role']), ['chief', 'agent', 'pool'], 'the block draws exactly the three rows, in that order')
  assert.equal(teamRow(tree, 'chief').props['data-open-bot'], 'bot-chief', 'the Chief row opens the Project Chief')
  assert.equal(teamRow(tree, 'agent').props['data-open-bot'], 'bot-assistant', 'my agent opens the assistant Bot')
  teamRow(tree, 'chief').props.onClick()
  teamRow(tree, 'agent').props.onClick()
  assert.deepEqual(opened, ['bot-chief', 'bot-assistant'], 'each Bot row opens that chat from the board')
  const pool = text(teamRow(tree, 'pool'))
  assert.match(pool, /bot-maint/, 'the pool lists the maintainers the record stores')
  assert.match(pool, /bot-member/, 'and the members')
  assert.match(pool, /Maintainer/, "and the caller's own rank beside them")
})

test('a Project with no Chief keeps the row and reads "not set"', () => {
  resetSlots()
  const opened = []
  const bare = { id: 'project-1', name: 'FlyBot', ownerUserId: 'owner-1', assistant: { botId: 'bot-assistant' } }
  const tree = render(ProjectBoardPane, { project: bare, rows, canManage: false, onOpenBot: id => opened.push(id) })
  const chief = teamRow(tree, 'chief')
  assert.ok(chief, 'the Chief row is drawn even when the record carries no Chief')
  assert.equal(chief.props['data-team-state'], 'not-set')
  assert.equal(chief.props['data-open-bot'], undefined, 'a row with no Bot opens nothing')
  assert.match(text(chief), /Not set/)
  // A `chief` that carries the host's refusal reads the same way: the row stays, nothing opens.
  const failed = { id: 'project-1', name: 'FlyBot', chief: { error: 'this host has no Project Chief seam, so no Chief was created' } }
  const drawn = teamRow(render(ProjectBoardPane, { project: failed, rows, onOpenBot: id => opened.push(id) }), 'chief')
  assert.equal(drawn.props['data-team-state'], 'not-set')
  assert.match(text(drawn), /Not set/)
  assert.deepEqual(opened, [])
})
