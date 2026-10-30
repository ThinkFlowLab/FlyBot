// Projects (#1691): the durable Project record and the binding a group, Bot or workflow run can
// name. One Project holds many members; a member holds at most one Project; an unbound member
// resolves `null`, so an install with no Projects behaves exactly as it did before.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const hashToken = token => createHash('sha256').update(token).digest('hex')

// #1710: a second member and two signed-in sessions, so an owner and a non-owner caller both
// exist without a second process.
const seed = (sessions = true) => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'owner-2': { id: 'owner-2', createdAt: 2, designatedChiefId: null },
  },
  ...(sessions
    ? {
        authSessions: {
          's-a': { id: 's-a', memberId: 'owner-1', tokenHash: hashToken('tok-a'), createdAt: 1 },
          's-b': { id: 's-b', memberId: 'owner-2', tokenHash: hashToken('tok-b'), createdAt: 2 },
        },
      }
    : {}),
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2, ownerId: 'owner-1' },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'a', named: true, sessions: {}, log: [], seq: 0, seen: {} } },
  agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
})

async function start(home = mkdtempSync(join(tmpdir(), 'ds-bot-projects-')), { sessions = true } = {}) {
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed(sessions)))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) agents.set(sessionId, { session: { id: sessionId }, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } })
    return agents.get(sessionId)
  }
  let route
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  apply(ctx, { home })
  const call = async (endpoint, payload, token = 'tok-a') => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST',
    headers: token ? { 'x-flybot-member-session': token } : {},
    body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async ({ keepHome = false } = {}) => {
    await ctx.dispose()
    if (!keepHome) rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, stop, home }
}

const value = (response) => {
  assert.equal(response.ok, true, JSON.stringify(response))
  return response.value
}
const created = (response) => value(response).project

test('create, read and list a Project', async () => {
  const { call, stop } = await start()
  try {
    const empty = await call('projects', {})
    assert.deepEqual(value(empty).projects, [])

    const project = created(await call('project-create', { name: 'FlyBot', repository: 'ThinkFlowLab/FlyBot', defaultBranch: 'main', ownerUserId: 'owner-1' }))
    assert.match(project.id, /^project-/)
    assert.equal(project.name, 'FlyBot')
    assert.equal(project.repository, 'ThinkFlowLab/FlyBot')
    assert.equal(project.defaultBranch, 'main')
    assert.equal(project.ownerUserId, 'owner-1')
    assert.equal(project.status, 'active')
    assert.equal(typeof project.createdAt, 'number')
    assert.equal(project.createdAt, project.updatedAt)

    assert.deepEqual(created(await call('project-read', { id: project.id })), project)
    const list = await call('projects', {})
    assert.deepEqual(value(list).projects.map(item => item.id), [project.id])
    assert.equal(value(await call('project-read', { id: 'project-missing' })).project, null)
  } finally { await stop() }
})

test('two Projects do not alias', async () => {
  const { call, stop } = await start()
  try {
    const one = created(await call('project-create', { name: 'One', repository: 'acme/one' }))
    const two = created(await call('project-create', { name: 'Two', repository: 'acme/two' }))
    assert.notEqual(one.id, two.id)
    assert.equal(value(await call('project-read', { id: one.id })).project.repository, 'acme/one')
    assert.equal(value(await call('project-read', { id: two.id })).project.repository, 'acme/two')
    assert.deepEqual(value(await call('projects', {})).projects.map(item => item.name).sort(), ['One', 'Two'])
  } finally { await stop() }
})

