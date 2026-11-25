// Map FlyBot slot names onto dsh-web-app slots that exist without loading the
// official ds-bot client bundle (that bundle is not a profile plugin here,
// because createRuntime already runs once through the wrapper).
//
// Composer @ rows are wired separately through DSH inputTriggers.registerSource
// (see mentions.js). flybot.bot.details is rendered by the FlyBot-branded
// surface in details.js, not by inventing a hook in the official drawer.
// A missing or rejecting dsh slot is ignored, the way social already treats
// an older host.

export const BRIDGE = {
  'flybot.settings.page': 'settings.section',
  'flybot.session.dock': 'conversation.composer.dock',
  'flybot.approvals': 'conversation.composer.dock',
  'flybot.sidebar.section': 'sidebar.footer.action',
  'flybot.new-chat.action': 'sidebar.footer.action',
  'flybot.account.header': 'sidebar.footer.action',
  'flybot.room.overview': 'conversation.session.header',
  'flybot.room.members': 'conversation.session.header',
}

export function attachBridge(dshSlots, flybotSlots) {
  if (!dshSlots || typeof dshSlots.register !== 'function') return () => {}
  const fly = flybotSlots
  const offs = []
  const installed = new Map()

  const clear = (flyName) => {
    for (const off of installed.get(flyName) ?? []) {
      try { off() } catch { /* disposer from a host that already dropped the slot */ }
    }
    installed.delete(flyName)
  }

  const sync = (flyName, dshName) => {
    clear(flyName)
    const disposers = []
    for (const entry of fly.entries(flyName)) {
      if (typeof entry.component !== 'function') continue
      try {
        const off = dshSlots.register({
          name: dshName,
          id: entry.id,
          order: entry.order,
          priority: entry.order,
          label: entry.label,
          icon: entry.icon,
        }, entry.component)
        if (typeof off === 'function') disposers.push(off)
      } catch {
        // dsh web does not declare this slot in this profile; keep the FlyBot entry.
      }
    }
    installed.set(flyName, disposers)
  }

  for (const [flyName, dshName] of Object.entries(BRIDGE)) {
    sync(flyName, dshName)
    offs.push(fly.subscribe(flyName, () => sync(flyName, dshName)))
  }
  return () => {
    for (const off of offs) off()
    for (const flyName of [...installed.keys()]) clear(flyName)
  }
}
