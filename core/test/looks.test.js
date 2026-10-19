import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DEFAULT_COLORS, DEFAULT_SHAPES, MAIN_LOOK, defaultColor, defaultShape, lookOf, lookKey, lookKeys, lookAvoidingLocals, PICKER_SHAPES } from '../src/client/characters.js'
import { indexRoster } from '../src/client/sources.js'

const ids = Array.from({ length: 3000 }, (_, index) => `session-${index.toString(16).padStart(8, '0')}-look`)

test('a Bot with no look of its own never gets the whale, gray, brown, or black', () => {
  assert.ok(!DEFAULT_SHAPES.includes('whale'))
  for (const color of ['gray', 'brown', 'black', 'aurora']) assert.ok(!DEFAULT_COLORS.includes(color), color)
  const shapes = new Set(ids.map(defaultShape))
  const colors = new Set(ids.map(defaultColor))
  assert.deepEqual([...shapes].sort(), [...DEFAULT_SHAPES].sort())
  assert.deepEqual([...colors].sort(), [...DEFAULT_COLORS].sort())
})

const roster = (bots, mainBotIds) => indexRoster({ bots, rooms: [], mainBotIds, mainBotId: mainBotIds[0] ?? null })

test('the whale is only a stored look: the browser gives no Bot a look by its place in the team', () => {
  const chief = { id: 'chief', name: 'Chief', createdAt: 1, color: 'deepseek', avatar: { shape: 'whale' } }
  const writer = { id: 'writer', name: 'Writer', createdAt: 2 }
  assert.deepEqual(lookOf(roster([writer, chief], ['chief']).byId.chief), { ...MAIN_LOOK, image: undefined })
  // The first Main Bot left, with no stored look, keeps the look its id gives it.
  const left = roster([writer], ['writer']).byId.writer
  assert.deepEqual(lookOf(left), { shape: defaultShape('writer'), color: defaultColor('writer'), image: undefined })
  const photo = lookOf({ id: 'chief', avatar: { image: 'data:image/png;base64,AA==' } })
  assert.equal(photo.image, 'data:image/png;base64,AA==')
  assert.equal(photo.shape, defaultShape('chief'))
})