test('a group, a Bot and a run bind to one Project, and unbind to null', async () => {
  const { call, stop } = await start()
  try {
    const project = created(await call('project-create', { name: 'FlyBot', repository: 'ThinkFlowLab/FlyBot' }))
    assert.equal(value(await call('project-of', { kind: 'bot', id: 'a' })).project, null, 'an unbound Bot reports null')
    assert.equal(value(await call('project-of', { kind: 'group', id: 'r1' })).project, null, 'an unbound group reports null')
    assert.equal(value(await call('project-of', { kind: 'run', id: 'run-1' })).project, null, 'an unbound run reports null')

    for (const binding of [{ kind: 'bot', id: 'a' }, { kind: 'group', id: 'r1' }, { kind: 'run', id: 'run-1' }]) {
      assert.equal(created(await call('project-bind', { ...binding, projectId: project.id })).id, project.id)
      assert.deepEqual(value(await call('project-of', binding)).project.id, project.id)
    }
    // One Project holds many members: a second Bot binds to the same record.
    assert.equal(created(await call('project-bind', { kind: 'bot', id: 'b', projectId: project.id })).id, project.id)
    assert.deepEqual(value(await call('projects', {})).projects.map(item => item.id), [project.id])

    const unbound = await call('project-bind', { kind: 'bot', id: 'a', projectId: null })
    assert.equal(unbound.ok, true)
    assert.equal(value(unbound).project, null)
    assert.equal(value(await call('project-of', { kind: 'bot', id: 'a' })).project, null)

    const refused = await call('project-bind', { kind: 'bot', id: 'a', projectId: 'project-missing' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'bot/not-found')
    assert.equal((await call('project-create', { repository: 'no-slash' })).ok, false)
  } finally { await stop() }
})

test('the record and its bindings survive a store re-open', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-projects-reopen-'))
  let first
  try {
    first = await start(home)
    const project = created(await first.call('project-create', { name: 'Durable', repository: 'acme/durable' }))
    await first.call('project-bind', { kind: 'group', id: 'r1', projectId: project.id })
    await first.call('project-bind', { kind: 'bot', id: 'b', projectId: project.id })
    await first.call('project-bind', { kind: 'run', id: 'run-2', projectId: project.id })
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(saved.projects[project.id].name, 'Durable')
    await first.stop({ keepHome: true })

    const second = await start(home)
    try {
      assert.equal(created(await second.call('project-read', { id: project.id })).repository, 'acme/durable')
      assert.equal(value(await second.call('project-of', { kind: 'group', id: 'r1' })).project.id, project.id)
      assert.equal(value(await second.call('project-of', { kind: 'bot', id: 'b' })).project.id, project.id)
      assert.equal(value(await second.call('project-of', { kind: 'run', id: 'run-2' })).project.id, project.id)
    } finally { await second.stop({ keepHome: true }) }
  } finally {
    await first?.stop({ keepHome: true }).catch(() => {})
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
})

// #1704: the id tables are plain objects, so `state.projects['__proto__']` and
// `state.bots['__proto__']` answered `Object.prototype` (which `isRecord` accepts). An id that
// is not an own key must resolve as absent, and no request may write `Object.prototype`.
test('an id that is not an own key resolves as absent and never writes Object.prototype (#1704)', async () => {
  const { call, stop, home } = await start()
  try {
    const project = created(await call('project-create', { name: 'FlyBot', repository: 'ThinkFlowLab/FlyBot' }))
    const protoRead = await call('project-read', { id: '__proto__' })
    const protoBind = await call('project-bind', { kind: 'bot', id: '__proto__', projectId: project.id })
    const protoOf = await call('project-of', { kind: 'bot', id: '__proto__' })
    const unboundBot = await call('project-of', { kind: 'bot', id: 'b' })
    const unboundGroup = await call('project-of', { kind: 'group', id: 'r1' })
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    const observed = JSON.stringify({
      'project-read __proto__': protoRead.value?.project ?? protoRead,
      'project-bind __proto__': protoBind,
      'project-of bot __proto__': protoOf.value?.project ?? protoOf,
      'project-of unbound bot b': unboundBot.value?.project ?? unboundBot,
      'project-of unbound group r1': unboundGroup.value?.project ?? unboundGroup,
      'Object.prototype has own projectId': Object.hasOwn(Object.prototype, 'projectId'),
      '({}).projectId': ({}).projectId ?? null,
      'state.json bots.b has own projectId': Object.hasOwn(saved.bots.b, 'projectId'),
    })
    // #1710: project-read also answers canManage; an absent Project is never manageable.
    assert.deepEqual(protoRead.value, { project: null, canManage: false }, observed)
    assert.equal(protoBind.ok, false, observed)
    assert.equal(protoBind.error?.code, 'bot/not-found', observed)
    assert.deepEqual(protoOf.value, { project: null }, observed)
    assert.deepEqual(unboundBot.value, { project: null }, observed)
    assert.deepEqual(unboundGroup.value, { project: null }, observed)
    assert.equal(Object.hasOwn(Object.prototype, 'projectId'), false, observed)
    assert.equal(({}).projectId, undefined, observed)
    assert.equal(Object.hasOwn(saved.bots.b, 'projectId'), false, observed)
  } finally { await stop() }
})

// #1704, the run half (#1708): a run's binding lives in `state.projectRuns`, a plain object, so
// `state.projectRuns['__proto__'] = id` was taken by the `__proto__` setter: the request answered
// `ok: true` and nothing was stored, and `project-of {kind:'run'}` kept answering null. The write
// now defines an own key, which is what the assertions below read; a plain assignment (or
// `Reflect.set`) fails them even though the response still says ok.
test('a run binds under an own key, not through the prototype chain (#1704)', async () => {
  const { call, stop, home } = await start()
  try {
    const project = created(await call('project-create', { name: 'FlyBot', repository: 'ThinkFlowLab/FlyBot' }))
    const bound = await call('project-bind', { kind: 'run', id: '__proto__', projectId: project.id })
    const of = await call('project-of', { kind: 'run', id: '__proto__' })
    const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    const observed = JSON.stringify({
      'project-bind run __proto__': bound,
      'project-of run __proto__': of,
      'state.projectRuns own __proto__': Object.hasOwn(saved.projectRuns, '__proto__'),
      'state.projectRuns __proto__': saved.projectRuns['__proto__'] ?? null,
      'state.projectRuns prototype is Object.prototype': Object.getPrototypeOf(saved.projectRuns) === Object.prototype,
      'Object.prototype has own projectId': Object.hasOwn(Object.prototype, 'projectId'),
      "'projectId' in {}": 'projectId' in {},
    })
    assert.equal(bound.ok, true, observed)
    assert.equal(Object.hasOwn(saved.projectRuns, '__proto__'), true, observed)
    assert.equal(saved.projectRuns['__proto__'], project.id, observed)
    assert.equal(Object.getPrototypeOf(saved.projectRuns), Object.prototype, observed)
    assert.equal(Object.hasOwn(Object.prototype, 'projectId'), false, observed)
    assert.equal('projectId' in {}, false, observed)
    assert.equal(value(of).project?.id, project.id, observed)
  } finally { await stop() }
})

// #1710: the owner of a Project may manage it, a member reads the same board read-only, and the
// refusal comes from the host action — not from a control the page happens to hide.
test('the caller becomes the owner, and only the owner may change the Project', async () => {
  const { call, stop } = await start()
  try {
    const project = created(await call('project-create', { name: 'Owned', repository: 'acme/owned', ownerUserId: 'owner-2' }, 'tok-a'))
    assert.equal(project.ownerUserId, 'owner-1', 'the caller is stamped as the owner, not the body')

    assert.equal(value(await call('project-read', { id: project.id }, 'tok-a')).canManage, true)
    assert.equal(value(await call('project-read', { id: project.id }, 'tok-b')).canManage, false)

    const refused = await call('project-bind', { kind: 'bot', id: 'a', projectId: project.id }, 'tok-b')
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'bot/forbidden')
    assert.equal(value(await call('project-of', { kind: 'bot', id: 'a' })).project, null, 'the refusal wrote nothing')

    assert.equal(created(await call('project-bind', { kind: 'bot', id: 'a', projectId: project.id }, 'tok-a')).id, project.id)
  } finally { await stop() }
})

