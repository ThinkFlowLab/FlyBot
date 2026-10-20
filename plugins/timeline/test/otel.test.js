import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExporter, otlpPayload, pendingRecords, spansFrom } from '../src/otel.js'
import { createTimeline } from '../src/timeline.js'
import { parseOtlpUrl } from '../index.js'
import { mockAdapter } from './mock-adapter.js'

const names = { bots: { a: 'Chief', b: 'Writer' }, rooms: { r1: 'Team Room' } }
const turnRecords = [
  { r: 'ts', t: 1_000, id: 'a#1', pl: 'chat', bot: 'a', x: 'e1', ro: 'user' },
  { r: 'ks', t: 1_100, id: 'c1', tid: 'a#1', nm: 'web_search', bot: 'a' },
  { r: 'ke', t: 1_400, id: 'c1', tid: 'a#1', ok: true },
  { r: 'm', t: 1_500, id: 'e2', f: { k: 'b', id: 'a' }, to: { k: 'b', id: 'b' }, ro: 'request', hop: 1, n: 42 },
  { r: 'te', t: 1_600, id: 'a#1', o: 'completed' },
]

test('spansFrom builds only closed spans; an open turn or tool call yields nothing', () => {
  assert.deepEqual(spansFrom([{ r: 'ts', t: 1_000, id: 'a#1', pl: 'chat', bot: 'a' }]), [])
  assert.deepEqual(spansFrom([{ r: 'ks', t: 1_100, id: 'c1', tid: 'a#1', nm: 'x', bot: 'a' }]), [])
  const spans = spansFrom(turnRecords, { names })
  const byName = Object.fromEntries(spans.map(span => [span.name, span]))
  const turn = byName['invoke_agent Chief']
  assert.ok(turn, spans.map(s => s.name).join(','))
  assert.equal(turn.startTimeUnixNano, '1000000000')
  assert.equal(turn.endTimeUnixNano, '1600000000')
  assert.equal(turn.status.code, 1)
  const tool = byName['execute_tool web_search']
  assert.equal(tool.parentSpanId, turn.spanId, 'the tool span hangs under its turn span')
  assert.deepEqual(Object.fromEntries(tool.attributes.map(a => [a.key, a.value]))['flybot.tool.ok'], { boolValue: true })
})

test('pendingRecords returns the records whose span is not closed yet', () => {
  const open = pendingRecords([
    { r: 'ts', t: 1, id: 'a#1' }, { r: 'te', t: 2, id: 'a#1' },
    { r: 'ts', t: 3, id: 'a#2' },
    { r: 'ks', t: 4, id: 'c1', tid: 'a#2' },
  ])
  assert.deepEqual(open.map(record => [record.r, record.id]), [['ts', 'a#2'], ['ks', 'c1']])
})

test('a failed turn is error; no model name or token attributes are invented', () => {
  const spans = spansFrom([{ r: 'ts', t: 1_000, id: 'a#1', pl: 'chat', bot: 'a' }, { r: 'te', t: 1_600, id: 'a#1', o: 'error', ec: 'RATE_LIMIT' }], { names })
  assert.equal(spans[0].status.code, 2)
  assert.equal(spans[0].status.message, 'RATE_LIMIT')
  const keys = spans[0].attributes.map(a => a.key)
  assert.ok(!keys.some(key => key.startsWith('gen_ai.request') || key.startsWith('gen_ai.usage')))
})

test('names are off by default: a span carries ids, and names only when asked', () => {
  const closed = [{ r: 'ts', t: 1, id: 'a#1', pl: 'chat', bot: 'a', room: 'r1' }, { r: 'te', t: 2, id: 'a#1', o: 'completed' }]
  const ids = Object.fromEntries(spansFrom(closed, {})[0].attributes.map(a => [a.key, a.value]))
  assert.equal(ids['gen_ai.agent.id'].stringValue, 'a')
  assert.equal(ids['gen_ai.agent.name'], undefined)
  assert.equal(ids['flybot.room.name'], undefined)
  const named = Object.fromEntries(spansFrom(closed, { names })[0].attributes.map(a => [a.key, a.value]))
  assert.equal(named['gen_ai.agent.name'].stringValue, 'Chief')
})

test('createExporter holds an open turn, sends it once it closes, and never twice', async () => {
  const sent = []
  const exporter = createExporter({ send: async (payload, info) => sent.push({ payload, info }) })
  const open = [{ r: 'ts', t: 1_000, id: 'a#1', pl: 'chat', bot: 'a' }, { r: 'ks', t: 1_100, id: 'c1', tid: 'a#1', nm: 'web_search', bot: 'a' }]
  assert.equal(await exporter.push(open, names), 0, 'nothing closed yet')
  const full = [...open, { r: 'ke', t: 1_400, id: 'c1', tid: 'a#1', ok: true }, { r: 'te', t: 1_600, id: 'a#1', o: 'completed' }]
  assert.equal(await exporter.push(full, names), 2)
  assert.equal(await exporter.push(full, names), 0, 'the same spans are not sent twice')
  assert.equal(sent.length, 1)
  const spanNames = sent[0].payload.resourceSpans[0].scopeSpans[0].spans.map(s => s.name)
  assert.deepEqual(spanNames.sort(), ['execute_tool web_search', 'invoke_agent'])
})

