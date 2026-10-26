// One card behind two boards (#1265, step 1): the identity a card carries, and the one component
// that draws a GitHub card and a task card. The view tests next door prove each board emits it;
// this file proves the identity rules and the component itself, without React.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { CARD_SOURCES, githubCard, githubCardKey, sameCard, taskCard, taskCardKey } from '../src/shared/board-card.js'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/board-card.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise,
  require: (name) => {
    const platform = {
      react: { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }) },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { BoardCard, DELIVERY_SKIN, TASK_SKIN } = module.exports

const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node && typeof node === 'object') { out.push(node); all(node.children, out) }
  return out
}
const textOf = node => (typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(textOf).join('') : '')

const row = (number, extra) => ({ number, kind: 'pr', title: `Row ${number}`, labels: ['area:ui'], owner: 'Dev4', ownerKind: 'bot', badge: 'pass-enqueue', sha: 'abc1234', url: 'https://example.invalid/1', ...extra })

test('a repository card is keyed by repository and number, so an issue and its pull request are one card', () => {
  assert.equal(githubCardKey('o/r', 12), 'o/r#12')
  assert.equal(githubCardKey('  o/r  ', '12'), 'o/r#12')
  assert.equal(githubCardKey('', 12), null)
  assert.equal(githubCardKey('o/r', 0), null)
  assert.equal(githubCardKey('o/r', 'x'), null)
  const issue = githubCard(row(12, { kind: 'issue' }), 'o/r')
  const pull = githubCard(row(12, { kind: 'pr' }), 'o/r')
  assert.equal(issue.key, pull.key)
  assert.equal(sameCard(issue, pull), true)
  assert.equal(issue.source, 'github')
  assert.deepEqual(CARD_SOURCES, ['github', 'task'])
})

test('two repositories with the same number are two cards, and a row without one says so', () => {
  assert.notEqual(githubCardKey('o/a', 7), githubCardKey('o/b', 7))
  assert.equal(githubCard(row(7), 'o/a').repo, 'o/a')
  // No repository: no cross-repository identity is implied, so the key names the kind instead.
  assert.equal(githubCard(row(7), null).key, 'github:pr:7')
  assert.equal(githubCard({ number: 0 }, 'o/r'), null)
})

test('a task card keeps its own id, and the two sources never collide', () => {
  assert.equal(taskCardKey('task-abc'), 'task:task-abc')
  assert.equal(taskCardKey('  '), null)
  assert.equal(taskCard(null), null)
  const card = taskCard({ id: 'task-abc', title: 'Ship it', note: 'halfway', ownerBotName: 'Dev4' })
  assert.equal(card.source, 'task')
  assert.equal(card.key, 'task:task-abc')
  assert.equal(card.title, 'Ship it')
  assert.equal(card.owner, null)
  assert.equal(sameCard(card, githubCard(row(7), 'task:task-abc')), false)
  assert.equal(sameCard(card, { key: 'task:task-abc' }), true)
})

test('one component draws both sources, each with the skin and identity of its board', () => {
  const repository = githubCard(row(12, { linked: 13 }), 'o/r')
  const task = taskCard({ id: 'task-abc', title: 'Ship it' })
  const repositoryCard = BoardCard({ card: repository, skin: DELIVERY_SKIN, idText: '#12', badge: 'PASS · waiting for enqueue' })
  const taskCardNode = BoardCard({ card: task, skin: TASK_SKIN, idText: '#abc' })

  assert.equal(repositoryCard.props.className, 'bt-del-card')
  assert.equal(repositoryCard.props['data-source'], 'github')
  assert.equal(repositoryCard.props['data-key'], 'o/r#12')
  assert.match(textOf(repositoryCard), /PASS · waiting for enqueue/)
  assert.match(textOf(repositoryCard), /linked to/)

  assert.equal(taskCardNode.props.className, 'bt-board-card')
  assert.equal(taskCardNode.props['data-source'], 'task')
  assert.equal(taskCardNode.props['data-key'], 'task:task-abc')
  assert.match(textOf(taskCardNode), /Ship it/)

  // The badge slot is only drawn when a board hands one in, so a task card keeps its own top row.
  assert.equal(all(taskCardNode).some(node => node.props?.className === TASK_SKIN.badge), false)
})
