// #3286: a run creates its node Bots with bounded concurrency. A host answers a
// spawn in about ten seconds, so a six-node lane built one Bot at a time needs
// ~66s and cannot fit the 60s batch deadline the service puts around a start.
// Four at a time finishes the same lane in two waves (~20s).
//
// The host is a fake clock: a spawn resolves only when the test moves time to its
// due moment, so the timing assertions are about how many waves `spawnAll` needs,
// not about how fast this machine is.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as ephemeralModule from '../src/ephemeral.js'

const NODES = Array.from({ length: 6 }, (_, index) => ({
  id: `node-${index + 1}`,
  name: `Node ${index + 1}`,
  role: 'dev',
  prompt: `Do step ${index + 1}.`,
}))
const DELAY = 10_000

const tick = () => new Promise(done => setImmediate(done))

function fakeHost(delayFor = () => DELAY) {
  let now = 0
  let active = 0
  let maxActive = 0
  const calls = []
  const queue = []
  const spawn = (spec) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    const entry = { spec, id: `eph-${spec.nodeId}`, due: now + delayFor(spec) }
    calls.push(entry.spec.nodeId)
    return new Promise((resolve) => {
      entry.finish = () => {
        active -= 1
        resolve(entry.id)
      }
      queue.push(entry)
    })
  }
  async function advance() {
    const due = Math.min(...queue.map(entry => entry.due))
    now = due
    const ready = queue.filter(entry => entry.due <= due)
    for (const entry of ready) queue.splice(queue.indexOf(entry), 1)
    for (const entry of ready) entry.finish()
    await tick()
  }
  return {
    spawn,
    calls,
    advance,
    get now() { return now },
    get maxActive() { return maxActive },
    get pending() { return queue.length },
  }
}

// Drives the fake clock until `spawnAll` settles, failing loudly if it waits on
// a spawn that the test never released.
async function run(batch, host) {
  let done = false
  batch.then(() => { done = true }, () => { done = true })
  while (!done) {
    await tick()
    if (done) break
    if (host.pending === 0) throw new Error('spawnAll waits with no spawn in flight')
    await host.advance()
  }
  return batch
}

test('#3286: spawns run four at a time and a six-node lane fits the 60s batch deadline', async () => {
  const host = fakeHost()
  const batch = ephemeralModule.spawnAll(NODES, [], host.spawn)
  const ephemeral = await run(batch, host)

  assert.equal(host.maxActive, 4, `never more than four spawns in flight: ${host.maxActive}`)
  assert.equal(Object.keys(ephemeral).length, 6, 'every node got a Bot')
  // Six nodes at 10s each: serial would be 60s (the old failure) and four at a
  // time is 20s. The bound keeps a slow machine from passing by luck.
  assert.ok(host.now < 60_000, `the whole batch took ${host.now}ms of host time, past the 60s deadline`)
  assert.ok(host.now <= 3 * DELAY, `two waves at ${DELAY}ms were expected, the batch took ${host.now}ms`)
  assert.equal(ephemeralModule.SPAWN_CONCURRENCY, 4, 'the default width is four')
})

test('#3286: a failed spawn stops new starts, lets the ones in flight land, and reports what was made', async () => {
  const calls = []
  const pending = []
  const spawn = (spec) => {
    calls.push(spec.nodeId)
    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  }
  const batch = ephemeralModule.spawnAll(NODES, [], spawn, '', {}, 2)
  const failed = batch.then(() => null, error => error)
  await tick()
  assert.deepEqual(calls, ['node-1', 'node-2'], 'two spawns are in flight')

  pending[0].resolve('eph-node-1')
  pending[1].resolve('eph-node-2')
  await tick()
  assert.deepEqual(calls, ['node-1', 'node-2', 'node-3', 'node-4'], 'both workers took the next nodes')

  // The third node the host answers is a refusal. The fourth is still in flight:
  // it must land, and no fifth or sixth spawn may start.
  pending[2].reject(new Error('the host could not create the coder'))
  await tick()
  assert.deepEqual(calls, ['node-1', 'node-2', 'node-3', 'node-4'], 'no new spawn starts after the refusal')
  pending[3].resolve('eph-node-4')

  const error = await failed
  assert.equal(error?.message, 'the host could not create the coder', 'the host reason is carried')
  assert.deepEqual(error.spawned, ['eph-node-1', 'eph-node-2', 'eph-node-4'], 'exactly the Bots that were made, in the order they landed')
  assert.deepEqual(calls, ['node-1', 'node-2', 'node-3', 'node-4'], 'the other two nodes were never asked for')
})

test('#3286: the result keeps the graph order even when the Bots land out of order', async () => {
  const delays = [50_000, 10_000, 20_000, 30_000, 40_000, 5_000]
  const host = fakeHost(spec => delays[Number(spec.nodeId.slice('node-'.length)) - 1])
  const ephemeral = await run(ephemeralModule.spawnAll(NODES, [], host.spawn), host)

  assert.deepEqual(Object.keys(ephemeral), NODES.map(node => node.id), 'the keys follow the nodes, not the answers')
  for (const node of NODES) assert.equal(ephemeral[node.id], `eph-${node.id}`)
})