test('createExporter retries the same closed spans after a failed send', async () => {
  let fail = true
  const exporter = createExporter({ send: async () => { if (fail) throw new Error('nope') }, warn: () => {} })
  const closed = [{ r: 'ts', t: 1, id: 'a#1', pl: 'chat', bot: 'a' }, { r: 'te', t: 2, id: 'a#1', o: 'completed' }]
  assert.equal(await exporter.push(closed), 0)
  fail = false
  assert.equal(await exporter.push(closed), 1)
  assert.equal(await exporter.push(closed), 0)
})

test('otlpPayload wraps spans in one resourceSpans with a service name', () => {
  const payload = otlpPayload(spansFrom(turnRecords, { names }), { serviceName: 'flybot-test', serviceVersion: '9.9.9' })
  const [resource] = payload.resourceSpans
  assert.equal(Object.fromEntries(resource.resource.attributes.map(a => [a.key, a.value]))['service.name'].stringValue, 'flybot-test')
  assert.equal(resource.scopeSpans[0].spans.length, 3)
})

test('parseOtlpUrl allows https anywhere and http only on the local host', () => {
  assert.equal(parseOtlpUrl('https://collector.example.com/v1/traces'), 'https://collector.example.com/v1/traces')
  assert.equal(parseOtlpUrl('http://localhost:4318/v1/traces'), 'http://localhost:4318/v1/traces')
  assert.equal(parseOtlpUrl('http://127.0.0.1:4318/v1/traces'), 'http://127.0.0.1:4318/v1/traces')
  assert.equal(parseOtlpUrl('http://collector.example.com/v1/traces'), undefined)
  assert.equal(parseOtlpUrl('ftp://x/v1/traces'), undefined)
  assert.equal(parseOtlpUrl('not a url'), undefined)
  assert.equal(parseOtlpUrl(''), undefined)
})

test('the plugin timeline exports through the configured send and nothing else changes', async () => {
  const adapter = mockAdapter()
  const sent = []
  const timeline = createTimeline(adapter, { persist: false, now: () => 5_000, exporter: { send: async (payload) => sent.push(payload), intervalMs: 1e9 } })
  adapter.feed('turn.start', { botId: 'a', place: 'chat', sessionId: 's1', turnId: 's1#1', turn: 1, time: 4_100, trigger: { exchangeId: 'x1', from: { kind: 'user' }, role: 'user', hop: 0 } })
  adapter.feed('tool.start', { botId: 'a', place: 'chat', sessionId: 's1', turnId: 's1#1', callId: 'c1', name: 'web_search', time: 4_200 })
  adapter.feed('tool.end', { botId: 'a', place: 'chat', sessionId: 's1', turnId: 's1#1', callId: 'c1', name: 'web_search', time: 4_700, ok: true })
  adapter.feed('turn.end', { botId: 'a', place: 'chat', sessionId: 's1', turnId: 's1#1', turn: 1, time: 4_900, outcome: 'completed' })
  assert.equal(await timeline.exportNow(), 2)
  assert.equal(sent.length, 1)
  const spans = sent[0].resourceSpans[0].scopeSpans[0].spans
  assert.deepEqual(spans.map(span => span.name).sort(), ['execute_tool web_search', 'invoke_agent'])
  timeline.dispose()
})

test('the on-demand export (#357) builds spans from the current trace, ids only unless asked', () => {
  const adapter = mockAdapter()
  const timeline = createTimeline(adapter, { persist: false, now: () => 5_000 })
  adapter.feed('turn.start', { botId: 'a', place: 'chat', sessionId: 's1', turnId: 's1#1', turn: 1, time: 4_100, trigger: { exchangeId: 'x1', from: { kind: 'user' }, role: 'user', hop: 0 } })
  adapter.feed('turn.end', { botId: 'a', place: 'chat', sessionId: 's1', turnId: 's1#1', turn: 1, time: 4_900, outcome: 'completed' })
  const spans = timeline.exportWindow().resourceSpans[0].scopeSpans[0].spans
  assert.equal(spans.length, 1)
  const attrs = Object.fromEntries(spans[0].attributes.map(a => [a.key, a.value]))
  assert.equal(attrs['gen_ai.agent.id'].stringValue, 'a')
  assert.equal(attrs['gen_ai.agent.name'], undefined, 'ids only by default')
  const named = timeline.exportWindow({ names: true }).resourceSpans[0].scopeSpans[0].spans
  assert.equal(Object.fromEntries(named[0].attributes.map(a => [a.key, a.value]))['gen_ai.agent.name'].stringValue, 'Chief')
  timeline.dispose()
})
