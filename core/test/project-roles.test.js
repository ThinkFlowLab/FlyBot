// #1828: a Project's roles. The record stores only maintainers and members; the Owner is derived
// from `ownerUserIds`, so a Project written before this slice is owner-only without a migration.
import test from 'node:test'
import assert from 'node:assert/strict'
import { changeRole, roleChoices, roleOf, rolesOf } from '../src/host/project-board.js'

const project = (extra = {}) => ({ id: 'project-1', name: 'P', ownerUserIds: ['owner'], ...extra })

test('a Project written before roles derives to owner-only (#1828)', () => {
  const old = project()
  assert.deepEqual(rolesOf(old), { owner: ['owner'], maintainers: [], members: [] })
  assert.equal(roleOf(old, 'owner'), 'owner')
  assert.equal(roleOf(old, 'someone'), null)
  assert.deepEqual(roleChoices(old, 'owner'), [])
})

test('a member cannot promote themselves and the roles stay put (#1828)', () => {
  const p = project({ roles: { maintainers: [], members: ['m'] } })
  const before = rolesOf(p)
  assert.deepEqual(changeRole(p, { actorId: 'm', targetId: 'm', role: 'maintainer' }), { ok: false, reason: 'cannot-self-promote' })
  assert.deepEqual(changeRole(p, { actorId: 'm', targetId: 'm', role: 'owner' }), { ok: false, reason: 'owner-not-assignable' })
  assert.deepEqual(rolesOf(p), before)
  assert.deepEqual(roleChoices(p, 'm'), [])
})

test('a member has no switchable role and cannot promote themselves (#1828)', () => {
  const p = project({ roles: { maintainers: [], members: ['b'] } })
  assert.deepEqual(roleChoices(p, 'b'), [])
  assert.deepEqual(changeRole(p, { actorId: 'b', targetId: 'b', role: 'maintainer' }), { ok: false, reason: 'cannot-self-promote' })
  assert.deepEqual(changeRole(p, { actorId: 'b', targetId: 'c', role: 'member' }), { ok: false, reason: 'not-owner' })
  assert.deepEqual(rolesOf(p), { owner: ['owner'], maintainers: [], members: ['b'] })
})

test('an owner demotes another member to Member (#1828)', () => {
  const p = project({ roles: { maintainers: ['m'], members: ['n'] } })
  const done = changeRole(p, { actorId: 'owner', targetId: 'm', role: 'member' })
  assert.deepEqual(done, { ok: true, roles: { maintainers: [], members: ['n', 'm'] } })
  assert.deepEqual(roleChoices(p, 'owner', 'm'), ['member'], 'the current role is not offered')
  assert.deepEqual(roleChoices(p, 'owner', 'n'), ['maintainer'])
})

test('the last owner cannot be demoted, by themselves or by anyone else (#1828)', () => {
  const p = project()
  assert.deepEqual(changeRole(p, { actorId: 'owner', targetId: 'owner', role: 'member' }), { ok: false, reason: 'last-owner' })
  assert.deepEqual(changeRole(p, { actorId: 'owner', targetId: 'owner', role: 'owner' }), { ok: false, reason: 'owner-not-assignable' })
  assert.deepEqual(rolesOf(p), { owner: ['owner'], maintainers: [], members: [] })
})

// #1838: `PROJECT_ROLE_RANKS` is a plain object, so a name inherited from Object.prototype used to
// read as a defined rank, skip every refusal, and land on the demote path. A role name is the rank
// table's own key or it is not a role.
test('#1838: role "toString" is refused and a Maintainer keeps that rank', () => {
  const p = project({ roles: { maintainers: ['m'], members: ['n'] } })
  const before = rolesOf(p)
  assert.deepEqual(changeRole(p, { actorId: 'owner', targetId: 'm', role: 'toString' }), { ok: false, reason: 'unknown-role' })
  assert.deepEqual(rolesOf(p), before)
})

test('#1838: role "__proto__" is refused and a Maintainer keeps that rank', () => {
  const p = project({ roles: { maintainers: ['m'], members: ['n'] } })
  const before = rolesOf(p)
  assert.deepEqual(changeRole(p, { actorId: 'owner', targetId: 'm', role: '__proto__' }), { ok: false, reason: 'unknown-role' })
  assert.deepEqual(rolesOf(p), before)
})

test('#1838: role "constructor" is refused and a Maintainer keeps that rank', () => {
  const p = project({ roles: { maintainers: ['m'], members: ['n'] } })
  const before = rolesOf(p)
  assert.deepEqual(changeRole(p, { actorId: 'owner', targetId: 'm', role: 'constructor' }), { ok: false, reason: 'unknown-role' })
  assert.deepEqual(rolesOf(p), before)
})
