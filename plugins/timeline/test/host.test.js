// @flybot/timeline on the real ctx.flybot host (ds-bot's hooks.js, resolved by test/resolve.mjs),
// fed by a mini agent loop whose model is core/dev/mock-llm.mjs over HTTP. The loop reports what
// DSH would (session/event: turn/start, tool/call, tool/result, user/message relay, turn/end);
// the spans the plugin serves must match that event log.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { apply } from 'ds-bot'
import * as timeline from '../index.js'
import { openTrace } from '../src/store.js'
import { fakeCordis } from './fake-cordis.js'

const MOCK = join(process.env.FLYBOT_CORE, 'dev', 'mock-llm.mjs')
const DELAY = 120
const TOOL_MS = 300
let mock
let mockUrl

before(async () => {
  mock = spawn(process.execPath, [MOCK], { env: { ...process.env, MOCK_PORT: '0', MOCK_DELAY_MS: String(DELAY), MOCK_LOG: join(mkdtempSync(join(tmpdir(), 'mock-log-')), 'mock.jsonl') }, stdio: ['ignore', 'pipe', 'inherit'] })
  mockUrl = await new Promise((resolve, reject) => {
    let out = ''
    mock.stdout.on('data', chunk => { out += chunk; const match = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(out); if (match) resolve(match[1]) })
    mock.on('exit', code => reject(new Error(`mock-llm exited ${code}`)))
  })
})
after(() => mock?.kill())

const team = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function start(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-timeline-host-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeCordis()
  const agents = new Map()
  const agentOf = id => {
    if (!agents.has(id)) agents.set(id, { session: { id, requestHeader: () => undefined }, id, calls: [], status: 'idle', followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {}, inbox: { nextStep: [], nextTurn: [], remove() {} } })
    return agents.get(id)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: agentOf(id) }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { if (options.path.endsWith('bot')) route = options; return register(options) }
  apply(ctx, { home })
  await ctx.flybot.ready()
  const dir = join(home, 'trace')
  const plugin = ctx.plugin(timeline, { dir, flushMs: 20, enabled: true, ...config })
  const call = async (endpoint, payload) => {
    const body = await (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
    return body.ok ? body.value : { error: body.error }
  }
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, home, dir, plugin, call, stop }
}