test('the whole Settings dialog is Settings; one Bot opens as Edit Bot or Bot settings; nothing is called Team settings', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const sources = readdirSync(dir).filter(name => name.endsWith('.js')).map(name => [name, readFileSync(new URL(name, dir), 'utf8')])
  for (const [name, text] of [...sources, ['client.js', readFileSync(new URL('../client.js', import.meta.url), 'utf8')]]) {
    assert.ok(!text.includes('Team settings'), `${name} still names Team settings`)
  }
  const text = name => sources.find(([file]) => file === name)[1]
  // #392: the account menu and palette open the whole dialog, so they do not say Bot settings.
  assert.match(text('sidebar.js'), /\[t\('Settings'\), GearIcon, \(\) => actions\.openSettings\('general'\)\]/)
  assert.match(text('palette.js'), /title: t\('Settings'\), run: \(\) => actions\.openSettings\('general'\)/)
  assert.doesNotMatch(text('sidebar.js'), /t\('Bot settings'\), GearIcon, \(\) => actions\.openSettings\('general'\)/)
  assert.doesNotMatch(text('palette.js'), /t\('Bot settings'\)/)
  // One Bot's own entries open that Bot, so they read Edit Bot instead.
  assert.match(text('context-menu.js'), /\[t\('Edit Bot'\), GearIcon, \(\) => actions\.openSettings\('bots', bot\.id\)\]/)
  assert.match(text('context-menu.js'), /bot\?\.remote/)
  assert.match(text('context-menu.js'), /\[t\('Bot settings'\), GearIcon, \(\) => actions\.openSettings\('bots', bot\.id\)\]/)
  assert.match(text('details-drawer.js'), /bot\.remote \? t\('Bot settings'\) : t\('Edit Bot'\)/)
  assert.match(text('details-drawer.js'), /bot && bot\.remote && tab === 'details'[\s\S]*FlyBotDetails/)
  assert.match(text('bot-settings.js'), /if \(bot\.remote\) return null/)
  assert.match(text('remote-bot-settings.js'), /remote-bot-sheet/)
  // #274: the friend's Bot sheet takes focus and closes on Escape itself; its row and gear fit a tree item.
  assert.match(text('remote-bot-settings.js'), /tabIndex: -1, ref: dialog, onKeyDown/)
  assert.match(text('remote-bot-settings.js'), /event\.key === 'Escape'\) \{ event\.stopPropagation\(\); close\(\) \}/)
  assert.match(text('remote-bot-settings.js'), /focus\?\.\(\{ preventScroll: true \}\)/)
  assert.match(text('sidebar.js'), /\.bt-tree-item>\.bt-row-wrap\{flex:1 1 auto;width:auto;min-width:0\}/)
  assert.match(text('sidebar.js'), /bt-row-settings/)
  // #276: gear is on every wide Bot row (own and friends'), not only remotes.
  assert.match(text('sidebar.js'), /const settings = wide \? h\('button'/)
  assert.doesNotMatch(text('sidebar.js'), /wide && bot\.remote \? h\('button'/)
  assert.match(text('header.js'), /setAttribute\('aria-label', composerLabel\)/)
  assert.match(text('settings.js'), /filter\(bot => !bot\.remote\)/)
  // #276: only the user's own Bots are offered as a Main Bot, in both selects.
  assert.match(text('settings.js'), /const own = roster\.bots\.filter\(bot => !bot\.remote\)/)
  assert.match(text('settings.js'), /const candidates = own\.filter/)
  assert.match(text('settings.js'), /own\.map\(bot => h\('option'/)
  // A group chat's entries open its own settings the same way.
  assert.match(text('context-menu.js'), /\[t\('Group settings'\), GearIcon, \(\) => actions\.openSettings\('groups', room\.id\)\]/)
  assert.ok(!text('mark.js').includes('WhaleLogo'))
})


test('a friend\'s Bot fallback look never matches one of my own Bots exactly (#384)', () => {
  const mine = { id: 'chief', name: 'Chief', color: 'deepseek', avatar: { shape: 'whale' } }
  // Force a remote seed that would otherwise collide: same shape+color as mine via stored fields cleared.
  const friend = { id: 'remote-1', name: 'Chief', remote: { handle: '@chief.friend.home' }, color: 'deepseek', avatar: { shape: 'whale' } }
  // Stored shape is the friend's real look — leave it (sync already happened).
  assert.deepEqual(lookAvoidingLocals(friend, [mine]), lookOf(friend))
  // Seeded fallback that collides: no avatar.shape, color matches MAIN whale via explicit color + lucky seed.
  // Build a remote whose lookOf equals mine by copying shape/color through seed collision is hard;
  // instead pass a bot whose lookOf we control by setting color and relying on lookAvoidingLocals
  // only when avatar has no shape — craft locals that take the remote's seeded key.
  const seeded = { id: 'r2', name: 'Helper', remote: { handle: '@helper.other.home' } }
  const seededLook = lookOf(seeded)
  const twin = { id: 'local-twin', name: 'Twin', color: seededLook.color, avatar: { shape: seededLook.shape } }
  const avoided = lookAvoidingLocals(seeded, [twin])
  assert.notEqual(lookKey(avoided), lookKey(lookOf(twin)), 'fallback must differ from the local twin')
  assert.equal(avoided.color, seededLook.color, 'color stays; only shape steps')
  assert.notEqual(avoided.shape, 'whale', 'never steal the Main Bot whale')
  // No locals: unchanged.
  assert.deepEqual(lookAvoidingLocals(seeded, []), seededLook)
  // Image / emoji keep the published look even if a local matches.
  const pictured = { ...seeded, avatar: { image: 'https://example.test/a.png' } }
  assert.equal(lookAvoidingLocals(pictured, [twin]).image, 'https://example.test/a.png')
})

test('fallback avoidance treats a named ink and its published hex as one color, and survives a full shape set (#384)', () => {
  const seeded = { id: 'r3', name: 'Scout', remote: { handle: '@scout.other.home' } }
  const seededLook = lookOf(seeded)
  // Bot Social publishes colors as lowercase hex; my own Bot uses the named ink.
  const published = { ...seeded, color: '#2a92fe' }
  const mine = { id: 'mine-blue', name: 'Blue', color: 'blue', avatar: { shape: lookOf(published).shape } }
  const avoided = lookAvoidingLocals(published, [mine])
  assert.ok(!lookKeys(avoided).some(key => lookKeys(lookOf(mine)).includes(key)), 'blue and #2a92fe are the same drawn color')
  // My own Bots take every non-whale shape in the fallback color: the color steps too.
  const all = PICKER_SHAPES.filter(id => id !== 'whale').map((shape, index) => ({ id: `own-${index}`, name: `Own ${index}`, color: seededLook.color, avatar: { shape } }))
  const escaped = lookAvoidingLocals(seeded, all)
  const taken = new Set(all.flatMap(bot => lookKeys(lookOf(bot))))
  assert.ok(!lookKeys(escaped).some(key => taken.has(key)), 'never hands back a taken look')
  assert.notEqual(escaped.shape, 'whale')
})

test('indexing the roster registers own Bots, so every BotMark of a friend avoids them (#384)', () => {
  const seeded = { id: 'r4', name: 'Pal', remote: { handle: '@pal.other.home' } }
  const seededLook = lookOf(seeded)
  const twin = { id: 'local-twin-2', name: 'Twin', color: seededLook.color, avatar: { shape: seededLook.shape } }
  indexRoster({ bots: [twin, seeded], rooms: [] })
  assert.notEqual(lookKey(lookAvoidingLocals(seeded)), lookKey(lookOf(twin)))
  indexRoster({ bots: [], rooms: [] })
  assert.deepEqual(lookAvoidingLocals(seeded), seededLook)
  // BotMark (palette, details drawer, transcript cells) uses the registry when no look is given.
  assert.match(readFileSync(new URL('../src/client/mark.js', import.meta.url), 'utf8'), /given \?\? \(bot\?\.remote \? lookAvoidingLocals\(bot\) : lookOf\(bot\)\)/)
})
