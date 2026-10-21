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
//                receipt): it neither grants nor takes away. A source kind this version does not
//                recognise is 'other', not nothing (#620).
//
// A turn's verdict is the strictest of its messages ('other' beats everything and sticks for the
// rest of the turn), and a turn that took in no message with a verdict has none. The caller treats
// "none" as 'other' (fail closed).
import { REFERENCE_KIND, REPLY_KIND, SOURCE_KIND } from './constants.js'
import { CLOCK_KINDS } from './time-context.js'

export const OWNER = 'owner'
export const OTHER = 'other'
export const SCHEDULED = 'scheduled'

// The messages that carry nobody's request, by source kind — one list, because everything else
// fails closed as 'other' (#620): a kind missing here takes the connector tools away in the middle
// of a turn the owner started (#626), and a kind wrongly added here would hand them out.
// Derived from `MessageSourceMap` in @deepseek-ai/dsh-llm (0.2.0-rc.2, the version
// core/dev/harness/package.json pins). A kind is not recognisable by its `form` alone: the kinds
// below that declare no `form` at all (`working-directory`, `ptc-mode`, `cordis-host-runner`) would
// read as opaque content, and `webhook` declares `form: 'notice'` while being an outside delivery
// (see `originOfSource`). Bumping the DSH pin means re-reading that map: the test
// `#626: the no-request kind list is derived from the DSH version the tests run against` fails
// until this list has been looked at again.
const NOTICE_KINDS = new Set([
  // Sources the host writes for itself, never a user turn.
  'tool',
  'system-prompt',
  'plan-mode', // @deepseek-ai/dsh-plan-mode, ContextFormed
  'user-approval', // @deepseek-ai/dsh-user-approval, ContextFormed
  // Context appended as role 'user' while a turn runs: the clock this host injects
  // (`ds-bot-time-context`, time-context.js `SOURCE`) and DSH injects (`time-context`); the
  // AGENTS.md baseline and changes (`agent-instructions`, @deepseek-ai/dsh-agent-instructions); a
  // cited conversation's snapshot (`session-reference`, constants.js `REFERENCE_KIND`); the model
  // and working directory a Session switched to (@deepseek-ai/dsh-agent `model-selection`,
  // `working-directory`); the PTC toggle (`ptc-mode`); the plugin host runner
  // (`cordis-host-runner`).
  ...CLOCK_KINDS,
  REFERENCE_KIND,
  'agent-instructions',
  'model-selection',
  'working-directory',
  'ptc-mode',
  'cordis-host-runner',
  // One-off accounts of what just happened, `form: 'notice'`: a subagent settling, which steers
  // the turn that is running (@deepseek-ai/dsh-subagent); a compaction checkpoint, the summary
  // that replaces the log (@deepseek-ai/dsh-compaction); and a skill's own instructions, injected
  // with `form: 'instructions'` when it is invoked (@deepseek-ai/dsh-skill).
  'subagent-settled',
  'compact-checkpoint',
  'skill-invocation',
])

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
    case 'goal':
      // A goal round continues a goal that was created in this Session: by the owner, or by the Bot
      // on a request that reached it. It is not a request arriving now, so it reads like a due task
      // — the owner's while the Bot is not shared (`settled` turns it into 'other' when it is).
      return SCHEDULED
    case SOURCE_KIND:
      if (source.remote !== undefined || source.form === 'remote-chat') return OTHER
      // A host notice about what the user did, and the note a Bot's own part switch hands on.
      if (source.role === 'mention') return undefined
      if (source.handoff === true && source.resume !== true) return undefined
      return source.origin === OWNER || source.origin === SCHEDULED ? source.origin : OTHER
    default:
      if (NOTICE_KINDS.has(source.kind)) return undefined
      // A kind this version does not recognise is not "nobody's request": the host cannot vouch for
      // who is behind it, so it fails closed as 'other' (#620). Only the two documented no-request
      // cases above may return undefined. Three DSH kinds stay here on purpose: `webhook` carries
      // an outside delivery (`form: 'notice'`, but a provider's event is somebody's request, so
      // reading `form` alone would let it through); `agent-message` (`form: 'relay'`) and
      // `team-message` carry another agent's words.
      return OTHER
  }
}

// Two verdicts of one turn: the strictest wins, and "none" yields to the other.
export function combine(a, b) {
  if (a === undefined) return b
  if (b === undefined) return a
  if (a === OTHER || b === OTHER) return OTHER
  return a === SCHEDULED || b === SCHEDULED ? SCHEDULED : OWNER
}

// The verdict the running turn recorded, before `settled` narrows it. `scheduled` is the one a caller
// cannot get anywhere else: on a shared Bot it is 'other' as a permission, and still 'scheduled' as
// a fact, which is what a caller needs to say why a turn is not the owner's (#651).
export function turnOrigin(rt, sessionId, entry = rt.live?.get(sessionId)) {
  return entry?.turn === undefined ? undefined : entry.origin
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
