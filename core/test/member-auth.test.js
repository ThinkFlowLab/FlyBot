import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install as installStore } from '../src/host/store.js'
import { install as installMemberAuth } from '../src/host/member-auth.js'

// Member auth foundation (#48): invitations, member sessions, and whoami from the
// x-flybot-member-session header. Members are the #47 identity schema (human owners);
// Bot role is a job title and means nothing here. Team mode stays disabled.

function runtime(t, saved) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-member-auth-'))
  const statePath = join(dir, 'state.json')
  if (saved !== undefined) writeFileSync(statePath, typeof saved === 'string' ? saved : JSON.stringify(saved))
  const warnings = []
  const disposers = []
  const ctx = {
    logger: { warn: (...args) => warnings.push(args) },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  const rt = {
    ctx,
    home: dir,
    statePath,
    autoRoomName: () => 'Room',
    retitleRoom: async () => {},
    warn: (...args) => warnings.push(args),
  }
  installStore(rt)
  installMemberAuth(rt)
  t.after(async () => {
    await Promise.all(disposers.splice(0).map(cleanup => cleanup()))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  return { rt, statePath }
}

const TEAM = {
  version: 2,
  revision: 1,
  mainBotIds: ['m1'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'm1' } },
  bots: { m1: { id: 'm1', sessionId: 'm1', name: 'Chief', instructions: '', createdAt: 1, ownerId: 'owner-1' } },
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

test('two members get different identities via invite then redeem', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const invite1 = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  assert.equal(typeof invite1.token, 'string')
  assert.ok(invite1.token.length > 20)
  // First redeem binds to the existing owner-1 (bootstrap), not a second record.
  const first = await rt.redeemInvitation(invite1.token, { displayName: 'Alice' })
  assert.equal(first.ok, true)
  assert.equal(first.memberId, 'owner-1')
  assert.equal(first.displayName, 'Alice')
  assert.equal(typeof first.sessionToken, 'string')
  assert.notEqual(first.sessionToken, invite1.token)
  // A second invite is a second human: a new owner member record.
  const invite2 = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const second = await rt.redeemInvitation(invite2.token, { displayName: 'Bob' })
  assert.equal(second.ok, true)
  assert.notEqual(second.memberId, 'owner-1')
  assert.equal(second.displayName, 'Bob')
  assert.equal(second.memberId, 'owner-2')
  // Persisted members keep the identity shape: no role, no displayName field.
  const member1 = rt.state.members['owner-1']
  const member2 = rt.state.members['owner-2']
  assert.deepEqual(Object.keys(member1).sort(), ['createdAt', 'designatedChiefId', 'id'])
  assert.deepEqual(Object.keys(member2).sort(), ['createdAt', 'designatedChiefId', 'id'])
  assert.equal(member1.designatedChiefId, 'm1')
  assert.equal(member2.designatedChiefId, null)
  // The two sessions authenticate to distinct members.
  const who1 = await rt.authenticate(first.sessionToken)
  const who2 = await rt.authenticate(second.sessionToken)
  assert.equal(who1.memberId, 'owner-1')
  assert.equal(who2.memberId, 'owner-2')
  assert.notEqual(who1.sessionId, who2.sessionId)
})

test('authenticate ignores forged strings; only a live session token works', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const invite = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const session = await rt.redeemInvitation(invite.token)
  assert.equal((await rt.authenticate('owner-1'))?.memberId, undefined)
  assert.equal(await rt.authenticate('owner-1'), null)
  assert.equal(await rt.authenticate(session.memberId), null)
  assert.equal(await rt.authenticate('owner-1:main'), null)
  assert.equal(await rt.authenticate(''), null)
  assert.equal(await rt.authenticate(null), null)
  assert.equal(await rt.authenticate(undefined), null)
  assert.equal(await rt.authenticate(123), null)
  assert.equal(await rt.authenticate({ memberId: 'owner-1' }), null)
  // A string that merely looks like a member id or session id is not a session token.
  assert.equal(await rt.authenticate('as-' + '0'.repeat(16)), null)
  // The real token still works.
  const who = await rt.authenticate(session.sessionToken)
  assert.equal(who.memberId, 'owner-1')
})

