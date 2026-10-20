import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// #359: the Composio app search and each picked app's status on the Connectors page.
const { outputFiles } = await build({
  stdin: {
    contents: "export { AppPicker, AppStatusList } from './src/client/connectors.js'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
// The next useState calls answer these values in order (query, found, failed in AppPicker).
let states = []
const react = { createElement: h, Fragment: Symbol('F'), useEffect() {}, useLayoutEffect() {}, useState: v => [states.length > 0 ? states.shift() : v, () => {}], useMemo: f => f(), useRef: current => ({ current }), useCallback: f => f, useSyncExternalStore: (_s, get) => get() }
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: { hidden: false }, navigator: { language: 'en' }, localStorage: { getItem: () => null, setItem() {} },
  setTimeout, clearTimeout,
  require: (name) => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: node => node }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`Unexpected platform module ${name}`)
  },
})
const { AppPicker, AppStatusList } = module.exports

const expand = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props.children) } }
}
const all = (node, out = []) => { if (node && typeof node === 'object') { if (Array.isArray(node)) node.forEach(child => all(child, out)); else { out.push(node); all(node.props?.children, out) } } return out }
const text = node => (node === null || node === undefined ? '' : Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' ? text(node.props.children) : String(node))
const group = (tree, label) => all(tree).find(node => node.props?.['aria-label'] === label)
const buttons = node => all(node).filter(child => child.type === 'button')
const render = (props, given = []) => { states = [...given]; const tree = expand(h(AppPicker, props)); states = []; return tree }

test('the picker shows the picked apps with their status, and a search box instead of a typed list', () => {
  const changes = []
  const tree = render({ apps: ['gmail', 'notion'], statuses: { gmail: 'ready', notion: 'sign-in' }, onChange: apps => changes.push(apps), search: async () => [] })
  const search = all(tree).find(node => node.type === 'input')
  assert.equal(search.props['aria-label'], 'Search apps')
  assert.equal(search.props.placeholder, 'Search Composio apps')
  assert.equal(all(tree).filter(node => node.type === 'input').length, 1)
  const chips = buttons(group(tree, 'Picked apps'))
  assert.deepEqual(chips.map(text), ['Gmail · Ready', 'Notion · Needs sign-in'])
  assert.deepEqual(chips.map(chip => chip.props['data-status']), ['ready', 'sign-in'])
  chips[1].props.onClick()
  assert.deepEqual([...changes.pop()], ['gmail'])
  // With no query the common apps are offered, without the picked ones.
  const offered = buttons(group(tree, 'Apps to add')).map(text)
  assert.ok(offered.includes('Slack'))
  assert.ok(!offered.includes('Gmail') && !offered.includes('Notion'))
  buttons(group(tree, 'Apps to add')).find(button => text(button) === 'Slack').props.onClick()
  assert.deepEqual([...changes.pop()], ['gmail', 'notion', 'slack'])
})

test('search results from Composio replace the common apps; an app it found is added by its slug', () => {
  const changes = []
  const tree = render({ apps: [], onChange: apps => changes.push(apps), search: async () => [] }, ['hub', [{ slug: 'hubspot', name: 'HubSpot' }, { slug: 'github', name: 'GitHub' }], null])
  assert.equal(group(tree, 'Picked apps'), undefined)
  const offered = buttons(group(tree, 'Apps to add'))
  assert.deepEqual(offered.map(text), ['HubSpot', 'GitHub'])
  offered[1].props.onClick()
  assert.deepEqual([...changes.pop()], ['github'])
})

test('without a key to search with, or when the search fails, the common apps are searched by name', () => {
  const keyless = render({ apps: [], onChange() {} }, ['cal'])
  assert.deepEqual(buttons(group(keyless, 'Apps to add')).map(text), ['Google Calendar', 'Calendly'])
  const failed = render({ apps: [], onChange() {}, search: async () => [] }, ['zzz', null, 'Composio answered 500'])
  assert.match(text(failed), /Could not search Composio: Composio answered 500/)
  assert.match(text(group(failed, 'Apps to add')), /No apps match/)
})

test('the connected row lists each picked app as ready or needing a sign-in, and nothing before Composio answers', () => {
  const tree = expand(h(AppStatusList, { apps: ['gmail', 'slack', 'hackernews'], statuses: { gmail: 'ready', slack: 'sign-in' } }))
  const rows = all(tree).filter(node => node.type === 'li')
  assert.deepEqual(rows.map(row => [text(row), row.props['data-status']]), [['GmailReady', 'ready'], ['SlackNeeds sign-in', 'sign-in'], ['hackernews', 'unknown']])
  assert.equal(expand(h(AppStatusList, { apps: ['gmail'], statuses: {} })), null)
})
