// #2583: an issue fast line's Triage node claims the issue and opens the pull request,
// then ends without its `state` line. The work is real and irreversible, so a format
// slip must not kill the run before gate/enqueue: the step stands, and the run record
// names the pull request. A step that produced nothing still fails (#1773).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstBranchValue, stepArtifacts } from '../src/graph.js'
import { createWorkflowService } from '../src/service.js'

const NOW = 1_700_000_000_000
const PR_URL = 'https://github.com/ThinkFlowLab/FlyBot/pull/999'

// The failing fast line's shape: `state: ready → claim` is the first branch and the
// `else` route goes to escalate, so a reply without `state` owes a verdict AND would
// otherwise fall into escalate rather than the work nodes.
function fastLineGraph() {
  return {
    nodes: [
      { id: 'triage', name: 'Triage', prompt: 'Triage the issue.' },
      { id: 'claim', name: 'Claim', prompt: 'Claim the issue.' },
      { id: 'escalate', name: 'Escalate', prompt: 'Report where it stopped.' },
    ],
    edges: [
      { from: 'triage', to: 'claim', when: { output: 'state', eq: 'ready' } },
      { from: 'triage', to: 'escalate', when: { else: true } },
    ],
  }
}

function liveHarness(graph = fastLineGraph()) {
  const dispatched = []
  const warnings = []
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
    warn: message => warnings.push(message),
  })
  const made = svc.define({ name: 'Fast line', ...graph }).workflows.find(item => item.name === 'Fast line')
  return { svc, id: made.id, dispatched, warnings }
}

const laneOf = (views, id) => views.workflows.find(item => item.id === id)
const messagesOf = (views, id) => laneOf(views, id).messages.map(line => line.text ?? line.key ?? '')

async function runTriageTo(text, graph = fastLineGraph()) {
  const harness = liveHarness(graph)
  let views = await harness.svc.runNamed({ workflow: 'Fast line', brief: 'i2583-impl' })
  views = await harness.svc.stepResult({ botId: harness.dispatched[0].botId, text })
  return { ...harness, views }
}

test('#2583: a Triage step that opened a PR stands and continues down its first branch', async () => {
  const { views, id } = await runTriageTo(`Claimed #2583 — first step: read the issue.\nOpened ${PR_URL} with the fix.`)
  const run = laneOf(views, id).run
  assert.equal(run.nodeStatus.triage, 'done', 'the work stands even though the OUTPUT line is missing')
  assert.equal(run.nodeStatus.claim, 'running', 'the run continues to the work node instead of dying on Triage')
  assert.equal(run.nodeStatus.escalate, 'skipped', 'the else route the step never chose is not taken')
  assert.equal(run.status, 'running')
  assert.equal(run.outputMissing, true, 'the run record says a gate-read OUTPUT was missing')
  assert.equal(run.producedPull, 999, 'the run record names the pull request the node produced')
  assert.ok(messagesOf(views, id).some(text => text.includes('PR #999')), 'the stage log names the pull request')
})

test('#2583: the claim comment alone is enough evidence, and no PR number is invented', async () => {
  const { views, id } = await runTriageTo('Claimed #2583 — first step: read the issue.')
  const run = laneOf(views, id).run
  assert.equal(run.nodeStatus.triage, 'done')
  assert.equal(run.nodeStatus.claim, 'running')
  assert.equal(run.outputMissing, true)
  assert.equal(run.producedPull, undefined, 'no pull request was named')
})

test('#2583: a step that produced nothing still fails the run at its missing OUTPUT', async () => {
  const { views, id } = await runTriageTo('Looked at the issue. Nothing to report yet.')
  const run = laneOf(views, id).run
  assert.equal(run.status, 'failed')
  assert.equal(run.nodeStatus.triage, 'failed')
  assert.equal(run.nodeStatus.claim, 'queued', 'the run does not advance past a silent step')
  assert.equal(run.nodeStatus.escalate, 'queued')
  assert.equal(run.outputMissing, true)
  assert.match(run.failure?.text ?? '', /Missing OUTPUT state/)
})