test('an install with no signed-in session falls back to its first member as the owner', async () => {
  const { call, stop } = await start(undefined, { sessions: false })
  try {
    const project = created(await call('project-create', { name: 'Solo', repository: 'acme/solo' }))
    assert.equal(project.ownerUserId, 'owner-1', 'the single-member install stamps its member')
    assert.equal(value(await call('project-read', { id: project.id })).canManage, true)
  } finally { await stop() }
})

test('a signed-in member may read the Project board even though it may not manage it', async () => {
  const { call, stop } = await start()
  try {
    const project = created(await call('project-create', { name: 'Board', repository: 'acme/board' }, 'tok-a'))
    const board = await call('project-board', { id: project.id }, 'tok-b')
    assert.equal(board.ok, true, JSON.stringify(board), 'project-board is a known endpoint once someone signed in')
    assert.deepEqual(value(board).tasks, [])
  } finally { await stop() }
})

// #1766: the Settings page needs somewhere to say where a Project works, so the record carries an
// optional folder — the absolute path the folder picker hands back, never a relative one.
test('a Project carries an optional working folder and refuses a relative one', async () => {
  const { call, stop } = await start()
  try {
    const project = created(await call('project-create', { name: 'Site', workDir: '/work/site' }))
    assert.equal(project.workDir, '/work/site')
    assert.equal(created(await call('project-read', { id: project.id })).workDir, '/work/site')
    assert.equal(value(await call('projects', {})).projects[0].workDir, '/work/site', 'the list carries it too')

    assert.equal(created(await call('project-create', { name: 'Bare' })).workDir, null)
    // An empty value is the field left alone, not a relative folder.
    assert.equal(created(await call('project-create', { name: 'Blank', workDir: '' })).workDir, null);
    for (const workDir of ['site', '../site', 'not-absolute/site']) {
      const refused = await call('project-create', { name: 'Bad', workDir })
      assert.equal(refused.ok, false, `${JSON.stringify(workDir)} is not a folder`)
      assert.match(refused.error.message, /absolute path/)
    }
  } finally { await stop() }
})

