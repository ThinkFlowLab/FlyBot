// Group chats: the room log, members' group Sessions, rounds and @mentions, round
// reports, and the group tools (group_relay, read_own_chat, read_group_chat).
//
// Group chat rounds. A group chat is one shared, ordered conversation, so members
// speak one at a time: a turn starts only after the previous speaker has posted or
// passed, and it shows everything that arrived since that member last looked, plus
// the speaking order and the member's place in it. Nobody answers a room that has
// moved on, and nobody has to count lines to know who went before. A plain message
// goes to every member in roster order, admin first, or to the admin alone in admin
// mode; "@Name" picks members. A face-to-face room still logs a plain human line,
// but only "@Name" / "@all" starts a Bot turn. A reply that @mentions a member
// calls that member next, bounded per member and per round; the admin's calls reach
// further.
//
// Work does not hold a round up: a member that is still busy with tools a little after
// it started, or that is called while still at earlier work, lets the round go on. Its
// turn keeps running in its group Session, and what it ends with is posted to the group,
// where the member that asked for it answers.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from './tool-schema.js'
import { ROOM_LATE_ROUNDS, SOURCE_KIND } from './constants.js'
import { OWNER, OTHER, SCHEDULED, combine } from './turn-origin.js'
import { escapeRegExp, textOf } from './text.js'
import { mentionSpans } from '../shared/mentions.js'
import { GROUP_REF, output } from './tools.js'
import { failureLine } from './turns.js'
import { currentParticipants, isFaceRoom } from './room-membership.js'
import { FACE_LEAD_NOTE, FACE_LEAD_ROUTE, faceLeadIsRemote, faceMemberNote, faceRoster, isFaceLead } from './face-lead.js'
import { faceMentions } from './face-mentions.js'
import { stripSessionChips } from './delivery.js'
import { createDshRoomParticipant } from './room-participant.js'

const ROOM_LOG_MAX = 60
const ROOM_FIRST_LOOK = 12
const ROOM_DELTA_MAX = 24
const ROOM_EARLIER_MAX = 8
const ROOM_EXTRA_TURNS = 4
const ROOM_ADMIN_EXTRA_TURNS = 4
const ROOM_TURNS_EACH = 2
const ROOM_ADMIN_TURNS_EACH = 4
// A plain line in a face-to-face room lets this many local Bots answer (#295); a larger room is cut off here.
const FACE_PLAIN_SPEAKERS = 6

// Logs written before rooms were versioned get sequence numbers in place.
const ensureRoomLog = (room) => {
  if (typeof room.seq !== 'number') {
    room.log = (room.log ?? []).map((line, index) => ({ ...line, seq: index + 1 }))
    room.seq = room.log.length
  }
  room.seen ??= {}
}

let fanoutRoomLine = async () => {}
const appendRoom = (room, line) => {
  room.seq += 1
  const stamped = { ...line, seq: room.seq }
  room.log = [...room.log, stamped].slice(-ROOM_LOG_MAX)
  void fanoutRoomLine(room, stamped)
  return stamped
}

// One answer per Bot to a person's plain line in a face-to-face room (#295, #456). The room keeps the
// line's seq, the Bots that answered it and the turns it asked for; a Bot asked again for the same line
// (the line delivered twice, or a turn that went on working and posts late after a second one) passes.
// A newer person line ends it, so a follow-up is always answered.
const lastPersonLine = (room) => {
  const log = room.log ?? []
  for (let at = log.length - 1; at >= 0; at -= 1) {
    const line = log[at]
    if (!line.kind && line.botId === undefined && line.authorKind !== 'bot') return line
  }
  return undefined
}
const lastPersonSeq = room => lastPersonLine(room)?.seq ?? 0
// Another home's Bots that posted while this round answers the person's line (#475): each home runs its own round
// over its own Bots, so a friend's Bot that already answered or planned counts as this line's answer here too. A
// Bot post queued before the round started is not counted: it may be older than the line it is logged after.
const friendAnswers = (room, round) => {
  if (round.faceLine === undefined) return []
  const after = Math.max(round.faceLine, round.openedSeq ?? 0)
  const names = []
  for (const line of room.log ?? []) {
    if ((line.seq ?? 0) <= after || line.kind || line.botId === undefined || line.botId === 'face-notice' || room.members.includes(line.botId)) continue
    if (!names.includes(line.who)) names.push(line.who)
  }
  return names
}
const FACE_ASKED_KEPT = 24
const currentFaceLine = (room, seq) => (room.faceLine !== undefined && room.faceLine.seq === seq && lastPersonSeq(room) === seq ? room.faceLine : undefined)
// `authorId`: a friend's line is only tracked once it is in the log (applyFaceLine logs it first).
function openFaceLine(room, authorId) {
  const person = lastPersonLine(room)
  const seq = person?.seq ?? 0
  if (seq === 0 || (authorId !== undefined && person.authorId !== authorId)) return undefined
  if (room.faceLine?.seq !== seq) room.faceLine = { seq, answered: [], asked: [] }
  return seq
}

// Lines a face-room send already put in the log and on the wire; the round that answers them
// reads them from the Session too and must not append them a second time (#287).
const postedLines = new Map()
const takePosted = (roomId, text) => {
  const list = postedLines.get(roomId) ?? []
  const at = list.indexOf(text)
  if (at === -1) return false
  postedLines.set(roomId, list.toSpliced(at, 1))
  return true
}

// A member's own lines are already in its Session, so only the others' are news.
const unseenLines = (room, memberId) => {
  const since = room.seen[memberId]
  if (since === undefined) return room.log.slice(-ROOM_FIRST_LOOK)
  return room.log.filter(line => line.seq > since && line.botId !== memberId).slice(-ROOM_DELTA_MAX)
}

const lineText = (line) => {
  if (line.kind === 'lookup') return `[${line.who} looked up its own chat${line.text ? ` for "${line.text}"` : ''}]`
  if (line.kind === 'resumed') return `[${line.who}'s work here was cut off when DeepSeek Harness restarted; it is picking it back up and posts when done]`
  if (line.kind === 'cut') return `[${line.who}'s work here was cut off by a restart again, so it stopped; ask it to go on if it still matters]`
  if (line.kind === 'stopped') return `[The user stopped ${line.who}'s work here]`
  if (line.kind === 'joined' || line.kind === 'left' || line.kind === 'started' || line.kind === 'invited' || line.kind === 'notice') {
    return line.text ? `[${line.text}]` : `[${line.who} ${line.kind}]`
  }
  return `${line.who}: ${line.text}`
}
const transcript = lines => lines.map(lineText).join('\n')

// Models often echo the transcript format ("Name: …") despite the instruction.
export const stripOwnName = (name, text) => text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()
export const isPass = text => text === '' || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(text)

