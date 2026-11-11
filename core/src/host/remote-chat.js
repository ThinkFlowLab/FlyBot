// FlyBot remote chats: a friend's (remote) Bot as a chat of its own, in ds-bot's own
// session model. Each remote Bot a plugin publishes gets a Bot record marked `remote`
// ({ handle, home, homeName, plugin }) whose Session runs on the model route
// `flybot-remote/<handle>`. That route is an LLM adapter registered here which calls no
// model: a message the user types in the chat goes to the plugin's sender (the transport
// to the friend's Bot), and a message from the friend's Bot, posted into the chat as a
// hidden relay, is written back as the assistant's reply. So history, unread marks, the
// last-message preview and the sidebar row all work as for a local Bot.
//
// Remote chat Bots are not team members: findBot, the team tools, flybot.bot.list() and
// memory skip them, and the tree never adopts them.
import { randomUUID } from 'node:crypto'
import { CLOCK_KINDS } from './time-context.js'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SOURCE_KIND } from './constants.js'
import { cleanName, fenceUntrusted } from './delivery.js'
import { isHomeLevelRemote, normRemoteHandle } from '../shared/remote-label.js'
import { safeLookImage } from '../shared/look-image.js'
import { cut } from './text.js'

export const REMOTE_PROVIDER = 'flybot-remote'
export const REMOTE_FORM = 'remote-chat'
const SENT_KEPT = 500

export const isRemoteChat = bot => typeof bot?.remote?.handle === 'string'
const textOf = content => (Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : String(content ?? ''))

// A published look reaches the mention stylesheet, so its image is checked here as well as
// at that sink: a value that could leave url("…") is dropped and the Bot keeps no photo (#2646).
export function applyPublishedLook(bot, member) {
  if (!bot || !member) return false
  const at = typeof member.avatarUpdatedAt === 'string' ? member.avatarUpdatedAt : ''
  if (at && bot.avatarUpdatedAt === at) return false
  let changed = false
  if (typeof member.color === 'string' && member.color && bot.color !== member.color) {
    bot.color = member.color
    changed = true
  }
  if (member.avatar && typeof member.avatar === 'object') {
    const avatar = { ...member.avatar }
    if (avatar.image !== undefined) {
      const image = safeLookImage(avatar.image)
      if (image === null) delete avatar.image
      else avatar.image = image
    }
    if (JSON.stringify(bot.avatar) !== JSON.stringify(avatar)) {
      bot.avatar = avatar
      changed = true
    }
  }
  if (at && bot.avatarUpdatedAt !== at) {
    bot.avatarUpdatedAt = at
    changed = true
  }
  return changed
}