// --- the mini agent loop -------------------------------------------------------------------
const modelCall = async (system, messages, tools) => {
  const res = await fetch(`${mockUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock', stream: true, system, tools: tools.map(name => ({ name })), messages }) })
  const used = []
  let text = ''
  for (const chunk of (await res.text()).split('\n\n')) {
    const line = /^data: (.+)$/m.exec(chunk)?.[1]
    if (line === undefined) continue
    const event = JSON.parse(line)
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') used.push({ id: event.content_block.id, name: event.content_block.name, json: '' })
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text += event.delta.text
    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') used.at(-1).json += event.delta.partial_json
  }
  return { text, used: used.map(call => ({ id: call.id, name: call.name, input: JSON.parse(call.json || '{}') })) }
}

const TOOLS = ['list_bots', 'message_bot', 'web_search']
const SYSTEM = { a: "You are Chief, a Bot on the user's team. You are the Main Bot.", b: "You are Writer, a Bot on the user's team." }
const NAME_TO_ID = { Chief: 'a', Writer: 'b' }

function agentLoop(ctx) {
  let seq = 0
  let turnNo = 0
  let exchangeNo = 0
  const log = [] // what DSH would have reported: [sessionId, type, time, data]
  const emit = (id, type, data = {}) => {
    const time = Date.now()
    log.push({ id, type, time, data })
    ctx.emitArgs('session/event', { id }, { type, seq: ++seq, time, data })
    return time
  }
  const deliver = (id, source, text) => emit(id, 'user/message', { source, content: [{ type: 'text', text }] })
  const turns = []
  const exchanges = []
  // Runs one turn of Bot `id` on `prompt` and returns what it sent on.
  async function turn(id, prompt, trigger) {
    const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
    const record = { id, turn: ++turnNo, tools: [] }
    record.t0 = emit(id, 'turn/start', { turn: record.turn })
    const sent = []
    for (let step = 0; step < 4; step++) {
      const out = await modelCall(SYSTEM[id], messages, TOOLS)
      if (out.used.length === 0) { record.text = out.text; break }
      messages.push({ role: 'assistant', content: out.used.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })) })
      const results = []
      for (const call of out.used) {
        const span = { name: call.name, t0: emit(id, 'tool/call', { callId: call.id, name: call.name, arguments: JSON.stringify(call.input) }) }
        if (call.name === 'message_bot') {
          const target = NAME_TO_ID[call.input.to]
          const exchangeId = `x${++exchangeNo}`
          const sentAt = deliver(target, { kind: 'bot', form: 'relay', role: 'request', exchangeId, hop: 0, senderSessionId: id }, `[Message from ${id}]\n${call.input.message}`)
          exchanges.push({ exchangeId, from: id, to: target, t: sentAt, role: 'request' })
          sent.push({ exchangeId, to: target, text: call.input.message })
        } else await sleep(TOOL_MS)
        span.t1 = emit(id, 'tool/result', { callId: call.id, message: { toolCallId: call.id, isError: false, content: [{ type: 'text', text: 'ok' }] } })
        record.tools.push(span)
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'ok' })
      }
      messages.push({ role: 'user', content: results })
    }
    record.t1 = emit(id, 'turn/end', { turn: record.turn, reason: { kind: 'completed' } })
    record.trigger = trigger
    turns.push(record)
    return { record, sent }
  }
  return { turn, deliver, emit, log, turns, exchanges }
}

test('a Chief → Writer → Chief run: the served spans match the event log', async (t) => {
  const h = await start()
  t.after(h.stop)
  const loop = agentLoop(h.ctx)
  // You ask Chief to brief Writer.
  const askAt = loop.deliver('a', { kind: 'user' }, '转告 Writer: 写首诗')
  const first = await loop.turn('a', '转告 Writer: 写首诗')
  const [request] = first.sent
  // Writer's turn starts from the relay delivered to it, then it answers Chief.
  const second = await loop.turn('b', `[Message from Chief]\n${request.text}`)
  const replyAt = loop.deliver('a', { kind: 'bot', form: 'relay', role: 'reply', exchangeId: 'x9', hop: 1, replyTo: request.exchangeId, senderSessionId: 'b' }, second.record.text)
  await loop.turn('a', second.record.text)
  // A tool call on Writer, to see tool time.
  loop.deliver('b', { kind: 'user' }, '搜索：天气 | 新闻')
  const fourth = await loop.turn('b', '搜索：天气 | 新闻')

  const win = await h.call('flybot/timeline/window', { windowMs: 120_000 })
  assert.equal(win.version, 1)
  assert.deepEqual(win.lanes.map(lane => lane.id), ['user', 'a', 'b'])
  const turnOf = id => win.turns.find(turn => turn.id === id)
  const A = loop.turns.filter(turn => turn.id === 'a')
  const B = loop.turns.filter(turn => turn.id === 'b')
  assert.deepEqual(win.turns.filter(turn => turn.lane === 'a').map(turn => [turn.t0, turn.t1]), A.map(turn => [turn.t0, turn.t1]))
  assert.deepEqual(win.turns.filter(turn => turn.lane === 'b').map(turn => [turn.t0, turn.t1]), B.map(turn => [turn.t0, turn.t1]))
  assert.ok(win.turns.every(turn => turn.running === false && turn.outcome === 'completed'))
  // The mock model takes DELAY per call, so a turn that made a call is at least that long.
  assert.ok(first.record.t1 - first.record.t0 >= 2 * DELAY - 20)
  // Tool spans: Writer's web_search took about TOOL_MS and is counted as tool time, not model time.
  const search = turnOf(`b#${fourth.record.turn}`).tools.find(tool => tool.name === 'web_search')
  assert.equal(search.t1 - search.t0, fourth.record.tools[0].t1 - fourth.record.tools[0].t0)
  assert.ok(search.t1 - search.t0 >= TOOL_MS - 20)
  const writer = win.utilization.find(item => item.lane === 'b')
  assert.ok(writer.toolMs >= TOOL_MS - 20 && writer.toolMs < writer.busyMs)
  assert.equal(writer.busyMs, B.reduce((sum, turn) => sum + turn.t1 - turn.t0, 0))
  // Exchange latency: Chief's request to Writer, replied to when the reply was delivered.
  const arrow = win.exchanges.find(item => item.id === request.exchangeId)
  assert.deepEqual([arrow.from, arrow.to, arrow.role, arrow.t, arrow.replyAt, arrow.latencyMs], ['a', 'b', 'request', loop.exchanges[0].t, replyAt, replyAt - loop.exchanges[0].t])
  assert.equal(win.exchanges.find(item => item.role === 'reply').replyTo, request.exchangeId)
  // "You asked" has the answer time from the turn it started, not from a reply the core cannot see.
  const ask = win.exchanges.find(item => item.role === 'user' && item.to === 'a')
  assert.equal(ask.t, askAt)
  assert.equal(ask.answerAt, first.record.t1)
  // The Bots' names come from the host's team.
  assert.deepEqual(win.lanes.filter(lane => lane.kind === 'bot').map(lane => lane.name), ['Chief', 'Writer'])
})

