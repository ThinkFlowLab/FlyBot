// P-209: a meeting is a record on disk, not a decoration of the live process. These tests restart
// the host on the same home and read what the caller was told: a decided meeting stays closed (its
// second decide is refused, with no second decision file and no second card), and an open meeting
// keeps its recorded positions.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2, revision: 1, mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Chief', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
    r1: { id: 'r1', name: 'Reviewer', role: 'Reviewer', sessionId: 'r1', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {}, grants: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function runtime(home) {
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: { session: { id }, id, status: 'idle', cancel() {} } }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  return { ctx, rt }
}

async function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-probe-meetings-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-probe-meetings-work-'))
  t.after(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  const first = await runtime(home)
  const meeting = (args, id = 'a') => first.ctx.registeredTools.get('meeting').execute(args, { agent: { id, session: { header: { cwd: dir } } } })
  return { home, dir, meeting, first }
}

const positionAll = async (meeting, id) => {
  for (const name of ['Chief', 'Dev', 'Reviewer']) await meeting({ action: 'position', meeting: id, as: name, stance: 'agree', text: `${name} agrees` })
}

test('P-209: a decided meeting survives a restart, and a second decide is refused with closed', async (t) => {
  const { home, dir, meeting, first } = await setup(t)
  const text = await meeting({ action: 'open', question: 'Which storage shape should Stage 4 use?', participants: ['Chief', 'Dev', 'Reviewer'] })
  const id = text.split(' ')[0]
  await positionAll(meeting, id)
  await meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Use the existing store.', evidence: [{ pr: 209 }], tasks: [{ botId: 'd1', title: 'Ship the record' }] })
  const cardsBefore = Object.keys(first.rt.state.tasks ?? {}).length
  const filesBefore = readdirSync(join(dir, 'decisions')).length
  await first.ctx.dispose()
  const second = await runtime(home)
  t.after(() => second.ctx.dispose())
  const read = await second.rt.meetingEndpoint('read', { meeting: id })
  assert.match(read, /\[decided\]/, `a restart must not forget the decision, got: ${read.split('\n')[0]}`)
  await assert.rejects(
    second.rt.meetingEndpoint('decide', { meeting: id, owner: 'Chief', decision: 'Again.', evidence: [{ pr: 209 }], exec: { agent: { session: { header: { cwd: dir } } } } }, { name: 'Chief' }),
    /closed/,
  )
  assert.equal(Object.keys(second.rt.state.tasks ?? {}).length, cardsBefore, 'a refused reopen adds no card')
  assert.equal(readdirSync(join(dir, 'decisions')).length, filesBefore, 'a refused reopen writes no second decision file')
})

test('P-209: an open meeting and a recorded position survive a restart', async (t) => {
  const { home, meeting, first } = await setup(t)
  const text = await meeting({ action: 'open', question: 'Which storage shape should Stage 4 use?', participants: ['Chief', 'Dev', 'Reviewer'] })
  const id = text.split(' ')[0]
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'the existing store' })
  await first.ctx.dispose()
  const second = await runtime(home)
  t.after(() => second.ctx.dispose())
  const read = await second.rt.meetingEndpoint('read', { meeting: id })
  assert.match(read, /\[deliberating\]/, `an open meeting must survive a restart, got: ${read.split('\n')[0]}`)
  assert.match(read, /- Chief: agree — the existing store/, `the position must survive, got: ${read}`)
})
