import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialRoleTarget } from '../src/host/project-role-admission.js'

test('initial targets pin capability, catalog and requirements without silently changing roles', () => {
  const task = { projectId: 'p', projectTask: { requirements: { revision: 3 } } }
  const roles = [{ id: 'p:builder', role: 'builder', policyRole: 'developer' }, { id: 'p:chief', role: 'chief' }]
  const catalog = { revision: 4, roles }
  const rt = { config: {}, projectAgents: { deliveryDefinitions: () => catalog } }
  const pinned = initialRoleTarget(rt, task)
  assert.deepEqual(pinned, { role: 'builder', botId: 'p:builder', policyRole: 'developer', definitionRevision: 4, requirementsRevision: 3 })
  assert.deepEqual(initialRoleTarget(rt, task, { initialTarget: pinned }), pinned)
  for (const targetRole of ['chief', 'retired', '', 12, '__proto__']) assert.throws(() => initialRoleTarget(rt, task, { targetRole }))
  assert.throws(() => initialRoleTarget(rt, task, { initialTarget: { ...pinned, botId: 'other:builder' } }), /selection changed/)
  task.projectTask.requirements.revision++
  assert.throws(() => initialRoleTarget(rt, task, { initialTarget: pinned }), /requirements changed/)
  task.projectTask.requirements.revision--
  catalog.revision++
  assert.throws(() => initialRoleTarget(rt, task, { initialTarget: pinned }), /catalog/)
  catalog.revision--
  roles.push({ id: 'p:developer', role: 'developer' })
  assert.equal(initialRoleTarget(rt, task).role, 'developer')
  assert.equal(initialRoleTarget(rt, task, { targetRole: 'builder' }).role, 'builder')
  rt.config.projectDispatch = 'workflow'
  assert.equal(initialRoleTarget(rt, task), undefined)
})
