import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteTurn, isRemoteChat, REMOTE_PROVIDER, install, notSentLine } from '../src/host/remote-chat.js';
import { isHomeLevelRemote, isListedRemoteChat, isShownRemoteChat } from '../src/shared/remote-label.js';
import { feishuReply } from '../src/host/connectors.js';

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

// #971: the peer withdrew `chat.public` — the same situation as "not shared", so the same one line,
// with no internal capability name and no "Try again." (nothing about it can change until the owner acts).
test('#971: a send the peer no longer grants reads as one line with no retry, never the server wording', () => {
    const shared = new Error('Coder (Bob) is not shared with your Bots, so the message was not delivered. Bot Social told its owner, who can share it with you. Sending again will not help until then.')
    assert.equal(notSentLine(shared), 'Not sent: ' + shared.message)
    const raw = Object.assign(new Error('Bot Social send_as_member: peer has not granted chat.public'), { code: 'capability_not_granted' })
    const line = notSentLine(raw)
    assert.doesNotMatch(line, /chat\.public|Try again|capability_not_granted|send_as_member/)
    assert.match(line, /no longer shared with you/)
    assert.equal(line, 'Not sent: this Bot is no longer shared with you, so messages to it cannot be delivered. Ask its owner for a new invite.')
})

// #988: the same code covers capabilities that are not a withdrawn share. A profile.read refusal,
// and a bare capability_not_granted with no sentence, stay ordinary failures. Dropping the
// chat.public sentence match above turns that case back into "Try again."
test('#988: a capability other than chat.public is not rewritten as not shared', () => {
    const profile = Object.assign(new Error('Bot Social send_as_member: peer has not granted profile.read'), { code: 'capability_not_granted' })
    const profileLine = notSentLine(profile)
    assert.match(profileLine, /peer has not granted profile\.read/)
    assert.match(profileLine, /Try again/)
    assert.doesNotMatch(profileLine, /not shared|no longer shared/)
    const calendar = Object.assign(new Error('Bot Social send_as_member: peer has not granted calendar.freebusy.read'), { code: 'capability_not_granted' })
    assert.match(notSentLine(calendar), /calendar\.freebusy\.read/)
    assert.doesNotMatch(notSentLine(calendar), /not shared|no longer shared/)
    const bare = Object.assign(new Error('Bot Social send_as_member: something odd happened'), { code: 'capability_not_granted' })
    const bareLine = notSentLine(bare)
    assert.match(bareLine, /Try again/)
    assert.doesNotMatch(bareLine, /not shared|no longer shared/)
})

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

// #1266 INC (Reviewer): the whole exit of a Feishu answer, composed. A `feishu:` chat carries the
// feishu plugin, the plugin's sender is the one `connectors.js` registers, and a message typed into
// that chat leaves on the webhook — not as "Not sent: the plugin that reaches this Bot is not running."
test('a reply typed into a feishu chat leaves on the Feishu webhook (#1266)', async () => {
  const state = { bots: { f1: { id: 'f1', name: '飞书 Owner', remote: { handle: 'feishu:oc_chat_1', plugin: 'feishu' } } } }
  let adapter
  const posts = []
  const rt = { state, load: async () => {}, save: async () => {}, warn() {}, ctx: { llm: { registerAdapter: (_, a) => { adapter = a } } } }
  install(rt)
  rt.remoteChats.onSend('feishu', feishuReply({
    secretValue: name => (name === 'FEISHU_WEBHOOK' ? 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' : undefined),
    post: async (webhook, text) => { posts.push([webhook, text]); return { ok: true } },
  }))
  let said = ''
  for await (const event of adapter.stream({ model: 'feishu:oc_chat_1', messages: [{ role: 'user', id: 'm1', content: [{ type: 'text', text: 'the answer' }] }] })) {
    if (event.type === 'text-delta') said += event.text
  }
  assert.equal(said, '', 'nothing is drawn for a send that left')
  assert.deepEqual(posts, [['https://open.feishu.cn/open-apis/bot/v2/hook/abc', 'the answer']])
})

// #1979: the remote home's own error text is cut at 157 units and ends in "…"; a cut that lands
// between the halves of a surrogate pair hands the owner a lone high surrogate.
test('#1979: a long remote error keeps a well-formed 157-unit tail before the ellipsis', () => {
    const raw = 'Not sent: ' + 'a'.repeat(146) + '😀' + 'tail';
    assert.ok(raw.length > 160, 'the long-line branch only runs past 160 units');
    const line = notSentLine(new Error(raw));
    assert.equal(line.isWellFormed(), true, 'the preview is well formed, never a lone high surrogate');
    assert.ok(line.endsWith('…'), 'the long line still ends in the ellipsis');
    const kept = line.slice(0, -1);
    assert.equal(kept, 'Not sent: ' + 'a'.repeat(146), 'the pair at the bound is dropped, not split');
    assert.ok(raw.startsWith(kept), 'a code-point prefix of what the remote home wrote');
    assert.ok(kept.length <= 157, 'the budget of 157 UTF-16 units is unchanged');
});

// #1979: a remote reply is abbreviated to 80 units before the trailing-period strip, so an emoji at
// the bound must not leave a lone high surrogate in the sentence the owner reads.
test('#1979: an abbreviated remote reply is well formed at 80 units', () => {
    const body = 'the remote said ' + 'a'.repeat(63) + '😀' + 'tail';
    const kept = 'the remote said ' + 'a'.repeat(63);
    assert.equal(kept.length, 79, 'the pair starts at unit 79, so a plain slice(0, 80) keeps half of it');
    const line = notSentLine(new Error('Bot Social send_as_member: ' + body));
    assert.equal(line.isWellFormed(), true, 'the sentence is well formed, never a lone high surrogate');
    assert.equal(line, 'Not sent: ' + kept + '. Try again.', 'the pair at the bound is dropped, not split');
    assert.ok(body.startsWith(kept), 'a code-point prefix of the reply');
});
