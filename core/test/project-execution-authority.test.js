import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pinTaskRoleDefinition } from '../src/host/project-task-sessions.js'
import { requireExecutionAuthority, reconcileExecutionAuthority } from '../src/host/project-execution-authority.js'
function fixture() {
  const definition = { id: 'p:developer', role: 'developer', policyRole: 'developer', instructions: 'Retain original persona', toolPolicy: { shell: true }, execution: { harness: 'codex', resourceIds: ['local'] } }
  const claim = { id: 'claim', status: 'active', role: 'developer', botId: definition.id, generation: 1, workerId: 'worker' }
  const session = { id: 'role-session', projectId: 'p', taskId: 't', attemptId: 'a', role: 'developer', generation: 1, poolClaimId: claim.id, botId: claim.workerId, resourceLease: { id: 'lease', resourceId: 'local' }, status: 'running' }
  const task = { id: 't', projectId: 'p', status: 'open', deliveryAttemptId: 'a', collaboration: { initiatedBy: 'human', generation: 1, claim } }
  const catalog = { revision: 1, roles: [definition] }
  const rt = { state: { tasks: { t: task }, projectAttempts: { a: { roleSessions: { developer: session } } } }, readOnly: () => undefined, projects: { requireActive() {} }, requireProjectAccess() {}, projectDelegations: { async background() {} }, projectAgents: { deliveryDefinitions: () => catalog }, projectResources: { requireBinding() {} } }
  Object.assign(session, pinTaskRoleDefinition(rt.state, session, definition, 1, catalog))
  return { rt, definition, claim, session, task, catalog }
}
test('ongoing execution retains persona but refuses live role capability and resource revocation', async () => {
  const f = fixture()
  f.definition.instructions = 'New persona'; f.definition.model = 'new-model'; f.catalog.revision++
  await requireExecutionAuthority(f.rt, f.session)
  assert.equal(f.session.definition.instructions, 'Retain original persona')
  f.definition.toolPolicy.shell = false
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /revoked/)
  f.definition.toolPolicy.shell = true; f.definition.execution.resourceIds = []
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /revoked/)
})
test('retired role may finish its retained active claim but cannot borrow another role identity', async () => {
  const f = fixture(); f.catalog.roles = []
  f.rt.state.projectRetiredRoles = { 'p:developer': structuredClone(f.definition) }
  await requireExecutionAuthority(f.rt, f.session)
  f.rt.state.projectRetiredRoles['p:developer'].id = 'p:foreign'
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /retired/)
})
test('live authority rechecks membership and claim after asynchronous delegation', async () => {
  const f = fixture()
  f.rt.projectDelegations.background = async () => { f.claim.status = 'revoked' }
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /revoked during/)
  f.claim.status = 'active'; f.rt.projectDelegations.background = async () => {}
  f.rt.requireProjectAccess = () => { throw Error('Member was removed') }
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /Member was removed/)
})
test('current implicit native host cannot survive a newly explicit role resource restriction', async () => {
  const f = fixture(); delete f.session.resourceLease
  f.definition.execution = { harness: 'flybot', resourceIds: [] }
  delete f.session.definitionRef
  f.rt.state.projectTaskSessions = {}; f.rt.state.projectRoleDefinitionSnapshots = {}
  Object.assign(f.session, pinTaskRoleDefinition(f.rt.state, f.session, f.definition, 1, f.catalog))
  await requireExecutionAuthority(f.rt, f.session)
  f.definition.execution.resourceIds = ['local']
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /Implicit host/)
})
test('scheduler reconciliation stops only the exact current claim, preserving released sessions and other tasks', async () => {
  const f = fixture(), stopped = []
  f.rt.projectPools = { async revokeExecution(...args) { stopped.push(args); f.claim.status = 'revoked' } }
  await reconcileExecutionAuthority(f.rt); assert.equal(stopped.length, 0)
  f.definition.execution.resourceIds = []
  await reconcileExecutionAuthority(f.rt)
  assert.equal(stopped.length, 1); assert.deepEqual(stopped[0].slice(0, 2), ['t', 'claim'])
  await reconcileExecutionAuthority(f.rt); assert.equal(stopped.length, 1)
  f.claim.status = 'active'; f.session.status = 'released'
  await reconcileExecutionAuthority(f.rt); assert.equal(stopped.length, 1)
})

test('missing initiator and Task identity replacement fail closed during authority checks', async () => {
  const f = fixture(); delete f.task.collaboration.initiatedBy
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /initiating human/)
  f.task.collaboration.initiatedBy = 'human'
  f.rt.projectDelegations.background = async () => { f.rt.state.tasks.t = structuredClone(f.task) }
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /Task scope changed/)
})

test('operator disabled resources and removed Harness capability stop retained execution', async () => {
  const f = fixture(), resource = { harnesses: ['codex'], type: 'local' }
  f.rt.projectResources.requireBinding = () => resource
  await requireExecutionAuthority(f.rt, f.session)
  resource.disabled = true
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /resource.*revoked/)
  resource.disabled = false; resource.harnesses = ['flybot']
  await assert.rejects(requireExecutionAuthority(f.rt, f.session), /resource.*revoked/)
})
