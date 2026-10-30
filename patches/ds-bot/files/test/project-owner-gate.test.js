// #1740: the Project endpoints that delete a Project or expose and change its assistant memory
// belong to the Project's owner. `requireProjectOwner` has existed since #1710 and only
// `project-bind` called it, so a signed-in member could delete another member's Project, read its
// private memory, write into the digest's source, and change another owner's digest settings.
//
// These drive `rt.projectEndpoint` with an explicit actor, the shape the host itself uses, so the
// assertion is on the refusal the store raises rather than on a rendered sentence.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'owner-2': { id: 'owner-2', createdAt: 2, designatedChiefId: null },
  },
  bots: { a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' } },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  grants: {},
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-owner-gate-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) agents.set(sessionId, { session: { id: sessionId }, followup() {}, steer() {}, inject() {}, cancel() {}, whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } })
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  // The assistant is where an owner's quiet window and digest opt-out live. A recording stand-in
  // proves a refused call never reached it, without depending on the assistant's own storage.
  const setOwnerCalls = []
  rt.projectAssistant = {
    create: async projectId => ({ id: `assistant-${projectId}` }),
    remove: async () => {},
    setOwner: async (projectId, ownerId, settings) => {
      setOwnerCalls.push({ projectId, ownerId, settings })
      return { owner: { id: ownerId, ...settings } }
    },
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, setOwnerCalls, stop }
}

const owner = { memberId: 'owner-1' }
const other = { memberId: 'owner-2' }

const create = async (rt, name = 'Ops') => (await rt.projectEndpoint('project-create', { name, repository: 'acme/ops' }, owner)).project

// The refusal is the error the store raises: assert its code, never the wording of the message.
const refused = (promise) => assert.rejects(promise, (error) => {
  assert.equal(error.code, 'bot/forbidden', `expected bot/forbidden, got ${error.code}: ${error.message}`)
  return true
})

test('#1740: a member who does not own the Project cannot delete it', async () => {
  const { rt, stop } = await start()
  try {
    const project = await create(rt)
    await rt.projectEndpoint('project-memory-write', { id: project.id, kind: 'decision', text: 'the deploy key' }, owner)
    const memory = JSON.stringify(rt.state.projectMemory[project.id])

    await refused(rt.projectEndpoint('project-delete', { id: project.id }, other))

    assert.notEqual(rt.state.projects[project.id], undefined, 'the Project is still there')
    assert.equal(JSON.stringify(rt.state.projectMemory[project.id]), memory, 'and so is its memory, byte for byte')
  } finally { await stop() }
})

test('#1740: a member who does not own the Project cannot read its memory', async () => {
  const { rt, stop } = await start()
  try {
    const project = await create(rt)
    await rt.projectEndpoint('project-memory-write', { id: project.id, kind: 'decision', text: 'the deploy key' }, owner)

    await refused(rt.projectEndpoint('project-memory', { id: project.id }, other))
  } finally { await stop() }
})

test('#1740: a refused memory write is a refusal, not a silent no-op', async () => {
  const { rt, stop } = await start()
  try {
    const project = await create(rt)
    await rt.projectEndpoint('project-memory-write', { id: project.id, kind: 'decision', text: 'the deploy key' }, owner)
    const memory = JSON.stringify(rt.state.projectMemory[project.id])

    await refused(rt.projectEndpoint('project-memory-write', { id: project.id, kind: 'decision', text: 'injected into the digest' }, other))

    assert.equal(JSON.stringify(rt.state.projectMemory[project.id]), memory, 'the stored entries are unchanged')
  } finally { await stop() }
})

test('#1740: a member cannot change another owner’s digest settings', async () => {
  const { rt, setOwnerCalls, stop } = await start()
  try {
    const project = await create(rt)

    // Naming the Project's owner, and naming themselves: neither is the caller's record to change.
    await refused(rt.projectEndpoint('project-assistant-owner', { id: project.id, ownerId: 'owner-1', settings: { off: true } }, other))
    await refused(rt.projectEndpoint('project-assistant-owner', { id: project.id, ownerId: 'owner-2', settings: { off: true } }, other))
    assert.deepEqual(setOwnerCalls, [], 'the assistant was never asked to change a record')
  } finally { await stop() }
})

test('#1740: the owner still uses all four, and a missing id still answers not-found', async () => {
  const { rt, setOwnerCalls, stop } = await start()
  try {
    const project = await create(rt)
    const written = await rt.projectEndpoint('project-memory-write', { id: project.id, kind: 'decision', text: 'ship it' }, owner)
    assert.equal(written.memory.decisions.at(-1).text, 'ship it')
    const read = await rt.projectEndpoint('project-memory', { id: project.id }, owner)
    assert.equal(read.memory.decisions.at(-1).text, 'ship it')
    const assistant = await rt.projectEndpoint('project-assistant-owner', { id: project.id, ownerId: 'owner-1', settings: { off: true } }, owner)
    assert.equal(assistant.owner.id, 'owner-1')
    assert.deepEqual(setOwnerCalls.map(call => call.ownerId), ['owner-1'])
    await rt.projectEndpoint('project-delete', { id: project.id }, owner)
    assert.equal(rt.state.projects[project.id], undefined)

    // The gate returns early on a missing Project: today's answer, not a new 403 and not a 500.
    await assert.rejects(rt.projectEndpoint('project-memory', { id: 'project-missing' }, owner), (error) => {
      assert.equal(error.code, 'bot/not-found', `${error.code}: ${error.message}`)
      return true
    })
  } finally { await stop() }
})
