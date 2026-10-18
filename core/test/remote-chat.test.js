import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remoteTurn, isRemoteChat, REMOTE_PROVIDER, install, notSentLine } from '../src/host/remote-chat.js';
import { isHomeLevelRemote } from '../src/shared/remote-label.js';

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
  assert.equal(state.bots.b.hidden, true)
  assert.equal(state.bots.c.remote.gone, true)
  assert.equal(state.bots.c.hidden, true)
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
  assert.equal(state.bots.c.hidden, true)
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
