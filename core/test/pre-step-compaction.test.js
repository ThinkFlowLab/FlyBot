import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { install } from '../src/host/parts.js'

// #1285: the pre-step that makes room for a step hands the engine the turn's own
// signal and nothing else. A compaction whose summary request keeps retrying never
// returns, so the turn never takes another step, the session keeps reading as
// working, and only a human `stop_bot` ends it.
function setup({ compaction, deadlineMs = 50, tokens = () => 30_000 } = {}) {
  const ctx = fakeContext()
  const warned = []
  const engine = {
    summarize: async function* () {},
    compactIfNeeded(target, trigger, signal) {
      return compaction({ target, trigger, signal })
    },
    compactNow: async () => null,
  }
  const session = {
    id: 'bot',
    header: { cwd: '/work' },
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'flash', maxTokens: 0 } }),
    deriveMessages: () => [],
  }
  const inbox = stubInbox()
  const agent = { id: 'bot', session, inbox }
  const rt = {
    ctx,
    config: { timeZone: 'UTC', compactDeadlineMs: deadlineMs },
    state: { bots: {}, rooms: {}, exchanges: [], questions: {}, revision: 0 },
    chatOwners: new Map(),
    groupOwners: new Map(),
    chatOf: () => undefined,
    roomOf: () => undefined,
    botOf: () => ({ id: 'bot', name: 'Writer', sessionId: 'bot', createdAt: 1 }),
    selfOf: () => ({}),
    pastOwners: new Map(),
    readOnly: () => undefined,
    tagUsage: (messages) => messages,
    renewMemory() {},
    async load() {},
    isBotSession: () => true,
    async *eventsBackwards() {},
    async createSession() { throw new Error('a switch is not part of this test') },
    liveOf: () => ({ switched: false, info: undefined }),
    warn: (format, ...args) => warned.push(String(format).replace(/%[sd]/g, () => String(args.shift() ?? ''))),
    async save() {},
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [],
      resolveModelInfo: async () => ({ context: { contextWindow: 20_000 }, defaultMaxTokens: 0 }),
      stream: () => {
        return (async function* () {
          yield { type: 'text-delta', text: '{"action":"compact","reason":"still working"}' }
          yield { type: 'finish', reason: { kind: 'completed' } }
        })()
      },
    },
  })
  ctx.set('compaction', engine)
  ctx.set('tokenMeter', { measure: () => ({ totalTokens: tokens() }) })
  install(rt)
  const hook = ctx.listeners.get('agent/pre-step').at(-1)
  const step = (payload = {}) => hook({
    agent, turn: 1, step: 3, messages: [],
    signal: new AbortController().signal,
    ...payload,
  }, async () => ({ kind: 'enter', messages: [] }))
  return { ctx, agent, engine, warned, step, inbox }
}

// The two pending lists DSH's turn loop claims from, with the same rules the host
// applies: an identity may sit in only one of them, and a turn takes every next-step
// message plus one queued next-turn message before the pre-step hook runs.
function stubInbox() {
  const pending = { 'next-turn': [], 'next-step': [] }
  return {
    append(target, message) {
      const other = target === 'next-turn' ? 'next-step' : 'next-turn'
      if ([...pending[target], ...pending[other]].some(held => held.id === message.id)) throw new Error(`message "${message.id}" is already pending`)
      pending[target].push(message)
    },
    claim() {
      const claimed = [...pending['next-step'], ...pending['next-turn'].slice(0, 1)]
      pending['next-step'] = []
      pending['next-turn'] = pending['next-turn'].slice(1)
      return claimed
    },
    waiting: target => pending[target].slice(),
    hasPending: () => pending['next-turn'].length > 0 || pending['next-step'].length > 0,
  }
}

// A compaction that answers a summary request only when its signal says to stop:
// what a request stuck in retries looks like from the outside.
function stubborn() {
  return ({ signal }) => new Promise((_resolve, reject) => {
    const stop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORTED' }))
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
  })
}

test('#1285: a pre-step compaction that never returns stops the turn instead of parking it', async () => {
  const { warned, step } = setup({ compaction: stubborn() })
  const outcome = await Promise.race([
    step().then(() => 'returned', (error) => `rejected: ${error.message}`),
    delay(2_000).then(() => 'hung'),
  ])
  assert.notEqual(outcome, 'hung', 'the pre-step must end instead of waiting for a compaction that never returns')
  assert.match(warned.join('\n'), /ran out of 50 ms/)
})

