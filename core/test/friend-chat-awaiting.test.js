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
  assert.match(src, /running \? sendRun\.current : awaiting/, 'the row stays up between the send turn and the reply turn')
  assert.match(src, /'data-carry'/, 'moving between hosts is no second entrance')
  {
    const roster = at => ({ remoteAwaiting: { r1: at }, byId: { r1: { remote: { handle: '@a.b.home' } }, c: {} } })
    assert.equal(row.awaitingReply(roster(1000), 'r1', 2000), true)
    assert.equal(row.awaitingReply(roster(1000), 'r1', 1000 + row.AWAIT_REPLY_MS + 1), false, 'a reply that never comes lets the row go')
    assert.equal(row.awaitingReply({ remoteAwaiting: { c: 1000 }, byId: { c: {} } }, 'c', 2000), false, 'only friend chats wait')
  }
})

test('the row between turns is not hidden by the turn-tail rules, and the echo turn never shows it (#443 follow-up)', () => {
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  // The tail hides everything but its slot, and an empty tail item hides itself: both spare the row.
  assert.match(css, /\[data-turn-tail\]>:not\(\[data-slot="conversation\.chat\.turnTail"\]\):not\(\.bt-typing\)\{display:none!important\}/)
  assert.match(css, /\[data-chat-flow-kind="turn-tail"\]:not\(:has\(\[data-slot="conversation\.chat\.turnTail"\]:not\(:empty\)\)\):not\(:has\(\[data-turn-tail\]>\.bt-typing\)\)\{display:none!important\}/)
  const src = readFileSync(new URL('../src/client/activity-row.js', import.meta.url), 'utf8')
  assert.match(src, /\? !streaming && \(running \? sendRun\.current : awaiting && !replied\)/, 'a friend chat shows the row for my send and the wait, not for the echo')
})

test('the reply turn hides the row at once; only the end of my send turn gets the grace (#443 follow-up)', () => {
  const src = readFileSync(new URL('../src/client/activity-row.js', import.meta.url), 'utf8')
  assert.match(src, /const steady = bridging/)
  assert.match(src, /lastRun\.current\.running && lastRun\.current\.send && !running/)
})

test('a friend\'s reply arriving clears the wait before it is written into the chat (#443 follow-up)', async () => {
  const { state, rt } = rig()
  state.remoteAwaiting = { r1: 1 }
  let seen
  rt.botOf = () => state.bots.r1
  rt.chatOf = () => ({})
  rt.resolveAgent = async () => ({ followup() { seen = { ...state.remoteAwaiting } }, session: {} })
  rt.ctx.sessions = { flush: async () => {} }
  await rt.remoteChats.deliver({ handle: '@bot-1.danyang.home', text: 'hi' })
  assert.deepEqual(seen, {}, 'cleared before the reply is followed up')
})

test('a reply drawn in a later turn than my send ends the wait on screen, ahead of the roster (#443 follow-up)', () => {
  const src = readFileSync(new URL('../src/client/activity-row.js', import.meta.url), 'utf8')
  assert.match(src, /awaiting && !replied/)
  assert.match(src, /lastTurnOnScreen\('assistant-step'\) > sendTurn\.current/)
})
