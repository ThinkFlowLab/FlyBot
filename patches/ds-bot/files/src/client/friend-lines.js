// A friend's line in one of my Bots' own chats (#420): it lands among my own messages, so DSH's
// "finished while you were away" mark is not enough (that chat may be the one on screen, or the
// line came while this window was closed). The host stamps the Bot with `friendLineAt`; this
// window keeps the last stamp it has shown per Bot and marks a Bot unread when a newer one
// arrives while its chat is not open. Stamps are compared with stamps, never with this
// browser's clock. A browser with no record yet takes everything already there as shown.

// `known`: the saved record, or null when this browser has none yet. `isOpen(bot)`: its chat is on
// screen now. Returns the record to save and the Bots to mark unread.
export function friendLineNews(bots, known, isOpen, selfId) {
  const next = { ...known }
  const unread = []
  for (const bot of bots ?? []) {
    const at = bot?.friendLineAt
    if (bot?.remote || !Number.isFinite(at)) continue
    // Another member's Bot shared in a group is theirs to read.
    if (selfId && bot.ownerId && bot.ownerId !== selfId) continue
    const shown = known?.[bot.id]
    if (shown === at) continue
    next[bot.id] = at
    if (known && (shown === undefined || at > shown) && !isOpen(bot)) unread.push(bot.id)
  }
  return { known: next, unread }
}
