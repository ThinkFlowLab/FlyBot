// Delivery: how one Bot, the user, or DS Bot itself puts a message into a Bot Session.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SOURCE_KIND } from './constants.js'
import { OWNER, OTHER, SCHEDULED } from './turn-origin.js'

// Text from outside the team, marked so the Bot treats it as data. Marker fragments are
// removed until none is left, so a nested "</untrusted-</untrusted-message>message>"
// cannot rebuild a closing tag.
export const stripMarkers = (text, tag = 'untrusted-message') => {
  let out = String(text)
  const pattern = new RegExp(`<\\/?\\s*${tag}`, 'gi')
  for (let previous; previous !== out;) { previous = out; out = out.replace(pattern, '') }
  return out
}
// Both untrusted tags in one fixed-point pass: stripping one tag can let fragments
// the other pass joined back survive it, so a closing fence must never be reachable
// by any order (#98 review).
export const stripUntrusted = text => {
  let out = String(text)
  const pattern = /<\/?\s*(?:untrusted-message|untrusted-file)/gi
  for (let previous; previous !== out;) { previous = out; out = out.replace(pattern, '') }
  return out
}
// A complete wrap we already stored. A mention of the marker in the middle is not this.
export const isFencedUntrusted = text => /^<untrusted-message from="[^"]*">\n?[\s\S]*\n?<\/untrusted-message>$/.test(String(text ?? ''))
// The words a human reads: the inner text of a stored untrusted-message wrap, else the
// original string. The Bot still sees the fenced log line; previews and bubbles must not.
export const unwrapUntrusted = (text) => {
  const value = String(text ?? '')
  const match = value.match(/<untrusted-message from="[^"]*">\n?([\s\S]*?)\n?<\/untrusted-message>/)
  return match ? match[1] : value
}
// A name from outside the team, safe on one line of trusted text: no control characters,
// newlines, brackets or quotes, at most 60 characters.
export const cleanName = (name, fallback = 'a remote Bot') => {
  const text = String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/[[\]"<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return text || fallback
}
export const fenceUntrusted = (name, text) => `<untrusted-message from="${cleanName(name)}">\n${stripUntrusted(text ?? '')}\n</untrusted-message>`

// Bot-authored followups are createUserMessage; DSH may resolve `dsh-session:` chips
// there and attach the snapshot. Drop chips so a Bot cannot tunnel a private chat
// into another Bot's own chat or a shared room (#106). Authorship stays the gate
// on actor-authored send / room-post. Loop until stable so a nested marker cannot
// reconstitute a valid chip after one pass.
export function stripSessionChips(text) {
  if (typeof text !== 'string' || !text.includes('dsh-session:')) return text
  let out = text
  for (let previous; previous !== out;) {
    previous = out
    out = out
      .replace(/@\[((?:\\.|[^\]\\])*)\]\(dsh-session:[A-Za-z0-9_-]+\)/g, (_, label) => `@${String(label).replace(/\\([\\\]])/g, '$1')}`)
      .replace(/dsh-session:[A-Za-z0-9_-]+/g, '')
  }
  if (out.includes('dsh-session:')) out = out.replace(/dsh-session:/g, '')
  return out
}

