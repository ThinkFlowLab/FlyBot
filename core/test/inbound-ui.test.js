import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The inbound friend conversation's display: trace lines, the thinking row, the remote speaker.
const { outputFiles } = await build({
  stdin: {
    contents: "export { stripTrace, previewOf, nameMentions } from './src/client/text.js'\nexport { remoteSpeaker, RemoteMessage } from './src/client/cells.js'\nexport { lookOf, lookBotForRemote, remoteSeed } from './src/client/characters.js'\nexport { roomAvatarPeople } from './src/client/mark.js'",
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
const { stripTrace, previewOf, nameMentions, remoteSpeaker, RemoteMessage, lookOf, lookBotForRemote, remoteSeed, roomAvatarPeople } = module.exports

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
  assert.equal(got.name, "danyang's Chief")
  assert.equal(got.chatId, 'session-x')
  const other = remoteSpeaker({ remote: { handle: '@x.home' }, senderName: 'X' }, { bots: [], remoteBots: [] })
  assert.equal(other.name, "X · x's Bot")
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
