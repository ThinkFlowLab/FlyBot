// The release path is strict (#1730): build -> test -> publish runs in declared order, a node
// whose required input was never produced is refused before it starts, and a second start after
// a crash between the claim and the result returns the run where it was instead of minting a
// second downstream task. Pure frontier reads only; nothing here starts a Bot.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeNode, freshStatus, normalizeGraph, startFrontier, unmetRequired } from '../src/graph.js'

const releaseGraph = () => normalizeGraph({
  strict: true,
  nodes: [
    { id: 'build', name: 'Build', outputs: [{ name: 'artifact' }] },
    { id: 'test', name: 'Test', inputs: [{ name: 'artifact', required: true }], outputs: [{ name: 'report' }] },
    { id: 'publish', name: 'Publish', inputs: [{ name: 'report', required: true }] },
  ],
  edges: [
    { from: 'build', to: 'test' },
    { from: 'test', to: 'publish' },
  ],
})

test('a strict release graph runs build -> test -> publish in declared order (#1730)', () => {
  const graph = releaseGraph()
  assert.equal(graph.strict, true)
  let status = freshStatus(graph)
  const started = []
  let step = startFrontier(graph, status)
  assert.deepEqual(step.started, ['build'], 'only the first declared node starts')
  started.push(...step.started)
  status = step.status

  step = completeNode(graph, status, 'build', { outputs: { artifact: 'dist/app.tgz' } })
  assert.deepEqual(step.started, ['test'])
  started.push(...step.started)
  status = step.status

  step = completeNode(graph, status, 'test', { outputs: { report: 'tests-ok' } })
  assert.deepEqual(step.started, ['publish'])
  started.push(...step.started)
  status = step.status

  const done = completeNode(graph, status, 'publish', { outputs: {} })
  assert.deepEqual(done.started, [])
  assert.equal(done.finished, true)
  assert.deepEqual(started, ['build', 'test', 'publish'])
})

test('a node whose required input was never produced is refused (#1730)', () => {
  const graph = releaseGraph()
  assert.deepEqual(unmetRequired(graph, 'test', {}), ['artifact'], 'no upstream output means no start')
  assert.deepEqual(unmetRequired(graph, 'test', { build: { artifact: 'dist/app.tgz' } }), [])
  assert.deepEqual(unmetRequired(graph, 'publish', { build: { artifact: 'dist/app.tgz' }, test: { report: 'tests-ok' } }), [])
  assert.deepEqual(unmetRequired(graph, 'publish', { build: { artifact: 'dist/app.tgz' } }), ['report'])
})

test('a second start after a crash between claim and result adds no downstream task (#1730)', () => {
  const graph = releaseGraph()
  let status = freshStatus(graph)
  let step = startFrontier(graph, status)
  status = completeNode(graph, step.status, 'build', { outputs: { artifact: 'dist/app.tgz' } }).status
  assert.equal(status.test, 'running', 'test is claimed when the process dies')

  // The restart reads the persisted status: the claimed node is not started a second time and
  // the node behind it is not reached early.
  const persisted = JSON.parse(JSON.stringify(status))
  const restart = startFrontier(graph, persisted)
  assert.deepEqual(restart.started, [], 'a running node is not started again')
  assert.equal(restart.status.publish, 'queued', 'publish waits for the claimed result')

  // The claimed result lands once: publish starts once, and a third start sees it running.
  const afterResult = completeNode(graph, persisted, 'test', { outputs: { report: 'tests-ok' } })
  assert.deepEqual(afterResult.started, ['publish'])
  const again = startFrontier(graph, afterResult.status)
  assert.deepEqual(again.started, [], 'no second publish task')
  assert.equal(again.status.publish, 'running')
})
