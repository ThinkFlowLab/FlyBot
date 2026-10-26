// The `repo-dev` preset and the fact providers (#1272 step 2). What this file pins:
//   - the preset is data: seven nodes, the roles the team really has, and the columns it draws;
//   - the four debts #1291 named each have a test of their own;
//   - the gate's refusal sentences are the merge gate's own sentences, byte for byte, through
//     `.github/scripts/fixtures/workflow-cases.json` — the file both sides read and neither imports;
//   - a fact nobody could read is `unreadable`, never a guess.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { artifact, artifactsBySpec } from '../src/shared/artifact.js'
import {
  canonicalSpec,
  consumersOf,
  dependencyEdges,
  enterNode,
  GUARD_CHECKS,
  holderOf,
  inputStates,
  layoutWorkflow,
  nodeById,
  producersOf,
  resolvedEdges,
  validateWorkflow,
  workflowColumns,
} from '../src/shared/workflow.js'
import { blankWorkflow } from '../src/shared/workflow-blank.js'
import { REPO_DEV_TEAM, repoDevWorkflow } from '../src/shared/workflow-repo-dev.js'
import { FACT_NAMES, FACT_PROVIDERS, githubCheckAtSha, githubLabels, githubPrBodyTip, githubVerdictAtTip, manualTick, taskProgress, workflowFact } from '../src/host/workflow-facts.js'

const cases = JSON.parse(readFileSync(fileURLToPath(new URL('../../.github/scripts/fixtures/workflow-cases.json', import.meta.url)), 'utf8'))

const factsFor = (entry) => ({
  present: artifactsBySpec(entry.present.map((item) => artifact(item.spec, item.revision, { value: item.value, by: item.by }))),
  current: entry.current,
})

test('the repo-dev preset is data, and it validates with the roles this team has', () => {
  const result = validateWorkflow(repoDevWorkflow, { team: REPO_DEV_TEAM })
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.deepEqual(repoDevWorkflow.nodes.map((node) => node.id), ['triage', 'build', 'verify', 'review', 'gate', 'merge', 'release'])
  assert.deepEqual(repoDevWorkflow.nodes.map((node) => node.role), ['Triage', 'Dev', 'SelfTest', 'Reviewer', 'Reviewer', 'system', 'Release'])
  // The two roles that are not one Bot on a roster say what they are, not who: the self-test Bot with
  // CI as the `check:tests-ok` fact it hands out, and the Reviewer that judged the verdict it reads.
  assert.equal(nodeById(repoDevWorkflow, 'verify').name, 'Verify — SelfTest and CI')
  assert.deepEqual(nodeById(repoDevWorkflow, 'verify').outputs, ['check:tests-ok'])
  assert.equal(holderOf(repoDevWorkflow, 'gate'), 'Reviewer')
  // The verdict is the fact the gate guards, not an input it waits for: its revision is what the head
  // guard compares against the live tip.
  assert.deepEqual(nodeById(repoDevWorkflow, 'gate').guards.map((guard) => guard.spec), ['pr', 'verdict', 'verdict', 'check:tests-ok'])
  assert.deepEqual(nodeById(repoDevWorkflow, 'gate').inputs, ['pr', 'check:tests-ok'])
  // The merge is the queue's, so no Bot is named for it.
  assert.equal(holderOf(repoDevWorkflow, 'merge'), 'system')
})

test('the columns are the definition s, and a node that says column: false draws none (#1265)', () => {
  const columns = workflowColumns(repoDevWorkflow)
  // `review` is the pull request's state, not a third lane: it stays in the definition, out of the board.
  assert.deepEqual(columns.map((column) => column.id), ['triage', 'build', 'verify', 'gate', 'merge', 'release'])
  assert.deepEqual(columns.map((column) => column.column), ['not-started', 'in-progress', 'in-progress', 'in-progress', 'done', 'done'])
  assert.deepEqual(columns.map((column) => column.role), ['Triage', 'Dev', 'SelfTest', 'Reviewer', 'system', 'Release'])
  // The node is still there — it just is not a column — so `enterNode` can still refuse it.
  assert.ok(nodeById(repoDevWorkflow, 'review'))
  assert.equal(nodeById(repoDevWorkflow, 'review').column, false)
  // The flowchart keeps every node: the board's columns and the picture are two questions.
  assert.equal(layoutWorkflow(repoDevWorkflow).boxes.length, repoDevWorkflow.nodes.length)
})

test('a definition that states no column keeps step 1 s answer, the node id', () => {
  const columns = workflowColumns(blankWorkflow)
  assert.deepEqual(columns.map((column) => column.id), ['draft', 'review', 'publish'])
  assert.deepEqual(columns.map((column) => column.column), ['draft', 'review', 'publish'])
})

