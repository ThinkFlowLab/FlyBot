// What an unattended run carries (#2344): the connectors a Bot's turn gets tools or a way in from.
// One predicate for every reader — the schedule card's sentence and the set the host stores when a
// task is created or saved (#2930) — because two copies of it would let the card and the stored set
// disagree about the same Bot.
//
// A sender has neither tools nor a way in (#1263), and a channel is a sender while it is
// webhook-only (#1266); the Connectors page still offers both a switch so the owner can reconnect a
// failed one (#2354), which is why that page keeps `connectedConnectors` rather than this.
// Only an explicit false turns a connector off for one Bot: no record means on (#335).

export const isOn = (bot, id) => bot?.connectors?.[id] !== false

export const offersReach = connector => connector.kind !== 'sender'
  && !(connector.kind === 'channel' && connector.mode !== 'app')

// Ready is the only state that gives a run tools: a failed connection is unmounted before it writes
// `error`, and a `connecting` one has none yet (#2354).
export const carriedConnectors = (bot, connectors) => (connectors ?? [])
  .filter(connector => connector?.state === 'ready' && offersReach(connector) && isOn(bot, connector.id))

// The ids alone, in the roster's order: a stored set is compared with another one, never drawn.
export const carriedIds = (bot, connectors) => carriedConnectors(bot, connectors).map(connector => connector.id)
