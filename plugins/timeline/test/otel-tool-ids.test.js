// A tool call's id is unique inside its turn, not across turns: the recorder writes `ks`/`ke`
// with both `id` and `tid`, and the window folds them under `${tid}/${id}` (src/window.js). Two
// turns of one trace — two Bots, or a provider that numbers its calls per request — can both call
// a tool `call_0`. The exporter keyed its tool records by `id` alone, so the later turn's start
// replaced the earlier one: one tool span left the batch, its parent was the wrong turn, and an
// open call in the earlier turn was not carried to the next push. Both halves are read here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pendingRecords, spansFrom } from '../src/otel.js'

const records = [
  { r: 'ts', t: 1000, id: 'turn-a', bot: 'a', pl: 'dm' },
  { r: 'ks', t: 1001, id: 'call_0', tid: 'turn-a', nm: 'read', bot: 'a' },
  { r: 'ke', t: 1005, id: 'call_0', tid: 'turn-a', ok: true },
  { r: 'te', t: 1010, id: 'turn-a', o: 'completed' },
  { r: 'ts', t: 2000, id: 'turn-b', bot: 'b', pl: 'dm' },
  { r: 'ks', t: 2001, id: 'call_0', tid: 'turn-b', nm: 'bash', bot: 'b' },
  { r: 'ke', t: 2009, id: 'call_0', tid: 'turn-b', ok: false },
  { r: 'te', t: 2020, id: 'turn-b', o: 'completed' },
]

const agentOf = span => span.attributes.find(attr => attr.key === 'gen_ai.agent.id')?.value?.stringValue

test('two turns that both call a tool with the same call id export one tool span each', () => {
  const spans = spansFrom(records)
  const tools = spans.filter(span => span.name.startsWith('execute_tool'))
  assert.equal(tools.length, 2, `one span per tool call, saw ${tools.map(span => span.name).join(', ') || 'none'}`)
  assert.deepEqual(tools.map(span => span.name).sort(), ['execute_tool bash', 'execute_tool read'])
  assert.equal(new Set(tools.map(span => span.spanId)).size, 2, 'the two calls need two span ids')
  // Each tool span hangs under its own turn's span, not the other turn's.
  const turnSpanOf = new Map(spans.filter(span => span.name.startsWith('invoke_agent')).map(span => [agentOf(span), span.spanId]))
  for (const tool of tools) assert.equal(tool.parentSpanId, turnSpanOf.get(agentOf(tool)), `${tool.name} hangs under its own turn`)
})

test('a tool call still open in an earlier turn is carried, not replaced by a later one', () => {
  const open = pendingRecords([
    { r: 'ts', t: 1, id: 'turn-a' },
    { r: 'ks', t: 2, id: 'call_0', tid: 'turn-a', nm: 'read' },
    { r: 'ts', t: 3, id: 'turn-b' },
    { r: 'ks', t: 4, id: 'call_0', tid: 'turn-b', nm: 'bash' },
  ])
  assert.deepEqual(open.filter(record => record.r === 'ks').map(record => record.tid).sort(), ['turn-a', 'turn-b'])
})