// #1759: `project-assistant-owner` had a store case and an owner gate (#1740) but no channel case
// and no `TASK_ENDPOINTS` entry, so every call failed `bot/not-found` and the digest opt-out, the
// quiet window and the zone were writable only in-process. There is no read endpoint: the second
// write's answer echoes the record the first one stored, so it proves the write went through the
// Project's own assistant rather than being accepted and dropped.
test('the Project owner writes the assistant settings through the host channel (#1759)', async () => {
  const { call, stop } = await start()
  try {
    const project = created(await call('project-create', { name: 'Assistant', repository: 'acme/assistant' }, 'tok-a'))
    assert.equal(typeof project.assistant?.botId, 'string', `the Project got an assistant: ${JSON.stringify(project.assistant)}`)

    // Before #1759 this answered `Unknown endpoint project-assistant-owner` / `bot/not-found` for
    // both callers: the endpoint was not dispatched at all.
    const refused = await call('project-assistant-owner', { id: project.id, settings: { off: true } }, 'tok-b')
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.equal(refused.error.code, 'bot/forbidden', JSON.stringify(refused))

    const written = value(await call('project-assistant-owner', {
      id: project.id,
      settings: { off: true, quiet: { on: true, from: '09:00', to: '11:00' }, zone: 'Asia/Shanghai' },
    }, 'tok-a'))
    assert.equal(written.owner, 'owner-1')
    assert.equal(written.off, true)
    assert.deepEqual(written.quiet, { on: true, from: '09:00', to: '11:00', zone: 'Asia/Shanghai' })
    assert.equal(written.changed, true)

    const reread = value(await call('project-assistant-owner', { id: project.id, settings: { off: false } }, 'tok-a'))
    assert.equal(reread.off, false)
    assert.deepEqual(reread.quiet, { on: true, from: '09:00', to: '11:00', zone: 'Asia/Shanghai' }, 'the window and the zone are still stored')
  } finally { await stop() }
})