test('a column the board does not have, and a guard check nobody implements, are each refused by name', () => {
  const base = {
    inputs: ['text:topic'],
    nodes: [
      { id: 'draft', name: 'Draft', role: 'Writer', inputs: ['text:topic'], outputs: ['text:draft'] },
      { id: 'publish', name: 'Publish', role: 'Publisher', inputs: ['text:draft'], outputs: ['link:published'] },
    ],
    deliverables: ['link:published'],
  }
  const wrongColumn = validateWorkflow({ ...base, nodes: [{ ...base.nodes[0], column: 'doing' }, base.nodes[1]] }, { team: ['Writer', 'Publisher'] })
  assert.deepEqual(wrongColumn.problems.map((problem) => problem.code), ['node/unknown-column'])
  assert.match(wrongColumn.problems[0].message, /names the column "doing", which is not one of not-started, in-progress, done/)

  // #1291 debt: `is: 'fres'` used to be read as `present`, which is a guard that can never refuse.
  const wrongCheck = validateWorkflow({ ...base, nodes: [{ ...base.nodes[0], guards: [{ id: 'pass', spec: 'verdict', is: 'fres', value: 'PASS' }] }, base.nodes[1]] }, { team: ['Writer', 'Publisher'] })
  assert.ok(wrongCheck.problems.some((problem) => problem.code === 'guard/unknown-check'))
  assert.match(wrongCheck.problems[0].message, /guard "pass" asks is: "fres", which is not one of present, fresh, equals/)
})

test('a guard whose check nobody implements refuses instead of passing on a guess (#1291 debt)', () => {
  const def = {
    inputs: ['pr'],
    nodes: [
      { id: 'build', name: 'Build', role: 'Dev', inputs: ['text:topic'], outputs: ['pr', 'verdict'] },
      { id: 'gate', name: 'Gate', role: 'Reviewer', inputs: ['verdict'], outputs: ['queue-entry'], guards: [{ id: 'pass', spec: 'verdict', is: 'fres', value: 'PASS' }] },
    ],
    deliverables: ['queue-entry'],
  }
  const present = { verdict: artifact('verdict', 'abc1234', { value: 'INC' }) }
  const refused = enterNode(def, 'gate', { present, current: { verdict: 'abc1234' } })
  // Before the fix this guard was dropped and the node started on an INC.
  assert.equal(refused.ok, false)
  assert.match(refused.refusal, /its check on verdict asks "fres", which is not one of present, fresh, equals/)
  assert.deepEqual(GUARD_CHECKS, ['present', 'fresh', 'equals'])
})

test('a fact is keyed by its parsed spec, so "text: draft" and "text:draft" are one fact (#1291 debt)', () => {
  const def = {
    inputs: ['text:topic'],
    nodes: [
      { id: 'draft', name: 'Draft', role: 'Writer', inputs: ['text:topic'], outputs: ['text: draft'] },
      { id: 'edit', name: 'Edit', role: 'Editor', inputs: ['text:draft'], outputs: ['link:published'] },
    ],
    deliverables: ['link:published'],
  }
  assert.equal(canonicalSpec('text: draft'), 'text:draft')
  assert.deepEqual(Object.keys(producersOf(def)), ['text:draft', 'link:published'])
  assert.deepEqual(Object.keys(consumersOf(def)), ['text:topic', 'text:draft'])
  // The one producer is found through the canonical key, so the workflow is valid and the dependency
  // exists: with the raw spelling it read "no producer" and "no consumer", and lost the edge.
  assert.equal(validateWorkflow(def, { team: ['Writer', 'Editor'] }).ok, true, JSON.stringify(validateWorkflow(def, { team: ['Writer', 'Editor'] }).problems))
  assert.deepEqual(dependencyEdges(def), [{ from: 'draft', to: 'edit' }])
})

test('one word for one thing: a node names a role, and the older spelling is not read (#1291 debt)', () => {
  const def = {
    inputs: ['text:topic'],
    nodes: [
      { id: 'draft', name: 'Draft', bot: 'Writer', inputs: ['text:topic'], outputs: ['link:published'] },
    ],
    deliverables: ['link:published'],
  }
  const result = validateWorkflow(def, { team: ['Writer'] })
  assert.equal(result.ok, false)
  assert.deepEqual(result.problems.map((problem) => problem.code), ['node/without-role'])
  assert.equal(holderOf(def, 'draft'), null)
  // The two spellings cannot both be written and disagree, because only one of them is read at all.
  assert.equal(validateWorkflow({ ...def, nodes: [{ ...def.nodes[0], role: 'Writer' }] }, { team: ['Writer'] }).ok, true)
})

test('an edge carries its artifact once, and says so (#1291 debt)', () => {
  const edge = resolvedEdges(repoDevWorkflow)[0]
  assert.deepEqual(Object.keys(edge).sort(), ['artifact', 'from', 'fromNode', 'to', 'toNode'].sort())
  assert.equal(edge.artifact, 'issue.ready')
  assert.equal('carries' in edge, false)
})

