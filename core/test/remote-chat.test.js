import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteTurn, isRemoteChat, REMOTE_PROVIDER, install, notSentLine } from '../src/host/remote-chat.js';
import { isHomeLevelRemote, isListedRemoteChat, isShownRemoteChat } from '../src/shared/remote-label.js';

const user = (content, source, id = 'm1') => ({ role: 'user', id, content, ...(source ? { source } : {}) });

test('typed user text is sent to the remote bot', () => {
    const t = remoteTurn([user('hi there')]);
    assert.equal(t.kind, 'send');
});

test('relayed remote text is echoed, not re-sent', () => {
    const t = remoteTurn([user('<fenced/>', { kind: 'bot', form: 'remote-chat', text: 'pong' })]);
    assert.equal(t.kind, 'echo');
    assert.equal(t.text, 'pong');
});

test('other sources and empty history do nothing', () => {
    assert.equal(remoteTurn([user('x', { kind: 'bot', form: 'other' })]).kind, 'none');
    assert.equal(remoteTurn([]).kind, 'none');
});

test('remote chats are recognised by their remote field', () => {
    assert.equal(isRemoteChat({ remote: { handle: '@a.b.home' } }), true);
    assert.equal(isRemoteChat({ name: 'x' }), false);
    assert.equal(REMOTE_PROVIDER, 'flybot-remote');
});

test('sync hides gone and home-level remotes without deleting the chat', async () => {
  assert.equal(isHomeLevelRemote({ handle: '@friend.home', home: '@friend.home' }), true)
  const state = {
    bots: {
      a: { id: 'a', name: 'Chief', remote: { handle: '@chief.hsliu.home', home: '@hsliu.home', plugin: 'social' } },
      b: { id: 'b', name: 'Friend', remote: { handle: '@friend.home', home: '@friend.home', plugin: 'social' } },
      c: { id: 'c', name: '助手', remote: { handle: '@assistant.friend.home', home: '@friend.home', plugin: 'social' } },
    },
  }
  const rt = { state, load: async () => {}, save: async () => {}, warn() {}, ctx: {} }
  install(rt)
  await rt.remoteChats.sync('social', [
    { handle: '@chief.hsliu.home', name: 'Chief', home: '@hsliu.home', homeName: 'hsliu' },
  ])
  assert.equal(state.bots.a.remote.gone, undefined)
  assert.equal(state.bots.a.hidden, undefined)
  assert.equal(state.bots.b.remote.gone, true)
  // #956: leaving the published list is `remote.gone`, never a `hidden` of the user's.
  assert.equal(state.bots.b.hidden, undefined)
  assert.equal(isShownRemoteChat(state.bots.b), true)
  assert.equal(state.bots.c.remote.gone, true)
  assert.equal(state.bots.c.hidden, undefined)
  assert.equal(isShownRemoteChat(state.bots.c), true)
  assert.equal(state.bots.b.name, 'Friend')
  await rt.remoteChats.sync('social', [
    { handle: '@chief.hsliu.home', name: 'Chief', home: '@hsliu.home' },
    { handle: '@assistant.friend.home', name: '助手', home: '@friend.home', homeName: 'Friend' },
  ])
  assert.equal(state.bots.c.remote.gone, undefined)
  assert.equal(state.bots.c.hidden, undefined)
  await rt.remoteChats.sync('social', [
    { handle: '@CHIEF.hsliu.home', name: 'Chief', home: '@HSLIU.home' },
  ])
  assert.equal(state.bots.a.remote.gone, undefined)
  assert.equal(state.bots.a.hidden, undefined)
  assert.equal(state.bots.c.remote.gone, true)
  assert.equal(isShownRemoteChat(state.bots.c), true)
})