// Sidebar / chat preview for a failed 1:1 send to a friend's Bot. Keep it one short
// English line with a next step; never dump `Bot Social send_as_member: …`.
export function notSentLine(error) {
  const raw = String(error?.message ?? error ?? '').replace(/\s+/g, ' ').trim()
  if (/^Not sent:/i.test(raw)) return raw.length > 160 ? `${cut(raw, 157).text}…` : raw
  const body = raw.replace(/^Bot Social\s+[A-Za-z0-9_.-]+:\s*/i, '').trim()
  const blob = `${raw} ${error?.code ?? ''}`
  if (/paused|turn budget|loop detected|emergency stop/i.test(blob)) {
    // The social plugin's pause (`resend`): the next send opens a fresh chat, so sending again is the step.
    // There is no turn limit and nothing to extend (owner decision 2026-10-19; social #404).
    if (error?.resend === true) return 'Not sent: Bot Social paused that chat. Send your message again: it starts a new chat.'
    return 'Not sent: this chat is paused. Approve any message waiting here, or remove and re-add this friend to start a new chat.'
  }
  // #954: the friend's Bot itself is gone (Bot Social 404 bot_not_found). One sentence that names the Bot and the
  // next step; the social plugin already writes that sentence, so it is reused whole instead of translated again.
  if (/bot_not_found|no such remote bot/i.test(blob)) {
    if (/no longer shared with you/i.test(raw)) return `Not sent: ${body.replace(/^Not sent:\s*/i, "")}`
    const who = typeof error?.handle === "string" && error.handle ? error.handle : "that Bot"
    return `Not sent: ${who} is no longer shared with you, so messages to it cannot be delivered. Ask its owner for a new invite.`
  }
  // #971: the peer withdrew `chat.public`, so the social plugin words it as "not shared"; the sentence is
  // passed through whole instead of gaining a "Try again." nothing can satisfy until that owner acts.
  if (/is not shared with your Bots/i.test(raw)) return `Not sent: ${body.replace(/^Not sent:\s*/i, "")}`
  // The same fact straight from Bot Social, before the plugin words it. Only the chat.public sentence
  // is that fact (#988): a bare capability_not_granted, or any other capability, is not a withdrawn share.
  if (/has not granted chat\.public/i.test(blob)) {
    return 'Not sent: this Bot is no longer shared with you, so messages to it cannot be delivered. Ask its owner for a new invite.'
  }
  if (/has no grant|has not been granted|cannot message friends|cannot message their Bots/i.test(blob)) {
    return 'Not sent: none of your Bots is invited to this friend. Invite them from Bot settings.'
  }
  if (/no Bot of yours is friends|no_relationship|no active relationship/i.test(blob)) {
    return 'Not sent: you are not friends with this Bot. Add them from + Add friend.'
  }
  if (/not connected|no token|no server URL/i.test(blob)) {
    return 'Not sent: Bot Social is disconnected. Reconnect in Friends\' Bots.'
  }
  if (/HTTP 401|unauthorized|signed you out/i.test(blob)) {
    return 'Not sent: Bot Social signed you out. Reconnect in Friends\' Bots.'
  }
  if (/HTTP 403|forbidden/i.test(blob)) {
    return 'Not sent: this Bot cannot be reached right now. Invite it from Bot settings, or try again.'
  }
  if (/HTTP 429|rate.?limit/i.test(blob)) {
    return 'Not sent: too many messages just now. Wait a moment and try again.'
  }
  if (/timeout|no answer/i.test(blob)) {
    return 'Not sent: Bot Social did not answer. Try again.'
  }
  // One "Try again." only: an earlier layer may already have said it (#954), and two reads as a stutter.
  const short = cut(body || raw, 80).text.replace(/\.$/, '').replace(/\.?\s*Try again\.?$/i, '').replace(/\.$/, '')
  if (!short || /^[a-z0-9_]+$/i.test(short)) {
    return 'Not sent: the message could not leave. Try again.'
  }
  return `Not sent: ${short}. Try again.`
}

/**
 * What a model call on a remote chat's route should do, from the request alone:
 * { kind: 'echo', text } writes a friend's message back as the reply; { kind: 'send',
 * messageId, text } is a message the user typed in the chat; { kind: 'none' } is anything
 * else (a one-off request without a durable message), which writes nothing.
 */
// Messages the host appends as role:'user' that the user did not type: context snapshots (the
// time context), the AGENTS.md baseline (form 'instructions') and notices (plan mode, tool
// reminders). Matched by form, not by a whitelist of senders, so a new notice kind is skipped too.
const CONTEXT_FORMS = new Set(['snapshot', 'instructions', 'notice'])
const isContextSnapshot = source => CONTEXT_FORMS.has(source?.form) || source?.kind === 'agent-instructions' || CLOCK_KINDS.includes(source?.kind)

export function remoteTurn(messages) {
  // Context the host appends as user messages (the time context, refreshed every few minutes;
  // the AGENTS.md baseline on a chat's first turn; notices) is not what the user typed: skip it,
  // or the turn reads as 'none' and the user's message is silently dropped (#66).
  const last = [...(messages ?? [])].reverse().find(message => message?.role === 'user' && !isContextSnapshot(message.source))
  if (last === undefined || typeof last.id !== 'string') return { kind: 'none' }
  const source = last.source
  if (source?.form === REMOTE_FORM && typeof source.text === 'string') return { kind: 'echo', text: source.text, messageId: last.id }
  if (source === undefined || source === null || source.kind === 'user') {
    const text = textOf(last.content).trim()
    return text ? { kind: 'send', text, messageId: last.id } : { kind: 'none' }
  }
  return { kind: 'none' }
}