// Who "@" calls, in order, by the same rule the bubbles draw. `references` are the
// round's referenced conversations: each one's "@label" is a reference, not a call.
// Pass every member, the speaker too, so "@新 Bot 2" said by 新 Bot 2 is never read as
// a call to 新 Bot; the caller drops the speaker.
export const mentionsIn = (text, members, references = []) => {
  const found = []
  let all = false
  for (const span of mentionSpans(text, members, { references: references.flatMap(reference => reference.labels) })) {
    if (span.all) all = true
    else if (!found.includes(span.bot)) found.push(span.bot)
  }
  return { all, found }
}

// What the user referenced in this round, for a member that has not been shown it yet.
export const referenceNote = references => (references?.length
  ? `Conversations the user referenced in this round:\n\n${references.map(reference => reference.text).join('\n\n')}`
  : '')

const ROOM_REPLY = 'Reply with your message for the group, no name prefix: in a discussion, one or two short messages. When you are asked to do something, do it now with your tools. The group does not wait for you, and your final reply is posted here when you finish, so give the result, never a promise to do it later. Reply [PASS] to stay silent when you have nothing new to add or the message is for someone else.'
// Words that address the whole room: a plain line with one of them may get an answer from each Bot (#299).
const ROOM_EVERYONE = /大家|你们|各位|所有人|所有 ?[Bb]ot|每个人|每位|各自|分别|everyone|everybody|y'?all|you all|all of you|each of you|introduce yourselves/i
const ROOM_REPLY_FORCED = 'Reply with your message for the group, no name prefix, short. Do not reply [PASS].'
const ROOM_CALLS = 'Writing "@Name" calls that member next, to answer or to do what you ask; when it finishes work you gave it, you answer its result. To only mention a member, write its name without "@".'

const slotLabel = (slot) => {
  if (slot.status === 'speaking') return `${slot.name} (you, now)`
  if (slot.status === 'posted') return `${slot.name} (posted)`
  if (slot.status === 'passed') return `${slot.name} (passed)`
  if (slot.status === 'missed') return `${slot.name} (no answer)`
  if (slot.status === 'working') return `${slot.name} (working on it; posts when done)`
  if (slot.status === 'waiting-approval') return `${slot.name} (waiting for the user's approval; posts when done)`
  if (slot.status === 'failed') return `${slot.name} (could not answer: error)`
  if (slot.status === 'left') return `${slot.name} (left the group)`
  return slot.name
}

// A face-to-face room's admin is its lead (#476), with the lead's rules instead.
const adminNote = room => isFaceRoom(room) ? FACE_LEAD_NOTE : [
  'You are this group\'s admin.',
  room.mode === 'admin' ? 'Plain messages come to you first: answer them, or call the members who should answer with @Name.' : '',
  '"@all" calls every member. When the user asks, change the group with update_group.',
].filter(Boolean).join(' ')

const ROOM_READ_MAX = 30

