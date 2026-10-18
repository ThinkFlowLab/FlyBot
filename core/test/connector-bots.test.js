import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #335: the per-Bot connector switches (Bot settings and the Connectors page).
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
  writer: { id: 'writer', name: 'Writer', connectors: { composio: true }, sharedWith: [] },
  chief: { id: 'chief', name: 'Chief', sharedWith: [] },
  shared: { id: 'shared', name: 'Helper', connectors: { composio: true }, sharedWith: ['Bob'] },
  friend: { id: 'friend', name: 'Friend Bot', remote: { handle: '@bob.home' } },
}
const roster = { bots: Object.values(bots), connectors: [github, composio], self: { memberId: 'me' } }

test('the owner switches only their own local Bots, and a shared Bot never reads as on', () => {
  assert.deepEqual(ownBots(roster).map(bot => bot.id), ['writer', 'chief', 'shared'])
  assert.deepEqual(ownBots({ ...roster, bots: [{ id: 'a', ownerId: 'me' }, { id: 'b', ownerId: 'other' }] }).map(bot => bot.id), ['a'])
  assert.equal(isOn(bots.writer, 'composio'), true)
  assert.equal(isOn(bots.writer, 'github'), false)
  assert.equal(isOn(bots.chief, 'composio'), false)
  assert.equal(isOn(bots.shared, 'composio'), false)
})

test('Bot settings: one switch per connected connector, off by default, disabled with the reason while shared', () => {
  const calls = []
  const actions = { setBotConnector: (...args) => { calls.push(args); return Promise.resolve() } }
  const card = bot => expand(BotConnectorsCard({ bot, roster, actions, run: task => task, Card, SwitchRow }))

  const chief = card(bots.chief)
  assert.equal(text(chief).startsWith('Connectors'), true)
  const rows = switches(chief)
  assert.deepEqual(rows.map(row => [row.props['aria-label'], row.props['aria-checked'], row.props.disabled]), [['GitHub', false, false], ['Composio', false, false]])
  assert.match(text(chief), /Off\. Turn on to let this Bot use it\./)
  rows[1].props.onClick()
  assert.deepEqual(calls, [['chief', 'composio', true]])

  const writer = switches(card(bots.writer))
  assert.deepEqual(writer.map(row => row.props['aria-checked']), [false, true])
  writer[1].props.onClick()
  assert.deepEqual(calls.at(-1), ['writer', 'composio', false])

  const shared = card(bots.shared)
  assert.deepEqual(switches(shared).map(row => [row.props['aria-checked'], row.props.disabled]), [[false, true], [false, true]])
  assert.match(text(shared), /Not available: shared with Bob\./)
})

test('Bot settings show no Connectors card until a connector is connected', () => {
  const none = { ...roster, connectors: [{ id: 'github', name: 'GitHub', state: 'off', account: null }, { id: 'composio', name: 'Composio', state: 'off', account: null, apps: [] }] }
  assert.equal(BotConnectorsCard({ bot: bots.chief, roster: none, actions: {}, run() {}, Card, SwitchRow }), null)
  assert.equal(BotConnectorsCard({ bot: bots.chief, roster: { bots: [] }, actions: {}, run() {}, Card, SwitchRow }), null)
})

test('Connectors page: a summary line and a switch per Bot, none enabled for a shared Bot', () => {
  assert.equal(usageText(roster, 'composio'), 'On for 1 of 3 Bots')
  assert.equal(usageText(roster, 'github'), 'Off for every Bot. Choose which Bots may use it.')
  const calls = []
  const list = expand(ConnectorBots({ connector: composio, roster, actions: { setBotConnector: (...args) => { calls.push(args); return Promise.resolve() } }, run: task => task, SwitchRow }))
  const rows = switches(list)
  assert.deepEqual(rows.map(row => [row.props['aria-label'], row.props['aria-checked'], row.props.disabled]), [['Writer', true, false], ['Chief', false, false], ['Helper', false, true]])
  rows[1].props.onClick()
  assert.deepEqual(calls, [['chief', 'composio', true]])
  assert.match(text(list), /A Bot that is shared with anyone never gets connector tools\./)
})

test('the connector switches and their host messages have zh copy', () => {
  for (const key of [
    'Choose Bots', 'Off for every Bot. Choose which Bots may use it.', 'On for {count} of {total} Bots', 'Off. Turn on to let this Bot use it.',
    'This Bot can use it.', 'Not available: shared with {names}.', 'A Bot that is shared with anyone never gets connector tools.', 'No Bots', 'Connectors', 'Done',
    'Composio did not give a session id', 'Say whether to turn it on or off',
  ]) assert.ok(typeof DICTIONARY.zh[key] === 'string' && DICTIONARY.zh[key] !== '', key)
  const off = installLocale({ register: () => () => {}, bind: () => key => key, getLocale: () => ({ active: 'zh' }) })
  try {
    assert.equal(hostText('Writer is shared with Bob, Ann, so it cannot use connectors. Stop sharing it first.'), 'Writer 已共享给 Bob, Ann，所以不能使用连接器。请先停止共享。')
  } finally {
    off()
  }
})
