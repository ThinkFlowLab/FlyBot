// The ONLY file that knows the shape of ctx.flybot (core/types/flybot.d.ts, API version 1).
// Everything goes through flybot.scope('flybot-timeline'):
//   on('turn.start' | 'turn.end' | 'tool.start' | 'tool.end' | 'exchange.delivered', fn) -> dispose
//     the team activity feed (metadata only; a core without it throws "unknown event")
//   bot.list() -> BotView[]            rooms.list() -> [{ id, name, ... }]
//   readOnly() -> boolean              true while another dsh holds the team: do not write
//   api.handle(name, fn, { read: true }) -> dispose     the endpoint the panel polls
//   warn(template, ...args)            host diagnostics (Settings -> Feedback)
export const NS = 'flybot-timeline'
export const FLYBOT_API = 1
export const FEED = Object.freeze(['turn.start', 'turn.end', 'tool.start', 'tool.end', 'exchange.delivered'])

export function createAdapter(flybot) {
  if (!flybot) throw new Error('@flybot/timeline needs ctx.flybot (ds-bot flybot hooks)')
  if (typeof flybot.scope !== 'function') throw new Error('@flybot/timeline needs ctx.flybot.scope (flybot API v1)')
  if (flybot.version !== undefined && flybot.version !== FLYBOT_API) {
    throw new Error(`@flybot/timeline needs flybot API v${FLYBOT_API}, ds-bot provides v${flybot.version}`)
  }
  const fb = flybot.scope(NS)
  return {
    // Throws on a core without the activity feed: the plugin then does not start.
    subscribe(handlers) {
      const offs = []
      try {
        for (const name of FEED) offs.push(fb.on(name, handlers[name]))
      } catch (error) {
        for (const off of offs) off()
        throw new Error(`@flybot/timeline needs a ds-bot with the activity feed (flybot.on('turn.start')): ${error?.message ?? error}`)
      }
      return () => { for (const off of offs.splice(0)) off() }
    },
    bots: () => (fb.bot.list() ?? []).map(bot => ({ id: bot.id, name: bot.name, isMain: bot.isMain === true })),
    rooms: () => (fb.rooms?.list?.() ?? []).map(room => ({ id: room.id, name: room.name })),
    readOnly: () => fb.readOnly?.() === true,
    handle: (name, fn) => fb.api.handle(name, fn, { read: true }),
    warn: (...args) => fb.warn?.(...args),
  }
}
