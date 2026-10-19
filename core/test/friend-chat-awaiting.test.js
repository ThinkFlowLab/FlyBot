import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { install } from '../src/host/remote-chat.js'

// #443: one thinking row from my send until the friend's reply lands.

function rig() {
  const state = { bots: { r1: { id: 'r1', name: '测试', remote: { handle: '@bot-1.danyang.home', home: '@danyang.home', plugin: 'social' } } } }
  let adapter
  const saves = []
  const rt = { state, save: async () => { saves.push(JSON.stringify(state.remoteAwaiting ?? {})) }, warn() {}, ctx: { llm: { registerAdapter: (_, a) => { adapter = a } } } }
  install(rt)
  return { state, rt, saves, run: async (messages) => { let text = ''; for await (const ev of adapter.stream({ model: '@bot-1.danyang.home', messages })) if (ev.type === 'text-delta') text += ev.text; return text } }
}

test('a sent message marks the chat as waiting; the friend\'s reply (echo turn) clears it', async () => {
  const { state, rt, saves, run } = rig()
  let sent = 0
  rt.remoteChats.onSend('social', async () => { sent++ })
  assert.equal(await run([{ role: 'user', id: 'm1', content: [{ type: 'text', text: 'Hi' }] }]), '')
  assert.equal(sent, 1)
  assert.equal(typeof state.remoteAwaiting.r1, 'number', 'waiting from the send')
  assert.ok(saves.at(-1).includes('r1'), 'saved before the send turn ends, so the roster has it')
  assert.equal(await run([{ role: 'user', id: 'm2', content: [], source: { kind: 'bot', form: 'remote-chat', text: 'Hi again!' } }]), 'Hi again!')
  assert.equal(state.remoteAwaiting.r1, undefined, 'the reply hands over from the thinking row')
})

test('a send that fails does not leave the chat waiting', async () => {
  const { state, rt, run } = rig()
  rt.remoteChats.onSend('social', async () => { throw new Error('Bot Social send_as_member: HTTP 429') })
  assert.match(await run([{ role: 'user', id: 'm1', content: [{ type: 'text', text: 'Hi' }] }]), /^Not sent:/)
  assert.equal(state.remoteAwaiting?.r1, undefined)
})

test('the roster carries remoteAwaiting and the activity row keeps one row with the friend\'s mark', async () => {
  const channel = readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  assert.match(channel, /remoteAwaiting: state\.remoteAwaiting \?\? \{\}/)
  const row = await import('../src/client/awaiting.js')
  const src = readFileSync(new URL('../src/client/activity-row.js', import.meta.url), 'utf8')
  assert.match(src, /\(awaiting && !running\)/, 'the row stays up between the send turn and the reply turn')
  assert.match(src, /'data-carry'/, 'moving between hosts is no second entrance')
  {
    const roster = at => ({ remoteAwaiting: { r1: at }, byId: { r1: { remote: { handle: '@a.b.home' } }, c: {} } })
    assert.equal(row.awaitingReply(roster(1000), 'r1', 2000), true)
    assert.equal(row.awaitingReply(roster(1000), 'r1', 1000 + row.AWAIT_REPLY_MS + 1), false, 'a reply that never comes lets the row go')
    assert.equal(row.awaitingReply({ remoteAwaiting: { c: 1000 }, byId: { c: {} } }, 'c', 2000), false, 'only friend chats wait')
  }
})
