// Room membership (#50/#50 follow-up): typed human, local-bot and granted remote-bot
// participants, room roles, persistent author ids, membership-window history. Face-to-face
// rooms (#83) reuse this model (`origin: 'face-to-face'`) so room-only matching members
// can sit as remote participants without a friendship. This is not team mode — the gates
// in docs/subsystems/team.md stay unsatisfied.
//
// Data model (additive; no STATE_VERSION bump). A room may carry `participants`:
//
//   { kind: 'human'|'bot', id, role: 'admin'|'member', displayName,
//     joinedSeq, joinedAt, leftSeq?, leftAt?,
//     invitedBy?, invitedByName?, invitedAt? }
//   remote bot:
//   { kind: 'bot', remote: true, id: handle, handle, ownerHome, ownerName,
//     displayName, isChief?, role, invitedBy, invitedByName, invitedAt,
//     joinedSeq, joinedAt, leftSeq?, leftAt? }
//
// `room.members` stays the current *local* bot ids (group rounds, settings, avatars).
// Rooms that never grew `participants` keep the shipped single-owner shape.
//
// History-visibility rule (membership window):
//   Only a *current* participant — or the owner of an invited Bot — may read a room.
//   They see lines whose `seq` is at least the `joinedSeq` of their open interval
//   (for an invited owner, their Bot's interval). Leaving closes the interval and
//   withdraws all history access. Rejoining opens a new interval at the then-current
//   seq; prior intervals do not come back. Non-members cannot read or inject.
//   Ungranted specialists stay owner-private. Across owners (and with remote
//   participants) only a local Bot that has a grant matching someone in the room
//   (see reach.js) or a Bot that joined by room code (`viaCode`, #83; reachable in
//   this room only, while a member), and a Bot granted to this owner
//   (`state.flybot.remote`, cleanRemote) may be added. A Bot that stops qualifying
//   (grant revoked) leaves such rooms at once (rt.evictUnshared).
//
// Inbound shared rooms (`origin: 'inbound-share'`) are the remote owner's projection
// of a friend's room that invited their granted Bot.

import { cleanPeerName, disambiguatedRemoteTitle, isChiefRecord, remoteBotTitle, sharedRoomTitle } from '../shared/remote-label.js'
import { formatFaceRoomTitle, isAutoFaceTitle, faceRoomCreatedAt } from '../shared/face-title.js'
import { encodeRoomShare, parseRoomShare } from '../shared/room-share.js'
import { cleanName, fenceUntrusted, isFencedUntrusted } from './delivery.js'
import { hasAnyGrant, mayShareRoom } from './reach.js'

const KINDS = new Set(['human', 'bot'])
const ROLES = new Set(['admin', 'member'])

export const PARTICIPANT_KINDS = ['human', 'bot']
export const ROOM_ROLES = ['admin', 'member']

const deny = (code, message) => Object.assign(new Error(message), { code })
const invalid = message => deny('bot/invalid', message)
const forbidden = message => deny('bot/forbidden', message)

export function currentParticipants(room) {
  return (room?.participants ?? []).filter(p => p.leftSeq === undefined)
}

export function isRemoteParticipant(p) {
  return p?.kind === 'bot' && p.remote === true
}

export function isRemoteDraft(draft) {
  return draft?.kind === 'bot' && (draft.remote === true || (typeof draft.handle === 'string' && draft.handle.startsWith('@')))
}

export function publishedRemotes(state) {
  return Object.values(state?.flybot?.remote ?? {}).flat().filter(bot => typeof bot?.handle === 'string')
}

export function publishedRemoteOf(state, handle) {
  const id = String(handle ?? '')
  return publishedRemotes(state).find(bot => bot.handle === id)
}

export function participantOf(room, kind, id) {
  return currentParticipants(room).find(p => {
    if (p.kind !== kind) return false
    if (p.id === id) return true
    return Boolean(p.remote && (p.handle === id || p.id === id))
  })
}

export function humanOwnersOf(room, state) {
  const owners = new Set()
  const live = currentParticipants(room)
  if (live.length > 0) {
    for (const p of live) {
      if (p.kind === 'human') owners.add(p.id)
      else if (!p.remote) {
        const ownerId = state.bots?.[p.id]?.ownerId
        if (ownerId) owners.add(ownerId)
      }
    }
    return owners
  }
  for (const id of room?.members ?? []) {
    const ownerId = state.bots?.[id]?.ownerId
    if (ownerId) owners.add(ownerId)
  }
  return owners
}

// Unsigned-in cloud UI has no member session. A face room still has one local owner
// (the person whose Bots joined); type as that human so the line can fan out.
export function implicitRoomOwner(room, state) {
  const owners = humanOwnersOf(room, state)
  const id = owners.size >= 1 ? [...owners][0] : Object.keys(state?.members || {})[0]
  if (!id) return undefined
  return { memberId: id, displayName: displayNameFor(state, id) || 'You' }
}

export function isCrossOwnerRoom(room, state) {
  return humanOwnersOf(room, state).size > 1
}

export function isDesignatedChief(state, botId) {
  const bot = state.bots?.[botId]
  if (!bot?.ownerId) return false
  return state.members?.[bot.ownerId]?.designatedChiefId === botId
}

export function isSpecialist(state, botId) {
  return state.bots?.[botId] !== undefined && !isDesignatedChief(state, botId)
}

const isPlaceholderName = (name) => {
  const text = String(name ?? '').trim()
  return !text || /^user$/i.test(text) || /^you$/i.test(text)
}

export function displayNameFor(state, memberId, fallback) {
  for (const session of Object.values(state.authSessions || {})) {
    if (session.memberId === memberId && !session.revokedAt && session.displayName && !isPlaceholderName(session.displayName)) {
      return session.displayName
    }
  }
  for (const room of Object.values(state.rooms || {})) {
    const hit = currentParticipants(room).find(p => p.kind === 'human' && p.id === memberId && p.displayName && !isPlaceholderName(p.displayName))
    if (hit) return hit.displayName
  }
  const member = state.members?.[memberId]
  if (member?.displayName && !isPlaceholderName(member.displayName)) return member.displayName
  if (fallback && !isPlaceholderName(fallback)) return fallback
  return fallback || member?.id || memberId
}

export function invitedBotOf(room, actor, state) {
  if (!actor?.memberId) return undefined
  if (room?.sharedFrom?.ownerId === actor.memberId) {
    return currentParticipants(room).find(p => p.kind === 'bot' && (
      p.handle === room.sharedFrom.invitedHandle || p.id === room.sharedFrom.localBotId || p.ownerId === actor.memberId
      || (!p.remote && state?.bots?.[p.id]?.ownerId === actor.memberId)
    ))
  }
  return currentParticipants(room).find(p => p.kind === 'bot' && !p.remote && state?.bots?.[p.id]?.ownerId === actor.memberId)
}