test('an invitation token cannot be replayed and an expired one fails', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const invite = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  assert.equal((await rt.redeemInvitation(invite.token)).ok, true)
  const replay = await rt.redeemInvitation(invite.token)
  assert.equal(replay.ok, false)
  assert.equal(replay.error, 'already_redeemed')
  // Expired: a fresh invite whose ttl already elapsed.
  const expired = await rt.createInvitation({ createdByMemberId: 'owner-1', ttlMs: -1 })
  const result = await rt.redeemInvitation(expired.token)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'expired')
  // An unknown token is also refused.
  assert.equal((await rt.redeemInvitation('not-a-real-token')).error, 'invalid_token')
})

test('removeMember and revokeSession invalidate authenticate; last owner stays', async (t) => {
  const { rt } = runtime(t, TEAM)
  await rt.load()
  const inviteA = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const a = await rt.redeemInvitation(inviteA.token)
  const inviteB = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const b = await rt.redeemInvitation(inviteB.token)
  assert.equal((await rt.authenticate(b.sessionToken)).memberId, 'owner-2')
  // revokeSession: that one session dies, the other lives.
  assert.equal(await rt.revokeSession(b.sessionToken), true)
  assert.equal(await rt.authenticate(b.sessionToken), null)
  assert.equal((await rt.authenticate(a.sessionToken)).memberId, 'owner-1')
  // removeMember revokes that member's remaining sessions and drops the record.
  // owner-1 still owns the Main Bot m1, so the refusal comes first (has_bots).
  const owned = await rt.removeMember('owner-1')
  assert.equal(owned.ok, false)
  assert.equal(owned.error, 'has_bots')
  // Drop the Bot binding and the same remove succeeds.
  delete rt.state.bots.m1
  const removed = await rt.removeMember('owner-1')
  assert.equal(removed.ok, true)
  assert.equal(await rt.authenticate(a.sessionToken), null)
  assert.equal(rt.state.members['owner-1'], undefined)
  // With only one member left, the last owner cannot be removed.
  const last = await rt.removeMember('owner-2')
  assert.equal(last.ok, false)
  assert.equal(last.error, 'last_owner')
  assert.ok(rt.state.members['owner-2'])
  // A fresh single-owner team also refuses removeMember on owner-1.
  const fresh = runtime(t, TEAM)
  await fresh.rt.load()
  const only = await fresh.rt.removeMember('owner-1')
  assert.equal(only.ok, false)
  assert.equal(only.error, 'last_owner')
})

test('tokens are stored only as hashes; plaintext never reaches state.json', async (t) => {
  const { rt, statePath } = runtime(t, TEAM)
  await rt.load()
  const invite = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const session = await rt.redeemInvitation(invite.token, { displayName: 'Alice' })
  const saved = readFileSync(statePath, 'utf8')
  assert.equal(saved.includes(invite.token), false)
  assert.equal(saved.includes(session.sessionToken), false)
  assert.ok(saved.includes('"tokenHash"'))
  assert.ok(saved.includes('"authSessions"'))
})

// Two owners and nothing else: no Bot roster, no designated Chief, so a removeMember
// race is visible as member count rather than a has_bots refusal.
const FLAT = {
  version: 2,
  revision: 1,
  mainBotIds: [],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: null } },
  bots: {},
  rooms: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

async function twoMembers(rt) {
  const first = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const a = await rt.redeemInvitation(first.token)
  const second = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const b = await rt.redeemInvitation(second.token)
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  return { a, b }
}

