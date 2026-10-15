// Reach policy (#90): who may be reached from outside their owner. One owner- and
// grant-aware check that sits OUTSIDE the plugin send chain, so a middleware's
// `allow` or `bypass` verdict can never skip it. hooks.js runs it before bot.send's
// chain, again when an approved hold is released, and on every other delivery that
// carries a sender (resumed, retried, deferred, re-sent), so a queued message is judged
// by what is true when it is delivered, not when it was written.
//
// There is no global "published" flag. Every access is an independent per-Bot GRANT
// (one of my Bots → one grantee; optionally scoped to a group). Default deny, Chief
// included. A grant is created when someone accepts "Invite to this Bot", or implicitly
// when the owner brings their own Bot into a face-to-face room by its 6-digit number
// (`viaCode: true`, this room only, while a member).
//
// Grants live on state.grants[botId] = [{ id, grantee, name?, relationshipId?, roomId? }].
// `grantee` is a friend home (`@bob.home`), a remote handle, a team member id, or a
// local Bot id. A Bot whose owner is not a team member has no grants.
//
// The rules (from → to), `deny` is `{ action: 'deny', reason, by: 'owner-policy' }`:
//   remote → local    the local Bot must have a grant matching that remote, or be
//                     code-joined in the room the message belongs to
//   local → remote    the sending Bot must have a grant matching that remote, or be
//                     a code-joined member of the room the message belongs to
//   local → local     same owner: allowed. Other owner: both sides need a matching
//                     grant, or both are current members of the room the message belongs to
//   no sender         the owner or the system: allowed

import { currentParticipants } from './room-membership.js'

export const POLICY = 'owner-policy'

const isRemoteRef = ref => (ref !== null && typeof ref === 'object' && ref.kind === 'remote') || (typeof ref === 'string' && ref.startsWith('@'))
const deny = reason => ({ action: 'deny', reason, by: POLICY })
const ALLOW = Object.freeze({ action: 'allow' })

const ownerKnown = (state, bot) => {
  if (!bot) return false
  const members = state.members
  // Single-human / version-1 teams have no members map: the install owner is implicit.
  if (!members || Object.keys(members).length === 0) return true
  return Boolean(bot.ownerId && members[bot.ownerId])
}

export function normGrantee(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') {
    if (value.kind === 'remote') return normGrantee(value.handle)
    if (typeof value.handle === 'string') return normGrantee(value.handle)
    if (typeof value.id === 'string') return String(value.id)
  }
  const raw = String(value).trim()
  if (!raw) return ''
  if (raw.startsWith('@')) return `@${raw.replace(/^@+/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '')}`
  return raw
}

export function homeOfHandle(handle) {
  const key = normGrantee(handle)
  if (!key.startsWith('@')) return key
  const parts = key.slice(1).split('.')
  return parts.length > 2 ? `@${parts.slice(1).join('.')}` : key
}

function peerKeys(peer) {
  const key = normGrantee(peer)
  if (!key) return []
  const keys = new Set([key])
  if (key.startsWith('@')) keys.add(homeOfHandle(key))
  if (peer && typeof peer === 'object') {
    if (peer.ownerId) keys.add(String(peer.ownerId))
    if (peer.home) keys.add(normGrantee(peer.home))
  }
  return [...keys]
}

export function grantsOf(state, botId) {
  const list = state?.grants?.[botId]
  return Array.isArray(list) ? list : []
}

function grantMatches(grant, peer) {
  const g = normGrantee(grant?.grantee)
  if (!g) return false
  return peerKeys(peer).some(key => key === g || homeOfHandle(key) === g || key === homeOfHandle(g))
}

export function hasGrant(state, botId, peer, roomId) {
  const bot = state.bots?.[botId]
  if (bot === undefined || bot.remote !== undefined || !ownerKnown(state, bot)) return false
  return grantsOf(state, botId).some(grant => {
    if (grant.roomId && String(grant.roomId) !== String(roomId ?? '')) return false
    return grantMatches(grant, peer)
  })
}

export function hasAnyGrant(state, botId) {
  const bot = state.bots?.[botId]
  if (bot === undefined || bot.remote !== undefined || !ownerKnown(state, bot)) return false
  return grantsOf(state, botId).some(grant => !grant.roomId)
}

export function isGranted(state, botId, peer, roomId) {
  if (peer !== undefined && peer !== null) return hasGrant(state, botId, peer, roomId)
  return hasAnyGrant(state, botId)
}

// A Bot that joined this room with its room code: reachable only here, only while a member.
export function isCodeJoined(state, roomId, botId) {
  const room = state.rooms?.[String(roomId ?? '')]
  return room !== undefined && currentParticipants(room).some(p => p.kind === 'bot' && !p.remote && p.id === botId && p.viaCode === true)
}

function remotesInRoom(room) {
  return currentParticipants(room).filter(p => p.kind === 'bot' && p.remote === true)
}

function ownersInRoom(state, room) {
  const owners = new Set()
  for (const p of currentParticipants(room)) {
    if (p.kind === 'human') owners.add(p.id)
    else if (!p.remote && state.bots?.[p.id]?.ownerId) owners.add(state.bots[p.id].ownerId)
  }
  return owners
}

// May this local Bot take part in a room that has a remote participant or more than one
// owner? A grant matching someone already in the room, or a code-join, is enough.
export function mayShareRoom(state, room, botId) {
  if (isCodeJoined(state, room?.id, botId)) return true
  if (hasAnyGrant(state, botId)) return true
  if (!ownerKnown(state, state.bots?.[botId])) return false
  for (const remote of remotesInRoom(room)) {
    if (hasGrant(state, botId, remote.handle || remote.id, room?.id) || hasGrant(state, botId, remote.handle || remote.id)) return true
  }
  for (const ownerId of ownersInRoom(state, room)) {
    if (ownerId !== state.bots?.[botId]?.ownerId && (hasGrant(state, botId, ownerId, room?.id) || hasGrant(state, botId, ownerId))) return true
  }
  return false
}

