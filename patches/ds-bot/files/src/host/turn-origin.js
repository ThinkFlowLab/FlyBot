// Whose request a Bot turn answers (#335, #369). Connector tools (the owner's mail, calendar,
// repositories) are the owner's: a turn the owner started may use them, and a turn someone else
// started (a friend, another room member, another owner's Bot, a Bot that itself was asked by one of
// them) only if the owner allowed it for shared use. The verdict is read from the messages a turn
// took in, never from what the Bot says about itself:
//
//   'owner'      the owner typed it, answered a question card, or a Bot of the same owner passed on a
//                request that was itself the owner's;
//   'scheduled'  a due scheduled task: the owner's while the Bot is not shared (DSH gives the task no
//                author, and a Bot can create tasks, so a shared Bot's tasks cannot be told apart);
//   'other'      everything else that carries someone's words: a friend's message, a line in a room
//                with other people in it, a Bot of another owner, a relay nobody vouched for;
//   (nothing)    a message that carries no one's request (DSH's own notices, a handoff note, a
//                receipt): it neither grants nor takes away.
//
// A turn's verdict is the strictest of its messages ('other' beats everything and sticks for the
// rest of the turn), and a turn that took in no message with a verdict has none. The caller treats
// "none" as 'other' (fail closed).
import { REPLY_KIND, SOURCE_KIND } from './constants.js'

export const OWNER = 'owner'
export const OTHER = 'other'
export const SCHEDULED = 'scheduled'

// The verdict of one message `source` (DSH's `user/message` event) to a Bot.
export function originOfSource(source, bot) {
  if (source === undefined || source === null || typeof source !== 'object') return OTHER
  switch (source.kind) {
    case 'user':
      // A signed-in member's line carries its author; it counts only for that Bot's owner.
      if (typeof source.authorId === 'string' && source.authorId !== '') return bot?.ownerId !== undefined && source.authorId === bot.ownerId ? OWNER : OTHER
      return OWNER
    case REPLY_KIND:
      return OWNER
    case 'schedule':
      return SCHEDULED
    case SOURCE_KIND:
      if (source.remote !== undefined || source.form === 'remote-chat') return OTHER
      // A host notice about what the user did, and the note a Bot's own part switch hands on.
      if (source.role === 'mention') return undefined
      if (source.handoff === true && source.resume !== true) return undefined
      return source.origin === OWNER || source.origin === SCHEDULED ? source.origin : OTHER
    default:
      return undefined
  }
}

// Two verdicts of one turn: the strictest wins, and "none" yields to the other.
export function combine(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  if (a === OTHER || b === OTHER) return OTHER
  return a === SCHEDULED || b === SCHEDULED ? SCHEDULED : OWNER
}

// The verdict that holds right now for the turn a Session is running: 'owner', 'other', or
// undefined when the Session runs no turn or no message of it carried a verdict. `entry` is the
// Session's `rt.live` record; the checks here read the team as it is at this moment, so a person
// who joins a room mid-turn counts from then on.
export function settled(rt, sessionId, entry = rt.live?.get(sessionId)) {
  if (entry?.turn === undefined || entry.origin === undefined) return undefined
  if (entry.origin === OTHER) return OTHER
  const bot = rt.botOf(rt.selfOf(sessionId))
  if (bot === undefined) return OTHER
  if (entry.origin === SCHEDULED && rt.sharedWith(bot.id).length > 0) return OTHER
  const owner = rt.groupOwners.get(sessionId)
  if (owner !== undefined) {
    // A room's lines come from everyone in it, so a turn there is the owner's only while nobody
    // but the owner's own Bots and the owner are in the room.
    const room = rt.roomOf(owner.roomId)
    if (room === undefined || rt.othersInRoom(room, bot.id).length > 0) return OTHER
  }
  return OWNER
}
