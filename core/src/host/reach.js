// Reach policy (#90): who may be reached from outside their owner. One owner- and
// grant-aware check that sits OUTSIDE the plugin send chain, so a middleware's
// `allow` or `bypass` verdict can never skip it. hooks.js runs it before bot.send's
// chain, again when an approved hold is released, and on every other delivery that
// carries a sender (resumed, retried, deferred, re-sent), so a queued message is judged
// by what is true when it is delivered, not when it was written.
//
// There is no global "published" flag. Every access is an independent per-Bot GRANT
// (one of my Bots → one grantee; optionally scoped to a group). Default deny, Chief
// included. A grant is created when someone accepts a Sharing → Copy invite link, or implicitly
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

import { currentParticipants, homesOf } from './room-membership.js'

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

// #884: the owner made a Bot Social link for this room, which is the consent to show the room — as
// it is, with that owner's own Bots in it — to the home the link seats. Only that owner's Bots, and
// only while a link of the room is open or still holds a seat.
function openedByLink(state, room, botId) {
  const bot = state.bots?.[botId]
  if (!bot || bot.remote !== undefined || !bot.ownerId || !Array.isArray(room?.localInvites)) return false
  const at = Date.now()
  // Open (not withdrawn, not out of date: a link has no deadline now), or still holding a seat it made.
  return room.localInvites.some(invite => invite?.server === true && invite.mintedBy === bot.ownerId
    && (Boolean(invite.acceptedBy) || (invite.homes && Object.keys(invite.homes).length > 0)
      || (!invite.withdrawnAt && (invite.expiresAt == null || Number(invite.expiresAt) > at))))
}

// May this local Bot take part in a room that has a remote participant or more than one
// owner? A grant matching someone already in the room, or a code-join, is enough.
export function mayShareRoom(state, room, botId) {
  if (isCodeJoined(state, room?.id, botId)) return true
  if (hasAnyGrant(state, botId)) return true
  if (openedByLink(state, room, botId)) return true
  if (!ownerKnown(state, state.bots?.[botId])) return false
  for (const remote of remotesInRoom(room)) {
    if (hasGrant(state, botId, remote.handle || remote.id, room?.id) || hasGrant(state, botId, remote.handle || remote.id)) return true
  }
  for (const ownerId of ownersInRoom(state, room)) {
    if (ownerId !== state.bots?.[botId]?.ownerId && (hasGrant(state, botId, ownerId, room?.id) || hasGrant(state, botId, ownerId))) return true
  }
  return false
}

const label = value => String(value ?? '').replace(/\p{Cc}/gu, ' ').trim().slice(0, 60)

// The people and Bots in one room that are not the Bot's owner's own (a friend's Bot, a person who
// is not its owner, a Bot of another owner, a room joined by code), as short labels.
export function othersInRoom(state, room, bot) {
  const who = new Set()
  if (room === undefined || bot === undefined || bot.remote !== undefined) return []
  if ((room.members ?? []).includes(bot.id) && isCodeJoined(state, room.id, bot.id)) who.add('a room joined by code')
  for (const p of currentParticipants(room)) {
    if (p.kind === 'bot' && p.remote === true) who.add(label(p.displayName) || label(p.handle) || 'a friend')
    else if (p.kind === 'human' && bot.ownerId !== undefined && p.id !== bot.ownerId) who.add(label(p.displayName) || 'another person')
  }
  for (const memberId of room.members ?? []) {
    const other = state.bots?.[memberId]
    if (other !== undefined && other.remote === undefined && other.ownerId !== bot.ownerId) who.add(label(other.name) || 'another person')
  }
  who.delete('')
  return [...who]
}

// Everyone a local Bot is shared with right now, as short labels for the owner to read: the
// friends and members it has a grant to, and the other people and Bots in the rooms it sits in.
// Empty means it is the owner's alone. Nothing here decides reach. It says "this Bot is shared"
// for the Connectors page, and "this room has other people in it" decides whose request a Bot
// turn in that room answers (connector-access.js, #335).
export function sharedWith(state, botId) {
  const bot = state?.bots?.[botId]
  if (bot === undefined || bot.remote !== undefined) return []
  const who = new Set()
  for (const grant of grantsOf(state, botId)) who.add(label(grant.name) || label(grant.grantee) || 'a friend')
  for (const room of Object.values(state?.rooms ?? {})) {
    if (!(room.members ?? []).includes(botId)) continue
    for (const name of othersInRoom(state, room, bot)) who.add(name)
  }
  who.delete('')
  return [...who]
}

const inRoom = (state, roomId, botId) => {
  const room = state.rooms?.[String(roomId ?? '')]
  return room !== undefined && (room.members ?? []).includes(botId)
}

function remoteInRoom(state, roomId, peer) {
  const room = state.rooms?.[String(roomId ?? '')]
  if (!room) return false
  const keys = new Set(peerKeys(peer))
  return remotesInRoom(room).some((p) => {
    for (const key of peerKeys(p.handle || p.id)) if (keys.has(key)) return true
    return false
  })
}

