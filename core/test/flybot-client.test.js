import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClientApi, createRegistry, mentionCandidates, newChatActionRows, registry, SLOTS } from '../src/client/flybot-registry.js'

test('the client registry orders entries, replaces by id, and notifies', () => {
  const slots = createRegistry()
  let ticks = 0
  slots.subscribe(() => { ticks += 1 })
  const offB = slots.register('flybot.sidebar.section', { id: 'b', order: 20 })
  slots.register('flybot.sidebar.section', { id: 'a', order: 10 })
  slots.register('flybot.sidebar.section', { id: 'b', order: 5 })
  assert.deepEqual(slots.entries('flybot.sidebar.section').map(e => e.id), ['b', 'a'])
  offB()
  assert.equal(ticks, 4)
  // The replaced entry stays: disposing the old one does not remove its successor.
  assert.deepEqual(slots.entries('flybot.sidebar.section').map(e => e.id), ['b', 'a'])
  assert.throws(() => slots.register('nope', { id: 'x' }), /unknown slot/)
  assert.deepEqual(SLOTS, ['flybot.sidebar.section', 'flybot.sidebar.structure', 'flybot.composer.mention', 'flybot.bot.details', 'flybot.approvals', 'flybot.room.overview', 'flybot.session.dock', 'flybot.new-chat.action', 'flybot.account.header', 'flybot.settings.page'])
})

test('new-chat action rows sit next to Create group chat and skip a failing plugin', () => {
  const slots = registry()
  const original = console.error
  console.error = () => {}
  const offs = [
    slots.register('flybot.new-chat.action', {
      id: 'social-face-group', order: 15, label: 'Face-to-face group', hint: 'Meet next to you',
      run: () => {},
    }),
    slots.register('flybot.new-chat.action', { id: 'broken', order: 1, label: 'x', visible: () => { throw new Error('x') } }),
  ]
  try {
    const rows = newChatActionRows({ mode: 'new' })
    assert.deepEqual(rows.map(row => row.key), ['social-face-group'])
    assert.equal(rows[0].label, 'Face-to-face group')
    assert.equal(rows[0].hint, 'Meet next to you')
  } finally {
    console.error = original
    for (const off of offs) off()
  }
})

test('mention candidates come from every plugin and one failing source is skipped', async () => {
  const slots = registry()
  const offs = [
    slots.register('flybot.composer.mention', { id: 'social', candidates: q => [{ name: `@bob.bot ${q}`, value: '@bob.bot ' }] }),
    slots.register('flybot.composer.mention', { id: 'broken', candidates: () => { throw new Error('x') } }),
  ]
  const original = console.error
  console.error = () => {}
  try {
    const rows = await mentionCandidates('b', { sessionId: 's' })
    assert.deepEqual(rows, [{ name: '@bob.bot b', value: '@bob.bot ', source: 'social' }])
  } finally {
    console.error = original
    for (const off of offs) off()
  }
})

test('the browser flybot service lists Bots and turns host changes into field events', async () => {
  const log = [{ seq: 1, botId: 'a', plugin: 'tree', key: 'parent', value: null }]
  const calls = []
  const host = async (endpoint, payload) => {
    calls.push([endpoint, payload])
    if (endpoint === 'bots') return [{ id: 'a', name: 'Chief', fields: {} }]
    return { seq: log.at(-1).seq, changes: log.filter(c => c.seq > payload.since) }
  }
  let tick
  const api = createClientApi({ call: host, every: fn => { tick = fn; return 1 }, clear: () => { tick = undefined } })
  assert.deepEqual((await api.bots()).map(b => b.id), ['a'])
  const seen = []
  const off = api.fields.on('change', c => seen.push(c))
  await api.poll()
  assert.deepEqual(seen, [])
  log.push({ seq: 2, botId: 'b', plugin: 'tree', key: 'parent', value: 'a' })
  await tick()
  assert.deepEqual(seen, [{ botId: 'b', plugin: 'tree', key: 'parent', value: 'a' }])
  off()
  assert.equal(tick, undefined)
  assert.throws(() => api.fields.on('nope', () => {}), /unknown event/)
})

test('remote members: @ rows insert the handle, the sidebar groups by home, bubbles show the fenced words', async () => {
  const { remoteMentionRows, remoteMembersByHome, remoteMessageText } = await import('../src/client/flybot-registry.js')
  const { mentionRows } = await import('../src/client/at-menu.js')
  const roster = {
    ready: true, bots: [{ id: 'a', name: 'Chief' }, { id: 'b', name: 'Writer' }], byId: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } }, roomsById: {}, rooms: [],
    remoteBots: [{ handle: '@coder.bob.home', name: 'Coder', home: '@bob.home', homeName: 'Bob', remote: true }, { handle: '@x.eve.home', name: 'X', home: '@eve.home', remote: true }],
  }
  assert.deepEqual(remoteMentionRows(roster, 'cod').map(row => row.text), ['@coder.bob.home '])
  assert.deepEqual(mentionRows(roster, 'a', 'coder').map(row => row.text), ['@coder.bob.home '])
  assert.deepEqual(remoteMembersByHome(roster).map(home => [home.home, home.name, home.bots.length]), [['@bob.home', 'Bob', 1], ['@eve.home', '@eve.home', 1]])
  assert.equal(remoteMessageText('<untrusted-message from="Coder">\nLGTM\n</untrusted-message>'), 'LGTM')
  const { failureLabel } = await import('../src/client/diagnostics.js')
  assert.equal(failureLabel('AUTH'), 'The API key was rejected')
  assert.equal(failureLabel('PROVIDER', 'llm-deepseek: no API key'), 'This Bot has no model set up yet.')
  assert.equal(failureLabel('BOOM', 'upstream exploded'), 'This Bot could not answer right now.')
  assert.equal(remoteMembersByHome({}).length, 0)
})