test('off by default (#281): without enabled: true nothing is recorded, written or served', async (t) => {
  const h = await start({ enabled: undefined })
  t.after(h.stop)
  const loop = agentLoop(h.ctx)
  loop.deliver('a', { kind: 'user' }, 'hello')
  await loop.turn('a', 'hello')
  await sleep(120)
  const answer = await h.call('timeline/window', {})
  assert.ok(answer.error, `the endpoint must not exist: ${JSON.stringify(answer).slice(0, 120)}`)
  assert.deepEqual(existsSync(h.dir) ? readdirSync(h.dir) : [], [])
  assert.equal(h.plugin.enabled, undefined)
})

test('no prompt, tool argument or model output reaches the trace on disk', async (t) => {
  const h = await start()
  t.after(h.stop)
  const loop = agentLoop(h.ctx)
  loop.deliver('a', { kind: 'user' }, '转告 Writer: 写首诗 sk-live-0123456789abcdef-SECRET')
  const first = await loop.turn('a', '转告 Writer: 写首诗 sk-live-0123456789abcdef-SECRET')
  await loop.turn('b', `[Message from Chief]\n${first.sent[0].text}`)
  loop.deliver('b', { kind: 'user' }, '搜索：天气secretquery')
  await loop.turn('b', '搜索：天气secretquery')
  await sleep(120) // let the flush interval write
  h.plugin.dispose()
  const files = readdirSync(h.dir)
  assert.ok(files.some(name => name.endsWith('.jsonl') || name.includes('trace')), `trace files: ${files}`)
  const all = files.filter(name => !name.endsWith('.lock')).map(name => readFileSync(join(h.dir, name), 'utf8')).join('\n')
  assert.match(all, /web_search/)
  for (const secret of ['写首诗', 'SECRET', 'sk-live', '天气', 'secretquery', '给 Chief 的回复']) assert.ok(!all.includes(secret), `trace must not contain ${secret}`)
})

test('dispose stops recording, removes the endpoint and releases the writer lock', async (t) => {
  const h = await start()
  t.after(h.stop)
  const loop = agentLoop(h.ctx)
  await loop.turn('a', 'hello')
  assert.equal((await h.call('flybot/timeline/window', {})).turns.length, 1)
  h.plugin.dispose()
  loop.emit('a', 'turn/start', { turn: 99 })
  loop.emit('a', 'turn/end', { turn: 99, reason: { kind: 'completed' } })
  const after = await h.call('flybot/timeline/window', {})
  assert.ok(after.error !== undefined || after.turns?.length === 1, 'the endpoint is gone or still shows only the first turn')
  const again = openTrace({ dir: h.dir, persist: true })
  again.close()
})

test('a second dsh on the same trace keeps answering from memory and does not write', async (t) => {
  const first = await start()
  t.after(first.stop)
  const second = await start({ dir: first.dir })
  t.after(second.stop)
  const loop = agentLoop(second.ctx)
  await loop.turn('a', 'hello')
  assert.equal((await second.call('flybot/timeline/window', {})).turns.length, 1)
  assert.equal((await second.call('flybot/timeline/window', {})).trace.persisting, false)
  assert.equal((await first.call('flybot/timeline/window', {})).trace.persisting, true)
})
