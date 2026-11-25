// Bridge FlyBot composer mention candidates onto DSH inputTriggers.
// The official ds-bot client (v0.3.6, unmodified) registers its own @ sources
// the same way: ctx.inject(['inputTriggers']) then triggers.registerSource.
// See runtime/ds-bot-upstream/ds-bot/src/client/index.js and at-menu.js.
// This does not invent a menu; it only uses that registerSource contract.

export const SOCIAL_MENTION_SOURCE = 'flybot-social'

export function mentionSource(flybotSlots) {
  return {
    trigger: '@',
    name: SOCIAL_MENTION_SOURCE,
    order: 100,
    showGroupTitle: false,
    async candidates(session, { query } = {}) {
      const needle = String(query ?? '')
      const context = { session, sessionId: session?.sessionId }
      const rows = []
      for (const entry of flybotSlots.entries('flybot.composer.mention')) {
        if (typeof entry.candidates !== 'function') continue
        const found = await entry.candidates(needle, context)
        if (Array.isArray(found)) rows.push(...found)
      }
      return rows
        .filter(row => row && row.value)
        .map(row => ({
          name: row.name,
          ...(row.description ? { description: row.description } : {}),
          section: row.section ?? 'Bots',
          value: row.value,
          ...(row.icon ? { icon: row.icon } : {}),
        }))
    },
    onPick: ({ candidate } = {}) => (candidate?.value ? { text: candidate.value } : undefined),
  }
}

export function attachMentionTriggers(triggers, flybotSlots) {
  if (!triggers || typeof triggers.registerSource !== 'function' || !flybotSlots) return () => {}
  const pending = []
  const sync = () => {
    while (pending.length) {
      try { pending.pop()() } catch { /* trigger host already dropped the source */ }
    }
    const off = triggers.registerSource(mentionSource(flybotSlots))
    if (typeof off === 'function') pending.push(off)
  }
  sync()
  const unsub = flybotSlots.subscribe?.('flybot.composer.mention', sync)
  return () => {
    if (typeof unsub === 'function') unsub()
    while (pending.length) {
      try { pending.pop()() } catch { /* disposer from a host that already dropped the source */ }
    }
  }
}

// Optional: when a plugin context can inject inputTriggers (cordis / dsh),
// attach and re-attach if the service appears later. Missing service is a no-op.
export function watchMentionTriggers(ctx, flybotSlots) {
  if (ctx && typeof ctx.inject === 'function') {
    const fiber = ctx.inject(['inputTriggers'], (scope) => {
      const run = () => attachMentionTriggers(scope.inputTriggers, flybotSlots)
      if (typeof scope.effect === 'function') return scope.effect(run, 'flybot-social: @ menu')
      return run()
    })
    return () => fiber?.dispose?.()
  }
  if (ctx?.inputTriggers) return attachMentionTriggers(ctx.inputTriggers, flybotSlots)
  return () => {}
}
