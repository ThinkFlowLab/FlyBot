// #2658: the issue fast line's Triage node prints its result as declared OUTPUT
// lines (`OUTPUT pr: 2657 (verified)`) instead of naming the pull request in the
// prose, so `stepArtifacts` read the delivered work as nothing and failed the run
// after the pull request had already merged. The step's own declared OUTPUT is
// evidence too, but only the two shapes below: a pull number in `pr`/`pull`, or
// a full commit sha in `merged`/`merge-commit`. Everything else stays fail-closed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readStepResult, stepArtifacts } from '../src/graph.js'
import { createWorkflowService } from '../src/service.js'

const NOW = 1_700_000_000_000
const SHA = 'f840979143b5c8a2d4f60a7b2db0f87b7a9f0a11'

// The i2656 reply as it was posted: a summary line that says the work is done
// (no creation verb), a table naming the pull request, and the OUTPUT lines.
const I2656_REPLY = [
  '已修复并合入 main，回归测试全绿。',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  '| PR #2657 | `Owner: Triage`、`Reviewer: Reviewer` |',
  '| tip | `f840979143b5c8a2d4f60a7b2db0f87b7a9f0a11` |',
  '',
  'OUTPUT issue: 2656 (verified)',
  'OUTPUT pr: 2657 (verified)',
  `OUTPUT tip: ${SHA}`,
  'OUTPUT merged: not yet',
  'OUTPUT tier: T2',
  'OUTPUT tests: green',
].join('\n')

const stepOf = text => readStepResult(text, { id: 'triage', name: 'Triage' })

test('#2658: a declared OUTPUT pr is delivery evidence the prose never states', () => {
  const { text, outputs } = stepOf(I2656_REPLY)
  assert.equal(outputs.pr, '2657 (verified)')
  assert.deepEqual(stepArtifacts(text, outputs), { pull: 2657, claimed: false })
})

test('#2658: a value without a pull number is not guessed', () => {
  const none = stepOf('OUTPUT pr: none')
  assert.deepEqual(stepArtifacts(none.text, none.outputs), { pull: null, claimed: false })

  const missing = stepOf('Opened the branch, nothing else to name.')
  assert.deepEqual(stepArtifacts(missing.text, missing.outputs), { pull: null, claimed: false })

  // `pull` is the other name that carries a number.
  const pull = stepOf('OUTPUT pull: 42')
  assert.equal(stepArtifacts(pull.text, pull.outputs).pull, 42)

  // A name outside the table counts for nothing, whatever its value looks like.
  const other = stepOf('OUTPUT issue: 2656 (verified)')
  assert.deepEqual(stepArtifacts(other.text, other.outputs), { pull: null, claimed: false })
})

// #2685: the declared path took any run of digits, so a value that says there is no
// pull request ("blocked on issue 2658"), a decimal, or `0` became one. Only a value
// that *is* the number counts: a positive integer, optional leading `#`, optional
// trailing parenthetical.
test('#2685: a declared pr value counts only when it is the pull number', () => {
  assert.deepEqual(stepArtifacts('', { pr: 'none — blocked on issue 2658' }), { pull: null, claimed: false })
  assert.deepEqual(stepArtifacts('', { pr: '12.5' }), { pull: null, claimed: false })
  assert.deepEqual(stepArtifacts('', { pr: '0' }), { pull: null, claimed: false })
  assert.deepEqual(stepArtifacts('', { pr: 'PR #2657, not merged' }), { pull: null, claimed: false })
  assert.deepEqual(stepArtifacts('', { pr: '#2657' }), { pull: 2657, claimed: false })
  assert.deepEqual(stepArtifacts('', { pr: '2657 (verified)' }), { pull: 2657, claimed: false })
  assert.deepEqual(stepArtifacts('', { pull: '42' }), { pull: 42, claimed: false })
})

test('#2685: the prose rules still read a pull request the usual way', () => {
  assert.equal(stepArtifacts('Opened https://github.com/o/r/pull/2657 for it.', {}).pull, 2657)
  assert.equal(stepArtifacts('Branch pushed; see pull/2657 for details.', {}).pull, 2657)
  assert.equal(stepArtifacts('Opened PR #2657 with the fix.', {}).pull, 2657)
})

test('#2658: a 40-character sha in merged or merge-commit counts as delivered', () => {
  const merged = stepOf(`OUTPUT merged: ${SHA}`)
  assert.deepEqual(stepArtifacts(merged.text, merged.outputs), { pull: null, claimed: false, merged: true })

  const mergeCommit = stepOf(`Fixed.\nOUTPUT merge-commit: ${SHA}`)
  assert.deepEqual(stepArtifacts(mergeCommit.text, mergeCommit.outputs), { pull: null, claimed: false, merged: true })

  // A short or non-hex value is not a merge, and `merged` reading "no" is not a merge.
  assert.deepEqual(stepArtifacts('', { merged: 'f840979143b5' }), { pull: null, claimed: false })
  assert.deepEqual(stepArtifacts('', { merged: 'not yet' }), { pull: null, claimed: false })
  assert.deepEqual(stepArtifacts('', { 'merge-commit': 'deadbeef' }), { pull: null, claimed: false })
  // A sha in some other output name is not delivery evidence either.
  assert.deepEqual(stepArtifacts('', { tip: SHA }), { pull: null, claimed: false })
})

function fastLineHarness() {
  const dispatched = []
  let seq = 0
  const svc = createWorkflowService({
    persist: false,
    now: () => NOW,
    bots: () => [],
    spawn: async () => `eph-${++seq}`,
    release: async () => {},
    dispatch: async step => {
      dispatched.push(step)
      return { ok: true }
    },
    warn: () => {},
  })
  const made = svc.define({
    name: 'Fast line',
    nodes: [
      { id: 'triage', name: 'Triage', prompt: 'Triage the issue.' },
      { id: 'claim', name: 'Claim', prompt: 'Claim the issue.' },
      { id: 'escalate', name: 'Escalate', prompt: 'Report where it stopped.' },
    ],
    edges: [
      { from: 'triage', to: 'claim', when: { output: 'state', eq: 'ready' } },
      { from: 'triage', to: 'escalate', when: { else: true } },
    ],
  }).workflows.find(item => item.name === 'Fast line')
  return { svc, id: made.id, dispatched }
}

test('#2658: commitAdvance no longer fails a Triage step that delivered the pull request', async () => {
  const { svc, id, dispatched } = fastLineHarness()
  let views = await svc.runNamed({ workflow: 'Fast line', brief: 'i2658-impl' })
  views = await svc.stepResult({ botId: dispatched[0].botId, text: I2656_REPLY })
  const run = views.workflows.find(item => item.id === id).run
  assert.equal(run.status, 'running', 'the run does not die after its PR was opened')
  assert.equal(run.nodeStatus.triage, 'done', 'the delivered work stands')
  assert.equal(run.nodeStatus.claim, 'running', 'the first state branch starts')
  assert.equal(run.nodeStatus.escalate, 'skipped')
  assert.equal(run.producedPull, 2657, 'the run record keeps the pull request number')
})

test('#2658: a merged sha alone also keeps the run alive', async () => {
  const { svc, id, dispatched } = fastLineHarness()
  let views = await svc.runNamed({ workflow: 'Fast line', brief: 'i2658-merge' })
  views = await svc.stepResult({ botId: dispatched[0].botId, text: `已合入。\nOUTPUT merged: ${SHA}` })
  const run = views.workflows.find(item => item.id === id).run
  assert.equal(run.status, 'running')
  assert.equal(run.nodeStatus.triage, 'done')
  assert.equal(run.nodeStatus.claim, 'running')
})
