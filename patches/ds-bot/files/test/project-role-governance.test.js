import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectEffects } from '../src/host/project-effects.js'
import { createProjectRoleGovernance } from '../src/host/project-role-governance.js'
const owner = { memberId: 'owner' }, maintainer = { memberId: 'maintainer' }, member = { memberId: 'member' }
function fixture() {
  let failure = false, activeChief = true, hold, disk
  const authority = { projectId: 'p', sourceId: 'chief-turn', memberId: 'member' }
  const rt = { state: { members: { owner: {}, maintainer: {}, member: {} }, projectAgentDefinitions: { p: { projectId: 'p', revision: 1, roles: ['chief', 'developer', 'tester', 'reviewer'].map(role => ({ id: `p:${role}`, role, name: role, policyRole: role, instructions: 'Original convention', memoryRefs: [], execution: { harness: 'flybot', resourceIds: [] } })) } }, tasks: { old: { id: 'old', projectId: 'p', collaboration: { botId: 'p:tester' } } } },
    readOnly: () => undefined, projects: { requireActive(id) { if (id !== 'p') throw Error('Project inactive') } },
    requireProjectAccess(actor, id, action = 'read') { if (id !== 'p' || !['owner', 'maintainer', 'member'].includes(actor?.memberId) || action === 'configure' && !['owner', 'maintainer'].includes(actor.memberId)) throw Object.assign(Error('Role access denied'), { code: 'bot/forbidden' }) },
    validateHumanActor: async actor => !actor.revoked,
    async save() { if (hold) await hold; if (failure) throw Error('fixture role save failed'); const capture = rt.projectEffects.capture(); disk = structuredClone(rt.state); rt.projectEffects.saved(capture) },
  }
  rt.projectEffects = createProjectEffects(rt)
  const service = createProjectRoleGovernance(rt, { definitionSet: () => rt.state.projectAgentDefinitions.p, baseDefinition: (p, role) => rt.state.projectAgentDefinitions.p.roles.find(row => row.role === role),
    prepareDefinition: async (role, body) => ({ ...structuredClone(role), ...structuredClone(body) }),
    requireChief(value) { if (value !== authority || !activeChief) throw Error('No current resident Chief authority') },
  })
  const offer = (action = 'add', role = 'specialist', extra = {}) => service.propose({ requestId: `${action}-${role}`, action, role, reason: 'Project needs this collaboration capability', fields: action === 'remove' ? {} : { name: 'Specialist', instructions: 'Follow the original repository conventions', policyRole: 'developer' }, ...extra }, authority)
  const approve = (proposal, actor = owner, extra = {}) => service.decide({ projectId: 'p', proposalId: proposal.id, expectedSha256: proposal.sha256, requestId: 'approve-' + proposal.requestId, decision: 'approve', ...extra }, actor)
  return { rt, service, authority, offer, approve, set: () => rt.state.projectAgentDefinitions.p, disk: () => disk, fail(value) { failure = value }, hold(value) { hold = value }, revokeChief() { activeChief = false } }
}

test('Chief can propose but only current Maintainer/Owner can apply an exact role revision', async () => {
  const f = fixture(), offered = await f.offer()
  assert.equal(f.set().roles.length, 4); assert.equal(offered.proposal.status, 'proposed')
  await assert.rejects(f.approve(offered.proposal, member), /access denied/)
  await assert.rejects(f.approve(offered.proposal, owner, { expectedSha256: 'stale' }), /hash/)
  const approved = await f.approve(offered.proposal, maintainer)
  assert.equal(approved.proposal.status, 'approved')
  assert.equal(f.set().revision, 2); assert.equal(f.set().roles.at(-1).role, 'specialist')
  assert.equal((await f.approve(offered.proposal, maintainer)).already, true)
  assert.equal(f.set().revision, 2)
  assert.equal(f.disk().projectRoleChanges[Object.keys(f.disk().projectRoleChanges)[0]].next.role, 'specialist')
  await f.rt.projectEffects.close()
})

test('forged/revoked Chief scopes, changed proposal bodies and Chief self-approval are rejected', async () => {
  const f = fixture()
  await assert.rejects(f.service.propose({ requestId: 'fake', action: 'add', role: 'fake', reason: 'Forgery' }, { ...f.authority }), /Chief authority/)
  const offered = await f.offer()
  await assert.rejects(f.approve(offered.proposal, { ...owner, chiefJobId: 'chief-turn' }), /Chief cannot approve/)
  const stored = f.rt.state.projectRoleProposals[offered.proposal.id]
  stored.definition.instructions = 'Tampered after the Owner inspected it'
  await assert.rejects(f.approve(offered.proposal), /content changed/)
  f.revokeChief(); await assert.rejects(f.offer('add', 'another'), /Chief authority/)
  await f.rt.projectEffects.close()
})

