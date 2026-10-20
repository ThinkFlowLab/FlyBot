// -------------------------------------------------------------------------
// The composer's "@" in a Bot's chat or a group chat: a Bot group that inserts
// "@Name", and the chats that "+ → Reference a chat" opens in the same menu.
// Both are sources of the shell's trigger menu; the shell's own file and session
// rows stay beside them, because a source cannot be hidden for one Session (a face
// room filters the session rows out of view: face-at-filter.js).
import { mentionCandidates, remoteMentionRows } from './flybot-registry.js'
import { cleanPeerName, ownerNameOf, remoteBotTitle, listedChatBots } from '../shared/remote-label.js'
import { t } from './i18n.js'
import { currentPart, relativeShort } from './text.js'

export const BOTS_SOURCE = 'ds-bot'
export const CHATS_SOURCE = 'ds-bot-chats'
// The words the group host reads as "everyone" (groups.js ROOM_ALL).
const ROOM_ALL = ['all', 'everyone', '所有人', '全体']
const OTHER_CHATS_MAX = 8

const conversationOf = (roster, sessionId) => {
  if (!roster.ready) return null
  const room = roster.roomsById[sessionId]
  if (room) return { room }
  const self = roster.byId[sessionId]
  return self ? { self } : null
}

// What "@query" offers: a group's members and "everyone", or in a Bot's chat every
// other Bot. Null outside the team, so a plain Session keeps the shell's menu alone.
export function mentionRows(roster, sessionId, query = '') {
  const here = conversationOf(roster, sessionId)
  if (here === null) return null
  const face = isFaceRoom(here.room)
  const live = (here.room?.participants ?? []).filter(p => p.leftSeq === undefined)
  const bots = here.room
    ? [
        ...here.room.members.map(id => roster.byId[id]).filter(Boolean)
          .map(bot => (face ? { ...bot, label: faceLabel(myOwnerName(roster, live, bot), bot.name) } : bot)),
        ...live.filter(p => p.kind === 'human')
          .map(p => ({ id: p.id, name: p.displayName || p.id, kind: 'human', role: p.role })),
        // A remote seat already listed under its handle (a duplicate participant record) is offered once.
        ...uniqueBy(live.filter(p => p.remote), p => p.handle || p.id)
          .map(p => ({
            id: p.handle || p.id, name: remoteBotTitle(p), kind: 'bot', remote: p, handle: p.handle,
            ...(face ? { label: faceLabel(ownerNameOf(p), cleanPeerName(p.displayName || p.name, 'Bot')) } : {}),
          })),
      ]
    : listedChatBots(roster).filter(bot => bot.id !== here.self.id)
  const needle = query.trim().toLowerCase()
  const rows = bots
    // A seated friend's Bot is also found by its handle, the second line of its row (#384).
    .filter(bot => bot.name.toLowerCase().includes(needle) || String(bot.label ?? '').toLowerCase().includes(needle)
      || (bot.remote && normHandle(remoteRecord(bot)?.handle || bot.handle).includes(normHandle(needle))))
    .map(bot => ({ bot, text: `@${bot.name} ` }))
  const everyone = t('Everyone')
  if (here.room && bots.length > 1 && [everyone, ...ROOM_ALL].some(word => word.toLowerCase().startsWith(needle))) {
    rows.push({ room: here.room, count: bots.filter(bot => bot.kind !== 'human').length, text: `@${everyone} ` })
  }
  // Friends' remote Bots are members of every chat, marked remote. Not of a face-to-face
  // room: only the Bots in that room can be reached there, each listed once above (#305).
  if (face) return rows
  // A friend's Bot is offered once (#384). In a group its seat stays (the name the room routes on)
  // and the remote member row goes; in a Bot's chat, its chat row gives way to the remote member
  // row, which inserts its handle.
  const seatHandles = new Set(bots.filter(bot => bot.remote).map(bot => normHandle(remoteRecord(bot)?.handle)).filter(Boolean))
  if (here.room) return [...rows, ...remoteMentionRows(roster, query).filter(row => !seatHandles.has(normHandle(row.remote.handle)))]
  const remoteHandles = new Set(remoteMentionRows(roster, '').map(row => normHandle(row.remote.handle)))
  return [
    ...rows.filter(row => !(row.bot && remoteHandles.has(normHandle(remoteRecord(row.bot)?.handle)))),
    ...remoteMentionRows(roster, query),
  ]
}

const isFaceRoom = room => room?.origin === 'face-to-face'
const memberCount = count => t(count === 1 ? '{count} member' : '{count} members', { count })
const botCount = count => (count === 1 ? t('1 Bot') : t('{count} Bots', { count }))
const normHandle = handle => String(handle ?? '').trim().replace(/^@+/, '').toLowerCase()
// A friend's Bot chat in the roster: its remote record (the Bot itself in older rosters).
export const remoteRecord = bot => (bot?.remote ? (bot.remote === true ? bot : bot.remote) : null)
// As `faceSeats` names it: the owner name Bot Social stamped on my Bot's seat, else my own name.
const myOwnerName = (roster, live, bot) => {
  const seat = live.find(p => !p.remote && p.kind !== 'human' && (p.id === bot.id || (bot.handle && p.handle === bot.handle)))
  return cleanPeerName(seat?.ownerName || roster.self?.displayName, '')
}
const uniqueBy = (list, key) => {
  const seen = new Set()
  return list.filter((item) => {
    const k = key(item)
    if (!k || seen.has(k)) return !k
    seen.add(k)
    return true
  })
}
// In a face-to-face room a Bot is named as the Members panel names it, mine and a friend's
// alike: "Chief (Ann)", "Chief (Bob)" (#229, #305, #384, #457); "(you)" is for a person, never a
// Bot. Only the label changes; the inserted "@Name" stays the one the room routes on.
const faceLabel = (person, bot) => (person ? `${bot} (${person})` : bot)