// The owner of an invited Bot who is not themselves a human participant.
export function ownsInvitedBot(room, actor, state) {
  if (participantOf(room, 'human', actor?.memberId)) return false
  if (room?.sharedFrom?.ownerId === actor?.memberId) {
    const bot = invitedBotOf(room, actor, state)
    return Boolean(bot) || currentParticipants(room).some(p => p.kind === 'bot')
  }
  return Boolean(invitedBotOf(room, actor, state))
}

export function viewerRole(room, actor, state) {
  if (!actor?.memberId) return 'anon'
  if (participantOf(room, 'human', actor.memberId)) return 'member'
  if (ownsInvitedBot(room, actor, state) || room?.sharedFrom?.ownerId === actor.memberId) return 'invited-owner'
  if (roomVisibleTo(state, actor, room?.id)) return 'member'
  return 'outsider'
}

export function inviterSnapshot(room, state) {
  if (room?.sharedFrom?.inviterName) {
    return {
      inviterName: cleanPeerName(room.sharedFrom.inviterName, 'a friend'),
      inviterHome: room.sharedFrom.inviterHome,
      invitedAt: room.sharedFrom.invitedAt ?? room.createdAt,
      invitedHandle: room.sharedFrom.invitedHandle,
      localBotId: room.sharedFrom.localBotId,
    }
  }
  const invited = currentParticipants(room).find(p => p.invitedBy)
  const name = invited?.invitedByName || displayNameFor(state, invited?.invitedBy) || displayNameFor(state, room?.createdBy)
  return { inviterName: cleanPeerName(name, 'a friend'), invitedAt: invited?.invitedAt ?? room?.createdAt }
}

export function presentParticipant(p, others = []) {
  if (!p) return p
  if (p.kind === 'human') return { ...p, label: p.displayName || p.id }
  if (isRemoteParticipant(p)) {
    const label = disambiguatedRemoteTitle(p, others)
    return { ...p, label, ownerBadge: label, ownerName: ownerNameSafe(p) }
  }
  return { ...p, label: p.displayName || p.id }
}

function ownerNameSafe(p) {
  return cleanPeerName(p.ownerName || p.homeName || p.ownerHome, '')
}

export function isFaceRoom(room) {
  return room?.origin === 'face-to-face'
}

function faceStatusFrom(spec, current) {
  const status = spec?.status
  if (status === 'open' || status === 'closed' || status === 'left') return status
  if (spec?.startedAt) return 'open'
  if (status) return status
  return current || 'candidate'
}

export function presentRoom(room, actor, state) {
  if (!room) return room
  const role = viewerRole(room, actor, state)
  const live = currentParticipants(room)
  const participants = live.map(p => presentParticipant(p, live))
  const base = {
    ...room,
    viewerRole: role,
    participants: room.participants,
    presentedParticipants: participants,
  }
  if (isFaceRoom(room)) {
    const labeled = live.map(p => {
      const shown = presentParticipant(p, live)
      if (p.kind !== 'bot') return shown
      // Every face-to-face member is `<Bot> · <owner>'s Bot` (Chief: `<owner>'s Chief`),
      // including the viewer's own Bot, matching the server label.
      if (!p.ownerName && !isRemoteParticipant(p)) return shown
      const label = disambiguatedRemoteTitle(p, live)
      return { ...shown, label, ownerBadge: label, ownerName: ownerNameSafe(p) }
    })
    return {
      ...base,
      presentedParticipants: labeled,
      viewerRole: role === 'outsider' ? 'outsider' : 'member',
      displayName: room.name,
      face: room.face,
      origin: 'face-to-face',
      sharedFrom: undefined,
      inviteNotice: false,
    }
  }
  if (role !== 'invited-owner') return base
  const from = inviterSnapshot(room, state)
  const bot = invitedBotOf(room, actor, state)
  return {
    ...base,
    displayName: sharedRoomTitle(from.inviterName),
    sharedFrom: {
      ...from,
      ownerId: actor?.memberId,
      botName: bot?.displayName || bot?.id,
      botHandle: bot?.handle,
      botId: bot?.remote ? undefined : bot?.id,
      invitedAt: bot?.invitedAt ?? from.invitedAt,
    },
    inviteNotice: room.inviteNotice !== false,
  }
}

// A signed-in human may see a room when they are a current human participant,
// they own an invited Bot in it, or (legacy / single-owner) every bot belongs to them.
export function roomVisibleTo(state, actor, roomId) {
  if (!actor?.memberId) return false
  const room = state.rooms?.[String(roomId ?? '')]
  if (!room) return false
  if (room.hidden) return false
  if (participantOf(room, 'human', actor.memberId)) return true
  if (ownsInvitedBot(room, actor, state) || room.sharedFrom?.ownerId === actor.memberId) {
    const bot = invitedBotOf(room, actor, state)
    if (!bot || bot.leftSeq !== undefined) return false
    return true
  }
  const ids = room.members ?? []
  if (ids.length === 0) return false
  return ids.every(id => state.bots?.[id]?.ownerId === actor.memberId)
}

export function joinedSeqOf(room, actor, state) {
  const me = participantOf(room, 'human', actor?.memberId)
  if (me) return me.joinedSeq ?? 0
  const invited = invitedBotOf(room, actor, state)
  if (invited) return invited.joinedSeq ?? 0
  return room?.sharedFrom?.joinedSeq ?? 0
}

// Membership-window filter. Callers must have already checked roomVisibleTo.
export function linesVisibleTo(room, actor, state) {
  const from = joinedSeqOf(room, actor, state)
  return (room.log ?? []).filter(line => (line.seq ?? 0) >= from)
}

export function authorOf(line, room, state) {
  if (line?.authorId && line?.authorKind) {
    const remote = currentParticipants(room).find(p => p.remote && (p.id === line.authorId || p.handle === line.authorId))
    return {
      authorId: line.authorId,
      authorKind: line.authorKind,
      displayName: remote ? remoteBotTitle(remote) : (line.who || line.authorId),
      ownerName: remote ? ownerNameSafe(remote) : undefined,
    }
  }
  if (line?.botId) {
    return { authorId: line.botId, authorKind: 'bot', displayName: line.who || state?.bots?.[line.botId]?.name || line.botId }
  }
  if (line?.who === 'User' || line?.authorKind === 'human') {
    const humans = currentParticipants(room).filter(p => p.kind === 'human')
    const id = humans.length === 1 ? humans[0].id : Object.keys(state?.members || {})[0]
    return { authorId: id, authorKind: 'human', displayName: line.who === 'User' && humans[0]?.displayName ? humans[0].displayName : (line.who || 'User') }
  }
  return { authorId: undefined, authorKind: undefined, displayName: line?.who }
}

export function deriveParticipants(room, state) {
  if (Array.isArray(room.participants)) return room.participants
  const owners = humanOwnersOf(room, state)
  const ownerId = owners.size === 1 ? [...owners][0] : Object.keys(state.members || {})[0]
  const at = room.createdAt ?? 0
  const humans = ownerId
    ? [{ kind: 'human', id: ownerId, role: 'member', displayName: displayNameFor(state, ownerId, 'You'), joinedSeq: 0, joinedAt: at }]
    : []
  const bots = (room.members ?? []).map(id => ({
    kind: 'bot',
    id,
    role: room.admin === id ? 'admin' : 'member',
    displayName: state.bots?.[id]?.name ?? id,
    joinedSeq: 0,
    joinedAt: at,
  }))
  return [...humans, ...bots]
}

