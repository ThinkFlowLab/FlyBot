// FlyBot-branded bot details surface on genuine dsh-web-app slots.
// The official ds-bot v0.3.6 details drawer has no flybot.bot.details hook;
// this adapter does not invent one and does not edit vendored ds-bot.
// It renders flybot.bot.details entries (Bot Social registers BotSocialDetails)
// from conversation.session.header, conversation.composer.dock, and
// settings.section — already-bridged host regions, including when the session
// header is hidden on a blank conversation.

export const DETAILS_SLOT = 'flybot.bot.details'
export const BRAND = 'FlyBot'
export const TRIGGER_ID = 'flybot-bot-details'
export const SURFACE_REGIONS = Object.freeze({
  header: 'conversation.session.header',
  dock: 'conversation.composer.dock',
  settings: 'settings.section',
})

export function detailsProps(slotProps = {}) {
  return {
    bot: slotProps.bot ?? slotProps.session?.bot ?? null,
    actions: slotProps.actions ?? null,
    roster: slotProps.roster ?? null,
  }
}

export function detailsEntries(flybotSlots) {
  if (!flybotSlots || typeof flybotSlots.entries !== 'function') return []
  return flybotSlots.entries(DETAILS_SLOT).filter((entry) => typeof entry.component === 'function')
}


export function realize(node, depth = 0) {
  if (depth > 8 || node == null || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    try {
      return realize(node.type({ ...(node.props || {}), children: node.children }), depth + 1)
    } catch {
      return node
    }
  }
  if (Array.isArray(node.children)) {
    return { ...node, children: node.children.map((child) => realize(child, depth + 1)) }
  }
  if (Array.isArray(node)) return node.map((child) => realize(child, depth + 1))
  return node
}

export function renderDetails(flybotSlots, slotProps = {}) {
  const props = detailsProps(slotProps)
  return {
    brand: BRAND,
    title: 'FlyBot details',
    'data-flybot': 'bot-details-panel',
    empty: detailsEntries(flybotSlots).length === 0,
    entries: detailsEntries(flybotSlots).map((entry) => ({
      id: entry.id,
      order: entry.order,
      content: realize(entry.component(props)),
    })),
  }
}

function vnode(type, props, ...children) {
  const lib = globalThis.React ?? globalThis.preact
  if (lib && typeof lib.createElement === 'function') {
    return lib.createElement(type, props, ...children)
  }
  return { type, props: props ?? {}, children }
}

export function detailsTrigger(flybotSlots, { region } = {}) {
  const FlyBotDetailsTrigger = (slotProps = {}) => {
    const panel = () => renderDetails(flybotSlots, slotProps)
    return vnode('button', {
      type: 'button',
      'data-flybot': 'bot-details-trigger',
      'data-flybot-brand': BRAND,
      'data-flybot-region': region ?? '',
      'aria-label': 'FlyBot details',
      brand: BRAND,
      label: 'FlyBot details',
      open: panel,
    }, 'FlyBot details')
  }
  FlyBotDetailsTrigger.displayName = 'FlyBotDetailsTrigger'
  FlyBotDetailsTrigger.open = (slotProps) => renderDetails(flybotSlots, slotProps)
  return FlyBotDetailsTrigger
}

export function detailsSettingsPage(flybotSlots) {
  const FlyBotDetailsPage = (slotProps = {}) => {
    const panel = renderDetails(flybotSlots, slotProps)
    return vnode('section', {
      'data-flybot': 'bot-details-panel',
      'data-flybot-brand': BRAND,
      'data-flybot-region': 'settings',
      brand: BRAND,
      title: panel.title,
      panel,
    }, panel.title)
  }
  FlyBotDetailsPage.displayName = 'FlyBotDetailsPage'
  FlyBotDetailsPage.open = (slotProps) => renderDetails(flybotSlots, slotProps)
  return FlyBotDetailsPage
}

export function attachBotDetails(dshSlots, flybotSlots) {
  if (!dshSlots || typeof dshSlots.register !== 'function' || !flybotSlots) return () => {}
  const disposers = []

  const register = (region, name, component, extra = {}) => {
    try {
      const off = dshSlots.register({
        name,
        id: TRIGGER_ID,
        order: 40,
        priority: 40,
        label: 'FlyBot details',
        ...extra,
      }, component)
      if (typeof off === 'function') disposers.push(off)
    } catch {
      // dsh web does not declare this slot in this profile; keep FlyBot details in the registry.
    }
  }

  register('header', SURFACE_REGIONS.header, detailsTrigger(flybotSlots, { region: 'header' }))
  register('dock', SURFACE_REGIONS.dock, detailsTrigger(flybotSlots, { region: 'dock' }))
  register('settings', SURFACE_REGIONS.settings, detailsSettingsPage(flybotSlots), { label: 'FlyBot details' })

  return () => {
    for (const off of disposers) {
      try { off() } catch { /* host already dropped the slot */ }
    }
    disposers.length = 0
  }
}
