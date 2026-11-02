import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTaskContract, admitTask, reviseTask, addTaskDependencies, dependencyResult, readyTaskWait, reopenTask } from '../src/host/project-task-lifecycle.js'

const task = (id = 'parent') => ({ id, projectId: 'p', status: 'open', title: 'Fix a regression', criteria: 'The regression test passes', projectTaskKind: 'code' })
const proof = id => ({ id, projectId: 'p', taskId: id === 'admit' ? 'parent' : id, executorRole: 'chief', runId: 'chief-run', initiatedBy: 'owner', reason: 'Requirements and evidence checked' })

test('Project Task requires Chief admission and versions requirements without changing stable identity', () => {
  const row = task()
  createTaskContract(row, { impact: 'Restore Project build reliability', scope: 'Parser error handling' })
  assert.equal(row.projectTask.admission.status, 'proposed')
  assert.throws(() => admitTask(row, { ...proof('admit'), executorRole: 'developer' }), /Chief/)
  admitTask(row, proof('admit'))
  assert.equal(row.projectTask.admission.status, 'accepted')
  assert.equal(row.projectTask.requirements.revision, 1)
  assert.throws(() => reviseTask(row, { criteria: 'No test needed' }, { ...proof('admit'), executorRole: 'developer' }), /Chief/)
  reviseTask(row, { criteria: 'Original regression and negative-input tests pass' }, { ...proof('admit'), id: 'revision-2' })
  assert.equal(row.id, 'parent')
  assert.equal(row.projectTask.requirements.revision, 2)
  assert.equal(row.projectTask.requirementsHistory[0].criteria, 'The regression test passes')
  assert.equal(row.criteria, 'Original regression and negative-input tests pass')
})

test('dependency waits keep failures unsatisfied, reject cycles and become ready only once with Chief results', () => {
  const parent = task(), a = task('a'), b = task('b')
  for (const row of [parent, a, b]) createTaskContract(row, { impact: row.title })
  const state = { tasks: { parent, a, b } }
  addTaskDependencies(state, parent, ['a', 'b'], { id: 'wait-1', botId: 'p:developer', resumePoint: 'Integrate child results', claimId: 'claim-1' })
  assert.throws(() => addTaskDependencies(state, a, ['parent'], { id: 'cycle', botId: 'p:developer', resumePoint: 'Resume', claimId: 'c2' }), /cycle/)
  assert.throws(() => addTaskDependencies(state, b, ['b'], { id: 'self', botId: 'p:developer', resumePoint: 'Resume', claimId: 'c3' }), /cycle/)
  state.tasks.foreign = { ...task('foreign'), projectId: 'elsewhere' }
  assert.throws(() => addTaskDependencies(state, a, ['foreign'], { id: 'foreign', botId: 'p:developer', resumePoint: 'Resume', claimId: 'c4' }), /Project/)
  a.status = 'cancelled'
  dependencyResult(state, a)
  assert.equal(readyTaskWait(state, parent), null)
  a.status = 'accepted'; a.completedBy = { kind: 'chief', decisionId: 'close-a' }; a.result = { summary: 'Child result', candidateSha: 'a'.repeat(40) }
  dependencyResult(state, a)
  b.status = 'failed'; dependencyResult(state, b)
  assert.equal(readyTaskWait(state, parent), null)
  b.status = 'accepted'; b.completedBy = { kind: 'chief', decisionId: 'close-b' }
  dependencyResult(state, b)
  const ready = readyTaskWait(state, parent)
  assert.equal(ready.botId, 'p:developer')
  assert.equal(ready.results[0].decisionId, 'close-a')
  assert.equal(parent.status, 'open')
  assert.equal(readyTaskWait(state, parent).id, ready.id)
  parent.projectTask.wait.status = 'queued'
  assert.equal(readyTaskWait(state, parent), null)
})

test('reopening retains the final record and invalidates a parent dependency without accepting new scope', () => {
  const parent = task(), child = task('child'), state = { tasks: { parent, child } }
  for (const row of [parent, child]) createTaskContract(row, { impact: row.title })
  addTaskDependencies(state, parent, ['child'], { id: 'w', botId: 'p:developer', resumePoint: 'Integration', claimId: 'c' })
  child.status = 'accepted'; child.result = { summary: 'Previous result' }; child.completedBy = { kind: 'chief', decisionId: 'closed' }
  dependencyResult(state, child)
  reopenTask(child, { ...proof('child'), id: 'reopen', reason: 'Original acceptance criterion was not met' })
  dependencyResult(state, child)
  assert.equal(child.projectTask.results[0].result.summary, 'Previous result')
  assert.equal(child.status, 'open')
  assert.equal(readyTaskWait(state, parent), null)
  assert.equal(child.projectTask.requirements.revision, 1)
})