test('#1285: a compaction that answers inside the deadline leaves the step alone', async () => {
  let compacted = false
  const { step, warned } = setup({
    compaction: async () => { compacted = true; return { compact: true } },
    tokens: () => (compacted ? 10_000 : 30_000),
  })
  assert.deepEqual(await step(), { kind: 'enter', messages: [] })
  assert.deepEqual(warned, [])
})

test('#1285: the turn the deadline ends puts the step input back for the next turn', async () => {
  const { step, inbox, warned } = setup({ compaction: stubborn() })
  const batch = [
    { id: 'm1', content: [{ type: 'text', text: 'first' }] },
    { id: 'm2', content: [{ type: 'text', text: 'second' }] },
  ]
  // The turn loop claimed the batch before the hook ran, as DSH does.
  inbox.append('next-step', batch[0])
  inbox.append('next-turn', batch[1])
  assert.deepEqual(inbox.claim(), batch, 'the batch is claimed before the hook runs')
  assert.deepEqual(inbox.waiting('next-turn'), [])

  const outcome = await Promise.race([
    step({ messages: batch }).then(() => 'returned', (error) => `rejected: ${error.message}`),
    delay(2_000).then(() => 'hung'),
  ])
  assert.notEqual(outcome, 'hung', 'the pre-step must end instead of waiting for a compaction that never returns')
  assert.match(warned.join('\n'), /ran out of 50 ms/)

  // Back in the queue, not only in a call: the next turn claims them the ordinary way.
  assert.equal(inbox.hasPending(), true)
  assert.deepEqual(inbox.waiting('next-turn'), batch)
  assert.deepEqual(inbox.claim(), [batch[0]])
  assert.deepEqual(inbox.claim(), [batch[1]])
  assert.equal(inbox.hasPending(), false)
})

// A compaction that ignores the signal it was given and answers only to the turn:
// the deadline has already fired when the user stops the turn, so both are aborted.
function deafToDeadline(turn) {
  return () => new Promise((_resolve, reject) => {
    const stop = () => reject(Object.assign(new Error('stopped'), { name: 'AbortError', code: 'ABORTED' }))
    if (turn.signal.aborted) stop()
    else turn.signal.addEventListener('abort', stop, { once: true })
  })
}

test('#1285: a turn the user stopped during the wait takes the old path', async () => {
  const { step, warned } = setup({ compaction: stubborn() })
  const turn = new AbortController()
  const pending = step({ signal: turn.signal })
  await delay(0)
  turn.abort(new Error('stopped'))
  assert.deepEqual(await pending, { kind: 'enter', messages: [] }, 'the step goes on as it did before the deadline')
  assert.match(warned.join('\n'), /condensing bot failed/)
  assert.doesNotMatch(warned.join('\n'), /ran out of/)
})

test('#1285: a deadline already reached does not claim a turn the user stopped', async () => {
  const turn = new AbortController()
  const { step, warned } = setup({ compaction: deafToDeadline(turn), deadlineMs: 20 })
  const pending = step({ signal: turn.signal })
  await delay(60)
  turn.abort(new Error('stopped'))
  assert.deepEqual(await pending, { kind: 'enter', messages: [] }, "the turn is the user's, not the deadline's")
  assert.match(warned.join('\n'), /condensing bot failed/)
  assert.doesNotMatch(warned.join('\n'), /ran out of/)
})

test('#1285: putting the same input back twice adds no second copy', async () => {
  const { step, inbox, warned } = setup({ compaction: stubborn() })
  const batch = [
    { id: 'm1', content: [{ type: 'text', text: 'first' }] },
    { id: 'm2', content: [{ type: 'text', text: 'second' }] },
  ]
  inbox.append('next-step', batch[0])
  inbox.append('next-turn', batch[1])
  inbox.claim()
  const first = await Promise.race([
    step({ messages: batch }).then(() => 'returned', error => `rejected: ${error.message}`),
    delay(2_000).then(() => 'hung'),
  ])
  assert.notEqual(first, 'hung', 'the deadline ends the turn instead of parking it')
  assert.match(first, /rejected: aborted/)
  assert.deepEqual(inbox.waiting('next-turn'), batch)

  // The same batch ends a second turn while it is already queued: the inbox refuses an
  // identity it holds, and the put-back keeps going instead of throwing over it.
  await assert.rejects(step({ messages: batch }), /aborted/)
  assert.deepEqual(inbox.waiting('next-turn'), batch)
  assert.match(warned.join('\n'), /could not go back in the queue/)
})
