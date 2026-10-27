// The GitHub delivery board is gone (#1363): the metrics panel, its host endpoints and the
// probe script. These assertions are red while that surface is still in the tree, and red
// again if a later change puts the panel or either endpoint back.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const url = (path) => new URL(`../${path}`, import.meta.url)
const read = (path) => readFileSync(url(path), 'utf8')

const gone = [
  'src/host/delivery-board.js',
  'src/host/delivery-repo.js',
  'src/client/delivery-view.js',
  'src/client/delivery-chart.js',
  'src/shared/workflow-board.js',
  'scripts/delivery-probe.mjs',
]

test('#1363: the delivery board files are gone', () => {
  for (const path of gone) assert.equal(existsSync(url(path)), false, path)
})

test('#1363: the host does not serve delivery-board or delivery-probe', () => {
  const channel = read('src/host/channel.js')
  const authz = read('src/host/authz.js')
  const index = read('index.js')
  for (const source of [channel, authz, index]) {
    assert.doesNotMatch(source, /delivery-board/)
    assert.doesNotMatch(source, /delivery-probe/)
    assert.doesNotMatch(source, /deliveryBoard/)
  }
})

test('#1363: the task board does not mount the delivery view', () => {
  const kanban = read('src/client/kanban.js')
  const client = read('src/client/index.js')
  assert.doesNotMatch(kanban, /delivery-view|DeliveryView|deliveryBoard|DELIVERY_CSS/)
  assert.doesNotMatch(client, /delivery-board|delivery-probe|deliveryBoard|deliveryProbe/)
  assert.match(kanban, /h\(BoardView/)
})
