// The sidebar Bot list as one tree under the Main Bot, from a plugin's 'flybot.sidebar.structure'.
import test from 'node:test'
import assert from 'node:assert/strict'
import { botTree, SLOTS } from '../src/client/flybot-registry.js'

const names = node => [node.bot.name, ...node.children.map(names)]

test('botTree: Chief is the root; Bots without a known parent go under it; cycles are broken', () => {
  assert.ok(SLOTS.includes('flybot.sidebar.structure'))
  const bots = ['chief', 'work', 'dev', 'research', 'oldroot', 'a', 'b'].map(id => ({ id, name: id }))
  const parents = { work: 'chief', dev: 'work', research: undefined, oldroot: null, a: 'b', b: 'a' }
  const [root] = botTree(bots, 'chief', id => parents[id])
  assert.equal(root.bot.id, 'chief')
  assert.equal(root.depth, 0)
  assert.deepEqual(names(root), ['chief', ['work', ['dev']], ['research'], ['oldroot'], ['a'], ['b']])
  assert.equal(root.children[0].children[0].depth, 2)
  // A parent that is not a listed Bot, or the Bot itself, also means "under Chief".
  const [again] = botTree(bots.slice(0, 3), 'chief', id => ({ work: 'gone', dev: 'dev' })[id])
  assert.deepEqual(names(again), ['chief', ['work'], ['dev']])
  assert.deepEqual(botTree(bots, 'missing', () => undefined), [])
})

test('sidebar tree toggle is a 28px hit target with a 16px chevron, hover, and focus ring', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  assert.match(src, /className: 'bt-tree-toggle'/)
  assert.match(src, /'aria-expanded': !closed/)
  assert.match(src, /'aria-label': `\$\{closed \? t\('Expand'\) : t\('Collapse'\)\} \$\{bot\.name\}`/)
  assert.match(src, /className: 'bt-tree-chev'/)
  assert.match(src, /className: 'bt-tree-toggle bt-tree-leaf'/)
  assert.match(css, /\.bt-tree-toggle\{[^}]*width:28px;height:28px/)
  assert.match(css, /\.bt-tree-chev\{[^}]*font-size:16px/)
  assert.match(css, /\.bt-tree-toggle:not\(\.bt-tree-leaf\):hover\{background:var\(--bt-hover\)\}/)
  assert.match(css, /\.bt-tree-toggle:focus-visible\{outline:2px solid var\(--bt-accent\)/)
  assert.match(css, /\.bt-tree-toggle\[aria-expanded=false\] \.bt-tree-chev\{transform:rotate\(-90deg\)\}/)
  assert.doesNotMatch(css, /\.bt-tree-toggle\[aria-expanded=false\]\{transform:rotate/)
})

test('sidebar tree draws the structure entry\'s nodeActions after each row', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  assert.match(src, /actions: structure\?\.nodeActions/)
  assert.match(src, /typeof actions === 'function' \? h\(NodeActions, \{ component: actions, bot \}\)/)
  assert.match(src, /children\.map\(child => h\(TreeNode, \{[^}]*actions \}\)\)/)
})

test('row context menu renders the structure entry\'s menuItems', async () => {
  const { pluginItems } = await import('../src/client/flybot-registry.js')
  const bot = { id: 'b', name: 'B' }
  const notes = []
  const actions = { notify: t => notes.push(t) }
  assert.deepEqual(pluginItems(undefined, bot, actions), [])
  assert.deepEqual(pluginItems({ menuItems: () => { throw new Error('x') } }, bot, actions), [])
  const items = pluginItems({ menuItems: ({ bot }) => [
    { id: 'a', label: 'Shown ' + bot.id, visible: true, run: () => 'done' },
    { id: 'h', label: 'Hidden', visible: false, run: () => {} },
    { id: 'bad', label: 'No run' },
  ] }, bot, actions)
  assert.deepEqual(items.map(i => i[0]), ['Shown b'])
  await items[0][1]()
  assert.deepEqual(notes, ['done'])
})