test('the gate s refusal is the merge gate s own sentence, byte for byte (acceptance 9)', () => {
  assert.ok(cases.cases.length >= 3)
  for (const entry of cases.cases) {
    const { present, current } = factsFor(entry.preset)
    const refused = enterNode(repoDevWorkflow, entry.preset.node, { present, current })
    assert.equal(refused.ok, false, `${entry.id} must refuse`)
    assert.equal(refused.refusal, entry.sentence, `${entry.id}: the preset and ${entry.where} must say the same thing`)
    // And the guard that answered is the one the fixture names, so a sentence cannot pass by accident
    // on some other guard that happens to read the same way.
    assert.equal(refused.guardRefusals[0].guard.id, entry.preset.guard, `${entry.id} must be refused by ${entry.preset.guard}`)
  }
})

test('the gate starts only when every fact it reads is present, current and says the right thing', () => {
  const entry = cases.cases.find((item) => item.id === 'verdict-not-pass')
  const { present, current } = factsFor(entry.preset)
  const pass = { ...current, verdict: 'abaf938b0c1d' }
  const presentPass = { ...present, verdict: artifact('verdict', 'abaf938b0c1d', { value: 'PASS', by: 'Reviewer' }) }
  assert.equal(enterNode(repoDevWorkflow, 'gate', { present: presentPass, current: pass }).ok, true)
  // A fact nobody could read refuses rather than passing (acceptance 10): the same node, same facts,
  // and the verdict's revision is not readable.
  const unread = enterNode(repoDevWorkflow, 'gate', { present: presentPass, current: { ...pass, verdict: null } })
  assert.equal(unread.ok, false)
  assert.match(unread.refusal, /could not be checked against the source/)
  // A guarded fact nobody could read is refused by the guard, and the card says the same thing: the
  // input that is present reads unreadable instead of fine.
  const unreadStates = inputStates(repoDevWorkflow, 'gate', { present: presentPass, current: { ...pass, 'check:tests-ok': null } })
  assert.equal(unreadStates.find((state) => state.spec === 'check:tests-ok').unreadable, true)
  assert.equal(enterNode(repoDevWorkflow, 'gate', { present: presentPass, current: { ...pass, 'check:tests-ok': null } }).ok, false)
})

test('a fact nobody could read is unreadable, and no fact is guessed (acceptance 10)', () => {
  assert.deepEqual([...FACT_NAMES].sort(), [...Object.keys(FACT_PROVIDERS)].sort())
  // Every provider answers `unreadable` when it has nothing to answer from: no token, no field.
  const nothing = [
    githubLabels({ head: 'abc1234', labels: [] }),
    githubCheckAtSha({ name: 'tests-ok', sha: 'abc1234' }),
    githubVerdictAtTip({ tip: 'abc1234', verdict: 'PASS' }),
    githubPrBodyTip({ body: 'Tip SHA: abc1234' }),
    workflowFact('github.nobody'),
  ]
  for (const answer of [githubLabels({}), githubCheckAtSha({}), githubVerdictAtTip({}), githubMergeableNothing(), githubPrBodyTip({}), taskProgress({}), manualTick({}), ...nothing]) {
    assert.equal(answer.ok, false, `${answer.fact} must not answer without a reading`)
    assert.equal(answer.reason, 'unreadable')
    assert.equal(answer.input, null)
    assert.ok(answer.why, `${answer.fact} must say why it could not read`)
  }
  // With the token and the answer, each one is an artifact at the revision it was read at.
  const labels = githubLabels({ token: 'x', head: 'abaf938b0c1d', labels: [{ name: 'hold' }] })
  assert.equal(labels.ok, true)
  assert.equal(labels.input.spec, 'pr')
  assert.equal(labels.input.value, 'hold')
  assert.equal(githubLabels({ token: 'x', head: 'abaf938b0c1d', labels: [] }).input.value, 'none')
  const check = githubCheckAtSha({ token: 'x', name: 'tests-ok', sha: 'abaf938b0c1d', conclusion: 'success' })
  assert.equal(check.input.spec, 'check:tests-ok')
  assert.equal(check.input.revision, 'abaf938b0c1d')
  const verdict = githubVerdictAtTip({ token: 'x', tip: 'abaf938b0c1d', verdict: 'INC', by: 'Reviewer' })
  assert.equal(verdict.input.spec, 'verdict')
  assert.equal(verdict.input.value, 'INC')
  assert.equal(verdict.input.by, 'Reviewer')
  const body = githubPrBodyTip({ token: 'x', body: 'Written-by: Dev3\nTip SHA: abaf938b0c1d\n' })
  assert.equal(body.input.revision, 'abaf938b0c1d')
  // A body with no Tip SHA line is unreadable, not an empty tip.
  assert.equal(githubPrBodyTip({ token: 'x', body: 'no tip here' }).reason, 'unreadable')
  const progress = taskProgress({ card: { progress: 85 } })
  assert.equal(progress.input.revision, '85')
  assert.equal(taskProgress({ card: { progress: 140 } }).reason, 'unreadable')
  assert.equal(manualTick({ at: '2026-10-26T12:00:00Z' }).input.spec, 'text:tick')
})

// `githubMergeable` with nothing to read: kept out of the list above so each call reads as itself.
function githubMergeableNothing() {
  return workflowFact('github.mergeable', {})
}
