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

import { randomBytes } from 'node:crypto'
import { cleanPeerName, disambiguatedRemoteTitle, isChiefRecord, remoteBotTitle, sharedRoomTitle } from '../shared/remote-label.js'
import { formatFaceRoomTitle, isAutoFaceTitle, faceRoomCreatedAt } from '../shared/face-title.js'
import { encodeRoomShare, parseRoomInviteLink, parseRoomShare, roomInviteUrl } from '../shared/room-share.js'
import { cleanFaceLead, cleanRoleLabel, faceLeadOf } from './face-lead.js'
import { cleanName, fenceUntrusted, isFencedUntrusted, unwrapUntrusted } from './delivery.js'
import { hasAnyGrant, mayShareRoom } from './reach.js'
import { mentionSpans } from '../shared/mentions.js'

const KINDS = new Set(['human', 'bot'])
const ROLES = new Set(['admin', 'member'])
// Held face-room lines kept per room (#456): the newest, so a long room cannot grow its record forever.
const HELD_LINES_KEPT = 50
// #825: a Bot's answer opens at most this many further answers in a shared room, unless the room
// stores its own `maxHops`. A person's line is hop 0, so 3 lets the Bots answer each other twice.
const DEFAULT_MAX_HOPS = 3
// Answers already started in a projected room, keyed `(remoteRoomId, seq, botId)`, so a line delivered
// twice (#641) does not open a second turn.
const ANSWERED_KEPT = 200

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
      // Every face-to-face Bot is `<Bot> (<owner>)` (#384), including the viewer's own Bot.
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
    const stamped = { ...(rt.stampHop?.(room, line) ?? line), seq: room.seq }
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

  const maxHopsOf = room => (Number.isFinite(Number(room?.maxHops)) ? Number(room.maxHops) : DEFAULT_MAX_HOPS)

  // #825: which friends' Bots a line calls, by the one "@" rule the rest of the host uses — over each
  // remote participant's handle and the name it is shown as. Fenced and quoted text is literal, so a
  // handle inside a block never starts a turn.
  const callsIn = (room, text) => {
    const said = String(text ?? '')
    if (!said.includes('@')) return []
    const names = []
    for (const peer of currentParticipants(room).filter(isRemoteParticipant)) {
      const handle = peer.handle ?? peer.id
      for (const name of [String(handle).replace(/^@+/, ''), peer.displayName, peer.label]) {
        if (name) names.push({ name: String(name), handle })
      }
    }
    if (names.length === 0) return []
    const found = new Set()
    for (const span of mentionSpans(said, names)) if (span.bot) found.add(span.bot.handle)
    return [...found]
  }

  // A line's `calls` are handles; the projected room answers with the local Bot behind the handle it
  // was invited as. Anything else in the list is another home's business.
  const localCalls = (room, calls) => {
    if (!Array.isArray(calls) || calls.length === 0) return []
    const wanted = new Set(calls.map(handle => String(handle ?? '').replace(/^@+/, '').toLowerCase()).filter(Boolean))
    const out = []
    // The projected room's local Bot is the one the invite was addressed to: that handle is how the
    // other home knows it, even when the local record carries no social handle of its own.
    const invited = String(room.sharedFrom?.invitedHandle ?? '').replace(/^@+/, '').toLowerCase()
    if (invited && wanted.has(invited)) {
      const own = room.sharedFrom?.localBotId ?? currentParticipants(room).find(peer => peer.kind === 'bot' && !peer.remote)?.id
      if (own) out.push(own)
    }
    for (const peer of currentParticipants(room)) {
      if (peer.kind !== 'bot' || peer.remote) continue
      const record = state.bots?.[peer.id]
      const handles = [peer.handle, peer.id, record?.fields?.social?.member?.handle, record?.name]
        .filter(Boolean).map(value => String(value).replace(/^@+/, '').toLowerCase())
      if (handles.some(handle => wanted.has(handle)) && !out.includes(peer.id)) out.push(peer.id)
    }
    return out
  }

  // Hop accounting (#825): a person's line is 0 and every Bot answer is one more than the newest line
  // the room received. A friend's line carries its own number, which also raises the room's cap count.
  rt.stampHop = (room, line) => {
    if (!line || typeof line !== 'object') return line
    const inbound = Number(line.hop)
    if (Number.isFinite(inbound) && inbound > (Number(room.hop) || 0)) room.hop = inbound
    if (line.hop !== undefined || line.remote === true || line.authorKind !== 'bot') return line
    if (line.kind && line.kind !== 'message') return line
    return { ...line, hop: (Number(room.hop) || 0) + 1 }
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

  const hasRemote = room => currentParticipants(room).some(isRemoteParticipant)
  // Local members that may not stay in a room with remote participants or other owners.
  const unsharable = room => currentParticipants(room).filter(p => p.kind === 'bot' && !p.remote && !mayShareRoom(state, room, p.id))

  // Why a friend's Bot and a local Bot with no grant to that friend cannot share a group.
  // A group with a friend's Bot is projected to the friend's home: its lines, and the replies of
  // every local Bot that may speak there, are sent on (fanoutRoomLine). Only a Bot the owner
  // shared with that friend (a per-Bot grant, or a room-code join) may be in it; the grant is made
  // by the friend accepting an invite to that Bot, so this refusal names the Bot, the friend and the
  // two ways out instead of a bare rule. `details` is for the client (an invite button), not trusted input.
  function ungrantedRefusal(room, bots, extraRemote) {
    const remotes = [
      ...currentParticipants(room).filter(isRemoteParticipant).map(p => ({ handle: p.handle || p.id, name: cleanPeerName(p.displayName, p.handle || p.id), owner: ownerNameSafe(p) })),
      ...(extraRemote ? [{ handle: extraRemote.handle, name: cleanPeerName(extraRemote.name, extraRemote.handle), owner: cleanPeerName(extraRemote.homeName || extraRemote.owner || extraRemote.home, '') }] : []),
    ].filter((p, i, all) => all.findIndex(other => other.handle === p.handle) === i)
    const localBots = bots.map(id => ({ id, name: state.bots?.[id]?.name ?? id }))
    const names = localBots.map(bot => bot.name).join(', ')
    const friends = [...new Set(remotes.map(p => p.owner || p.name))].join(', ') || 'a friend'
    const many = localBots.length > 1
    const message = `${names} ${many ? 'are' : 'is'} not shared with ${friends}, so ${many ? 'they' : 'it'} cannot be in a group with their Bot: the group's messages go to ${friends}'s home. Share ${many ? 'them' : 'it'} with ${friends} (Bot settings → Sharing → Copy invite link for ${names}), or leave ${many ? 'them' : 'it'} out.`
    return Object.assign(forbidden(message), { details: { reason: 'ungranted-local', bots: localBots, remotes } })
  }

  // `viaCode` (a room-code join, #83) is an internal option: it is never read from a request body.
  function assertAddable(room, draft, actor, { viaCode = false } = {}) {
    if (!KINDS.has(draft.kind)) throw invalid('Participant kind must be human or bot')
    if (isRemoteDraft(draft)) {
      const published = publishedRemoteOf(state, draft.handle || draft.id)
      if (!published) throw forbidden('Only a Bot granted to you may join a shared room')
      if (participantOf(room, 'bot', published.handle)) throw invalid('That participant is already in the room')
      const blocked = unsharable(room)
      if (blocked.length > 0) throw ungrantedRefusal(room, blocked.map(p => p.id), published)
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
    if (hasRemote(room) && !viaCode && !mayShareRoom(state, room, draft.id)) throw ungrantedRefusal(room, [draft.id])
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
      if (me.remote) {
        void Promise.resolve(rt.notifyRoomShare?.(room, { op: 'leave', handle: me.handle || me.id }))
          .then(() => (isTicketSeat(me) ? settleTicket(room, me.ticket, me) : undefined))
          .catch(error => rt.warn?.('ds-bot: a seat\'s leave was not settled: %s', error))
      } else if (kind === 'bot' && room.origin === 'inbound-share' && room.sharedFrom?.ticket) {
        void leaveTicketRoom(room, me).catch(error => rt.warn?.('ds-bot: leaving %s was not sent: %s', room.name, error))
      }
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
    if (hasRemote(room)) {
      const blocked = unsharable(room)
      if (blocked.length > 0) throw ungrantedRefusal(room, blocked.map(p => p.id))
    }
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

  // Who invited the friend's Bot (#848). A group made from the sidebar has no human participant, so
  // the human lookup alone always said `a friend`; the owner-level name and home the social plugin
  // stores on the Bot's member record name that person instead. An inbound projection forwards the
  // inviter of the room it mirrors, never this home's owner.
  function shareInviter(room) {
    const original = room?.origin === 'inbound-share' ? room.sharedFrom : undefined
    if (original?.inviterName) {
      return {
        inviterName: original.inviterName,
        inviterHome: original.inviterHome,
        inviterHandle: original.inviterHandle,
      }
    }
    const human = currentParticipants(room).find(p => p.kind === 'human')
    const from = shareSpeaker(room)
    const member = from ? state.bots?.[from]?.fields?.social?.member : undefined
    const ownerId = from ? state.bots?.[from]?.ownerId : undefined
    // "You" is this home's own label for its owner, so the far side would read itself in it.
    const humanName = human?.displayName && human.displayName !== 'You' ? human.displayName : undefined
    return {
      inviterName: humanName || member?.ownerName || displayNameFor(state, ownerId, 'a friend'),
      inviterHome: member?.home || human?.ownerHome,
      inviterHandle: member?.handle,
    }
  }

  // A line as written, for a link's seat (#884): the far home fences it once with `who`, so a fence
  // stored here is opened first, never nested (a nested one reads as markup to the person).
  // Who a person's own line is said by on a link's seat: a name they gave stays; this home's own
  // placeholder (`You`, or the bare member id) becomes the owner's Bot Social name.
  const seatSayer = (line, who, botId) => {
    if (line.authorKind !== 'human' || line.remote === true) return who
    if (who !== 'You' && who !== cleanName(String(line.authorId ?? ''))) return who
    return cleanPeerName(state.bots?.[botId]?.fields?.social?.member?.ownerName, who)
  }
  const seatText = line => (!line.text ? `[${cleanName(line.kind || 'event')}]` : isFencedUntrusted(line.text) ? unwrapUntrusted(line.text) : String(line.text))

  // #884: a seat a ticket admitted is reached from the Bot its link named, under that room's scope only,
  // and is told about the room by that Bot.
  const isTicketSeat = p => p?.remote === true && p.admittedBy === 'ticket'
  function seatSender(room, seat) {
    const botId = seat.hostBotId && rt.botOf?.(seat.hostBotId) && room.members?.includes(seat.hostBotId) ? seat.hostBotId : undefined
    if (!botId) return undefined
    const member = state.bots?.[botId]?.fields?.social?.member
    return { botId, from: { ...shareInviter(room), inviterHandle: member?.handle, ...(member?.home ? { inviterHome: member.home } : {}) } }
  }

  async function sendShareTo(room, remote, payload, via, sender, scope) {
    const from = sender ?? shareSpeaker(room)
    if (!from || !rt.flybotSend) return undefined
    try {
      // The answer says whether the send went out, is held for the owner, or was refused (#825 D):
      // a held or refused reply has to become one line in the room instead of nothing.
      return await rt.flybotSend({
        from,
        to: remote.handle || remote.id,
        text: encodeRoomShare(payload),
        role: 'request',
        via,
        meta: { roomId: room.id, seq: payload.seq, share: payload.op, ...(scope ? { scope } : {}) },
      })
    } catch (error) {
      rt.warn?.('ds-bot: room share not sent to %s: %s', remote.handle || remote.id, error)
      return undefined
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
      if (isTicketSeat(remote)) {
        const seat = seatSender(room, remote)
        if (!seat) continue
        await sendShareTo(room, remote, {
          op,
          roomId: room.id,
          name: room.name,
          invitedHandle: remote.handle,
          seq: room.seq ?? 0,
          ticket: remote.ticket,
          ...seat.from,
        }, 'room-share', seat.botId, room.id)
        continue
      }
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

  // #852, #878, #884: the link invitations for a room that lives here. A room keeps a list of tickets
  // (several may be live at once, one per person invited); the link is never authority on its own —
  // every knock and every accept is read back against this list, and a ticket stops answering the
  // moment it is withdrawn, expires, or the room is gone. Ten minutes, like the face-room window.
  //
  // A ticket Bot Social minted (`server: true`, when the server offers `local_room_invites`) can seat a
  // stranger: the server records which home claimed it with which Bots and gives exactly those Bots
  // reach to the inviter's Bot for this room id, nothing else. Seats it admits are `admittedBy: 'ticket'`:
  // not published friends, nothing in the sidebar, the room's join/line traffic only, from the Bot the
  // link named. A ticket minted here alone (an older server) still works for a friend whose Bot can
  // already be reached, as before.
  const ROOM_INVITE_ORIGIN = 'https://social.botawaken.com'
  const LOCAL_INVITES_KEPT = 20
  const TICKET_SEATS_MAX = 8
  const TICKET_SHAPE = /^[A-Za-z0-9_-]{16,64}$/

  // The list, with a record written before it existed (one `localInvite`) moved in once.
  function invitesOf(room) {
    if (!room) return []
    if (room.localInvite && typeof room.localInvite === 'object') {
      room.localInvites = [...(Array.isArray(room.localInvites) ? room.localInvites : []), room.localInvite]
      delete room.localInvite
    }
    if (!Array.isArray(room.localInvites)) return []
    return room.localInvites.filter(invite => invite && typeof invite.ticket === 'string' && invite.ticket)
  }
  // A link has no deadline now (owner decision, 2026-10-24): it lives until it is withdrawn. A link
  // minted with one before that, or one Bot Social still dates, keeps its deadline.
  const unexpired = (invite, at = Date.now()) => Boolean(invite) && (invite.expiresAt == null || Number(invite.expiresAt) > at)
  // A link a new person can still use: not withdrawn and not out of date. A link admits anyone it is
  // given to (owner decision, 2026-10-24), so a home that joined does not close it.
  const openInvite = (invite, at = Date.now()) => unexpired(invite, at) && !invite.withdrawnAt
  // The homes a link seated, `{ [home]: [seat handles] }`; a record from before keeps its one `acceptedBy`.
  const homesOf = (invite) => {
    const homes = invite?.homes && typeof invite.homes === 'object' ? { ...invite.homes } : {}
    if (typeof invite?.acceptedBy === 'string' && invite.acceptedBy && !homes[invite.acceptedBy]) homes[invite.acceptedBy] = [...(invite.seats ?? [invite.acceptedBy])]
    return homes
  }
  const seatedBy = invite => Object.keys(homesOf(invite)).length > 0

  function inviteView(invite) {
    const origin = rt.roomInviteOrigin || ROOM_INVITE_ORIGIN
    return {
      ticket: invite.ticket,
      handle: invite.handle,
      expiresAt: invite.expiresAt == null ? null : Number(invite.expiresAt),
      url: invite.url || roomInviteUrl(invite.handle, invite.ticket, origin),
      ...(invite.server === true ? { server: true } : {}),
      ...(seatedBy(invite) ? { joined: Object.keys(homesOf(invite)).length } : {}),
      ...(invite.withdrawnAt ? { withdrawn: true } : {}),
    }
  }

  // Every link of the room a new person can still use, oldest first; the newest is the one to show.
  rt.localInvitesOf = function localInvitesOf(roomId) {
    return invitesOf(rt.roomOf(roomId)).filter(invite => openInvite(invite)).map(inviteView)
  }
  rt.localInviteOf = function localInviteOf(roomId) {
    return rt.localInvitesOf(roomId).at(-1)
  }

  rt.roomOfLocalInvite = function roomOfLocalInvite(ticket) {
    const wanted = String(ticket ?? '')
    if (!wanted) return undefined
    for (const room of Object.values(state.rooms || {})) {
      const invite = invitesOf(room).find(item => item.ticket === wanted)
      if (!invite) continue
      // An expired or withdrawn ticket resolves nothing: the room record is the authority, and a dead
      // link must not be able to open a room through the accept path.
      return openInvite(invite) ? room : undefined
    }
    return undefined
  }

  const memberHandleOf = botId => {
    const handle = state.bots?.[botId]?.fields?.social?.member?.handle
    return typeof handle === 'string' && handle.startsWith('@') ? handle : undefined
  }
  // The Bot the link knocks on: the room's lead when it has a Bot Social identity, else the first
  // member that has one. A stranger's seat talks to this Bot, and to no other of this home.
  function inviteBotOf(room) {
    const ids = [room.admin, ...(room.members ?? [])].filter((id, i, all) => id && all.indexOf(id) === i && rt.botOf?.(id))
    const shareable = ids.find(id => memberHandleOf(id) && mayShareRoom(state, room, id))
    return shareable ?? ids.find(id => memberHandleOf(id))
  }

  rt.mintRoomInvite = async function mintRoomInvite(roomId, actor) {
    const room = rt.roomOf(roomId)
    if (room === undefined) throw invalid('Unknown group chat')
    // A shared or face room has its own invitation; this one is for a room that lives in FlyBot.
    if (room.origin === 'inbound-share' || isFaceRoom(room)) throw invalid('This room has its own invitation')
    // A link is the owner's consent to show this room outside: the Bot it knocks on gets a Bot Social
    // identity now if it has none (a home with no friends has none yet).
    const lead = [room.admin, ...(room.members ?? [])].find(id => id && rt.botOf?.(id))
    if (lead && !memberHandleOf(lead)) await identify([lead])
    const botId = inviteBotOf(room)
    const handle = botId ? memberHandleOf(botId) : shareInviter(room).inviterHandle
    if (!handle) throw invalid('This machine has no Bot Social identity yet')
    const origin = rt.roomInviteOrigin || ROOM_INVITE_ORIGIN
    const mintedAt = Date.now()
    const mintedBy = actor?.memberId ?? state.bots?.[botId]?.ownerId
    let invite
    if (typeof rt.roomInviteServer?.mint === 'function') {
      let minted
      try {
        minted = await rt.roomInviteServer.mint({ roomId: room.id, name: room.name, handle })
      } catch (error) {
        // Fail closed: a link the server never recorded could not seat anyone it promises to.
        throw invalid(`Bot Social could not make a link right now: ${String(error?.message ?? error).slice(0, 160)}`)
      }
      if (minted) {
        const ticket = String(minted.ticket ?? '')
        // No deadline from a current server; an older one still dates its links, and that date stands.
        const at = minted.expiresAt == null ? undefined : Number(minted.expiresAt)
        if (!TICKET_SHAPE.test(ticket) || (at !== undefined && !Number.isFinite(at))) throw invalid('Bot Social answered with a link this FlyBot cannot read')
        const url = roomInviteUrl(handle, ticket, origin)
        if (!url) throw invalid('This room has no Bot handle a link can carry')
        invite = { ticket, handle, botId, url, ...(at !== undefined ? { expiresAt: at } : {}), mintedAt, server: true, ...(mintedBy ? { mintedBy } : {}) }
      }
    }
    if (!invite) {
      // 16 random bytes in base64url are 22 characters, the shape the invite field already accepts.
      const ticket = randomBytes(16).toString('base64url')
      // Build the link before the record is written: a handle the link cannot carry must not leave a
      // ticket behind that no invitee could ever use.
      if (!roomInviteUrl(handle, ticket, origin)) throw invalid('This room has no Bot handle a link can carry')
      invite = { ticket, handle, ...(botId ? { botId } : {}), mintedAt, ...(mintedBy ? { mintedBy } : {}) }
    }
    // Several links may be live (#878): each mint adds one. Dated-out links that seated nobody are dropped;
    // a spent link stays, because its seats hang off it.
    room.localInvites = [...invitesOf(room).filter(item => seatedBy(item) || openInvite(item)), invite].slice(-LOCAL_INVITES_KEPT)
    await rt.save?.()
    return inviteView(invite)
  }

  // Withdraw one link by its ticket, or (no ticket) every open link of the room. Nobody new can join
  // with it; the people it already seated keep their seats (owner decision, 2026-10-24) until the
  // owner removes them, they leave, or the room is deleted. A link that seated nobody is dropped.
  rt.revokeRoomInvite = async function revokeRoomInvite(roomId, ticket) {
    const room = rt.roomOf(roomId)
    if (room === undefined) throw invalid('Unknown group chat')
    const list = invitesOf(room)
    const wanted = ticket === undefined || ticket === null || ticket === '' ? undefined : String(ticket)
    const gone = (wanted === undefined ? list : list.filter(item => item.ticket === wanted)).filter(item => !item.withdrawnAt)
    if (gone.length === 0) {
      if (Array.isArray(room.localInvites) || list.length > 0) room.localInvites = list
      return { revoked: false }
    }
    const at = Date.now()
    for (const invite of gone) invite.withdrawnAt = at
    room.localInvites = list.filter(item => !gone.includes(item) || seatedBy(item))
    await rt.save?.()
    for (const invite of gone) {
      if (invite.server === true) void endServerTicket(invite.ticket)
    }
    return { revoked: true, ...(wanted === undefined && gone.length > 1 ? { count: gone.length } : {}) }
  }

  async function identify(ids) {
    if (typeof rt.roomInviteServer?.identify !== 'function') return
    try { await rt.roomInviteServer.identify(ids) } catch (error) {
      throw invalid(`Bot Social could not give this Bot an identity right now: ${String(error?.message ?? error).slice(0, 160)}`)
    }
  }

  async function endServerTicket(ticket, opts) {
    try { await rt.roomInviteServer?.revoke?.(ticket, opts) } catch (error) {
      rt.warn?.('ds-bot: Bot Social did not withdraw a room link: %s', error)
    }
  }
  // One home's claim ends at the server (the owner removed that guest, or its last seat left).
  async function endServerClaim(ticket, handle) {
    try { await rt.roomInviteServer?.endClaim?.(ticket, handle) } catch (error) {
      rt.warn?.('ds-bot: Bot Social did not end a room link claim: %s', error)
    }
  }

  function markSeatLeft(room, seat) {
    if (seat.leftSeq !== undefined) return
    const line = append(room, { kind: 'left', who: remoteBotTitle(seat), authorId: seat.handle, authorKind: 'bot', remote: true, text: '' })
    seat.leftSeq = line.seq
    seat.leftAt = Date.now()
    if (room.seen) delete room.seen[seat.id]
  }

  // A room this home deletes takes its links with it at the server too, so nobody can be seated by them.
  // The seats it admitted hear that the room is gone.
  rt.dropRoomInvites = async function dropRoomInvites(room) {
    if (!room) return
    for (const seat of currentParticipants(room).filter(isTicketSeat)) {
      await rt.notifyRoomShare?.(room, { op: 'leave', handle: seat.handle })
    }
    // The room is gone: every link is withdrawn and every home's reach in it ends.
    for (const invite of invitesOf(room)) {
      if (invite.server === true) await endServerTicket(invite.ticket, { endClaims: true })
    }
  }

  // #876: the invitee's side of a local link. The knock goes out from a Bot of the actor's whose home
  // has a Bot Social identity — the link cannot name the sender, so the transport does, exactly as on
  // the answering side.
  function socialBotsOf(actor) {
    const usable = Object.values(state.bots ?? {}).filter(bot => bot && bot.remote === undefined && memberHandleOf(bot.id))
    if (!actor?.memberId) return usable
    return usable.filter(bot => bot.ownerId === actor.memberId)
  }
  function localSpeaker(actor) {
    const list = socialBotsOf(actor)
    const chief = actor?.memberId ? state.members?.[actor.memberId]?.designatedChiefId : undefined
    return (chief !== undefined ? list.find(bot => bot.id === chief) : undefined)?.id ?? list[0]?.id
  }

  // What the link is, before anyone joins: Bot Social's record when it has one (a stranger can read
  // it), else nothing — the friend path asks the inviter's Bot instead.
  rt.previewLocalInvite = async function previewLocalInvite(link) {
    const parsed = parseRoomInviteLink(typeof link === 'string' ? link : '')
    if (!parsed || parsed.kind !== 'local') throw invalid('That is not a room link on another FlyBot')
    if (typeof rt.roomInviteServer?.preview !== 'function') return { handle: parsed.handle, ticket: parsed.ticket }
    try {
      const seen = await rt.roomInviteServer.preview(parsed.ticket)
      if (!seen) return { handle: parsed.handle, ticket: parsed.ticket }
      return {
        handle: parsed.handle,
        ticket: parsed.ticket,
        server: true,
        name: cleanPeerName(seen.name, ''),
        lead: cleanPeerName(seen.lead?.name, cleanPeerName(seen.lead?.handle, '')),
        owner: cleanPeerName(seen.lead?.ownerName, ''),
        expiresAt: Number(seen.expiresAt) || undefined,
        claimed: seen.claimed === true,
      }
    } catch (error) {
      const code = String(error?.code ?? '')
      if (code === 'invite_not_found') return { handle: parsed.handle, ticket: parsed.ticket }
      return { handle: parsed.handle, ticket: parsed.ticket, refused: refusalOf(code) }
    }
  }
  // Bot Social's refusal code, as the one reason the dialog names.
  function refusalOf(code) {
    switch (code) {
      case 'expired': return 'expired'
      case 'revoked': return 'revoked'
      case 'already_claimed': return 'claimed-elsewhere'
      case 'own_invite': return 'own-invite'
      case 'locked_out':
      case 'rate_limited': return 'busy'
      case 'invite_not_found': return 'unknown'
      default: return 'lookup-failed'
    }
  }

  rt.askLocalInvite = async function askLocalInvite(link, opts = {}, actor) {
    const parsed = parseRoomInviteLink(typeof link === 'string' ? link : '')
    if (!parsed || parsed.kind !== 'local') throw invalid('That is not a room link on another FlyBot')
    if (!rt.flybotSend) throw invalid('Bot Social is not connected on this machine yet')
    const accept = opts?.accept === true
    if (accept && typeof rt.roomInviteServer?.claim === 'function') {
      const claimed = await claimTicket(parsed, opts, actor)
      if (claimed) return claimed
    }
    const from = localSpeaker(actor)
    if (from === undefined) throw invalid('This machine has no Bot Social identity yet')
    const sent = await rt.flybotSend({
      from,
      to: parsed.handle,
      text: encodeRoomShare({ op: 'ask', ticket: parsed.ticket, ...(accept ? { accept: true } : {}) }),
      role: 'request',
      via: 'room-share',
      meta: { share: 'ask', ticket: parsed.ticket },
    })
    return { sent: sent?.action ?? 'sent', handle: parsed.handle, ticket: parsed.ticket, accept }
  }

  // #878: Join on a link Bot Social minted. The home claims the ticket for the Bots it brings (all or
  // none), then the first of them knocks with the claim; the inviter's home reads the claim back from
  // the server before it seats anyone. A link the server never minted falls back to the friend's knock.
  async function claimTicket(parsed, opts, actor) {
    // The actor's own Bots, by owner (a Bot with no Bot Social identity yet gets one below: Join is the
    // consent, as accepting a friend's invite is).
    const own = Object.values(state.bots ?? {}).filter(bot => bot && bot.remote === undefined && (!actor?.memberId || bot.ownerId === actor.memberId))
    const asked = Array.isArray(opts?.bots) ? opts.bots.map(String) : []
    const chief = actor?.memberId ? state.members?.[actor.memberId]?.designatedChiefId : undefined
    const fallback = own.find(bot => bot.id === chief) ?? own.find(bot => memberHandleOf(bot.id)) ?? own[0]
    const picked = asked.length > 0 ? own.filter(bot => asked.includes(bot.id)) : (fallback ? [fallback] : [])
    if (asked.length > 0 && picked.length !== new Set(asked).size) throw invalid('Pick Bots of your own to bring')
    if (picked.length === 0) throw invalid('This machine has no Bot Social identity yet')
    if (picked.length > TICKET_SEATS_MAX) throw invalid(`A link brings at most ${TICKET_SEATS_MAX} Bots`)
    const missing = picked.filter(bot => !memberHandleOf(bot.id)).map(bot => bot.id)
    if (missing.length > 0) await identify(missing)
    const handles = picked.map(bot => memberHandleOf(bot.id))
    if (handles.some(handle => !handle)) throw invalid('This machine has no Bot Social identity yet')
    let claim
    try {
      claim = await rt.roomInviteServer.claim(parsed.ticket, handles)
    } catch (error) {
      const code = String(error?.code ?? '')
      if (code === 'invite_not_found') return undefined
      return { refused: refusalOf(code), handle: parsed.handle, ticket: parsed.ticket, accept: true }
    }
    if (!claim) return undefined
    const roomId = String(claim.roomId ?? '')
    const inviter = String(claim.inviterHandle ?? parsed.handle)
    const first = picked[0].id
    // The claim is this home's one way to the inviter's Bot before the room exists here: the accepting
    // knock leaves under it (reach.js ticketPeers), and nothing else does. A day old and never answered,
    // it is dropped.
    const at = Date.now()
    state.roomClaims = Object.fromEntries(Object.entries(state.roomClaims ?? {}).filter(([, item]) => at - Number(item?.claimedAt) < 24 * 60 * 60 * 1000))
    state.roomClaims[parsed.ticket] = { inviterHandle: inviter, roomId, bots: picked.map(bot => bot.id), claimedAt: at }
    await rt.save?.()
    const sent = await rt.flybotSend({
      from: first,
      to: inviter,
      text: encodeRoomShare({ op: 'ask', ticket: parsed.ticket, accept: true, roomId, bots: handles }),
      role: 'request',
      via: 'room-share',
      meta: { share: 'ask', ticket: parsed.ticket, scope: roomId, claimed: true },
    })
    return { sent: sent?.action ?? 'sent', handle: inviter, ticket: parsed.ticket, accept: true, claimed: true, bots: handles }
  }

  // #852: a knock at a local room's link. The invitee's host sends `ask` (the accepting knock carries
  // `accept: true`); this side answers from the room record only, and a knock never creates a room,
  // adds a participant, or writes a line. The asker is the transport's sender, never a field of the
  // payload. Verify → consume → add → the join goes back to every seat.
  async function answerLocalInvite(data, event, actor) {
    const ticket = String(data.ticket ?? '')
    const asker = String(event.fromHandle ?? '')
    if (!asker) return { handled: true, refused: 'no-sender' }
    const room = Object.values(state.rooms || {}).find(record => invitesOf(record).some(item => item.ticket === ticket))
    if (room === undefined) return { handled: true, refused: 'unknown' }
    const invite = invitesOf(room).find(item => item.ticket === ticket)
    if (invite.server === true && data.accept === true) return seatByTicket(room, invite, data, event)
    if (invite.withdrawnAt) return { handled: true, refused: 'revoked' }
    if (!unexpired(invite)) return { handled: true, refused: 'expired' }
    if (data.accept !== true) {
      // The offer is information, not authority: the ticket is not consumed, and no member joins.
      await sendShareTo(room, { handle: asker }, {
        op: 'invite',
        ticket,
        roomId: room.id,
        name: room.name,
        lead: room.admin ? state.bots?.[room.admin]?.name : undefined,
        expiresAt: invite.expiresAt,
        ...shareInviter(room),
      }, 'room-share', invite.botId)
      return { handled: true, offer: { ticket, roomId: room.id, name: room.name, expiresAt: invite.expiresAt } }
    }
    // The accept lands here: the link admits anyone it is given to, and the record keeps who it seated.
    const homes = homesOf(invite)
    const claimed = !homes[asker]
    if (claimed) {
      invite.homes = { ...homes, [asker]: [asker] }
      invite.acceptedAt ??= Date.now()
    }
    try {
      const seated = currentParticipants(room).some(p => p.remote === true && (p.handle === asker || p.id === asker))
      if (seated) {
        // The usual retry: the join reply was lost. Success without a second seat, and say it again.
        await rt.save?.()
        void rt.notifyRoomShare?.(room, { op: 'join', handle: asker })
      } else {
        const ownerId = actor?.memberId ?? Object.keys(state.members || {})[0]
        await rt.addRoomParticipant(room.id, { kind: 'bot', handle: asker }, actor ?? (ownerId ? { memberId: ownerId } : undefined))
      }
    } catch (error) {
      // Nothing was added, so the record must not say it seated anyone.
      if (claimed) {
        const rest = homesOf(invite)
        delete rest[asker]
        invite.homes = rest
        delete invite.acceptedBy
      }
      rt.warn?.('ds-bot: a room invite accept from %s was refused: %s', asker, error)
      return { handled: true, refused: 'not-addable' }
    }
    return { handled: true, room, accepted: true }
  }

  // #884: the accepting knock on a ticket Bot Social minted. The knock is a request, never the
  // authority: the claim is read back from the server with this home's own credential, and the seats
  // are the Bots it names — all of them or none. Each way it can fail has its own reason.
  async function seatByTicket(room, invite, data, event) {
    const asker = String(event.fromHandle ?? '')
    if (typeof rt.roomInviteServer?.verify !== 'function') return { handled: true, refused: 'lookup-failed' }
    let claim
    try {
      claim = await rt.roomInviteServer.verify(invite.ticket)
    } catch (error) {
      const why = refusalOf(String(error?.code ?? ''))
      return { handled: true, refused: why === 'unknown' ? 'revoked' : why }
    }
    if (!claim || String(claim.roomId ?? '') !== room.id) return { handled: true, refused: 'wrong-room' }
    // A link admits every home it is given to (Bot Social #65): the minter reads each home's claim, and
    // the knock is answered from the one whose Bots include the asker. An older server names one claimer.
    const claims = Array.isArray(claim.claimers) ? claim.claimers : claim.claimer ? [claim.claimer] : []
    const botsOf = c => (Array.isArray(c?.bots) ? c.bots : []).map(String).filter(handle => handle.startsWith('@'))
    if (!claims.some(c => botsOf(c).length > 0)) return { handled: true, refused: 'unclaimed' }
    const mine = claims.find(c => botsOf(c).includes(asker))
    const seats = botsOf(mine)
    const home = typeof mine?.home === 'string' ? mine.home : undefined
    // The Bot that knocked must be one a claim brought, from the home that claimed it.
    if (!mine || (home && event.fromHome && event.fromHome !== home)) return { handled: true, refused: 'claimed-elsewhere' }
    if (seats.length > TICKET_SEATS_MAX) return { handled: true, refused: 'too-many' }
    const names = new Map((Array.isArray(mine?.members) ? mine.members : []).map(m => [String(m?.handle ?? ''), m]))
    const result = await withRoomLock(async () => {
      materialize(room)
      // A Bot of this room that may not be shown outside would be read by the stranger: refuse rather
      // than seat a room whose lines could not all go out.
      const blocked = unsharable(room).filter(p => p.id !== invite.botId)
      if (blocked.length > 0) return { refused: 'not-addable' }
      const fresh = seats.filter(handle => !currentParticipants(room).some(p => p.remote === true && (p.handle === handle || p.id === handle)))
      const at = Date.now()
      invite.homes = { ...homesOf(invite), [home ?? asker]: seats }
      delete invite.acceptedBy
      delete invite.seats
      invite.acceptedAt ??= at
      for (const handle of fresh) {
        const named = names.get(handle)
        const displayName = cleanPeerName(named?.display_name, handle)
        const ownerName = cleanPeerName(named?.owner_name, cleanPeerName(home, 'a guest'))
        const line = append(room, { kind: 'joined', who: remoteBotTitle({ handle, displayName, ownerName }), authorId: handle, authorKind: 'bot', remote: true, text: '' })
        // Drop an old left record of the same Bot, so the room holds one record for it.
        room.participants = room.participants.filter(p => !(p.remote === true && p.handle === handle && p.leftSeq !== undefined))
        room.participants.push({
          kind: 'bot',
          remote: true,
          id: handle,
          handle,
          ...(home ? { ownerHome: home } : {}),
          ownerName,
          displayName,
          role: 'member',
          admittedBy: 'ticket',
          ticket: invite.ticket,
          ...(invite.botId ? { hostBotId: invite.botId } : {}),
          invitedAt: at,
          joinedSeq: line.seq,
          joinedAt: at,
        })
      }
      syncMembers(room)
      await rt.save?.()
      return { fresh }
    })
    if (result.refused) return { handled: true, refused: result.refused }
    // Every seat hears the join, a retry included (the reply was lost): no second seat is made.
    for (const handle of seats) await rt.notifyRoomShare?.(room, { op: 'join', handle })
    return { handled: true, room, accepted: true, seats }
  }

  // A line or a leave that a remote seat sent into a room of this home (#884). The seat must be current
  // and the sender must be that seat's own Bot; anything else is dropped without a trace in the room.
  async function ingestSeatShare(room, seat, data) {
    if (data.op === 'leave') {
      await withRoomLock(async () => {
        markSeatLeft(room, seat)
        syncMembers(room)
      })
      await rt.save?.()
      if (isTicketSeat(seat)) await settleTicket(room, seat.ticket, seat)
      return { handled: true, room, left: seat.handle }
    }
    if (data.op !== 'line') return { handled: true, room }
    const who = cleanPeerName(data.who, remoteBotTitle(seat))
    const hop = Number.isFinite(Number(data.hop)) ? Math.max(0, Math.floor(Number(data.hop))) : 0
    const human = data.authorKind !== 'bot'
    const posted = append(room, rt.authoredRoomLine(room, {
      who,
      text: data.text || '',
      // A guest person's id is theirs, not this home's: it is kept apart from the members here.
      authorId: human ? `${seat.handle}#${String(data.authorId || 'person').slice(0, 40)}` : seat.handle,
      authorKind: human ? 'human' : 'bot',
      remote: true,
      hop,
      via: seat.handle,
      ...(human ? {} : { botId: seat.handle }),
      ownerName: ownerNameSafe(seat),
      kind: data.kind === 'message' ? undefined : data.kind,
    }))
    await rt.save?.()
    // The other homes in the room see it too; the home it came from already has it.
    void rt.fanoutRoomLine?.(room, posted)
    const named = localCalls(room, data.calls)
    const called = []
    if (named.length > 0 && hop < maxHopsOf(room) && typeof rt.startInboundTurn === 'function') {
      room.answered ??= []
      const remoteSeq = Number.isFinite(Number(data.seq)) ? Number(data.seq) : posted.seq
      for (const botId of named) {
        const key = `${seat.handle}:${remoteSeq}:${botId}`
        if (room.answered.includes(key)) continue
        room.answered = [...room.answered, key].slice(-ANSWERED_KEPT)
        called.push(botId)
        void Promise.resolve(rt.startInboundTurn({ room, botId, seq: posted.seq, hop, who, text: data.text || '' }))
          .catch(error => rt.warn?.('ds-bot: a guest\'s call in %s failed: %s', room.name, error))
      }
    }
    return { handled: true, room, ...(called.length > 0 ? { called } : {}) }
  }

  // A seat a link admitted has left (it left, or the owner removed it). When none of its home's seats
  // is left, that home's claim ends at the server; the link itself stays open for others. A withdrawn
  // link that no longer seats anyone is dropped.
  async function settleTicket(room, ticket, seat) {
    const invite = invitesOf(room).find(item => item.ticket === ticket)
    if (!invite) return
    const homes = homesOf(invite)
    const home = Object.keys(homes).find(key => (homes[key] ?? []).includes(seat?.handle)) ?? seat?.ownerHome
    const still = handle => currentParticipants(room).some(p => isTicketSeat(p) && p.ticket === ticket && p.handle === handle)
    if (home && homes[home] && !homes[home].some(still)) {
      delete homes[home]
      invite.homes = homes
      delete invite.acceptedBy
      delete invite.seats
      if (invite.server === true && seat?.handle) void endServerClaim(invite.ticket, seat.handle)
    }
    if (invite.withdrawnAt && !seatedBy(invite)) room.localInvites = invitesOf(room).filter(item => item !== invite)
    await rt.save?.()
  }

  // The guest's side of a seat (#884): a Bot of mine that a ticket seated leaves the room it mirrors.
  // The inviter's home hears it from that Bot, and when none of mine is left the claim is given back.
  async function leaveTicketRoom(room, me) {
    const inviter = room.sharedFrom?.inviterHandle
    const scope = room.sharedFrom?.remoteRoomId
    if (inviter && scope) {
      await sendShareTo(room, { handle: inviter, id: inviter }, {
        op: 'leave',
        roomId: scope,
        name: room.name,
        invitedHandle: inviter,
        seq: room.seq ?? 0,
        ticket: room.sharedFrom.ticket,
      }, 'room-share', me.id, scope)
    }
    const stays = currentParticipants(room).some(p => p.kind === 'bot' && !p.remote)
    if (!stays) {
      if (state.roomClaims?.[room.sharedFrom.ticket]) {
        delete state.roomClaims[room.sharedFrom.ticket]
        await rt.save?.()
      }
      await endServerTicket(room.sharedFrom.ticket)
    }
  }

  // A seat of this home's own room that the sender is, for a share addressed to that room.
  function ownSeatOf(data, event) {
    const room = rt.roomOf(String(data.roomId ?? ''))
    if (!room || room.origin === 'inbound-share' || isFaceRoom(room)) return undefined
    const from = String(event.fromHandle ?? '')
    // A seat a ticket admitted, or a friend's Bot the owner added: both are this room's remote members.
    const seat = currentParticipants(room).find(p => p.remote === true && p.handle === from)
    if (!seat) return undefined
    if (seat.ownerHome && event.fromHome && seat.ownerHome !== event.fromHome) return undefined
    return { room, seat }
  }

  // Room lines go out to the friends' Bots in the room, checked per author and per recipient
  // (#51): a line written by a local Bot that may not share the room never leaves, a friend's
  // Bot that is no longer granted to us gets nothing, and the sending Bot is one that may
  // speak outside (bot.send then runs the reach policy on every single send).
  rt.fanoutRoomLine = async function fanoutRoomLine(room, line) {
    if (isFaceRoom(room)) {
      // A line my own Bot wrote is not a room bubble until it has left (#456): it is `sending` from here,
      // `pending` while Bot Social holds it for the owner's Approve / Reject, and dropped from the list
      // once it went out. Only the owner's click (settleHeldLine) moves a pending line on.
      const held = rt.faceRoomFanout && isLocalBotLine(line) ? holdLine(room, line) : undefined
      let result
      try { result = await rt.faceRoomFanout?.(room, line) } catch (error) {
        rt.warn?.('ds-bot: face-room line not sent: %s', error)
      }
      if (held !== undefined) {
        if (result?.held === true && typeof result.approvalId === 'string' && result.approvalId) {
          held.status = 'pending'
          held.approvalId = result.approvalId
        } else {
          room.heldLines = (room.heldLines ?? []).filter(entry => entry !== held)
        }
        void Promise.resolve(rt.save?.()).catch(() => {})
      }
      return
    }
    const who = cleanName(line.who || 'member')
    const body = !line.text
      ? `[${cleanName(line.kind || 'event')}]`
      : isFencedUntrusted(line.text) ? line.text : fenceUntrusted(who, line.text)
    // #825: the projected room answers into the group it mirrors. The line goes back as one
    // `op: 'line'` envelope to the friend who invited this Bot, under *their* room id, one hop on,
    // carrying the handles it calls there.
    if (room.origin === 'inbound-share' && !isFaceRoom(room)) {
      const inviter = room.sharedFrom?.inviterHandle
      if (!inviter || !rt.flybotSend) return
      // A Bot of mine a ticket seated speaks for itself, under that room's scope (#884).
      const author = line.authorKind === 'bot' && line.remote !== true ? (line.authorId ?? line.botId) : undefined
      const seatedAuthor = room.sharedFrom?.ticket && author && currentParticipants(room).some(p => p.kind === 'bot' && !p.remote && p.id === author) ? author : undefined
      const sender = seatedAuthor ?? room.sharedFrom?.localBotId ?? shareSpeaker(room)
      if (!sender) return
      // A link's room (#884): the owner's own line is said under their Bot Social name, never this
      // home's "You", and the text goes as written: the inviter's home fences it once, on arrival.
      const ticketed = Boolean(room.sharedFrom?.ticket)
      const sayer = ticketed ? seatSayer(line, who, sender) : who
      const result = await sendShareTo(room, { handle: inviter, id: inviter }, {
        op: 'line',
        roomId: room.sharedFrom?.remoteRoomId,
        name: room.name,
        invitedHandle: inviter,
        seq: line.seq,
        who: sayer,
        kind: line.kind || 'message',
        authorKind: line.authorKind,
        authorId: line.authorId,
        text: ticketed ? seatText(line) : `${who}: ${body}`,
        hop: Number(line.hop) || ((Number(room.hop) || 0) + 1),
        calls: callsIn(room, line.text),
        ...shareInviter(room),
      }, 'room', sender, room.sharedFrom?.ticket ? room.sharedFrom.remoteRoomId : undefined)
      // Held for the owner's approval, or refused: the group gets one line about it instead of silence.
      const why = result?.action === 'hold' ? 'held for approval' : result?.action === 'deny' || result?.action === 'refused' ? 'rejected by its owner' : undefined
      if (why !== undefined && line.authorKind === 'bot' && line.remote !== true) {
        append(room, { who, kind: 'notice', text: `${who}'s answer is ${why}`, authorKind: 'bot' })
        await rt.save?.()
      }
      return
    }
    const remotes = currentParticipants(room).filter(isRemoteParticipant)
    if (remotes.length === 0 || !rt.flybotSend) return
    const localAuthor = line.authorKind === 'bot' && !line.remote && rt.botOf?.(line.authorId ?? line.botId) ? (line.authorId ?? line.botId) : undefined
    if (localAuthor !== undefined && !mayShareRoom(state, room, localAuthor)) return
    const from = shareInviter(room)
    for (const remote of remotes) {
      if (line.authorId === remote.id || line.authorId === remote.handle) continue
      // A line a seat sent here is not sent back to that seat's home (#884).
      if (line.via && line.via === remote.handle) continue
      if (isTicketSeat(remote)) {
        const seat = seatSender(room, remote)
        if (!seat) continue
        await sendShareTo(room, remote, {
          op: 'line',
          roomId: room.id,
          name: room.name,
          invitedHandle: remote.handle,
          seq: line.seq,
          who: seatSayer(line, who, seat.botId),
          kind: line.kind || 'message',
          authorKind: line.authorKind,
          authorId: line.authorId,
          text: seatText(line),
          hop: Number(line.hop) || (line.authorKind === 'bot' && line.remote !== true ? (Number(room.hop) || 0) + 1 : 0),
          calls: callsIn(room, line.text),
          ...seat.from,
        }, 'room', seat.botId, room.id)
        continue
      }
      if (!shareSpeaker(room)) continue
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
        hop: Number(line.hop) || (line.authorKind === 'bot' && line.remote !== true ? (Number(room.hop) || 0) + 1 : 0),
        calls: callsIn(room, line.text),
        ...from,
      }, 'room')
    }
  }

  const isLocalBotLine = line => !line?.kind && line?.remote !== true && line?.authorKind === 'bot'
    && typeof (line.botId ?? line.authorId) === 'string' && rt.botOf?.(line.botId ?? line.authorId) !== undefined
  function holdLine(room, line) {
    const entry = { seq: line.seq, botId: line.botId ?? line.authorId, text: String(line.text ?? ''), status: 'sending', at: Date.now() }
    room.heldLines = [...(room.heldLines ?? []), entry].slice(-HELD_LINES_KEPT)
    return entry
  }
  // The owner decided a held room line on its card (#456): approved, it is a plain bubble from now on;
  // rejected, it stays a grey "Not sent" line, after a reload and in Past rooms too.
  rt.settleHeldLine = function settleHeldLine(approvalId, decision) {
    const id = String(approvalId ?? '')
    if (!id || (decision !== 'approved' && decision !== 'rejected')) return false
    for (const room of Object.values(state.rooms ?? {})) {
      const entry = (room.heldLines ?? []).find(item => item.approvalId === id)
      if (entry === undefined) continue
      if (decision === 'approved') room.heldLines = room.heldLines.filter(item => item !== entry)
      else entry.status = 'rejected'
      void Promise.resolve(rt.save?.()).catch(() => {})
      return true
    }
    return false
  }

  // A Bot that no longer qualifies (grant revoked, owner removed) leaves every room
  // that has friends' Bots or more than one owner, at once; without an id, every such Bot does.
  rt.evictUnshared = async function evictUnshared(botId) {
    let changed = false
    for (const room of Object.values(state.rooms ?? {})) {
      // A face-to-face room's members come from Bot Social (syncFaceParticipants), and a Bot brought
      // by number is reachable there without a person-grant: a grant change never evicts it (#236).
      if (isFaceRoom(room)) continue
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
    // The envelope names the person who invited; the event names the Bot that carried the line here (#873).
    // Prefer the envelope for the identity, and keep the transport only as the fallback, so the room reads
    // "Shared room from Alice" rather than after the sender's Bot.
    const fromHandle = data.inviterHandle || event.fromHandle
    const fromHome = data.inviterHome || event.fromHome
    const fromName = cleanPeerName(data.inviterName || event.fromName, 'a friend')
    // A chat line is attributed to its speaker (`who`) and otherwise to the sender, never to the inviter:
    // this fix is about the room's identity, not about who wrote inside it.
    const transportName = cleanPeerName(event.fromName || data.inviterName, 'a friend')
    const localBotId = event.localBotId && state.bots?.[event.localBotId] ? event.localBotId : undefined
    const ownerId = actor?.memberId ?? event.ownerId ?? Object.keys(state.members || {})[0]
    // #852: answered before the branch below, so a knock or an offer never projects a room here.
    if (data.op === 'ask') return answerLocalInvite(data, event, actor)
    if (data.op === 'invite') {
      // The dialog shows the offer; it admits nobody and creates nothing on this side.
      void rt.onLocalInviteOffer?.(data, { fromHandle, fromHome, fromName })
      return { handled: true, offer: data }
    }
    // #884: a share addressed to a room that lives here, from one of its remote seats: the seat writes
    // into it or leaves it. It never projects a second room of the same id on this side.
    const own = ownSeatOf(data, event)
    if (own) return ingestSeatShare(own.room, own.seat, data)
    // A line for a room of mine from someone it does not seat is dropped: it must not open a copy here.
    const mine = rt.roomOf(String(data.roomId ?? ''))
    if (data.op === 'line' && mine && mine.origin !== 'inbound-share' && !isFaceRoom(mine)) return { handled: true, refused: 'not-seated' }
    let room = inboundOf(data.roomId, fromHome, fromHandle)
    if (!room) {
      // A share recorded before this fix stores the transport's identity, so the envelope's home would not
      // match it and the same remote room would fork into a second `inbound-share` room. Match the values
      // the room already has as well; the envelope still wins for what gets recorded.
      const storedHome = event.fromHome || ''
      const storedHandle = event.fromHandle || ''
      if ((storedHome && storedHome !== fromHome) || (storedHandle && storedHandle !== fromHandle)) {
        room = inboundOf(data.roomId, storedHome, storedHandle)
      }
    }
    const ticket = typeof data.ticket === 'string' && TICKET_SHAPE.test(data.ticket) ? data.ticket : undefined
    // #884: a join that says it comes through a link is one this home claimed: that inviter, that room,
    // and a Bot the claim brought. A ticket nobody here claimed opens nothing.
    if (ticket && data.op === 'join') {
      const claim = state.roomClaims?.[ticket]
      const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase() && String(a ?? '') !== ''
      if (!claim || !same(claim.inviterHandle, event.fromHandle) || String(claim.roomId ?? '') !== String(data.roomId ?? '')
        || (localBotId && !(claim.bots ?? []).includes(localBotId))) return { handled: true, refused: 'unclaimed' }
    }
    if (data.op === 'leave') {
      if (!room) return { handled: true, room: undefined }
      // #884: a seat of a room that holds several Bots of mine ends for the Bot it names; the room
      // goes when the last of them does.
      const mineNamed = currentParticipants(room).filter(p => p.kind === 'bot' && !p.remote && memberHandleOf(p.id) === data.invitedHandle)
      const others = currentParticipants(room).filter(p => p.kind === 'bot' && !p.remote && !mineNamed.includes(p))
      if (room.sharedFrom?.ticket && mineNamed.length > 0 && others.length > 0) {
        for (const p of mineNamed) {
          const line = append(room, { kind: 'left', who: p.displayName, authorId: p.id, authorKind: 'bot', text: '' })
          p.leftSeq = line.seq
          p.leftAt = Date.now()
        }
        syncMembers(room)
      } else {
        markInboundLeft(room)
      }
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
        ...(ticket && data.op === 'join' ? { ticket } : {}),
      }, actor || (ownerId ? { memberId: ownerId } : undefined))
    } else {
      delete room.hidden
      // A ticket seats each Bot of mine on its own (#878): the join names one, and only that one comes
      // back or is added. A friend's share keeps the room's one Bot.
      const seatedHere = ticket && data.op === 'join' && localBotId
      if (seatedHere && !(room.participants ?? []).some(p => p.kind === 'bot' && !p.remote && p.id === localBotId)) {
        const at = Date.now()
        room.participants = [...(room.participants ?? []), {
          kind: 'bot',
          id: localBotId,
          role: 'member',
          displayName: state.bots[localBotId].name,
          joinedSeq: room.seq ?? 0,
          joinedAt: at,
          invitedByName: fromName,
          invitedAt: at,
        }]
        room.sharedFrom = { ...room.sharedFrom, ticket }
      }
      for (const p of room.participants ?? []) {
        if (seatedHere && p.id !== localBotId) continue
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
    let called = []
    if (data.op === 'line') {
      const who = cleanPeerName(data.who || transportName, transportName)
      const hop = Number.isFinite(Number(data.hop)) ? Math.max(0, Math.floor(Number(data.hop))) : 0
      const posted = append(room, rt.authoredRoomLine(room, {
        who,
        text: data.text || '',
        authorId: data.authorId || fromHandle,
        authorKind: data.authorKind || 'human',
        remote: true,
        hop,
        ...(data.authorKind === 'bot' ? { botId: data.authorId || fromHandle } : {}),
        kind: data.kind === 'message' ? undefined : data.kind,
      }))
      // #825: the line names Bots, and one of them is mine. The remote home resolved the call where
      // mentions are resolved, so this side never reads @names out of the text.
      const named = localCalls(room, data.calls)
      if (named.length > 0 && hop < maxHopsOf(room) && typeof rt.startInboundTurn === 'function') {
        room.answered ??= []
        // Keyed by the remote line, not the local copy: a redelivery of the same line lands at a new
        // local seq, so keying on that would answer the same line twice.
        const remoteSeq = Number.isFinite(Number(data.seq)) ? Number(data.seq) : posted.seq
        for (const botId of named) {
          const key = `${data.roomId}:${remoteSeq}:${botId}`
          if (room.answered.includes(key)) continue
          room.answered = [...room.answered, key].slice(-ANSWERED_KEPT)
          called.push(botId)
          void Promise.resolve(rt.startInboundTurn({ room, botId, seq: posted.seq, hop, who, text: data.text || '' }))
            .catch(error => rt.warn?.('ds-bot: inbound call in %s failed: %s', room.name, error))
        }
      }
    }
    await rt.save?.()
    return { handled: true, room, ...(called.length > 0 ? { called } : {}) }
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
        ...(typeof draft.ticket === 'string' && draft.ticket ? { ticket: draft.ticket } : {}),
      },
      inviteNotice: true,
      maxHops: Number.isFinite(Number(draft.maxHops)) ? Math.max(0, Math.floor(Number(draft.maxHops))) : DEFAULT_MAX_HOPS,
      participants: [
        // A link admits the person with their Bots (#878): the owner can write in the room it opened.
        ...(typeof draft.ticket === 'string' && draft.ticket ? [{
          kind: 'human', id: ownerId, role: 'member', displayName: displayNameFor(state, ownerId, 'You'),
          joinedSeq: draft.joinedSeq ?? 0, joinedAt: draft.invitedAt ?? at,
        }] : []),
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
      ...(cleanRoleLabel(member.role) ? { roleLabel: cleanRoleLabel(member.role) } : {}),
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
      // Brought by number: reachable in this room only, while a member (reach.js isCodeJoined).
      viaCode: true,
      joinedSeq,
      joinedAt: at,
    }
  }

  // A Bot that is back in the server's member list was never gone: drop the empty `left` line a
  // local removal wrote for it, so the log does not say it left. A platform leave notice has text
  // and stays. Matches on the author, since a silent `leftSeq` can equal any line's seq.
  function dropStrayLeft(room, p) {
    const ids = new Set([p.id, p.handle].filter(Boolean))
    const at = (room.log ?? []).findIndex(line => line.seq === p.leftSeq && line.kind === 'left'
      && line.authorKind === 'bot' && !line.text && ids.has(line.authorId))
    if (at >= 0) room.log.splice(at, 1)
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
      // The role label its home set for this room (#476); gone when that home clears it.
      if (cleanRoleLabel(member.role)) existing.roleLabel = cleanRoleLabel(member.role)
      else delete existing.roleLabel
      const look = faceLookFields(member)
      if (look.color) existing.color = look.color
      if (look.avatar) existing.avatar = look.avatar
    } else {
      existing.viaCode = true
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
          dropStrayLeft(room, existing)
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
    // The number the room was joined by, kept on the room: an upsert that does not repeat it
    // (a poll, a leave) must not turn `· 482913` into a date (#304).
    code: spec.joinCode || spec.code || room?.face?.joinCode,
    at: faceRoomCreatedAt({ createdAt: spec.createdAt, expiresAt: spec.expiresAt || room?.face?.expiresAt, startedAt: spec.startedAt || room?.face?.startedAt }) || room?.createdAt,
  })

  const faceJoinCode = (spec, room) => {
    const digits = String(spec.joinCode || spec.code || '').replace(/\D/g, '')
    return digits.length === 6 ? digits : room?.face?.joinCode
  }

  rt.upsertFaceRoom = async function upsertFaceRoom(spec = {}) {
    const serverId = String(spec.roomId || spec.faceRoomId || '')
    if (!serverId) throw invalid('A face-to-face room needs a room id')
    let room = Object.values(state.rooms || {}).find(item => item.face?.roomId === serverId)
    const title = faceRoomFallbackTitle(spec, room)
    // The room lead every home follows (#476): kept until a snapshot names it again.
    const lead = spec.lead !== undefined ? cleanFaceLead(spec.lead) : room?.face?.lead
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
      ...(faceJoinCode(spec, room) ? { joinCode: faceJoinCode(spec, room) } : {}),
      ...(lead ? { lead } : {}),
    }
    if (spec.name || isAutoFaceTitle(room.name)) room.name = title
    if (Array.isArray(spec.members)) rt.syncFaceParticipants(room, spec.members, spec.localBots)
    // When the lead is one of my Bots it is this room's admin here, so the round asks it first (#476).
    const leadSeat = faceLeadOf(room)
    room.admin = leadSeat && !leadSeat.remote && room.members.includes(leadSeat.id) ? leadSeat.id : null
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