function permittedBot(state, room, botId, humans, { viaCode = false } = {}) {
  const bot = state.bots?.[botId]
  if (!bot) return false
  const owners = new Set(humans)
  for (const p of currentParticipants(room)) {
    if (p.kind === 'human') owners.add(p.id)
    else if (state.bots?.[p.id]?.ownerId) owners.add(state.bots[p.id].ownerId)
  }
  if (state.bots[botId]?.ownerId) owners.add(bot.ownerId)
  const cross = owners.size > 1
  if (cross) return (hasAnyGrant(state, botId) && humans.has(bot.ownerId)) || viaCode || mayShareRoom(state, room, botId)
  return bot.ownerId === [...owners][0]
}

export function install(rt) {
  const { state } = rt

  let roomGate = Promise.resolve()
  const withRoomLock = (fn) => {
    const run = roomGate.then(fn, fn)
    roomGate = run.then(() => {}, () => {})
    return run
  }

  const ensureLog = (room) => {
    if (typeof room.seq !== 'number') {
      room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }))
      room.seq = room.log.length
    }
    room.log ??= []
    room.seen ??= {}
  }

  const append = (room, line) => {
    ensureLog(room)
    room.seq += 1
    const stamped = { ...line, seq: room.seq }
    room.log = [...room.log, stamped].slice(-200)
    return stamped
  }

  const syncMembers = (room) => {
    room.members = currentParticipants(room).filter(p => p.kind === 'bot' && !p.remote).map(p => p.id)
    const botAdmin = currentParticipants(room).find(p => p.kind === 'bot' && !p.remote && p.role === 'admin')
    if (botAdmin) room.admin = botAdmin.id
    else if (room.admin && !room.members.includes(room.admin)) room.admin = room.members[0] ?? null
  }

  const materialize = (room) => {
    if (!Array.isArray(room.participants)) room.participants = deriveParticipants(room, state)
    return room
  }

  rt.participantsOf = room => currentParticipants(room)
  rt.roomVisibleTo = (actor, roomId) => roomVisibleTo(state, actor, roomId)
  rt.isCrossOwnerRoom = room => isCrossOwnerRoom(room, state)
  rt.isDesignatedChief = botId => isDesignatedChief(state, botId)
  rt.isSpecialist = botId => isSpecialist(state, botId)
  rt.displayNameFor = (memberId, fallback) => displayNameFor(state, memberId, fallback)
  rt.authorOf = (line, room) => authorOf(line, room, state)
  rt.linesVisibleTo = (room, actor) => linesVisibleTo(room, actor, state)
  rt.deriveParticipants = room => deriveParticipants(room, state)
  rt.humanOwnersOf = room => humanOwnersOf(room, state)
  rt.publishedRemoteOf = handle => publishedRemoteOf(state, handle)
  rt.isPublishedRemote = handle => Boolean(publishedRemoteOf(state, handle))
  rt.presentRoom = (room, actor) => presentRoom(room, actor, state)
  rt.viewerRole = (room, actor) => viewerRole(room, actor, state)

  rt.canManageParticipants = (room, actor) => {
    if (!rt.authzEnforced?.()) return true
    if (!actor) return false
    if (rt.roomOwnedBy?.(actor, room.id)) return true
    const me = participantOf(room, 'human', actor.memberId)
    return me?.role === 'admin'
  }

  rt.canRemoveParticipant = (room, ref, actor) => {
    if (rt.canManageParticipants(room, actor)) return true
    if (!actor) return false
    if (ref.kind === 'human' && ref.id === actor.memberId) return true
    if (ref.kind === 'bot') {
      const bot = participantOf(room, 'bot', ref.id || ref.handle)
      if (!bot) return false
      if (!bot.remote && state.bots?.[bot.id]?.ownerId === actor.memberId) return true
      if (bot.remote && (bot.ownerId === actor.memberId || room.sharedFrom?.ownerId === actor.memberId)) return true
    }
    return false
  }

  const fenceRemoteText = (name, text) => {
    if (!text) return text
    if (isFencedUntrusted(text)) return text
    return fenceUntrusted(name, text)
  }

  rt.authoredRoomLine = (room, line) => {
    const botId = line.botId ?? (line.authorKind === 'bot' ? line.authorId : undefined)
    const remote = botId
      ? currentParticipants(room).find(p => p.remote && (p.id === botId || p.handle === botId))
      : undefined
    const record = botId ? state.bots?.[botId] : undefined
    // Peer-controlled text stays data in every shared room, not only face-to-face
    // (#98). Origin is a remote participant, a remote-chat record in state.bots
    // (bot.remote set), a botId that is no local team Bot, or line.remote.
    const remoteLine = Boolean(remote || line.remote || (record && record.remote !== undefined) || (botId && !record))
    if (botId) {
      const name = remote ? remoteBotTitle(remote) : (line.who || record?.name || 'Bot')
      const text = remoteLine && line.text ? fenceRemoteText(name, line.text) : line.text
      return {
        ...line,
        who: name,
        text,
        authorId: botId,
        authorKind: 'bot',
        ...(remote || line.remote ? { remote: true, ownerName: remote ? ownerNameSafe(remote) : line.ownerName } : {}),
      }
    }
    if (line.authorId && line.authorKind) {
      const name = line.authorKind === 'human'
        ? ((!isPlaceholderName(line.who) ? line.who : undefined) || displayNameFor(state, line.authorId) || line.authorId)
        : (line.who || state.bots?.[line.authorId]?.name || line.authorId)
      const text = remoteLine && line.text ? fenceRemoteText(name, line.text) : line.text
      return { ...line, who: name, text }
    }
    const humans = currentParticipants(room).filter(p => p.kind === 'human')
    const id = line.authorId || (humans.length === 1 ? humans[0].id : undefined)
    const name = !isPlaceholderName(line.who) ? line.who : (id ? displayNameFor(state, id, humans[0]?.displayName) : 'User')
    return { ...line, who: name, ...(id ? { authorId: id, authorKind: 'human' } : {}) }
  }

  const REMOTE_ROOM_MESSAGE = 'Only a Bot you granted (or one that joined with the room code) may be in a room with friends\' Bots'
  const hasRemote = room => currentParticipants(room).some(isRemoteParticipant)
  // Local members that may not stay in a room with remote participants or other owners.
  const unsharable = room => currentParticipants(room).filter(p => p.kind === 'bot' && !p.remote && !mayShareRoom(state, room, p.id))

  // `viaCode` (a room-code join, #83) is an internal option: it is never read from a request body.
  function assertAddable(room, draft, actor, { viaCode = false } = {}) {
    if (!KINDS.has(draft.kind)) throw invalid('Participant kind must be human or bot')
    if (isRemoteDraft(draft)) {
      const published = publishedRemoteOf(state, draft.handle || draft.id)
      if (!published) throw forbidden('Only a Bot granted to you may join a shared room')
      if (participantOf(room, 'bot', published.handle)) throw invalid('That participant is already in the room')
      if (unsharable(room).length > 0) throw forbidden(REMOTE_ROOM_MESSAGE)
      return published
    }
    if (typeof draft.id !== 'string' || draft.id === '') throw invalid('A participant needs an id')
    if (draft.role !== undefined && !ROLES.has(draft.role)) throw invalid('Room role must be admin or member')
    if (participantOf(room, draft.kind, draft.id)) throw invalid('That participant is already in the room')
    if (draft.kind === 'human') {
      if (!state.members?.[draft.id]) throw invalid('Unknown team member')
      const humans = new Set(currentParticipants(room).filter(p => p.kind === 'human').map(p => p.id))
      humans.add(draft.id)
      if (humans.size > 1) {
        for (const p of currentParticipants(room).filter(item => item.kind === 'bot' && !item.remote)) {
          const ownerId = state.bots?.[p.id]?.ownerId
          if (!mayShareRoom(state, room, p.id) || !humans.has(ownerId)) {
            throw forbidden('Specialists stay in their owner\'s private rooms; a cross-owner room takes each side\'s Chief')
          }
        }
      }
      return
    }
    const bot = state.bots?.[draft.id]
    if (!bot) throw invalid('Unknown Bot')
    const humans = new Set(currentParticipants(room).filter(p => p.kind === 'human').map(p => p.id))
    if (actor?.memberId) humans.add(actor.memberId)
    humans.add(bot.ownerId)
    if (!permittedBot(state, room, draft.id, humans, { viaCode })) {
      if (!hasAnyGrant(state, draft.id) && !viaCode && (isCrossOwnerRoom(room, state) || humans.size > 1)) {
        throw forbidden('Specialists stay in their owner\'s private rooms; a cross-owner room takes each side\'s Chief')
      }
      throw forbidden('Only a granted Bot of a room member may join a shared room')
    }
    if (hasRemote(room) && !viaCode && !mayShareRoom(state, room, draft.id)) throw forbidden(REMOTE_ROOM_MESSAGE)
    const nextOwners = new Set(humans)
    if (nextOwners.size > 1) {
      for (const p of currentParticipants(room).filter(item => item.kind === 'bot' && !item.remote)) {
        if (!mayShareRoom(state, room, p.id)) {
          throw forbidden('Specialists stay in their owner\'s private rooms; a cross-owner room takes each side\'s Chief')
        }
      }
    }
  }

  // `opts.viaCode`: the Bot joins with the room's code (#83): it needs no person-grant, and is
  // reachable in this room only, while it is a member. Internal: request bodies cannot set it.
  rt.addRoomParticipant = function addRoomParticipant(roomId, draft, actor, opts = {}) {
    return withRoomLock(async () => {
      const room = rt.roomOf(roomId)
      if (room === undefined) throw invalid('Unknown group chat')
      materialize(room)
      if (rt.authzEnforced?.() && !rt.canManageParticipants(room, actor)) {
        throw forbidden('Only a room admin can add participants')
      }
      const kind = draft.kind
      const viaCode = opts?.viaCode === true && draft.kind === 'bot' && !isRemoteDraft(draft)
      const published = assertAddable(room, draft, actor, { viaCode })
      const role = draft.role === 'admin' ? 'admin' : 'member'
      const invitedBy = actor?.memberId
      const invitedByName = actor ? displayNameFor(state, actor.memberId, actor.displayName) : undefined
      const invitedAt = Date.now()
      let record
      if (published) {
        const handle = published.handle
        const displayName = cleanPeerName(published.name, handle)
        const line = append(room, {
          kind: 'joined',
          who: remoteBotTitle({ ...published, displayName, ownerName: published.homeName || published.owner }),
          authorId: handle,
          authorKind: 'bot',
          remote: true,
          text: '',
        })
        record = {
          kind: 'bot',
          remote: true,
          id: handle,
          handle,
          ownerHome: published.home,
          ownerName: cleanPeerName(published.homeName || published.owner || published.home, published.home),
          displayName,
          isChief: isChiefRecord(published),
          role: 'member',
          invitedBy,
          invitedByName,
          invitedAt,
          joinedSeq: line.seq,
          joinedAt: invitedAt,
        }
        room.participants.push(record)
        append(room, {
          kind: 'invited',
          who: record.ownerName,
          authorId: handle,
          authorKind: 'bot',
          text: `${remoteBotTitle(record)} was invited by ${cleanPeerName(invitedByName, 'a friend')}`,
        })
      } else {
        const id = draft.id
        const displayName = kind === 'human'
          ? displayNameFor(state, id, draft.displayName)
          : (state.bots[id]?.name ?? draft.displayName ?? id)
        const line = append(room, {
          kind: 'joined',
          who: displayName,
          authorId: id,
          authorKind: kind,
          text: '',
        })
        record = {
          kind,
          id,
          role,
          displayName,
          joinedSeq: line.seq,
          joinedAt: invitedAt,
          ...(viaCode ? { viaCode: true } : {}),
          ...(invitedBy && kind === 'bot' ? { invitedBy, invitedByName, invitedAt } : {}),
        }
        room.participants.push(record)
        if (kind === 'bot' && state.bots[id]?.ownerId && state.bots[id].ownerId !== actor?.memberId) {
          append(room, {
            kind: 'invited',
            who: displayName,
            authorId: id,
            authorKind: 'bot',
            text: `${displayName} was invited by ${cleanPeerName(invitedByName, 'a friend')}`,
          })
        }
      }
      syncMembers(room)
      await rt.save()
      if (record?.remote && record.handle) void rt.notifyRoomShare?.(room, { op: 'join', handle: record.handle })
      return room
    })
  }

  rt.removeRoomParticipant = function removeRoomParticipant(roomId, ref, actor) {
    return withRoomLock(async () => {
      const room = rt.roomOf(roomId)
      if (room === undefined) throw invalid('Unknown group chat')
      materialize(room)
      const kind = ref.kind
      const id = ref.id || ref.handle
      const me = participantOf(room, kind, id)
      if (!me) throw invalid('That participant is not in the room')
      if (rt.authzEnforced?.() && !rt.canRemoveParticipant(room, { kind, id: me.id, handle: me.handle }, actor)) {
        throw forbidden('Only a room admin can remove participants')
      }
      const live = currentParticipants(room)
      const botsLeft = live.filter(p => p.kind === 'bot' && p.id !== me.id && p.handle !== me.handle)
      const ownerLeave = actor && (
        (kind === 'human' && me.id === actor.memberId)
        || (kind === 'bot' && (state.bots?.[me.id]?.ownerId === actor.memberId || me.ownerId === actor.memberId || room.sharedFrom?.ownerId === actor.memberId))
      )
      if (kind === 'bot' && room.origin !== 'inbound-share' && room.origin !== 'face-to-face' && !me.remote && botsLeft.length < 2 && !ownerLeave) throw invalid('A group chat needs at least two Bots')
      const line = append(room, {
        kind: 'left',
        who: me.displayName,
        authorId: id,
        authorKind: kind,
        text: '',
      })
      me.leftSeq = line.seq
      me.leftAt = Date.now()
      if (kind === 'bot') {
        if (room.seen) delete room.seen[id]
        rt.dropGroupSession?.(room, id)
      }
      syncMembers(room)
      await rt.save()
      if (me.remote) void rt.notifyRoomShare?.(room, { op: 'leave', handle: me.handle || me.id })
      return room
    })
  }

  rt.postRoomMessage = function postRoomMessage(roomId, { text, authorId, authorKind, displayName } = {}, actor) {
    return withRoomLock(async () => {
      const room = rt.roomOf(roomId)
      if (room === undefined) throw invalid('Unknown group chat')
      const body = String(text ?? '').trim()
      if (body === '') throw invalid('Nothing to send')
      // Actor wins: a forged authorId in the body grants nothing.
      const implicit = (!actor && !authorId && isFaceRoom(room)) ? implicitRoomOwner(room, state) : undefined
      const kind = actor ? 'human' : (authorKind || (implicit ? 'human' : authorKind))
      const id = actor?.memberId ?? authorId ?? implicit?.memberId
      if (!kind || !id) throw forbidden('Sign in first')
      if (rt.authzEnforced?.() && actor && !roomVisibleTo(state, actor, room.id)) {
        throw forbidden('You are not a member of that room')
      }
      if (Array.isArray(room.participants) || actor) {
        materialize(room)
        const here = participantOf(room, kind, id)
        const faceOwner = isFaceRoom(room) && kind === 'human'
          && (humanOwnersOf(room, state).has(id) || Object.hasOwn(state.members || {}, id))
        if (!here && !faceOwner) throw forbidden('You are not a member of that room')
      }
      const remote = kind === 'bot' ? currentParticipants(room).find(p => p.remote && (p.id === id || p.handle === id)) : undefined
      const who = kind === 'human'
        ? (actor?.displayName || displayName || implicit?.displayName || displayNameFor(state, id) || 'You')
        : (remote ? remoteBotTitle(remote) : (state.bots?.[id]?.name ?? displayName ?? id))
      const line = append(room, rt.authoredRoomLine(room, {
        who,
        text: body,
        authorId: id,
        authorKind: kind,
        ...(kind === 'bot' ? { botId: id } : {}),
        ...(remote ? { remote: true, ownerName: ownerNameSafe(remote) } : {}),
      }))
      void rt.fanoutRoomLine?.(room, line)
      await rt.save()
      return line
    })
  }

  rt.roomHistory = function roomHistory(roomId, actor) {
    const room = rt.roomOf(roomId)
    if (room === undefined) throw invalid('Unknown group chat')
    if (rt.authzEnforced?.() && !roomVisibleTo(state, actor, room.id)) {
      throw forbidden('You are not a member of that room')
    }
    if (!rt.authzEnforced?.() && !actor) return room.log ?? []
    return linesVisibleTo(room, actor, state)
  }

  // The owner of a member Bot lets its brief — their own chat with it — ride into
  // this one room, or takes it back (#53). Bot ownership decides, not room admin;
  // the flag lives on the participant, so leaving the room drops it.
  rt.setBriefShare = function setBriefShare(roomId, botId, shared, actor) {
    const room = rt.roomOf(roomId)
    if (room === undefined) throw invalid('Unknown group chat')
    const bot = state.bots?.[String(botId ?? '')]
    if (bot === undefined || bot.remote !== undefined) throw forbidden('No such Bot')
    if (rt.authzEnforced?.() && bot.ownerId !== actor?.memberId) throw forbidden("Only the Bot's owner may share its brief")
    const entry = currentParticipants(room).find(p => p.kind === 'bot' && p.id === botId)
    if (entry === undefined) throw forbidden('That Bot is not in this room')
    if (shared) entry.briefShared = true
    else delete entry.briefShared
    return rt.save()
  }

  rt.applyParticipants = function applyParticipants(room, drafts, actor) {
    if (!Array.isArray(drafts) || drafts.length === 0) return room
    room.participants = []
    const at = room.createdAt ?? Date.now()
    for (const draft of drafts) {
      if (isRemoteDraft(draft)) {
        const published = publishedRemoteOf(state, draft.handle || draft.id)
        if (!published) throw forbidden('Only a Bot granted to you may join a shared room')
        room.participants.push({
          kind: 'bot',
          remote: true,
          id: published.handle,
          handle: published.handle,
          ownerHome: published.home,
          ownerName: cleanPeerName(published.homeName || published.owner || published.home, published.home),
          displayName: cleanPeerName(published.name, published.handle),
          isChief: isChiefRecord(published),
          role: 'member',
          invitedBy: actor?.memberId,
          invitedByName: actor ? displayNameFor(state, actor.memberId, actor.displayName) : undefined,
          invitedAt: at,
          joinedSeq: 0,
          joinedAt: at,
        })
        continue
      }
      if (!KINDS.has(draft.kind) || typeof draft.id !== 'string' || draft.id === '') {
        throw invalid('Each participant needs a kind (human or bot) and an id')
      }
      if (draft.role !== undefined && !ROLES.has(draft.role)) throw invalid('Room role must be admin or member')
      if (draft.kind === 'human' && !state.members?.[draft.id]) throw invalid('Unknown team member')
      if (draft.kind === 'bot' && !state.bots?.[draft.id]) throw invalid('Unknown Bot')
      room.participants.push({
        kind: draft.kind,
        id: draft.id,
        role: draft.role === 'admin' ? 'admin' : 'member',
        displayName: draft.kind === 'human'
          ? displayNameFor(state, draft.id, draft.displayName)
          : (state.bots[draft.id]?.name ?? draft.displayName ?? draft.id),
        joinedSeq: 0,
        joinedAt: at,
      })
    }
    if (actor?.memberId && !participantOf(room, 'human', actor.memberId)) {
      room.participants.unshift({
        kind: 'human',
        id: actor.memberId,
        role: 'admin',
        displayName: displayNameFor(state, actor.memberId, actor.displayName),
        joinedSeq: 0,
        joinedAt: at,
      })
    }
    const humans = new Set(currentParticipants(room).filter(p => p.kind === 'human').map(p => p.id))
    for (const p of currentParticipants(room).filter(p => p.kind === 'bot' && !p.remote)) {
      if (!permittedBot(state, room, p.id, humans)) {
        throw forbidden('Specialists stay in their owner\'s private rooms; a cross-owner room takes each side\'s Chief')
      }
    }
    // A room with a friend's Bot takes only granted local Bots (a room code cannot be used here).
    if (hasRemote(room) && unsharable(room).length > 0) throw forbidden(REMOTE_ROOM_MESSAGE)
    syncMembers(room)
    return room
  }

  rt.publicHumans = function publicHumans() {
    return Object.values(state.members || {}).map(member => ({
      id: member.id,
      designatedChiefId: member.designatedChiefId ?? null,
      displayName: displayNameFor(state, member.id),
    }))
  }

  function shareSpeaker(room) {
    const speakers = [room.admin, ...(room.members ?? [])].filter(id => id && rt.botOf?.(id) && mayShareRoom(state, room, id))
    return speakers[0]
  }

  function shareInviter(room) {
    const human = currentParticipants(room).find(p => p.kind === 'human')
    const from = shareSpeaker(room)
    const member = from ? state.bots?.[from]?.fields?.social?.member : undefined
    return {
      inviterName: human?.displayName || displayNameFor(state, human?.id, 'a friend'),
      inviterHome: member?.home || human?.ownerHome,
      inviterHandle: member?.handle,
    }
  }

  async function sendShareTo(room, remote, payload, via) {
    const from = shareSpeaker(room)
    if (!from || !rt.flybotSend) return
    try {
      await rt.flybotSend({
        from,
        to: remote.handle || remote.id,
        text: encodeRoomShare(payload),
        role: 'request',
        via,
        meta: { roomId: room.id, seq: payload.seq, share: payload.op },
      })
    } catch (error) {
      rt.warn?.('ds-bot: room share not sent to %s: %s', remote.handle || remote.id, error)
    }
  }

  // Membership notice: the add/remove click is the owner's consent, so this does not wait
  // for a chat line. Bot Social is 1:1; the envelope is the group record the other FlyBot sees.
  rt.notifyRoomShare = async function notifyRoomShare(room, { op = 'join', handle } = {}) {
    if (!room || isFaceRoom(room) || room.origin === 'inbound-share') return
    const wanted = handle ? String(handle) : undefined
    const remotes = (op === 'leave' ? (room.participants ?? []) : currentParticipants(room))
      .filter(p => isRemoteParticipant(p) && (!wanted || p.handle === wanted || p.id === wanted))
    if (remotes.length === 0) return
    const from = shareInviter(room)
    for (const remote of remotes) {
      if (op !== 'leave' && !publishedRemoteOf(state, remote.handle)) continue
      await sendShareTo(room, remote, {
        op,
        roomId: room.id,
        name: room.name,
        invitedHandle: remote.handle,
        seq: room.seq ?? 0,
        ...from,
      }, 'room-share')
    }
  }

  // Room lines go out to the friends' Bots in the room, checked per author and per recipient
  // (#51): a line written by a local Bot that may not share the room never leaves, a friend's
  // Bot that is no longer granted to us gets nothing, and the sending Bot is one that may
  // speak outside (bot.send then runs the reach policy on every single send).
  rt.fanoutRoomLine = async function fanoutRoomLine(room, line) {
    if (isFaceRoom(room)) {
      try { await rt.faceRoomFanout?.(room, line) } catch (error) {
        rt.warn?.('ds-bot: face-room line not sent: %s', error)
      }
      return
    }
    const remotes = currentParticipants(room).filter(isRemoteParticipant)
    if (remotes.length === 0 || !rt.flybotSend) return
    const localAuthor = line.authorKind === 'bot' && !line.remote && rt.botOf?.(line.authorId ?? line.botId) ? (line.authorId ?? line.botId) : undefined
    if (localAuthor !== undefined && !mayShareRoom(state, room, localAuthor)) return
    if (!shareSpeaker(room)) return
    const who = cleanName(line.who || 'member')
    const body = !line.text
      ? `[${cleanName(line.kind || 'event')}]`
      : isFencedUntrusted(line.text) ? line.text : fenceUntrusted(who, line.text)
    const from = shareInviter(room)
    for (const remote of remotes) {
      if (line.authorId === remote.id || line.authorId === remote.handle) continue
      if (!publishedRemoteOf(state, remote.handle)) continue
      await sendShareTo(room, remote, {
        op: 'line',
        roomId: room.id,
        name: room.name,
        invitedHandle: remote.handle,
        seq: line.seq,
        who,
        kind: line.kind || 'message',
        authorKind: line.authorKind,
        authorId: line.authorId,
        text: `${who}: ${body}`,
        ...from,
      }, 'room')
    }
  }

  // A Bot that no longer qualifies (grant revoked, owner removed) leaves every room
  // that has friends' Bots or more than one owner, at once; without an id, every such Bot does.
  rt.evictUnshared = async function evictUnshared(botId) {
    let changed = false
    for (const room of Object.values(state.rooms ?? {})) {
      if (!Array.isArray(room.participants) || !(hasRemote(room) || isCrossOwnerRoom(room, state))) continue
      for (const me of currentParticipants(room).filter(p => p.kind === 'bot' && !p.remote && (botId === undefined || p.id === botId))) {
        if (mayShareRoom(state, room, me.id)) continue
        await withRoomLock(async () => {
          if (me.leftSeq !== undefined) return
          const line = append(room, { kind: 'left', who: me.displayName, authorId: me.id, authorKind: 'bot', text: '' })
          me.leftSeq = line.seq
          me.leftAt = Date.now()
          if (room.seen) delete room.seen[me.id]
          rt.dropGroupSession?.(room, me.id)
          syncMembers(room)
          changed = true
        })
      }
    }
    if (changed) await rt.save()
  }

  rt.ingestRemoteRoomLine = async function ingestRemoteRoomLine({ handle, text, name, home } = {}) {
    const id = String(handle ?? '')
    if (!id) return
    const body = String(text ?? '')
    if (parseRoomShare(body)) {
      await rt.applyInboundRoomShare({ fromHandle: id, fromHome: home, fromName: name, text: body })
      return
    }
    for (const room of Object.values(state.rooms || {})) {
      if (room.origin === 'inbound-share' || isFaceRoom(room)) continue
      const remote = currentParticipants(room).find(p => p.remote && (p.handle === id || p.id === id))
      if (!remote) continue
      append(room, rt.authoredRoomLine(room, {
        who: remoteBotTitle(remote),
        text: body,
        authorId: remote.handle,
        authorKind: 'bot',
        botId: remote.handle,
        remote: true,
        ownerName: ownerNameSafe(remote),
      }))
    }
    await rt.save()
  }

  function inboundOf(remoteRoomId, inviterHome, inviterHandle) {
    return Object.values(state.rooms || {}).find((room) => {
      if (room.origin !== 'inbound-share') return false
      if (String(room.sharedFrom?.remoteRoomId) !== String(remoteRoomId)) return false
      const home = room.sharedFrom?.inviterHome
      const from = room.sharedFrom?.inviterHandle
      if (inviterHome && home && home === inviterHome) return true
      if (inviterHandle && from && from === inviterHandle) return true
      return !home && !from
    })
  }

  function markInboundLeft(room) {
    const at = Date.now()
    const line = append(room, { kind: 'left', who: room.sharedFrom?.inviterName || 'the room', authorKind: 'bot', text: '' })
    for (const p of currentParticipants(room)) {
      p.leftSeq = line.seq
      p.leftAt = at
    }
    room.hidden = true
    syncMembers(room)
    return room
  }

  rt.leaveInboundShares = async function leaveInboundShares({ localBotId, handle, grantee } = {}) {
    let changed = false
    const botKey = localBotId ? String(localBotId) : ''
    const invited = handle ? String(handle) : ''
    const peer = grantee ? String(grantee) : ''
    for (const room of Object.values(state.rooms || {})) {
      if (room.origin !== 'inbound-share' || room.hidden) continue
      const from = room.sharedFrom ?? {}
      const botHit = botKey && (from.localBotId === botKey || (room.members ?? []).includes(botKey))
      const handleHit = invited && (from.invitedHandle === invited)
      if (!botHit && !handleHit) continue
      if (peer && (from.inviterHome || from.inviterHandle) && from.inviterHome !== peer && from.inviterHandle !== peer) continue
      markInboundLeft(room)
      changed = true
    }
    if (changed) await rt.save?.()
  }

  rt.applyInboundRoomShare = async function applyInboundRoomShare(event = {}, actor) {
    const data = parseRoomShare(event.text)
    if (!data) return undefined
    const fromHandle = event.fromHandle || data.inviterHandle
    const fromHome = event.fromHome || data.inviterHome
    const fromName = cleanPeerName(event.fromName || data.inviterName, 'a friend')
    const localBotId = event.localBotId && state.bots?.[event.localBotId] ? event.localBotId : undefined
    const ownerId = actor?.memberId ?? event.ownerId ?? Object.keys(state.members || {})[0]
    let room = inboundOf(data.roomId, fromHome, fromHandle)
    if (data.op === 'leave') {
      if (!room) return { handled: true, room: undefined }
      markInboundLeft(room)
      await rt.save?.()
      return { handled: true, room }
    }
    if (!room) {
      room = await rt.recordInboundSharedRoom({
        name: data.name,
        inviterName: fromName,
        inviterHome: fromHome,
        inviterHandle: fromHandle,
        invitedHandle: data.invitedHandle,
        localBotId,
        ownerId,
        remoteRoomId: data.roomId,
        joinedSeq: data.seq,
      }, actor || (ownerId ? { memberId: ownerId } : undefined))
    } else {
      delete room.hidden
      for (const p of room.participants ?? []) {
        if (p.leftSeq !== undefined) {
          delete p.leftSeq
          delete p.leftAt
        }
      }
      if (data.name) room.name = cleanPeerName(data.name, room.name)
      room.sharedFrom = {
        ...room.sharedFrom,
        inviterName: fromName,
        inviterHome: fromHome || room.sharedFrom?.inviterHome,
        inviterHandle: fromHandle || room.sharedFrom?.inviterHandle,
        invitedHandle: data.invitedHandle || room.sharedFrom?.invitedHandle,
        remoteRoomId: data.roomId,
      }
      syncMembers(room)
    }
    if (data.op === 'line') {
      const who = cleanPeerName(data.who || fromName, fromName)
      append(room, rt.authoredRoomLine(room, {
        who,
        text: data.text || '',
        authorId: data.authorId || fromHandle,
        authorKind: data.authorKind || 'human',
        remote: true,
        ...(data.authorKind === 'bot' ? { botId: data.authorId || fromHandle } : {}),
        kind: data.kind === 'message' ? undefined : data.kind,
      }))
    }
    await rt.save?.()
    return { handled: true, room }
  }

  rt.recordInboundSharedRoom = async function recordInboundSharedRoom(draft = {}, actor) {
    const ownerId = actor?.memberId ?? draft.ownerId ?? Object.keys(state.members || {})[0]
    if (!ownerId) throw invalid('Sign in first')
    const handle = draft.invitedHandle || draft.handle
    const localBotId = draft.localBotId && state.bots?.[draft.localBotId] ? draft.localBotId : undefined
    const at = Date.now()
    const inviterName = cleanPeerName(draft.inviterName, 'a friend')
    const title = cleanPeerName(draft.name, sharedRoomTitle(inviterName))
    const id = draft.id || (typeof rt.createSession === 'function' ? await rt.createSession(title) : `inbound-${at.toString(36)}`)
    if (state.rooms[id]?.origin === 'inbound-share') return state.rooms[id]
    const room = {
      id,
      name: title,
      origin: 'inbound-share',
      members: localBotId ? [localBotId] : [],
      admin: localBotId ?? null,
      named: Boolean(draft.name),
      createdAt: at,
      createdBy: null,
      log: Array.isArray(draft.log) ? draft.log : [],
      seq: Array.isArray(draft.log) ? draft.log.length : 0,
      seen: {},
      sharedFrom: {
        inviterName,
        inviterHome: draft.inviterHome,
        inviterHandle: draft.inviterHandle,
        invitedHandle: handle,
        invitedAt: draft.invitedAt ?? at,
        ownerId,
        localBotId,
        remoteRoomId: draft.remoteRoomId,
        joinedSeq: draft.joinedSeq ?? 0,
      },
      inviteNotice: true,
      participants: [
        ...(localBotId ? [{
          kind: 'bot',
          id: localBotId,
          role: 'member',
          displayName: state.bots[localBotId].name,
          joinedSeq: draft.joinedSeq ?? 0,
          joinedAt: draft.invitedAt ?? at,
          invitedByName: inviterName,
          invitedAt: draft.invitedAt ?? at,
        }] : handle ? [{
          kind: 'bot',
          remote: true,
          id: handle,
          handle,
          ownerHome: draft.inviterHome,
          ownerName: inviterName,
          displayName: cleanPeerName(draft.botName, handle),
          role: 'member',
          joinedSeq: draft.joinedSeq ?? 0,
          joinedAt: draft.invitedAt ?? at,
          invitedByName: inviterName,
          invitedAt: draft.invitedAt ?? at,
          ownerId,
        }] : []),
      ],
    }
    state.rooms[id] = room
    await rt.save?.()
    return room
  }

  function faceHandleOf(p) {
    if (p?.remote) return p.handle || p.id
    const bot = state.bots?.[p?.id]
    return bot?.fields?.social?.member?.handle || p?.handle
  }

  function faceLookFields(member) {
    const out = {}
    if (typeof member?.color === 'string' && member.color.trim()) out.color = member.color.trim().slice(0, 32)
    if (member?.avatar && typeof member.avatar === 'object') out.avatar = member.avatar
    return out
  }

  function faceRemoteRecord(member, joinedSeq, at) {
    const handle = String(member.handle || member.id || '')
    const displayName = cleanPeerName(member.displayName || member.name, handle)
    const ownerName = cleanPeerName(member.ownerName || member.ownerHome, '')
    const label = cleanPeerName(member.label, '')
    return {
      kind: 'bot',
      remote: true,
      id: handle,
      handle,
      ownerHome: member.ownerHome,
      ownerName,
      displayName,
      ...(label ? { label } : {}),
      // Face-to-face: the matching room is the scope. No person-grant is implied.
      roomOnly: member.roomOnly === true || member.published !== true,
      role: 'member',
      joinedSeq,
      joinedAt: at,
      ...faceLookFields(member),
    }
  }

  function faceLocalRecord(bot, joinedSeq, at, member) {
    const label = cleanPeerName(member?.label, '')
    return {
      kind: 'bot',
      id: bot.id,
      role: 'member',
      displayName: bot.name ?? bot.id,
      handle: bot.handle,
      ownerName: cleanPeerName(member?.ownerName, ''),
      ...(label ? { label } : {}),
      joinedSeq,
      joinedAt: at,
    }
  }

  function faceSameBot(p, { local, handle }) {
    if (local) return p.kind === 'bot' && !p.remote && p.id === local.id
    return p.remote && (p.handle === handle || p.id === handle)
  }

  function faceLiveKey(p, byHandle) {
    const key = p.remote
      ? (p.handle || p.id)
      : (byHandle.get(String(p.handle || '').toLowerCase())?.handle || faceHandleOf(p) || p.id)
    return String(key || '').toLowerCase()
  }

  function applyFaceMemberFields(existing, member) {
    if (existing.remote) {
      existing.displayName = cleanPeerName(member.displayName || member.name, existing.displayName)
      existing.ownerName = cleanPeerName(member.ownerName, existing.ownerName)
      existing.roomOnly = member.roomOnly === true || member.published !== true
      const label = cleanPeerName(member.label, '')
      if (label) existing.label = label
      const look = faceLookFields(member)
      if (look.color) existing.color = look.color
      if (look.avatar) existing.avatar = look.avatar
    } else {
      if (member.ownerName) existing.ownerName = cleanPeerName(member.ownerName, existing.ownerName)
      const label = cleanPeerName(member.label, '')
      if (label) existing.label = label
    }
  }

  rt.syncFaceParticipants = function syncFaceParticipants(room, members, localBots = []) {
    materialize(room)
    const at = Date.now()
    const seq = room.seq ?? 0
    const byHandle = new Map()
    for (const bot of localBots) {
      if (bot?.handle) byHandle.set(String(bot.handle).toLowerCase(), bot)
    }
    const liveKeys = new Set()
    for (const member of members ?? []) {
      const handle = String(member.handle || member.id || '')
      if (!handle) continue
      liveKeys.add(handle.toLowerCase())
      const local = byHandle.get(handle.toLowerCase())
      const matches = (room.participants ?? []).filter(p => faceSameBot(p, { local, handle }))
      const existing = matches.find(p => p.leftSeq === undefined) || matches.at(-1)
      if (existing) {
        if (existing.leftSeq !== undefined) {
          delete existing.leftSeq
          delete existing.leftAt
          existing.joinedSeq = seq
          existing.joinedAt = at
        }
        applyFaceMemberFields(existing, member)
        continue
      }
      const record = local
        ? faceLocalRecord(local, seq, at, member)
        : faceRemoteRecord(member, seq, at)
      room.participants.push(record)
    }
    const seenLive = new Set()
    for (const p of currentParticipants(room)) {
      const match = faceLiveKey(p, byHandle)
      const still = [...liveKeys].some(h => h === match || h === String(p.id).toLowerCase() || (p.handle && h === String(p.handle).toLowerCase()))
      if (!still || (match && seenLive.has(match))) {
        p.leftSeq = seq
        p.leftAt = at
        continue
      }
      if (match) seenLive.add(match)
    }
    syncMembers(room)
    return room
  }

  const faceRoomFallbackTitle = (spec, room) => formatFaceRoomTitle({
    name: spec.name || room?.name,
    // Everyone who was in the room, so the title reads the same on every home and does not
    // lose a member who left (#182). The time is the start, never the joining deadline.
    members: [...(spec.members ?? []), ...(room?.participants ?? [])],
    code: spec.joinCode || spec.code,
    at: faceRoomCreatedAt({ createdAt: spec.createdAt, expiresAt: spec.expiresAt || room?.face?.expiresAt, startedAt: spec.startedAt || room?.face?.startedAt }) || room?.createdAt,
  })

  rt.upsertFaceRoom = async function upsertFaceRoom(spec = {}) {
    const serverId = String(spec.roomId || spec.faceRoomId || '')
    if (!serverId) throw invalid('A face-to-face room needs a room id')
    let room = Object.values(state.rooms || {}).find(item => item.face?.roomId === serverId)
    const title = faceRoomFallbackTitle(spec, room)
    const at = Date.now()
    if (!room) {
      const id = spec.localId || (typeof rt.createSession === 'function' ? await rt.createSession(title) : `face-${serverId}`)
      room = {
        id,
        name: title,
        named: true,
        origin: 'face-to-face',
        members: [],
        admin: null,
        mode: 'everyone',
        createdAt: at,
        createdBy: null,
        log: [],
        seq: 0,
        seen: {},
        participants: [],
        face: { roomId: serverId, status: faceStatusFrom(spec, 'candidate'), expiresAt: spec.expiresAt || null, eventCursor: 0, seenEvents: [] },
      }
      state.rooms[id] = room
    }
    room.face = {
      roomId: serverId,
      status: faceStatusFrom(spec, room.face?.status),
      expiresAt: spec.expiresAt ?? room.face.expiresAt ?? null,
      startedAt: spec.startedAt ?? room.face.startedAt ?? null,
      eventCursor: Math.max(Number(room.face.eventCursor) || 0, Number(spec.eventCursor) || 0),
      seenEvents: Array.isArray(room.face.seenEvents) ? room.face.seenEvents : [],
    }
    if (spec.name || isAutoFaceTitle(room.name)) room.name = title
    if (Array.isArray(spec.members)) rt.syncFaceParticipants(room, spec.members, spec.localBots)
    await rt.save?.()
    return room
  }

  rt.applyFaceRoomLine = function applyFaceRoomLine(room, line) {
    materialize(room)
    const eventId = line?.eventId
    room.face ??= { seenEvents: [] }
    room.face.seenEvents ??= []
    if (eventId && room.face.seenEvents.includes(eventId)) return undefined
    if (eventId) {
      room.face.seenEvents.push(eventId)
      if (room.face.seenEvents.length > 200) room.face.seenEvents = room.face.seenEvents.slice(-200)
    }
    if (line?.eventCursor) room.face.eventCursor = Math.max(Number(room.face.eventCursor) || 0, Number(line.eventCursor) || 0)
    const drafted = {
      kind: line.kind,
      who: line.who,
      text: line.text ?? '',
      authorId: line.authorId,
      authorKind: line.authorKind,
      ...(line.remote ? { remote: true, ownerName: line.ownerName, ...(line.authorKind === 'bot' ? { botId: line.authorId } : {}) } : {}),
      ...(line.eventId ? { eventId: line.eventId } : {}),
    }
    const stamped = append(room, (line.kind && line.kind !== 'message') ? drafted : rt.authoredRoomLine(room, drafted))
    return stamped
  }

  rt.dropFaceRoom = async function dropFaceRoom(roomId) {
    const room = rt.roomOf(roomId)
    if (!room || !isFaceRoom(room)) return false
    if (typeof rt.deleteRoom === 'function') await rt.deleteRoom(roomId)
    else delete state.rooms[roomId]
    return true
  }

  return rt
}
