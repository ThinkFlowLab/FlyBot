import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { attachBridge, BRIDGE } from '../src/bridge.js'
import { installFlybotHost, uninstallFlybotHost } from '../src/host.js'

test('bridges component slots onto dsh names and ignores a rejecting host slot', () => {
  const dsh = new Map()
  const rejected = []
  const fake = {
    register(options, component) {
      if (options.name === 'sidebar.footer.action') {
        rejected.push(options.id)
        throw new Error('unknown slot')
      }
      const item = { ...options, component }
      const list = dsh.get(options.name) ?? []
      list.push(item)
      dsh.set(options.name, list)
      return () => {
        const current = dsh.get(options.name) ?? []
        const at = current.indexOf(item)
        if (at !== -1) current.splice(at, 1)
      }
    },
  }
  const host = installFlybotHost({ replace: true, call: async () => ({}) })
  const Page = () => 'page'
  const Dock = () => 'dock'
  const Section = () => 'section'
  const detach = attachBridge(fake, host.slots)
  host.slots.register('flybot.settings.page', { id: 'social', order: 100, label: 'Bot Social', component: Page })
  host.slots.register('flybot.session.dock', { id: 'social-approval', order: 50, component: Dock })
  host.slots.register('flybot.sidebar.section', { id: 'social', order: 100, component: Section })
  host.slots.register('flybot.new-chat.action', { id: 'social-add-friend', order: 17, label: 'Add friend', run: () => {} })
  const sections = dsh.get('settings.section') ?? []
  assert.equal(sections.length, 1)
  assert.equal(sections[0].label, 'Bot Social')
  assert.equal(sections[0].component, Page)
  assert.equal((dsh.get('conversation.composer.dock') ?? []).length, 1)
  assert.deepEqual(rejected, ['social'])
  // Actions without a component are not forced into the dsh tree.
  assert.equal((dsh.get('sidebar.footer.action') ?? []).length, 0)
  detach()
  assert.equal((dsh.get('settings.section') ?? []).length, 0)
  uninstallFlybotHost(host)
  assert.ok(BRIDGE['flybot.settings.page'])
})

test('social client apply registers FlyBot slots once the host exists', async () => {
  uninstallFlybotHost(globalThis.__flybot__)
  const host = installFlybotHost({ replace: true, call: async (endpoint) => {
    if (endpoint === 'social/status') return { home: '', approvals: [] }
    return {}
  } })
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
  assert.ok(social?.apply)
  const dispose = social.apply({})
  assert.ok(host.slots.entries('flybot.settings.page').some((e) => e.id === 'social'))
  assert.ok(host.slots.entries('flybot.session.dock').some((e) => e.id === 'social-approval'))
  assert.ok(host.slots.entries('flybot.sidebar.section').some((e) => e.id === 'social'))
  assert.equal(typeof host.social.canInvite, 'function')
  dispose()
  assert.equal(host.slots.entries('flybot.settings.page').length, 0)
  assert.equal(host.social, undefined)
  uninstallFlybotHost(host)
})
