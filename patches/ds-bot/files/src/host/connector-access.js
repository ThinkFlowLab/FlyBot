// Which Bot may use a connector (#335). The connector tools (mcp__github__*, mcp__composio__*)
// are mounted once for the whole DSH profile (connectors.js), so each Bot's own tool list and
// every call are narrowed here:
//
//   - A Bot has the tools only when its owner turned that connector on for it
//     (`bot.connectors = { github?: true, composio?: true }`; absent means off, so every Bot,
//     old or new, starts without them) AND the Bot is not shared with anyone (reach.js
//     `sharedWith`: a grant to a friend or member, or a room with a friend's Bot, another person
//     or a room code). A shared Bot never gets them, whatever its switch says, so a friend who
//     reaches it cannot use the owner's mail, calendar or repositories through it.
//   - The tools are taken out of the Bot's tool list (restrict, per Agent) and every call is
//     refused by a guard that looks at the answer when the call happens, so a Bot that became
//     shared after its Agent was set up is refused too. A sub-agent counts as its parent's Bot.
//   - Sessions that belong to no Bot (the DSH Agent, plain DSH sessions) are not touched: they
//     are the owner's own, and no friend can reach them.
//
// The switches change only through `bot-connectors` on the channel, which Bots do not call.

import { GITHUB, COMPOSIO } from './connectors.js'

export const CONNECTOR_IDS = [GITHUB, COMPOSIO]
const prefixOf = id => `mcp__${id}__`
export const connectorOfTool = name => (typeof name === 'string' ? CONNECTOR_IDS.find(id => name.startsWith(prefixOf(id))) : undefined)
const MAX_DEPTH = 8

