import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createClientApi, createRegistry, mentionCandidates, newChatActionRows, registry, SLOTS } from '../src/client/flybot-registry.js'

// A client module that imports React cannot be loaded as plain ESM here (the platform packages come
// from a DSH install, not from this checkout), so bundle it the way the other client tests do
// (test/face-person-first.test.js) and hand it a small stand-in for the platform modules.
async function loadClientModule(entry) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(`../src/client/${entry}`, import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  })
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: (name) => {
      const platform = {
        react: {
          Component: class {}, createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
          useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: current => ({ current }),
          useLayoutEffect: () => {}, useMemo: make => make(), useCallback: fn => fn, useSyncExternalStore: (sub, get) => get(), Fragment: 'fragment',
        },
        'react-dom': { createPortal: node => node },
        '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: function MarkdownText() { return null }, projectUserText: text => text },
      }
      if (!(name in platform)) throw new Error(`no platform module ${name}`)
      return platform[name]
    },
  })
  return module.exports
}

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
  assert.deepEqual(SLOTS, ['flybot.sidebar.section', 'flybot.sidebar.structure', 'flybot.composer.mention', 'flybot.bot.details', 'flybot.approvals', 'flybot.room.overview', 'flybot.room.members', 'flybot.session.dock', 'flybot.new-chat.action', 'flybot.account.header', 'flybot.settings.page'])
})

