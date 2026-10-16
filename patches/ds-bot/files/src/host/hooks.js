// FlyBot hooks: the `flybot` service feature plugins (plugins/social, plugins/tree)
// build on. Installed after resume.js, so its gate around rt.deliver is the outermost
// wrapper: every Bot-to-Bot message, including message_bot, stop_bot, and replies,
// passes the send middleware chain exactly once.
//
// Persisted in state.json with the team:
//   state.bots[id].fields[plugin][key]   custom fields (bot.fields)
//   state.bots[id].systemPrompt          plugin prompt text (prompt.js appends it)
//   state.flybot.approvals[id]           sends held for the owner's decision
// Types: ds-bot/types/flybot.d.ts. Plugins call flybot.scope('<plugin>') to get the
// same API with their own field namespace; the unscoped API uses namespace 'shared'.
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mentionSpans } from '../shared/mentions.js'
import { isHomeLevelRemote } from '../shared/remote-label.js'
import { cleanName } from './delivery.js'
import { SOURCE_KIND } from './constants.js'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const FLYBOT_API_VERSION = 1
export const SHARED = 'shared'
// Roles that are one Bot talking to another; group rounds, kickoffs, and notices are not.
const BOT_TO_BOT_ROLES = new Set(['request', 'reply', 'stopped', 'report'])
const ACTIONS = new Set(['allow', 'deny', 'hold'])
const MAX_ATTACHMENTS = 5
const APPROVALS_KEPT = 200
const BUILTIN_ENDPOINTS = new Set(['bots', 'remote-members', 'changes', 'approvals', 'decide'])
const PENDING_MAX = 100
const MAX_SEND_TEXT = 20_000
class HoldFull extends Error {}
const CHANGES_KEPT = 500
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i