test('#2583: a quoted PR reference is not evidence that this step produced one', async () => {
  const { views, id } = await runTriageTo('The issue follows up on PR #999, which is already closed.')
  const run = laneOf(views, id).run
  assert.equal(run.status, 'failed', 'a line without a creation verb is not this step\'s work')
  assert.equal(run.nodeStatus.triage, 'failed')
})

test('#2583: a verdict gate keeps #1773 — naming a PR does not stand in for the verdict', async () => {
  const graph = {
    nodes: [
      { id: 'check', name: 'Check', prompt: 'Check the pull request.', outputs: [{ name: 'summary', type: 'text' }, { name: 'verdict', type: 'text' }] },
      { id: 'merge', name: 'Merge', inputs: [{ name: 'verdict', type: 'text', required: true }] },
    ],
    edges: [{ from: 'check', to: 'merge', when: { output: 'verdict', eq: 'PASS' } }],
  }
  const { views, id } = await runTriageTo(`Checked ${PR_URL} — 3 checks green.`, graph)
  const run = laneOf(views, id).run
  assert.equal(run.status, 'failed', 'only the state line is degraded, not every missing verdict')
  assert.equal(run.nodeStatus.check, 'failed')
  assert.match(run.failure?.text ?? '', /Missing OUTPUT verdict/)
})

test('#2583: stepArtifacts reads a pull request or a claim line, and nothing else', () => {
  assert.deepEqual(stepArtifacts(`Opened ${PR_URL}`, {}), { pull: 999, claimed: false })
  assert.deepEqual(stepArtifacts('Branch pushed; see pull/999 for details.', {}), { pull: 999, claimed: false })
  assert.deepEqual(stepArtifacts('Opened PR #999 with the fix.', {}), { pull: 999, claimed: false })
  assert.deepEqual(stepArtifacts('Claimed-by: Triage', {}), { pull: null, claimed: true })
  assert.deepEqual(stepArtifacts('Claimed #2583 — first step: read the issue.', {}), { pull: null, claimed: true })
  assert.deepEqual(stepArtifacts('Follows PR #999, which is closed.', {}), { pull: null, claimed: false })
  assert.deepEqual(stepArtifacts('No work yet.', {}), { pull: null, claimed: false })
  assert.deepEqual(stepArtifacts('', { summary: `Opened ${PR_URL}` }), { pull: 999, claimed: false }, 'outputs are read too')
})

test('#2583: a failOnce retry that later prints its OUTPUT clears the missing-output record', async () => {
  const graph = fastLineGraph()
  graph.nodes[0].failOnce = true
  const { svc, id, dispatched } = liveHarness(graph)
  let views = await svc.runNamed({ workflow: 'Fast line', brief: 'i2583-impl' })
  views = await svc.stepResult({ botId: dispatched[0].botId, text: 'Nothing to report yet.' })
  assert.equal(laneOf(views, id).run.outputMissing, true, 'the failed attempt was a format failure')
  views = await svc.stepResult({ botId: dispatched[0].botId, text: 'OUTPUT state: ready' })
  const run = laneOf(views, id).run
  assert.equal(run.nodeStatus.triage, 'done', 'the retry delivered the verdict')
  assert.equal(run.outputMissing, undefined, 'a delivered OUTPUT is not still recorded as missing')
})

test('#2583: firstBranchValue names the branch a standing step continues on', () => {
  const graph = {
    nodes: [{ id: 'triage', name: 'Triage' }, { id: 'claim', name: 'Claim' }, { id: 'escalate', name: 'Escalate' }],
    edges: [
      { from: 'triage', to: 'claim', when: { output: 'state', eq: 'ready' } },
      { from: 'triage', to: 'escalate', when: { else: true } },
    ],
  }
  assert.equal(firstBranchValue(graph, 'triage', 'state'), 'ready')
  assert.equal(firstBranchValue(graph, 'triage', 'status'), null)
  assert.equal(firstBranchValue(graph, 'claim', 'state'), null)
})
