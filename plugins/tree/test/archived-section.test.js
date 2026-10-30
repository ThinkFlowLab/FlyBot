// #810: an Archived group the sidebar can reach. Archived Bots are hidden from ds-bot's own list
// (#452), so the only way back to one of their chats was the right-click menu. This section lists
// them through the same `flybot.sidebar.section` slot the reorganization notice uses; the list
// itself is untouched (`structure.include` still hides them).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { findAll, reactStub, renderToString } from './render.js'

const loadClient = () => {
  let mod
  globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => reactStub) } } }
  new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()
  return mod
}

const archived = (id, name, own = { archived: { reason: 'idle' } }) => ({ id, name, createdAt: 1, fields: { 'flybot-tree': own } })

test('#810: the section draws nothing when no Bot is archived', () => {
  const mod = loadClient()
  const bots = [
    { id: 'c', name: 'Chief', createdAt: 1, isMain: true, fields: { 'flybot-tree': { parent: null, treeRole: 'root' } } },
    { id: 'live', name: 'FlyBot 开发', createdAt: 2, fields: { 'flybot-tree': { parent: 'c', treeRole: 'dev' } } },
  ]
  assert.deepEqual(mod.archivedOf(bots), [])
  assert.equal(renderToString(reactStub.createElement(mod.ArchivedView, { bots: mod.archivedOf(bots) })), '')
  assert.equal(renderToString(reactStub.createElement(mod.ArchivedView, {})), '')
})

test('#810: archived Bots are listed collapsed by default; expanding shows the row and its status tag', () => {
  const mod = loadClient()
  const bots = [archived('old', 'Old Dev'), { id: 'c', name: 'Chief', fields: {} }]
  const list = mod.archivedOf(bots)
  assert.deepEqual(list.map(b => b.id), ['old'])

  const closed = renderToString(reactStub.createElement(mod.ArchivedView, { bots: list }))
  assert.match(closed, /aria-label="Archived bots"/)
  assert.match(closed, /class="flybot-tree-head"[^>]*aria-expanded="false"/)
  assert.match(closed, />Archived \(1\)</)
  assert.doesNotMatch(closed, /flybot-tree-name/, 'collapsed: no rows')

  const open = renderToString(reactStub.createElement(mod.ArchivedView, { bots: list, expanded: true }))
  assert.match(open, /aria-expanded="true"/)
  assert.match(open, /data-bot-id="old"/)
  assert.match(open, /class="flybot-tree-name">Old Dev</)
  assert.match(open, /class="flybot-tree-role">archived</)
})

test('#810: the header counts the archived Bots, and each row opens that chat', () => {
  const mod = loadClient()
  const list = [archived('a', 'A'), archived('b', 'B')]
  const html = renderToString(reactStub.createElement(mod.ArchivedView, { bots: list, expanded: true }))
  assert.match(html, />Archived \(2\)</)
  assert.equal(findAll(reactStub.createElement(mod.ArchivedView, { bots: list, expanded: true }), n => n.props.className === 'flybot-tree-open').length, 2)

  const opened = []
  const view = reactStub.createElement(mod.ArchivedView, { bots: list, expanded: true, openBot: id => opened.push(id) })
  const rowB = findAll(view, n => n.props.className === 'flybot-tree-open')
    .find(n => findAll(n, c => c.props.className === 'flybot-tree-name')[0].children[0] === 'B')
  rowB.props.onClick()
  assert.deepEqual(opened, ['b'])
  // No openSession (an older ds-bot): the rows still show, and clicking does nothing.
  const plain = reactStub.createElement(mod.ArchivedView, { bots: list, expanded: true })
  findAll(plain, n => n.props.className === 'flybot-tree-open')[0].props.onClick()
  assert.deepEqual(opened, ['b'])
})

test('#810: a merged Bot says where it went; a leftover 归档- name needs no field', () => {
  const mod = loadClient()
  const merged = archived('m', 'Old Editor', { archived: { reason: 'merged', intoName: 'Editor' } })
  const prefixed = { id: 'p', name: '归档-FlyBot 维护', createdAt: 3, fields: { 'flybot-tree': { parent: 'c', treeRole: 'maint' } } }
  const bare = { id: 'n', name: 'Archive-Writer', createdAt: 4, fields: {} }
  assert.deepEqual(mod.archivedOf([merged, prefixed, bare]).map(b => b.id), ['m', 'p', 'n'])

  const html = renderToString(reactStub.createElement(mod.ArchivedView, { bots: [merged], expanded: true }))
  assert.match(html, /class="flybot-tree-role">archived · merged into Editor</)
})