const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// Peer-controlled labels (display name, home, owner): strip @ so they cannot look
// like a mention of another Bot, strip controls/newlines, keep a 60-char cap (#75).
export const cleanPublishedName = (value) => String(value ?? '').replace(/@/g, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
// A remote address: { kind: 'remote', handle, home? } or a '@handle' string. Remote Bots
// are never in bot.list(); their handle is '@<bot>.<home>' (home '@<home>') or a plain
// per-bot identity.
const isRemote = ref => (ref !== null && typeof ref === 'object' && ref.kind === 'remote') || (typeof ref === 'string' && ref.startsWith('@'))
const homeOfHandle = handle => {
  const parts = String(handle).replace(/^@/, '').split('.')
  return parts.length > 2 ? `@${parts.slice(1).join('.')}` : `@${parts.join('.')}`
}
export const toRemote = (ref) => {
  if (!isRemote(ref)) return undefined
  const handle = `@${String(typeof ref === 'string' ? ref : ref.handle).replace(/^@+/, '').toLowerCase()}`
  return { kind: 'remote', handle, home: typeof ref === 'object' && ref.home ? ref.home : homeOfHandle(handle), ...(typeof ref === 'object' && ref.name ? { name: ref.name } : {}), ...(typeof ref === 'object' && ref.transport ? { transport: ref.transport } : {}) }
}
const targetOf = ref => (isRemote(ref) ? { remote: true, handle: toRemote(ref).handle, home: toRemote(ref).home } : { remote: false, id: ref })
const checkName = (kind, value) => {
  if (typeof value !== 'string' || !NAME.test(value)) throw new Error(`flybot: invalid ${kind} ${JSON.stringify(value)}`)
}

// Priority bands for send middleware: lower runs first; unset is DEFAULT. Routing
// (e.g. tree relays) runs before policies; approvals/transports (e.g. social) run last.
export const SEND_PRIORITY = Object.freeze({ ROUTING: 100, DEFAULT: 500, APPROVAL: 900 })
const priorityOf = m => (Number.isFinite(m.priority) ? m.priority : SEND_PRIORITY.DEFAULT)

// Orders middleware by priority, then by before/after names (which still win over
// priority, for compatibility); ties keep registration order. A cycle falls back to
// priority/registration order for the entries left.
export function orderMiddleware(input) {
  const list = input.map((m, index) => ({ m, index })).sort((a, b) => priorityOf(a.m) - priorityOf(b.m) || a.index - b.index).map(e => e.m)
  const names = new Set(list.map(m => m.name))
  const after = new Map(list.map(m => [m.name, new Set()]))
  for (const m of list) {
    for (const other of m.before ?? []) if (names.has(other)) after.get(other).add(m.name)
    for (const other of m.after ?? []) if (names.has(other)) after.get(m.name).add(other)
  }
  const done = new Set()
  const out = []
  while (out.length < list.length) {
    const next = list.find(m => !done.has(m.name) && [...after.get(m.name)].every(n => done.has(n)))
      ?? list.find(m => !done.has(m.name))
    done.add(next.name)
    out.push(next)
  }
  return out
}

// Tools may give DSH's parameter map or a JSON Schema object; a schema becomes the map
// (its `required` list moves onto each property).
export function toParameterMap(parameters) {
  if (parameters?.type !== 'object' || typeof parameters.properties !== 'object') return parameters ?? {}
  const required = new Set(parameters.required ?? [])
  // DSH's value DSL takes type, description, enum, and items; other keywords
  // (minLength, maxLength, ...) are dropped, so execute() must still check them.
  const keep = ({ type, description, enum: values, items }) => ({ type, ...(description ? { description } : {}), ...(values ? { enum: values } : {}), ...(items ? { items: keep(items) } : {}) })
  return Object.fromEntries(Object.entries(parameters.properties).map(([key, schema]) => [key, { ...keep(schema), ...(required.has(key) ? { required: true } : {}) }]))
}

export function install(rt) {
  const { ctx, state, config } = rt
  // config.flybot.bypass: { <middleware that asks>: [<middleware names it may skip>] }
  const bypassGrants = config?.flybot?.bypass ?? {}
  const warn = (...args) => rt.warn?.(...args)
  const emit = (name, payload) => { try { ctx.emit?.(name, payload) } catch (error) { warn('flybot: %s listener failed: %s', name, error) } }

  // ---------------------------------------------------------------- events
  const listeners = { 'change': new Set(), 'bot.created': new Set(), 'bot.removed': new Set(), 'bot.grants': new Set() }
  const changes = []
  let changeSeq = 0
  // A new host process starts a new epoch: the browser resets its watermark on a change.
  const changeEpoch = randomUUID()
  const fire = (event, payload) => {
    if (event === 'change') {
      changes.push({ seq: ++changeSeq, ...structuredClone(payload) })
      if (changes.length > CHANGES_KEPT) changes.shift()
    }
    for (const fn of [...listeners[event]]) {
      try { fn(structuredClone(payload)) } catch (error) { warn('flybot: %s listener failed: %s', event, error) }
    }
    emit(`flybot/${event}`, clone(payload))
  }
  // Cordis-style subscription, returns a disposer. 'change' listeners hear their own
  // plugin's fields unless they pass { all: true }; 'bot.removed' hears every removal.
  const onFor = plugin => (event, fn, { all = false } = {}) => {
    if (!listeners[event]) throw new Error(`flybot: unknown event ${event}; use 'change', 'bot.created', 'bot.removed', or 'bot.grants'`)
    const listener = event === 'change' && !all ? change => { if (change.plugin === plugin) fn(change) } : fn
    listeners[event].add(listener)
    return () => listeners[event].delete(listener)
  }

  // ---------------------------------------------------------------- bots
  // The team: every Bot but friends' Bots, which are chats of their own (remote-chat.js).
  const team = () => Object.values(state.bots).filter(bot => bot.remote === undefined)
  const view = bot => (bot === undefined ? undefined : {
    id: bot.id, name: bot.name, role: bot.role, isMain: rt.isMain(bot.id), createdBy: bot.createdBy ?? null,
    granted: rt.hasAnyGrant?.(bot.id) === true,
    systemPrompt: bot.systemPrompt ?? '', fields: clone(bot.fields ?? {}),
  })
  const persist = () => rt.save().catch(error => warn('flybot: save failed: %s', error))

  async function create({ name, systemPrompt, fields, role, instructions, createdBy, plugin = SHARED } = {}) {
    checkName('plugin', plugin)
    await rt.load()
    const bot = await rt.createBot({
      name, role, instructions, createdBy,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(fields && Object.keys(fields).length > 0 ? { fields: { [plugin]: fields } } : {}),
    })
    for (const [key, value] of Object.entries(fields ?? {})) fire('change', { botId: bot.id, plugin, key, value: clone(value), prev: undefined })
    return bot.id
  }
  function setSystemPrompt(id, text) {
    const bot = rt.botOf(id)
    if (bot === undefined) throw new Error(`flybot: unknown Bot ${id}`)
    const clean = String(text ?? '').trim()
    if ((bot.systemPrompt ?? '') === clean) return
    if (clean) bot.systemPrompt = clean
    else delete bot.systemPrompt
    persist()
  }
  // Every new Bot (UI, create_bot, plugins) is announced with its record.
  const createBot = rt.createBot
  if (typeof createBot === 'function') {
    rt.createBot = async (...args) => {
      const bot = await createBot(...args)
      if (bot?.id !== undefined && bot.remote === undefined) fire('bot.created', view(rt.botOf(bot.id)) ?? view(bot))
      return bot
    }
  }
  // A deleted Bot's fields go with it: one 'bot.removed', no per-field events.
  const deleteBot = rt.deleteBot
  if (typeof deleteBot === 'function') {
    rt.deleteBot = async (id, ...rest) => {
      // Fires after removal; the payload keeps the Bot's last record, fields included.
      const last = view(rt.botOf(id))
      const remote = rt.botOf(id)?.remote
      const remoteChat = remote !== undefined
      const result = await deleteBot(id, ...rest)
      if (!remoteChat) {
        fire('bot.removed', { ...last, botId: id, bot: last })
        // A hold naming this Bot as sender or target can no longer be spent (#52).
        await invalidateFor([id], 'the Bot was deleted')
        // Its open tasks fail rather than wait forever (#54).
        await rt.taskBotDeleted?.(id)
      // Deleting a friend's Bot's chat clears it; the friend's Bot is still there, so it gets a
      // fresh, empty chat at once. Otherwise its row waits ("opening its chat…") until the
      // plugin next publishes its roster, which may be hours or the next restart.
      } else if (typeof remote?.handle === 'string' && typeof remote.plugin === 'string') {
        const published = (state.flybot?.remote?.[remote.plugin] ?? []).find(bot => bot.handle === remote.handle)
        if (published !== undefined) {
          await rt.remoteChats?.open({ handle: published.handle, name: published.name, home: published.home, homeName: published.homeName, plugin: remote.plugin })
            .catch(error => warn('flybot: chat for %s not reopened: %s', remote.handle, error))
        }
      }
      return result
    }
  }
  // A demoted Main Bot's holds were queued under its Chief authority; they die with the
  // role (docs/subsystems/team.md, replaced Chiefs) (#52).
  const setMain = rt.setMain
  if (typeof setMain === 'function') {
    rt.setMain = async (id, main, opts = {}) => {
      const before = [...state.mainBotIds]
      const result = await setMain(id, main, opts)
      const demoted = before.filter(other => !state.mainBotIds.includes(other))
      if (demoted.length > 0) await invalidateFor(demoted, 'the Chief that held this was replaced', 'from')
      return result
    }
  }
  // ---------------------------------------------------------------- fields (synchronous)
  const fieldsFor = (plugin) => {
    checkName('plugin', plugin)
    const on = onFor(plugin)
    return {
      get(botId, key) {
        return clone(rt.botOf(botId)?.fields?.[plugin]?.[key])
      },
      all(botId) {
        return clone(rt.botOf(botId)?.fields?.[plugin] ?? {})
      },
      // Saves in the background; null or undefined removes the key.
      set(botId, key, value) {
        if (typeof key !== 'string' || key === '') throw new Error('flybot: a field needs a key')
        const bot = rt.botOf(botId)
        if (bot === undefined) throw new Error(`flybot: unknown Bot ${botId}`)
        const prev = clone(bot.fields?.[plugin]?.[key])
        const next = value === null ? undefined : clone(value)
        if (same(prev, next)) return
        bot.fields ??= {}
        bot.fields[plugin] ??= {}
        if (next === undefined) delete bot.fields[plugin][key]
        else bot.fields[plugin][key] = next
        if (Object.keys(bot.fields[plugin]).length === 0) delete bot.fields[plugin]
        if (Object.keys(bot.fields).length === 0) delete bot.fields
        persist()
        fire('change', { botId, plugin, key, value: next, prev })
      },
      // Bots that have the key; with `value`, only those whose value deep-equals it.
      query(key, value) {
        return team()
          .filter(bot => bot.fields?.[plugin] !== undefined && Object.hasOwn(bot.fields[plugin], key) && (value === undefined || same(bot.fields[plugin][key], value)))
          .map(view)
      },
      on,
    }
  }

  // ---------------------------------------------------------------- send middleware
  let chain = []
  const use = (middleware) => {
    checkName('middleware name', middleware?.name)
    if (typeof middleware.handle !== 'function') throw new Error('flybot: middleware needs handle()')
    if (chain.some(m => m.name === middleware.name)) throw new Error(`flybot: middleware ${middleware.name} exists`)
    chain = orderMiddleware([...chain, middleware])
    return () => { chain = chain.filter(m => m !== middleware) }
  }
  // `after`: the middleware that held this message; an approved hold resumes the chain
  // just after it, so later policies (audit, leak prevention) still run.
  const evaluate = async (msg, { after } = {}) => {
    const skip = new Set()
    let resumed = after === undefined || !chain.some(m => m.name === after)
    for (const middleware of chain) {
      if (!resumed) { if (middleware.name === after) resumed = true; continue }
      if (skip.has(middleware.name)) continue
      let verdict
      try {
        verdict = await middleware.handle(clone(msg))
      } catch (error) {
        return { action: 'deny', reason: `${middleware.name} failed: ${error?.message ?? error}`, by: middleware.name }
      }
      if (verdict === undefined || verdict === null) continue
      if (!ACTIONS.has(verdict.action)) return { action: 'deny', reason: `${middleware.name} returned ${JSON.stringify(verdict.action)}`, by: middleware.name }
      if (verdict.action === 'allow') {
        // A bypass counts only for names config grants to this middleware.
        const granted = bypassGrants[middleware.name] ?? []
        for (const name of verdict.bypass ?? []) {
          if (granted.includes(name) || granted.includes('*')) skip.add(name)
        }
        continue
      }
      return { action: verdict.action, reason: verdict.reason || `${verdict.action} by ${middleware.name}`, by: middleware.name }
    }
    return { action: 'allow' }
  }

  const transports = new Map()
  const addTransport = (kind, transport) => {
    if (transports.has(kind)) throw new Error(`flybot: transport ${kind} exists`)
    transports.set(kind, transport)
    return () => transports.delete(kind)
  }

  // ---------------------------------------------------------------- approvals
  const store = () => {
    state.flybot ??= {}
    state.flybot.approvals ??= {}
    return state.flybot.approvals
  }
  // The version hash binds a decision to the exact request content: a record whose
  // request changed after it was held (or across owners) is stale, never dispatched (#52).
  const requestVersion = (msg) => createHash('sha256').update(JSON.stringify([
    msg?.from, msg?.to, msg?.text, msg?.role,
    (Array.isArray(msg?.attachments) ? msg.attachments : []).map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  ])).digest('hex')
  // The owner a held send belongs to is the sender Bot's owner, derived from the team
  // state at the moment it matters — never from a claim inside the message (#52).
  const ownerOfRequest = (request) => {
    const bot = typeof request?.from === 'string' ? rt.botOf(request.from) : undefined
    return bot?.ownerId ?? null
  }
  const nameOf = (ref) => (isRemote(ref) ? toRemote(ref)?.handle : rt.botOf(ref)?.name) ?? String(ref ?? '')
  // Why a held send may no longer be spent; undefined when it still can. Old records
  // from before the version stamp keep working (they only miss the tamper check).
  const staleReason = (approval) => {
    const request = approval?.request
    if (request === undefined || request === null) return 'the held request is missing'
    if (approval.version !== undefined && requestVersion(request) !== approval.version) return 'the request changed after it was held'
    if (!isRemote(request.from) && (typeof request.from !== 'string' || rt.botOf(request.from) === undefined)) return 'the sender Bot no longer exists'
    const owner = ownerOfRequest(request)
    if (owner === null) return 'the sender Bot has no owner on this team'
    if (approval.ownerId !== undefined && approval.ownerId !== owner) return 'the sender Bot changed owners after it was held'
    if (!isRemote(request.to) && rt.botOf(request.to) === undefined) return 'the target Bot no longer exists'
    return undefined
  }
  const approvalListeners = new Set()
  const approvalsChanged = (approval) => {
    for (const fn of [...approvalListeners]) {
      try { fn(clone(approval)) } catch (error) { warn('flybot: approval listener failed: %s', error) }
    }
    emit('flybot/approval', clone(approval))
  }
  // Queued work whose authority is gone does not wait forever: a hold naming one of
  // these Bots as sender or target is marked stale (still listed for the audit view).
  // `field` narrows the match ('from': sender-side only, e.g. a demoted Chief).
  // Unknown values must throw: a silent no-op would skip invalidation (#97).
  const invalidateFor = async (botIds, reason, field) => {
    if (field !== undefined && field !== 'from') {
      throw new Error(`flybot: invalidateFor field must be 'from' or omitted, got ${JSON.stringify(field)}`)
    }
    await rt.load()
    const ids = new Set(botIds)
    // Pending, and approved-but-not-yet-dispatched: otherwise a concurrent setMain /
    // deleteBot during release() skips the record (status already `approved`) (#97).
    const inFlight = a => a.status === 'pending' || (a.status === 'approved' && a.exchangeId === undefined)
    const hit = Object.values(store()).filter(a => inFlight(a)
      && (ids.has(a.request?.from) && (field === undefined || field === 'from')
        || ids.has(a.request?.to) && field === undefined))
    if (hit.length === 0) return
    for (const approval of hit) {
      approval.status = 'stale'
      approval.error = reason
      approval.decidedAt = Date.now()
    }
    await rt.save()
    for (const approval of hit) approvalsChanged(approval)
  }

  let innerDeliver
  const dispatch = async (msg) => {
    if (isRemote(msg.to)) {
      const kind = msg.to.transport ?? 'bot-social'
      const transport = transports.get(kind)
      if (transport === undefined) throw new Error(`flybot: no transport ${kind}`)
      const { deliverArgs, ...plain } = msg
      const result = await transport.send(clone(plain))
      return result?.exchangeId ?? msg.exchangeId
    }
    return innerDeliver({ ...msg.deliverArgs, flybotChecked: true })
  }

  const hold = async (msg, verdict) => {
    await rt.load()
    const all = store()
    if (Object.values(all).filter(a => a.status === 'pending').length >= PENDING_MAX) {
      throw new HoldFull(`${PENDING_MAX} messages already wait for approval; decide those first`)
    }
    const audience = rt.roomOf?.(msg?.meta?.sessionId)?.id
    const ownerId = ownerOfRequest(msg)
    const approval = {
      id: randomUUID(), status: 'pending', reason: verdict.reason, by: verdict.by, createdAt: Date.now(),
      request: clone(msg),
      // Server-derived provenance (#52): what was held, who owns the decision, where it
      // came from. Fields of msg itself (meta especially) are data, never authority.
      requestId: msg.exchangeId,
      version: requestVersion(msg),
      origin: { via: msg.via, hop: msg.hop ?? 0, ...(audience ? { audience } : {}) },
      ...(ownerId !== null ? { ownerId } : {}),
    }
    all[approval.id] = approval
    const done = Object.values(all).filter(a => a.status !== 'pending').sort((a, b) => a.createdAt - b.createdAt)
    for (const old of done.slice(0, Math.max(0, Object.keys(all).length - APPROVALS_KEPT))) delete all[old.id]
    await rt.save()
    approvalsChanged(approval)
    // A working task's consequential send is held: the task blocks on this card (#54).
    try { await rt.taskHeld?.(msg, approval) } catch (error) { warn('flybot: task hold failed: %s', error) }
    return approval
  }

  // An approved hold: the rest of the chain decides (a later deny or hold still counts),
  // then it is dispatched; a failed dispatch stays visible for Retry. The hold is
  // revalidated first: hours may have passed since the decision (#52).
  const release = async (approval) => {
    const stale = staleReason(approval)
    if (stale !== undefined) {
      approval.status = 'stale'
      approval.error = stale
      return
    }
    let verdict
    // Approved or not, the owner policy is asked again: the hold may be hours old.
    const owner = ownerPolicy(approval.request)
    if (owner.action === 'deny') verdict = owner
    else try { verdict = await evaluate(approval.request, { after: approval.by }) } catch (error) { verdict = { action: 'deny', reason: error?.message ?? String(error) } }
    if (verdict.action === 'deny') {
      approval.status = 'denied'
      approval.error = verdict.reason
      return
    }
    if (verdict.action === 'hold') {
      try {
        const next = await hold(approval.request, verdict)
        approval.next = next.id
      } catch (error) {
        approval.status = 'failed'
        approval.error = error?.message ?? String(error)
      }
      return
    }
    // Re-check immediately before dispatch: evaluate() yielded, so a concurrent
    // setMain/deleteBot may have marked this in-flight approve stale (#97).
    if (approval.status === 'stale') return
    const still = staleReason(approval)
    if (still !== undefined) {
      approval.status = 'stale'
      approval.error = still
      return
    }
    try {
      approval.exchangeId = await dispatch(approval.request)
    } catch (error) {
      approval.status = 'failed'
      approval.error = error?.message ?? String(error)
    }
  }

  const approvals = {
    // Under member enforcement a member sees only the holds of their own Bots; the
    // decision on each stays owner-checked in decide() (#52).
    list: ({ status = 'pending', actor } = {}) => {
      const enforced = rt.authzEnforced()
      return Object.values(store())
        .filter(a => status === 'all' || (Array.isArray(status) ? status.includes(a.status) : a.status === status))
        .filter(a => {
          if (!enforced || actor === undefined) return true
          const owner = ownerOfRequest(a.request)
          return owner !== null && owner === actor.memberId
        })
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(a => ({ ...clone(a), ownerId: ownerOfRequest(a.request) ?? undefined, senderName: nameOf(a.request?.from), targetName: nameOf(a.request?.to) }))
    },
    get: id => clone(store()[id]),
    // Owner only: the decision is bound to the session of the member who owns the sender
    // Bot, resolved from the member-session header — a body actorId grants nothing.
    // Without member sessions the single-human host decides as before (#52).
    async decide(id, decision, { note, actor } = {}) {
      await rt.load()
      const approval = store()[id]
      if (approval === undefined) throw new Error(`flybot: no approval ${id}`)
      const ownerId = ownerOfRequest(approval.request)
      if (rt.authzEnforced()) {
        if (actor === null || actor === undefined) throw Object.assign(new Error('Sign in first'), { code: 'bot/unauthorized' })
        if (ownerId === null || ownerId !== actor.memberId) throw Object.assign(new Error('You do not own that approval'), { code: 'bot/forbidden' })
      }
      if (decision === 'retry') {
        if (approval.status !== 'failed') throw Object.assign(new Error(`flybot: only a failed send can be retried (${id} is ${approval.status})`), { code: 'bot/stale' })
        approval.status = 'approved'
        delete approval.error
        await release(approval)
        await rt.save()
        approvalsChanged(approval)
        return clone(approval)
      }
      if (approval.status !== 'pending') throw Object.assign(new Error(`flybot: approval ${id} is already ${approval.status}`), { code: 'bot/stale' })
      if (decision !== 'approve' && decision !== 'reject') throw new Error('flybot: decision is approve or reject')
      approval.status = decision === 'approve' ? 'approved' : 'rejected'
      approval.decidedAt = Date.now()
      if (note) approval.note = String(note)
      if (decision === 'approve') await release(approval)
      // The blocked task resumes on approve, or ends on reject (#54).
      try { await rt.taskDecided?.(approval, decision) } catch (error) { warn('flybot: task decision failed: %s', error) }
      await rt.save()
      approvalsChanged(approval)
      return clone(approval)
    },
    onChange(fn) {
      approvalListeners.add(fn)
      return () => approvalListeners.delete(fn)
    },
  }

  // ---------------------------------------------------------------- bot.send
  const outcomes = new Map()
  const noteOutcome = (exchangeId, outcome) => {
    outcomes.set(exchangeId, outcome)
    if (outcomes.size > 500) outcomes.delete(outcomes.keys().next().value)
  }
  // The owner policy (reach.js) sits before the chain and is not a middleware: no verdict, bypass
  // or priority of a plugin can skip it. It judges the message as it is now, so a Bot that was
  // revoked since it was written is refused.
  const ownerPolicy = msg => rt.reach?.(msg) ?? { action: 'allow' }
  const run = async (msg) => {
    const owner = ownerPolicy(msg)
    if (owner.action === 'deny') return { action: 'deny', reason: owner.reason, by: owner.by }
    const verdict = await evaluate(msg)
    if (verdict.action === 'deny') return { action: 'deny', reason: verdict.reason, by: verdict.by }
    if (verdict.action === 'hold') {
      let approval
      try { approval = await hold(msg, verdict) } catch (error) {
        if (error instanceof HoldFull) return { action: 'deny', reason: error.message, by: verdict.by }
        throw error
      }
      return { action: 'hold', approvalId: approval.id, reason: verdict.reason, by: verdict.by }
    }
    return { action: 'allow', exchangeId: await dispatch(msg) }
  }

  // File metadata a send carries (names and sizes for the approval card; a path or a
  // remote id for the transport). Bytes never travel through the middleware chain.
  const cleanAttachments = (list) => {
    if (list === undefined || list === null) return []
    if (!Array.isArray(list)) throw new Error('flybot: attachments must be an array')
    if (list.length > MAX_ATTACHMENTS) throw new Error(`flybot: at most ${MAX_ATTACHMENTS} attachments`)
    return list.map((file) => {
      const name = String(file?.name ?? '').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, 200)
      const size = Number(file?.size)
      if (!name || !Number.isInteger(size) || size < 0) throw new Error('flybot: an attachment needs a name and a size')
      return {
        name, size, mime: String(file.mime ?? 'application/octet-stream').slice(0, 120),
        ...(/^[0-9a-f]{64}$/.test(file.sha256 ?? '') ? { sha256: file.sha256 } : {}),
        ...(typeof file.id === 'string' ? { id: file.id.slice(0, 80) } : {}),
        ...(typeof file.path === 'string' ? { path: file.path } : {}),
      }
    })
  }

  async function send({ from, to, text, role = 'request', hop = 0, via = SHARED, meta, attachments } = {}) {
    await rt.load()
    if (typeof text !== 'string' || text.trim() === '') throw new Error('flybot: send needs text')
    if (text.length > MAX_SEND_TEXT) throw new Error(`flybot: a message is at most ${MAX_SEND_TEXT} characters`)
    if (role !== 'request' && role !== 'reply') throw new Error(`flybot: unsupported role ${role}`)
    if (!isRemote(from) && rt.botOf(from) === undefined) throw new Error(`flybot: unknown sender ${from}`)
    if (!isRemote(to) && rt.botOf(to) === undefined) throw new Error(`flybot: unknown Bot ${to}`)
    if (isRemote(from) && isRemote(to)) throw new Error('flybot: one side must be a local Bot')
    from = isRemote(from) ? toRemote(from) : from
    to = isRemote(to) ? toRemote(to) : to
    const files = cleanAttachments(attachments)
    const exchangeId = randomUUID()
    const msg = { from, to, target: targetOf(to), text, role, hop, via, exchangeId, ...(meta ? { meta } : {}), ...(files.length ? { attachments: files } : {}) }
    if (!isRemote(to)) {
      // Only a remote sender's files reach a local Bot, as references (no local paths).
      const shown = files.map(({ path, ...ref }) => ref)
      msg.deliverArgs = isRemote(from)
        ? { toId: to, role, hop, text, exchangeId, fromName: from.name ?? remoteMembers.get(from.handle)?.name ?? from.handle, untrusted: true, remote: { handle: from.handle, home: from.home }, ...(shown.length ? { attachments: shown } : {}) }
        : { fromId: from, toId: to, role, hop, text, exchangeId }
    }
    const result = await run(msg)
    noteOutcome(exchangeId, result)
    return result
  }
  send.use = use
  send.list = () => chain.map(m => ({ name: m.name, priority: priorityOf(m), before: m.before ?? [], after: m.after ?? [] }))
  send.priority = SEND_PRIORITY

  // The gate around ds-bot's own rt.deliver. Approved and re-sent messages pass through.
  const gated = args => args.fromId !== undefined && rt.botOf(args.fromId) !== undefined && BOT_TO_BOT_ROLES.has(args.role)
    && !args.flybotChecked && !args.resent && !args.resumed && !args.retried && !args.deferred
  innerDeliver = rt.deliver
  rt.deliver = async (args) => {
    // Everything that is not a first, checked send still carries its sender: resumed, retried,
    // deferred and re-sent deliveries (and kickoffs, notices) are judged by the owner policy
    // now, since the Bot they name may have had its grant revoked, replaced or removed since.
    if (!gated(args) && !args.flybotChecked && (args.remote?.handle || args.fromId !== undefined)) {
      const owner = ownerPolicy(args)
      if (owner.action === 'deny') {
        const exchangeId = args.exchangeId ?? randomUUID()
        noteOutcome(exchangeId, { action: 'deny', reason: owner.reason, by: owner.by })
        warn('flybot: delivery to %s refused: %s', args.toId, owner.reason)
        return exchangeId
      }
    }
    if (!gated(args)) return innerDeliver(args)
    const exchangeId = args.exchangeId ?? randomUUID()
    const msg = { from: args.fromId, to: args.toId, target: targetOf(args.toId), text: args.text, role: args.role, hop: args.hop ?? 0, via: 'ds-bot', exchangeId, deliverArgs: { ...args, exchangeId } }
    noteOutcome(exchangeId, await run(msg))
    return exchangeId
  }

  // ---------------------------------------------------------------- tools
  const callerOf = exec => rt.botOf(rt.selfOf(exec?.agent?.id))
  const visible = (def, botId) => {
    if (botId === undefined) return false
    if (typeof def.visibleTo !== 'function') return true
    const answer = def.visibleTo(botId)
    // visibleTo is synchronous by contract; a Promise is settled again in execute.
    return answer instanceof Promise ? true : Boolean(answer)
  }
  const tools = {
    register(def) {
      if (typeof def?.name !== 'string' || typeof def.execute !== 'function') throw new Error('flybot: a tool needs a name and execute()')
      const refusal = `${def.name} is not available to this Bot.`
      const disposeGuard = ctx.tools.guard?.(exec => (exec.name === def.name && !visible(def, callerOf(exec)?.id) ? refusal : undefined))
      const { visibleTo, ...spec } = def
      spec.parameters = toParameterMap(spec.parameters)
      const disposeTool = ctx.tools.register(defineTool({
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] },
        ...spec,
        async execute(args, exec) {
          await rt.load()
          const botId = callerOf(exec)?.id
          if (botId === undefined || (visibleTo && !(await visibleTo(botId)))) throw new Error(refusal)
          const result = await def.execute(args, { ...exec, botId })
          return typeof result === 'string' ? result : JSON.stringify(result)
        },
      }))
      if (typeof visibleTo === 'function') gatedTools.set(def.name, def)
      return () => {
        gatedTools.delete(def.name)
        disposeTool?.()
        disposeGuard?.()
      }
    },
  }

  // A tool whose visibleTo says no is taken out of that Bot's tool list, not only
  // refused when called. Each Agent's mask is recomputed when it is resolved, so a
  // Bot that joins (or leaves) a plugin's scope gets (or loses) the tool next turn.
  const gatedTools = new Map()
  const masks = new WeakMap()
  function hidePluginTools(agent) {
    if (agent === undefined || typeof agent.ctx?.tools?.restrict !== 'function') return
    const bot = rt.botOf(rt.selfOf(agent.session?.id ?? agent.id))
    if (bot === undefined) return
    let known
    try { known = new Set(ctx.tools.schemas(agent).map(schema => schema.name)) } catch { return }
    const deny = [...gatedTools.values()].filter(def => known.has(def.name) && !visible(def, bot.id)).map(def => def.name).sort()
    const key = deny.join(',')
    const current = masks.get(agent)
    if ((current?.key ?? '') === key) return
    try {
      current?.dispose?.()
      masks.set(agent, { key, dispose: deny.length ? agent.ctx.tools.restrict({ deny }) : undefined })
    } catch (error) {
      warn('flybot: tools stay listed for %s: %s', bot.name, error)
    }
  }
  ctx.on('agent/created', ({ agent }) => { void rt.load().then(() => hidePluginTools(agent)).catch(() => {}) })

  // ---------------------------------------------------------------- remote members
  // Remote Bots a plugin can reach (social: friends' Bots). They are chat members the
  // UI shows with a remote badge and the "@" menu offers, never team Bots (bot.list()).
  // Kept in state.json so the roster revision moves when they change.
  const remoteStore = () => {
    state.flybot ??= {}
    state.flybot.remote ??= {}
    return state.flybot.remote
  }
  const cleanRemote = (plugin, bot) => {
    const remote = toRemote(bot.handle)
    const name = cleanPublishedName(bot.name) || cleanPublishedName(remote.handle) || 'a remote Bot'
    const homeName = cleanPublishedName(bot.homeName)
    const owner = cleanPublishedName(bot.owner)
    return { handle: remote.handle, home: bot.home ? toRemote(bot.home).handle : remote.home, name, ...(homeName ? { homeName } : {}), ...(owner ? { owner } : {}), plugin, remote: true }
  }
  const remoteMembers = {
    // Replaces this plugin's list; saves only when it changed.
    publish(plugin, list) {
      checkName('plugin', plugin)
      const next = (list ?? []).filter(bot => typeof bot?.handle === 'string' && !isHomeLevelRemote(bot)).map(bot => cleanRemote(plugin, bot))
      // A read-only host shows what the writer saved; it changes nothing.
      if (rt.readOnly() !== undefined) return
      const all = remoteStore()
      // Every granted remote Bot gets a chat of its own (remote-chat.js). Hidden
      // and home-level handles are not in `next`, so those sessions go gone/hidden.
      const synced = rt.remoteChats?.sync(plugin, next)?.catch(error => warn('flybot: remote chats not synced: %s', error))
      const jobs = []
      if (synced && typeof synced.then === 'function') jobs.push(synced)
      if (!same(all[plugin] ?? [], next)) {
        if (next.length === 0) delete all[plugin]
        else all[plugin] = next
        jobs.push(Promise.resolve(persist()))
      }
      return jobs.length ? Promise.all(jobs) : synced
    },
    list: () => Object.values(state.flybot?.remote ?? {}).flat().map(clone),
    get: handle => remoteMembers.list().find(bot => bot.handle === toRemote(handle)?.handle),
  }

  // The user's "@handle" of a remote member in a Bot's chat or a group goes out through
  // bot.send (so the social middleware still decides), from that Bot or the group's admin.
  const SESSION_CHIP = /@\[((?:\\.|[^\]\\])*)\]\(dsh-session:([A-Za-z0-9_-]+)\)/g
  const decodeChip = payload => {
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return undefined }
  }
  const seenUserMessages = new Set()
  async function sendUserMentions(sessionId, text, key) {
    if (seenUserMessages.has(key)) return []
    seenUserMessages.add(key)
    if (seenUserMessages.size > 1000) seenUserMessages.delete(seenUserMessages.values().next().value)
    const known = new Map(remoteMembers.list().map(bot => [bot.handle, bot]))
    if (known.size === 0) return []
    const room = rt.roomOf(rt.groupOwners?.get(sessionId)?.roomId ?? sessionId)
    const from = room ? (room.admin ?? room.members?.[0]) : rt.selfOf(sessionId)
    if (from === undefined || rt.botOf(from) === undefined) return []
    // The same "@" rule as the team (code, links and quoted lines are literal), over the
    // friends' Bots by handle and by chat name; a menu chip names the chat directly.
    const handles = new Set()
    const quoted = text.replace(/^[ \t]*>.*$/gm, line => ' '.repeat(line.length))
    const names = [...known.values()].flatMap(bot => [
      { name: bot.handle.slice(1), handle: bot.handle },
      ...Object.values(state.bots).filter(chat => chat.remote?.handle === bot.handle && chat.name).map(chat => ({ name: chat.name, handle: bot.handle })),
    ])
    for (const span of mentionSpans(quoted, names)) if (span.bot) handles.add(span.bot.handle)
    for (const match of quoted.matchAll(SESSION_CHIP)) {
      const handle = rt.botOf(decodeChip(match[2]))?.remote?.handle
      if (handle && known.has(handle)) handles.add(handle)
    }
    const plain = text.replace(SESSION_CHIP, (_, label) => `@${label.replace(/\\([\\\]])/g, '$1')}`).trim()
    const results = []
    for (const handle of handles) {
      try {
        results.push({ handle, ...(await send({ from, to: handle, text: plain, via: 'user-mention', meta: { sessionId } })) })
      } catch (error) {
        warn('flybot: sending to %s failed: %s', handle, error)
        results.push({ handle, action: 'deny', reason: error?.message ?? String(error) })
      }
    }
    await mentionReceipt(sessionId, room, results, known)
    return results
  }

  // A group hears what each @ of a friend's Bot did (#80, #81): the answer never
  // re-enters the group (it lands in the friend's Bot's own chat), and a denied or
  // failed send was visible only in this log. One muted line in the room, posted as a
  // relay role the room's round machinery does not answer (groups.js `opens`).
  async function mentionReceipt(sessionId, room, results, known) {
    if (room === undefined || results.length === 0) return
    const line = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240)
    const lines = results.map(({ handle, action, reason }) => {
      const name = cleanName(known.get(handle)?.name, handle)
      const why = line(reason)
      if (action === 'deny') return `${name}: not sent${why ? ` — ${why}` : ''}`
      if (action === 'hold') return `${name}: held for your approval${why ? ` — ${why}` : ''}`
      return `${name}: sent — its replies appear in its own chat under Friends' Bots, not in this group`
    })
    try {
      const agent = await rt.resolveAgent(sessionId)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: SOURCE_KIND, form: 'relay', role: 'mention', roomId: room.id, exchangeId: randomUUID(), hop: 0 },
      }))
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      warn('flybot: mention receipt for %s failed: %s', sessionId, error)
    }
  }
  const textOfContent = content => (Array.isArray(content) ? content.map(block => (block?.type === 'text' ? block.text : '')).join('\n') : String(content ?? ''))
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message') return
    const source = event.data?.source
    if (source !== undefined && source !== null && source.kind !== 'user') return
    const id = session?.id
    if (id === undefined || (!rt.isBotSession(id) && !rt.roomOf(id))) return
    void sendUserMentions(id, textOfContent(event.data?.content), `${id}:${event.seq ?? event.id ?? textOfContent(event.data?.content)}`)
      .then(async results => {
        // A message the user addressed to a friend's Bot is that Bot's to answer; its
        // reply comes back into this chat. The local Bot does not answer it itself.
        if (!results.some(result => result.action !== 'deny') || rt.roomOf(id)) return
        try { (await rt.resolveAgent(id)).cancel({ kind: 'user' }) } catch {}
      })
      .catch(error => warn('flybot: user mention failed: %s', error))
  })

  // ---------------------------------------------------------------- UI endpoints
  const handlers = new Map()
  // Endpoints a read-only host (another dsh holds the team) still answers: queries only.
  const READ_ENDPOINTS = new Set(['bots', 'remote-members', 'changes', 'approvals'])
  const readHandlers = new Set()
  const api = {
    // `{ read: true }`: the handler only reads, so a read-only host serves it too.
    handle(name, fn, { read = false } = {}) {
      if (typeof name !== 'string' || name === '' || BUILTIN_ENDPOINTS.has(name)) throw new Error(`flybot: api name ${JSON.stringify(name)} is reserved`)
      if (handlers.has(name)) throw new Error(`flybot: api ${name} exists`)
      handlers.set(name, fn)
      if (read) readHandlers.add(name)
      return () => { handlers.delete(name); readHandlers.delete(name) }
    },
  }
  const isReadEndpoint = name => READ_ENDPOINTS.has(name) || readHandlers.has(name)
  async function endpoint(name, payload, { actor } = {}) {
    await rt.load()
    const body = payload ?? {}
    switch (name) {
      case 'bots': return team().map(view)
      case 'remote-members': return remoteMembers.list()
      case 'changes': {
        const since = body.epoch === changeEpoch ? Number(body.since ?? 0) : 0
        return { epoch: changeEpoch, seq: changeSeq, changes: changes.filter(change => change.seq > since).map(change => structuredClone(change)) }
      }
      case 'approvals': return approvals.list({ ...body, actor })
      case 'decide': return approvals.decide(String(body.id ?? ''), body.decision, { note: body.note, actor })
      default: {
        const handler = handlers.get(name)
        if (handler === undefined) throw Object.assign(new Error(`Unknown FlyBot endpoint ${name}`), { code: 'bot/not-found' })
        return handler(body)
      }
    }
  }

  const build = (plugin) => {
    if (plugin === SHARED && built) throw new Error(`flybot: '${SHARED}' is the unscoped service; scope a plugin by its own name`)
    const fields = fieldsFor(plugin)
    return {
    version: FLYBOT_API_VERSION,
    plugin,
    scope: build,
    bot: {
      get: id => view(rt.botOf(id)),
      list: () => team().map(view),
      find: name => view(rt.findBot?.(name)),
      isRemote,
      // Whether this Bot has at least one person-grant (Invite to this Bot was accepted).
      hasGrant: (id, peer, roomId) => rt.hasGrant?.(id, peer, roomId) === true,
      hasAnyGrant: id => rt.hasAnyGrant?.(id) === true,
      of: sessionId => view(rt.botOf(rt.selfOf(sessionId))),
      create: spec => create({ plugin, ...spec }),
      setSystemPrompt,
      // Same object as flybot.fields.
      fields,
      send: Object.assign((msg) => send({ via: plugin, ...msg }), { use, list: send.list, priority: SEND_PRIORITY }),
    },
    fields,
    // True while another dsh holds the team: plugins then only read (no polling, no writes).
    readOnly: () => rt.readOnly() !== undefined,
    // Resolves once ds-bot's saved team is loaded, so bot.list() has every Bot.
    ready: () => rt.load().then(() => undefined),
    on: onFor(plugin),
    // Same log as Settings → Feedback. Plugins must not depend on ctx.logger (DSH may export none).
    warn: (...args) => rt.warn?.(...args),
    transports: { add: addTransport },
    roomApprovals: {
      setProvider(fn) { rt.listRoomApprovals = typeof fn === 'function' ? fn : undefined },
    },
    chatApprovals: {
      setProvider(fn) { rt.listChatApprovals = typeof fn === 'function' ? fn : undefined },
    },
    rooms: {
      list() {
        return Object.values(state.rooms || {}).map(room => ({
          id: room.id,
          name: room.name,
          origin: room.origin,
          face: room.face,
          members: [...(room.members ?? [])],
          participants: (room.participants ?? []).map(p => ({ ...p })),
        }))
      },
      removeParticipant: (roomId, ref) => rt.removeRoomParticipant?.(roomId, ref),
      upsertFace: spec => rt.upsertFaceRoom?.(spec),
      applyFaceLine: (roomId, line) => {
        const room = rt.roomOf(roomId)
        if (!room) return undefined
        return rt.applyFaceRoomLine?.(room, line)
      },
      ofFace: serverId => Object.values(state.rooms || {}).find(room => room.face?.roomId === serverId),
      dropFace: roomId => rt.dropFaceRoom?.(roomId),
      onFaceLine(fn) {
        rt.faceRoomFanout = typeof fn === 'function' ? fn : undefined
        return () => { if (rt.faceRoomFanout === fn) rt.faceRoomFanout = undefined }
      },
      postNotice: (roomId, text) => {
        const room = rt.roomOf(roomId)
        if (!room || typeof rt.postToRoom !== 'function') return
        return rt.postToRoom(room, { id: 'face-notice', name: 'Room' }, String(text ?? ''), { quiet: true, notice: true })
      },
      postRemote: (roomId, { handle, name, text } = {}) => {
        const room = rt.roomOf(roomId)
        if (!room || typeof rt.postToRoom !== 'function') return
        const who = name || handle || 'Bot'
        return rt.postToRoom(room, { id: handle, name: who }, String(text ?? ''), { remote: { handle }, senderName: who })
      },
      applyInbound: (event, actor) => rt.applyInboundRoomShare?.(event, actor),
      leaveInbound: spec => rt.leaveInboundShares?.(spec),
    },
    remote: {
      publish: list => remoteMembers.publish(plugin, list),
      list: remoteMembers.list,
      get: remoteMembers.get,
      // Remote chats: a friend's Bot as a chat of its own (remote-chat.js).
      // chats.onSend(fn({ handle, text, botId, remote })) sends what the user types there;
      // chats.deliver({ handle, text, name?, home? }) posts the friend's message into it.
      chats: {
        onSend: fn => rt.remoteChats.onSend(plugin, fn),
        deliver: msg => rt.remoteChats.deliver({ ...msg, plugin }),
        open: member => rt.remoteChats.open({ ...member, plugin }),
        list: () => rt.remoteChats.list(),
        of: handle => rt.remoteChats.of(toRemote(handle)?.handle),
      },
    },
    grants: {
      of: botId => rt.grantsOf?.(botId) ?? [],
      has: (botId, peer, roomId) => rt.hasGrant?.(botId, peer, roomId) === true,
      set: (botId, list) => rt.setGrants?.(botId, list),
    },
    approvals,
    tools,
    api,
    outcomeOf: exchangeId => outcomes.get(exchangeId),
    }
  }
  let built = false
  const flybot = build(SHARED)
  built = true
  // A local Bot's answer to a friend's Bot (turns.js): back through bot.send, so the
  // plugin's middleware still decides (auto-accept, or the approval hold).
  const replyRemote = ({ from, handle, home, text, replyTo }) => send({ from, to: { kind: 'remote', handle, ...(home ? { home } : {}) }, text, role: 'reply', via: 'auto-reply', meta: { replyTo } })
  rt.flybotGrantsChanged = botId => { const bot = rt.botOf(botId); if (bot !== undefined && bot.remote === undefined) fire('bot.grants', view(bot)) }
  Object.assign(rt, { flybot, flybotReplyRemote: replyRemote, flybotEndpoint: endpoint, flybotRemoteMembers: remoteMembers.list, flybotSend: send, flybotIsRead: isReadEndpoint, flybotHideTools: hidePluginTools })
}