async function serviceFixture() {
  const { createProjectEffects } = await import('../src/host/project-effects.js')
  const { createProjectInputs } = await import('../src/host/project-inputs.js')
  const { install } = await import('../src/host/project-task-lifecycle.js')
  const parent = task(); parent.requesterId = 'owner'
  createTaskContract(parent, { impact: 'Restore the Project build' }); admitTask(parent, proof('admit'))
  let failSave = false
  const rt = { state: { tasks: { parent }, projectChiefPolicies: {} }, config: {}, readOnly: () => undefined,
    projects: { requireActive(id) { assert.equal(id, 'p') } },
    requireProjectAccess(actor, projectId) { if (actor.memberId !== 'owner' || projectId !== 'p') throw new Error('Denied') },
    projectDelegations: { background: async () => true },
    projectChiefControl: { validateActor: async actor => { if (actor.chiefJobId !== 'live-chief') throw new Error('Chief authority missing') },
      request: async (projectId, purpose, source, taskId) => {
        const row = { id: source.requestId, projectId, purpose, source: structuredClone(source), taskId }
        ;(rt.state.projectExecutions ??= {})[row.id] = row
        return row
      } },
  }
  rt.projectEffects = createProjectEffects(rt)
  rt.projectEffects.register('input.notify', { run: async row => row.payload })
  rt.projectInputs = createProjectInputs(rt)
  install(rt)
  rt.save = async () => { if (failSave) throw new Error('Disk unavailable'); rt.projectEffects.saved(rt.projectEffects.capture()) }
  const actor = { memberId: 'owner', chiefJobId: 'live-chief' }
  return { rt, parent, actor, failSave: value => { failSave = value } }
}

test('Chief requirement revision commits its inbox notification and failed persistence restores both facts and input', async () => {
  const f = await serviceFixture()
  const audit = { ...proof('admit'), id: 'revise', action: 'revise' }
  await f.rt.projectTaskLifecycle.adjudicate(f.parent, { requirements: { criteria: 'Negative and normal cases pass' }, expectedRequirementsRevision: 1 }, audit, f.actor)
  assert.equal(f.parent.projectTask.requirements.revision, 2)
  const inputs = Object.values(f.rt.state.projectTaskInputs)
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].kind, 'requirements-change')
  assert.equal(inputs[0].source.kind, 'chief-decision')
  assert.match(inputs[0].text, /Negative and normal/)
  f.failSave(true)
  await assert.rejects(f.rt.projectTaskLifecycle.adjudicate(f.parent, { requirements: { criteria: 'New invalidated revision' }, expectedRequirementsRevision: 2 }, { ...audit, id: 'failed-revision' }, f.actor), /Disk unavailable/)
  assert.equal(f.parent.projectTask.requirements.revision, 2)
  assert.equal(Object.keys(f.rt.state.projectTaskInputs).length, 1)
  await assert.rejects(f.rt.projectTaskLifecycle.adjudicate(f.parent, { requirements: { criteria: 'Stale revision' }, expectedRequirementsRevision: 1 }, audit, f.actor), /changed/)
  await assert.rejects(f.rt.projectTaskLifecycle.adjudicate(f.parent, {}, audit, { memberId: 'owner' }), /Chief authority/)
  await f.rt.projectEffects.close()
})

test('Task change requests are idempotent suggestions and cancellation/reopen require an actual Chief capability', async () => {
  const f = await serviceFixture()
  const body = { taskId: 'parent', requestId: 'request', action: 'cancel', reason: 'No longer needed' }
  const first = await f.rt.projectTaskLifecycle.requestChange(body, { memberId: 'owner' })
  assert.equal(first.applied, false)
  assert.equal(f.parent.status, 'open')
  assert.equal((await f.rt.projectTaskLifecycle.requestChange(body, { memberId: 'owner' })).run.id, first.run.id)
  await assert.rejects(f.rt.projectTaskLifecycle.requestChange({ ...body, reason: 'Changed intent' }, { memberId: 'owner' }), /reused/)
  await assert.rejects(f.rt.projectTaskLifecycle.requestChange(body, { memberId: 'foreign' }), /Denied/)
  await assert.rejects(f.rt.projectTaskLifecycle.requestChange({ ...body, action: 'close' }, { memberId: 'owner' }), /supported/)
  await assert.rejects(f.rt.projectTaskLifecycle.requestChange({ ...body, requirements: { criteria: 'New' } }, { memberId: 'owner' }), /Only revision/)
  const revision = await f.rt.projectTaskLifecycle.requestChange({ ...body, requestId: 'revision', action: 'revise', requirements: { criteria: 'New explicit criterion' } }, { memberId: 'owner' })
  assert.equal(revision.applied, false)
  await f.rt.projectTaskLifecycle.adjudicate(f.parent, {}, { ...proof('admit'), id: 'cancel', action: 'cancel' }, f.actor)
  assert.equal(f.parent.status, 'cancelled')
  await f.rt.projectTaskLifecycle.adjudicate(f.parent, {}, { ...proof('admit'), id: 'reopen', action: 'reopen' }, f.actor)
  assert.equal(f.parent.status, 'open')
  assert.equal(f.parent.projectTask.results.length, 2)
  assert.equal(f.parent.projectTask.requirements.revision, 1)
  await f.rt.projectEffects.close()
})