// #1793: `archive_bot` retires a Bot out of the tree (`forestOf` already skips it), but `treeOf` kept
// drawing it as a working member and the Archived section did not list it, so its chat was lost.
test('#1793: a retired Bot leaves the tree and opens from the Archived section with a retired tag', async () => {
  const mod = loadClient()
  const bots = [
    { id: 'c', name: 'Chief', createdAt: 1, isMain: true, fields: { 'flybot-tree': { parent: null, treeRole: 'root' } } },
    { id: 'live', name: 'Live Dev', createdAt: 2, fields: { 'flybot-tree': { parent: 'c', treeRole: 'dev' } } },
    { id: 'gone', name: 'Retired Dev', createdAt: 3, fields: { 'flybot-tree': { parent: 'c', treeRole: 'dev', retired: true } } },
  ]
  const forest = mod.buildForest((await mod.treeOf({ bots: () => bots })).nodes)
  const drawn = []
  const walk = list => list.forEach(node => { drawn.push(node.name); walk(node.children) })
  walk(forest)
  assert.deepEqual(drawn, ['Chief', 'Live Dev'], 'the retired Bot is not drawn as a working member')
  assert.deepEqual(mod.forestOf(bots).map(root => root.name), ['Chief'], 'the sidebar forest already left it out')

  const list = mod.archivedOf(bots)
  assert.deepEqual(list.map(b => b.id), ['gone'])
  const html = renderToString(reactStub.createElement(mod.ArchivedView, { bots: list, expanded: true }))
  assert.match(html, /data-bot-id="gone"/)
  assert.match(html, /class="flybot-tree-role">retired</)

  const opened = []
  const view = reactStub.createElement(mod.ArchivedView, { bots: list, expanded: true, openBot: id => opened.push(id) })
  findAll(view, n => n.props.className === 'flybot-tree-open')[0].props.onClick()
  assert.deepEqual(opened, ['gone'], 'the retired Bot\'s chat stays reachable')
})

test('#1793: retired and archived stay distinct, and both are listed', () => {
  const mod = loadClient()
  const retired = { id: 'r', name: 'Retired', createdAt: 1, fields: { 'flybot-tree': { parent: 'c', treeRole: 'dev', retired: true } } }
  const both = { id: 'b', name: 'Retired Editor', createdAt: 2, fields: { 'flybot-tree': { parent: 'c', treeRole: 'dev', retired: true, archived: { reason: 'merged', intoName: 'Editor' } } } }
  assert.equal(mod.statusOf(retired), 'retired')
  assert.equal(mod.statusOf(both), 'archived · merged into Editor')
  assert.deepEqual(mod.archivedOf([retired, both]).map(b => b.id), ['r', 'b'])
})

test('#810: the section is registered on the sidebar slot, and archived Bots stay out of the Bot list', async () => {
  const mod = loadClient()
  const sections = []
  const structures = []
  const flybot = {
    slots: { register: (name, entry) => { (name === 'flybot.sidebar.section' ? sections : structures).push(entry); return () => {} } },
    bots: async () => [
      { id: 'c', name: 'Chief', createdAt: 1, isMain: true, fields: { 'flybot-tree': { parent: null, treeRole: 'root' } } },
      archived('old', 'Old Dev'),
    ],
    fields: { on: () => () => {} },
  }
  const dispose = mod.apply({ flybot })
  assert.deepEqual(sections.map(e => [e.id, e.order]), [['flybot-tree-archived', 88], ['flybot-tree-reorg', 89]])
  assert.equal(typeof sections[0].component, 'function')
  await new Promise(r => setTimeout(r, 10))
  // The list itself does not change: the structure entry still hides the archived Bot.
  assert.equal(structures.at(-1).include('old'), false)
  assert.equal(structures.at(-1).include('c'), true)
  dispose()

  const off = []
  mod.apply({ flybot: { ...flybot, slots: { register: (name, entry) => { if (name === 'flybot.sidebar.section') off.push(entry.id); return () => {} } } } }, { archivedSection: false })
  assert.ok(!off.includes('flybot-tree-archived'), 'config.archivedSection: false turns the section off')
})