test('sync keeps a chat the user hid while the Bot is still published', async () => {
  const state = {
    bots: {
      a: { id: 'a', name: 'Chief', remote: { handle: '@chief.hsliu.home', home: '@hsliu.home', plugin: 'social' } },
      b: { id: 'b', name: '助手', hidden: true, remote: { handle: '@assistant.friend.home', home: '@friend.home', plugin: 'social' } },
    },
  }
  const rt = { state, load: async () => {}, save: async () => {}, warn() {}, ctx: {} }
  install(rt)
  await rt.remoteChats.sync('social', [
    { handle: '@chief.hsliu.home', name: 'Chief', home: '@hsliu.home' },
    { handle: '@assistant.friend.home', name: '助手', home: '@friend.home' },
  ])
  // A friend's chat hidden from the sidebar stays hidden; only leaving the published list does (#hide).
  assert.equal(state.bots.b.remote.gone, undefined)
  assert.equal(state.bots.b.hidden, true)
})

// #631: `hidden` alone cannot tell "the user hid this" from "we hid this because the Bot left".
test('a hide the user set survives the Bot leaving the published list and coming back', async () => {
  const state = {
    bots: {
      b: { id: 'b', name: '助手', hidden: true, remote: { handle: '@assistant.friend.home', home: '@friend.home', plugin: 'social' } },
    },
  }
  const rt = { state, load: async () => {}, save: async () => {}, warn() {}, ctx: {} }
  install(rt)
  const member = { handle: '@assistant.friend.home', name: '助手', home: '@friend.home' }
  await rt.remoteChats.sync('social', [member])
  assert.equal(state.bots.b.hidden, true)
  await rt.remoteChats.sync('social', [])
  assert.equal(state.bots.b.remote.gone, true)
  assert.equal(state.bots.b.hidden, true)
  // A hide the user set keeps the row out of the sidebar, gone or not (#611).
  assert.equal(isShownRemoteChat(state.bots.b), false)
  await rt.remoteChats.sync('social', [member])
  assert.equal(state.bots.b.remote.gone, undefined)
  // The hide was the user's, so the return must not drop it.
  assert.equal(state.bots.b.hidden, true)
  assert.equal(state.bots.b.remote.hiddenByGone, undefined)
})

test('#956: a chat whose Bot left keeps its row in the sidebar, and comes back as an ordinary one', async () => {
  const state = {
    bots: {
      b: { id: 'b', name: '助手', remote: { handle: '@assistant.friend.home', home: '@friend.home', plugin: 'social' } },
    },
  }
  const rt = { state, load: async () => {}, save: async () => {}, warn() {}, ctx: {} }
  install(rt)
  const member = { handle: '@assistant.friend.home', name: '助手', home: '@friend.home' }
  await rt.remoteChats.sync('social', [])
  assert.equal(state.bots.b.remote.gone, true)
  assert.equal(state.bots.b.hidden, undefined)
  assert.equal(isShownRemoteChat(state.bots.b), true)
  await rt.remoteChats.sync('social', [member])
  assert.equal(state.bots.b.remote.gone, undefined)
  assert.equal(state.bots.b.hidden, undefined)
  assert.equal(state.bots.b.remote.hiddenByGone, undefined)
  assert.equal(isShownRemoteChat(state.bots.b), true)
})

// A state file written before #956 carries the hide we imposed as a real `hidden`. The next sync
// takes it back, so the row returns without the user doing anything.
test('#956: a hide a previous version imposed is taken back on the next sync', async () => {
  const state = {
    bots: {
      b: { id: 'b', name: '助手', hidden: true, remote: { handle: '@assistant.friend.home', home: '@friend.home', plugin: 'social', gone: true, hiddenByGone: true } },
    },
  }
  const rt = { state, load: async () => {}, save: async () => {}, warn() {}, ctx: {} }
  install(rt)
  await rt.remoteChats.sync('social', [])
  assert.equal(state.bots.b.remote.gone, true)
  assert.equal(state.bots.b.hidden, undefined)
  // The marker goes with the hide it explains: it has that one use, and a marker left behind makes a
  // later Hide from sidebar read as ours, so the next sync would delete the user's hide.
  assert.equal(state.bots.b.remote.hiddenByGone, undefined)
  assert.equal(isShownRemoteChat(state.bots.b), true)
  await rt.remoteChats.sync('social', [{ handle: '@assistant.friend.home', name: '助手', home: '@friend.home' }])
  assert.equal(state.bots.b.remote.gone, undefined)
  assert.equal(state.bots.b.hidden, undefined)
  assert.equal(isShownRemoteChat(state.bots.b), true)
})

