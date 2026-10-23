import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const QUESTION = 'ask_user_question'

const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 },
    writer: { id: 'writer', sessionId: 'writer', name: 'Writer', role: 'Write', instructions: '', createdAt: 2 },
  },
  rooms: { room: { id: 'room', name: 'Desk', members: ['chief', 'writer'], sessions: { writer: 'room-writer' }, admin: 'chief', mode: 'everyone' } },
  agents: { dsh: { id: 'dsh', name: 'DSH Agent', sessions: ['plain'], createdAt: 3 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  revision: 1,
})

// dsh keeps one Agent per Session and fires agent/created, waiting for its listeners,
// the first time a Session resolves one. restrict() calls are recorded per Session.
async function setup({ served = ['read', 'ask_user', QUESTION] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-blocking-question-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  const agents = new Map()
  const hidden = []
  const sent = []
  let sessions = 0
  const created = agent => Promise.all((ctx.listeners.get('agent/created') ?? []).map(listener => listener({ agent })))
  const agentFor = async (id) => {
    if (agents.has(id)) return agents.get(id)
    const agent = {
      id,
      session: { id },
      ctx: {
        tools: { restrict: (filter) => { hidden.push([id, [...filter.deny]]); return () => {} } },
        effect: execute => execute(),
      },
      followup: message => sent.push({ sessionId: id, message }),
    }
    agents.set(id, agent)
    await created(agent)
    return agent
  }
  ctx.tools.schemas = () => served.map(name => ({ name }))
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'deepseek-v4-flash' }],
      resolveModelInfo: async () => ({}),
    },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `new${++sessions}` }),
      resolveAgent: async id => ({ agent: await agentFor(id) }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  const guard = (name, sessionId) => ctx.guards.map(check => check({ name, agent: sessionId === undefined ? undefined : { id: sessionId } })).find(reason => reason !== undefined)
  const hiddenIn = id => hidden.filter(([sessionId, deny]) => sessionId === id && deny.includes(QUESTION))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, agentFor, hidden, hiddenIn, guard, sent, stop }
}

test('a Bot\'s own chat and its group Session lose dsh\'s blocking question tool; other Sessions keep it', async (t) => {
  const { agentFor, hidden, hiddenIn, stop } = await setup()
  t.after(stop)
  for (const id of ['chief', 'writer', 'room-writer', 'plain', 'elsewhere']) await agentFor(id)
  assert.equal(hiddenIn('chief').length, 1)
  assert.equal(hiddenIn('writer').length, 1)
  assert.equal(hiddenIn('room-writer').length, 1)
  assert.deepEqual(hiddenIn('plain'), [])
  assert.deepEqual(hiddenIn('elsewhere'), [])
  // The mask names only that tool, never ds-bot's own ask_user.
  for (const [sessionId, deny] of hidden.filter(([id]) => id !== 'plain')) assert.deepEqual([sessionId, deny], [sessionId, [QUESTION]])
})

test('ds-bot resolving a Bot\'s Agent again does not hide the tool twice', async (t) => {
  const { rt, hiddenIn, stop } = await setup()
  t.after(stop)
  await rt.resolveAgent('writer')
  await rt.resolveAgent('writer')
  await rt.deliver({ fromId: 'chief', toId: 'writer', text: 'hi', role: 'request' })
  assert.equal(hiddenIn('writer').length, 1)
})

test('a profile without the tool gets no mask, which restrict() would refuse', async (t) => {
  const { agentFor, hidden, guard, stop } = await setup({ served: ['read', 'ask_user'] })
  t.after(stop)
  await agentFor('writer')
  assert.deepEqual(hidden, [])
  // The guard still holds should a later profile serve it.
  assert.match(guard(QUESTION, 'writer'), /Bots cannot use ask_user_question/)
})

test('the guard refuses the blocking question tool in Bot Sessions only', async (t) => {
  const { guard, stop } = await setup()
  t.after(stop)
  for (const sessionId of ['chief', 'writer', 'room-writer']) assert.match(guard(QUESTION, sessionId), /Ask with ask_user in your own chat, or ask in your reply\./)
  for (const sessionId of ['plain', 'elsewhere', undefined]) assert.equal(guard(QUESTION, sessionId), undefined)
  assert.equal(guard('ask_user', 'writer'), undefined)
  assert.equal(guard('read', 'writer'), undefined)
})

// FeiZhuLulu/DeepSeek-Bot#77: a new Bot told never to use a question tool must not be
// told to use one, and its Session must not carry dsh's either. Creating it speaks to
// nobody (#645); the mask lands on its first delivered turn, and the guard holds before that.
test('a new Bot that rules out question tools is sent nothing and cannot block on dsh\'s', async (t) => {
  const { rt, hiddenIn, guard, sent, stop } = await setup()
  t.after(stop)
  const receiver = await rt.createBot({ name: 'Receiver', instructions: 'Never use ask_user or any question tool.', createdBy: 'chief' })
  assert.deepEqual(sent, [])
  assert.match(guard(QUESTION, receiver.id), /Bots cannot use ask_user_question/)
  await rt.deliver({ fromId: 'chief', toId: receiver.id, text: 'Start.', role: 'request' })
  assert.equal(hiddenIn(receiver.id).length, 1)
})
