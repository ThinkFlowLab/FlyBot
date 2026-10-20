import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The inbound friend conversation's display: trace lines, the thinking row, the remote speaker.
const { outputFiles } = await build({
  stdin: {
    contents: "export { stripTrace, previewOf, nameMentions } from './src/client/text.js'\nexport { remoteSpeaker, RemoteMessage, FirstContact } from './src/client/cells.js'\nexport { lookOf, lookBotForRemote, remoteSeed } from './src/client/characters.js'\nexport { roomAvatarPeople, PersonMark } from './src/client/mark.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = { createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useState: v => [v, () => {}], useMemo: f => f(), useRef: current => ({ current }) }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: ({ text }) => text }
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { stripTrace, previewOf, nameMentions, remoteSpeaker, RemoteMessage, FirstContact, lookOf, lookBotForRemote, remoteSeed, roomAvatarPeople, PersonMark } = module.exports

test('a reply opening with a delegation trace shows without it', () => {
  assert.equal(stripTrace('Chief → 助手\n\nHi Chief! Good to hear from you.'), 'Hi Chief! Good to hear from you.')
  assert.equal(stripTrace('user → 助手\nHi!'), 'Hi!')
  assert.equal(stripTrace('Chief → 程序员 → 后端\n\nDone.'), 'Done.')
  assert.equal(stripTrace('Use Settings → Models first'), 'Use Settings → Models first')
})

test('ordinary text that merely mentions an arrow is left alone', () => {
  for (const text of ['Hi! Step one → step two.', 'Settings → Models, then retry', 'Plain reply', 'a → b: see below\nmore']) {
    assert.equal(stripTrace(text), text)
  }
  assert.equal(stripTrace(undefined), undefined)
})

test('the sidebar preview drops the trace too', () => {
  const list = { byId: { s: { projectionValues: { turnOutline: [{ turn: 2, prompt: '', response: 'Chief → 助手\n\nHi Chief!' }] } } } }
  assert.equal(previewOf(list, 's'), 'Hi Chief!')
  const flat = { byId: { s: { projectionValues: { turnOutline: [{ turn: 1, prompt: '', response: 'Chief → 助手 Hi! Message received.' }] } } } }
  assert.equal(previewOf(flat, 's'), 'Hi! Message received.')
  const plain = { byId: { s: { projectionValues: { turnOutline: [{ turn: 1, prompt: '', response: 'Use Settings → Models first' }] } } } }
  assert.equal(previewOf(plain, 's'), 'Use Settings → Models first')
})

test("an inbound friend's message uses the friend's sidebar Bot (avatar, name), else a stable look from its handle", () => {
  const chat = { id: 'session-x', name: 'Chief', color: 'orange', shape: 'star', remote: { handle: '@chief.danyang.home' } }
  const roster = { bots: [chat], remoteBots: [{ handle: '@chief.danyang.home', name: 'Chief' }] }
  const got = remoteSpeaker({ remote: { handle: '@chief.danyang.home' } }, roster)
  assert.equal(got.bot, chat)
  assert.equal(got.name, 'Chief (danyang)')
  assert.equal(got.chatId, 'session-x')
  const other = remoteSpeaker({ remote: { handle: '@x.home' }, senderName: 'X' }, { bots: [], remoteBots: [] })
  assert.equal(other.name, 'X (x)')
  assert.equal(other.bot.remote.handle, '@x.home')
  assert.notEqual(lookOf(other.bot).color, 'gray')
  assert.equal(other.chatId, undefined)
})

test("a friend Bot's handle in a preview reads as its display name (#71)", () => {
  const roster = { bots: [{ id: 'f', name: '代码审查官', remote: { handle: '@bot-2a758c0f.danyang.home' } }], remoteBots: [{ handle: '@bot-2a758c0f.danyang.home', name: '代码审查官' }] }
  assert.equal(nameMentions('@bot-2a758c0f.danyang.home 你是?', roster), '@代码审查官 你是?')
  assert.equal(nameMentions('看 @bot-2a758c0f.danyang.home。', roster), '看 @代码审查官。')
  // An address before the @, or a longer word after the handle, stays as written.
  assert.equal(nameMentions('mail a@bot-2a758c0f.danyang.home', roster), 'mail a@bot-2a758c0f.danyang.home')
  assert.equal(nameMentions('@bot-2a758c0f.danyang.home2 不在', roster), '@bot-2a758c0f.danyang.home2 不在')
  // Unknown handles, missing rosters, and non-string input pass through.
  assert.equal(nameMentions('@bot-x.home 你在?', roster), '@bot-x.home 你在?')
  assert.equal(nameMentions('@bot-2a758c0f.danyang.home', undefined), '@bot-2a758c0f.danyang.home')
  assert.equal(nameMentions(undefined, roster), '')
  // One pass: a name that itself contains another handle is not rescanned.
  const nested = { bots: [], remoteBots: [
    { handle: '@b.x.home', name: '请找 @a.x.home 的主人' },
    { handle: '@a.x.home', name: '代码审查官' },
  ] }
  assert.equal(nameMentions('@b.x.home 你在?', nested), '@请找 @a.x.home 的主人 你在?')
})

test("a friend Bot's generated look is seeded by its handle: with or without its chat record, one look (#84)", () => {
  const source = { remote: { handle: '@bot-2a758c0f.danyang.home' }, senderName: 'X' }
  const record = { id: 'session-y', name: 'X', remote: { handle: '@bot-2a758c0f.danyang.home' } }
  const withRecord = remoteSpeaker(source, { bots: [record], remoteBots: [] })
  const without = remoteSpeaker(source, { bots: [], remoteBots: [] })
  assert.equal(withRecord.bot, record)
  const kept = lookOf(withRecord.bot)
  const fallback = lookOf(without.bot)
  assert.equal(kept.shape, fallback.shape)
  assert.equal(kept.color, fallback.color)
})

test('lookBotForRemote seeds a distinct look from the handle when there is no chat record', () => {
  const person = { handle: '@bot.friend.home', displayName: '助手', label: "助手 · Friend's Bot" }
  const synthetic = lookBotForRemote(person, { bots: [] })
  assert.equal(synthetic.remote.handle, '@bot.friend.home')
  assert.equal(synthetic.id, remoteSeed('@bot.friend.home'))
  const look = lookOf(synthetic)
  assert.notEqual(look.shape, undefined)
  assert.notEqual(look.color, 'gray')
  assert.notEqual(look.color, 'black')
  const other = lookOf(lookBotForRemote({ handle: '@other.friend.home', displayName: 'Other' }, { bots: [] }))
  assert.notEqual(look.shape + look.color, other.shape + other.color)
  const pictured = lookBotForRemote({
    handle: '@bot.friend.home', displayName: '助手',
    avatar: { image: 'https://example.test/friend.png' },
  }, { bots: [] })
  assert.equal(lookOf(pictured).image, 'https://example.test/friend.png')
  const chat = { id: 'session-f', name: '助手', remote: { handle: '@bot.friend.home' }, color: 'green' }
  assert.equal(lookBotForRemote(person, { bots: [chat] }), chat)
  const overlaid = lookBotForRemote({
    handle: '@bot.friend.home', displayName: '助手', color: '#2a92fe', avatar: { shape: 'star' },
  }, { bots: [chat] })
  assert.equal(overlaid.color, '#2a92fe')
  assert.equal(overlaid.avatar.shape, 'star')
  assert.equal(lookOf({ id: 'e', avatar: { emoji: '🌟' } }).emoji, '🌟')
})

test('room avatars include live remote face-to-face members', () => {
  const roster = {
    byId: { a: { id: 'a', name: 'Chief', color: 'blue', avatar: { shape: 'whale' } } },
    bots: [{ id: 'r1', name: 'Coder', remote: { handle: '@coder.bob.home' }, color: 'green' }],
  }
  assert.equal(typeof roomAvatarPeople, 'function')
  const empty = roomAvatarPeople({ members: [], participants: [] }, roster)
  assert.ok(Array.isArray(empty))
  assert.equal(empty.length, 0)
  const face = roomAvatarPeople({
    members: ['a'],
    participants: [
      { kind: 'bot', id: 'a', handle: '@a.me.home' },
      { kind: 'bot', remote: true, handle: '@coder.bob.home', displayName: 'Coder', leftSeq: undefined },
      { kind: 'bot', remote: true, handle: '@gone.bob.home', displayName: 'Gone', leftSeq: 3 },
    ],
  }, roster)
  assert.equal(face[0].id, 'a')
  assert.equal(face[1].remote.handle, '@coder.bob.home')
  assert.equal(face.length, 2)
  const onlyRemote = roomAvatarPeople({
    members: [],
    participants: [{ kind: 'bot', remote: true, handle: '@bot.friend.home', displayName: '助手' }],
  }, { byId: {}, bots: [] })
  assert.equal(onlyRemote.length, 1)
  assert.equal(onlyRemote[0].remote.handle, '@bot.friend.home')
  assert.notEqual(onlyRemote[0].id, undefined)
})

test('handles equal modulo @ and case share one look; a stored look still wins', () => {
  const at = lookOf({ id: 'a', remote: { handle: '@Bot.X.home' } })
  const bare = lookOf({ id: 'b', remote: { handle: 'bot.x.home' } })
  assert.equal(at.shape, bare.shape)
  assert.equal(at.color, bare.color)
  const owned = lookOf({ id: 'c', remote: { handle: '@bot.x.home' }, color: 'green', avatar: { shape: 'kitty' } })
  assert.equal(owned.shape, 'kitty')
  assert.equal(owned.color, 'green')
})

const flat = (node, out = []) => {
  if (node === null || node === undefined || typeof node === 'string') return out
  if (Array.isArray(node)) { node.forEach(child => flat(child, out)); return out }
  out.push(node)
  flat(node.props?.children, out)
  return out
}

test("#236 follow-up: a friend's line Bot Social attested as typed by them is drawn as the person, not as their Bot", () => {
  const roster = { bots: [], remoteBots: [{ handle: '@chief.danyang.home', name: 'Chief' }], byId: {} }
  const props = { roster, actions: {}, sessionId: 's', msgKey: 'k', useUi: () => ({}), text: 'hello Helper' }
  const typedLine = flat(RemoteMessage({ ...props, source: { remote: { handle: '@chief.danyang.home', typedBy: 'Danyang' }, senderName: 'Chief' } }))
  const wrap = typedLine[0]
  assert.match(wrap.props.className, /bt-person-msg/)
  assert.equal(wrap.props['data-person'], 'Danyang')
  assert.ok(typedLine.some(n => n.props?.className === 'bt-group-name' && n.props.children[0] === 'Danyang'), 'the name is the person\'s')
  const leadOf = nodes => flat(nodes.find(n => n.props?.lead !== undefined)?.props.lead)
  assert.equal(leadOf(typedLine).some(n => n.props?.bot !== undefined), false, 'no Bot avatar in the lead')
  assert.ok(leadOf(typedLine).some(n => typeof n.type === 'function' && n.type.name === 'PersonMark'), 'a person mark leads')
  const botLine = flat(RemoteMessage({ ...props, source: { remote: { handle: '@chief.danyang.home' }, senderName: 'Chief' } }))
  assert.doesNotMatch(botLine[0].props.className, /bt-person-msg/)
  assert.equal(botLine[0].props['data-remote'], '@chief.danyang.home')
  assert.ok(leadOf(botLine).some(n => n.props?.bot !== undefined), 'a Bot line keeps the Bot avatar')
})

test('#275: a typed line from a friend has one short header: the person, then "via <Bot>" only when that Bot is known', () => {
  const props = { actions: {}, sessionId: 's', msgKey: 'k', useUi: () => ({}), text: 'Hi from B' }
  const header = nodes => {
    const name = nodes.find(n => n.props?.className === 'bt-group-name')
    return flat(name.props.children).map(n => n.props?.children).flat().concat(name.props.children.filter(c => typeof c === 'string')).filter(c => typeof c === 'string').join(' ')
  }
  // This home was never shared the carrying Bot: the plugin's model-facing sender label is not shown.
  const unknown = flat(RemoteMessage({ ...props, roster: { bots: [], remoteBots: [], byId: {} }, source: { remote: { handle: '@chief.selfb1220.home', typedBy: 'SelfB1220' }, senderName: 'SelfB1220 (typed via @chief.selfb1220.home, Bot Social)' } }))
  assert.equal(header(unknown), 'SelfB1220')
  assert.equal(unknown.some(n => n.props?.className === 'bt-remote-handle'), false)
  // A Bot this home knows: its plain name, not "· owner's Bot".
  const known = flat(RemoteMessage({ ...props, roster: { bots: [], remoteBots: [{ handle: '@helper.selfb1220.home', name: 'Helper' }], byId: {} }, source: { remote: { handle: '@helper.selfb1220.home', typedBy: 'SelfB1220' }, senderName: 'Helper' } }))
  const via = known.find(n => n.props?.className === 'bt-remote-handle')
  assert.ok(via)
  assert.doesNotMatch(header(known), /typed via|Bot Social|'s Bot/)
})

test("#420: a sender's first line in a Bot's own chat gets one quiet line naming who talks to which Bot", () => {
  const roster = { bots: [], remoteBots: [], byId: { s: { id: 'a', name: 'Chief' } } }
  const text = node => flat(node).flatMap(n => (Array.isArray(n.props?.children) ? n.props.children : [])).filter(c => typeof c === 'string').join('')
  const typed = FirstContact({ roster, sessionId: 's', source: { remote: { handle: '@chief.selfb1238.home', typedBy: 'SelfB1238', firstContact: true }, senderName: 'SelfB1238 (typed via @chief.selfb1238.home, Bot Social)' } })
  assert.equal(typed.props.className, 'bt-event')
  assert.equal(text(typed), 'SelfB1238 is talking to Chief through Bot Social')
  const known = { ...roster, remoteBots: [{ handle: '@helper.selfb1238.home', name: 'Helper', owner: 'SelfB1238' }] }
  const bot = FirstContact({ roster: known, sessionId: 's', source: { remote: { handle: '@helper.selfb1238.home', firstContact: true }, senderName: 'Helper' } })
  assert.equal(text(bot), 'Helper (SelfB1238) is talking to Chief through Bot Social')
})

test("a face room's remote Bot speaks with its seat's look, the one Members and the waiting tiles draw (#182)", () => {
  const handle = '@chief-9a.bob.home'
  const seat = { kind: 'bot', remote: true, id: handle, handle, displayName: 'Chief', ownerName: 'Bob', color: '#2a92fe', avatar: { shape: 'whale' } }
  const room = { id: 'room-1', origin: 'face-to-face', participants: [seat] }
  const source = { remote: { handle }, senderName: 'Chief' }
  const roster = { bots: [], remoteBots: [], roomsById: { 'room-1': room } }
  const spoke = remoteSpeaker(source, roster, 'room-1')
  assert.equal(lookOf(spoke.bot).shape, 'whale')
  assert.equal(lookOf(spoke.bot).color, '#2a92fe')
  // The Members panel draws the seat through lookBotForRemote: the same look.
  const members = lookOf(lookBotForRemote(seat, roster))
  assert.equal(lookOf(spoke.bot).shape, members.shape)
  assert.equal(lookOf(spoke.bot).color, members.color)
  // A chat record for the same handle keeps its id (its chat opens from the bubble) but wears the seat's look.
  const chat = { id: 'session-c', name: 'Chief', color: 'orange', avatar: { shape: 'star' }, remote: { handle } }
  const withChat = remoteSpeaker(source, { ...roster, bots: [chat] }, 'room-1')
  assert.equal(withChat.bot.id, 'session-c')
  assert.equal(withChat.chatId, 'session-c')
  assert.equal(lookOf(withChat.bot).shape, 'whale')
  // Outside a face room (or a seat with no look) nothing changes: the chat record as before.
  assert.equal(remoteSpeaker(source, { ...roster, bots: [chat] }).bot, chat)
  const bare = { ...room, participants: [{ ...seat, color: undefined, avatar: undefined }] }
  assert.equal(remoteSpeaker(source, { bots: [chat], remoteBots: [], roomsById: { 'room-1': bare } }, 'room-1').bot, chat)
})

test("a person's mark is their initial on a color from their name, the same on every home (#182)", () => {
  const bob = PersonMark({ name: 'Bob', size: 22 })
  assert.equal(bob.props['data-initial'], 'B')
  assert.deepEqual(bob.props.children, ['B'])
  assert.match(bob.props.className, /bt-person-initial/)
  assert.equal(PersonMark({ name: ' bob ' }).props.style.background, bob.props.style.background)
  // Two people are told apart by initial or color.
  const ann = PersonMark({ name: 'Ann' })
  assert.notEqual(`${ann.props['data-initial']}${ann.props.style.background}`, `${bob.props['data-initial']}${bob.props.style.background}`)
  assert.equal(PersonMark({ name: '小明' }).props['data-initial'], '小')
  // No name: the plain silhouette, as before.
  const plain = PersonMark({})
  assert.equal(plain.props['data-initial'], undefined)
  assert.equal(plain.props.className, 'bt-person-mark')
})