test('new-chat action rows sit after New group chat and skip a failing plugin', () => {
  const slots = registry()
  const original = console.error
  console.error = () => {}
  const offs = [
    slots.register('flybot.new-chat.action', {
      id: 'social-face-group', order: 15, label: 'Face-to-face room', hint: 'Meet next to you',
      icon: () => null, run: () => {},
    }),
    slots.register('flybot.new-chat.action', { id: 'broken', order: 1, label: 'x', visible: () => { throw new Error('x') } }),
  ]
  try {
    const rows = newChatActionRows({ mode: 'new' })
    assert.deepEqual(rows.map(row => row.key), ['social-face-group'])
    assert.equal(rows[0].label, 'Face-to-face room')
    assert.equal(typeof rows[0].icon, 'function')
    const memo = { $$typeof: Symbol.for('react.memo'), type: () => null }
    const off = slots.register('flybot.new-chat.action', { id: 'memo-icon', order: 20, label: 'Memo', icon: memo, run: () => {} })
    try {
      assert.equal(newChatActionRows({ mode: 'new' }).find(row => row.key === 'memo-icon').icon, memo, 'a memo / forwardRef component is kept')
    } finally { off() }
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

test('remote members: @ rows insert the one name, the sidebar groups by home, bubbles show the fenced words', async () => {
  const { remoteMentionRows, remoteMembersByHome, remoteMessageText } = await import('../src/client/flybot-registry.js')
  const { mentionRows } = await import('../src/client/at-menu.js')
  const roster = {
    ready: true, bots: [{ id: 'a', name: 'Chief' }, { id: 'b', name: 'Writer' }], byId: { a: { id: 'a', name: 'Chief' }, b: { id: 'b', name: 'Writer' } }, roomsById: {}, rooms: [],
    remoteBots: [{ handle: '@coder.bob.home', name: 'Coder', home: '@bob.home', homeName: 'Bob', remote: true }, { handle: '@x.eve.home', name: 'X', home: '@eve.home', remote: true }],
  }
  // #967: the menu inserts the name people read ("Coder (Bob)"), not the handle it routes on.
  assert.deepEqual(remoteMentionRows(roster, 'cod').map(row => row.text), ['@Coder (Bob) '])
  assert.deepEqual(mentionRows(roster, 'a', 'coder').map(row => row.text), ['@Coder (Bob) '])
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
  assert.match(menu, /\[t\('Connect apps'\), ConnectorIcon, \(\) => actions\.openConnectors\(\)\]/)
  assert.equal(DICTIONARY.zh.Plugins, '插件')
})

test('the account menu names each destination as it is named elsewhere (#392, #393, #394)', async () => {
  const { readFileSync } = await import('node:fs')
  const { DICTIONARY } = await import('../src/client/i18n.js')
  const source = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const settings = readFileSync(new URL('../src/client/settings.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const menu = source.slice(source.indexOf('const groups = ['), source.indexOf('return h(Fragment, null,', source.indexOf('const groups = [')))
  const labels = [...menu.matchAll(/\[t\('([^']+)'\)/g)].map(match => match[1])
  assert.deepEqual(labels, ['Usage', 'Connect apps', 'Plugins', 'Scheduled tasks', 'Settings', 'Switch to classic Agent mode'])
  // Connectors: the footer button's words, not the second name "Connectors".
  assert.doesNotMatch(menu, /t\('Connectors'\)/)
  // Scheduled tasks: the Settings page and a Bot's details use that name, and the row opens that page.
  assert.match(menu, /\[t\('Scheduled tasks'\), ClockIcon, \(\) => actions\.openSettings\('schedules'\)\]/)
  assert.doesNotMatch(menu, /Automation tasks|selectPanel\('schedules'\)/)
  assert.match(settings, /\['schedules', 'Scheduled tasks'\]/)
  // Classic Agent mode: one way in, the account menu; Settings → General is Appearance only.
  const general = settings.slice(settings.indexOf('function GeneralPage('), settings.indexOf('function MainBotsSection('))
  assert.doesNotMatch(general, /setSurface|Classic Agent mode/)
  assert.equal(DICTIONARY.zh.Settings, '设置')
  assert.equal(DICTIONARY.zh['Scheduled tasks'], '定时任务')
  for (const gone of ['Automation tasks', 'Classic Agent mode', 'Switch', 'Mode']) assert.equal(Object.hasOwn(DICTIONARY.zh, gone), false, gone)
})

test('a face-room sidebar row stays on one line and shows its full title on hover (#304)', async () => {
  const { readFileSync } = await import('node:fs')
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const styles = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const mark = sidebar.slice(sidebar.indexOf('function FaceMark('), sidebar.indexOf('\n}\n', sidebar.indexOf('function FaceMark(')))
  assert.match(mark, /className: 'bt-row-remote bt-row-face'/)
  const row = sidebar.slice(sidebar.indexOf('function RoomRow('), sidebar.indexOf('function AgentSessionRow('))
  // #892: the hover is the title, plus who shared it for a shared room.
  assert.match(row, /'aria-current': active \? 'page' : undefined,\n(\s*\/\/[^\n]*\n)?\s*title: hover,\n/)
  // No sidebar row wraps its title (#384 dropped the friend's Bot two-line clamp too).
  assert.equal(styles.split('\n').some(line => line.includes('-webkit-line-clamp:2') && line.includes('.bt-row-')), false)
  assert.match(styles, /\.bt-row-title\{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/)
})

test("a friend's Bot sidebar row is its one name, \"Chief (Bob)\", on one line, with a second line like own rows (#384, #498)", async () => {
  const { readFileSync } = await import('node:fs')
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const styles = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const row = sidebar.slice(sidebar.indexOf('function BotRow('), sidebar.indexOf('function RemoteMark('))
  // The same string as the header, tab, composer placeholder and @ menu: one formatter (#498).
  assert.match(row, /const shown = remote \? friendBotTitle\(bot\) : bot\.name/)
  assert.match(row, /h\('span', \{ className: 'bt-row-title' \}, shown\)/)
  // No second, muted owner part ("Chief" + grey "Bob" read as a different format).
  assert.doesNotMatch(row, /bt-row-owner/)
  assert.doesNotMatch(styles, /\.bt-row-owner\{/)
  // Before the first message the second line still says what the row is.
  // #956: the placeholder names the state once the Bot is gone, so a kept row says why it is there.
  assert.match(row, /const secondLine = awayLine \|\| preview \|\| \(remote \? \(bot\.remote\?\.gone \? t\(.no longer shared.\) : t\("Friend's Bot"\)\) : ''\)/)
  // The full name is on hover and in the label.
  assert.match(row, /title: remote \? shown :/)
  // flybot-slots.js publishes the same formatter to plugins (__flybot__.names), so a plugin row
  // inserts the name the bubble chips (#967).
  for (const file of ['header.js', 'brand.js', 'user-message.js', 'at-menu.js', 'flybot-slots.js']) {
    const src = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    // #967: a mention reads the same label through remoteMentionLabel, which itself reads
    // friendBotTitle, so the menu, the bubble and the preview cannot drift apart.
    assert.match(src, /\bfriendBotTitle\b|\bremoteMentionLabel\b/, `${file} names a friend's Bot through the one formatter`)
    assert.doesNotMatch(src, /ownerName: bot\.remote\.homeName \|\| bot\.remote\.owner/, `${file} builds no name of its own`)
  }
  assert.match(styles, /\.bt-row-remote\{[^}]*color:var\(--bt-ink-2\)\}/)
  const { DICTIONARY } = await import('../src/client/i18n.js')
  assert.equal(DICTIONARY.zh["Friend's Bot"], '好友的 Bot')
})

test("a friend's Bot picked from the @ menu reads as its one name in the menu, the bubble and the preview (#967)", async () => {
  const { remoteMentionRows } = await import('../src/client/flybot-registry.js')
  const { mentionableBots, userTextParts } = await loadClientModule('user-message.js')
  const { nameMentions } = await import('../src/client/text.js')
  const { atSources } = await import('../src/client/at-menu.js')
  // The reported shape: the friend's Bot is on the roster, and no chat of its own exists yet, so
  // the bubble used to know no name for it and DSH drew "@coder.bob.home" as a file (bare handle).
  const roster = {
    ready: true, bots: [{ id: 'a', name: 'Chief' }], byId: { a: { id: 'a', name: 'Chief' } }, roomsById: {}, rooms: [],
    remoteBots: [{ handle: '@coder.bob.home', name: 'Coder', home: '@bob.home', homeName: 'Bob', remote: true }],
  }
  assert.deepEqual(remoteMentionRows(roster, 'cod').map(row => row.text), ['@Coder (Bob) '])
  const bots = mentionableBots(roster, 'a')
  const parts = userTextParts('@Coder (Bob) hello', bots)
  assert.equal(parts.length, 2)
  assert.equal(parts[0].bot.mentionLabel, 'Coder (Bob)')
  assert.equal(`@${parts[0].bot.mentionLabel}`, '@Coder (Bob)')
  assert.equal(parts[1].text, ' hello')
  // The line the menu used to insert still chips as the same Bot, one mention, not raw text.
  const legacy = userTextParts('@coder.bob.home hello', bots)
  assert.equal(legacy.length, 2)
  assert.equal(legacy[0].bot.mentionLabel, 'Coder (Bob)')
  assert.equal(legacy[1].text, ' hello')
  // One vocabulary: the sidebar preview renders the same words for both forms.
  assert.equal(nameMentions('@Coder (Bob) hello', roster), '@Coder (Bob) hello')
  assert.equal(nameMentions('@coder.bob.home hello', roster), '@Coder (Bob) hello')
  // The menu row shows what it inserts, so picking it is never a surprise.
  const source = (await atSources({
    roster: { getSnapshot: () => roster },
    sessions: { list: { getSnapshot: () => ({ byId: {}, ids: [] }) } },
    launched: () => false,
    iconFor: () => 'bot',
  }))[0]
  const row = (await source.candidates({ sessionId: 'a' }, { query: 'cod' }))[0]
  assert.equal(row.name, 'Coder (Bob)')
  assert.equal(row.value, '@Coder (Bob) ')
  assert.equal(row.description, '@coder.bob.home')
  // Two friends may publish a Bot with the same name: the label keeps them apart, and each still
  // names its own handle at the transport.
  const clash = {
    ...roster,
    remoteBots: [
      { handle: '@chief.bob.home', name: 'Chief', home: '@bob.home', homeName: 'Bob', remote: true },
      { handle: '@chief.ann.home', name: 'Chief', home: '@ann.home', homeName: 'Ann', remote: true },
    ],
  }
  const labels = remoteMentionRows(clash, 'chief').map(row => row.text)
  assert.notEqual(labels[0], labels[1])
  const both = mentionableBots(clash, 'a')
  assert.equal(userTextParts(labels[0], both)[0].bot.handle, '@chief.bob.home')
  assert.equal(userTextParts(labels[1], both)[0].bot.handle, '@chief.ann.home')
  assert.equal(nameMentions(labels[0].trim(), clash), labels[0].trim())
  // Not a mention: a bare handle typed inside a message stays exactly as typed (the raw path is
  // not removed, and nothing is silently rewritten), and plain text is untouched.
  assert.equal(nameMentions('mail me at coder.bob.home', roster), 'mail me at coder.bob.home')
  // The bundled module builds its arrays in another realm, so compare their values, not their prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(userTextParts('plain words', bots).map(part => part.text))), ['plain words'])
})