// The repair above must leave the chat exactly as it found it, so the user's own Hide works from then
// on: set after the repair, it survives the next sync and the Bot coming back (#611, #303, #956).
test('#956: a hide the user sets after the repair keeps the row out, and the Bot coming back changes nothing', async () => {
  const state = {
    bots: {
      b: { id: 'b', name: '助手', hidden: true, remote: { handle: '@assistant.friend.home', home: '@friend.home', plugin: 'social', gone: true, hiddenByGone: true } },
    },
  }
  const rt = { state, load: async () => {}, save: async () => {}, warn() {}, ctx: {} }
  install(rt)
  await rt.remoteChats.sync('social', [])
  assert.equal(isShownRemoteChat(state.bots.b), true)
  state.bots.b.hidden = true
  await rt.remoteChats.sync('social', [])
  assert.equal(state.bots.b.hidden, true)
  assert.equal(isShownRemoteChat(state.bots.b), false)
  assert.equal(state.bots.b.remote.gone, true)
  await rt.remoteChats.sync('social', [{ handle: '@assistant.friend.home', name: '助手', home: '@friend.home' }])
  assert.equal(state.bots.b.remote.gone, undefined)
  assert.equal(state.bots.b.hidden, true)
  assert.equal(isShownRemoteChat(state.bots.b), false)
  assert.equal(isListedRemoteChat(state.bots.b), false)
})