test('every client bundle registers under its package name, as the DSH module loader looks it up', async () => {
  const { readFileSync } = await import('node:fs')
  for (const dir of ['.']) { // @flybot/social and @flybot/tree check their own (plugins/*, #34)
    const pkg = JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8'))
    const client = readFileSync(new URL(`../${dir}/client.js`, import.meta.url), 'utf8')
    const id = client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1]
    assert.equal(id, pkg.name, `${dir}/client.js id`)
    if (dir !== '.') {
      assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', `${dir} mounts itself as a bundle`)
      assert.match(readFileSync(new URL(`../${dir}/cordis.patch.yml`, import.meta.url), 'utf8'), new RegExp(`name: '${pkg.name}'`))
    }
  }
})

test('field events keep flowing after a host restart (#18)', async () => {
  let epoch = 'e1'
  let log = []
  const host = async (endpoint, body) => {
    assert.equal(endpoint, 'changes')
    const since = body.epoch === epoch ? body.since : 0
    return { epoch, seq: log.length, changes: log.map((c, i) => ({ seq: i + 1, ...c })).filter(c => c.seq > since) }
  }
  let tick
  const api = createClientApi({ call: host, every: fn => { tick = fn; return 1 }, clear: () => {} })
  const seen = []
  log = [{ key: 'a' }, { key: 'b' }, { key: 'c' }]
  api.fields.on('change', e => seen.push(e.key))
  await new Promise(resolve => setTimeout(resolve, 10))
  log.push({ key: 'd' })
  await tick()
  assert.deepEqual(seen, ['d'])
  // Restart: a new epoch, counting from 1 again.
  epoch = 'e2'
  log = [{ key: 'after' }]
  await tick()
  assert.deepEqual(seen, ['d', 'after'])
})

test('client UI (#19): every plugin slot renders inside an error boundary; approval copy is translated; the stack scrolls', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/client/flybot-slots.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n') // a Windows checkout has CRLF
  assert.match(source, /static getDerivedStateFromError\(\)/)
  assert.match(source, /function Safe\(\{ entry, props \}\) \{\n  return h\(SlotBoundary/)
  assert.doesNotMatch(source, /\}, '(Approve|Reject|Retry)'\)/)
  assert.match(source, /\.bt-flybot-approvals \{[^}]*max-height:[^}]*overflow-y: auto/)
  // One remote list: the old built-in "Remote members" section is gone.
  assert.doesNotMatch(source, /Remote members/)
})

test('the sidebar footer button opens Settings > Connectors as "Connect apps"', async () => {
  const { readFileSync } = await import('node:fs')
  const { DICTIONARY } = await import('../src/client/i18n.js')
  const source = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const body = source.slice(source.indexOf('export function ConnectApps('), source.indexOf('export function YouAvatar'))
  assert.match(body, /onClick: \(\) => actions\.openConnectors\(\)/)
  assert.match(body, /t\('Connect apps'\)/)
  assert.doesNotMatch(body, /selectPanel|Connect plugins/)
  assert.equal(DICTIONARY.zh['Connect apps'], '连接应用')
  assert.equal(Object.hasOwn(DICTIONARY.zh, 'Connect plugins'), false)
})

test('the account menu keeps a Plugins row that opens the shell plugin panel', async () => {
  const { readFileSync } = await import('node:fs')
  const { DICTIONARY } = await import('../src/client/i18n.js')
  const source = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const menu = source.slice(source.indexOf('const groups = ['), source.indexOf('return h(Fragment, null,', source.indexOf('const groups = [')))
  assert.match(menu, /\[t\('Plugins'\), PlugIcon, \(\) => actions\.selectPanel\('plugins'\)\]/)
  assert.match(menu, /\[t\('Connectors'\), ConnectorIcon, \(\) => actions\.openConnectors\(\)\]/)
  assert.equal(DICTIONARY.zh.Plugins, '插件')
})

test('a face-room sidebar row stays on one line and shows its full title on hover (#304)', async () => {
  const { readFileSync } = await import('node:fs')
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const styles = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const mark = sidebar.slice(sidebar.indexOf('function FaceMark('), sidebar.indexOf('\n}\n', sidebar.indexOf('function FaceMark(')))
  assert.match(mark, /className: 'bt-row-remote bt-row-face'/)
  const row = sidebar.slice(sidebar.indexOf('function RoomRow('), sidebar.indexOf('function AgentSessionRow('))
  assert.match(row, /'aria-current': active \? 'page' : undefined,\n(\s*\/\/[^\n]*\n)?\s*title,\n/)
  // The two-line clamp is for a friend's Bot marker only, never the face-room people mark.
  const clamp = styles.split('\n').filter(line => line.includes('-webkit-line-clamp:2') && line.includes('.bt-row-remote'))
  assert.ok(clamp.length > 0)
  for (const line of clamp) assert.doesNotMatch(line, /:has\(\.bt-row-remote\)/)
  assert.match(styles, /\.bt-row:has\(\.bt-row-remote:not\(\.bt-row-face\)\) \.bt-row-title/)
  assert.match(styles, /\.bt-row-title\{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/)
})