// The seats each link of this room admitted: the invite's own `homes` (home → the handles it seated)
// is written on the accept and survives even when the seat record itself did not keep the ticket.
// #929: a link accepted before that field was written keeps the same fact in `acceptedBy` + `seats`, and
// `homesOf` in `room-membership.js` is the one reading of it — ask that, never `invite.homes` directly,
// or a room that predates the field enumerates no pair and its envelopes fall back to a friendship.
function linkSeats(room) {
  const out = new Map()
  const invites = [room?.localInvite, ...(Array.isArray(room?.localInvites) ? room.localInvites : [])]
  for (const invite of invites) {
    if (!invite || typeof invite.ticket !== 'string' || !invite.ticket) continue
    for (const handles of Object.values(homesOf(invite))) {
      for (const handle of Array.isArray(handles) ? handles : []) {
        if (typeof handle === 'string' && handle && !out.has(handle)) out.set(handle, invite)
      }
    }
  }
  return out
}

// #883, #884: the only pairs a room link opens, as { from: local Bot id, to: remote handle, scope:
// the room id Bot Social knows the room by, ticket? }. A seat in a room of this home is reached from
// the Bot its link named; a room of another home that a ticket seated Bots of mine in is reached from
// those Bots, to its inviter; a claim this home made is the accepting knock's one way out. Nothing
// else: a stranger is never on the roster, and these pairs are not friendships.
export function ticketPeers(state) {
  const peers = []
  const handleOf = p => String(p?.handle || p?.id || '')
  for (const room of Object.values(state.rooms ?? {})) {
    const live = currentParticipants(room)
    if (room.origin === 'inbound-share') {
      const from = room.sharedFrom ?? {}
      if (!from.ticket || !from.inviterHandle || !from.remoteRoomId || room.hidden) continue
      for (const p of live) {
        if (p.kind === 'bot' && !p.remote && state.bots?.[p.id]) peers.push({ from: p.id, to: from.inviterHandle, scope: String(from.remoteRoomId), ticket: from.ticket })
      }
      continue
    }
    const linkOf = linkSeats(room)
    for (const p of live) {
      if (p.kind !== 'bot' || p.remote !== true) continue
      // #923: a seat is a pair when a link of this room admitted it, whether the seat itself kept the
      // ticket (`admittedBy: 'ticket'`) or the link's own record of who it admitted is the only trace
      // — a room opened before the seat carried it must reach that seat the same way, or its group
      // envelopes fall back to a friendship the two homes never had. A friend's Bot added by hand is
      // named by no link and stays out.
      const ticket = p.admittedBy === 'ticket' ? p.ticket : linkOf.get(handleOf(p))?.ticket
      if (!ticket) continue
      // The seat names the Bot of this home whose handle it knocked on; a seat written before that
      // was recorded is reached from the room's own lead, which is the Bot its link was minted for.
      const host = p.hostBotId && (room.members ?? []).includes(p.hostBotId) ? p.hostBotId : room.admin
      if (!host || !(room.members ?? []).includes(host)) continue
      peers.push({ from: host, to: handleOf(p), scope: String(room.id), ticket })
    }
  }
  for (const [ticket, claim] of Object.entries(state.roomClaims ?? {})) {
    if (!claim?.inviterHandle || !claim.roomId) continue
    for (const id of claim.bots ?? []) if (state.bots?.[id]) peers.push({ from: id, to: claim.inviterHandle, scope: String(claim.roomId), ticket })
  }
  return peers
}

// The exact Bot, never "any Bot of that home": a link opens one pair, not a friendship.
const handleKey = ref => normGrantee(ref && typeof ref === 'object' ? ref.handle : ref)
const samePeer = (a, b) => handleKey(a) !== '' && handleKey(a) === handleKey(b)

export function reach(state, { from, to, roomId, scope } = {}) {
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
    // The owner already put this friend's Bot in the room: talking to it here is that share.
    if (roomId !== undefined && inRoom(state, roomId, from) && remoteInRoom(state, roomId, to)) return ALLOW
    // A room link's pair, under that room's scope only (#883).
    if (scope !== undefined && ticketPeers(state).some(peer => peer.from === from && peer.scope === String(scope) && samePeer(peer.to, to))) return ALLOW
    // Name the step that exists (#273): the sending Bot is the one not shared with that friend.
    return deny(`${sender.name} is not shared with that friend, so it cannot message their Bots. To allow it, share ${sender.name} with them in its settings → Sharing.`)
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
  rt.sharedWith = botId => sharedWith(state, botId)
  rt.othersInRoom = (room, botId) => othersInRoom(state, room, state.bots?.[botId])
  rt.isGranted = (botId, peer, roomId) => isGranted(state, botId, peer, roomId)
  rt.isCodeJoined = (roomId, botId) => isCodeJoined(state, roomId, botId)
  rt.mayShareRoom = (room, botId) => mayShareRoom(state, room, botId)
  rt.reach = (msg = {}) => reach(state, {
    from: msg.remote?.handle ? { kind: 'remote', handle: msg.remote.handle } : (msg.from ?? msg.fromId),
    to: msg.to ?? msg.toId,
    roomId: msg.meta?.roomId ?? msg.roomId ?? msg.fromRoomId ?? msg.deliverArgs?.roomId ?? msg.deliverArgs?.fromRoomId,
    scope: msg.meta?.scope,
  })
  rt.ticketPeers = () => ticketPeers(state)

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
    rt.refreshConnectorTools?.(botId)
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
