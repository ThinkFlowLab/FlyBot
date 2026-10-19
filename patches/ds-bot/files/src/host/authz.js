// Owner-scoped access (#49): default-deny authorization for the /api/bot channel.
// Once a member session exists on the host, every Bot, room and session an endpoint
// touches must belong to the signed-in actor; shared resources that cannot yet be
// isolated per owner are explicitly blocked. With no session the legacy single-human
// behavior is untouched. This is not team mode: it is the access foundation the team
// gates build on (docs/subsystems/team.md).
//
// Room membership (#50) adds one exception: a signed-in human may reach a room they
// currently belong to (history, send, progress, participant changes they may make),
// even when its Chiefs belong to more than one owner. Specialists and private 1:1
// chats stay owner-scoped. Team mode stays disabled.
//
// Install order matters: right after member-auth, so rt.authzEnforced sees the same
// state.authSessions the sign-in surface writes, and before any module it gates.

import { currentParticipants, roomVisibleTo } from './room-membership.js'
import { hasAnyGrant } from './reach.js'

// Endpoints a request without an actor may still reach. auth-invite keeps the
// bootstrap rule in member-auth (first invite signs the installing human in).
const NO_ACTOR_ALLOWED = new Set(['auth-redeem', 'auth-whoami', 'auth-invite'])

// Resources that are one per deployment, not one per owner: blocked outright while
// more than one member exists rather than silently shared. The DSH Agent (`add-agent`)
// is one of them: there is at most one, and it carries no owner.
const SHARED_BLOCKED = new Set([
  'secret-set', 'secret-allow', 'secret-cancel', 'secret-update', 'secret-delete',
  'connector-connect', 'connector-apps', 'connector-disconnect', 'connector-retry', 'bot-connectors',
  'capability-save', 'capability-delete', 'capability-approve',
  'folders', 'folder-pick', 'folder-list',
  'browser-wait', 'browser-result',
  'update-install', 'dsh-update-install',
  'diagnostics-clear', 'diagnostics', 'diagnostics-log', 'set-prefs',
  'add-agent',
])

// Endpoints whose body names a Bot (or a resource hanging off one).
const BOT_TARGETED = new Set([
  'update-bot', 'delete-bot', 'duplicate-bot', 'set-flags', 'bot-capability',
  'memory-view', 'memory-ask', 'memory-forget',
  'schedules', 'schedule-create', 'schedule-delete',
  'agent-session', 'agent-adopt', 'agent-archive', 'agent-rename', 'remove-agent',
  'stop-member-work', 'set-main', 'test-model',
])

// Endpoints whose body names a room.
const ROOM_TARGETED = new Set(['update-room', 'delete-room', 'room-progress', 'create-room', 'room-history', 'room-post'])

// Endpoints whose body names a Session.
const SESSION_TARGETED = new Set(['earlier', 'send', 'answer-question', 'dismiss-question', 'approval-answer', 'exchange'])

// Task channel names. Requester checks live on the record in tasks.js; listing them
// here keeps a future `task-*` from auto-allowing for any signed-in actor (#111).
const TASK_ENDPOINTS = new Set([
  'tasks', 'task-create', 'task-accept', 'task-start', 'task-return', 'task-accept-result', 'task-cancel',
  'task-wait-input', 'task-answer-input',
])

const deny = (code, message) => ({ ok: false, code, message })
const ALLOW = { ok: true }