test('retirement retains the definition and audit without moving Tasks, Sessions or active ownership', async () => {
  const f = fixture(), original = structuredClone(f.rt.state.tasks.old), removed = await f.offer('remove', 'tester')
  await f.approve(removed.proposal)
  assert.equal(f.set().roles.some(row => row.role === 'tester'), false)
  assert.equal(f.rt.state.projectRetiredRoles['p:tester'].instructions, 'Original convention')
  assert.deepEqual(f.rt.state.tasks.old, original)
  assert.equal(f.service.catalog({ projectId: 'p', role: 'tester' }, owner).text.includes('retiredAt'), true)
  await assert.rejects(f.offer('remove', 'chief'), /resident Chief/)
  await f.rt.projectEffects.close()
})

test('stale approvals cannot replace newer owner settings and rejection changes no definition', async () => {
  const f = fixture(), offered = await f.offer()
  await f.service.update({ projectId: 'p', role: 'developer', instructions: 'New human convention' }, owner)
  await assert.rejects(f.approve(offered.proposal), /stale/)
  const before = structuredClone(f.set())
  await f.approve(offered.proposal, owner, { decision: 'reject' })
  assert.deepEqual(f.set(), before)
  await f.rt.projectEffects.close()
})

test('failed proposal/approval commits restore history and definitions; pending changes are not execution-visible', async () => {
  const f = fixture()
  f.fail(true); await assert.rejects(f.offer(), /save failed/)
  assert.equal(Object.keys(f.rt.state.projectRoleProposals).length, 0)
  f.fail(false); const offered = await f.offer(), before = structuredClone(f.set())
  f.fail(true); await assert.rejects(f.approve(offered.proposal), /save failed/)
  assert.deepEqual(f.set(), before); assert.equal(f.rt.state.projectRoleProposals[offered.proposal.id].status, 'proposed')
  f.fail(false)
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.hold(gate)
  const applying = f.approve(offered.proposal)
  // Observe the explicit save boundary, not a wall-clock sleep.
  while (!f.set().changeEffect) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.service.visibleSet('p').revision, before.revision)
  release(); await applying
  assert.equal(f.service.visibleSet('p').revision, before.revision + 1)
  await f.rt.projectEffects.close()
})

test('role proposals have stable Chief-level idempotency and bounded scoped queries', async () => {
  const f = fixture(), offered = await f.offer()
  f.authority.sourceId = 'another-chief-turn'
  assert.equal((await f.offer()).proposal.id, offered.proposal.id)
  await assert.rejects(f.offer('add', 'specialist', { reason: 'Changed intent with same key' }), /reused/)
  assert.equal(f.service.list({ projectId: 'p', limit: 1 }, member).proposals[0].id, offered.proposal.id)
  assert.throws(() => f.service.list({ projectId: 'foreign', proposalId: offered.proposal.id }, owner), /denied/)
  assert.throws(() => f.service.list({ projectId: 'p', limit: 51 }, owner), /page limit/)
  await f.rt.projectEffects.close()
})


test('restoring a retired role keeps its capability class and original conventions unless explicitly changed', async () => {
  const f = fixture(), removal = await f.offer('remove', 'reviewer')
  await f.approve(removal.proposal)
  const added = await f.offer('add', 'reviewer', { requestId: 'restore-reviewer', fields: { name: 'Restored Reviewer' } })
  await f.approve(added.proposal)
  const role = f.set().roles.find(row => row.role === 'reviewer')
  assert.equal(role.policyRole, 'reviewer'); assert.equal(role.instructions, 'Original convention')
  assert.equal(role.id, 'p:reviewer'); assert.equal(role.name, 'Restored Reviewer')
  assert.equal(role.retiredAt, undefined); assert.equal(role.changeId, undefined)
})


test('exact proposal queries retain the proposed definition and reject missing or foreign records', async () => {
  const f = fixture(), offered = await f.offer()
  const exact = f.service.list({ projectId: 'p', proposalId: offered.proposal.id }, member)
  assert.equal(exact.definition.instructions, 'Follow the original repository conventions')
  exact.definition.instructions = 'Client edit'
  assert.notEqual(f.service.list({ projectId: 'p', proposalId: offered.proposal.id }, member).definition.instructions, 'Client edit')
  assert.throws(() => f.service.list({ projectId: 'p', proposalId: 'unknown' }, member), /unavailable/)
  f.rt.state.projectRoleProposals[offered.proposal.id].projectId = 'other'
  assert.throws(() => f.service.list({ projectId: 'p', proposalId: offered.proposal.id }, member), /unavailable/)
})