test('roster and model guards keep a friend\'s Bot on its relay route', async () => {
    const { readFileSync } = await import('node:fs')
    const src = f => readFileSync(new URL('../src/host/' + f, import.meta.url), 'utf8')
    assert.match(src('models.js'), /bot\.remote\?\.handle\) return `flybot-remote\//)
    assert.match(src('roster.js'), /bot\.remote !== undefined\) \{ delete patch\.model/)
})

test('a time-context snapshot appended after the typed text does not swallow it', () => {
    const clock = user('Current time: 2026-10-14, 19:47:33 GMT+08:00 (Asia/Shanghai).', { kind: 'ds-bot-time-context', form: 'snapshot', sections: [] }, 'm2');
    const t = remoteTurn([user('hi', { kind: 'user' }), clock]);
    assert.equal(t.kind, 'send');
    assert.equal(t.text, 'hi');
    assert.equal(t.messageId, 'm1');
});

test('a failed 1:1 send is one short English line with a next step', () => {
    assert.equal(
        notSentLine(Object.assign(new Error('Bot Social send_as_member: HTTP 403'), { code: 'http_403' })),
        'Not sent: this Bot cannot be reached right now. Invite it from Bot settings, or try again.',
    )
    assert.equal(
        notSentLine(new Error('Bot Social send_as_member: no answer in 8s')),
        'Not sent: Bot Social did not answer. Try again.',
    )
    assert.match(notSentLine(new Error('Chief has no grant to that Bot, so it cannot message friends\' Bots')), /Invite them from Bot settings/)
    assert.match(notSentLine(new Error('Chief is not shared with that friend, so it cannot message their Bots. To allow it, share Chief with them in its settings → Sharing.')), /Invite them from Bot settings/)
    assert.match(notSentLine(new Error('no Bot of yours is friends with @x.y.home')), /Add them from \+ Add friend/)
    assert.equal(notSentLine(new Error('Not sent: already friendly.')), 'Not sent: already friendly.')
    // #404: a paused chat and an unknown failure name only steps a FlyBot owner can take.
    assert.equal(notSentLine(new Error('Bot Social paused this conversation (turn budget exhausted)')), 'Not sent: this chat is paused. Approve any message waiting here, or remove and re-add this friend to start a new chat.')
    // The plugin's pause says to send again: the next send opens a fresh chat; nothing names Extend or turns.
    assert.equal(notSentLine(Object.assign(new Error('Bot Social paused that chat (loop detected). Send your message again: it starts a new chat.'), { code: 'conversation_paused', resend: true })), 'Not sent: Bot Social paused that chat. Send your message again: it starts a new chat.')
    assert.doesNotMatch(notSentLine(Object.assign(new Error('paused'), { resend: true })), /Extend|turns/)
    // #954: a Bot that no longer exists says one sentence with the next step, names the Bot when the sender
    // knows which one it is, and never repeats "Try again." (the plugin's sentence already ended the line).
    const gone = notSentLine(Object.assign(new Error('Bot Social send_as_member: no such remote bot'), { code: 'bot_not_found', handle: '@coder.bob.home' }))
    assert.equal(gone, 'Not sent: @coder.bob.home is no longer shared with you, so messages to it cannot be delivered. Ask its owner for a new invite.')
    assert.doesNotMatch(gone, /no such remote bot|Try again/)
    const relayed = notSentLine(Object.assign(new Error('Coder (Bob) (@coder.bob.home) is no longer shared with you, so messages to it cannot be delivered. Ask its owner for a new invite.'), { code: 'bot_not_found', handle: '@coder.bob.home' }))
    assert.equal(relayed, 'Not sent: Coder (Bob) (@coder.bob.home) is no longer shared with you, so messages to it cannot be delivered. Ask its owner for a new invite.')
    // One "Try again." only, whatever the layer below already wrote (#954).
    assert.equal(notSentLine(new Error('Bot Social send_as_member: gateway hiccup. Try again.')), 'Not sent: gateway hiccup. Try again.')
    assert.equal(notSentLine(new Error('Bot Social send_as_member: weird_code')), 'Not sent: the message could not leave. Try again.')
    assert.doesNotMatch(notSentLine(new Error('something odd happened')), /console/)
});

test('agent-instructions and notice messages after the typed text do not swallow it', () => {
    const baseline = user([{ type: 'text', text: '<system-reminder>AGENTS.md ...</system-reminder>' }],
        { kind: 'agent-instructions', form: 'instructions', baseline: true, changes: [] }, 'm2');
    const notice = user('plan mode on', { kind: 'plan-mode', form: 'notice' }, 'm3');
    for (const extra of [[baseline], [baseline, notice]]) {
        const t = remoteTurn([user('hi', { kind: 'user' }), ...extra]);
        assert.equal(t.kind, 'send'); assert.equal(t.text, 'hi'); assert.equal(t.messageId, 'm1');
    }
    assert.equal(remoteTurn([user('<f/>', { kind: 'bot', form: 'remote-chat', text: 'pong' }), baseline]).kind, 'echo');
    assert.equal(remoteTurn([baseline]).kind, 'none');
});

test('a line Bot Social attests the friend typed themselves carries the person\'s name; a plain line does not', async () => {
  const state = { bots: { a: { id: 'a', name: 'Coder', remote: { handle: '@coder.bob.home', home: '@bob.home', plugin: 'social' } } } }
  const followups = []
  const rt = {
    state, load: async () => {}, save: async () => {}, warn() {},
    ctx: { sessions: { flush: async () => {} } },
    botOf: id => state.bots[id],
    chatOf: id => ({ id }),
    resolveAgent: async () => ({ session: 's', followup: message => followups.push(message) }),
  }
  install(rt)
  const base = { handle: '@coder.bob.home', name: 'Coder', home: '@bob.home', plugin: 'social' }
  await rt.remoteChats.deliver({ ...base, text: 'typed it', human: true, ownerName: 'Bob' })
  await rt.remoteChats.deliver({ ...base, text: 'bot line', ownerName: 'Bob' })
  await rt.remoteChats.deliver({ ...base, text: 'no name', human: true })
  assert.deepEqual(followups.map(message => message.source.typedBy), ['Bob', undefined, undefined])
  assert.equal(followups[0].source.form, 'remote-chat')
  assert.equal(followups[1].source.text, 'bot line')
})