const inRoom = (state, roomId, botId) => {
  const room = state.rooms?.[String(roomId ?? '')]
  return room !== undefined && (room.members ?? []).includes(botId)
}

export function reach(state, { from, to, roomId } = {}) {
  const fromRemote = isRemoteRef(from)
  const toRemote = isRemoteRef(to)
  if (fromRemote && toRemote) return deny('one side must be a local Bot')
  if (fromRemote) {
    const target = state.bots?.[to]
    if (target === undefined) return ALLOW
    if (hasGrant(state, to, from, roomId) || (roomId !== undefined && isCodeJoined(state, roomId, to))) return ALLOW
    return deny(`${target.name} has not been granted to this sender, so it cannot be reached from outside`)
  }
  if (from === undefined || from === null) return ALLOW
  const sender = state.bots?.[from]
  if (sender === undefined) return ALLOW
  if (toRemote) {
    if (hasGrant(state, from, to, roomId) || (roomId !== undefined && isCodeJoined(state, roomId, from))) return ALLOW
    return deny(`${sender.name} has no grant to that Bot, so it cannot message friends' Bots`)
  }
  const target = state.bots?.[to]
  if (target === undefined) return ALLOW
  if (sender.ownerId === target.ownerId) return ALLOW
  if (!ownerKnown(state, sender) || !ownerKnown(state, target)) return deny('that Bot has no owner on this team')
  if (hasGrant(state, from, target.ownerId, roomId) && hasGrant(state, to, sender.ownerId, roomId)) return ALLOW
  if (hasGrant(state, from, to, roomId) && hasGrant(state, to, from, roomId)) return ALLOW
  if (roomId !== undefined && inRoom(state, roomId, from) && inRoom(state, roomId, to)) return ALLOW
  return deny(`${target.name} has not been granted to this sender, so it cannot be reached by another owner's Bot`)
}

function grantsEqual(a = [], b = []) {
  if (a.length !== b.length) return false
  const key = g => `${g.id ?? ''}\0${normGrantee(g.grantee)}\0${g.roomId ?? ''}`
  const left = a.map(key).sort()
  const right = b.map(key).sort()
  return left.every((item, i) => item === right[i])
}

export function install(rt) {
  const { state } = rt
  state.grants ??= {}

  rt.grantsOf = botId => grantsOf(state, botId)
  rt.hasGrant = (botId, peer, roomId) => hasGrant(state, botId, peer, roomId)
  rt.hasAnyGrant = botId => hasAnyGrant(state, botId)
  rt.isGranted = (botId, peer, roomId) => isGranted(state, botId, peer, roomId)
  rt.isCodeJoined = (roomId, botId) => isCodeJoined(state, roomId, botId)
  rt.mayShareRoom = (room, botId) => mayShareRoom(state, room, botId)
  rt.reach = (msg = {}) => reach(state, {
    from: msg.remote?.handle ? { kind: 'remote', handle: msg.remote.handle } : (msg.from ?? msg.fromId),
    to: msg.to ?? msg.toId,
    roomId: msg.meta?.roomId ?? msg.roomId ?? msg.fromRoomId ?? msg.deliverArgs?.roomId ?? msg.deliverArgs?.fromRoomId,
  })

  rt.setGrants = async (botId, list) => {
    const bot = state.bots?.[botId]
    if (bot === undefined || bot.remote !== undefined) throw Object.assign(new Error('Unknown Bot'), { code: 'bot/not-found' })
    if (!Array.isArray(list)) throw Object.assign(new Error('grants must be an array'), { code: 'bot/invalid' })
    const next = list.map((grant, i) => {
      const grantee = normGrantee(grant?.grantee)
      if (!grantee) throw Object.assign(new Error('each grant needs a grantee'), { code: 'bot/invalid' })
      return {
        id: String(grant.id ?? grant.relationshipId ?? `${botId}:${grantee}:${grant.roomId ?? ''}:${i}`),
        grantee,
        ...(grant.name ? { name: String(grant.name) } : {}),
        ...(grant.relationshipId ? { relationshipId: String(grant.relationshipId) } : {}),
        ...(grant.roomId ? { roomId: String(grant.roomId) } : {}),
      }
    })
    const before = hasAnyGrant(state, botId)
    state.grants ??= {}
    const changed = !grantsEqual(state.grants[botId], next)
    if (next.length) state.grants[botId] = next
    else delete state.grants[botId]
    if (changed && before !== hasAnyGrant(state, botId)) await rt.reachChanged(botId)
    else if (changed) {
      await rt.evictUnshared?.(botId)
      rt.flybotGrantsChanged?.(botId)
    }
    await rt.save()
    return grantsOf(state, botId)
  }

  rt.reachChanged = async (botId) => {
    await rt.evictUnshared?.(botId)
    rt.flybotGrantsChanged?.(botId)
  }
  const syncChief = rt.syncDesignatedChief
  if (typeof syncChief === 'function') {
    rt.syncDesignatedChief = (...args) => {
      const before = new Map(Object.keys(state.bots ?? {}).map(id => [id, hasAnyGrant(state, id)]))
      const changed = syncChief(...args)
      if (changed) {
        for (const [id, was] of before) if (was !== hasAnyGrant(state, id)) void rt.reachChanged(id).catch(error => rt.warn?.('ds-bot: reach change for %s failed: %s', id, error))
      }
      return changed
    }
  }
}