export function install(rt) {
  const { ctx } = rt
  const participant = createDshRoomParticipant(rt)
  fanoutRoomLine = (room, line) => rt.fanoutRoomLine?.(room, line)
  rt.notePostedLine = (roomId, text) => postedLines.set(roomId, [...(postedLines.get(roomId) ?? []), text].slice(-20))

  // A member's group Session, created on its first turn there. A new one starts with
  // a fresh look at the log and a brief of the member's own chat; the brief is the
  // first message, so it stays fixed and the prefix stays cacheable.
  // The brief is the member's owner's private chat with the Bot. In a room where
  // another owner sits it stays out unless that owner shared it with this room (#53).
  const briefAllowed = (room, member) => {
    if (!rt.authzEnforced?.()) return true
    const participants = currentParticipants(room)
    const owners = new Set([rt.botOf(member.id)?.ownerId])
    for (const p of participants) {
      if (p.kind === 'human') owners.add(p.id)
      // A granted remote Bot speaks for another home; its handle stands for that owner.
      else if (p.remote) owners.add(p.handle)
      else owners.add(rt.botOf(p.id)?.ownerId)
    }
    owners.delete(undefined)
    if (owners.size <= 1) return true
    return participants.some(p => p.kind === 'bot' && p.id === member.id && p.briefShared === true)
  }

  async function groupSessionFor(room, member) {
    const session = await participant.open({ room, member })
    return { id: session.id, brief: session.created && briefAllowed(room, member) ? await rt.ownChatBrief(member) : undefined }
  }

  // A plain line in a face-to-face room (#299): the Bots decide who answers. Each gets this note, so one
  // Bot answers a specific question, a follow-up goes to the Bot that just spoke, and a line to everyone may
  // get a short answer from each. A pass posts nothing.
  function routeNote(room, member, round) {
    const { broadcast, last, forced } = round.route
    if (forced === member.id) return 'The user asked this and nobody else answered. Answer now: if the line is plainly for another owner\'s Bot, say that in one short sentence.'
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const roles = everyone.filter(bot => bot.role).map(bot => `${bot.name}${bot.id === member.id ? ' (you)' : ''}: ${String(bot.role).slice(0, 80)}`)
    const friends = currentParticipants(room).filter(p => p.kind === 'bot' && p.remote).map(p => p.label || p.displayName).filter(Boolean)
    const answered = friendAnswers(room, round)
    return [
      'This line names no Bot, and the group should get the right answer, not one from everyone. Decide whether it is yours.',
      broadcast
        ? 'It is addressed to everyone (introductions, what each of you can do, a round of opinions): give your own short answer, but reply [PASS] if it would only repeat what a Bot before you said.'
        : isFaceLead(room, member)
          ? FACE_LEAD_ROUTE
          : 'Default to [PASS]: exactly one Bot answers a line like this, and the first Bot that answers ends it, so the Bots after it are not asked. Answer only if it is for you: it names you or your role, no other member\'s role fits it better, or it follows up on your own last answer. Reply [PASS] when it is for another Bot by name or role, when it follows up on another Bot\'s answer, or when you would only be guessing.',
      last && !broadcast ? `${last.name} spoke last before this line: a follow-up to what ${last.name} said ("what did you mean", "and then?", "say more") is for ${last.name}.` : '',
      roles.length > 0 ? `What members do: ${roles.join('; ')}.` : '',
      friends.length > 0 ? `Other owners' Bots here answer for themselves in their own home: ${friends.join(', ')}.` : '',
      answered.length > 0 ? `${answered.join(', ')} already answered this line or posted a plan; add only your role's part, and do not re-plan or repeat it.` : '',
      '[PASS] posts nothing and nobody sees it: never explain a pass.',
    ].filter(Boolean).join(' ')
  }

  // Lines from before the round's opening message are kept apart from this round, so
  // an earlier round (an old count-off, say) never reads as part of the current one.
  function roomPrompt(room, member, round) {
    const peers = room.members.filter(id => id !== member.id).map(rt.botOf).filter(Boolean)
      .map(bot => `${bot.name}${rt.isAdminOf(room, bot.id) ? ' (admin)' : ''}`)
    const leads = rt.isAdminOf(room, member.id)
    const lines = unseenLines(room, member.id)
    const earlier = lines.filter(line => line.seq < round.startSeq).slice(-ROOM_EARLIER_MAX)
    const current = lines.filter(line => line.seq >= round.startSeq)
    const spokeThisRound = (room.seen[member.id] ?? 0) >= round.startSeq
    const index = round.slots.findIndex(slot => slot.status === 'speaking')
    const before = index
    const after = round.slots.length - index - 1
    const members = `${isFaceRoom(room) ? `${faceRoster(room, member, rt.botOf)}\n` : `Members: the user${peers.length ? `, ${peers.join(', ')}` : ''} and you${leads ? ' (admin)' : ''}. `}Members speak one at a time; each message is posted before the next speaker starts. ${ROOM_CALLS}`
    const notice = room.notice ? `Group notice (shared instructions for every member):\n${room.notice}` : ''
    const working = workingIn(room).filter(item => item.bot.id !== member.id)
    return [
      members,
      notice,
      leads ? adminNote(room) : faceMemberNote(room, member, rt.botOf),
      earlier.length ? `Earlier in the group, before this round (context only):\n${transcript(earlier)}` : '',
      current.length
        ? `This round so far${spokeThisRound ? ', since your last message' : ', starting with the new message'} (oldest first):\n${transcript(current)}`
        : 'Nothing new in this round since your last message.',
      round.shown?.includes(member.id) ? '' : referenceNote(round.references),
      working.length > 0 ? `Still at work on what they were asked; each posts here when done: ${working.map(item => `${item.bot.name} (${minutesSince(item.since)} min)`).join(', ')}.` : '',
      `Speaking order for this round: ${round.slots.map(slotLabel).join(' → ')}.`,
      `You are number ${index + 1} of ${round.slots.length}. ${before === 0 ? 'Nobody spoke before you' : `${before} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`,
      round.route ? routeNote(room, member, round) : '',
      round.route?.forced === member.id ? ROOM_REPLY_FORCED : ROOM_REPLY,
    ].filter(Boolean).join('\n\n')
  }

  // Members whose turn in this group is running, and since when.
  const workingIn = room => room.members.flatMap((id) => {
    const entry = participant.snapshot(room.sessions?.[id])
    const bot = rt.botOf(id)
    return entry.working && bot !== undefined ? [{ bot, since: entry.since ?? Date.now() }] : []
  })
  const minutesSince = at => Math.max(1, Math.round((Date.now() - at) / 60000))

  // A called member moves up if it is still waiting, or gets one more turn if it
  // already spoke; either way it goes right after slot `index`. `cap` is the caller's
  // per-member turn bound for the round; `by` is the calling member, if a member called.
  function callMembers(round, turns, index, callees, note, cap, by) {
    let next = index + 1
    for (const peer of callees) {
      if ((turns.get(peer.id) ?? 0) >= cap) continue
      const waiting = round.slots.findIndex((other, at) => at > index && other.id === peer.id && other.status === 'waiting')
      const called = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots.splice(waiting, 1)[0]
      called.note = note
      if (by === undefined) delete called.by
      else called.by = by
      round.slots.splice(next, 0, called)
      next += 1
    }
  }

  // The user's messages waiting in the group Session's inbox while a round runs, from
  // the composer whether it queued or steered them. Images and chat references are
  // only read when the Session takes the message itself, so a message with either
  // stays for the next round, and so does everything after it in that list.
  const waitingLines = agent => ['nextStep', 'nextTurn'].flatMap((list) => {
    const lines = []
    for (const message of agent?.inbox?.[list] ?? []) {
      if (message.source?.kind !== 'user') continue
      const content = Array.isArray(message.content) ? message.content : []
      const text = textOf(content)
      if (text === '' || content.some(block => block?.type !== 'text') || text.includes('dsh-session:')) break
      lines.push({ id: message.id, text })
    }
    return lines
  })

  // Messages the user sent while this round is running post into the log before the
  // next speaker, so everyone still to speak sees them. The members the message's own
  // round would open with answer it next, inside this round. Each message leaves the
  // Session's inbox, so it does not open another round when this one ends. Returns
  // the number of turns added, which the round's limit allows for.
  function drainRoomInbox(room, round, turns, index, agent) {
    const lines = waitingLines(agent).filter(line => agent.inbox.remove(line.id))
    if (lines.length === 0) return 0
    const before = round.slots.length
    const members = room.members.map(rt.botOf).filter(Boolean)
    // The owner's own typed line reaches a face round through the Session inbox, not as the round's opener (the opener
    // is the quiet "name: text" notice), so it is routed here (#299). A line added to a round that already routes
    // is answered by the rule for its own opening, so that round stops routing.
    const starting = round.route === undefined && round.slots.length === 0
    delete round.route
    for (const line of lines) {
      if (!takePosted(room.id, line.text)) appendRoom(room, rt.authoredRoomLine?.(room, { who: line.authorName || 'User', text: line.text, authorId: line.authorId, authorKind: line.authorKind || 'human' }) ?? { who: 'User', text: line.text })
      round.replies.push({ kind: 'user', text: line.text, time: Date.now(), authorId: line.authorId, authorKind: line.authorKind, name: line.authorName })
      const { all, found } = mentionsIn(line.text, members)
      const note = all || found.length > 0 ? 'the user mentioned you' : 'new message from the user'
      let speakers = openingSpeakers(room, { text: line.text })
      // Lines queued together are routed by the newest one.
      if (starting && line === lines.at(-1)) {
        const route = routeFor(room, { text: line.text }, round.startSeq)
        if (route) {
          round.route = route
          round.single = true
          round.faceLine = openFaceLine(room)
          speakers = lastFirst(speakers, route)
        }
      }
      callMembers(round, turns, index - 1, speakers, note, ROOM_ADMIN_TURNS_EACH)
    }
    // The user spoke in this room, so late replies may be answered again.
    room.lateRounds = 0
    void rt.save().catch(() => {})
    return round.slots.length - before
  }

  // The routing of a person's plain line in a face-to-face room (not @all): who decides, whether it is to everyone,
  // who spoke last, and whether the user must be answered if every Bot passes (the owner's own line, not a friend's).
  function routeFor(room, opener, startSeq) {
    if (!isPlainFaceLine(room, opener) || opener.everyone) return undefined
    const broadcast = ROOM_EVERYONE.test(opener.text ?? '')
    return { broadcast, fallback: opener.plain !== true, last: broadcast ? undefined : recentSpeaker(room, startSeq) }
  }
  // The Bot that spoke last is asked first.
  function lastFirst(speakers, route) {
    const at = route?.last && !route.last.remote ? speakers.findIndex(bot => bot.id === route.last.id) : -1
    if (at > 0) speakers.unshift(...speakers.splice(at, 1))
    return speakers
  }

  // A routed, non-broadcast round where a Bot already posted, is working on it or waits for the owner's approval,
  // or where another home's Bot already answered the line (#475).
  const answeredAlready = (room, round) => round.route !== undefined && !round.route.broadcast && round.route.forced === undefined
    && (round.slots.some(slot => slot.status === 'posted' || slot.status === 'working' || slot.status === 'waiting-approval')
      || friendAnswers(room, round).length > 0)

  // True once a routed round ended with every Bot silent on the owner's own line (a friend's line is not
  // forced: the friend's own home answers it). A line that follows up a friend's Bot is theirs to answer, and
  // a line a friend's Bot already answered is answered (#475). A room led by another home's Bot is
  // that lead's to answer (#476); with no lead known, my own lead, or a lead who left, the fallback stays.
  function fallbackDue(room, round) {
    const route = round.route
    if (!route?.fallback || route.forced !== undefined || (route.last?.remote && !route.broadcast)) return false
    if (friendAnswers(room, round).length > 0) return false
    // Another home's Bot leads this room (#476): it answers what my Bots leave, so mine are not forced.
    if (faceLeadIsRemote(room)) return false
    const states = round.slots.map(slot => slot.status)
    return !states.some(status => status === 'posted' || status === 'working' || status === 'waiting-approval' || status === 'speaking' || status === 'waiting')
      && states.some(status => status === 'passed' || status === 'missed')
  }

  // The Bot that answered the exchange right before this line (a Bot's post, once the person's own line or
  // lines are set aside), for follow-ups such as "then what did you say about X?" (#299).
  function recentSpeaker(room, startSeq) {
    const lines = (room.log ?? []).filter(line => !line.kind)
    let at = lines.length - 1
    while (at >= 0 && (lines[at].seq ?? 0) >= startSeq) at -= 1
    while (at >= 0 && lines[at].authorKind === 'human' && !lines[at].botId) at -= 1
    const line = lines[at]
    if (!line?.botId) return undefined
    const local = rt.botOf(line.botId)
    return local && room.members.includes(local.id) ? { id: local.id, name: local.name, remote: false } : { id: line.botId, name: line.who, remote: true }
  }

  // Whose request a round answers (turn-origin.js). Its member turns are delivered by the host, which
  // would stamp them as the owner's, so the round carries the strictest verdict of the Bot posts that
  // opened it: a Bot post that was itself asked by someone else (a friend driving a Main Bot that posts
  // here) makes every member turn of the round someone else's, and so does a post nobody vouched for.
  // A person's own line has no verdict here: other people in the room are caught when the turn is
  // judged (settled() reads the room at the moment of each call).
  const roundOrigins = new WeakMap()
  const postOrigin = (post) => {
    if (post.notice || post.failed || post.resumed || post.stopped || post.botId === 'face-notice') return undefined
    if (post.botId === undefined) return undefined
    const bot = rt.botOf(post.botId)
    if (bot === undefined || bot.remote !== undefined) return OTHER
    return post.origin === OWNER || post.origin === SCHEDULED ? OWNER : OTHER
  }
  const originOfPosts = posts => posts.reduce((verdict, post) => combine(verdict, postOrigin(post)), undefined)

  async function runRound(room, round, signal, agent) {
    let limit = round.slots.length + ROOM_EXTRA_TURNS + (room.admin ? ROOM_ADMIN_EXTRA_TURNS : 0)
    const turns = new Map()
    // The inbox check keeps a message sent during the last speaker's turn inside
    // this round: it drains at the loop's head even once the slots ran out.
    for (let index = 0; (index < round.slots.length || waitingLines(agent).length > 0 || fallbackDue(room, round)) && round.turns < limit; index += 1) {
      if (signal.aborted) break
      limit += drainRoomInbox(room, round, turns, index, agent)
      // Everyone passed on the owner's own plain line: the first Bot that passed answers, so the user is never ignored (#299).
      if (index >= round.slots.length && fallbackDue(room, round)) {
        const first = round.slots.find(slot => slot.status === 'passed' || slot.status === 'missed')
        round.route.forced = first.id
        round.slots.push({ id: first.id, name: first.name, status: 'waiting', note: 'nobody answered yet' })
        limit += 1
      }
      if (index >= round.slots.length) break
      const slot = round.slots[index]
      const member = rt.botOf(slot.id)
      // Settings may change mid-round, for example when the admin removes someone.
      if (member === undefined || !room.members.includes(slot.id)) {
        slot.status = 'left'
        continue
      }
      // One answer for a line that is not for everyone (#299): once a Bot has answered, the Bots still waiting are not
      // asked at all (no model call, no line), so three Bots never post three similar answers.
      if (answeredAlready(room, round) || currentFaceLine(room, round.faceLine)?.answered.includes(member.id)) {
        slot.status = 'passed'
        round.passed.push(member.name)
        continue
      }
      slot.status = 'speaking'
      round.speaking = member.id
      round.turns += 1
      turns.set(member.id, (turns.get(member.id) ?? 0) + 1)
      let session
      try {
        session = await groupSessionFor(room, member)
      } catch (error) {
        rt.warn('ds-bot: group Session for %s in %s failed: %s', member.name, room.name, error)
        round.speaking = null
        slot.status = 'failed'
        round.failed.push(member.name)
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code: 'SESSION', text: String(error?.message ?? error).slice(0, 300), time: Date.now() })
        continue
      }
      const prompt = roomPrompt(room, member, round)
      round.shown?.push(member.id)
      const text = session.brief === undefined ? prompt : `${session.brief}\n\n${prompt}`
      if (!signal.aborted) room.seen[member.id] = room.seq
      const exchangeId = randomUUID()
      // A turn asked for this line may post late; it still counts as this line's answer (#456).
      const asked = currentFaceLine(room, round.faceLine)
      if (asked !== undefined) asked.asked = [...asked.asked, exchangeId].slice(-FACE_ASKED_KEPT)
      const result = await participant.runTurn({ room, member, sessionId: session.id, text, note: slot.note ?? 'your turn', signal, started: round.started, by: slot.by, origin: roundOrigins.get(round), exchangeId })
      const reply = result === null || typeof result === 'object' ? result : stripOwnName(member.name, String(result ?? '').trim())
      round.speaking = null
      if (reply?.failure !== undefined) {
        // Not a pass: the user sees why the member is silent, and the round goes on.
        slot.status = 'failed'
        round.failed.push(member.name)
        const { code, status, message } = reply.failure
        round.replies.push({ kind: 'failed', botId: member.id, name: member.name, color: member.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
        continue
      }
      // The member's turn goes on in the background and posts when it ends.
      if (reply?.approval) {
        slot.status = 'waiting-approval'
        round.replies.push({ kind: 'approval', botId: member.id, name: member.name, color: member.color, time: Date.now() })
        continue
      }
      if (reply?.working) {
        slot.status = 'working'
        round.replies.push({ kind: 'working', botId: member.id, name: member.name, color: member.color, time: Date.now() })
        continue
      }
      if (reply === null || reply?.missed || isPass(reply)) {
        slot.status = typeof reply === 'string' ? 'passed' : 'missed'
        round.passed.push(member.name)
        if (reply?.missed) round.replies.push({ kind: 'missed', botId: member.id, name: member.name, color: member.color, time: Date.now() })
        continue
      }
      const heard = currentFaceLine(room, round.faceLine)
      // A second answer to the same line is dropped, never posted (#456).
      if (heard?.answered.includes(member.id)) {
        slot.status = 'passed'
        round.passed.push(member.name)
        continue
      }
      heard?.answered.push(member.id)
      slot.status = 'posted'
      const posted = appendRoom(room, rt.authoredRoomLine?.(room, { who: member.name, botId: member.id, authorId: member.id, authorKind: 'bot', text: reply }) ?? { who: member.name, botId: member.id, text: reply })
      // The line's seq lets the chat find its held state (#456).
      round.replies.push({ botId: member.id, name: member.name, color: member.color, text: reply, time: Date.now(), seq: posted.seq })
      void rt.save().catch(() => {})
      // Only the admin's "@all" calls everyone, so a member cannot set off a storm.
      const leads = rt.isAdminOf(room, member.id)
      const everyone = room.members.map(rt.botOf).filter(Boolean)
      const others = everyone.filter(other => other.id !== member.id)
      const { all, found: named } = mentionsIn(reply, everyone)
      const found = named.filter(other => other.id !== member.id)
      const callees = leads && all ? [...found, ...others.filter(other => !found.includes(other))] : found
      if (!round.single) callMembers(round, turns, index, callees, `${member.name} mentioned you`, leads ? ROOM_ADMIN_TURNS_EACH : ROOM_TURNS_EACH, member.id)
    }
  }

  ctx.tools.register(defineTool({
    name: 'group_relay',
    description: 'Group chat relay only. Deliver the latest user message to the Bots in this group chat, one at a time, and collect their replies.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(_args, exec) {
      await rt.load()
      const room = rt.roomOf(exec.agent?.id)
      if (room === undefined) return JSON.stringify({ error: 'Not a group chat' })
      ensureRoomLog(room)
      // Everything queued since the last relay is posted in order, so messages that the
      // Session folds into one turn are not lost; the newest one picks the speakers.
      const queued = rt.roomInbox.get(room.id) ?? []
      rt.roomInbox.delete(room.id)
      const posts = queued.length > 0 ? queued : [{ text: '' }]
      const startSeq = room.seq + 1
      // A member's late failure, its work picked up after a restart, or its work the user
      // stopped is an event of the round.
      const event = item => item.failed || item.resumed || item.stopped || item.notice || item.botId === 'face-notice'
      // A post a running round already showed and logged when it arrived (#455) is not logged again.
      for (const post of posts.filter(item => !event(item) && !item.shown)) {
        // Image readings go into the log only; `@` names are picked from what the user typed.
        const text = post.images === undefined ? post.text : [post.text, ...await rt.imagesForGroup(post.images, room.id)].filter(Boolean).join('\n')
        // A face-room line the send path already logged and sent is not logged or sent again (#287).
        if (!post.botId && takePosted(room.id, post.text)) continue
        logPost(room, post, text)
      }
      if (posts.some(post => !post.botId)) room.lateRounds = 0
      await rt.save()
      // An event post never picks the speakers over a message queued with it; a friend's line that asks
      // this home's Bots to answer is a person's line, not an event (#462).
      const opener = posts.findLast(post => !event(post) || friendAsks(post)) ?? posts.at(-1)
      const references = posts.flatMap(post => post.references ?? [])
      // A member a Bot's post calls by name works for that Bot.
      const named = opener.botId === undefined ? [] : mentionsIn(opener.text ?? '', room.members.map(rt.botOf).filter(Boolean)).found
      // A person's plain line (not @all) in a face-to-face room: the Bots decide who answers (#299). The
      // owner's own line is never left unanswered; a friend's attested line is answered by their home too.
      const route = routeFor(room, opener, startSeq)
      const speakers = lastFirst(openingSpeakers(room, opener), route)
      const round = {
        roomId: room.id,
        members: room.members,
        ...(route ? { route } : {}),
        startSeq,
        openedSeq: room.seq,
        ...(references.length > 0 ? { references, shown: [] } : {}),
        slots: speakers.map(member => ({
          id: member.id, name: member.name, status: 'waiting',
          ...(named.includes(member) ? { by: opener.botId } : {}),
        })),
        // One pass: a plain line's speakers do not call each other on (#295), so Bots in two homes cannot loop.
        ...(isPlainFaceLine(room, opener) ? { single: true } : {}),
        // A person's plain line, the friend's attested one too, is answered once per Bot (#456).
        ...(isPlainFaceLine(room, opener) ? { faceLine: openFaceLine(room, friendLine(opener) ? String(opener.human.authorId ?? '') : undefined) } : {}),
        speaking: null,
        turns: 0,
        replies: [],
        passed: [],
        failed: [],
        started: [],
      }
      roundOrigins.set(round, originOfPosts(posts))
      for (const post of posts.filter(item => item.failed)) {
        const bot = rt.botOf(post.botId)
        const { code, status, message } = post.failed
        round.failed.push(bot?.name ?? post.name)
        round.replies.push({ kind: 'failed', botId: post.botId, name: bot?.name ?? post.name, color: bot?.color, code, ...(status ? { status } : {}), text: message, time: Date.now() })
      }
      // The log line tells the admin and the other members on their next turn.
      for (const post of posts.filter(item => item.resumed || item.stopped)) {
        const bot = rt.botOf(post.botId)
        const name = bot?.name ?? post.name
        const kind = post.stopped ? 'stopped' : post.again ? 'cut' : 'resumed'
        appendRoom(room, { who: name, botId: post.botId, kind, text: '' })
        round.replies.push({ kind, botId: post.botId, name, color: bot?.color, time: Date.now() })
      }
      for (const post of posts.filter(item => (item.notice || item.botId === 'face-notice') && !item.shown)) {
        const text = String(post.text ?? '')
        if (!text) continue
        if (post.human) round.replies.push(personReply(post.human, text))
        else round.replies.push({ kind: 'notice', text, time: Date.now() })
      }
      if (posts.some(post => post.resumed || post.stopped)) await rt.save()
      rt.roomProgress.set(exec.callId, round)
      try {
        await runRound(room, round, exec.signal, exec.agent)
        // A scheduled task's run in this group fails with its members' failed turns (#473).
        if (round.failed.length > 0) rt.scheduleRoundFailed?.(room.id, round.failed)
      } catch (error) {
        rt.warn('ds-bot: group round in %s stopped: %s', room.name, error)
      } finally {
        rt.roomProgress.delete(exec.callId)
      }
      if (exec.signal?.aborted) {
        for (const turn of round.started) void participant.cancel({ sessionId: room.sessions?.[turn.botId] ?? turn.sessionId, exchangeId: turn.exchangeId })
      }
      await rt.save()
      for (const post of posts) {
        if (post.reportBack && rt.botOf(post.botId)) void reportRound(room, post, round)
      }
      exec.concludeTurn?.()
      return JSON.stringify({ replies: round.replies, passed: round.passed, ...(round.failed.length > 0 ? { failed: round.failed } : {}) })
    },
  }))

  // Private context enters a group only through this tool, and the group sees each use.
  ctx.tools.register(defineTool({
    name: 'read_own_chat',
    description: 'Read or search your own chat with the user, across all its parts, including earlier parts that left your working context. Each line starts with its anchor, such as [part 2 #1234 · 10-08 14:22]; long messages are cut. Pass the anchor as around to read that message in full, with what was said just before and after it. In a group chat the group sees that you looked, so share only what the group needs.',
    parameters: {
      query: { type: 'string', description: 'Words to look for in every part, separated by spaces. A message must have all of them; when none has, those with the most are shown. Omit for the latest messages' },
      around: { type: 'string', description: 'An anchor from an earlier result, such as "part 2 #1234": shows that message in full and the messages just before and after it' },
      part: { type: 'integer', description: 'Number of an earlier part: shows the handoff note you wrote when it ended' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const id = exec.agent?.id
      const owner = rt.groupOwners.get(id)
      const botId = owner?.botId ?? rt.chatOwners.get(id)
      if (botId === undefined) return 'Only Bots on the team can use read_own_chat.'
      const member = rt.botOf(botId)
      const room = rt.roomOf(owner?.roomId)
      const query = String(args.query ?? '').trim().slice(0, 80)
      const around = String(args.around ?? '').trim().slice(0, 40)
      const parts = rt.partsOf(botId)
      const number = Number.isInteger(args.part) ? args.part : undefined
      if (room !== undefined && member !== undefined) {
        ensureRoomLog(room)
        const text = query !== '' ? query : around !== '' ? `around ${around}` : number !== undefined ? `part ${number}` : ''
        appendRoom(room, { who: member.name, botId: member.id, kind: 'lookup', text })
        for (const round of rt.roomProgress.values()) {
          if (round.roomId === room.id) round.replies.push({ kind: 'lookup', botId: member.id, name: member.name, color: member.color, text, time: Date.now() })
        }
        void rt.save().catch(() => {})
      }
      const partsNote = parts.length > 1 ? `\n\nYour own chat has ${parts.length} parts: ${rt.partIndex(parts)}. Call read_own_chat with part N for the note that closed an earlier part, or with words to search all parts.` : ''
      if (query === '' && around !== '') {
        const found = await rt.aroundOwnChat(botId, around)
        if (found.error) return `${found.error}${partsNote}`
        if (found.lines.length === 0) return `Nothing was said around ${around}.${partsNote}`
        const heading = found.exact ? `around ${around}` : `with no message at ${around}; the nearest ones`
        return `Your own chat ${heading} (oldest first):\n${found.lines.join('\n')}${partsNote}`
      }
      if (query === '' && number !== undefined) {
        const part = parts[number - 1]
        if (part === undefined) return `Your own chat has no part ${number}.${partsNote}`
        if (part.endedAt === undefined) return `Part ${number} is the current one; it is in your context.${partsNote}`
        return `Part ${number} of your own chat (${rt.clock(part.startedAt)} – ${rt.clock(part.endedAt)}). The handoff note that closed it:\n${rt.noteText(part) ?? '(none: the part ended on a context overflow)'}${partsNote}`
      }
      if (query === '') {
        const lines = await rt.latestOwnChat(botId, { askingId: id })
        return lines.length === 0 ? `Your own chat is empty.${partsNote}` : `Your own chat (oldest first):\n${lines.join('\n')}${partsNote}`
      }
      const { lines, every } = await rt.searchOwnChat(botId, query, { askingId: id })
      if (lines.length === 0) return `Nothing in your own chat mentions "${query}".${partsNote}`
      const heading = every ? `messages mentioning "${query}"` : `no message has all of "${query}"; messages with the most of these words`
      return `Your own chat, ${heading} (oldest first):\n${lines.join('\n')}${partsNote}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read_group_chat',
    description: 'Read the latest messages of a group chat, including what you said there. You speak in groups from separate conversations, so your own chat does not show them. Main Bots may read any group; others the groups they are in.',
    parameters: { group: GROUP_REF },
    output,
    async execute(args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (rt.botOf(self) === undefined) return 'Only Bots on the team can read group chats.'
      const { room, error } = rt.pickRoom(args.group, self)
      if (error) return error
      ensureRoomLog(room)
      const botPart = rt.participantsOf?.(room)?.find(p => p.kind === 'bot' && p.id === self)
      const from = botPart?.joinedSeq ?? 0
      const lines = room.log.filter(line => (line.seq ?? 0) >= from).slice(-ROOM_READ_MAX)
      return lines.length === 0 ? `"${room.name}" has no messages yet.` : `Latest in "${room.name}" (oldest first):\n${transcript(lines)}`
    },
  }))

  // A Bot that posts never answers its own post. @mentions choose the speakers; else
  // the admin answers alone in admin mode, or first of everyone. What a member posts
  // after its round moved on is answered by the member that asked for it; work the
  // user asked for is left for the user to read.
  // A plain person's line in a face-to-face room: every local Bot may answer, the admin first, then the
  // room's order, one at a time (each sees the earlier replies), capped (#295).
  const plainSpeakers = (members, admin) => (admin ? [admin, ...members.filter(bot => bot !== admin)] : members).slice(0, FACE_PLAIN_SPEAKERS)

  // A friend's own typed line, as postHuman posts it (#180, #462): the room's quiet notice sender, carrying the person.
  const friendLine = post => post.botId === 'face-notice' && post.human !== undefined
  // One that asks this home's Bots to answer: attested plain (or @all), or naming my Bots (#287, #295).
  const friendAsks = post => friendLine(post) && (post.plain === true || post.callIds?.length > 0)

  // Whether this opener is a person's plain line there: the one that starts a single pass over the
  // Bots with no Bot-triggered follow-ups inside it (#295). An @ that names a Bot, a Bot's post, a late
  // reply is not.
  function isPlainFaceLine(room, opener) {
    if (!isFaceRoom(room) || opener.late) return false
    // A friend's attested plain line (or @all) is a person's line too, routed and single like the owner's (#462).
    if (friendLine(opener)) return opener.plain === true
    if (opener.botId !== undefined) return false
    if (opener.quiet || opener.callIds?.length > 0) return false
    const said = faceMentions(room, opener.text, rt.botOf, { references: (opener.references ?? []).flatMap(reference => reference.labels) })
    return !said.all && said.bots.length === 0 && said.friends.length === 0
  }

  function openingSpeakers(room, opener) {
    const everyone = room.members.map(rt.botOf).filter(Boolean)
    const members = everyone.filter(bot => bot.id !== opener.botId)
    const admin = members.find(bot => rt.isAdminOf(room, bot.id))
    // A friend's own typed line that @-calls Bots here (#287): only those Bots answer. The caller
    // resolved the names and only passes lines the server attests as typed by that person.
    if (opener.callIds?.length > 0) return members.filter(bot => opener.callIds.includes(bot.id))
    // A friend's own attested plain line (or their @all): this home's Bots answer too (#295). The caller only
    // sets `plain` on lines the server attests as typed by that person; a Bot's line never does.
    if (opener.plain && isFaceRoom(room)) return plainSpeakers(members, admin)
    if (opener.quiet) return []
    const { all, found: named } = mentionsIn(opener.text, everyone, opener.references)
    const found = named.filter(bot => bot.id !== opener.botId)
    if (opener.late) return found.length > 0 ? found : members.filter(bot => bot.id === opener.askedBy)
    // Face-to-face, the room's own person typing (#167, #287): @Name, the label the picker shows
    // ("Friend's Chief") or a handle picks that local Bot; a line to a friend's Bot starts none
    // here; a plain line lets every local Bot answer in one pass (#295): the admin first, then the room's
    // order, up to FACE_PLAIN_SPEAKERS, each after the earlier replies. @all stays everyone. Another person's line (postHuman) is quiet and never gets here
    // without callIds, and a Bot's post keeps the old rule below, so Bots in two homes cannot set
    // each other off.
    if (isFaceRoom(room) && opener.botId === undefined) {
      const said = faceMentions(room, opener.text, rt.botOf, { references: (opener.references ?? []).flatMap(reference => reference.labels) })
      if (!said.all) {
        const called = said.bots.filter(bot => bot.id !== opener.botId)
        if (called.length > 0) return called
        if (said.friends.length > 0) return []
        return plainSpeakers(members, admin)
      }
    }
    if (found.length > 0 && !all) return found
    // Face-to-face Bot posts: a plain one stays in the room; only @Name / @all calls a Bot (#167). Another
    // home's Bot's @all wakes none of mine (#475): only the local Bots it names answer.
    if (isFaceRoom(room) && (!all || (opener.botId !== undefined && !room.members.includes(opener.botId)))) return found
    if (!all && room.mode === 'admin' && admin) return [admin]
    return admin ? [admin, ...members.filter(bot => bot !== admin)] : members
  }

  // A post's line in the room log, as the relay writes it: a Bot's (mine or another home's) or a person's.
  function logPost(room, post, text) {
    return appendRoom(room, rt.authoredRoomLine?.(room, post.botId
      ? { who: rt.botOf(post.botId)?.name ?? post.name ?? 'Bot', botId: post.botId, authorId: post.botId, authorKind: 'bot', text }
      : { who: post.authorName || 'User', text, authorId: post.authorId, authorKind: post.authorKind || 'human' })
      ?? (post.botId
        ? { who: rt.botOf(post.botId)?.name ?? post.name ?? 'Bot', botId: post.botId, text }
        : { who: 'User', text }))
  }
  // Another person's own line as a round shows it: their bubble, never one of mine (#180).
  const personReply = (human, text) => ({ kind: 'user', other: true, text, authorId: human.authorId, authorKind: 'human', name: human.name, time: Date.now() })

  // A line that arrives while the group's Session is in a turn, whoever sends it (#455, #595): another
  // person's, another home's Bot's, or this home's own Bot's. DSH would hold a followup in the composer's
  // queue until the turn ends, shown raw with its "[Group post from …]" header and steerable as if the
  // owner had typed it. Instead the round that is running shows it at once, as that person's or Bot's
  // bubble (a Bot's line is logged then too, so the Bots still to speak see it; a person's line Bot Social
  // delivered is logged already), and the Session gets it once the turn is done, for the round its own
  // rules open (who answers, if anyone). A Bot's failure, stop or resume notice is held too, so its header
  // never reaches the composer, but the round does not draw it: group_relay draws it as that event.
  const heldPosts = new Map()
  const isEvent = extra => extra.notice === true || extra.failed !== undefined || extra.stopped === true || extra.resumed === true
  // Another person's line, another home's Bot's line, and this home's own Bot's line (#455, #595) are held
  // while the group runs; a room notice (the 'face-notice' sender) keeps the queue path: it is not a Bot's
  // line and the round draws it as a notice.
  const heldWhileRunning = (sender, extra) => extra.human !== undefined || extra.remote !== undefined
    || rt.botOf(sender.id) !== undefined
  function showInRound(room, sender, text, extra) {
    const round = [...rt.roomProgress.values()].findLast(entry => entry.roomId === room.id)
    if (round === undefined || text === '') return false
    if (extra.human) {
      round.replies.push(personReply(extra.human, text))
      return true
    }
    if (extra.remote) {
      logPost(room, { botId: sender.id, name: sender.name }, text)
      void rt.save().catch(() => {})
      // Another home's Bot is not a reply to the round, so a round report leaves it out (kind) and the chat
      // draws the friend's Bot.
      round.replies.push({ kind: 'remote', remote: true, botId: sender.id, handle: extra.remote.handle, name: sender.name, text, time: Date.now() })
      return true
    }
    // A failure, stop or resume notice, or another quiet post: held only, so its raw header never reaches
    // the composer; group_relay draws it as that event, not as this Bot's bubble.
    if (extra.quiet === true || isEvent(extra)) return false
    // This home's own Bot's ordinary line: logged, then drawn as the same bubble its own reply is.
    const posted = logPost(room, { botId: sender.id, name: sender.name }, text)
    void rt.save().catch(() => {})
    round.replies.push({ botId: sender.id, name: sender.name, color: rt.botOf(sender.id)?.color, text, time: Date.now(), ...(posted?.seq === undefined ? {} : { seq: posted.seq }) })
    return true
  }
  function holdPost(room, agent, sender, text, extra) {
    const shown = extra.shown === true || showInRound(room, sender, text, extra)
    const held = heldPosts.get(room.id) ?? []
    heldPosts.set(room.id, [...held, { sender, text, extra: shown ? { ...extra, shown: true } : extra }])
    if (held.length > 0) return
    void Promise.resolve().then(() => agent.whenIdle()).then(async () => {
      const waiting = heldPosts.get(room.id) ?? []
      heldPosts.delete(room.id)
      for (const post of waiting) await postToRoom(rt.roomOf(room.id) ?? room, post.sender, post.text, post.extra)
    }).catch(error => rt.warn('ds-bot: a line held for %s was not delivered: %s', room.name, error))
  }

  // A Bot's message into the group's own Session, which relays it as a new round.
  // Chips are stripped here and again in deliver() for Bot-to-Bot own-chat followups (#106).
  async function postToRoom(room, sender, text, extra = {}) {
    const agent = await rt.resolveAgent(room.id)
    if (agent.status === 'running' && typeof agent.whenIdle === 'function' && heldWhileRunning(sender, extra)) {
      holdPost(room, agent, sender, stripSessionChips(text), extra)
      return
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[Group post from ${sender.name}]\n${stripSessionChips(text)}` }],
      source: { kind: SOURCE_KIND, form: 'relay', role: 'post', exchangeId: randomUUID(), senderName: sender.name, senderSessionId: sender.id, roomId: room.id, hop: 0, ...extra },
    }))
    await ctx.sessions.flush(agent.session)
  }
  rt.postToRoom = postToRoom

  // A member the round moved on from (it went on working, went quiet or waited for an
  // approval) posts what its turn ended with. The member that asked for it and anyone
  // it names answer; past the late round limit nobody does, so late posts cannot keep a
  // group talking.
  async function lateRoomReply(sessionId, info, reply, origin) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const text = stripOwnName(member.name, reply)
    if (isPass(text)) return
    // A late answer to a face-room line this Bot already answered is dropped (#456).
    const heard = isFaceRoom(room) && room.faceLine?.asked?.includes(info.exchangeId) ? currentFaceLine(room, room.faceLine.seq) : undefined
    if (heard?.answered.includes(member.id)) {
      rt.warn('ds-bot: %s already answered this line in %s; its second answer is not posted', member.name, room.name)
      return
    }
    heard?.answered.push(member.id)
    const quiet = (room.lateRounds ?? 0) >= ROOM_LATE_ROUNDS
    if (!quiet) room.lateRounds = (room.lateRounds ?? 0) + 1
    await rt.save()
    await postToRoom(room, member, text, { late: true, origin: origin ?? OTHER, ...(info.askedBy ? { askedBy: info.askedBy } : {}), ...(quiet ? { quiet: true } : {}) })
      .catch(error => rt.warn('ds-bot: late group reply from %s failed: %s', member.name, error))
  }
  rt.lateRoomReply = lateRoomReply

  // The user stops a member's work in this group from the group's details. Messages
  // still waiting for that member here go with it.
  async function stopMemberWork(roomId, botId) {
    await rt.load()
    const room = rt.roomOf(roomId)
    const member = rt.botOf(botId)
    const sessionId = room?.sessions?.[botId]
    if (room === undefined || member === undefined || sessionId === undefined) return false
    if (!await participant.cancel({ sessionId })) return false
    await postToRoom(room, member, '', { quiet: true, stopped: true })
    return true
  }
  rt.stopMemberWork = stopMemberWork

  // The round said such a member posts when done; a failed model call is how it ended.
  // Nobody answers it.
  async function lateRoomFailure(sessionId, info, failure) {
    const owner = rt.groupOwners.get(sessionId)
    const room = rt.roomOf(owner?.roomId ?? info.roomId)
    const member = rt.botOf(owner?.botId)
    if (room === undefined || member === undefined || !room.members.includes(member.id)) return
    const { code, status, message } = failure
    const friendly = /api key|no api key|missing (?:api )?key|not configured|no model/i.test(String(message ?? ''))
      ? 'This Bot has no model set up yet.'
      : 'This Bot could not answer right now.'
    await postToRoom(room, member, `Could not finish: ${friendly}`, {
      late: true, quiet: true, failed: { code, ...(status ? { status } : {}), message },
    }).catch(error => rt.warn('ds-bot: late group failure from %s failed: %s', member.name, error))
  }
  rt.lateRoomFailure = lateRoomFailure

  async function reportRound(room, post, round) {
    const lines = round.replies.filter(reply => reply.kind === undefined).map(reply => `${reply.name}: ${reply.text}`)
    const waiting = round.replies.filter(reply => reply.kind === 'approval').map(reply => reply.name)
    const working = round.replies.filter(reply => reply.kind === 'working').map(reply => reply.name)
    const text = [
      lines.length > 0 ? `Replies to your post (oldest first):\n${lines.join('\n')}` : 'Nobody replied to your post.',
      working.length > 0 ? `Still working on it: ${working.join(', ')}. Each posts its result in the group when done, not to you; read_group_chat shows it.` : '',
      waiting.length > 0 ? `Waiting for the user's approval: ${waiting.join(', ')}. What they say afterwards is posted in the group, not sent to you; read_group_chat shows it.` : '',
      round.passed.length > 0 ? `Stayed silent: ${round.passed.join(', ')}.` : '',
      round.failed.length > 0 ? `Could not answer because their model call failed: ${round.replies.filter(reply => reply.kind === 'failed').map(reply => `${reply.name} (${failureLine({ code: reply.code, status: reply.status, message: reply.text })})`).join(', ')}.` : '',
    ].filter(Boolean).join('\n\n')
    // The replies are what the room's members said, so the report is the owner's request only when the
    // round was and nobody but the owner's own Bots is in the room.
    const poster = rt.botOf(post.botId)
    const origin = roundOrigins.get(round) === OTHER || poster === undefined || rt.othersInRoom(room, poster).length > 0 ? OTHER : OWNER
    await rt.deliver({ toId: post.botId, role: 'report', roomId: room.id, text, hop: (post.hop ?? 0) + 1, origin })
      .catch(error => rt.warn('ds-bot: group report to %s failed: %s', post.name, error))
  }

  // A group chat's own Session never consults the model: models drift from "only call
  // group_relay" (they message one member directly when the user names it), so the
  // relay step is synthesized here. Auxiliary calls such as titles, and DS Bot's own
  // calls for the room such as image readings, still reach the model.
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined || options.purpose !== undefined || rt.ownRequest(options)) return next()
    return (async function* relayOrPass() {
      await rt.load()
      if (rt.roomOf(options.sessionId) === undefined) {
        yield* next()
        return
      }
      // Plugins append context as user-role messages (time, attachments), so only a
      // message from the user, a scheduled task, or a Bot's post after the last model or
      // tool step starts a relay.
      const opens = message => message.role === 'user'
        && (message.source?.kind === 'user' || message.source?.kind === 'schedule' || (message.source?.kind === SOURCE_KIND && message.source.role === 'post'))
      const latest = [...options.messages].reverse()
        .find(message => message.role === 'assistant' || message.role === 'tool' || opens(message))
      if (latest?.role !== 'user') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const id = `toolu_relay_${randomUUID().replace(/-/g, '')}`
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'group_relay', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'group_relay', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })()
  })
}
