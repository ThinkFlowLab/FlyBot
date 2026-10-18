import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #335: the per-Bot connector switches (Bot settings and the Connectors page).
const { outputFiles } = await build({
  stdin: {
    contents: "export { Card, SwitchRow } from './src/client/bot-settings.js'; export { BotConnectorsCard, ConnectorBots, ownBots, isOn, othersOn, usageText } from './src/client/connector-bots.js'; export { DICTIONARY, hostText, installLocale } from './src/client/i18n.js'",
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
const { Card, SwitchRow, BotConnectorsCard, ConnectorBots, ownBots, isOn, othersOn, usageText, DICTIONARY, hostText, installLocale } = module.exports

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
  // Shared with a friend: the owner's own use is untouched, others get it only when allowed.
  shared: { id: 'shared', name: 'Helper', sharedWith: ['Bob (@bob.home)'] },
  allowed: { id: 'allowed', name: 'Open', connectorsShared: { composio: true }, sharedWith: ['Bob (@bob.home)'] },
  // A stale offer on a Bot the owner turned off for themselves never reads as on.
  stale: { id: 'stale', name: 'Stale', connectors: { composio: false }, connectorsShared: { composio: true }, sharedWith: [] },
  friend: { id: 'friend', name: 'Friend Bot', remote: { handle: '@bob.home' } },
}
const roster = { bots: Object.values(bots), connectors: [github, composio], self: { memberId: 'me' } }
const rowsOf = tree => switches(tree).map(row => [row.props['aria-label'], row.props['aria-checked'], row.props.disabled])

test('the owner switches only their own local Bots; on is the default, and only an explicit off reads as off', () => {
  assert.deepEqual(ownBots(roster).map(bot => bot.id), ['writer', 'chief', 'shared', 'allowed', 'stale'])
  assert.deepEqual(ownBots({ ...roster, bots: [{ id: 'a', ownerId: 'me' }, { id: 'b', ownerId: 'other' }] }).map(bot => bot.id), ['a'])
  assert.equal(isOn(bots.chief, 'composio'), true, 'no record: on')
  assert.equal(isOn(bots.chief, 'github'), true)
  assert.equal(isOn(bots.writer, 'composio'), false)
  assert.equal(isOn(bots.writer, 'github'), true)
  // Sharing does not take the owner's own use away.
  assert.equal(isOn(bots.shared, 'composio'), true)
  assert.equal(othersOn(bots.chief, 'composio'), false, 'others: off by default')
  assert.equal(othersOn(bots.shared, 'composio'), false)
  assert.equal(othersOn(bots.allowed, 'composio'), true)
  assert.equal(othersOn(bots.stale, 'composio'), false)
})

test('Bot settings: two switches per connected connector, the second never disabled by sharing', () => {
  const calls = []
  const actions = { setBotConnector: (...args) => { calls.push(args); return Promise.resolve() } }
  const card = bot => expand(BotConnectorsCard({ bot, roster, actions, run: task => task, Card, SwitchRow }))

  const chief = card(bots.chief)
  assert.equal(text(chief).startsWith('Connectors'), true)
  assert.deepEqual(rowsOf(chief), [
    ['GitHub', true, false], ['GitHub: also when others use it', false, false],
    ['Composio', true, false], ['Composio: also when others use it', false, false],
  ])
  assert.match(text(chief), /On\. This Bot can use it for you\./)
  assert.match(text(chief), /Off\. If others use this Bot, they get it only when you turn this on\./)
  const chiefRows = switches(chief)
  chiefRows[2].props.onClick()
  chiefRows[3].props.onClick()
  assert.deepEqual(calls, [['chief', 'composio', false, 'owner'], ['chief', 'composio', true, 'shared']])

  // Shared with a friend: the first switch is the owner's and on; the second is enabled and explains itself.
  const shared = card(bots.shared)
  assert.deepEqual(rowsOf(shared), [
    ['GitHub', true, false], ['GitHub: also when others use it', false, false],
    ['Composio', true, false], ['Composio: also when others use it', false, false],
  ])
  assert.match(text(shared), /Shared with Bob \(@bob\.home\)\. They cannot use it unless you turn this on\./)
  assert.doesNotMatch(text(shared), /Unavailable|Not available|never gets/)
  switches(shared)[3].props.onClick()
  assert.deepEqual(calls.at(-1), ['shared', 'composio', true, 'shared'])

  const allowed = card(bots.allowed)
  assert.deepEqual(switches(allowed).map(row => row.props['aria-checked']), [true, false, true, true])
  assert.match(text(allowed), /On: Bob \(@bob\.home\) can use it through this Bot\./)
  switches(allowed)[3].props.onClick()
  assert.deepEqual(calls.at(-1), ['allowed', 'composio', false, 'shared'])

  // Off for the owner: the second switch has nothing to give and waits, with the reason.
  const writer = card(bots.writer)
  assert.deepEqual(rowsOf(writer).slice(2), [['Composio', false, false], ['Composio: also when others use it', false, true]])
  assert.match(text(writer), /Turn it on for yourself first\./)
  switches(writer)[2].props.onClick()
  assert.deepEqual(calls.at(-1), ['writer', 'composio', true, 'owner'])
  assert.deepEqual(switches(card(bots.stale)).map(row => row.props['aria-checked']).slice(2), [false, false])
})

test('Bot settings show no Connectors card until a connector is connected', () => {
  const none = { ...roster, connectors: [{ id: 'github', name: 'GitHub', state: 'off', account: null }, { id: 'composio', name: 'Composio', state: 'off', account: null, apps: [] }] }
  assert.equal(BotConnectorsCard({ bot: bots.chief, roster: none, actions: {}, run() {}, Card, SwitchRow }), null)
  assert.equal(BotConnectorsCard({ bot: bots.chief, roster: { bots: [] }, actions: {}, run() {}, Card, SwitchRow }), null)
})

test('Connectors page: a summary line and two switches per Bot, none disabled for a shared Bot', () => {
  assert.equal(usageText(roster, 'composio'), 'On for 3 of 5 Bots · Allowed for others on 1')
  assert.equal(usageText(roster, 'github'), 'On for all 5 Bots')
  assert.equal(usageText({ ...roster, bots: [bots.writer] }, 'composio'), 'Off for every Bot. Choose which Bots may use it.')
  assert.equal(usageText({ ...roster, bots: [bots.chief, bots.shared] }, 'composio'), 'On for all 2 Bots')
  const calls = []
  const list = expand(ConnectorBots({ connector: composio, roster, actions: { setBotConnector: (...args) => { calls.push(args); return Promise.resolve() } }, run: task => task, SwitchRow }))
  assert.deepEqual(rowsOf(list), [
    ['Writer', false, false], ['Writer: also when others use it', false, true],
    ['Chief', true, false], ['Chief: also when others use it', false, false],
    ['Helper', true, false], ['Helper: also when others use it', false, false],
    ['Open', true, false], ['Open: also when others use it', true, false],
    ['Stale', false, false], ['Stale: also when others use it', false, true],
  ])
  const rows = switches(list)
  rows[0].props.onClick()
  rows[5].props.onClick()
  assert.deepEqual(calls, [['writer', 'composio', true, 'owner'], ['shared', 'composio', true, 'shared']])
  assert.match(text(list), /On by default for you\. When someone else uses a Bot, or it works in a room with other people, such as a friend or another member, it is off unless you allow it for that Bot\./)
  assert.doesNotMatch(text(list), /never gets connector tools/)
})

test('the connector switches and their host messages have zh copy', () => {
  for (const key of [
    'Choose Bots', 'Off for every Bot. Choose which Bots may use it.', 'On for {count} of {total} Bots', 'On for all {total} Bots', 'Allowed for others on {count}',
    'On. This Bot can use it for you.', 'Off. This Bot will not use it for anyone.', '{name}: also when others use it', 'Turn it on for yourself first.',
    'On: anyone who uses this Bot, such as a friend or another room member, can use it too.', 'On: {names} can use it through this Bot.',
    'Off. If others use this Bot, they get it only when you turn this on.', 'Shared with {names}. They cannot use it unless you turn this on.',
    'On by default for you. When someone else uses a Bot, or it works in a room with other people, such as a friend or another member, it is off unless you allow it for that Bot.',
    'No Bots', 'Connectors', 'Done', 'Composio did not give a session id', 'Say whether to turn it on or off', 'Say whose use it is: yours or other people\'s',
  ]) assert.ok(typeof DICTIONARY.zh[key] === 'string' && DICTIONARY.zh[key] !== '', key)
  const off = installLocale({ register: () => () => {}, bind: () => key => key, getLocale: () => ({ active: 'zh' }) })
  try {
    assert.equal(hostText('Turn composio on for Writer first: other people only get what you have.'), '请先为 Writer 开启 composio：别人只能得到你已有的权限。')
  } finally {
    off()
  }
})
