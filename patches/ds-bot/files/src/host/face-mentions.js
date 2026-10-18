// Who "@" calls in a face-to-face room (#287). A room holds people from two homes, and each
// side draws a Bot with the label the picker gave it ("Friend's Chief", "Writer · Bob's Bot"),
// so a line typed on one home has to be read on the other by those labels too, and by handle.
// A friend's Bot is only ever matched here to be told apart from a local one: the local home
// never starts a turn for it. Pure: the room and the Bot lookup come in.
import { mentionSpans, unmatchedMentions } from '../shared/mentions.js'
import { remoteBotTitle } from '../shared/remote-label.js'
import { currentParticipants, isRemoteParticipant } from './room-membership.js'

const clean = value => String(value ?? '').trim()

// Every name one participant answers to, longest first is left to mentionSpans.
export function faceAliases(participant, name) {
  const owner = clean(participant.ownerName)
  const handle = clean(participant.handle).replace(/^@+/, '')
  const title = remoteBotTitle({ displayName: name, name, ownerName: owner, handle: participant.handle })
  const names = [name, participant.label, title, owner ? `${name} · ${owner}` : '', owner ? `${name} · ${owner}'s Bot` : '', handle]
  return [...new Set(names.map(clean).filter(Boolean))]
}

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
    for (const name of faceAliases(participant, bot.name)) if (!(fromFriend && theirs.has(name.toLowerCase()))) local.push({ name, bot })
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
  let all = false
  for (const span of mentionSpans(text, [...local, ...remote], options)) {
    if (span.all) all = true
    else if (span.bot.bot !== undefined) { if (!bots.includes(span.bot.bot)) bots.push(span.bot.bot) }
    else if (!friends.includes(span.bot.participant)) friends.push(span.bot.participant)
  }
  return { all, bots, friends, unmatched: unmatchedMentions(text, [...local, ...remote], options) }
}
