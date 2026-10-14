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

  rt.createInvitation = async function createInvitation({ ttlMs = DEFAULT_TTL_MS, createdByMemberId = null } = {}) {
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
    }
    await rt.save()
    return { id, token, expiresAt: now + ttlMs }
  }

  rt.redeemInvitation = async function redeemInvitation(token, { displayName = null } = {}) {
    if (typeof token !== 'string' || !token) return { ok: false, error: 'invalid_token' }
    const tokenHash = hashToken(token)
    const now = Date.now()
    const invitation = Object.values(state.invitations).find(inv => inv.tokenHash === tokenHash)
    if (!invitation) return { ok: false, error: 'invalid_token' }
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
    const session = Object.values(state.authSessions).find(s => s.tokenHash === tokenHash)
    if (!session || session.revokedAt) return false
    session.revokedAt = Date.now()
    await rt.save()
    return true
  }

  rt.revokeMemberSessions = async function revokeMemberSessions(memberId) {
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

  rt.removeMember = async function removeMember(memberId) {
    const members = rt.state.members || {}
    const member = members[memberId]
    if (!member) return { ok: false, error: 'not_found' }
    if (lastOwner(members)) return { ok: false, error: 'last_owner' }
    await rt.revokeMemberSessions(memberId)
    delete members[memberId]
    await rt.save()
    return { ok: true }
  }

  rt.whoami = async function whoami(sessionToken) {
    return rt.authenticate(sessionToken)
  }

  return rt
}

export { hashToken }
