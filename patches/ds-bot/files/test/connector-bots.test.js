import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #335, #601: the per-Bot connector switch (Bot settings and the Connectors page).
const { outputFiles } = await build({
  stdin: {
    contents: "export { Card, SwitchRow } from './src/client/bot-settings.js'; export { BotConnectorsCard, ConnectorBots, ownBots, isOn, usageText } from './src/client/connector-bots.js'; export { DICTIONARY, hostText, installLocale } from './src/client/i18n.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const react = { createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useState: v => [v, () => {}], useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get() }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { Card, SwitchRow, BotConnectorsCard, ConnectorBots, ownBots, isOn, usageText, DICTIONARY, hostText, installLocale } = module.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const all = (node, out = []) => { if (node && typeof node === 'object') { if (Array.isArray(node)) node.forEach(child => all(child, out)); else { out.push(node); all(node.props?.children, out) } } return out }
const text = node => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))
const switches = tree => all(tree).filter(node => node.props?.role === 'switch')

const github = { id: 'github', name: 'GitHub', state: 'ready', account: 'octo' }
const composio = { id: 'composio', name: 'Composio', state: 'ready', account: null, apps: ['gmail'] }
const bots = {
  writer: { id: 'writer', name: 'Writer', connectors: { composio: false }, sharedWith: [] },
  chief: { id: 'chief', name: 'Chief', sharedWith: [] },
  // Shared with a friend: the same single switch, on by default (#601).
  shared: { id: 'shared', name: 'Helper', sharedWith: ['Bob (@bob.home)'] },
  // A retired "also when others use it" offer saved before #601 changes nothing.
  stale: { id: 'stale', name: 'Stale', connectors: { composio: false }, connectorsShared: { composio: true }, sharedWith: [] },
  friend: { id: 'friend', name: 'Friend Bot', remote: { handle: '@bob.home' } },
}
const roster = { bots: Object.values(bots), connectors: [github, composio], self: { memberId: 'me' } }
const rowsOf = tree => switches(tree).map(row => [row.props['aria-label'], row.props['aria-checked'], row.props.disabled])

test('the owner switches only their own local Bots; on is the default, and only an explicit off reads as off', () => {
  assert.deepEqual(ownBots(roster).map(bot => bot.id), ['writer', 'chief', 'shared', 'stale'])
  assert.deepEqual(ownBots({ ...roster, bots: [{ id: 'a', ownerId: 'me' }, { id: 'b', ownerId: 'other' }] }).map(bot => bot.id), ['a'])
  assert.equal(isOn(bots.chief, 'composio'), true, 'no record: on')
  assert.equal(isOn(bots.chief, 'github'), true)
  assert.equal(isOn(bots.writer, 'composio'), false)
  assert.equal(isOn(bots.writer, 'github'), true)
  assert.equal(isOn(bots.shared, 'composio'), true, 'sharing does not take it away')
  assert.equal(isOn(bots.stale, 'composio'), false)
})

test('#601: Bot settings show one switch per connected connector, also on a shared Bot', () => {
  const calls = []
  const actions = { setBotConnector: (...args) => { calls.push(args); return Promise.resolve() } }
  const card = bot => expand(BotConnectorsCard({ bot, roster, actions, run: task => task, Card, SwitchRow }))

  const chief = card(bots.chief)
  assert.equal(text(chief).startsWith('Connectors'), true)
  assert.deepEqual(rowsOf(chief), [['GitHub', true, false], ['Composio', true, false]])
  assert.match(text(chief), /On\. This Bot can use it on every turn\./)
  assert.doesNotMatch(text(chief), /also when others use it/)
  switches(chief)[1].props.onClick()
  assert.deepEqual(calls, [['chief', 'composio', false]])

  const shared = card(bots.shared)
  assert.deepEqual(rowsOf(shared), [['GitHub', true, false], ['Composio', true, false]])
  assert.doesNotMatch(text(shared), /Shared with|They cannot use it/)

  const writer = card(bots.writer)
  assert.deepEqual(rowsOf(writer), [['GitHub', true, false], ['Composio', false, false]])
  assert.match(text(writer), /Off\. This Bot will not use it\./)
  switches(writer)[1].props.onClick()
  assert.deepEqual(calls.at(-1), ['writer', 'composio', true])
  assert.deepEqual(rowsOf(card(bots.stale)).map(row => row[1]), [true, false])
})

test('Bot settings show no Connectors card until a connector is connected', () => {
  const none = { ...roster, connectors: [{ id: 'github', name: 'GitHub', state: 'off', account: null }, { id: 'composio', name: 'Composio', state: 'off', account: null, apps: [] }] }
  assert.equal(BotConnectorsCard({ bot: bots.chief, roster: none, actions: {}, run() {}, Card, SwitchRow }), null)
  assert.equal(BotConnectorsCard({ bot: bots.chief, roster: { bots: [] }, actions: {}, run() {}, Card, SwitchRow }), null)
})

test('#601: Connectors page: a summary line and one switch per Bot', () => {
  assert.equal(usageText(roster, 'composio'), 'On for 2 of 4 Bots')
  assert.equal(usageText(roster, 'github'), 'On for all 4 Bots')
  assert.equal(usageText({ ...roster, bots: [bots.writer] }, 'composio'), 'Off for every Bot. Choose which Bots may use it.')
  const calls = []
  const list = expand(ConnectorBots({ connector: composio, roster, actions: { setBotConnector: (...args) => { calls.push(args); return Promise.resolve() } }, run: task => task, SwitchRow }))
  assert.deepEqual(rowsOf(list), [['Writer', false, false], ['Chief', true, false], ['Helper', true, false], ['Stale', false, false]])
  switches(list)[0].props.onClick()
  assert.deepEqual(calls, [['writer', 'composio', true]])
  assert.match(text(list), /On by default for each of your Bots, on every turn: in its own chat, in groups, on schedules and when a friend uses it\. A friend's own Bot never gets it\./)
})

test('the connector switch and its host messages have zh copy', () => {
  for (const key of [
    'Choose Bots', 'Off for every Bot. Choose which Bots may use it.', 'On for {count} of {total} Bots', 'On for all {total} Bots',
    'On. This Bot can use it on every turn.', 'Off. This Bot will not use it.',
    'On by default for each of your Bots, on every turn: in its own chat, in groups, on schedules and when a friend uses it. A friend\'s own Bot never gets it.',
    'No Bots', 'Connectors', 'Done', 'Composio did not give a session id', 'Say whether to turn it on or off',
  ]) assert.ok(typeof DICTIONARY.zh[key] === 'string' && DICTIONARY.zh[key] !== '', key)
  for (const gone of ['{name}: also when others use it', 'Allowed for others on {count}', 'Say whose use it is: yours or other people\'s']) assert.equal(DICTIONARY.zh[gone], undefined, gone)
  assert.ok(typeof installLocale === 'function' && typeof hostText === 'function')
})