export function install(rt) {
  const { state } = rt

  // Enforced only on a deployment where someone has signed in; before that the
  // single-human product behaves exactly as it always has.
  rt.authzEnforced = () => Object.keys(state.authSessions || {}).length > 0

  const botOwnedBy = (actor, botId) => typeof botId === 'string' && (state.bots || {})[botId]?.ownerId === actor.memberId

  const roomOwnedBy = (actor, roomId) => {
    const room = (state.rooms || {})[String(roomId ?? '')]
    if (!room) return false
    const ids = Object.values(room.members ?? {})
    if (ids.length === 0) return false
    return ids.every(id => {
      const bot = (state.bots || {})[id]
      return bot !== undefined && bot.ownerId === actor.memberId
    })
  }

  // Shared rooms (#50): a current human participant may read and speak. Private
  // owner rooms still match roomOwnedBy (legacy rooms with no participants).
  const roomMemberOf = (actor, roomId) => roomVisibleTo(state, actor, roomId)

  const listedHumans = (body) => {
    const ids = new Set()
    if (Array.isArray(body?.participants)) {
      for (const p of body.participants) {
        if (p?.kind === 'human' && typeof p.id === 'string') ids.add(p.id)
      }
    }
    if (Array.isArray(body?.humans)) {
      for (const id of body.humans) if (typeof id === 'string') ids.add(id)
    }
    return ids
  }

  const permittedSharedBot = (actor, botId, humans) => {
    const bot = (state.bots || {})[botId]
    if (!bot) return false
    if (bot.ownerId === actor.memberId) return true
    const owners = new Set(humans)
    owners.add(actor.memberId)
    // Another owner's Bot joins only if it has a grant (#90).
    return hasAnyGrant(state, botId) && owners.has(bot.ownerId)
  }

  // A sessionId may be a Bot's id, its current chat Session, a group Session, an
  // earlier part, or a room Session: resolve it to its Bot or room and apply that
  // owner's rule. `rt.botOf` maps a Bot id to the Bot object; the store's owner maps
  // (`groupOwners`, `pastOwners`) and `rt.selfOf` resolve Session ids. Unresolvable
  // is a deny.
  const sessionOwnedBy = (actor, sessionId) => {
    const id = String(sessionId ?? '')
    if (id === '') return false
    if (state.rooms?.[id]) return roomMemberOf(actor, id) || roomOwnedBy(actor, id)
    const bot = rt.botOf?.(id)
    if (bot !== undefined && bot !== null) return botOwnedBy(actor, bot.id)
    const owner = rt.groupOwners?.get(id) ?? rt.pastOwners?.get(id)
    if (owner) {
      if (owner.roomId !== undefined) return roomMemberOf(actor, owner.roomId) || roomOwnedBy(actor, owner.roomId)
      if (owner.botId !== undefined) return botOwnedBy(actor, owner.botId)
      return false
    }
    const selfBotId = rt.selfOf?.(id)
    if (typeof selfBotId === 'string' && selfBotId !== '') return botOwnedBy(actor, selfBotId)
    for (const room of Object.values(state.rooms || {})) {
      const sessions = room.sessions ?? {}
      if (Object.values(sessions).includes(id) || Object.values(room.segments ?? {}).some(list => (list ?? []).some(s => s?.sessionId === id))) {
        return roomMemberOf(actor, room.id) || roomOwnedBy(actor, room.id)
      }
    }
    return false
  }

  rt.botOwnedBy = botOwnedBy
  rt.roomOwnedBy = roomOwnedBy
  rt.roomMemberOf = roomMemberOf
  rt.sessionOwnedBy = sessionOwnedBy

  // Alone on the deployment nothing is shared, so deployment-wide surfaces stay
  // visible (the same rule as SHARED_BLOCKED); with more than one member they hide.
  const alone = () => Object.keys(state.members || {}).length <= 1

  // The channel's view()/live() narrowing: per-owner resources narrow to the actor
  // (a keyed-by-session map keeps the actor's own entries), deployment-wide surfaces
  // follow the `alone` rule. Unenforced or actor-less, the full views go out unchanged.
  rt.ownedView = (full, actor) => {
    if (!(rt.authzEnforced() && actor)) return full
    const bySession = obj => Object.fromEntries(Object.entries(obj ?? {}).filter(([id]) => sessionOwnedBy(actor, id)))
    // Shared rooms (#50): rooms the actor owns or currently belongs to, and the Bots in
    // them, so the shared room renders for every participant.
    const rooms = full.rooms.filter(room => roomMemberOf(actor, room.id) || roomOwnedBy(actor, room.id))
    const sharedBots = new Set()
    for (const room of rooms) {
      for (const id of room.members ?? []) sharedBots.add(id)
      for (const p of room.participants ?? []) if (p.kind === 'bot' && p.leftSeq === undefined) sharedBots.add(p.id)
    }
    return {
      ...full,
      bots: full.bots.filter(bot => bot.ownerId === actor.memberId || sharedBots.has(bot.id)),
      rooms,
      self: { memberId: actor.memberId, displayName: actor.displayName },
      questions: bySession(full.questions),
      exchangeTurns: bySession(full.exchangeTurns),
      remoteTypedTurns: bySession(full.remoteTypedTurns),
      agents: alone() ? full.agents : [],
      secrets: alone() ? full.secrets : [],
      secretRequests: alone() ? full.secretRequests : {},
    }
  }
  rt.ownedLive = (full, actor) => {
    if (!(rt.authzEnforced() && actor)) return full
    const mine = id => (state.bots || {})[id]?.ownerId === actor.memberId
    const pick = obj => Object.fromEntries(Object.entries(obj ?? {}).filter(([id]) => mine(id)))
    return {
      activity: pick(full.activity),
      work: {
        bots: pick(full.work.bots),
        rooms: Object.fromEntries(Object.entries(full.work.rooms ?? {}).filter(([id]) => roomMemberOf(actor, id) || roomOwnedBy(actor, id))),
        approvals: full.work.approvals.filter(entry => mine(entry.botId)),
      },
      memoryNews: pick(full.memoryNews),
      memoryReviews: alone() ? full.memoryReviews : 0,
      connectors: alone() ? full.connectors : [],
      capabilityStatuses: pick(full.capabilityStatuses),
    }
  }

  rt.authorize = function authorize(actor, endpoint, body) {
    if (!rt.authzEnforced()) return ALLOW
    const ep = String(endpoint ?? '')

    if (!actor) {
      if (NO_ACTOR_ALLOWED.has(ep)) return ALLOW
      return deny('bot/unauthorized', 'Sign in first')
    }

    // Shared deployment-wide resources: one member may still use them, more than
    // one may not until they can be scoped per owner.
    if (SHARED_BLOCKED.has(ep) && Object.keys(state.members || {}).length > 1) {
      return deny('bot/blocked-shared', 'This resource cannot be isolated per owner yet, so it is unavailable while the team has more than one member')
    }
    // Alone on the deployment there is nothing to share: the resource is still one per
    // owner, so the single member reaches it without a per-owner rule.
    if (SHARED_BLOCKED.has(ep)) return ALLOW

    // FlyBot plugin endpoints (src/host/hooks.js) served on this channel: reads go to
    // any signed-in actor; plugin writes are deployment-wide until plugins declare
    // owners, so they follow the shared rule.
    if (ep.startsWith('flybot/')) {
      if (rt.flybotIsRead?.(ep.slice('flybot/'.length)) === true) return ALLOW
      // Held-send decisions are per-owner enforced in hooks.js — the approval belongs
      // to the sender Bot's owner — so deciding does not follow the shared rule (#52).
      if (ep === 'flybot/decide') return ALLOW
      if (!alone()) return deny('bot/blocked-shared', 'This plugin endpoint cannot be scoped per owner yet, so it is unavailable while the team has more than one member')
      return ALLOW
    }

    // Body id fields the actor does not own deny the request before the endpoint runs.
    const requireBot = id => (botOwnedBy(actor, id) ? ALLOW : deny('bot/forbidden', 'You do not own that Bot'))
    const requireRoom = id => (roomOwnedBy(actor, id) ? ALLOW : deny('bot/forbidden', 'You do not own that room'))
    const requireSession = id => (sessionOwnedBy(actor, id) ? ALLOW : deny('bot/forbidden', 'You do not own that session'))

    if (BOT_TARGETED.has(ep)) {
      if (ep === 'schedules' || ep === 'schedule-create' || ep === 'schedule-delete') {
        // The create endpoint keys off `body.target` (Bot or room id); `sessionId` is
        // the list/delete key. Checking only sessionId would allow a foreign target
        // paired with an owned session (#106).
        if (ep === 'schedule-create') {
          const target = body?.target
          if (typeof target === 'string' && target !== '') {
            if (botOwnedBy(actor, target) || roomOwnedBy(actor, target) || roomMemberOf(actor, target)) return ALLOW
            return deny('bot/forbidden', 'You do not own that Bot or group chat')
          }
        }
        if (ep === 'schedule-delete' && typeof body?.id === 'string' && !sessionOwnedBy(actor, body.id) && !sessionOwnedBy(actor, body.sessionId)) return deny('bot/forbidden', 'You do not own that schedule')
        return requireSession(body?.sessionId)
      }
      if (ep.startsWith('agent-') || ep === 'remove-agent') {
        // Agent sessions hang off the deployment's one DSH Agent (no owner record of
        // its own), so the body's Bot decides.
        return botOwnedBy(actor, body?.botId ?? body?.ownerBotId) ? ALLOW : deny('bot/forbidden', 'You do not own that agent')
      }
      if (ep === 'usage') return body?.botId === undefined ? ALLOW : requireBot(body.botId)
      if (ep === 'set-main') return requireBot(body?.id)
      if (ep === 'set-flags') {
        const id = body?.id ?? body?.botId
        if (botOwnedBy(actor, id) || roomOwnedBy(actor, id) || roomMemberOf(actor, id)) return ALLOW
        return deny('bot/forbidden', 'You do not own that conversation')
      }
      if (ep === 'stop-member-work') {
        const roomOk = roomOwnedBy(actor, body?.roomId) || roomMemberOf(actor, body?.roomId)
        const botOk = botOwnedBy(actor, body?.botId)
        return roomOk || botOk ? ALLOW : deny('bot/forbidden', 'You do not own that Bot or room')
      }
      return requireBot(body?.id ?? body?.botId)
    }

    if (ROOM_TARGETED.has(ep)) {
      if (ep === 'create-room') {
        // A room with no member Bot would belong to nobody (a room is owned through
        // its members), so it is refused here rather than created unownable.
        const members = Array.isArray(body?.members) ? body.members : []
        const fromParticipants = Array.isArray(body?.participants)
          ? body.participants.filter(p => p?.kind === 'bot' && !p.remote && !p.handle).map(p => p.id)
          : []
        const remotes = [
          ...(Array.isArray(body?.participants) ? body.participants : []),
        ].filter(p => p?.kind === 'bot' && (p.remote || p.handle)).map(p => p.handle || p.id)
        if (remotes.some(handle => !rt.isPublishedRemote?.(handle))) {
          return deny('bot/forbidden', 'Only a Bot granted to you may join a shared room')
        }
        const bots = [...new Set([...members, ...fromParticipants])]
        // A room with nothing in it would belong to nobody; one made only of other
        // participants (humans, granted remote Bots) is a shared room (#50, #90).
        const hasParticipants = Array.isArray(body?.participants) && body.participants.length > 0
        if (bots.length === 0 && !hasParticipants) return deny('bot/forbidden', 'You do not own every Bot in that room')
        if (bots.every(id => botOwnedBy(actor, id))) return ALLOW
        const humans = listedHumans(body)
        humans.add(actor.memberId)
        if (bots.every(id => permittedSharedBot(actor, id, humans))) return ALLOW
        return deny('bot/forbidden', 'You do not own every Bot in that room')
      }
      if (ep === 'update-room') {
        const roomId = body?.id
        const addedRemotes = [
          ...(Array.isArray(body?.addParticipants) ? body.addParticipants : []),
        ].filter(p => p?.kind === 'bot' && (p.remote || p.handle)).map(p => p.handle || p.id)
        if (addedRemotes.some(handle => !rt.isPublishedRemote?.(handle))) {
          return deny('bot/forbidden', 'Only a Bot granted to you may join a shared room')
        }
        if (roomOwnedBy(actor, roomId)) {
          const ids = []
          for (const list of [body?.members, body?.add, body?.remove]) if (Array.isArray(list)) ids.push(...list)
          if (ids.every(id => botOwnedBy(actor, id))) return ALLOW
        }
        if (roomMemberOf(actor, roomId)) {
          const humans = listedHumans(body)
          humans.add(actor.memberId)
          for (const p of currentParticipants(state.rooms?.[roomId])) {
            if (p.kind === 'human') humans.add(p.id)
          }
          const bots = [...(Array.isArray(body?.add) ? body.add : []), ...(Array.isArray(body?.members) ? body.members : [])]
          if (bots.every(id => permittedSharedBot(actor, id, humans) || botOwnedBy(actor, id))) return ALLOW
          if (bots.length === 0) return ALLOW
        }
        return deny('bot/forbidden', 'You do not own that room or one of its Bots')
      }
      if (ep === 'room-history' || ep === 'room-progress' || ep === 'room-post') {
        const id = body?.id ?? body?.roomId
        return roomMemberOf(actor, id) || roomOwnedBy(actor, id) ? ALLOW : deny('bot/forbidden', 'You are not a member of that room')
      }
      if (ep === 'delete-room') {
        const id = body?.id ?? body?.roomId
        if (roomOwnedBy(actor, id)) return ALLOW
        const room = state.rooms?.[id]
        const me = currentParticipants(room).find(p => p.kind === 'human' && p.id === actor.memberId)
        return me?.role === 'admin' ? ALLOW : deny('bot/forbidden', 'You do not own that room')
      }
      return requireRoom(body?.id ?? body?.roomId)
    }

    if (SESSION_TARGETED.has(ep)) {
      if (ep === 'exchange') {
        const a = String(body?.a ?? ''), b = String(body?.b ?? '')
        if (a === '' || b === '') return deny('bot/forbidden', 'You do not own that exchange')
        return sessionOwnedBy(actor, a) && sessionOwnedBy(actor, b) ? ALLOW : deny('bot/forbidden', 'You do not own that exchange')
      }
      if (ep === 'approval-answer') {
        // The client answers by approval id alone; the approval names its own Bot and
        // room, and those decide — never a caller-chosen sessionId next to it.
        const approval = (rt.approvalsView?.() ?? []).find(entry => entry.id === String(body?.id ?? ''))
        if (approval === undefined) return deny('bot/forbidden', 'You do not own that approval')
        return botOwnedBy(actor, approval.botId) || roomOwnedBy(actor, approval.roomId) ? ALLOW : deny('bot/forbidden', 'You do not own that approval')
      }
      return requireSession(body?.sessionId)
    }

    if (ep === 'create-bot') return ALLOW

    // Sharing a member Bot's brief is the Bot owner's decision, checked on the record
    // in room-membership (#53); the endpoint itself only needs a signed-in actor.
    if (ep === 'share-brief') return ALLOW
    // Task transitions are requester-checked on the record in tasks.js (#54) — the
    // endpoint only needs a signed-in actor, like held-send decisions. Create is
    // grant-aware there (owner, matching grant, or the named room). Explicit set:
    // a future `task-*` name must be listed here, not auto-allowed (#111).
    if (TASK_ENDPOINTS.has(ep)) return ALLOW

    // Anything not in the table and not a known auth/read endpoint is denied.
    if (NO_ACTOR_ALLOWED.has(ep) || ep.startsWith('auth-')) return ALLOW
    if (ep === 'state' || ep === 'models' || ep === 'efforts' || ep === 'repo-stars' || ep === 'update-check'
      || ep === 'diagnostics' || ep === 'diagnostics-log' || ep === 'usage') return ALLOW

    return deny('bot/not-found', `Unknown endpoint ${ep}`)
  }

  return rt
}
