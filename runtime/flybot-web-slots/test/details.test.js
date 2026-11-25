import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { attachBotDetails, detailsTrigger, renderDetails, BRAND, SURFACE_REGIONS, TRIGGER_ID } from '../src/details.js'
import { apply as applySlots } from '../client.js'
import { installFlybotHost, uninstallFlybotHost } from '../src/host.js'

function fakeDsh() {
  const regions = new Map()
  return {
    regions,
    register(options, component) {
      const item = { ...options, component }
      const list = regions.get(options.name) ?? []
      list.push(item)
      regions.set(options.name, list)
      return () => {
        const current = regions.get(options.name) ?? []
        const at = current.indexOf(item)
        if (at !== -1) current.splice(at, 1)
      }
    },
    mount(name, props = {}) {
      return (regions.get(name) ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        name: item.name,
        view: typeof item.component === 'function' ? item.component(props) : item.component,
        open: typeof item.component?.open === 'function' ? item.component.open(props) : undefined,
      }))
    },
  }
}

function loadSocial(hostCall) {
  uninstallFlybotHost(globalThis.__flybot__)
  const host = installFlybotHost({
    replace: true,
    call: async (endpoint, body) => hostCall?.(endpoint, body) ?? (endpoint === 'social/status' ? { home: '', approvals: [] } : {}),
  })
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'F',
    useEffect: () => {},
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useRef: (value) => ({ current: value }),
  }
  const modules = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory((name) => (name === 'react' ? react : {}))) } }
  new Function('window', readFileSync(new URL('../../flybot/plugins/social/client.js', import.meta.url), 'utf8'))(window)
  const social = modules.get('@flybot/social')
  const dispose = social.apply({})
  return { host, social, dispose, react }
}

function findFlybotMark(node, mark) {
  if (!node || typeof node !== 'object') return false
  if (node['data-flybot'] === mark || node.props?.['data-flybot'] === mark) return true
  if (Array.isArray(node.entries) && node.entries.some((entry) => findFlybotMark(entry.content, mark))) return true
  const children = node.children ?? node.props?.children
  if (Array.isArray(children)) return children.some((child) => findFlybotMark(child, mark))
  if (children && typeof children === 'object') return findFlybotMark(children, mark)
  return false
}

test('FlyBot details trigger is reachable on genuine header, dock, and settings slots', () => {
  const dsh = fakeDsh()
  const host = installFlybotHost({ replace: true, call: async () => ({}) })
  const detach = attachBotDetails(dsh, host.slots)
  for (const name of Object.values(SURFACE_REGIONS)) {
    const mounted = dsh.mount(name)
    assert.equal(mounted.length, 1, name)
    assert.equal(mounted[0].id, TRIGGER_ID)
    assert.equal(mounted[0].label, 'FlyBot details')
    assert.equal(mounted[0].view?.props?.['data-flybot-brand'], BRAND)
    const panel = mounted[0].open
    assert.equal(panel.brand, BRAND)
    assert.equal(panel['data-flybot'], 'bot-details-panel')
    assert.equal(panel.empty, true)
  }
  assert.equal(dsh.mount('conversation.session.header')[0].view.props['data-flybot-region'], 'header')
  assert.equal(dsh.mount('conversation.composer.dock')[0].view.props['data-flybot-region'], 'dock')
  assert.equal(dsh.mount('settings.section')[0].view.props['data-flybot-region'], 'settings')
  detach()
  assert.equal(dsh.mount('conversation.session.header').length, 0)
  uninstallFlybotHost(host)
})

test('opening the surface renders real BotSocialDetails from flybot.bot.details', () => {
  const { host, dispose } = loadSocial()
  assert.ok(host.slots.entries('flybot.bot.details').some((entry) => entry.id === 'social-invite'))
  const dsh = fakeDsh()
  const detach = attachBotDetails(dsh, host.slots)
  const bot = { id: 'bot-local', handle: 'local' }
  const mounted = dsh.mount('conversation.session.header', { bot, actions: {}, roster: {} })
  const panel = mounted[0].open
  assert.equal(panel.brand, BRAND)
  assert.equal(panel.empty, false)
  assert.ok(panel.entries.some((entry) => entry.id === 'social-invite'))
  assert.ok(
    findFlybotMark(panel, 'bot-social-details'),
    'expected BotSocialDetails mark in the opened FlyBot panel',
  )
  // Dock remains available when a host hides the session header on a blank chat.
  const dock = dsh.mount('conversation.composer.dock', { bot })[0].open
  assert.ok(findFlybotMark(dock, 'bot-social-details'))
  const settings = dsh.mount('settings.section', { bot })[0]
  assert.ok(findFlybotMark(settings.open, 'bot-social-details'))
  detach()
  dispose()
  uninstallFlybotHost(host)
})

test('apply() on a dsh ctx with slots installs the FlyBot details surface', () => {
  uninstallFlybotHost(globalThis.__flybot__)
  const dsh = fakeDsh()
  const off = applySlots({ slots: dsh })
  const header = dsh.mount('conversation.session.header')
  assert.equal(header[0].id, TRIGGER_ID)
  assert.equal(header[0].view.props['aria-label'], 'FlyBot details')
  off()
  assert.equal(dsh.mount('conversation.session.header').length, 0)
  uninstallFlybotHost(globalThis.__flybot__)
})

test('detailsProps prefer an explicit bot over session.bot', () => {
  const host = installFlybotHost({ replace: true, call: async () => ({}) })
  host.slots.register('flybot.bot.details', {
    id: 'probe',
    order: 1,
    component: ({ bot }) => ({ 'data-flybot': 'bot-social-details', botId: bot?.id }),
  })
  const panel = detailsTrigger(host.slots).open({ session: { bot: { id: 'from-session' } }, bot: { id: 'explicit' } })
  assert.equal(panel.entries[0].content.botId, 'explicit')
  const inherited = renderDetails(host.slots, { session: { bot: { id: 'from-session' } } })
  assert.equal(inherited.entries[0].content.botId, 'from-session')
  uninstallFlybotHost(host)
})