export function install(rt) {
  const { ctx, state } = rt

  const resolveAgent = async (sessionId) => {
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if ('error' in resolved) throw new Error(resolved.error?.message ?? 'Session unavailable')
    rt.hideBlockingQuestion(resolved.agent)
    rt.flybotHideTools?.(resolved.agent)
    rt.hideConnectorTools?.(resolved.agent)
    return resolved.agent
  }

  const headerFor = (role, fromName, roomName, audience, note = 'new message', deferred = false, { resumed = false, retried = false } = {}) => {
    if (deferred) return `[Message from ${fromName} · you read it during your last task; answer it now]`
    if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
    if (resumed && role === 'resume') return '[DeepSeek Harness restarted while you were working]'
    if (resumed && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted while you were working on it]`
    if (role === 'reply') return `[Reply from ${fromName}]`
    if (role === 'stopped') return `[Stopped by ${fromName}]`
    if (role === 'room') return `[Group chat "${roomName}" · ${note}]`
    if (role === 'report') return `[Group chat "${roomName}" · replies to your post]`
    if (role === 'kickoff') return '[Bot team setup]'
    if (role === 'secret') return '[Secret card]'
    if (audience === 'user') return `[Message from ${fromName} · the user sees your reply here]`
    return `[Message from ${fromName}]`
  }

  // Whose request a relay is (turn-origin.js). A friend's message is someone else's; the host's own
  // (no sender: the user through the UI, a group round, a secret card) is the owner's; a Bot's is the
  // request that Bot's own turn answered, and only when both Bots have one owner. A Bot that cannot say
  // (no running turn found, or a sender that is not a local Bot) passes on nothing.
  const originOf = ({ from, to, fromId, remote, given }) => {
    if (remote?.handle) return OTHER
    if (fromId === undefined) return given === OTHER ? OTHER : OWNER
    if (from === undefined || to === undefined || from.remote !== undefined || from.ownerId !== to.ownerId) return OTHER
    const said = given ?? rt.botTurnOrigin?.(fromId)
    return said === OWNER || said === SCHEDULED ? OWNER : OTHER
  }

  // A friend's line in a Bot's own chat (#420): `friendLineAt` on the Bot tells every window that a
  // line it has not shown yet arrived (its row turns unread), and the senders seen so far, kept apart
  // from the roster, tell the first line from a sender. A group line is the group's, not the Bot's.
  const CONTACTS_KEPT = 200
  const noteFriendLine = (to, sessionId, roomId, handle) => {
    if (to === undefined || roomId || (sessionId !== undefined && sessionId !== rt.chatOf(to.id))) return false
    const key = String(handle)
    const contacts = (state.remoteContacts ??= {})[to.id] ??= {}
    const first = contacts[key] === undefined
    const now = Date.now()
    if (first) {
      contacts[key] = now
      const keys = Object.keys(contacts)
      if (keys.length > CONTACTS_KEPT) for (const old of keys.slice(0, keys.length - CONTACTS_KEPT)) delete contacts[old]
    }
    to.friendLineAt = now
    void rt.save().catch(() => {})
    return first
  }

  // Roles recorded as team exchanges.
  const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped'])

  // `sessionId` defaults to the recipient's own chat; group turns name its group Session.
  // `deferred`: a request the Bot already read mid-turn, handed back to answer in a
  // turn of its own; its exchange was recorded when it first arrived. `resumed` and
  // `retried` carry on a turn that a restart cut off or that wrote its tool call as
  // text (resume.js, turns.js), and `resent` is a message a shutdown cancelled; their
  // exchange is recorded already too. `askedBy` is the member whose @mention called a
  // group turn (groups.js). `fromRoomId`: the group whose Session the sender wrote
  // from; the reply goes back to that Session (turns.js).
  async function deliver({ fromId, toId, sessionId, text, role, hop = 0, replyTo, roomId, audience, note, exchangeId = randomUUID(), steer = false, deferred = false, resumed = false, retried = false, resent = false, askedBy, fromRoomId, fromName: givenName, untrusted = false, remote, attachments, origin: givenOrigin }) {
    const from = rt.botOf(fromId)
    const to = rt.botOf(toId)
    if (to === undefined) throw new Error(`Unknown Bot ${toId}`)
    // `fromName`: a sender outside the team (a FlyBot plugin's remote Bot), whose
    // `untrusted` text is fenced so the Bot reads it as data, not instructions.
    const fromName = from?.name ?? (givenName === undefined ? 'You' : untrusted ? cleanName(givenName) : givenName)
    const room = rt.roomOf(roomId)
    const origin = originOf({ from, to, fromId, remote, given: givenOrigin })
    const firstContact = remote?.handle && !deferred && !resumed && !retried && !resent ? noteFriendLine(to, sessionId, roomId, remote.handle) : false
    // Session events reject `undefined` members, so optional fields are omitted instead.
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      senderName: fromName,
      hop,
      // Whose request this is, for the connector tools (turn-origin.js): read by the receiving turn.
      origin,
      ...(fromId ? { senderSessionId: fromId } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(roomId ? { roomId } : {}),
      ...(audience === 'user' ? { audience } : {}),
      ...(deferred ? { deferred: true } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(retried ? { retried: true } : {}),
      ...(askedBy ? { askedBy } : {}),
      ...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
      // A remote member's message (FlyBot): the chat draws it as that member's bubble.
      // `typedBy`: the plugin has the server's attestation that this friend typed the line themselves.
      // `firstContact`: this sender's first line in the Bot's own chat; the chat names who is talking (#420).
      ...(remote?.handle ? { remote: { handle: String(remote.handle), ...(remote.home ? { home: String(remote.home) } : {}), ...(remote.typedBy ? { typedBy: cleanName(remote.typedBy) } : {}), ...(firstContact ? { firstContact: true } : {}) } } : {}),
      // A remote member's files, as references the chat shows as chips (fetched on demand).
      ...(remote?.handle && Array.isArray(attachments) && attachments.length ? { attachments: attachments.map(file => ({ id: String(file.id ?? ''), name: String(file.name), size: Number(file.size), mime: String(file.mime ?? '') })) } : {}),
    }
    if (EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried && !resent) {
      state.exchanges.push({ id: exchangeId, from: fromId, to: toId, text, role, time: Date.now(), ...(replyTo ? { replyTo } : {}), ...(audience === 'user' ? { audience } : {}) })
      void rt.save().catch(() => {})
    }
    const targetSessionId = sessionId ?? rt.chatOf(toId)
    await rt.ensureCapabilities(targetSessionId)
    const agent = await resolveAgent(targetSessionId)
    // A steered message cuts into a running turn at its next step; a follow-up
    // queues for the next turn (see turns.js for how each is routed).
    const body = fromId ? stripSessionChips(text) : text
    const message = createUserMessage({
      content: [{ type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried })}\n${untrusted ? fenceUntrusted(fromName, body) : body}` }],
      source,
    })
    if (steer) agent.steer(message)
    else agent.followup(message)
    await ctx.sessions.flush(agent.session)
    return exchangeId
  }

  Object.assign(rt, { resolveAgent, deliver })
}
