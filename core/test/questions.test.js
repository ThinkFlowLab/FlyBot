import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief', createdAt: 1 },
    writer: { id: 'writer', name: 'Writer', role: 'Write', sessionId: 'writer', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-questions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const askOptions = (sessionId, options, callId) => ctx.registeredTools.get('ask_user').execute(
    { question: 'Which name?', options },
    { agent: { id: sessionId }, callId, concludeTurn() {} },
  )
  const ask = (sessionId, callId) => askOptions(sessionId, [{ label: 'Lookout' }, { label: 'Scout' }], callId)
  const questions = async () => (await (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint: 'state', payload: {} }),
  }))).json()).value.questions
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await ctx.registeredTools.get('list_bots').execute({}, { agent: { id: 'chief' } })
  return { emit, ask, askOptions, questions, stop: async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

const text = value => [{ type: 'text', text: value }]

const RULE = 'Give two to four answers.'
const CARD = 'The card is on screen; the user\'s answer arrives as their next message.'
const labels = (...names) => names.map(label => ({ label }))
// Everything the client renders, without the card's own identity.
const cardJson = card => JSON.stringify(card, (key, value) => (key === 'id' || key === 'askedAt' ? undefined : value))

test('a card asked in a hidden Bot-to-Bot turn goes to the dock, without its call', async (t) => {
  const { emit, ask, questions, stop } = await start()
  t.after(stop)
  emit('writer', 'turn/start', { turn: 1 })
  emit('writer', 'user/message', { content: text('[Message from Chief]\nThe user wants a new Bot; ask them for its name'), source: { kind: 'bot', role: 'request', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x1', hop: 0 } })
  await ask('writer', 'call-1')
  const asked = (await questions()).writer
  assert.equal(asked.question, 'Which name?')
  assert.equal(asked.callId, undefined)
})

test('a card asked in a visible turn stays at its call', async (t) => {
  const { emit, ask, questions, stop } = await start()
  t.after(stop)
  emit('writer', 'turn/start', { turn: 1 })
  emit('writer', 'user/message', { content: text('Help me name a Bot'), source: { kind: 'user' } })
  await ask('writer', 'call-2')
  assert.equal((await questions()).writer.callId, 'call-2')

  // A message that asks for an answer in the recipient's own chat is visible too.
  emit('writer', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('writer', 'turn/start', { turn: 2 })
  emit('writer', 'user/message', { content: text('[Message from Chief · the user sees your reply here]\nIntroduce yourself'), source: { kind: 'bot', role: 'request', audience: 'user', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x2', hop: 0 } })
  await ask('writer', 'call-3')
  assert.equal((await questions()).writer.callId, 'call-3')
})

// #2771: the card's own contract says two to four answers, and the host enforces exactly that.
test('#2771: one option is refused with the rule and stores no card', async (t) => {
  const { askOptions, questions, stop } = await start()
  t.after(stop)
  assert.equal(await askOptions('writer', labels('Only'), 'call-1'), RULE)
  assert.equal((await questions()).writer, undefined)
})

test('#2771: six options are refused with the rule and store no card', async (t) => {
  const { askOptions, questions, stop } = await start()
  t.after(stop)
  assert.equal(await askOptions('writer', labels('A', 'B', 'C', 'D', 'E', 'F'), 'call-1'), RULE)
  assert.equal((await questions()).writer, undefined)
})

test('#2771: seven options are refused, never cut to six', async (t) => {
  const { askOptions, questions, stop } = await start()
  t.after(stop)
  assert.equal(await askOptions('writer', labels('A', 'B', 'C', 'D', 'E', 'F', 'G'), 'call-1'), RULE)
  assert.equal((await questions()).writer, undefined)
})

test('#2771: two and four options keep the card and the answer string, byte for byte', async (t) => {
  const { askOptions, questions, stop } = await start()
  t.after(stop)
  assert.equal(await askOptions('writer', labels('Lookout', 'Scout'), 'call-2'), CARD)
  assert.equal(cardJson((await questions()).writer),
    '{"callId":"call-2","question":"Which name?","options":[{"label":"Lookout"},{"label":"Scout"}],"multiSelect":false}')
  assert.equal(await askOptions('writer', labels('A', 'B', 'C', 'D'), 'call-4'), CARD)
  assert.equal(cardJson((await questions()).writer),
    '{"callId":"call-4","question":"Which name?","options":[{"label":"A"},{"label":"B"},{"label":"C"},{"label":"D"}],"multiSelect":false}')
})

// The count is taken after the empty-label filter: five given with two blanks is three buttons.
test('#2771: labels dropped as empty do not count, so five given with two blanks is three and passes', async (t) => {
  const { askOptions, questions, stop } = await start()
  t.after(stop)
  const options = [{ label: 'A' }, { label: '  ' }, { label: 'B' }, { label: '' }, { label: 'C' }]
  assert.equal(await askOptions('writer', options, 'call-3'), CARD)
  assert.equal(cardJson((await questions()).writer),
    '{"callId":"call-3","question":"Which name?","options":[{"label":"A"},{"label":"B"},{"label":"C"}],"multiSelect":false}')
})
