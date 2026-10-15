// Member auth foundation (#48): invitations, member sessions, and the whoami that the
// channel resolves from the x-flybot-member-session header. Members are human owners
// (store #47 identity schema: id, createdAt, designatedChiefId) — Bot `role` is a job
// title and grants nothing here. Tokens never leave as hashes; only hashes are stored.
// This is not team mode: it is the sign-in surface the gates in docs/subsystems/team.md
// need, and nothing more.
import { createHash, randomBytes } from 'node:crypto'

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function ensureState(state) {
  if (!state.invitations) state.invitations = {}
  if (!state.authSessions) state.authSessions = {}
  return state
}

// Last owner: the one member the single-human product still needs. All members are
// human owners; a Bot is not a member and its job-title role means nothing here.
function lastOwner(members) {
  return Object.keys(members).length <= 1
}

function displayNameOf(member, displayName) {
  return displayName ?? member.displayName ?? member.name ?? member.id
}

export function install(rt) {
  const state = ensureState(rt.state)

  // One mutation at a time: a check like last_owner or has_bots must not race another
  // mutation that would invalidate it between the check and the save.
  let authGate = Promise.resolve()
  const withAuthLock = fn => {
    const run = authGate.then(fn, fn)
    authGate = run.then(() => {}, () => {})
    return run
  }

  rt.createInvitation = async function createInvitation({ ttlMs = DEFAULT_TTL_MS, createdByMemberId = null } = {}) {
    return withAuthLock(async () => {
      const token = randomBytes(32).toString('base64url')
      const tokenHash = hashToken(token)
      const id = `inv-${randomBytes(8).toString('hex')}`
      const now = Date.now()
      state.invitations[id] = {
        id,
        tokenHash,
        createdByMemberId,
        createdAt: now,
        expiresAt: now + ttlMs,
        redeemedAt: null,
        redeemedByMemberId: null,
        revokedAt: null,
      }
      await rt.save()
      return { id, token, expiresAt: now + ttlMs }
    })
  }

  rt.revokeInvitation = async function revokeInvitation(invitationId) {
    return withAuthLock(async () => {
      const inv = state.invitations[invitationId]
      if (!inv) return { ok: false, error: 'not_found' }
      if (inv.redeemedAt) return { ok: false, error: 'already_redeemed' }
      if (inv.revokedAt) return { ok: false, error: 'already_revoked' }
      inv.revokedAt = Date.now()
      await rt.save()
      return { ok: true }
    })
  }

  rt.redeemInvitation = async function redeemInvitation(token, { displayName = null } = {}) {
    if (typeof token !== 'string' || !token) return { ok: false, error: 'invalid_token' }
    const tokenHash = hashToken(token)
    const now = Date.now()
    return withAuthLock(async () => {
      const invitation = Object.values(state.invitations).find(inv => inv.tokenHash === tokenHash)
      if (!invitation) return { ok: false, error: 'invalid_token' }
      if (invitation.revokedAt) return { ok: false, error: 'revoked' }
      if (invitation.redeemedAt) return { ok: false, error: 'already_redeemed' }
      if (now > invitation.expiresAt) return { ok: false, error: 'expired' }

      if (!rt.state.members) rt.state.members = {}
      const members = rt.state.members
      // Bootstrap: the first redeem binds to the existing single owner (owner-1) when one
      // is there, so the human who installed FlyBot claims the session without a second
      // member record. Only a later redeem creates the next owner.
      let member
      if (Object.keys(state.authSessions).length === 0) {
        member = members['owner-1'] ?? null
      }
      if (!member) {
        let n = 1
        while (members[`owner-${n}`]) n += 1
        const memberId = `owner-${n}`
        // Persisted member is the identity schema only; displayName is returned in the
        // session response, not written into the member record.
        member = { id: memberId, createdAt: now, designatedChiefId: null }
        members[memberId] = member
      }
      const sessionToken = randomBytes(32).toString('base64url')
      const sessionId = `as-${randomBytes(8).toString('hex')}`
      state.authSessions[sessionId] = {
        id: sessionId,
        tokenHash: hashToken(sessionToken),
        memberId: member.id,
        createdAt: now,
        revokedAt: null,
      }
      invitation.redeemedAt = now
      invitation.redeemedByMemberId = member.id
      await rt.save()
      return { ok: true, sessionToken, memberId: member.id, displayName: displayNameOf(member, displayName) }
    })
  }

  rt.authenticate = async function authenticate(sessionToken) {
    if (typeof sessionToken !== 'string' || !sessionToken) return null
    const tokenHash = hashToken(sessionToken)
    const session = Object.values(state.authSessions).find(s => s.tokenHash === tokenHash)
    if (!session || session.revokedAt) return null
    const member = (rt.state.members || {})[session.memberId]
    if (!member) return null
    return { memberId: member.id, sessionId: session.id, displayName: displayNameOf(member) }
  }

  rt.revokeSession = async function revokeSession(sessionToken) {
    if (typeof sessionToken !== 'string' || !sessionToken) return false
    const tokenHash = hashToken(sessionToken)
    return withAuthLock(async () => {
      const session = Object.values(state.authSessions).find(s => s.tokenHash === tokenHash)
      if (!session || session.revokedAt) return false
      session.revokedAt = Date.now()
      await rt.save()
      return true
    })
  }

  const revokeMemberSessionsNow = async memberId => {
    const now = Date.now()
    let count = 0
    for (const session of Object.values(state.authSessions)) {
      if (session.memberId === memberId && !session.revokedAt) {
        session.revokedAt = now
        count += 1
      }
    }
    if (count > 0) await rt.save()
    return count
  }

  rt.revokeMemberSessions = async function revokeMemberSessions(memberId) {
    return withAuthLock(() => revokeMemberSessionsNow(memberId))
  }

  rt.removeMember = async function removeMember(memberId) {
    return withAuthLock(async () => {
      const members = rt.state.members || {}
      const member = members[memberId]
      if (!member) return { ok: false, error: 'not_found' }
      if (lastOwner(members)) return { ok: false, error: 'last_owner' }
      const bots = Object.values(rt.state.bots || {})
      if (bots.some(b => b.ownerId === memberId)) return { ok: false, error: 'has_bots' }
      await revokeMemberSessionsNow(memberId)
      delete members[memberId]
      await rt.save()
      return { ok: true }
    })
  }

  // Channel bootstrap: an invitation needs a signed-in member, except on a host that has
  // never had a session — the first invite is how the installing human signs in.
  rt.authInviteAllowed = actor => !!actor || Object.keys(state.authSessions).length === 0
  rt.authBootstrapOpen = () => Object.keys(state.authSessions).length === 0

  rt.whoami = async function whoami(sessionToken) {
    return rt.authenticate(sessionToken)
  }

  return rt
}

export { hashToken }
