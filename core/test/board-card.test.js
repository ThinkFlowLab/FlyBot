// Task-card identity, and the one component that draws a task card. The view test next door
// proves the board emits it; this file proves the identity rules and the component, without React.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { taskCard, taskCardKey } from '../src/shared/board-card.js'

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
const { BoardCard, TASK_SKIN } = module.exports

const all = (node, out = []) => {
  if (Array.isArray(node)) { for (const item of node) all(item, out); return out }
  if (node === null || typeof node !== 'object') return out
  out.push(node)
  all(node.children, out)
  return out
}
const textOf = node => (typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(textOf).join('') : '')

test('a task card keeps its own id', () => {
  assert.equal(taskCardKey('task-abc'), 'task:task-abc')
  assert.equal(taskCardKey('  '), null)
  assert.equal(taskCard(null), null)
  const card = taskCard({ id: 'task-abc', title: 'Ship it', note: 'halfway', ownerBotName: 'Dev4' })
  assert.equal(card.source, 'task')
  assert.equal(card.key, 'task:task-abc')
  assert.equal(card.id, 'task-abc')
  assert.equal(card.title, 'Ship it')
})

test('the task card draws with the task skin and its identity', () => {
  const task = taskCard({ id: 'task-abc', title: 'Ship it' })
  const node = BoardCard({ card: task, skin: TASK_SKIN, idText: '#abc', note: 'halfway' })
  assert.equal(node.props.className, 'bt-board-card')
  assert.equal(node.props['data-source'], 'task')
  assert.equal(node.props['data-key'], 'task:task-abc')
  assert.match(textOf(node), /Ship it/)
  assert.match(textOf(node), /halfway/)
  assert.equal(all(node).some(item => item.props?.className === TASK_SKIN.badge), false)
})
