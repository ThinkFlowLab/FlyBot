// Actual DSH/host/pool continuation; model transport is deliberately deterministic.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const marker = 'NATIVE_PRIOR_CONVERSATION_2184'
export function nativePoolModel() {
  const observed = { developerTurns: 0, testerTurns: 0, resumedContext: false }
  function reply({ body, result, tools }) {
    const system = JSON.stringify(body.system ?? '')
    const developer = system.includes('Implement the task in your assigned worktree')
    const tester = system.includes('Inspect the implementation in your assigned worktree')
    if (!developer && !tester) return undefined
    if (developer && observed.developerTurns === 1 && !result) {
      assert.ok(JSON.stringify(body.messages).includes(marker), 'The actual second native request must contain its prior conversation')
      assert.ok(!system.includes(marker), 'The marker must not be reconstructed from the current system/context snapshot')
      assert.ok(!JSON.stringify(body.messages.at(-1)).includes(marker), 'The marker must not be supplied as new input')
      observed.resumedContext = true
    }
    if (tools && !result) {
      const source = 'export const add = (a,b) => a+b;\n' + (observed.developerTurns ? '// native continuation verified\n' : '')
      const command = developer
        ? `node --input-type=module -e 'import {writeFileSync} from "node:fs"; writeFileSync("code.mjs",${JSON.stringify(source)}); console.log("implemented")'`
        : 'node --test code.test.mjs'
      return [{ type: 'tool_use', id: `native-${developer ? 'dev' : 'test'}-${developer ? observed.developerTurns : observed.testerTurns}`, name: 'bash', input: { description: 'Execute the assigned native pool work', command } }]
    }
    if (developer) {
      ++observed.developerTurns
      return [{ type: 'text', text: (observed.developerTurns === 1 ? `Private conversation marker: ${marker}\n` : '') + 'OUTPUT handoff: ' + JSON.stringify({ action: 'handoff', to: observed.projectId + ':tester', reason: 'Inspect the actual sealed implementation', outputs: { implementation: 'Correct addition and preserve the requested continuation checkpoint' } }) }]
    }
    ++observed.testerTurns
    return [{ type: 'text', text: 'OUTPUT handoff: ' + JSON.stringify(observed.testerTurns === 1
      ? { action: 'return', to: observed.projectId + ':developer', reason: 'Add an explicit continuation checkpoint comment before final host verification', outputs: {} }
      : { action: 'handoff', to: observed.projectId + ':chief', reason: 'Actual host verification is ready for Chief judgement; no Review or project closure is claimed', outputs: { tests: 'Request the configured independent host tests' } }) }]
  }
  return { observed, reply }
}
export async function checkNativePools({ api, saved, waitFor, repository, model, storage = 'json' }) {
  const invitation = await api('auth-invite')
  const human = await api('auth-redeem', { token: invitation.token, displayName: 'Native pool owner' })
  const call = (endpoint, body = {}) => api(endpoint, body, human.sessionToken)
  const state = await call('state')
  const route = state.models.find(row => /deepseek-flash/.test(row.ref))?.ref ?? state.models.at(-1)?.ref
  const { project } = await call('project-create', { name: 'Native pool continuation acceptance', repository: 'example/delivery-fixture' })
  model.observed.projectId = project.id
  assert.equal((await call('project-resource-environment-check', { projectId: project.id, resourceId: 'native-local' })).status, 'ready')
  for (const role of ['chief', 'developer', 'tester', 'reviewer']) await call('project-agent-definition', { projectId: project.id, role, model: route, ...(role === 'chief' ? {} : { execution: { harness: 'flybot', resourceIds: ['native-local'] } }) })
  const botId = saved().projects[project.id].chief.botId
  const task = await call('task-create', { botId, projectId: project.id, title: 'Fix addition with explicit native continuation', impact: 'Repair Project addition behavior while preserving original role context', criteria: 'Addition passes actual configured tests and native role context survives a return' })
  const requested = await call('project-task-run', { taskId: task.id, requestId: 'native-pool-continuation' })
  assert.equal(requested.waitingFor, 'chief')
  assert.equal(Object.values(saved().projectAttempts).filter(row => row.taskId === task.id).length, 0)
  await call('project-chief-configure', { projectId: project.id, enabled: true, inspection: { enabled: false } })
  const started = await waitFor(() => {
    const attempt = Object.values(saved().projectAttempts).find(row => row.taskId === task.id)
    if (!attempt || attempt.status === 'preparing') return null
    if (attempt.status === 'failed') throw new Error('Native pool Attempt failed before initialization; inspect scoped execution evidence')
    return attempt
  }, 'actual Chief admission before native pool allocation')
  assert.equal(started.protocol, 'project-handoff/v1')
  assert.equal(started.status, 'running')
  await waitFor(() => {
    const current = saved().tasks[task.id]?.collaboration
    if (current?.status === 'blocked') throw new Error('Native pool blocked: ' + current.block?.reason)
    return current?.botId === project.id + ':chief' && ['arbitration', 'chief-working'].includes(current.status)
  }, 'native Developer → Tester → original Developer → Tester → Chief pool', 90_000)
  const snapshot = saved(), attempts = Object.values(snapshot.projectAttempts).filter(row => row.taskId === task.id)
  const developer = Object.values(snapshot.projectTaskSessions).find(row => row.taskId === task.id && row.role === 'developer')
  assert.equal(attempts.length, 2)
  assert.equal(developer.bindings.length, 2)
  const [first, second] = developer.bindings.map(binding => snapshot.projectNativeWorkers[binding.workerId])
  assert.notEqual(first.id, second.id, 'Execution carriers are temporary')
  assert.equal(first.sessionId, second.sessionId, 'The original physical native context must resume')
  assert.equal(first.cwd, second.cwd, 'Resume keeps the original execution cwd')
  assert.ok(model.observed.resumedContext)
  assert.equal(model.observed.developerTurns, 2); assert.equal(model.observed.testerTurns, 2)
  assert.ok(Object.values(snapshot.projectNativeWorkers).every(row => row.status === 'quiescent' && row.releaseProof?.kind === 'native-agent-quiescent'))
  for (const row of Object.values(snapshot.projectNativeWorkers)) {
    const activation = snapshot.projectEffects[row.activationEffect.id]
    assert.equal(activation.kind, 'native.activate')
    assert.equal(activation.payload.workerId, row.id)
    assert.equal(activation.payload.sessionId, row.sessionId)
  }
  const leases = Object.values(snapshot.projectResourceLeases).filter(row => row.projectId === project.id).sort((a, b) => a.createdAt - b.createdAt)
  assert.equal(leases.length, 4)
  assert.ok(leases.every(row => row.status === 'released' && row.releaseProof?.kind === 'native-agent-quiescent'))
  for (let index = 1; index < leases.length; ++index) assert.ok(leases[index - 1].releasedAt <= leases[index].createdAt, 'One actual resource must never authorize overlapping execution')
  const current = snapshot.projectAttempts[snapshot.tasks[task.id].deliveryAttemptId]
  assert.equal(current.evidence.tests.passed, true)
  assert.equal(current.evidence.tests.sha, current.candidateSha)
  const previous = attempts.find(row => row.id === current.feedback.previousAttemptId)
  assert.ok(previous, 'The successor points to its actual prior Attempt independently of map ordering')
  assert.notEqual(previous.candidateSha, current.candidateSha)
  assert.notEqual(snapshot.tasks[task.id].status, 'accepted', 'Chief has not adjudicated completion')
  assert.match(readFileSync(join(repository, 'code.mjs'), 'utf8'), /a-b/, 'The base repository stays intact')
  await call('project-attempt-stop', { attemptId: current.id })
  for (const attempt of attempts) await call('project-attempt-cleanup', { attemptId: attempt.id })
  return { milestone: '2184-native-pools', runtime: 'actual DSH', storage, model: 'deterministic mock',
    checks: ['actual Chief admission before native pool allocation', 'native per-Bot pool return/handoff', 'same Task and original physical role Session', 'fresh carrier identities and same cwd', 'prior conversation present only in retained context', 'actual two code revisions and configured host tests', 'native quiescence and single-resource release before downstream execution', 'Chief arbitration inbox without fake closure', 'disposable cleanup'],
    notRun: ['real model', 'Reviewer and forge publication in this continuation probe', 'Chief acceptance', 'native crash recovery'] }
}
