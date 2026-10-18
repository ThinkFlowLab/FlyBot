// Who "@" calls in a face-to-face room (#287). A room holds people from two homes, and each
// side draws a Bot with the label the picker gave it ("Friend's Chief", "Writer · Bob's Bot"),
// so a line typed on one home has to be read on the other by those labels too, and by handle.
// A friend's Bot is only ever matched here to be told apart from a local one: the local home
// never starts a turn for it. Pure: the room and the Bot lookup come in.
import { mentionSpans, unmatchedMentions } from '../shared/mentions.js'
import { faceAliases } from '../shared/remote-label.js'
import { currentParticipants, isRemoteParticipant } from './room-membership.js'

const clean = value => String(value ?? '').trim()

// The aliases are shared with the chat bubble, which draws the same names as chips (#305).
export { faceAliases }

// A handle as one comparable key ("@Chief.Bob" and "chief.bob" are the same Bot), or ''.
export const handleKey = value => clean(value).replace(/^@+/, '').toLowerCase()
// The handle a mention list carries: lowercase, with the "@" Bot Social writes.
const wireHandle = value => (handleKey(value) === '' ? '' : `@${handleKey(value)}`)


// { local: [{ name, bot }], remote: [{ name, participant }] }: one entry per alias.
export function faceCandidates(room, botOf, { fromFriend = false } = {}) {
  const local = []
  const remote = []
  // A friend typing a bare "@Chief" may mean their own Chief: when a friend's Bot in the room
  // has the same bare name, only a label or handle calls the local one.
  const theirs = new Set(currentParticipants(room).filter(isRemoteParticipant).map(p => clean(p.displayName || p.name).toLowerCase()))
  for (const participant of currentParticipants(room)) {
    if (participant.kind !== 'bot') continue
    if (isRemoteParticipant(participant)) {
      for (const name of faceAliases(participant, clean(participant.displayName || participant.name || participant.handle))) remote.push({ name, participant })
      continue
    }
    const bot = botOf(participant.id)
    if (bot === undefined || !(room.members ?? []).includes(bot.id)) continue
    for (const name of faceAliases(participant, bot.name)) if (!(fromFriend && theirs.has(name.toLowerCase()))) local.push({ name, bot, participant })
  }
  // A local member the room has no participant record for still answers to its own name.
  for (const id of room.members ?? []) {
    const bot = botOf(id)
    if (bot !== undefined && !local.some(entry => entry.bot === bot) && !(fromFriend && theirs.has(clean(bot.name).toLowerCase()))) local.push({ name: bot.name, bot })
  }
  return { local, remote }
}

export function faceMentions(room, text, botOf, { fromFriend = false, ...options } = {}) {
  const { local, remote } = faceCandidates(room, botOf, { fromFriend })
  const bots = []
  const friends = []
  const handles = []
  let all = false
  for (const span of mentionSpans(text, [...local, ...remote], options)) {
    if (span.all) { all = true; continue }
    if (span.bot.bot !== undefined) { if (!bots.includes(span.bot.bot)) bots.push(span.bot.bot) }
    else if (!friends.includes(span.bot.participant)) friends.push(span.bot.participant)
    const handle = wireHandle(span.bot.participant?.handle)
    if (handle !== '' && !handles.includes(handle)) handles.push(handle)
  }
  // `handles`: the server handle of every Bot the line @-names, mine and friends' alike: the explicit
  // mention list a sender attaches (#293). @all is not a Bot and has no handle.
  return { all, bots, friends, handles, unmatched: unmatchedMentions(text, [...local, ...remote], options) }
}

// The receiving end of an explicit mention list (#293): resolve the sender's handles against the
// room's current participants. `bots` are the local Bots called; `known` counts the handles that
// are in this room at all (mine or a friend's), so a list that names only friends' Bots calls
// nobody here and a list of handles this room has never seen can fall back to reading the text.
export function mentionedByHandle(room, handles, botOf) {
  const wanted = new Set((Array.isArray(handles) ? handles : []).map(handleKey).filter(Boolean))
  const bots = []
  let known = 0
  if (wanted.size === 0) return { bots, known }
  for (const participant of currentParticipants(room)) {
    if (participant.kind !== 'bot' || !wanted.has(handleKey(participant.handle))) continue
    known += 1
    if (isRemoteParticipant(participant)) continue
    const bot = typeof botOf === 'function' ? botOf(participant.id) : undefined
    if (bot !== undefined && (room.members ?? []).includes(bot.id) && !bots.includes(bot)) bots.push(bot)
  }
  return { bots, known }
}
