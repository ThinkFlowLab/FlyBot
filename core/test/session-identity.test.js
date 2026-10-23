import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Some routes (OpenCode Go among them) turn down every model request that names no
// Session. DS Bot's own requests name the Session they serve, and the hooks that act
// on a Session's own rounds still leave them alone.

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', model: 'deepseek/v4', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2', name: 'Writer', role: 'Writing', model: 'deepseek/v4', instructions: '', createdAt: 2 },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: 'Code', model: 'deepseek/v4', instructions: '', createdAt: 3 },
  },
  rooms: {
    r1: { id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b3: 'g3' }, seq: 0, log: [] },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const MISSING = '400: {"type":"MissingSessionID","message":"Request is missing x-opencode-session"}'
const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, name: 'triangle.png' }
const userText = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

// `ctx.llm.stream` runs the plugin's `llm/stream` listeners in order, as DSH does,
// and then a route that turns down a request without a Session. `respond` gives the
// text of each answer the route lets through.
function start({ config = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-session-identity-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const bench = { tokens: 0, compacted: 0, respond: () => '', requests: [] }
  const compaction = {
    summarize() {},
    async compactIfNeeded() {
      bench.compacted += 1
      bench.tokens = 100
      return {}
    },
    async compactNow() {},
    async compactRegion() {},
  }
  const ctx = fakeContext({ services: { compaction, tokenMeter: { measure: () => ({ totalTokens: bench.tokens }) } } })
  async function* route(options) {
    bench.requests.push(options)
    if (options.sessionId === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: MISSING } } }
      return
    }
    yield { type: 'text-delta', index: 0, text: bench.respond(options) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  Object.assign(ctx, {
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [{ id: 'v4' }, { id: 'vision', inputModalities: ['text', 'image'] }],
      resolveModelInfo: async (_provider, model) => ({
        inputModalities: model === 'vision' ? ['text', 'image'] : ['text'],
        context: { contextWindow: 100_000 },
        defaultMaxTokens: 8_000,
        reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] },
      }),
      stream(options) {
        const chain = ctx.listeners.get('llm/stream') ?? []
        const run = index => (index < chain.length ? chain[index](options, () => run(index + 1)) : route(options))
        return run(0)
      },
    },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 2 } } }),
      selectModel: async () => {},
      page: async () => ({
        records: [
          { event: { seq: 0, time: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep working on the report' }] } } },
          { event: { seq: 1, time: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Working on it.' }] } } } },
        ],
        hasMore: false,
      }),
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = createRuntime(ctx, { home, ...config })
  const hook = pattern => ctx.listeners.get('llm/stream').find(listener => pattern.test(String(listener)))
  const stop = async () => {
    await ctx.dispose()
    // A reading is cached on disk in the background.
    if (bench.requests.some(request => request.model === 'vision' && request.sessionId !== undefined)) {
      for (let tries = 0; tries < 100 && !existsSync(join(home, 'ocr.json')); tries += 1) await new Promise(resolve => setTimeout(resolve, 10))
    }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, bench, hook, home, stop }
}

for (const sessionId of ['b2', 'g3']) {
  test(`the context steward names the Session it decides for (${sessionId}), and the part is condensed in place`, async (t) => {
    const { ctx, bench, stop } = start()
    t.after(stop)
    bench.tokens = 95_000
    bench.respond = () => '{"action":"compact"}'
    const session = { id: sessionId, seq: 2, requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }), deriveMessages: () => [], toolHistory: () => [] }
    const preStep = ctx.listeners.get('agent/pre-step').find(listener => /adoptCompaction/.test(String(listener)))
    const next = { kind: 'continue' }
    const result = await preStep({ agent: { id: sessionId, session }, messages: [], step: 2, signal: new AbortController().signal }, () => next)
    assert.equal(result, next)
    assert.equal(bench.compacted, 1)
    assert.deepEqual(bench.requests.map(request => [request.sessionId, request.purpose]), [[sessionId, 'compaction']])
  })
}

test('an image in a Bot chat is read for that chat, and the chat gets the reading', async (t) => {
  const { ctx, bench, stop } = start()
  t.after(stop)
  bench.respond = options => (options.model === 'vision' ? 'A red triangle.' : 'It is a triangle.')
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment }, { type: 'text', text: 'What is this?' }] }
  const chunks = await drain(ctx.llm.stream({ provider: 'deepseek', model: 'v4', sessionId: 'b2', messages: [message] }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(bench.requests.map(request => [request.model, request.sessionId]), [['vision', 'b2'], ['v4', 'b2']])
  assert.equal(bench.requests[0].messages[0].content[0].type, 'image')
  assert.match(bench.requests[1].messages[0].content[0].text, /A red triangle\./)
})

