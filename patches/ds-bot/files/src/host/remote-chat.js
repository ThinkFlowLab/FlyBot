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
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SOURCE_KIND } from './constants.js'
import { cleanName, fenceUntrusted } from './delivery.js'
import { isHomeLevelRemote, normRemoteHandle } from '../shared/remote-label.js'

export const REMOTE_PROVIDER = 'flybot-remote'
export const REMOTE_FORM = 'remote-chat'
const SENT_KEPT = 500

export const isRemoteChat = bot => typeof bot?.remote?.handle === 'string'
const textOf = content => (Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : String(content ?? ''))

/**
 * What a model call on a remote chat's route should do, from the request alone:
 * { kind: 'echo', text } writes a friend's message back as the reply; { kind: 'send',
 * messageId, text } is a message the user typed in the chat; { kind: 'none' } is anything
 * else (a kickoff, a one-off request without a durable message), which writes nothing.
 */
// Messages the host appends as role:'user' that the user did not type: context snapshots (the
// time context), the AGENTS.md baseline (form 'instructions') and notices (plan mode, tool
// reminders). Matched by form, not by a whitelist of senders, so a new notice kind is skipped too.
const CONTEXT_FORMS = new Set(['snapshot', 'instructions', 'notice'])
const isContextSnapshot = source => CONTEXT_FORMS.has(source?.form) || source?.kind === 'agent-instructions' || source?.kind === 'ds-bot-time-context' || source?.kind === 'time-context'

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

export function install(rt) {
  const { ctx, state } = rt
  const warn = (...args) => rt.warn?.(...args)
  const chats = () => Object.values(state.bots ?? {}).filter(isRemoteChat)
  const chatOfHandle = handle => chats().find(bot => normRemoteHandle(bot.remote.handle) === normRemoteHandle(handle))
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
      void rt.save().catch(() => {})
      return ''
    } catch (error) {
      return `Not sent: ${error?.message ?? error}`
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
      if (turn.kind === 'echo') yield* streamText(turn.text)
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
  // Creates the chat for a remote Bot (once), or refreshes its name and home label.
  function open({ handle, name, home, homeName, plugin }) {
    if (isHomeLevelRemote({ handle, home })) return Promise.resolve(undefined)
    const run = opening.then(async () => {
      await rt.load()
      const existing = chatOfHandle(handle)
      if (existing !== undefined) {
        const next = { ...existing.remote, home, ...(homeName ? { homeName } : {}), plugin, gone: undefined }
        delete next.gone
        if (JSON.stringify(next) !== JSON.stringify(existing.remote) || (name && existing.name !== name)) {
          existing.remote = next
          if (name) existing.name = String(name).slice(0, 40)
          await rt.save()
        }
        return existing.id
      }
      pending.set(handle, name)
      try {
        const bot = await rt.createBot({ name: String(name || handle).slice(0, 40), model: `${REMOTE_PROVIDER}/${handle}`, remote: { handle, home, ...(homeName ? { homeName } : {}), plugin } })
        return bot.id
      } finally { pending.delete(handle) }
    })
    opening = run.catch(() => {})
    return run
  }

  // A published list: every Bot gets its chat; a chat whose Bot left keeps its history, marked gone.
  async function sync(plugin, list) {
    const handles = new Set()
    for (const member of list) {
      if (isHomeLevelRemote(member)) continue
      handles.add(normRemoteHandle(member.handle))
      await open({ ...member, plugin }).catch(error => warn('ds-bot: chat for %s not opened: %s', member.handle, error))
    }
    let changed = false
    for (const bot of chats()) {
      if (bot.remote.plugin !== plugin) continue
      const gone = isHomeLevelRemote(bot.remote) || !handles.has(normRemoteHandle(bot.remote.handle))
      const wasGone = Boolean(bot.remote.gone)
      const wasHidden = Boolean(bot.hidden)
      if (wasGone !== gone || wasHidden !== gone) {
        bot.remote = { ...bot.remote, ...(gone ? { gone: true } : {}) }
        if (!gone) delete bot.remote.gone
        if (gone) bot.hidden = true
        else delete bot.hidden
        changed = true
      }
    }
    if (changed) await rt.save()
  }

  // A message from the friend's Bot, into its chat: a hidden relay (fenced, as any text
  // from outside the team) that the chat's route writes back as the reply.
  async function deliver({ handle, text, name, home, plugin }) {
    const id = chatOfHandle(handle)?.id ?? await open({ handle, name: name ?? handle, home, plugin })
    const bot = rt.botOf(id)
    const agent = await rt.resolveAgent(rt.chatOf(id))
    const shownName = cleanName(bot?.name ?? name ?? handle)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `[Message from ${shownName} (${cleanName(handle)})]\n${fenceUntrusted(shownName, text)}` }],
      source: { kind: SOURCE_KIND, form: REMOTE_FORM, role: 'remote', exchangeId: randomUUID(), senderName: shownName, hop: 0, remote: { handle, ...(home ? { home } : {}) }, text: String(text) },
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
