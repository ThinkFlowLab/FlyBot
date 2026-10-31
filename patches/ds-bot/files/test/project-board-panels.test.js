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
const { ProjectBoardPane, ProjectSettingsPanel, ProjectMembersPanel, ProjectDossierPanel, ProjectAgentEntry, projectAgentFor, readProjectBoard, hostText, installLocale } = module.exports

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

async function startHost(t, state = seed()) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-panels-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
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

// #1845: the panel read `project.assistant.off`, a field the host never writes — the switch lives
// per owner on `owners[<ownerId>]`. A digest the owner paused therefore showed unticked, and one
// Save sent `off: false`, silently resuming it. The read now answers the caller's own record and a
// Save that changes nothing leaves the schedule alone.
const assistantSeed = () => {
  const state = seed()
  state.members['owner-2'] = { id: 'owner-2', createdAt: 1 }
  Object.assign(state.projects['project-1'], {
    ownerUserIds: ['owner-1', 'owner-2'],
    assistant: { botId: 'a', sessionId: 's1', createdAt: 1, scheduleId: 'digest-1', owners: {} },
  })
  return state
}
const checkboxOf = (tree) => all(tree).find(node => node.props?.['data-action'] === 'assistant-off')

test('the settings panel reads the caller own pause back, and a Save that changes nothing resumes no digest', async (t) => {
  resetSlots()
  const rt = await startHost(t, assistantSeed())
  const calls = []
  const watch = (runtime) => {
    const real = runtime.scheduleEndpoint
    runtime.scheduleEndpoint = async (endpoint, payload) => {
      calls.push(endpoint)
      return typeof real === 'function' ? real(endpoint, payload) : { tasks: [] }
    }
  }
  watch(rt)
  const as = (memberId) => ({ memberId })
  const call = (runtime, endpoint, payload, actor) => runtime.projectEndpoint(endpoint, payload, actor)
  // A mount is a fresh panel: real React starts one with no state, so the fake hook slots are
  // emptied first (#1843). A re-render of the instance that is already open keeps them.
  const propsFor = (assistantMine, actor, runtime) => ({ project: seed().projects['project-1'], assistantMine, call: (e, p) => call(runtime, e, p, actor), onClose() {} })
  const mount = (assistantMine, actor, runtime = rt) => { resetSlots(); return render(ProjectSettingsPanel, propsFor(assistantMine, actor, runtime)) }
  const redraw = (assistantMine, actor, runtime = rt) => () => render(ProjectSettingsPanel, propsFor(assistantMine, actor, runtime))

  // The owner pauses their own digest through the endpoint the panel writes through.
  const paused = await call(rt, 'project-assistant-owner', { id: 'project-1', settings: { off: true } }, as('owner-1'))
  assert.equal(paused.off, true)
  const scheduleCallCount = calls.length

  // Opened as the owner who paused it: the box is ticked, not the default unticked box that would
  // send `off: false` on the next Save.
  const mine = await call(rt, 'project-read', { id: 'project-1' }, as('owner-1'))
  assert.equal(mine.assistantMine?.off, true, 'the read answers the caller own record')
  assert.equal(checkboxOf(mount(mine.assistantMine, as('owner-1'))).props.checked, true)

  // The other owner has not paused anything: same Project, the box is unticked for them.
  const theirs = await call(rt, 'project-read', { id: 'project-1' }, as('owner-2'))
  assert.equal(theirs.assistantMine?.off, false, 'one owner never reads another owner switch')
  assert.equal(checkboxOf(mount(theirs.assistantMine, as('owner-2'))).props.checked, false)

  // Save without touching the row: the value stays true and nothing is resumed.
  byAction(mount(mine.assistantMine, as('owner-1')), 'project-assistant-save').props.onClick()
  assert.equal(await statusAfter(redraw(mine.assistantMine, as('owner-1')), 'Assistant settings saved.'), 'Assistant settings saved.')
  assert.equal(calls.length, scheduleCallCount, 'a Save that changes nothing sends no schedule-pause/schedule-resume')
  const kept = await call(rt, 'project-read', { id: 'project-1' }, as('owner-1'))
  assert.equal(kept.project.assistant.owners['owner-1'].off, true, 'and it leaves the paused value paused')
  assert.equal(kept.assistantMine.off, true)

  // Ticking the box the panel drew and saving writes the value, and a fresh read returns it: an
  // owner who never paused sees an empty box and a Save turns the digest off.
  const fresh = await startHost(t, assistantSeed())
  watch(fresh)
  const unset = await call(fresh, 'project-read', { id: 'project-1' }, as('owner-1'))
  assert.equal(unset.assistantMine?.off, false)
  const other = mount(unset.assistantMine, as('owner-1'), fresh)
  assert.equal(checkboxOf(other).props.checked, false)
  checkboxOf(other).props.onChange({ target: { checked: true } })
  byAction(redraw(unset.assistantMine, as('owner-1'), fresh)(), 'project-assistant-save').props.onClick()
  assert.equal(await statusAfter(redraw(unset.assistantMine, as('owner-1'), fresh), 'Assistant settings saved.'), 'Assistant settings saved.')
  const after = await call(fresh, 'project-read', { id: 'project-1' }, as('owner-1'))
  assert.equal(after.project.assistant.owners['owner-1'].off, true, 'the ticked box is written')
  assert.equal(after.assistantMine.off, true, 'and a fresh read returns what was written')
  assert.ok(after.assistantMine.quiet, 'the neighbour the panel does not draw is still read back')
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
    // #1887: an empty box no longer reaches the host, so the entry is one the panel allows; the
    // refusal below is the owner gate, which is what this half of the test is about.
    all(draw()).find(node => node.props?.id === 'bt-project-note').props.onChange({ target: { value: 'ship on Friday' } })
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

// #1847: the panel is not the only writer of a Project's memory. The endpoint used to store a
// blank entry and silently cut one over 600 characters, while the assistant writer refused both.
// The bound now lives at `appendProjectMemory`, the one door every writer goes through.
test('#1847: the memory write door refuses empty and over-long text and stores 600 exactly', async (t) => {
  const rt = await startHost(t)
  const call = (endpoint, payload) => rt.projectEndpoint(endpoint, payload)
  const before = (await call('project-read', { id: 'project-1' })).project

  await assert.rejects(() => call('project-memory-write', { id: 'project-1', kind: 'decision', text: '' }),
    error => error.code === 'bot/invalid' && error.message === 'A Project memory entry needs text')
  await assert.rejects(() => call('project-memory-write', { id: 'project-1', kind: 'decision', text: 'x'.repeat(601) }),
    error => error.code === 'bot/invalid' && error.message === 'A Project memory entry is at most 600 characters')

  let memory = (await call('project-memory', { id: 'project-1' })).memory
  assert.deepEqual(memory.decisions, [], 'a refused write leaves no entry behind')
  assert.deepEqual(memory.questions, [], 'and it does not land in the other list either')
  const after = (await call('project-read', { id: 'project-1' })).project
  assert.equal(after.updatedAt, before.updatedAt, 'a refused write does not touch the Project')

  const exact = 'x'.repeat(600)
  await call('project-memory-write', { id: 'project-1', kind: 'decision', text: exact })
  memory = (await call('project-memory', { id: 'project-1' })).memory
  assert.equal(memory.decisions.length, 1, 'the entry at the cap is accepted')
  assert.equal(memory.decisions[0].text.length, 600, 'and stored whole, not cut')
  assert.equal(memory.decisions[0].text, exact, 'the text is what was sent')
})

// The other half of #1847: the panel quotes the host's refusals in Chinese. Since #1887 the panel
// refuses an empty or over-long box before the click, so the one refusal still reachable is the two
// bounds disagreeing — an emoji entry the client counts as exactly 600 code points while a host
// that still counted UTF-16 units (#1886) answers "at most 600 characters". The reader must see
// why Save did nothing, never a success line, and no row may land.
test('#1847: the panel shows the Chinese refusal when the host refuses the memory text', async (t) => {
  resetSlots()
  const rt = await startHost(t)
  const call = (endpoint, payload) => rt.projectEndpoint(endpoint, payload)
  const off = installLocale(fakeLocale('zh'))
  try {
    const draw = () => render(ProjectSettingsPanel, { project: project(), call, onClose() {} })
    all(draw()).find(node => node.props?.id === 'bt-project-note').props.onChange({ target: { value: '🙂'.repeat(600) } })
    const refused = Object.assign(new Error('A Project memory entry is at most 600 characters'), { code: 'bot/invalid' })
    const racing = () => render(ProjectSettingsPanel, { project: project(), call: async () => { throw refused }, onClose() {} })
    assert.ok(!byAction(racing(), 'project-memory-save').props.disabled, 'the client counts the entry at the bound and lets the click through')
    byAction(racing(), 'project-memory-save').props.onClick()
    assert.equal(await statusAfter(racing, '项目记忆条目最多 600 个字符'), '项目记忆条目最多 600 个字符')
    assert.ok(!drawnStatus(racing).includes('记忆已保存。'), 'a refusal is never painted as a success')
    assert.equal(hostText('A Project memory entry needs text'), '项目记忆条目需要文字', 'the empty-text refusal is translated too, for a host that refuses it')

    const memory = (await call('project-memory', { id: 'project-1' })).memory
    assert.deepEqual(memory.decisions, [], 'the refusal adds no row')
  } finally {
    off()
  }
})

// #1886: the bound was compared against `String#length`, which counts UTF-16 code units, so a 350
// character emoji note — 700 units — was refused as "over 600 characters" even though the sentence
// counts characters. The bound now counts code points, the unit the repo already uses for a
// message's own length (`chat-index.js`, `busy-ack.js`).
test('#1886: the memory bound counts code points, so an emoji note keeps its full 600 characters', async (t) => {
  const rt = await startHost(t)
  const call = (endpoint, payload) => rt.projectEndpoint(endpoint, payload)
  const write = text => call('project-memory-write', { id: 'project-1', kind: 'decision', text })
  const kept = async () => (await call('project-memory', { id: 'project-1' })).memory.decisions

  assert.equal([...'😀'].length, 1, 'one emoji is one code point')
  assert.equal('😀'.length, 2, 'and two UTF-16 units, which is what the bound used to count')

  // The user-visible case: 350 characters is well short of 600, and 350 emoji are 700 units.
  const short = '😀'.repeat(350)
  await write(short)
  let rows = await kept()
  assert.equal(rows.length, 1, 'a 350-character emoji note is accepted')
  assert.equal(rows[0].text, short, 'and stored whole, not cut')

  // The cap is 600 code points: accepted, and 601 refused in the sentence the panel quotes.
  const exact = '😀'.repeat(600)
  await write(exact)
  rows = await kept()
  assert.deepEqual(rows.map(entry => entry.text), [short, exact], 'the entry at the cap is accepted')
  await assert.rejects(() => write('😀'.repeat(601)),
    error => error.code === 'bot/invalid' && error.message === 'A Project memory entry is at most 600 characters')
  rows = await kept()
  assert.equal(rows.length, 2, 'the refusal leaves no row behind')

  // ASCII was already counted right; the new unit must leave it exactly as it was.
  const ascii = 'x'.repeat(600)
  await write(ascii)
  rows = await kept()
  assert.equal(rows.length, 3, 'an ASCII entry at the cap is still accepted')
  assert.equal(rows[2].text, ascii, 'and still stored whole')
  await assert.rejects(() => write('x'.repeat(601)),
    error => error.code === 'bot/invalid' && error.message === 'A Project memory entry is at most 600 characters')
  rows = await kept()
  assert.equal(rows.length, 3, 'and ASCII over the cap still leaves nothing behind')
})

test("the settings panel shows the host's refusal instead of pretending the save landed", async () => {
  resetSlots()
  const refused = Object.assign(new Error('Only the owner of this Project may change it'), { code: 'bot/forbidden' })
  const save = async () => { throw refused }
  const draw = () => render(ProjectSettingsPanel, { project: { id: 'project-1' }, call: save, onClose() {} })
  // #1887: the box needs an entry the panel allows, or Save is disabled and no host refusal is asked.
  all(draw()).find(node => node.props?.id === 'bt-project-note').props.onChange({ target: { value: 'ship on Friday' } })
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

// #1864: the dossier. The board's team block now carries a Dossier control on every row, the panel
// draws Persona / Memory / Skills from the one `project-team` answer, and the owner's own chat
// header has an entry that opens the Project assistant's Session.
const dossier = () => ({
  botId: 'bot-chief', name: 'Project Chief (FlyBot)', role: 'Project Chief',
  persona: 'You are the Project Chief of FlyBot.', model: 'deepseek-chat', color: '#112233', createdAt: 1,
  memory: { head: 'The Chief remembers the Project.', topics: ['travel', 'work'] },
  skills: ['ship-it'], rooms: [{ id: 'r1', name: 'FlyBot dev' }],
})

const projectRecord = () => ({
  id: 'project-1', name: 'FlyBot', ownerUserId: 'owner-1',
  chief: { botId: 'bot-chief', sessionId: 'bot-chief', createdAt: 1 },
  assistant: { botId: 'bot-assistant', sessionId: 'bot-assistant', createdAt: 1 },
  roles: { maintainers: ['bot-dev'], members: [] },
})

const boardAnswer = () => ({ tasks: [], done: [], decisions: {}, meetings: {}, waiting: [], inflight: [], blocked: [], counts: null, metrics: null })

test('the board reads the dossier from exactly one project-team call', async () => {
  resetSlots()
  const calls = []
  const read = async (endpoint) => {
    calls.push(endpoint)
    if (endpoint === 'projects') return { projects: [{ id: 'project-1', name: 'FlyBot', role: 'owner', choices: [] }] }
    if (endpoint === 'project-read') return { project: projectRecord(), canManage: true }
    if (endpoint === 'project-board') return boardAnswer()
    if (endpoint === 'tasks') return []
    if (endpoint === 'project-team') return { rows: [dossier(), null, { ...dossier(), botId: 'bot-dev', name: 'Dev' }] }
    throw new Error(`unexpected endpoint ${endpoint}`)
  }
  const state = await readProjectBoard(read, 'project-1')
  assert.equal(calls.filter(endpoint => endpoint === 'project-team').length, 1, 'one call feeds the whole dossier')
  assert.equal(state.team.rows.length, 3, 'the null row survives the read so the panel can stay empty')
  assert.equal(state.team.rows[0].botId, 'bot-chief')

  const tree = render(ProjectBoardPane, { project: state.project, rows: state.rows, team: state.team, canManage: true })
  const chief = all(tree).find(node => node.props?.['data-dossier-bot'] === 'bot-chief')
  assert.ok(chief, 'the Chief row carries the dossier control')
  const opened = []
  const drawn = render(ProjectBoardPane, { project: state.project, rows: state.rows, team: state.team, canManage: true, onOpenDossier: value => opened.push(value) })
  const control = all(drawn).find(node => node.props?.['data-dossier-bot'] === 'bot-chief')
  control.props.onClick()
  assert.deepEqual(opened.map(entry => entry.botId), ['bot-chief'])
})

test('the dossier panel draws Persona, Memory and Skills, and stays empty for a null row', () => {
  resetSlots()
  const drawn = text(render(ProjectDossierPanel, { row: dossier(), label: 'Project Chief' }))
  assert.match(drawn, /Persona/, 'the Persona section is drawn')
  assert.match(drawn, /Project Chief of FlyBot/, 'the persona text is the host answer')
  assert.match(drawn, /deepseek-chat/, 'the model is shown with the persona')
  assert.match(drawn, /Memory/, 'the Memory section is drawn')
  assert.match(drawn, /The Chief remembers the Project\./, 'the memory head is shown')
  assert.match(drawn, /travel/, 'the topic names are listed')
  assert.match(drawn, /Skills/, 'the Skills section is drawn')
  assert.match(drawn, /ship-it/, 'the attached skill is listed')

  const empty = text(render(ProjectDossierPanel, { row: null, label: 'Project Chief' }))
  assert.match(empty, /Not set/, 'an unset Bot reads "not set"')
  assert.doesNotMatch(empty, /deepseek-chat/, 'and the panel draws no invented persona')
})

test('the owner\'s chat entry opens the Project assistant, and only the owner\'s own Bot offers it', async () => {
  resetSlots()
  const calls = []
  const opened = []
  const read = async (endpoint, payload) => {
    calls.push({ endpoint, payload })
    return { project: { assistant: { botId: 'bot-assistant' } } }
  }
  let tree = render(ProjectAgentEntry, { projectId: 'project-1', read, onOpen: id => opened.push(id) })
  const entry = all(tree).find(node => node.props?.['data-project-agent'] === 'project-1')
  entry.props.onClick()
  await waitFor(() => (opened.length > 0 ? true : undefined))
  assert.deepEqual(opened, ['bot-assistant'], 'the entry opens the assistant Session')
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ endpoint: 'project-read', payload: { id: 'project-1' } }], 'one project-read answers the assistant id')
  tree = render(ProjectAgentEntry, { projectId: 'project-1', read, onOpen: id => opened.push(id) })
  assert.equal(all(tree).find(node => node.props?.['data-open-bot']).props['data-open-bot'], 'bot-assistant', 'the resolved entry names the Bot it opens')

  assert.deepEqual(JSON.parse(JSON.stringify(projectAgentFor({ projectId: 'project-1', ownerId: 'owner-1' }, 'owner-1'))), { projectId: 'project-1' })
  assert.equal(projectAgentFor({ projectId: 'project-1', ownerId: 'other' }, 'owner-1'), null, "another owner's Bot offers no entry")
  assert.equal(projectAgentFor({ ownerId: 'owner-1' }, 'owner-1'), null, 'a Bot outside a Project offers no entry')
  assert.equal(projectAgentFor({ projectId: 'project-1', ownerId: 'owner-1', remote: {} }, 'owner-1'), null, "a friend's Bot offers no entry")
})

// #1887: the memory box warns before the click. The field had no counter and Save stayed enabled
// with nothing typed, so the first news of the 600 bound was the host's refusal after the click
// (#1847 already refuses at the door — the defect is the silence before it, not a blank entry
// landing). The counter counts code points, the unit the host bounds (#1886), so an emoji entry at
// the bound is not refused for what `maxLength` would have counted as twice as many UTF-16 units.
const memoryCount = (tree) => all(tree).find(node => node.props?.['data-role'] === 'project-memory-count')
const memorySave = (tree) => byAction(tree, 'project-memory-save')

test('#1887: the memory box counts code points and disables Save before the click', async (t) => {
  resetSlots()
  const rt = await startHost(t)
  let calls = 0
  const call = (endpoint, payload) => { calls += 1; return rt.projectEndpoint(endpoint, payload) }
  const draw = () => render(ProjectSettingsPanel, { project: project(), call, onClose() {} })
  const type = (value) => {
    all(draw()).find(node => node.props?.id === 'bt-project-note').props.onChange({ target: { value } })
    return draw()
  }

  // Empty: there is nothing to save, and the reader is told before pressing anything.
  let tree = type('')
  assert.equal(memorySave(tree).props.disabled, true, 'an empty memory box disables Save')
  assert.equal(text(memoryCount(tree)), '0/600', 'the counter reads the empty box')
  memorySave(tree).props.onClick()
  await settle()

  // Whitespace is not an entry either: the host refuses it as no text, so the button agrees.
  tree = type('  \n ')
  assert.equal(memorySave(tree).props.disabled, true, 'a whitespace-only memory box disables Save')

  // One past the bound: the counter says so and Save is disabled before the click.
  const emoji = '🙂'
  tree = type(emoji.repeat(601))
  assert.equal(text(memoryCount(tree)), '601/600', 'the counter counts code points, not UTF-16 units')
  assert.equal(memoryCount(tree).props['data-over'], 'true', 'the counter is in its over-limit state')
  assert.equal(memorySave(tree).props.disabled, true, 'an over-long entry disables Save')
  memorySave(tree).props.onClick()
  await settle()

  // The bound itself is an entry: Save is enabled and the counter reads it whole.
  tree = type(emoji.repeat(600))
  assert.equal(text(memoryCount(tree)), '600/600', 'an entry at the bound reads the bound')
  assert.equal(memoryCount(tree).props['data-over'], 'false', 'and the counter is not in its over-limit state')
  assert.ok(!memorySave(tree).props.disabled, 'the bound itself is allowed')

  assert.equal(calls, 0, 'neither a disabled nor an over-limit Save calls the endpoint')
  const memory = (await rt.projectEndpoint('project-memory', { id: 'project-1' })).memory
  assert.deepEqual(memory.decisions, [], 'and neither state writes anything')
})