test('an image in a group is read for the group, and the group still relays its own rounds', async (t) => {
  const { ctx, rt, bench, stop } = start()
  t.after(stop)
  bench.respond = () => 'A red triangle.'
  const [reading] = await rt.imagesForGroup([attachment], 'r1')
  assert.match(reading, /read by vision:\]\nA red triangle\./)
  assert.deepEqual(bench.requests.map(request => [request.model, request.sessionId]), [['vision', 'r1']])

  const chunks = await drain(ctx.llm.stream({ provider: 'deepseek', model: 'v4', sessionId: 'r1', messages: [userText('Discuss the picture')] }))
  assert.ok(chunks.some(chunk => chunk.type === 'tool-call-delta' && chunk.name === 'group_relay'))
  assert.equal(bench.requests.length, 1)
})

test('the Session hooks pass DS Bot\'s own requests through, and still act on a Session\'s own rounds', async (t) => {
  const { rt, hook, stop } = start()
  t.after(stop)
  await rt.load()
  const own = (sessionId, messages) => ({ provider: 'deepseek', model: 'v4', sessionId, messages: rt.tagUsage([...messages], { sessionId, kind: 'memory' }) })
  const round = (sessionId, messages) => ({ provider: 'deepseek', model: 'v4', sessionId, messages })
  const passed = (async function* () {})()
  const pass = () => passed

  const relay = hook(/relayOrPass/)
  assert.equal(relay(own('r1', [userText('Read this')]), pass), passed)
  assert.ok((await drain(relay(round('r1', [userText('Read this')]), pass))).some(chunk => chunk.name === 'group_relay'))

  const handoff = [{ role: 'user', source: { kind: 'bot', handoff: true }, content: [{ type: 'text', text: 'Handoff note' }] }]
  const acknowledge = hook(/acknowledge/)
  assert.equal(acknowledge(own('b2', handoff), pass), passed)
  assert.ok((await drain(acknowledge(round('b2', handoff), pass))).some(chunk => chunk.type === 'text-delta'))

  const picture = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment }] }]
  const images = hook(/imagesAsTextOrPass/)
  assert.equal(images(own('b2', picture), pass), passed)
  assert.notEqual(images(round('b2', picture), pass), passed)
})

// #779: with no vision model a picture cannot be read, and the placeholder then names the bytes on
// disk so a Bot can pick them up with its own file tools. Both paths that turn an image into text
// for a text-only model share that placeholder: the group relay and a Bot chat.
test('an unread image names its bytes in a group and in a chat alike', async (t) => {
  const { ctx, rt, bench, home, stop } = start({ config: { textOnlyModels: ['deepseek/vision'] } })
  t.after(stop)
  const id = 'b'.repeat(64)
  const objectPath = join(home, 'attachments', 'v1', 'objects', id.slice(0, 2), id)
  mkdirSync(join(home, 'attachments', 'v1', 'objects', id.slice(0, 2)), { recursive: true })
  writeFileSync(objectPath, 'not really a png')
  const picture = { attachmentId: `sha256:${id}`, name: 'chart.png', mediaType: 'image/png', bytes: 16 }

  const [line] = await rt.imagesForGroup([picture], 'r1')
  assert.match(line, /it could not be read right now\. The file is at /)
  assert.ok(line.includes(`"${objectPath}"`), line)

  bench.respond = () => 'It is a chart.'
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: picture }, { type: 'text', text: 'What is this?' }] }
  const chunks = await drain(ctx.llm.stream({ provider: 'deepseek', model: 'v4', sessionId: 'b2', messages: [message] }))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  // No vision request went out: there is no model to send it to.
  assert.deepEqual(bench.requests.map(request => request.model), ['v4'])
  assert.ok(bench.requests[0].messages[0].content[0].text.includes(`"${objectPath}"`), bench.requests[0].messages[0].content[0].text)
})

test('an unread image whose bytes are gone keeps the placeholder short', async (t) => {
  const { ctx, rt, bench, home, stop } = start({ config: { textOnlyModels: ['deepseek/vision'] } })
  t.after(stop)
  const id = 'c'.repeat(64)
  const picture = { attachmentId: `sha256:${id}`, name: 'gone.png' }
  const [line] = await rt.imagesForGroup([picture], 'r1')
  assert.match(line, /it could not be read right now\. Ask the user/)
  assert.ok(!line.includes(home), line)

  bench.respond = () => 'It is a chart.'
  const message = { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: picture }, { type: 'text', text: 'What is this?' }] }
  await drain(ctx.llm.stream({ provider: 'deepseek', model: 'v4', sessionId: 'b2', messages: [message] }))
  assert.ok(!bench.requests[0].messages[0].content[0].text.includes(home), bench.requests[0].messages[0].content[0].text)
})