export function install(rt) {
  const { ctx, state } = rt

  const enabled = (bot, id) => bot?.connectors?.[id] === true
  const allowed = (bot, id) => enabled(bot, id) && rt.sharedWith(bot.id).length === 0

  // The Bot an Agent works for: its own chat, a group Session and an earlier part resolve through
  // selfOf; a sub-agent Session is followed up to its parent. The answer has three shapes, and only
  // the middle one keeps the tools:
  //   { bot }      the Agent works for that Bot: its switch and its sharing decide;
  //   { plain }    the chain ends at a Session that belongs to no Bot (the DSH Agent, a plain Session);
  //   { unknown }  the chain cannot be followed to its end (a parent Session that is gone, a parent
  //                chain deeper than MAX_DEPTH, a Bot id that no longer exists). It may well belong to
  //                a shared Bot, so it fails CLOSED: no connector tools, every call refused.
  const whoseAgent = (agent) => {
    let id = agent?.id ?? agent?.session?.id
    let header = agent?.session?.header
    for (let depth = 0; id !== undefined && depth < MAX_DEPTH; depth += 1) {
      const botId = rt.selfOf(id)
      if (botId !== undefined) {
        const bot = rt.botOf(botId)
        return bot === undefined ? { unknown: true } : { bot }
      }
      // The Agent's own header is part of the call; a parent's header has to be found again.
      if (depth > 0 && header === undefined) return { unknown: true }
      const parent = header?.parentSession
      if (parent === undefined) return { plain: true }
      id = String(parent)
      header = ctx.sessions?.get?.(id)?.header
    }
    return id === undefined ? { plain: true } : { unknown: true }
  }
  const botOfAgent = agent => whoseAgent(agent).bot

  ctx.tools.guard(exec => {
    const id = connectorOfTool(exec?.name)
    if (id === undefined) return undefined
    const who = whoseAgent(exec.agent)
    if (who.plain === true) return undefined
    if (who.unknown === true) return `The ${id} connector is not available here: the Bot this Agent works for could not be determined.`
    const { bot } = who
    if (allowed(bot, id)) return undefined
    return enabled(bot, id)
      ? `The ${id} connector is not available to ${bot.name} while it is shared with other people.`
      : `The ${id} connector is not turned on for ${bot.name}. The owner can turn it on in this Bot's settings.`
  })

  // ---------------------------------------------------------------- the per-Agent tool list
  const masks = new WeakMap()
  // Whether each local Bot was shared the last time its Agents were looked at (see followSharing).
  const sharedBefore = new Map()
  const seen = new WeakSet()
  const refs = []
  const track = (agent) => {
    if (agent === null || typeof agent !== 'object' || seen.has(agent)) return
    seen.add(agent)
    refs.push(new WeakRef(agent))
  }
  const served = (agent) => {
    try { return new Set(ctx.tools.schemas(agent).map(schema => schema.name)) } catch { return undefined }
  }
  const denied = (who, names) => [...names].filter((name) => {
    const id = connectorOfTool(name)
    return id !== undefined && (who.bot === undefined || !allowed(who.bot, id))
  }).sort()

  function hideConnectorTools(agent) {
    track(agent)
    if (typeof agent?.ctx?.tools?.restrict !== 'function') return
    const who = whoseAgent(agent)
    const bot = who.bot
    if (bot !== undefined) sharedBefore.set(bot.id, rt.sharedWith(bot.id).length > 0)
    // An Agent that belongs to no Bot keeps the tools, unless it already carries a mask; one whose Bot
    // cannot be determined never gets them (see whoseAgent).
    const current = masks.get(agent)
    if (who.plain === true && current === undefined) return
    const names = served(agent)
    if (names === undefined) return
    // The mask hides its own names from schemas(), so count them as known (as hooks.js does).
    for (const name of current?.deny ?? []) names.add(name)
    const key = denied(who, names).join(',')
    if ((current?.key ?? '') === key) return
    try {
      current?.dispose?.()
      masks.delete(agent)
      // After the old mask is lifted, schemas() lists what is really served now.
      const fresh = served(agent)
      const deny = fresh === undefined ? [] : denied(who, fresh)
      masks.set(agent, { key: deny.join(','), deny, dispose: deny.length > 0 ? agent.ctx.tools.restrict({ deny }) : undefined })
    } catch (error) {
      rt.warn('ds-bot: connector tools stay listed for %s: %s', bot?.name ?? agent?.id, error)
    }
  }

  const eachAgent = (visit) => {
    for (let i = refs.length - 1; i >= 0; i -= 1) {
      const agent = refs[i].deref()
      if (agent === undefined) refs.splice(i, 1)
      else visit(agent)
    }
  }
  // The profile's tool set changed (a connector mounted or went away): apply the answer to every
  // Agent that is already up. One pass per burst of changes; a pass that changes a mask changes the
  // tool set again, and the next pass finds nothing left to do.
  let scheduled = false
  ctx.on('tools/change', () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      eachAgent(hideConnectorTools)
    })
  })
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await rt.load()
      hideConnectorTools(agent)
    } catch (error) {
      rt.warn('ds-bot: connector tools for a new Agent: %s', error)
    }
  })

  // ---------------------------------------------------------------- the switch
  const clean = flags => Object.fromEntries(CONNECTOR_IDS.filter(id => flags?.[id] === true).map(id => [id, true]))

  async function setBotConnector({ botId, connector, enabled: on } = {}) {
    await rt.load()
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    const bot = rt.botOf(String(botId ?? ''))
    if (bot === undefined || bot.remote !== undefined) throw new Error('Unknown Bot')
    if (!CONNECTOR_IDS.includes(connector)) throw new Error('No such connector')
    if (typeof on !== 'boolean') throw new Error('Say whether to turn it on or off')
    if (on) {
      const who = rt.sharedWith(bot.id)
      if (who.length > 0) throw new Error(`${bot.name} is shared with ${who.slice(0, 3).join(', ')}, so it cannot use connectors. Stop sharing it first.`)
    }
    const next = clean({ ...bot.connectors, [connector]: on })
    if (Object.keys(next).length === 0) delete bot.connectors
    else bot.connectors = next
    await rt.save()
    rt.refreshConnectorTools(bot.id)
    return { botId: bot.id, connectors: { ...bot.connectors } }
  }

  // Disconnecting a connector turns it off for every Bot: a later connection (maybe another
  // account) starts from off again.
  async function forgetConnector(connector) {
    let changed = false
    for (const bot of Object.values(state.bots ?? {})) {
      if (bot.connectors?.[connector] === undefined) continue
      const next = clean({ ...bot.connectors, [connector]: false })
      if (Object.keys(next).length === 0) delete bot.connectors
      else bot.connectors = next
      changed = true
    }
    if (changed) {
      await rt.save()
      eachAgent(hideConnectorTools)
    }
  }

  // A Bot's sharing changed (a grant was added or removed): apply it to the Agents it already has.
  const refreshConnectorTools = botId => eachAgent(agent => { if (botOfAgent(agent)?.id === botId) hideConnectorTools(agent) })

  // Sharing also changes without a grant: a friend, another person or another owner's Bot joins or
  // leaves a room, or a room is joined by code. Every such change is saved, so each save compares
  // which local Bots are shared now with the last time and refreshes the Agents of those that
  // flipped. (The call guard reads `sharedWith` at call time, so a refusal never waits for this; this
  // keeps the tool list in step: no listed tool that is refused, no hidden tool once the person left.)
  const followSharing = () => {
    try {
      const flipped = []
      for (const bot of Object.values(state.bots ?? {})) {
        if (bot.remote !== undefined) continue
        const shared = rt.sharedWith(bot.id).length > 0
        if (sharedBefore.get(bot.id) === !shared) flipped.push(bot.id)
        sharedBefore.set(bot.id, shared)
      }
      for (const botId of flipped) refreshConnectorTools(botId)
    } catch (error) {
      rt.warn('ds-bot: connector tools after a sharing change: %s', error)
    }
  }
  const save = rt.save
  rt.save = async (...args) => {
    const result = await save.apply(rt, args)
    followSharing()
    return result
  }

  Object.assign(rt, { botConnectorEndpoint: setBotConnector, forgetConnector, hideConnectorTools, refreshConnectorTools })
}