// The chat a published record names (#2797). A room reaches this home once per member of that room:
// every member record carries the same name — the room's own title — at the same home, and each one
// used to open a chat of its own, so the friends' list showed one room as many rows. The chat belongs
// to the room, not to the member handle it happened to arrive on. A record with no home, or none of
// its own name, keeps the plain per-handle rule, and so does every older chat that recorded neither.
const remoteNameKey = name => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const roomKeyOf = ({ home, name }) => {
  const at = normRemoteHandle(home)
  // The name is cut where a chat's stored name is cut, so a long room title keys the same on both sides.
  const label = remoteNameKey(cut(String(name ?? ''), 40).text)
  return label && at.length > 1 ? `${at}|${label}` : ''
}

export function install(rt) {
  const { ctx, state } = rt
  const warn = (...args) => rt.warn?.(...args)
  const chats = () => Object.values(state.bots ?? {}).filter(isRemoteChat)
  const chatOfHandle = handle => chats().find(bot => normRemoteHandle(bot.remote.handle) === normRemoteHandle(handle))
  // The chat already holding this room, if one is. Two plugins publishing the same title are still
  // two chats, and a chat that recorded no plugin is not rewritten by one that does.
  const chatOfRoom = ({ home, name, plugin }) => {
    const key = roomKeyOf({ home, name })
    if (!key) return undefined
    return chats().find(bot => (plugin === undefined || bot.remote.plugin === undefined || bot.remote.plugin === plugin)
      && roomKeyOf({ home: bot.remote.home, name: bot.name }) === key)
  }
  const chatRoomKey = bot => roomKeyOf({ home: bot?.remote?.home, name: bot?.name })

  // #2804: `#2797` stopped a *new* install from opening one chat per member of a room, but a state
  // written before it still carries those rows. Every one of them holds the room key, so the gone
  // check below reads each as "still published" and nothing joins them: the list shows the same
  // room eight times and every member's line lands in its own row. This joins one room's rows into
  // one chat without copying a message: the oldest row keeps the id, handle, name, model route and
  // `hidden` flag, and every other row's Session becomes an earlier part of it (parts.js:299-308),
  // with the newest Session current so the chat reads in the order the rows were made. No text is
  // rewritten and nothing is injected, so an assistant reply inside a duplicate stays that reply
  // and the user's own hide is never touched.
  async function mergeRoom(key, plugin) {
    if (!key) return false
    const group = chats().filter(bot => chatRoomKey(bot) === key
      && (plugin === undefined || bot.remote.plugin === undefined || bot.remote.plugin === plugin))
    if (group.length < 2) return false
    const ordered = [...group].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)))
    const survivor = ordered[0]
    const current = ordered[ordered.length - 1]
    // A card is answered on the chat's own Session and only one card can move up to it, so two rows
    // each waiting on an answer cannot both be kept: the merge below would delete one card and leave
    // the wait behind it hanging. A room with more than one open card is left alone for this round
    // (#2804 acceptance 10): nothing is written, and the next sync, open or deliver tries again once
    // a card is answered.
    if (ordered.filter(bot => state.questions?.[bot.sessionId] !== undefined).length > 1) return false
    // The Session each row had, read before the chat's own id is replaced: the part boundaries, the
    // re-index and the card move all need it, and the survivor's own Session becomes an earlier part.
    const before = ordered.map(bot => bot.sessionId)
    // The parts of the chat now: the survivor's own earlier parts first (they are the oldest), then
    // each row's own parts and its Session, in creation order. A row that is itself a merged chat
    // keeps the parts it already had; the newest row's Session stays current and needs no boundary.
    const parts = [...(survivor.segments ?? [])]
    for (let index = 0; index < ordered.length; index += 1) {
      const bot = ordered[index]
      if (index > 0) parts.push(...(bot.segments ?? []))
      // A part ends when the next row was made: `partsOf` reads each part's `startedAt` from the
      // `endedAt` before it (parts.js:299-308), so a boundary taken from its own row shifts the rest.
      if (index < ordered.length - 1) parts.push({ sessionId: before[index], endedAt: ordered[index + 1].createdAt ?? Date.now() })
    }
    survivor.segments = parts
    survivor.sessionId = current.sessionId
    // The Session maps `selfOf` and `earlierPage` read follow the Sessions that moved: the chat's own
    // Session is the survivor's, and every other one is an earlier part of it (#1453 applies the same
    // rule to a gone Bot, and `indexSessions` rebuilds both maps from this state on the next load).
    // The ids come from `before`: the survivor's own was just replaced by the chat's.
    try {
      for (const sessionId of before) {
        rt.chatOwners?.delete(sessionId)
        rt.pastOwners?.set(sessionId, { botId: survivor.id })
      }
      rt.chatOwners?.set(current.sessionId, survivor.id)
      rt.pastOwners?.delete(current.sessionId)
    } catch (error) {
      warn('ds-bot: re-indexing the merged room chat failed: %s', error)
    }
    // A reply that was on its way to one of those chats is the survivor's wait now (#443).
    if (state.remoteAwaiting !== undefined) {
      for (const bot of ordered.slice(1)) {
        const at = state.remoteAwaiting[bot.id]
        if (at === undefined) continue
        if (state.remoteAwaiting[survivor.id] === undefined) state.remoteAwaiting[survivor.id] = at
        delete state.remoteAwaiting[bot.id]
      }
    }
    // Who has spoken here (#420) hangs off the Bot id too, and the rows going away would take it
    // along. The same sender keeps the earlier first-seen time so a first line stays a first line,
    // and `friendLineAt` the latest, so a line that arrived in one of them still marks the row
    // unread. `noteFriendLine` trims the map to its own cap on the next new sender (delivery.js:108).
    if (state.remoteContacts !== undefined) {
      const kept = (state.remoteContacts[survivor.id] ??= {})
      for (const bot of ordered.slice(1)) {
        for (const [handle, at] of Object.entries(state.remoteContacts[bot.id] ?? {})) {
          if (kept[handle] === undefined || at < kept[handle]) kept[handle] = at
        }
        delete state.remoteContacts[bot.id]
      }
    }
    for (const bot of ordered.slice(1)) {
      if (typeof bot.friendLineAt === 'number' && (typeof survivor.friendLineAt !== 'number' || bot.friendLineAt > survivor.friendLineAt)) survivor.friendLineAt = bot.friendLineAt
    }
    // A question card is answered on the chat's current Session (channel.js:568-593 resolves an
    // earlier part to it), so a card left open in one of these rows moves up the way a rotation
    // moves it (parts.js:1009-1013): its call stays in the old part, the card does not. The gate
    // above leaves at most one card in the room, so this move can never overwrite a card.
    for (const sessionId of before.slice(0, -1)) {
      const question = state.questions?.[sessionId]
      if (question === undefined) continue
      if (state.questions[current.sessionId] === undefined) {
        const { callId: _call, ...rest } = question
        state.questions[current.sessionId] = rest
      }
      delete state.questions[sessionId]
    }
    // The Session that is now the chat's own was opened for another row's handle, and a turn runs on
    // the Session's own route (parts.js:965-968) while `forward` sends to the handle in it: without
    // this, the next line typed here is sent for a handle that no longer has a row.
    if (typeof rt.selectSessionModel === 'function' && survivor.remote?.handle) {
      await rt.selectSessionModel(survivor.sessionId, { provider: REMOTE_PROVIDER, model: survivor.remote.handle })
        .catch(error => warn('ds-bot: route for the merged chat %s not applied: %s', survivor.name, error))
    }
    for (const bot of ordered.slice(1)) delete state.bots[bot.id]
    return true
  }
  const senders = new Map()
  const pending = new Map()

  async function* streamText(text) {
    if (text) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const sentStore = () => {
    state.flybot ??= {}
    state.flybot.remoteSent ??= []
    return state.flybot.remoteSent
  }
  // Friend chats waiting on a reply (#443): chat id → when the message left. Cleared when the
  // friend's reply is written back (the echo turn), so the thinking row hands over to the reply.
  const markAwaiting = (id, at) => {
    state.remoteAwaiting ??= {}
    if (at === undefined) {
      if (state.remoteAwaiting[id] === undefined) return false
      delete state.remoteAwaiting[id]
      return true
    }
    state.remoteAwaiting[id] = at
    return true
  }
  async function forward(handle, turn) {
    const bot = chatOfHandle(handle)
    if (bot === undefined) return `Not sent: ${handle} is not a friend's Bot any more.`
    const sent = sentStore()
    // A retried turn never sends the same message twice.
    if (sent.includes(turn.messageId)) return ''
    const sender = senders.get(bot.remote.plugin)
    if (sender === undefined) return 'Not sent: the plugin that reaches this Bot is not running.'
    try {
      await sender({ handle, text: turn.text, botId: bot.id, remote: { ...bot.remote } })
      sent.push(turn.messageId)
      if (sent.length > SENT_KEPT) sent.splice(0, sent.length - SENT_KEPT)
      // The chat now waits for the friend's reply: the client keeps one thinking row up from
      // this send until the reply lands (#443), across the gap between this turn and the echo.
      markAwaiting(bot.id, Date.now())
      await rt.save().catch(error => warn('ds-bot: saving a friend chat wait failed: %s', error))
      return ''
    } catch (error) {
      return notSentLine(error)
    }
  }

  class RemoteAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Friends\' Bots' } }
    async listModels(provider) {
      const handles = new Set([...chats().map(bot => bot.remote.handle), ...pending.keys()])
      return [...handles].map(handle => ({ provider, id: handle, name: chatOfHandle(handle)?.name ?? pending.get(handle) ?? handle, inputModalities: ['text'] }))
    }
    async resolveModel(provider, model) {
      return { provider, id: model, name: chatOfHandle(model)?.name ?? model, inputModalities: ['text'], context: { contextWindow: 1_000_000 }, defaultMaxTokens: 4096 }
    }
    async *stream(options) {
      const turn = remoteTurn(options.messages)
      if (turn.kind === 'echo') {
        const id = chatOfHandle(options.model)?.id
        if (id !== undefined && markAwaiting(id)) void rt.save().catch(error => warn('ds-bot: saving a friend chat wait failed: %s', error))
        yield* streamText(turn.text)
      }
      else if (turn.kind === 'send') yield* streamText(await forward(options.model, turn))
      else yield* streamText('')
    }
  }
  try {
    const off = ctx.llm?.registerAdapter?.([REMOTE_PROVIDER], new RemoteAdapter())
    if (typeof off === 'function') ctx.effect?.(() => off, 'ds-bot: remote chat route')
  } catch (error) {
    warn('ds-bot: remote chats are off: %s', error)
  }

  let opening = Promise.resolve()
  // Creates the chat for a remote Bot (once), or refreshes its name, home label, and look.
  function open({ handle, name, home, homeName, plugin, color, avatar, avatarUpdatedAt }) {
    if (isHomeLevelRemote({ handle, home })) return Promise.resolve(undefined)
    const run = opening.then(async () => {
      await rt.load()
      const room = roomKeyOf({ home, name })
      if (room && await mergeRoom(room, plugin)) await rt.save()
      const existing = chatOfHandle(handle) ?? chatOfRoom({ home, name, plugin })
      if (existing !== undefined) {
        const next = { ...existing.remote, home, ...(homeName ? { homeName } : {}), plugin, gone: undefined }
        delete next.gone
        const lookChanged = applyPublishedLook(existing, { color, avatar, avatarUpdatedAt })
        if (JSON.stringify(next) !== JSON.stringify(existing.remote) || (name && existing.name !== name) || lookChanged) {
          existing.remote = next
          if (name) existing.name = cut(String(name), 40).text
          await rt.save()
        }
        return existing.id
      }
      pending.set(handle, name)
      try {
        const bot = await rt.createBot({ name: cut(String(name || handle), 40).text, model: `${REMOTE_PROVIDER}/${handle}`, remote: { handle, home, ...(homeName ? { homeName } : {}), plugin } })
        if (applyPublishedLook(bot, { color, avatar, avatarUpdatedAt })) await rt.save()
        return bot.id
      } finally { pending.delete(handle) }
    })
    opening = run.catch(() => {})
    return run
  }

  // A published list: every Bot gets its chat; a chat whose Bot left keeps its history, marked gone.
  async function sync(plugin, list) {
    // `open()` clears `remote.gone` on a chat that is published again, so remember which chats
    // were gone first. `remote.gone` alone says the Bot left; `hidden` stays the user's own flag
    // (`roster.setFlags`) and is never written here (#956), so a chat that left keeps its row in the
    // sidebar and a returning one cannot carry a hide of the user's away with it.
    const goneBefore = new Map()
    for (const bot of chats()) if (bot.remote.plugin === plugin) goneBefore.set(bot.id, Boolean(bot.remote.gone))
    const handles = new Set()
    const rooms = new Set()
    for (const member of list) {
      if (isHomeLevelRemote(member)) continue
      handles.add(normRemoteHandle(member.handle))
      // One room is published once per member: opening each member would give the room one row each
      // (#2797), so the room is opened once and the rest of its members only keep it from going stale.
      const room = roomKeyOf(member)
      if (room) {
        if (rooms.has(room)) continue
        rooms.add(room)
      }
      await open({ ...member, plugin }).catch(error => warn('ds-bot: chat for %s not opened: %s', member.handle, error))
    }
    let changed = false
    // #2804: rows written before #2797 are one room, not several. Joining them first makes the gone
    // check below read one row, and every later line lands in it.
    for (const room of rooms) if (await mergeRoom(room, plugin)) changed = true
    for (const bot of chats()) {
      if (bot.remote.plugin !== plugin) continue
      // A chat whose room is still published is not gone when the member handle that carried the room
      // has changed: the publisher names a room by its members, and any of them speaks for it.
      const room = chatRoomKey(bot)
      const gone = isHomeLevelRemote(bot.remote) || (!handles.has(normRemoteHandle(bot.remote.handle)) && !(room && rooms.has(room)))
      const wasGone = goneBefore.get(bot.id) ?? Boolean(bot.remote.gone)
      if (wasGone !== gone) {
        bot.remote = { ...bot.remote, ...(gone ? { gone: true } : {}) }
        if (!gone) delete bot.remote.gone
        // The Bot is published again: drop the marker an older version left with the hide it imposed.
        if (!gone && bot.remote.hiddenByGone === true) {
          delete bot.hidden
          delete bot.remote.hiddenByGone
        }
        changed = true
      } else if (gone && bot.hidden === true && bot.remote.hiddenByGone === true) {
        // A state file written before #956 hid the row we imposed. The row is the conversation's, so
        // one sync takes that hide back (#956); a hide the user set carries no marker and stays. The
        // marker goes with it — taking the hide back is its only use, and while it stayed a hide the
        // user set later read as ours, so the next sync deleted it (the row then ignored the Hide).
        delete bot.hidden
        delete bot.remote.hiddenByGone
        changed = true
      }
    }
    if (changed) await rt.save()
  }

  // A message from the friend's Bot, into its chat: a hidden relay (fenced, as any text
  // from outside the team) that the chat's route writes back as the reply.
  // `human` + `ownerName`: the plugin has Bot Social's attestation that the friend typed this line
  // themselves (never derived from the text). The reply is then drawn as the person, not the Bot.
  async function deliver({ handle, text, name, home, plugin, human, ownerName }) {
    const room = roomKeyOf({ home, name })
    if (room && await mergeRoom(room, plugin)) await rt.save()
    const id = chatOfHandle(handle)?.id ?? await open({ handle, name: name ?? handle, home, plugin })
    const bot = rt.botOf(id)
    const agent = await rt.resolveAgent(rt.chatOf(id))
    const shownName = cleanName(bot?.name ?? name ?? handle)
    // The reply is here: the thinking row goes before the reply is drawn, not a beat after it (#443).
    if (markAwaiting(id)) await rt.save().catch(error => warn('ds-bot: saving a friend chat wait failed: %s', error))
    const typedBy = human === true && typeof ownerName === 'string' && ownerName.trim() ? cleanName(ownerName) : ''
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[Message from ${shownName} (${cleanName(handle)})]\n${fenceUntrusted(shownName, text)}` }],
      source: { kind: SOURCE_KIND, form: REMOTE_FORM, role: 'remote', exchangeId: randomUUID(), senderName: shownName, hop: 0, remote: { handle, ...(home ? { home } : {}) }, ...(typedBy ? { typedBy } : {}), text: String(text) },
    }))
    await ctx.sessions.flush(agent.session)
    await rt.ingestRemoteRoomLine?.({ handle, text, name: shownName }).catch(error => warn('ds-bot: room ingest for %s failed: %s', handle, error))
    return id
  }

  const onSend = (plugin, fn) => {
    senders.set(plugin, fn)
    return () => { if (senders.get(plugin) === fn) senders.delete(plugin) }
  }

  Object.assign(rt, { remoteChats: { open, sync, deliver, onSend, list: () => chats().map(bot => ({ id: bot.id, ...bot.remote, name: bot.name })), of: handle => chatOfHandle(handle)?.id } })
}
