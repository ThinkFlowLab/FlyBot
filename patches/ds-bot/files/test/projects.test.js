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
