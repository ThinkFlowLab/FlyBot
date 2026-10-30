// #1773: a step that declares an OUTPUT its gate reads, and then ends without
// printing it, is not a finished step. Silence is not a verdict: the gate must
// never be read from it, and the run must not close as done.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { missingVerdicts, normalizeGraph } from '../src/graph.js'
import { createWorkflowService } from '../src/service.js'

const NOW = 1_700_000_000_000

// Check declares two outputs on purpose: readStepResult only fills a single
// declared output from the reply body, so the gate's verdict can only be answered
// by a real `OUTPUT verdict:` line.
function gateGraph() {
  return {
    nodes: [
      { id: 'claim', name: 'Claim', prompt: 'Claim the issue.', outputs: [{ name: 'issue', type: 'text' }] },
      { id: 'check', name: 'Check', prompt: 'Check the pull request.', outputs: [{ name: 'summary', type: 'text' }, { name: 'verdict', type: 'text' }] },
      { id: 'merge', name: 'Merge', inputs: [{ name: 'verdict', type: 'text', required: true }] },
    ],
    edges: [
      { from: 'claim', to: 'check' },
      { from: 'check', to: 'merge', when: { output: 'verdict', eq: 'PASS' } },
    ],
  }
}

function liveHarness(graph = gateGraph()) {
  const dispatched = []
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => NOW,
    bots: () => [],
    spawn: async () => `eph-${++seq}`,
    release: async () => {},
    dispatch: async (step) => {
      dispatched.push(step)
      return { ok: true }
    },
  })
  const made = svc.define({ name: 'Gate', ...graph }).workflows.find(item => item.name === 'Gate')
  return { svc, id: made.id, dispatched }
}

const laneOf = (views, id) => views.workflows.find(item => item.id === id)
const messagesOf = (views, id) => laneOf(views, id).messages.map(line => line.text ?? line.key ?? '')

// The run the issue reported: claim passes, then Check answers with prose only.
async function runCheckToSilence() {
  const { svc, id, dispatched } = liveHarness()
  let views = await svc.runNamed({ workflow: 'Gate', brief: 'bs136-impl' })
  views = await svc.stepResult({ botId: dispatched[0].botId, text: 'OUTPUT issue: bs136-impl' })
  assert.deepEqual(laneOf(views, id).run.running, ['check'], 'Check is the step under test')
  const checkBot = dispatched[1].botId
  views = await svc.stepResult({ botId: checkBot, text: 'Retrying after a brief pause.' })
  return { svc, id, views }
}

test('#1773: a step that never prints its verdict fails the run instead of finishing it', async () => {
  const { id, views } = await runCheckToSilence()
  const run = laneOf(views, id).run
  assert.equal(run.status, 'failed', 'the run must not close as done')
  assert.equal(run.nodeStatus.check, 'failed', 'a silent verdict is not a completed step')
  assert.equal(run.nodeStatus.merge, 'queued', 'the gate is held, not read from silence')
  assert.ok(!messagesOf(views, id).some(text => text.includes('✓ 完成')), 'the stage must not print the done line')
})

test('#1773: the run record names the step and the OUTPUT contract it missed', async () => {
  const { id, views } = await runCheckToSilence()
  const failure = laneOf(views, id).run.failure
  assert.equal(failure?.nodeName, 'Check')
  assert.match(failure?.text ?? '', /Missing OUTPUT verdict/)
})

test('#1773: a delivered verdict still completes the step and opens the gate', async () => {
  const { svc, id, dispatched } = liveHarness()
  let views = await svc.runNamed({ workflow: 'Gate', brief: 'bs136-impl' })
  views = await svc.stepResult({ botId: dispatched[0].botId, text: 'OUTPUT issue: bs136-impl' })
  views = await svc.stepResult({ botId: dispatched[1].botId, text: 'OUTPUT summary: 2 checks green\nOUTPUT verdict: PASS' })
  const run = laneOf(views, id).run
  assert.equal(run.nodeStatus.check, 'done')
  assert.equal(run.nodeStatus.merge, 'running', 'PASS takes the gate')
  assert.equal(run.status, 'running')
})

test('#1773: a non-matching verdict is a skip, not a missing one', async () => {
  const { svc, id, dispatched } = liveHarness()
  let views = await svc.runNamed({ workflow: 'Gate', brief: 'bs136-impl' })
  views = await svc.stepResult({ botId: dispatched[0].botId, text: 'OUTPUT issue: bs136-impl' })
  views = await svc.stepResult({ botId: dispatched[1].botId, text: 'OUTPUT summary: red\nOUTPUT verdict: FAIL' })
  const run = laneOf(views, id).run
  assert.equal(run.nodeStatus.check, 'done', 'a real verdict completes the step')
  assert.equal(run.nodeStatus.merge, 'skipped', 'the gate answered FAIL')
  assert.equal(run.status, 'done')
})

test('#1773: only the outputs a gate reads are required, and silence names each one', () => {
  const graph = normalizeGraph({
    nodes: [
      { id: 'check', name: 'Check', outputs: [{ name: 'summary' }, { name: 'verdict' }, { name: 'detail' }] },
      { id: 'merge', name: 'Merge' },
    ],
    edges: [{ from: 'check', to: 'merge', when: { output: 'verdict', eq: 'PASS' } }],
  })
  assert.deepEqual(missingVerdicts(graph, 'check', {}), ['verdict'])
  assert.deepEqual(missingVerdicts(graph, 'check', { summary: 'green' }), ['verdict'])
  assert.deepEqual(missingVerdicts(graph, 'check', { verdict: 'FAIL' }), [])
  const plain = normalizeGraph({
    nodes: [
      { id: 'plan', name: 'Plan', outputs: [{ name: 'plan' }] },
      { id: 'code', name: 'Code' },
    ],
    edges: [{ from: 'plan', to: 'code' }],
  })
  assert.deepEqual(missingVerdicts(plain, 'plan', {}), [], 'an output no gate reads stays optional')
})
