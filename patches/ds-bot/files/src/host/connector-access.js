// Which Bot may use a connector (#335, #369, #601). The connector tools (mcp__github__*,
// mcp__composio__*) are mounted once for the whole DSH profile (connectors.js), so each Bot's own
// tool list and every call are narrowed here.
//
//   - Every turn of the owner's own Bots uses them (owner decision 2026-10-22, #601: 「放开，主要应该用
//     连接器工具」), whatever started the turn: the owner, a group round, another Bot, a schedule, a
//     friend talking to a shared Bot, a turn with no recorded origin. A sub-agent counts as its
//     parent's Bot.
//   - The owner can turn a connector off for one Bot: `bot.connectors = { composio: false }`. Absent
//     means on, so every Bot, old or new, has the connected connector.
//   - A friend's Bot (`remote`) never gets them, and neither does a Session whose Bot or parent chain
//     cannot be resolved (fail closed). Sessions that belong to no Bot (the DSH Agent, plain DSH
//     sessions) are not touched: they are the owner's own, and no friend can reach them.
//   - The tools are taken out of the Bot's tool list (restrict, per Agent) and every call is refused by
//     a guard that looks at the answer when the call happens.
//
// The switches change only through `bot-connectors` on the channel, which Bots do not call.

import { GITHUB, COMPOSIO } from './connectors.js'
import { OWNER, OTHER, settled } from './turn-origin.js'

export const CONNECTOR_IDS = [GITHUB, COMPOSIO]
const prefixOf = id => `mcp__${id}__`
export const connectorOfTool = name => (typeof name === 'string' ? CONNECTOR_IDS.find(id => name.startsWith(prefixOf(id))) : undefined)
const MAX_DEPTH = 8

export function install(rt) {
  const { ctx, state } = rt

  // Only an explicit false turns it off; a Bot with no record has it (a team saved by #346, where an
  // absent record meant off, therefore starts on).
  const turnedOff = (bot, id) => bot?.connectors?.[id] === false
  const allowed = (bot, id) => bot.remote === undefined && !turnedOff(bot, id)

  // The Bot an Agent works for: its own chat, a group Session and an earlier part resolve through
  // selfOf; a sub-agent Session is followed up to its parent. The answer has three shapes, and only
  // the middle one keeps the tools:
  //   { bot, sessionId }  the Agent works for that Bot, in that Bot Session (the end of the chain):
  //                the Bot's switches and whose turn it is decide;
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
        return bot === undefined ? { unknown: true } : { bot, sessionId: id }
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
  // secrets.js follows a shell call to its Bot along the same chain (#601).
  rt.whoseAgent = whoseAgent

  // The origin an Agent's request to another Bot carries on (message_bot, stop_bot, post_to_group): the
  // strictest answer, OTHER when it cannot be told. Not a Bot's Agent (the DSH Agent): the owner's own.
  // Connector tools no longer read it (#601); standing approvals and resumed turns still do.
  rt.agentOrigin = (agent) => {
    const who = whoseAgent(agent)
    if (who.plain === true) return OWNER
    return who.bot === undefined ? OTHER : settled(rt, who.sessionId) ?? OTHER
  }

  ctx.tools.guard(exec => {
    const id = connectorOfTool(exec?.name)
    if (id === undefined) return undefined
    const who = whoseAgent(exec.agent)
    if (who.plain === true) return undefined
    if (who.unknown === true) return `The ${id} connector is not available here: the Bot this Agent works for could not be determined.`
    const { bot } = who
    if (allowed(bot, id)) return undefined
    if (bot.remote !== undefined) return `The ${id} connector is not available to a friend's Bot.`
    return `The ${id} connector is turned off for ${bot.name}. Its owner can turn it on in this Bot's settings.`
  })

  // ---------------------------------------------------------------- the per-Agent tool list
  const masks = new WeakMap()
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

  // ---------------------------------------------------------------- the switches
  // What is stored is only what differs from the default: `connectors` holds the explicit offs. The
  // retired "also when others use it" offers (`connectorsShared`, before #601) are dropped on the next
  // switch or disconnect.
  const cleanOff = flags => Object.fromEntries(CONNECTOR_IDS.filter(id => flags?.[id] === false).map(id => [id, false]))
  const store = (bot, flags) => {
    delete bot.connectorsShared
    if (Object.keys(flags).length === 0) delete bot.connectors
    else bot.connectors = flags
  }

  async function setBotConnector({ botId, connector, enabled: on } = {}) {
    await rt.load()
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
    const bot = rt.botOf(String(botId ?? ''))
    if (bot === undefined || bot.remote !== undefined) throw new Error('Unknown Bot')
    if (!CONNECTOR_IDS.includes(connector)) throw new Error('No such connector')
    if (typeof on !== 'boolean') throw new Error('Say whether to turn it on or off')
    store(bot, cleanOff({ ...bot.connectors, [connector]: on ? undefined : false }))
    await rt.save()
    rt.refreshConnectorTools(bot.id)
    return { botId: bot.id, connectors: cleanOff(bot.connectors) }
  }

  // Disconnecting a connector clears every Bot's choice for it: a later connection (maybe another
  // account) starts from the default again, on for every Bot.
  async function forgetConnector(connector) {
    let changed = false
    for (const bot of Object.values(state.bots ?? {})) {
      if (bot.connectors?.[connector] === undefined && bot.connectorsShared === undefined) continue
      const { [connector]: _, ...rest } = bot.connectors ?? {}
      store(bot, cleanOff(rest))
      changed = true
    }
    if (changed) {
      await rt.save()
      eachAgent(hideConnectorTools)
    }
  }

  // A Bot's switches changed: apply it to the Agents it already has.
  const refreshConnectorTools = botId => eachAgent(agent => { if (botOfAgent(agent)?.id === botId) hideConnectorTools(agent) })

  Object.assign(rt, { botConnectorEndpoint: setBotConnector, forgetConnector, hideConnectorTools, refreshConnectorTools })
}
