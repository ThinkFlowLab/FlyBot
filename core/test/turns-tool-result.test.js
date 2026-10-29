import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/turns.js'

// The running Bot's tool chip is cleared from the same `tool/result` read that closes the
// steer line's wait (#1644), so the payload shapes are pinned here too.
function turnsHost() {
  let listener
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map([['b', 'b']]),
    botOf: id => ({ id, name: id }),
    selfOf: id => id,
    save: async () => {},
    deliver: async () => {},
    noteFailure() {},
    warn() {},
    switchJobs: () => [],
    flybotReplyRemote: async () => ({}),
  }
  install(rt)
  let seq = 0
  const emit = (type, data) => listener({ id: 'b' }, { type, seq: ++seq, data })
  return { rt, emit }
}

const toolResult = (callId) => ({ message: { role: 'tool', toolCallId: callId, isError: false, content: [] } })

test("a tool result in the host's shape clears the running tool (#1644)", () => {
  const { rt, emit } = turnsHost()
  emit('turn/start', { turn: 1 })
  emit('tool/call', { callId: 'c1', name: 'bash' })
  assert.equal(rt.workView().b.tool, 'bash')
  emit('tool/result', toolResult('c1'))
  assert.equal(rt.liveOf('b').calls?.size ?? 0, 0)
  assert.equal(rt.workView().b.tool, undefined)
})

test('a result that names its call id at the top of data still clears the running tool', () => {
  const { rt, emit } = turnsHost()
  emit('turn/start', { turn: 1 })
  emit('tool/call', { callId: 'c1', name: 'bash' })
  emit('tool/result', { callId: 'c1' })
  assert.equal(rt.liveOf('b').calls?.size ?? 0, 0)
  assert.equal(rt.workView().b.tool, undefined)
})
