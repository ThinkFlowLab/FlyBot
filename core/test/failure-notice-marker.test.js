// #2677: a workflow step used to be failed whenever its own answer quoted the failure
// sentence. The host's notice now says structurally that the turn failed, so a reader does
// not have to parse the text it may be auditing.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install as installTurns } from '../src/host/turns.js'
import { SOURCE_KIND } from '../src/host/constants.js'

function turnsHost() {
  let listener
  const delivered = []
  const rt = {
    ctx: { on: (name, fn) => { if (name === 'session/event') listener = fn } },
    state: { exchangeTurns: {}, questions: {} },
    bots: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } },
    isBotSession: () => true,
    roomOf: () => undefined,
    groupOwners: new Map(),
    chatOwners: new Map(),
    botOf: id => rt.bots[id],
    selfOf: id => id,
    save: async () => {},
    deliver: async (args) => { delivered.push(args) },
    noteFailure() {},
    warn() {},
    switchJobs: () => [],
  }
  installTurns(rt)
  let seq = 0
  const emit = (id, type, data) => listener({ id }, { type, seq: ++seq, data })
  return { emit, delivered }
}

const replySource = (extra = {}) => ({ kind: SOURCE_KIND, role: 'request', senderSessionId: 'a', senderName: 'Chief', exchangeId: 'e1', hop: 0, ...extra })
const textBlock = content => [{ type: 'text', text: content }]
const assistantText = text => ({ message: { content: textBlock(text) } })
const joined = host => {
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', { content: textBlock('write the letter'), source: { kind: 'user' } })
  host.emit('b', 'assistant/message', assistantText('first half'))
  host.emit('b', 'user/message', { content: textBlock('[Message from Chief]\nmore'), source: replySource() })
}

test('#2677: the failure notice carries the structural marker; a normal reply does not', () => {
  const failed = turnsHost()
  joined(failed)
  failed.emit('b', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: 'upstream busy', status: 503 } } })
  assert.equal(failed.delivered.length, 1)
  assert.equal(failed.delivered[0].failed, true)

  const answered = turnsHost()
  joined(answered)
  answered.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(answered.delivered.length, 1)
  assert.equal(answered.delivered[0].failed, undefined)
})