// The chats a message here can reference: every other Bot's chat, then the latest
// conversations outside the team. Group chats stay out: a group's Session holds only
// the user's messages, so a snapshot of it would miss every Bot's reply.
export function chatRows(roster, list, sessionId) {
  const here = conversationOf(roster, sessionId)
  if (here === null) return []
  const byId = list?.byId ?? {}
  const bots = roster.bots.filter(bot => bot.id !== here.self?.id).map((bot) => {
    const id = currentPart(bot)
    return { sessionId: id, label: t('Chat with {name}', { name: bot.name }), bot, updatedAt: byId[id]?.updatedAt }
  })
  const team = new Set([
    ...roster.bots.flatMap(bot => [bot.id, currentPart(bot), ...(bot.parts ?? [])]),
    ...roster.rooms.flatMap(room => [room.id, ...(room.parts ?? [])]),
  ])
  const others = (list?.ids ?? []).map(id => byId[id])
    .filter(row => row !== undefined && row.id !== sessionId && !team.has(row.id) && row.origin !== 'subagent' && row.blank !== true)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, OTHER_CHATS_MAX)
    .map(row => ({ sessionId: row.id, label: row.displayTitle || row.title || row.id, updatedAt: row.updatedAt }))
  return [...bots, ...others]
}

// DSH's canonical session mention: `@[label](dsh-session:<base64url of the JSON id>)`.
// The host turns it into "@label" plus a read-only snapshot of that Session.
export function sessionMention(sessionId, label) {
  let binary = ''
  for (const byte of new TextEncoder().encode(JSON.stringify(sessionId))) binary += String.fromCharCode(byte)
  const payload = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `@[${label.replace(/[\\\]]/g, mark => `\\${mark}`)}](dsh-session:${payload})`
}

// `launched(sessionId)`: whether "+ → Reference a chat" opened the menu, so the chats
// never join a typed "@". `iconFor(row)` is the row's character mark.
export function atSources({ roster, sessions, launched, iconFor }) {
  const bots = {
    trigger: '@',
    name: BOTS_SOURCE,
    order: -20,
    showGroupTitle: false,
    async candidates(session, { query }) {
      const snapshot = roster.getSnapshot()
      const face = isFaceRoom(snapshot.roomsById?.[session.sessionId])
      const team = (mentionRows(snapshot, session.sessionId, query) ?? []).map(row => ({
        // A friend's Bot by its one name, "Chief (Bob)"; its handle is the second line (#384).
        name: row.bot?.remote && !face ? remoteBotTitle(remoteRecord(row.bot)) : row.bot ? (row.bot.label ?? row.bot.name) : row.remote ? remoteBotTitle({ ...row.remote, displayName: row.remote.name, ownerName: row.remote.owner || row.remote.homeName }) : t('Everyone'),
        ...(row.bot?.role && !face ? { description: row.bot.role } : {}),
        ...(row.remote ? { description: row.remote.handle } : {}),
        ...(row.bot?.remote && !face && remoteRecord(row.bot).handle ? { description: remoteRecord(row.bot).handle } : {}),
        // A face room counts the Bots in it, mine and everyone else's (#305, #457).
        ...(row.room ? { description: face ? botCount(row.count) : memberCount(row.count) } : {}),
        icon: iconFor(row),
        section: t('Bots'),
        value: row.text,
      }))
      // FlyBot plugins' rows (remote Bots...), only where the team's menu shows, and not in a
      // face-to-face room, whose Bots are all listed above (no separate Friends' Bots, #305).
      if (mentionRows(snapshot, session.sessionId, '') === null || face) return team
      const extra = (await mentionCandidates(query, { sessionId: session.sessionId, roster: snapshot })).map(row => ({
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        icon: row.icon ?? 'session',
        section: row.section ?? 'FlyBot',
        value: row.value,
      }))
      return [...team, ...extra]
    },
    onPick: ({ candidate }) => (candidate.value ? { text: candidate.value } : undefined),
  }
  const chats = {
    trigger: '@',
    name: CHATS_SOURCE,
    order: -10,
    showGroupTitle: false,
    async candidates(session) {
      if (!launched(session.sessionId)) return []
      return chatRows(roster.getSnapshot(), sessions.list.getSnapshot(), session.sessionId).map(row => ({
        name: row.bot ? row.bot.name : row.label,
        ...(row.updatedAt ? { description: relativeShort(row.updatedAt) } : {}),
        icon: row.bot ? iconFor(row) : 'session',
        section: row.bot ? t('Bots') : t('Conversations'),
        value: JSON.stringify({ sessionId: row.sessionId, label: row.label }),
      }))
    },
    onPick({ candidate }) {
      const { sessionId, label } = JSON.parse(candidate.value)
      const mention = sessionMention(sessionId, label)
      return { insert: { source: CHATS_SOURCE, ref: mention, label, appearance: 'session', clipboardText: mention } }
    },
    codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
  }
  return [bots, chats]
}