test('removeMember refuses while the member still owns a Bot; has_bots after delete', async (t) => {
  const { rt, statePath } = runtime(t, TEAM)
  await rt.load()
  const { b } = await twoMembers(rt)
  assert.ok(rt.state.members['owner-2'])
  rt.state.bots['b1'] = { id: 'b1', sessionId: 'b1', name: 'X', instructions: '', createdAt: 2, ownerId: 'owner-2' }
  await rt.save()
  const refused = await rt.removeMember('owner-2')
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'has_bots')
  assert.ok(rt.state.members['owner-2'])
  // The refusal does not touch the member's live session.
  assert.equal((await rt.authenticate(b.sessionToken))?.memberId, 'owner-2')
  // The owner-2 member and its Bot survive a reload, and the refusal is not sticky:
  // drop the Bot and the same remove succeeds.
  delete rt.state.bots['b1']
  await rt.save()
  const removed = await rt.removeMember('owner-2')
  assert.equal(removed.ok, true)
  assert.equal(rt.state.members['owner-2'], undefined)
  // Restart: the saved file loads and the ownership invariants still hold.
  const restart = runtime(t, readFileSync(statePath, 'utf8'))
  await restart.rt.load()
  assert.equal(restart.rt.state.members['owner-2'], undefined)
  assert.ok(restart.rt.state.members['owner-1'])
  assert.equal(restart.rt.state.bots.m1.ownerId, 'owner-1')
})

test('concurrent removeMember calls cannot both pass the last-owner check', async (t) => {
  const { rt, statePath } = runtime(t, FLAT)
  await rt.load()
  await twoMembers(rt)
  assert.equal(Object.keys(rt.state.members).length, 2)
  const results = await Promise.all([rt.removeMember('owner-1'), rt.removeMember('owner-2')])
  const okCount = results.filter(r => r.ok).length
  assert.equal(okCount, 1)
  const refusal = results.find(r => !r.ok)
  assert.ok(['last_owner', 'not_found'].includes(refusal.error))
  assert.equal(Object.keys(rt.state.members).length, 1)
  const restart = runtime(t, readFileSync(statePath, 'utf8'))
  await restart.rt.load()
  assert.equal(Object.keys(restart.rt.state.members).length, 1)
})

test('a revoked invitation cannot be redeemed or revoked twice', async (t) => {
  const { rt } = runtime(t, FLAT)
  await rt.load()
  const invite = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  const revoked = await rt.revokeInvitation(invite.id)
  assert.deepEqual(revoked, { ok: true })
  assert.equal(await rt.revokeInvitation(invite.id).then(r => r.error), 'already_revoked')
  assert.equal(await rt.revokeInvitation('inv-nope').then(r => r.error), 'not_found')
  const redeem = await rt.redeemInvitation(invite.token)
  assert.equal(redeem.ok, false)
  assert.equal(redeem.error, 'revoked')
  // An invitation already redeemed cannot be revoked after the fact.
  const live = await rt.createInvitation({ createdByMemberId: 'owner-1' })
  assert.equal((await rt.redeemInvitation(live.token)).ok, true)
  assert.equal(await rt.revokeInvitation(live.id).then(r => r.error), 'already_redeemed')
})

test('authInviteAllowed: bootstrap opens the first invite, then a session is required', async (t) => {
  const { rt } = runtime(t, FLAT)
  await rt.load()
  // Never signed in: the channel lets an anonymous caller create the first invitation.
  assert.equal(Object.keys(rt.state.authSessions).length, 0)
  assert.equal(rt.authBootstrapOpen(), true)
  assert.equal(rt.authInviteAllowed(null), true)
  assert.equal(rt.authInviteAllowed(undefined), true)
  const invite = await rt.createInvitation({ createdByMemberId: null })
  assert.equal(typeof invite.token, 'string')
  // After the first session exists, bootstrap closes: an actor is required.
  const session = await rt.redeemInvitation(invite.token)
  assert.equal(session.ok, true)
  assert.equal(rt.authBootstrapOpen(), false)
  assert.equal(rt.authInviteAllowed(null), false)
  assert.equal(rt.authInviteAllowed({ memberId: 'owner-1', sessionId: session.sessionId, displayName: null }), true)
})
