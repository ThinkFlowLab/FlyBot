import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ROOM_WORK_GRACE_MS } from '../src/host/constants.js'
import { prepareFixture, checkWorker, verifyArtifact, requirement, question, answer } from '../dev/room-collaboration/fixture.mjs'

const implementation = `export function totalPaid(orders, region) {
  return orders.filter(row => row.status === 'paid' && (region === undefined || row.region === region))
    .reduce((total, row) => total + row.amount, 0)
}
`
const incomplete = `export function totalPaid(orders, region) {
  return orders.filter(row => row.status === 'paid' && row.region === region)
    .reduce((total, row) => total + row.amount, 0)
}
`

async function start(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const home = mkdtempSync(join(tmpdir(), 'flybot-room-pilot-'))
  const dirs = prepareFixture(join(home, 'fixture'))
  const bots = Object.fromEntries(['chief', 'writer'].map(id => [id, {
    id, name: id === 'chief' ? 'Chief' : 'Writer', sessionId: id,
    role: id, ownerId: 'owner', createdAt: 1, workDir: id === 'chief' ? dirs.verifier : dirs.worker,
  }]))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 2, revision: 1, mainBotIds: ['chief'], bots,
    members: { owner: { id: 'owner', displayName: 'Operator', createdAt: 1, designatedChiefId: 'chief' } },
    rooms: { ops: { id: 'ops', name: 'Pilot', members: ['chief', 'writer'], admin: 'chief', mode: 'admin', named: true,
      sessions: { chief: 'room-chief', writer: 'room-writer' }, seen: {}, seq: 0, log: [] } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {},
  }))
  const ctx = fakeContext()
  const pending = []
  const controller = new AbortController()
  t.after(async () => { controller.abort(); await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'workspace', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => { throw new Error('Pilot must reuse its seeded room sessions') },
      selectModel: async () => {}, page: async () => ({ events: [] }),
      resolveAgent: async id => ({ agent: { session: { id }, followup: message => pending.push({ sessionId: id, message }), cancel() {} } }),
    },
    sessionTitle: { rename: async () => {} }, sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { if (options.path.endsWith('bot')) route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload = {}) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const ok = async (endpoint, payload) => {
    const response = await call(endpoint, payload)
    assert.equal(response.ok, true, JSON.stringify(response))
    return response.value
  }
  const emit = async (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener({ id }, { type, data })
  }
  let turn = 0
  const next = async (id, expected) => {
    for (let attempt = 0; attempt < 200 && pending.length === 0; attempt += 1) await delay(5)
    const delivery = pending.shift()
    assert.ok(delivery, `no turn for ${id}`)
    assert.equal(delivery.sessionId, `room-${id}`)
    assert.equal(delivery.message.source.roomId, 'ops')
    assert.equal(delivery.message.source.role, 'room')
    const prompt = delivery.message.content.map(block => block.text ?? '').join('\n')
    assert.match(prompt, expected)
    await emit(delivery.sessionId, 'turn/start', { turn: ++turn })
    await emit(delivery.sessionId, 'user/message', { source: delivery.message.source, content: delivery.message.content })
    return async reply => {
      await emit(delivery.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
      await emit(delivery.sessionId, 'turn/end', { reason: { kind: 'stop' } })
    }
  }
  await ok('state')
  return { home, dirs, rt, call, ok, next, pending, emit, controller, ctx }
}

async function collaborate(t, { source = implementation, accept = true } = {}) {
  const host = await start(t)
  const { ok, call, next, dirs } = host
  const task = await ok('task-create', { botId: 'chief', roomId: 'ops', title: requirement, criteria: 'Independent checks pass; requester explicitly accepts.' })
  await ok('task-accept', { id: task.id })
  await ok('task-start', { id: task.id })
  assert.equal((await call('task-accept-result', { id: task.id })).ok, false)
  const original = readFileSync(join(dirs.worker, 'total.mjs'), 'utf8')
  await host.emit('ops', 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: `@Chief ${requirement}` }] })
  const running = host.ctx.registeredTools.get('group_relay').execute({}, { agent: { id: 'ops' }, callId: 'pilot', signal: host.controller.signal })
  t.after(() => running.catch(() => {}))

  const chief = await next('chief', /totalPaid/)
  await chief('@Writer Implement totalPaid in the isolated fixture. Ask me about omitted region before editing, then return actual test evidence.')
  const writer = await next('writer', /Ask me about omitted region/)
  assert.equal(readFileSync(join(dirs.worker, 'total.mjs'), 'utf8'), original)
  await writer(`@Chief ${question}`)
  // The coordinator represents the requester; Bots do not gain task API authority.
  const waiting = await ok('task-wait-input', { id: task.id, question })
  assert.equal(waiting.status, 'blocked')
  const clarify = await next('chief', /omitted region mean/)
  await clarify(`@Writer ${answer}`)
  await ok('task-answer-input', { id: task.id, questionId: waiting.inputRequest.id, answer })

  const implement = await next('writer', /all regions/)
  // Real tool work yields the first round; its late result starts a fresh round.
  // Keep the normal per-member turn bound rather than expanding it for the test.
  await host.emit('room-writer', 'tool/call', { callId: 'fixture-edit', name: 'shell', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS)
  const firstRound = JSON.parse(await running)
  assert.deepEqual(firstRound.replies.map(reply => [reply.botId, reply.kind ?? 'reply']), [
    ['chief', 'reply'], ['writer', 'reply'], ['chief', 'reply'], ['writer', 'working'],
  ])
  writeFileSync(join(dirs.worker, 'total.mjs'), source)
  const worker = checkWorker(dirs)
  assert.equal(worker.ok, true, 'the Writer actually runs its narrow test')
  await implement(`@Chief Implemented totalPaid. Self-test passed (exit ${worker.exitCode}); please independently verify the returned module.`)
  for (let attempt = 0; attempt < 200 && host.pending.length === 0; attempt += 1) await delay(5)
  const post = host.pending.shift()
  assert.equal(post?.sessionId, 'ops')
  assert.equal(post.message.source.late, true)
  assert.equal(post.message.source.askedBy, 'chief')
  await host.emit('ops', 'user/message', { source: post.message.source, content: post.message.content })
  const checking = host.ctx.registeredTools.get('group_relay').execute({}, { agent: { id: 'ops' }, callId: 'verification', signal: host.controller.signal })
  t.after(() => checking.catch(() => {}))
  const verify = await next('chief', /independently verify/)
  const independent = verifyArtifact(dirs)
  assert.equal(independent.sha256, worker.sha256, 'Chief verifies the exact returned code bytes')
  await verify(independent.ok ? `Independent tests passed: ${independent.sha256}. Awaiting requester acceptance.` : 'Independent tests failed. Do not accept this result.')
  const round = JSON.parse(await checking)
  assert.equal(round.failed, undefined)
  assert.deepEqual(round.replies.map(reply => reply.botId), ['chief'])
  assert.equal(host.pending.length, 0)
  assert.equal(host.rt.roomWaiters.size, 0)
  const room = host.rt.state.rooms.ops
  assert.deepEqual(room.log.slice(1).map(line => line.botId), ['chief', 'writer', 'chief', 'writer', 'chief'])
  assert.equal(room.log[2].text, `@Chief ${question}`)
  assert.equal(room.log[3].text, `@Writer ${answer}`)
  assert.notEqual(room.sessions.chief, room.sessions.writer)
  const returned = await ok('task-return', { id: task.id, summary: round.replies.at(-1).text })
  assert.equal(returned.status, 'result-ready')
  assert.equal((await ok('tasks')).find(item => item.id === task.id).status, 'result-ready')
  const final = await ok(accept && independent.ok ? 'task-accept-result' : 'task-cancel', { id: task.id })
  return { worker, independent, final, returned }
}

test('same-room DSH fixture delegates, clarifies, edits, independently verifies and accepts', async t => {
  const result = await collaborate(t)
  assert.equal(result.independent.ok, true)
  assert.equal(result.final.status, 'accepted')
  assert.equal(result.final.inputRequest.answer, answer)
})

test('independent verification rejects a result that passed the Writer self-test', async t => {
  const result = await collaborate(t, { source: incomplete })
  assert.equal(result.worker.ok, true)
  assert.equal(result.independent.ok, false)
  assert.equal(result.independent.exitCode, 1)
  assert.equal(result.final.status, 'cancelled')
  assert.match(result.returned.result.summary, /Independent tests failed/)
})

test('requester may reject a correctly verified result', async t => {
  const result = await collaborate(t, { accept: false })
  assert.equal(result.independent.ok, true)
  assert.equal(result.final.status, 'cancelled')
  assert.deepEqual(result.final.result, result.returned.result)
})
