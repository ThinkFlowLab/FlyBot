import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../index.js'
import { DEFAULT_LIMITS, resolveLimits, checkCreate } from '../src/limits.js'
import { treeSendMiddleware } from '../src/middleware.js'
import { createMockFlybot } from './mock-flybot.js'
import { reactStub, renderToString, findAll } from './render.js'

async function setup(config = {}) {
  const m = createMockFlybot()
  m.addBot({ name: 'Chief', isMain: true, systemPrompt: 'Chief own prompt' })
  const { tree } = plugin.apply({ flybot: m.flybot }, { adoptExisting: false, ...config })
  const root = await tree.ensureRoot()
  return { ...m, tree, root }
}
const f = (m, id, k) => m.bots.get(id)?.fields['flybot-tree']?.[k]
const sp = (m, id) => m.bots.get(id)?.systemPrompt
const outsider = (m, name = 'Outsider') => m.flybot.bot.create({ name })
const make = async (m, parent, name) => (await m.call(parent, 'create_child_bot', { name, role_description: `${name} stuff` })).created?.id

test('manifest follows dsh plugin conventions', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
  assert.ok(pkg.keywords.includes('dsh-plugin'))
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(plugin.name, 'flybot-tree')
  assert.deepEqual(plugin.inject, ['flybot'])
})

test('limits: defaults, config override, rules', () => {
  assert.deepEqual(DEFAULT_LIMITS, { maxDepth: 5, maxChildren: 8 })
  assert.deepEqual(resolveLimits({ maxDepth: 3 }), { maxDepth: 3, maxChildren: 8 })
  assert.deepEqual(resolveLimits({ maxDepth: -1, maxChildren: 'x' }), DEFAULT_LIMITS)
  const L = { maxDepth: 5, maxChildren: 2 }
  assert.equal(checkCreate({ parentName: 'R', parentDepth: 1, siblings: [], name: 'A', limits: L }), null)
  assert.match(checkCreate({ parentName: 'R', parentDepth: 1, siblings: [{ name: 'a ' }], name: ' A', limits: L }), /already exists/)
  assert.match(checkCreate({ parentName: 'R', parentDepth: 1, siblings: [{ name: 'x' }, { name: 'y' }], name: 'z', limits: L }), /maxChildren=2/)
  assert.match(checkCreate({ parentName: 'R', parentDepth: 5, siblings: [], name: 'z', limits: L }), /depth 6/)
  assert.match(checkCreate({ parentName: 'R', parentDepth: 1, siblings: [], name: '  ', limits: L }), /name required/)
})

test('tree starts with only a root; ensureRoot is idempotent', async () => {
  const m = await setup()
  assert.equal(m.bots.size, 1)
  assert.equal(await m.tree.ensureRoot(), m.root)
  assert.deepEqual((await m.call(m.root, 'list_children')).children, [])
})

test('tools: create under caller only, list, duplicates, depth 5, 8 children', async () => {
  const m = await setup()
  const work = await make(m, m.root, 'Work')
  const dev = await make(m, work, 'Dev')
  assert.equal(f(m, dev, 'parent'), work)
  assert.deepEqual((await m.call(m.root, 'list_children')).children.map(c => c.name), ['Work'])
  assert.match((await m.call(m.root, 'create_child_bot', { name: 'work', role_description: 'dup' })).error, /already exists/)
  const l4 = await make(m, dev, 'L4'); const l5 = await make(m, l4, 'L5')
  assert.ok(l5)
  assert.match((await m.call(l5, 'create_child_bot', { name: 'L6', role_description: 'x' })).error, /maxDepth=5/)
  for (let i = 1; i < 8; i++) assert.ok(await make(m, m.root, `C${i}`))
  assert.match((await m.call(m.root, 'create_child_bot', { name: 'C9', role_description: 'x' })).error, /maxChildren=8/)
  assert.match(sp(m, dev), /recursive bot tree/)
  assert.match(sp(m, dev), /Chief → Work → Dev/)
  assert.match(sp(m, work), /COORDINATOR[\s\S]*- Dev: Dev stuff/)
})

test('tools: configurable limits and hidden from non-tree bots', async () => {
  const m = await setup({ maxDepth: 2, maxChildren: 1 })
  const a = await make(m, m.root, 'A')
  assert.match((await m.call(m.root, 'create_child_bot', { name: 'B', role_description: 'x' })).error, /maxChildren=1/)
  assert.match((await m.call(a, 'create_child_bot', { name: 'B', role_description: 'x' })).error, /maxDepth=2/)
  const o = await outsider(m)
  await assert.rejects(m.call(o, 'list_children'), /not visible/)
})

test('#16 Option B: a non-Main tree Bot may create a child under itself; limits still bind; the child is not auto-granted', async () => {
  const m = await setup({ maxDepth: 3, maxChildren: 2 })
  assert.equal(m.flybot.bot.get(m.root).isMain, true)
  const specialist = await make(m, m.root, 'Work')
  assert.equal(m.flybot.bot.get(specialist).isMain, false)
  // A grant on the parent (or the Chief) must not follow the new child.
  m.setGrants(m.root, [{ grantee: '@alice.home' }])
  m.setGrants(specialist, [{ grantee: '@alice.home' }])
  const child = await make(m, specialist, 'Dev')
  assert.ok(child)
  assert.equal(f(m, child, 'parent'), specialist)
  assert.equal(m.flybot.bot.get(child).isMain, false)
  assert.equal(m.flybot.bot.hasAnyGrant(child), false)
  assert.deepEqual(m.flybot.grants.of(child), [])
  const toward = to => m.middlewares[0].handle({ from: { kind: 'remote', handle: '@alice.home' }, to, target: { remote: false, id: to } })
  assert.equal(toward(child)?.action, 'deny')
  assert.match(toward(child)?.reason, /has not been granted/)
  // Sharing still takes an independent grant on that Bot.
  m.setGrants(child, [{ grantee: '@alice.home' }])
  assert.equal(m.flybot.bot.hasAnyGrant(child), true)
  m.setGrants(child, [])
  assert.equal(m.flybot.bot.hasAnyGrant(child), false)
  assert.ok(await make(m, specialist, 'QA'))
  assert.match((await m.call(specialist, 'create_child_bot', { name: 'Extra', role_description: 'x' })).error, /maxChildren=2/)
  assert.match((await m.call(child, 'create_child_bot', { name: 'TooDeep', role_description: 'x' })).error, /maxDepth=3/)
  const o = await outsider(m)
  await assert.rejects(m.call(o, 'create_child_bot', { name: 'X', role_description: 'x' }), /not visible/)
})

test('fix 1: fields are written under fields["flybot-tree"] via flybot.scope, never shared', async () => {
  const m = await setup()
  assert.ok(m.scopes.includes('flybot-tree'))
  const a = await make(m, m.root, 'A')
  for (const id of [m.root, a]) {
    assert.equal(m.bots.get(id).fields.shared, undefined)
    assert.deepEqual(Object.keys(m.bots.get(id).fields), ['flybot-tree'])
  }
  assert.equal(m.flybot.fields.get(a, 'parent'), undefined) // unscoped (shared) view sees nothing
  assert.equal(m.flybot.scope('flybot-tree').fields.get(a, 'parent'), m.root)
  // a field another plugin writes with the same key does not make a bot a tree member
  const o = await outsider(m); m.flybot.scope('other').fields.set(o, 'parent', m.root)
  await assert.rejects(m.call(o, 'list_children'), /not visible/)
  assert.deepEqual((await m.call(m.root, 'list_children')).children.map(c => c.name), ['A'])
})

test('fix 1: change events: only own plugin unless { all: true }', async () => {
  const m = createMockFlybot()
  m.addBot({ name: 'Chief', isMain: true })
  const { tree } = plugin.apply({ flybot: m.flybot })
  const seen = []; tree.subscribe(c => seen.push(c.plugin + ':' + c.key))
  const root = await tree.ensureRoot()
  m.flybot.scope('other').fields.set(root, 'parent', 'zzz')
  assert.ok(seen.includes('flybot-tree:treeRole'))
  assert.ok(!seen.some(s => s.startsWith('other:')))
  const all = []; m.flybot.on('change', c => all.push(c.plugin), { all: true })
  m.flybot.scope('other').fields.set(root, 'x', 1)
  assert.deepEqual(all, ['other'])
})

test('fix 2: create_child_bot returns the resolved id (not a Promise)', async () => {
  const m = await setup()
  assert.equal(typeof m.root, 'string')
  assert.ok(m.bots.has(m.root))
  const r = await m.call(m.root, 'create_child_bot', { name: 'A', role_description: 'a' })
  assert.equal(typeof r.created.id, 'string')
  assert.ok(!(r.created.id instanceof Promise))
  assert.ok(m.bots.has(r.created.id))
  assert.equal(JSON.parse(JSON.stringify(r)).created.id, r.created.id) // survives JSON encoding
  assert.equal(r.created.depth, 2)
  assert.match(sp(m, m.root), /COORDINATOR[\s\S]*- A:/) // parent prompt refreshed after the await
  assert.equal(f(m, r.created.id, 'parent'), m.root)
})

test('send middleware: parent <-> direct child only', async () => {
  const m = await setup()
  const work = await make(m, m.root, 'Work'); const life = await make(m, m.root, 'Life'); const dev = await make(m, work, 'Dev')
  const send = (from, to) => m.flybot.bot.send({ from, to, text: 'hi' })
  assert.equal(m.middlewares[0].priority, m.flybot.bot.send.priority.ROUTING) // ROUTING band, ahead of social (APPROVAL)
  assert.equal((await send(m.root, work)).action, 'allow')
  assert.equal((await send(dev, work)).action, 'allow')
  assert.equal((await send(m.root, dev)).action, 'deny') // grandchild
  assert.equal((await send(dev, m.root)).action, 'deny')
  assert.equal((await send(work, life)).action, 'deny') // sibling
  const o = await outsider(m)
  assert.equal((await send(o, work)).action, 'deny') // non-tree sender may reach only the root
  assert.equal((await send(o, m.root)).action, 'allow')
})

test('fix 3: non-root tree bot -> local non-tree bot is denied; root (Chief) may message any local bot; remote passes', async () => {
  const m = await setup()
  const a = await make(m, m.root, 'A'); const b = await make(m, a, 'B')
  const other = await outsider(m, 'Other')
  const h = m.middlewares[0].handle
  const r = h({ from: a, to: other, target: { remote: false, id: other } })
  assert.equal(r.action, 'deny'); assert.match(r.reason, /outside the tree/)
  assert.equal((await m.flybot.bot.send({ from: b, to: other, text: 'x' })).action, 'deny')
  assert.equal((await m.flybot.bot.send({ from: m.root, to: other, text: 'x' })).action, 'allow') // Chief is the root and the main bot
  assert.equal((await m.flybot.bot.send({ from: other, to: m.root, text: 'x' })).action, 'allow') // outside -> root
  assert.equal((await m.flybot.bot.send({ from: other, to: a, text: 'x' })).action, 'deny') // outside -> non-root
  const other2 = await outsider(m, 'Other2')
  assert.equal((await m.flybot.bot.send({ from: other, to: other2, text: 'x' })).action, 'allow') // non-tree traffic untouched
  assert.equal((await m.flybot.bot.send({ from: m.root, to: b, text: 'x' })).action, 'deny') // root still only direct children in the tree
  assert.equal(h({ from: a, to: { kind: 'remote', handle: '@coder.bob.home', home: '@bob.home' }, target: { remote: true, handle: '@coder.bob.home', home: '@bob.home' } }), undefined)
  assert.equal((await m.flybot.bot.send({ from: a, to: '@coder.bob.home', text: 'x' })).action, 'allow')
  assert.equal(h({ from: a, to: '@coder.bob.home' }), undefined)
})

test('send middleware: social bypass only when configured', async () => {
  const off = await setup(); const a = await make(off, off.root, 'A')
  assert.equal(off.middlewares[0].handle({ from: off.root, to: a, target: { remote: false, id: a } }), undefined)
  const on = await setup({ bypassSocial: true }); const b = await make(on, on.root, 'B')
  assert.deepEqual(on.middlewares[0].handle({ from: on.root, to: b, target: { remote: false, id: b } }), { action: 'allow', bypass: ['social'] })
  assert.equal(on.middlewares[0].name, 'tree')
})

test('send chain: social bypass applies only when enabled in config', async () => {
  for (const bypassSocial of [false, true]) {
    const m = await setup({ bypassSocial })
    m.flybot.bot.send.use({ name: 'social', handle: () => ({ action: 'hold', reason: 'needs approval' }) })
    const a = await make(m, m.root, 'A')
    assert.equal((await m.flybot.bot.send({ from: m.root, to: a }, { bypassEnabled: true })).action, bypassSocial ? 'allow' : 'hold')
  }
})

test('send middleware: remote targets pass to social without reading fields', async () => {
  const m = await setup()
  const a = await make(m, m.root, 'A')
  const tf = m.flybot.scope('flybot-tree').fields
  let reads = 0
  const orig = m.bots.get
  const h = m.middlewares[0].handle
  m.bots.get = function (id) { if (typeof id === 'string' && id.startsWith('@')) reads++; return orig.call(this, id) }
  assert.equal(h({ from: a, to: { kind: 'remote', handle: '@x.peer' }, target: { remote: true, handle: '@x.peer', home: '@peer' } }), undefined)
  m.remote.add('remote2')
  assert.equal(h({ from: a, to: 'remote2' }), undefined) // bot.isRemote fallback
  m.bots.get = orig
  assert.equal(reads, 0)
  assert.equal(h({ from: a, target: { id: m.root, remote: false } }), undefined) // child -> parent ok
  assert.equal(tf.get(a, 'parent'), m.root)
})

test('fix 4: create_child_bot enforces minLength/maxLength dropped by tools.register', async () => {
  const m = await setup()
  const params = m.tools.get('create_child_bot').parameters
  assert.equal(params.name.minLength, undefined) // dropped, like the real host
  const c = args => m.call(m.root, 'create_child_bot', args)
  assert.match((await c({ name: '', role_description: 'x' })).error, /name must be at least 1/)
  assert.match((await c({ name: '   ', role_description: 'x' })).error, /name must be at least 1/)
  assert.match((await c({ name: 'x'.repeat(41), role_description: 'x' })).error, /name must be at most 40/)
  assert.match((await c({ name: 'A', role_description: '' })).error, /role_description must be at least 1/)
  assert.match((await c({ name: 'A', role_description: 'r'.repeat(1001) })).error, /role_description must be at most 1000/)
  assert.match((await c({ name: 'A' })).error, /role_description is required/)
  assert.match((await c({ name: 5, role_description: 'x' })).error, /name must be a string/)
  assert.match((await c({ name: 'A', role_description: 'x', owner: 'bot9' })).error, /unknown argument: owner/)
  assert.match((await c({ name: 'A', role_description: 'x', parent: 'bot9' })).error, /parent must be you or one of your descendants/) // #447
  assert.equal(m.bots.size, 1) // nothing created
  assert.ok((await c({ name: 'x'.repeat(40), role_description: 'r'.repeat(1000) })).created.id)
  assert.match((await m.call(m.root, 'list_children', { junk: 1 })).error, /unknown argument/)
})

test('field-change events reach tree subscribers; dispose unregisters', async () => {
  const m = createMockFlybot()
  m.addBot({ name: 'Chief', isMain: true })
  const { tree, dispose } = plugin.apply({ flybot: m.flybot })
  const seen = []; tree.subscribe(c => seen.push(c.key))
  const root = await tree.ensureRoot(); await make(m, root, 'A')
  assert.ok(seen.includes('parent'))
  dispose()
  assert.equal(m.tools.size, 0); assert.equal(m.middlewares.length, 0)
})

test('client: injects flybot, registers into FlyBot slots (not the shell slots service)', () => {
  let mod
  globalThis.window = { __ModuleLoader__: { load: ({ id, factory }) => { assert.equal(id, '@flybot/tree'); mod = factory(() => ({ createElement() {}, useEffect() {}, useState() {}, useCallback() {} })) } } }
  new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()
  assert.deepEqual(mod.inject, ['flybot']) // the browser flybot service carries the FlyBot slots
  assert.equal(mod.name, 'flybot-tree')
  const reg = []
  const effects = []
  const off = mod.apply({ flybot: { slots: { register: (name, entry) => { reg.push([name, entry]); return () => { const i = reg.findIndex(r => r[1] === entry); if (i >= 0) reg.splice(i, 1) } } } }, effect: fn => effects.push(fn) }, { sidebarSection: true })
  assert.deepEqual(reg.map(r => [r[0], r[1].id]), [['flybot.sidebar.section', 'flybot-tree'], ['flybot.sidebar.structure', 'flybot-tree'], ['flybot.sidebar.section', 'flybot-tree-reorg']])
  assert.equal(typeof reg[0][1].component, 'function')
  assert.equal(effects.length, 1)
  off(); assert.equal(reg.length, 0)
  const fo = mod.buildForest({ r: { id: 'r', name: 'Root', parent: null }, w: { id: 'w', name: 'Work', parent: 'r' }, d: { id: 'd', name: 'Dev', parent: 'w' } })
  assert.equal(fo[0].children[0].children[0].name, 'Dev')
})

test('bot.removed: children re-attach to the grandparent, prompts refresh, listeners fire', async () => {
  const m = await setup()
  const work = await make(m, m.root, 'Work'); const dev = await make(m, work, 'Dev')
  const seen = []; m.tree.subscribe(c => seen.push(c.key))
  m.removeBot(work)
  assert.equal(m.flybot.bot.list().some(b => b.id === work), false)
  assert.equal(f(m, dev, 'parent'), m.root)
  assert.ok(seen.includes('removed'))
  assert.match(sp(m, m.root), /- Dev:/)
  assert.doesNotMatch(sp(m, m.root), /- Work:/)
})

test('client builds the tree from ctx.flybot.bots() and fields', async () => {
  let mod
  globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => ({ createElement() {}, useEffect() {}, useState() {}, useCallback() {} })) } } }
  new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()
  const flybot = {
    bots: async () => [
      { id: 'r', name: 'Root', fields: { 'flybot-tree': { parent: null, treeRole: 'x' } } },
      { id: 'w', name: 'Work', fields: { 'flybot-tree': { parent: 'r', treeRole: 'y' }, social: { friends: [] } } },
      { id: 'o', name: 'Other', fields: { social: {} } },
    ],
    fields: { on: () => () => {} },
    on: () => () => {},
  }
  const { nodes } = await mod.treeOf(flybot)
  assert.deepEqual(Object.keys(nodes), ['r', 'w'])
  assert.equal(mod.buildForest(nodes)[0].children[0].name, 'Work')
})

test('bot.removed for a non-tree bot is ignored', async () => {
  const m = await setup()
  const a = await make(m, m.root, 'A')
  const o = await outsider(m)
  m.removeBot(o)
  assert.equal(f(m, a, 'parent'), m.root)
})

test('adapter requires flybot.scope', () => {
  assert.throws(() => plugin.apply({ flybot: { bot: {}, tools: {} } }), /scope/)
})

test('non-tree local sender: only the root is reachable; remote senders unchanged', async () => {
  const m = await setup()
  const a = await make(m, m.root, 'A'); const b = await make(m, a, 'B')
  const chief = await outsider(m, 'Chief')
  const send = (from, to) => m.flybot.bot.send({ from, to, text: 'x' })
  assert.equal((await send(chief, m.root)).action, 'allow')
  for (const t of [a, b]) {
    const r = await send(chief, t)
    assert.equal(r.action, 'deny'); assert.match(r.reason, /only the tree root/)
  }
  const h = m.middlewares[0].handle
  assert.equal(h({ from: { kind: 'remote', handle: '@x.peer' }, to: m.root, target: { remote: false, id: m.root } })?.action, 'deny') // remote sender to an ungranted Chief
  m.setGrants(m.root, [{ grantee: '@x.peer' }])
  assert.equal(h({ from: { kind: 'remote', handle: '@x.peer' }, to: m.root, target: { remote: false, id: m.root } }), undefined) // granted Chief: not the tree's call
  assert.equal(h({ from: '@x.peer', to: chief, target: { remote: false, id: chief } }), undefined) // a non-tree Bot is not the tree's call
  assert.equal((await send(chief, await outsider(m, 'Other'))).action, 'allow')
  assert.equal((await send(a, '@coder.bob.home')).action, 'allow') // remote target
})

test('#90: a remote sender reaches a granted tree Bot directly and an ungranted one never; no redirect to the root', async () => {
  const m = await setup()
  const a = await make(m, m.root, 'A'); const b = await make(m, a, 'B')
  const h = m.middlewares[0].handle
  const remote = { kind: 'remote', handle: '@x.peer' }
  const toward = to => h({ from: remote, to, target: { remote: false, id: to } })
  // New tree Bots have no grant.
  for (const id of [a, b]) {
    assert.equal(m.flybot.bot.hasAnyGrant(id), false)
    const verdict = toward(id)
    assert.equal(verdict.action, 'deny'); assert.match(verdict.reason, /has not been granted/)
  }
  assert.equal(toward(m.root)?.action, 'deny', 'the Chief has no grant until someone is invited')
  m.setGrants(m.root, [{ grantee: '@x.peer' }])
  assert.equal(toward(m.root), undefined, 'a granted Chief is reached directly')
  // Granted: reached directly, even a deep descendant, and the tree gives no other target.
  m.setGrants(b, [{ grantee: '@x.peer' }])
  assert.equal(toward(b), undefined)
  assert.equal((await m.flybot.bot.send({ from: remote, to: b, text: 'hi' })).action, 'allow')
  assert.equal(toward(a)?.action, 'deny', 'its parent stays ungranted')
  m.setGrants(b, [])
  assert.equal(toward(b).action, 'deny')
  // The rule also holds before the control-role bypass, and the string handle form.
  assert.equal(h({ from: '@x.peer', to: b, role: 'stopped', target: { remote: false, id: b } }).action, 'deny')
  assert.equal(h({ from: '@x.peer', to: b, target: { remote: false, id: b } }).action, 'deny')
})

test('#90: granted Bots on both sides are not the tree\'s call across trees; inside one tree the edge rule holds', async () => {
  const m = await setup()
  const a = await make(m, m.root, 'A'); const b = await make(m, a, 'B')
  const other = await outsider(m, 'Other owner Chief')
  const h = m.middlewares[0].handle
  const send = (from, to, extra = {}) => h({ from, to, target: { remote: false, id: to }, ...extra })
  const grant = id => m.setGrants(id, [{ grantee: 'peer' }])
  // Ungranted: the old rules.
  assert.match(send(other, b).reason, /only the tree root/)
  assert.match(send(b, other).reason, /outside the tree/)
  // Granted on both sides: the core's owner policy decides, the tree does not force it through the root.
  grant(other); grant(b)
  assert.equal(send(other, b), undefined)
  assert.equal(send(b, other), undefined)
  // One side ungranted: still denied.
  m.setGrants(b, [])
  assert.match(send(other, b).reason, /only the tree root/)
  // Inside one tree, a grant does not open the grandchild.
  grant(b); grant(a)
  assert.match(send(m.root, b).reason, /parent and its direct children/)
  assert.match(send(b, m.root).reason, /parent and its direct children/)
  assert.equal(send(a, b), undefined)
  // Two trees: granted nodes of different trees reach each other directly, ungranted ones do not.
  const root2 = await outsider(m, 'Second root')
  m.flybot.scope('flybot-tree').fields.set(root2, 'treeRole', 'root')
  const c = await make(m, root2, 'C')
  assert.equal(m.tree.rootOf(c), root2)
  assert.equal(m.tree.rootOf(b), m.root)
  assert.equal(m.tree.rootOf(other), undefined)
  assert.match(send(b, c).reason, /parent and its direct children/)
  grant(c)
  assert.equal(send(b, c), undefined)
  assert.equal(send(c, b), undefined)
})

test('#90: an older core without hasAnyGrant leaves the remote-sender rule as no opinion', async () => {
  const m = await setup()
  const a = await make(m, m.root, 'A')
  const h = treeSendMiddleware(m.tree, { isRemote: ref => typeof ref === 'string' && ref.startsWith('@') })
  assert.equal(h({ from: '@x.peer', to: a, target: { remote: false, id: a } }), undefined)
})

test('#90: new and adopted Bots start ungranted, prompts tell a child how outside senders are answered', async () => {
  const m = await setup()
  const a = await make(m, m.root, 'A')
  assert.equal(m.flybot.bot.hasAnyGrant(a), false)
  assert.equal(m.flybot.bot.hasAnyGrant(m.root), false, 'the Chief has no grant by default')
  assert.match(sp(m, a), /granted access to you/)
  assert.match(sp(m, a), /no trace line/)
  assert.doesNotMatch(sp(m, m.root), /granted access to you/)
})

const loadClient = () => {
  let mod
  globalThis.window = { __ModuleLoader__: { load: ({ factory }) => { mod = factory(() => reactStub) } } }
  new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()
  return mod
}
const sample = mod => mod.buildForest({
  r: { id: 'r', name: 'Root', role: 'Top-level coordinator for everything.', parent: null },
  w: { id: 'w', name: 'Work', role: 'Work tasks\nsecond line', parent: 'r' },
  d: { id: 'd', name: 'Dev', role: 'x'.repeat(300), parent: 'w' },
  l: { id: 'l', name: 'Life', role: '', parent: 'r' },
})

test('sidebar: header shows the node count; nodes render name, one-line role, guide lines', () => {
  const mod = loadClient()
  const html = renderToString(reactStub.createElement(mod.TreeView, { forest: sample(mod) }))
  assert.match(html, /class="flybot-tree-head"[^>]*aria-expanded="true"/)
  assert.match(html, /<span class="flybot-tree-title">Tree<\/span><span class="flybot-tree-count"[^>]*>4<\/span>/)
  assert.match(html, /class="flybot-tree-name">Work</)
  assert.match(html, /class="flybot-tree-role">Work tasks</) // first line only
  assert.doesNotMatch(html, /second line/)
  assert.match(html, /<ul class="flybot-tree-kids"/) // indented children with guide lines
  assert.match(mod.CSS, /\.flybot-tree-role\{[^}]*text-overflow:ellipsis/)
  assert.match(mod.CSS, /\.flybot-tree-kids::before\{[^}]*border-left/)
  assert.match(mod.CSS, /var\(--bt-ink-2/) // ds-bot sidebar tokens, dark theme follows
  assert.doesNotMatch(mod.CSS, /overflow:(auto|scroll)/) // no stray scrollbars
  assert.match(mod.CSS, /\.flybot-tree-toggle\{[^}]*width:28px;height:28px/)
  assert.match(mod.CSS, /\.flybot-tree-caret\{[^}]*font-size:16px/)
  assert.match(mod.CSS, /\.flybot-tree-toggle:hover\{background:var\(--bt-hover/)
  assert.match(mod.CSS, /\.flybot-tree-toggle:focus-visible\{outline:2px solid var\(--bt-accent/)
  assert.match(mod.CSS, /\.flybot-tree-toggle\[aria-expanded=false\] \.flybot-tree-caret\{transform:rotate\(-90deg\)\}/)
  assert.match(html, /class="flybot-tree-caret"/)
  assert.equal(mod.countNodes(sample(mod)), 4)
})

test('sidebar: empty state (no tree bots, or no root) and collapsed header', () => {
  const mod = loadClient()
  const empty = renderToString(reactStub.createElement(mod.TreeView, { forest: [] }))
  assert.match(empty, /No child bots yet\. Ask Chief to take on a task and it will create child bots\./)
  assert.match(empty, /class="flybot-tree-count"[^>]*>0</)
  const orphans = mod.buildForest({ a: { id: 'a', name: 'A', parent: 'gone' } }) // no root
  assert.match(renderToString(reactStub.createElement(mod.TreeView, { forest: orphans })), /No child bots yet/)
  // Chief adopted as root, no children yet: Chief's row plus the empty state
  const { nodes } = { nodes: { c: { id: 'c', name: 'Chief', role: 'Main bot · root of the tree', parent: null } } }
  const chiefOnly = renderToString(reactStub.createElement(mod.TreeView, { forest: mod.buildForest(nodes) }))
  assert.match(chiefOnly, /class="flybot-tree-name">Chief</)
  assert.match(chiefOnly, /No child bots yet/)
  const closed = renderToString(reactStub.createElement(mod.TreeView, { forest: sample(mod), expanded: false }))
  assert.match(closed, /aria-expanded="false"/)
  assert.doesNotMatch(closed, /flybot-tree-name/)
})

test('sidebar: clicking a node opens its chat via actions.openSession; toggles collapse children', () => {
  const mod = loadClient()
  const opened = []
  let entry
  mod.apply({ flybot: { slots: { register: (n, e) => { if (n === 'flybot.sidebar.section' && e.id === 'flybot-tree') entry = e; return () => {} } }, bots: async () => [], fields: { on: () => () => {} } } }, { sidebarSection: true })
  const Section = entry.component
  const tree = reactStub.createElement(Section, { actions: { openSession: id => opened.push(id) } })
  const buttons = findAll(tree, n => n.props.className === 'flybot-tree-head')
  assert.equal(buttons.length, 1)
  // with data: render the pure view with the same openBot wiring
  const view = reactStub.createElement(mod.TreeView, { forest: sample(mod), openBot: id => opened.push(id) })
  const open = findAll(view, n => n.props.className === 'flybot-tree-open')
  open.find(n => findAll(n, c => c.props.className === 'flybot-tree-name')[0].children[0] === 'Dev').props.onClick()
  assert.deepEqual(opened, ['d'])
  const toggles = findAll(view, n => n.props.className === 'flybot-tree-toggle')
  assert.deepEqual(toggles.map(t => t.props['aria-label']), ['Collapse Root', 'Collapse Work']) // only nodes with children
  // without openSession, node buttons are disabled
  const plain = findAll(reactStub.createElement(mod.TreeView, { forest: sample(mod) }), n => n.props.className === 'flybot-tree-open')
  assert.ok(plain.every(n => n.props.disabled === true))
})

test('root: Chief (Main Bot) is adopted as root, no bot created; own prompt kept; idempotent', async () => {
  const m = createMockFlybot()
  const helper = m.addBot({ name: 'Helper' })
  const chief = m.addBot({ name: 'Chief', isMain: true, systemPrompt: 'Chief own prompt' })
  const { tree } = plugin.apply({ flybot: m.flybot })
  const [a, b] = await Promise.all([tree.ensureRoot(), tree.ensureRoot()])
  assert.equal(a, chief); assert.equal(b, chief)
  await new Promise(r => setTimeout(r, 10))
  assert.equal(m.bots.size, 2) // nothing created
  assert.equal(f(m, chief, 'treeRole'), 'root')
  assert.equal(f(m, helper, 'parent'), chief) // existing bot adopted as Chief's child
  assert.match(sp(m, chief), /^Chief own prompt\n\n<!-- flybot-tree:start -->/) // injected, not overwritten
  assert.match(sp(m, chief), /ROOT of a recursive bot tree/)
  const before = sp(m, chief)
  await tree.ensureRoot(); await tree.ensureRoot()
  assert.equal(sp(m, chief), before) // one block, idempotent
  const kid = await make(m, chief, 'Work')
  assert.match(sp(m, chief), /^Chief own prompt/)
  assert.match(sp(m, chief), /COORDINATOR[\s\S]*- Work:/)
  assert.equal(sp(m, chief).split('flybot-tree:start').length, 2)
  assert.match(sp(m, kid), /Chief → Work/)
  // the user later edits Chief's own text: the tree block survives a refresh and the edit stays
  m.bots.get(chief).systemPrompt = sp(m, chief).replace('Chief own prompt', 'Edited by user')
  await make(m, chief, 'Life')
  assert.match(sp(m, chief), /^Edited by user/)
  assert.match(sp(m, chief), /- Life:/)
})

test('root: adopted when Chief appears later (bot.created), config.rootBotId wins, autoRoot:false is off', async () => {
  const m = createMockFlybot()
  plugin.apply({ flybot: m.flybot })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(m.bots.size, 0) // team not loaded: nothing created
  const chief = m.addBot({ name: 'Chief', isMain: true })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(f(m, chief, 'treeRole'), 'root')
  assert.equal(m.bots.size, 1)

  const n = createMockFlybot()
  n.addBot({ name: 'Chief', isMain: true }); const pick = n.addBot({ name: 'Lead' })
  const { tree } = plugin.apply({ flybot: n.flybot }, { rootBotId: pick })
  assert.equal(await tree.ensureRoot(), pick)
  const off = createMockFlybot(); const c2 = off.addBot({ name: 'Chief', isMain: true }); plugin.apply({ flybot: off.flybot }, { autoRoot: false })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(f(off, c2, 'treeRole'), undefined)
})

test('root: fallback creates a Root only when the team has bots but no Main Bot (once)', async () => {
  const m = createMockFlybot()
  m.addBot({ name: 'Solo' })
  const { tree } = plugin.apply({ flybot: m.flybot }, { autoRoot: false })
  const [a, b] = await Promise.all([tree.ensureRoot(), tree.ensureRoot()])
  assert.equal(a, b)
  assert.equal(m.bots.size, 2)
  assert.equal(m.bots.get(a).name, 'Root'); assert.equal(f(m, a, 'treeRole'), 'root')
  assert.equal(await tree.ensureRoot(), a)
})

test('migration: an earlier auto-created Root hands its children to Chief, keeps the bot, idempotent', async () => {
  const m = createMockFlybot()
  const chief = m.addBot({ name: 'Chief', isMain: true, systemPrompt: 'Chief own prompt' })
  // state from an earlier install: separate Root (pre-block prompt) with two children
  const old = m.addBot({ name: 'Root', systemPrompt: 'You are Root, a bot in a recursive bot tree. ...', fields: { 'flybot-tree': { parent: null, treeRole: 'Top-level coordinator for everything.' } } })
  const w = m.addBot({ name: 'Work', fields: { 'flybot-tree': { parent: old, treeRole: 'work' } } })
  const l = m.addBot({ name: 'Life', fields: { 'flybot-tree': { parent: old, treeRole: 'life' } } })
  const { tree } = plugin.apply({ flybot: m.flybot }, { autoRoot: false })
  assert.equal(await tree.ensureRoot(), chief)
  assert.equal(f(m, w, 'parent'), chief); assert.equal(f(m, l, 'parent'), chief)
  assert.ok(m.bots.has(old)) // not deleted
  assert.deepEqual(m.bots.get(old).fields, { 'flybot-tree': { retired: true } }) // tree fields cleared, retired
  assert.equal(sp(m, old), '')
  assert.match(sp(m, chief), /COORDINATOR[\s\S]*- Work:[\s\S]*- Life:/)
  assert.deepEqual((await m.call(chief, 'list_children')).children.map(c => c.name).sort(), ['Life', 'Work'])
  await assert.rejects(m.call(old, 'list_children'), /not visible/)
  const snap = JSON.stringify([...m.bots.values()])
  await tree.ensureRoot()
  assert.equal(JSON.stringify([...m.bots.values()]), snap) // idempotent
  // a block-style old Root keeps its own text, loses only the block
  const n = createMockFlybot(); const c = n.addBot({ name: 'Chief', isMain: true })
  const o2 = n.addBot({ name: 'Root', systemPrompt: 'mine\n\n<!-- flybot-tree:start -->\nYou are Root, a bot in a recursive bot tree.\n<!-- flybot-tree:end -->', fields: { 'flybot-tree': { parent: null, treeRole: 'x' } } })
  const t2 = plugin.apply({ flybot: n.flybot }, { autoRoot: false }).tree
  assert.equal(await t2.ensureRoot(), c)
  assert.equal(sp(n, o2), 'mine')
})

test('sidebar section is off by default; sync tree.forest(bots) helper is exposed', () => {
  const mod = loadClient()
  const reg = []
  const flybot = { slots: { register: (n) => { reg.push(n); return () => {} } } }
  globalThis.__flybot__ = {}
  const off = mod.apply({ flybot })
  // No separate Tree section (ds-bot's list draws the tree); only the reorganization notice (#446),
  // which draws nothing until a reorganization ran. reorgNotice: false leaves it out.
  assert.deepEqual(reg, ['flybot.sidebar.structure', 'flybot.sidebar.section'])
  assert.equal(typeof flybot.tree.forest, 'function')
  assert.equal(globalThis.__flybot__.tree, flybot.tree)
  const bots = [
    { id: 'c', name: 'Chief', createdAt: 1, fields: { 'flybot-tree': { treeRole: 'root' } } },
    { id: 'p', name: '程序员', createdAt: 5, fields: { 'flybot-tree': { parent: 'c', treeRole: '' } } },
    { id: 'r', name: '研究员', createdAt: 3, fields: { 'flybot-tree': { parent: 'c', treeRole: 'research' } } },
    { id: 'd', name: 'Dev', createdAt: 9, fields: { 'flybot-tree': { parent: 'p', treeRole: 'dev' } } },
    { id: 'old', name: 'Root', createdAt: 2, fields: { 'flybot-tree': { retired: true } } },
    { id: 'x', name: 'Outside', createdAt: 4, fields: {} },
  ]
  const f = flybot.tree.forest(bots) // synchronous
  assert.ok(!(f instanceof Promise))
  assert.deepEqual(f, [{ id: 'c', name: 'Chief', role: 'Main bot · root of the tree', root: true, createdAt: 1, children: [
    { id: 'r', name: '研究员', role: 'research', root: false, createdAt: 3, children: [] },
    { id: 'p', name: '程序员', role: '', root: false, createdAt: 5, children: [{ id: 'd', name: 'Dev', role: 'dev', root: false, createdAt: 9, children: [] }] },
  ] }])
  off()
  assert.equal(flybot.tree, undefined)
  delete globalThis.__flybot__
})

test('client forestOf is an identical copy of src/forest.js', async () => {
  const src = readFileSync(new URL('../src/forest.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function forestOf')).replace('export function forestOf', 'function forestOf').trim()
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const block = client.slice(client.indexOf('forest-of:start'), client.indexOf('// ---- forest-of:end'))
  const copy = block.slice(block.indexOf('function forestOf')).split('\n').map(l => l.replace(/^ {4}/, '')).join('\n').trim()
  assert.equal(copy, fn)
  const { forestOf } = await import('../src/forest.js')
  assert.deepEqual(forestOf([{ id: 'a', name: 'A', fields: { 'flybot-tree': { parent: 'a', treeRole: 'x' } } }]).map(n => n.id), ['a']) // self-parent -> top level
})

test('adoption: existing local bots without tree fields join the tree by role; retired/remote/main skipped; maxChildren respected (#446)', async () => {
  const m = createMockFlybot()
  const chief = m.addBot({ name: 'Chief', isMain: true })
  const names = ['研究员', '数据分析师', '文案', '程序员']
  const ids = names.map(name => m.addBot({ name, systemPrompt: `${name} own` }))
  const retired = m.addBot({ name: 'Root', fields: { 'flybot-tree': { retired: true } } })
  const main2 = m.addBot({ name: 'Second main', isMain: true })
  const warns = []
  const { tree } = plugin.apply({ flybot: m.flybot, logger: () => ({ warn: (...a) => warns.push(a.join(' ')) }) }, { autoRoot: false, maxChildren: 3 })
  await tree.ensureRoot()
  await tree.settled()
  // Chief is full at 程序员: the two research Bots are grouped under a new Research Lead, which frees the slot.
  const kids = (await m.call(chief, 'list_children')).children.map(c => c.name)
  assert.deepEqual(kids, ['文案', '程序员', 'Research Lead'])
  const lead = (await m.call(chief, 'list_children')).children.find(c => c.name === 'Research Lead')
  assert.equal(f(m, ids[0], 'parent'), lead.id); assert.equal(f(m, ids[1], 'parent'), lead.id)
  assert.match(lead.role, /Lead of the Research group: coordinates 研究员, 数据分析师/)
  assert.deepEqual(f(m, lead.id, 'lead'), { key: 'domain:research', label: 'Research' })
  assert.doesNotMatch(warns.join('\n'), /left outside/)
  assert.match(warns.join('\n'), /reorganized \(full\): created Research Lead under Chief/)
  assert.equal(f(m, retired, 'parent'), undefined); assert.equal(f(m, main2, 'parent'), undefined)
  assert.match(sp(m, ids[0]), /^研究员 own\n\n<!-- flybot-tree:start -->/) // own prompt kept, tree block added
  assert.match(sp(m, chief), /COORDINATOR[\s\S]*- 文案/)
  assert.match(sp(m, chief), /Last automatic tree reorganization \(\d{4}-\d\d-\d\d \d\d:\d\d\): created Research Lead under Chief/)
  // message rules: Chief reaches its children; a grouped Bot reaches only its lead
  const send = (from, to) => m.flybot.bot.send({ from, to, text: 'x' })
  assert.equal((await send(chief, ids[2])).action, 'allow')
  assert.equal((await send(ids[2], chief)).action, 'allow')
  assert.equal((await send(ids[2], ids[3])).action, 'deny') // siblings
  assert.equal((await send(ids[0], lead.id)).action, 'allow')
  assert.equal((await send(ids[0], chief)).action, 'deny') // not its parent any more
  // idempotent; host-side sync forest
  await tree.ensureRoot(); await tree.settled()
  assert.equal((await m.call(chief, 'list_children')).children.length, 3)
  const fo = tree.forest()
  assert.equal(fo[0].id, chief); assert.deepEqual(fo[0].children.map(c => c.name), ['文案', '程序员', 'Research Lead'])
})

test('adoption on bot.created: a bot created without a parent joins Chief; create_child_bot keeps its parent; adoptExisting:false is off', async () => {
  const m = createMockFlybot()
  const chief = m.addBot({ name: 'Chief', isMain: true })
  const { tree } = plugin.apply({ flybot: m.flybot })
  await new Promise(r => setTimeout(r, 10))
  const w = (await m.call(chief, 'create_child_bot', { name: 'Work', role_description: 'w' })).created.id
  const d = (await m.call(w, 'create_child_bot', { name: 'Dev', role_description: 'd' })).created.id
  const later = await m.flybot.bot.create({ name: '文案' }) // e.g. ds-bot UI / create_bot
  await new Promise(r => setTimeout(r, 10))
  assert.equal(f(m, later, 'parent'), chief)
  assert.equal(f(m, d, 'parent'), w)
  assert.deepEqual(tree.forest()[0].children.map(c => c.name), ['Work', '文案'])

  const n = createMockFlybot(); n.addBot({ name: 'Chief', isMain: true })
  plugin.apply({ flybot: n.flybot }, { adoptExisting: false })
  const solo = await n.flybot.bot.create({ name: 'Solo' })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(f(n, solo, 'parent'), undefined)
})

test('migration marks the old auto-created Root retired; adoption skips it; never deleted', async () => {
  const m = createMockFlybot()
  const chief = m.addBot({ name: 'Chief', isMain: true })
  const old = m.addBot({ name: 'Root', fields: { 'flybot-tree': { parent: null, treeRole: 'Top-level coordinator for everything.' } } })
  const w = m.addBot({ name: 'Work', fields: { 'flybot-tree': { parent: old, treeRole: 'work' } } })
  const { tree } = plugin.apply({ flybot: m.flybot }, { autoRoot: false })
  await tree.ensureRoot(); await tree.ensureRoot()
  assert.ok(m.bots.has(old))
  assert.deepEqual(m.bots.get(old).fields, { 'flybot-tree': { retired: true } })
  assert.equal(f(m, w, 'parent'), chief)
  assert.deepEqual(tree.forest()[0].children.map(c => c.name), ['Work'])
})

test('sidebar structure: parents from forestOf; retired and outside Bots have none (ds-bot puts them under Chief)', async () => {
  const mod = loadClient()
  const bots = [
    { id: 'c', name: 'Chief', createdAt: 1, fields: { 'flybot-tree': { treeRole: 'root' } } },
    { id: 'w', name: 'Work', createdAt: 2, fields: { 'flybot-tree': { parent: 'c', treeRole: 'work' } } },
    { id: 'd', name: 'Dev', createdAt: 3, fields: { 'flybot-tree': { parent: 'w', treeRole: 'dev' } } },
    { id: 'old', name: 'Root', createdAt: 0, fields: { 'flybot-tree': { retired: true } } },
    { id: 'x', name: 'Outside', createdAt: 4, fields: {} },
  ]
  const entries = []
  const dispose = mod.registerStructure({ slots: { register: (n, e) => { entries.push([n, e]); return () => {} } }, bots: async () => bots })
  await new Promise(r => setTimeout(r, 10))
  const [name, entry] = entries.at(-1)
  assert.equal(name, 'flybot.sidebar.structure')
  assert.deepEqual(['c', 'w', 'd', 'old', 'x'].map(id => entry.parentOf(id)), [undefined, 'c', 'w', undefined, undefined])
  dispose()
})

// ---- per-node "Copy invite link" (bare URL); copyInvite's 'text' kind (full message) stays for callers
const withNavigator = async (nav, fn) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true })
  try { return await fn() } finally { if (before) Object.defineProperty(globalThis, 'navigator', before); else delete globalThis.navigator }
}
const inviteButtons = (mod, flybot, bot) => findAll(reactStub.createElement(mod.makeInviteAction(flybot), { bot }), n => n.props.className === 'flybot-tree-invite')

test('menu item: structure entry carries one copy-invite menu item, visible only when canInvite(bot.id)', async () => {
  const mod = loadClient()
  const entries = []
  const dispose = mod.registerStructure({ slots: { register: (n, e) => { entries.push(e); return () => {} } }, bots: async () => [] })
  assert.equal(typeof entries[0].menuItems, 'function')
  assert.equal(typeof entries[0].nodeActions, 'function') // the idle / archived tag (#446), not the old hover button
  dispose()
  const b = { id: 'b1', name: '研究员' }
  delete globalThis.__flybot__
  const items = flybot => mod.makeMenuItems(flybot)({ bot: b })
  const item = flybot => items(flybot)[0]
  // The menu offers one Copy invite entry; the invite with instructions is in Sharing (#173).
  const full = flybot => ({ run: async ({ bot }) => { const r = await mod.copyInvite(flybot, bot.id, 'text'); if (r.tone === 'error') throw new Error(r.text); return `Invite for ${bot.name} copied, with instructions` } })
  assert.deepEqual(items({}).map(i => [i.id, i.label]), [['copy-invite', 'Copy invite link']])
  assert.equal(item({}).visible, false)
  assert.equal(item({ social: { canInvite: () => false } }).visible, false)
  assert.equal(item({ social: { canInvite: () => { throw new Error('x') } } }).visible, false)
  const seen = []
  assert.equal(item({ social: { canInvite: id => { seen.push(id); return true } } }).visible, true)
  assert.deepEqual(seen, ['b1'])
  const copied = []
  const social = { canInvite: () => true, createInvite: async id => ({ text: 'join ' + id + ' at https://s/i/X', link: 'https://s/i/X' }) }
  await withNavigator({ clipboard: { writeText: async t => { copied.push(t) } } }, async () => {
    // "Copy invite link": the bare URL only, no instructions.
    assert.equal(await item({ social }).run({ bot: b }), 'Invite link for 研究员 copied')
    // copyInvite 'text': the full message.
    assert.equal(await full({ social }).run({ bot: b }), 'Invite for 研究员 copied, with instructions')
  })
  assert.deepEqual(copied, ['https://s/i/X', 'join b1 at https://s/i/X'])
  await assert.rejects(item({ social: { canInvite: () => true, createInvite: async () => { throw new Error('offline') } } }).run({ bot: b }), /offline/)
  // Neither falls back to the other field.
  await withNavigator({ clipboard: { writeText: async t => { copied.push(t) } } }, async () => {
    await assert.rejects(full({ social: { canInvite: () => true, createInvite: async () => ({ link: 'L' }) } }).run({ bot: b }), /without its message/)
    await assert.rejects(item({ social: { canInvite: () => true, createInvite: async () => ({ text: 'T' }) } }).run({ bot: b }), /without its link/)
  })
  assert.equal(copied.length, 2)
  // ClipboardItem path: the write starts inside the click (before the invite resolves).
  const writes = []
  let started = 0
  globalThis.ClipboardItem = class { constructor(parts) { this.parts = parts } }
  try {
    await withNavigator({ clipboard: { write: async ([it]) => { started++; writes.push(await (await it.parts['text/plain']).text()) }, writeText: async () => { throw new Error('unused') } } }, async () => {
      const slow = { canInvite: () => true, createInvite: async id => { await new Promise(r => setTimeout(r, 5)); return { text: 'full ' + id, link: 'https://s/i/Y' } } }
      const pending = item({ social: slow }).run({ bot: b })
      assert.equal(started, 1) // synchronous with the click
      await pending
      await full({ social: slow }).run({ bot: b })
    })
  } finally { delete globalThis.ClipboardItem }
  assert.deepEqual(writes, ['https://s/i/Y', 'full b1'])
})

test('invite action (legacy hover component): hidden without social or when canInvite is false', () => {
  const mod = loadClient()
  const bot = { id: 'b1', name: '研究员' }
  delete globalThis.__flybot__
  assert.equal(inviteButtons(mod, {}, bot).length, 0) // social not installed
  assert.equal(inviteButtons(mod, { social: { canInvite: () => false } }, bot).length, 0) // status not ready / not invitable
  assert.equal(inviteButtons(mod, { social: { canInvite: () => { throw new Error('x') } } }, bot).length, 0)
  const seen = []
  const btn = inviteButtons(mod, { social: { canInvite: id => { seen.push(id); return true } } }, bot)
  assert.equal(btn.length, 1); assert.deepEqual(seen, ['b1'])
  assert.equal(btn[0].props['aria-label'], 'Copy invite link for 研究员')
  assert.equal(btn[0].props.title, 'Copy invite link')
  // globalThis.__flybot__.social is used when ctx.flybot.social is absent
  globalThis.__flybot__ = { social: { canInvite: () => true } }
  assert.equal(inviteButtons(mod, {}, bot).length, 1)
  delete globalThis.__flybot__
  // revealed on hover, consistent with ds-bot tokens
  assert.match(mod.INVITE_CSS, /\.bt-tree-item:hover \.flybot-tree-invite/)
  assert.match(mod.INVITE_CSS, /var\(--bt-hover/)
})

test('invite action: click stops propagation, calls createInvite and copies the bare link (clipboard)', async () => {
  const mod = loadClient()
  const copied = [], calls = []
  const social = { canInvite: () => true, createInvite: async botId => { calls.push(botId); return { botId, link: 'https://x/i/abc', text: 'Join my bot: https://x/i/abc' } } }
  await withNavigator({ clipboard: { writeText: async t => { copied.push(t) } } }, async () => {
    const [btn] = inviteButtons(mod, { social }, { id: 'b1', name: 'A' })
    let stopped = 0
    await btn.props.onClick({ stopPropagation: () => stopped++, preventDefault() {} })
    assert.equal(stopped, 1)
    assert.deepEqual(calls, ['b1'])
    assert.deepEqual(copied, ['https://x/i/abc'])
    assert.deepEqual(await mod.copyInvite({ social }, 'b1', 'text'), { tone: 'ok', text: 'Copied' })
    assert.deepEqual(copied, ['https://x/i/abc', 'Join my bot: https://x/i/abc'])
    assert.deepEqual(await mod.copyInvite({ social }, 'b2'), { tone: 'ok', text: 'Copied' })
    // without social.createInvite it uses flybot.call('social.createInvite', { botId })
    const via = []
    const r = await mod.copyInvite({ social: { canInvite: () => true }, call: async (name, payload) => { via.push([name, payload]); return { text: 'T', link: 'L' } } }, 'b3')
    assert.deepEqual(r, { tone: 'ok', text: 'Copied' }); assert.deepEqual(via, [['social.createInvite', { botId: 'b3' }]])
  })
})

test('invite action: textarea fallback, and errors become inline messages', async () => {
  const mod = loadClient()
  const social = { canInvite: () => true, createInvite: async () => ({ text: 'invite text', link: 'https://s/i/Z' }) }
  const doc = { body: { appendChild(el) { doc.added = el } }, createElement: () => ({ style: {}, setAttribute() {}, select() { doc.selected = this.value }, remove() { doc.removed = true } }), execCommand: cmd => cmd === 'copy' }
  const beforeDoc = globalThis.document
  globalThis.document = doc
  try {
    await withNavigator({ clipboard: { writeText: async () => { throw new Error('denied') } } }, async () => {
      assert.deepEqual(await mod.copyInvite({ social }, 'b1'), { tone: 'ok', text: 'Copied' })
      assert.equal(doc.selected, 'https://s/i/Z'); assert.equal(doc.removed, true)
    })
    doc.execCommand = () => false
    await withNavigator({}, async () => {
      assert.deepEqual(await mod.copyInvite({ social }, 'b1'), { tone: 'error', text: 'Copy failed' })
    })
  } finally { if (beforeDoc === undefined) delete globalThis.document; else globalThis.document = beforeDoc }
  await withNavigator({}, async () => {
    assert.deepEqual(await mod.copyInvite({ social }, 'b1'), { tone: 'error', text: 'Clipboard unavailable' })
    assert.deepEqual(await mod.copyInvite({ social: { createInvite: async () => { throw new Error('Not connected to Bot Social') } } }, 'b1'), { tone: 'error', text: 'Not connected to Bot Social' })
    assert.deepEqual(await mod.copyInvite({ social: { createInvite: async () => ({}) } }, 'b1'), { tone: 'error', text: 'The invite came back without its link' })
    assert.deepEqual(await mod.copyInvite({ social: { createInvite: async () => ({}) } }, 'b1', 'text'), { tone: 'error', text: 'The invite came back without its message' })
  })
})

test('issue 15 (1): control notices (stopped, report) bypass tree policy; a Main Bot can stop_bot any tree bot', async () => {
  const m = await setup()
  const work = await make(m, m.root, 'Work'); const life = await make(m, m.root, 'Life'); const dev = await make(m, work, 'Dev')
  const o = await outsider(m)
  const send = (from, to, role) => m.flybot.bot.send({ from, to, text: 'stop', role })
  for (const [from, to] of [[m.root, dev], [o, dev], [o, work], [work, life], [dev, o]]) {
    assert.equal((await send(from, to, 'stopped')).action, 'allow', `stopped ${from}->${to}`)
    assert.equal((await send(from, to, 'report')).action, 'allow', `report ${from}->${to}`)
  }
  assert.equal((await send(m.root, dev, 'request')).action, 'deny') // ordinary requests still follow the tree
  assert.equal((await send(o, dev)).action, 'deny')
})

test('issue 15 (2) / #446: deleting a middle node refreshes every reparented child (and its subtree); an overflow is regrouped by role, nothing dropped', async () => {
  const warnings = []
  const m = createMockFlybot()
  m.addBot({ name: 'Chief', isMain: true, systemPrompt: '' })
  const { tree } = plugin.apply({ flybot: m.flybot, logger: () => ({ warn: (...a) => warnings.push(a.join(' ')) }) }, { adoptExisting: false, maxChildren: 2 })
  m.tree = tree; m.root = await tree.ensureRoot()
  const work = await make(m, m.root, 'Work'); const life = await make(m, m.root, 'Life')
  const dev = await make(m, work, 'Dev'); const ops = await make(m, work, 'Ops'); const qa = await make(m, dev, 'QA')
  assert.match(sp(m, dev), /Work/); assert.match(sp(m, qa), /Work/)
  m.removeBot(work)
  // Chief would have Life, Dev and Ops (3 > maxChildren=2). Dev and Ops share a role (dev) and Dev
  // already coordinates (it has QA), so Dev becomes the lead and Ops moves under it, at once. Life,
  // an unrelated Bot, is not used as a dumping ground. No Bot is deleted.
  assert.equal(f(m, dev, 'parent'), m.root)
  assert.equal(f(m, ops, 'parent'), dev)
  assert.equal(f(m, life, 'parent'), m.root)
  assert.equal(m.tree.childrenOf(m.tree.snapshot(), m.root).length, 2)
  for (const id of [dev, ops, qa]) { assert.ok(m.bots.has(id)); assert.doesNotMatch(sp(m, id), /Work/); assert.match(sp(m, id), /Chief/) }
  assert.match(sp(m, qa), /Chief → Dev → QA/)
  assert.match(sp(m, ops), /Chief → Dev → Ops/)
  assert.match(sp(m, dev), /COORDINATOR[\s\S]*- Ops/)
  assert.ok(warnings.some(w => /reorganized \(repair\): moved Ops from Chief to Dev/.test(w)), 'the move is logged')
  assert.ok(warnings.some(w => /made Dev the lead of the Dev group/.test(w)))
  await assert.rejects(m.call(m.root, 'create_child_bot', { name: 'New', role_description: 'x' }).then(r => { if (r.error || !r.created) throw new Error(r.error ?? 'refused') }))
})

test('issue 15 (3): parallel create_child_bot never exceeds maxChildren nor duplicates sibling names', async () => {
  const m = await setup({ maxChildren: 3 })
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => m.call(m.root, 'create_child_bot', { name: `C${i}`, role_description: 'x' })))
  const kids = m.tree.childrenOf(m.tree.snapshot(), m.root)
  assert.equal(kids.length, 3)
  const dup = await Promise.allSettled(Array.from({ length: 6 }, () => m.call(kids[0].id, 'create_child_bot', { name: 'Same', role_description: 'x' })))
  const same = m.tree.childrenOf(m.tree.snapshot(), kids[0].id)
  assert.equal(same.length, 1)
  assert.ok(results.length === 10 && dup.length === 6)
})

test('issue 20: name limit matches the roster (40); checkCreate enforces it too', async () => {
  const { MAX_NAME_LENGTH } = await import('../src/limits.js')
  assert.equal(MAX_NAME_LENGTH, 40)
  const L = { maxDepth: 5, maxChildren: 8 }
  assert.match(checkCreate({ parentName: 'R', parentDepth: 1, siblings: [], name: 'x'.repeat(41), limits: L }), /at most 40/)
  assert.equal(checkCreate({ parentName: 'R', parentDepth: 1, siblings: [], name: ` ${'x'.repeat(40)} `, limits: L }), null)
  const m = await setup()
  await assert.rejects(m.tree.createChild(m.root, 'y'.repeat(41), 'r'), /at most 40/)
})

test('issue 20: dispose via ctx.effect (cordis), ctx.on("dispose") only as fallback', async () => {
  const m = createMockFlybot()
  m.addBot({ name: 'Chief', isMain: true })
  const effects = [], ons = []
  plugin.apply({ flybot: m.flybot, effect: (fn, label) => effects.push([fn(), label]), on: e => ons.push(e) }, { autoRoot: false })
  assert.equal(effects.length, 1); assert.equal(effects[0][1], 'flybot-tree'); assert.equal(ons.length, 0)
  assert.equal(m.middlewares.length, 1)
  effects[0][0]() // the effect's disposer unregisters middleware and tools
  assert.equal(m.middlewares.length, 0)
  assert.equal(m.tools.size, 0)
  const m2 = createMockFlybot(); const ons2 = []
  plugin.apply({ flybot: m2.flybot, on: (e, fn) => ons2.push([e, fn]) }, { autoRoot: false })
  assert.equal(ons2[0][0], 'dispose'); ons2[0][1]()
  assert.equal(m2.middlewares.length, 0)
})

test('issue 6: concurrent ensureRoot() calls create a single root', async () => {
  const m = createMockFlybot()
  m.addBot({ name: 'Worker' }) // team has bots but no Main Bot: fallback root is created
  const { tree } = plugin.apply({ flybot: m.flybot }, { adoptExisting: false, autoRoot: false })
  const ids = await Promise.all(Array.from({ length: 5 }, () => tree.ensureRoot()))
  assert.equal(new Set(ids).size, 1)
  assert.equal(m.flybot.bot.list().filter(b => b.name === 'Root').length, 1)
})

test('trace line: only in answers to the parent tree bot; never to the user or remote bots; root never', async () => {
  const { systemPrompt } = await import('../src/prompt.js')
  const leaf = systemPrompt({ name: 'Dev', role: 'code', trace: 'Chief → Work → Dev', children: [] })
  const mid = systemPrompt({ name: 'Work', role: 'w', trace: 'Chief → Work', children: [{ name: 'Dev', role: 'code' }] })
  const root = systemPrompt({ name: 'Chief', role: 'root', trace: 'Chief', children: [{ name: 'Work', role: 'w' }], root: true })
  for (const p of [leaf, mid, root]) {
    assert.doesNotMatch(p, /^(Start your answer|Begin with)/m)
    assert.match(p, /Never start a reply to the user, or to a remote bot/)
  }
  assert.match(leaf, /Only when you answer your parent bot in the tree, start that answer with a one-line trace[^\n]*"Chief → Work → Dev"/)
  assert.match(mid, /Only when you answer your parent bot in the tree/)
  assert.match(root, /Do not start your replies with a trace/)
  assert.doesNotMatch(root, /Only when you answer your parent/)
  const m = await setup()
  const work = await make(m, m.root, 'Work')
  assert.match(sp(m, m.root), /Do not start your replies with a trace/)
  assert.match(sp(m, work), /Only when you answer your parent bot/)
})

test('client bundle registers under the package name and mounts itself (moved from ds-bot core tests, #34)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(client.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1], pkg.name)
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.match(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), new RegExp(`name: '${pkg.name}'`))
  assert.notEqual(pkg.peerDependencies['ds-bot'], '*')
})

test('adapter refuses a flybot API version it was not written for', async () => {
  const { createAdapter, FLYBOT_API } = await import('../src/adapter.js')
  const m = createMockFlybot()
  assert.throws(() => createAdapter({ ...m.flybot, scope: m.flybot.scope, version: FLYBOT_API + 1 }), /needs flybot API v1/)
})

// #446 (owner decision 2026-10-19 21:27): every Bot is placed in the tree under its limits, by role.
// A full level is regrouped by role under a suitable existing lead or a new lead with a clear role;
// there is no "least-loaded child" fallback. Duplicates are merged and archived, never deleted; a
// daily tidy archives long-idle leaves; every change is journaled and the last run can be undone.
async function fullChief(maxChildren = 3, names = ['Cooking', 'Travel', 'Garden'], config = {}) {
  const m = createMockFlybot()
  const chief = m.addBot({ name: 'Chief', isMain: true })
  const warns = []
  const { tree } = plugin.apply({ flybot: m.flybot, logger: () => ({ warn: (...a) => warns.push(a.join(' ')) }) }, { maxChildren, dailyTidy: false, ...config })
  await tree.ensureRoot()
  const kids = {}
  for (const name of names) kids[name] = (await m.call(chief, 'create_child_bot', { name, role_description: `${name} stuff` })).created.id
  const children = id => tree.childrenOf(tree.snapshot(), id).map(c => c.name)
  const idOf = name => Object.values(tree.snapshot()).find(n => n.name === name)?.id
  // Fails the test if any parent ever goes over maxChildren, even for a moment.
  const over = []
  m.flybot.scope('flybot-tree').fields.on('change', c => {
    if (c.key !== 'parent') return
    const nodes = tree.snapshot()
    for (const id of Object.keys(nodes)) if (tree.childrenOf(nodes, id).length > maxChildren) over.push(`${nodes[id].name}: ${tree.childrenOf(nodes, id).length}`)
  })
  return { m, tree, chief, kids, warns, children, idOf, over }
}

test('#446: create_child_bot still refuses at maxChildren; create_bot Bots are grouped by role (Life Lead, FlyBot Lead), never under an unrelated Bot', async () => {
  const { m, tree, chief, kids, warns, children, idOf, over } = await fullChief(4, ['Cooking', 'Shopping', 'Garden', 'Travel'])
  assert.match((await m.call(chief, 'create_child_bot', { name: 'FlyBot Dev', role_description: 'x' })).error, /limit reached: Chief already has 4 children \(maxChildren=4\)/)
  const team = []
  for (const name of ['FlyBot Dev', 'FlyBot Test', 'FlyBot Maint', 'FlyBot Repo']) team.push(await m.flybot.bot.create({ name })) // the create_bot path: no tree fields
  await tree.settled()
  assert.deepEqual(over, [], 'no parent ever went over maxChildren')
  assert.deepEqual(children(chief), ['Life Lead', 'FlyBot Lead'])
  assert.deepEqual(children(idOf('Life Lead')), ['Cooking', 'Shopping', 'Garden', 'Travel'])
  assert.deepEqual(children(idOf('FlyBot Lead')), ['FlyBot Dev', 'FlyBot Test', 'FlyBot Maint', 'FlyBot Repo'])
  for (const id of team) assert.equal(f(m, id, 'parent'), idOf('FlyBot Lead'))
  for (const id of Object.values(kids)) assert.equal(f(m, id, 'parent'), idOf('Life Lead'))
  assert.match(f(m, idOf('FlyBot Lead'), 'treeRole'), /^Lead of the FlyBot group: coordinates FlyBot Dev, FlyBot Test, FlyBot Maint, FlyBot Repo/)
  assert.match(sp(m, chief), /COORDINATOR[\s\S]*- Life Lead[\s\S]*- FlyBot Lead/)
  assert.match(sp(m, team[3]), /Chief → FlyBot Lead → FlyBot Repo/)
  assert.match(warns.join('\n'), /reorganized \(full\): created FlyBot Lead under Chief to lead the FlyBot group/)
  assert.equal(m.bots.size, 1 + 4 + 4 + 2, 'only the two leads were created; nothing deleted')
})

test('#446: a newcomer that fits no group never goes under an unrelated Bot; one that fits joins its lead at once', async () => {
  const { m, tree, chief, kids, children, idOf, over } = await fullChief(3, ['Cooking', 'Shopping', 'Budget'])
  const translator = await m.flybot.bot.create({ name: 'Translator' })
  await tree.settled()
  // Cooking and Shopping (life) make room under a new Life Lead; Translator goes under Chief itself.
  assert.equal(f(m, translator, 'parent'), chief)
  assert.equal(f(m, kids.Budget, 'parent'), chief)
  assert.deepEqual(children(idOf('Life Lead')), ['Cooking', 'Shopping'])
  // An existing lead takes a matching newcomer synchronously, inside the create call.
  const grocery = await m.flybot.bot.create({ name: 'Grocery' })
  assert.equal(f(m, grocery, 'parent'), idOf('Life Lead'))
  assert.deepEqual(over, [])
})

test('#446: a suitable existing Bot becomes the lead (no new Bot); the others move under it', async () => {
  const { m, chief, kids, children, warns } = await fullChief(3, ['Kitchen Manager', 'Shopping', 'Budget'])
  const before = m.bots.size
  // A matching newcomer goes straight to the lead-like Bot of its group, inside the create call.
  const cooking = await m.flybot.bot.create({ name: 'Cooking' })
  assert.equal(f(m, cooking, 'parent'), kids['Kitchen Manager'])
  // An unrelated newcomer at a full level: Shopping (life) joins Kitchen Manager, which frees the slot.
  const translator = await m.flybot.bot.create({ name: 'Translator' })
  assert.equal(f(m, translator, 'parent'), chief, 'placed inside the create call')
  assert.equal(f(m, kids.Shopping, 'parent'), kids['Kitchen Manager'])
  assert.deepEqual(children(chief), ['Kitchen Manager', 'Budget', 'Translator'])
  assert.deepEqual(children(kids['Kitchen Manager']), ['Shopping', 'Cooking'])
  assert.equal(m.bots.size, before + 2, 'no lead Bot was created')
  assert.deepEqual(f(m, kids['Kitchen Manager'], 'lead'), { key: 'domain:life', label: 'Life' })
  assert.match(warns.join('\n'), /made Kitchen Manager the lead of the Life group/)
  assert.match(warns.join('\n'), /moved Shopping from Chief to Kitchen Manager/)
})

test('#446: a duplicate-named Bot joins its namesake instead of becoming a second sibling with that name', async () => {
  const { m, chief, kids, children } = await fullChief(8, ['Editor', 'Travel'])
  const dup = await m.flybot.bot.create({ name: 'editor' })
  assert.equal(f(m, dup, 'parent'), kids.Editor)
  assert.deepEqual(children(chief), ['Editor', 'Travel'])
})

test('#446: freeing a slot moves nobody up by list order; the next new Bot takes it', async () => {
  const { m, tree, chief, kids, children } = await fullChief(3, ['Cooking', 'Shopping', 'Budget'])
  await m.flybot.bot.create({ name: 'Translator' }); await tree.settled()
  const before = Object.fromEntries(Object.values(tree.snapshot()).map(n => [n.id, n.parent]))
  m.removeBot(kids.Budget)
  await tree.ensureRoot(); await tree.settled()
  for (const [id, parent] of Object.entries(before)) if (id !== kids.Budget) assert.equal(f(m, id, 'parent') ?? null, parent)
  assert.deepEqual(children(chief), ['Translator', 'Life Lead'])
  const next = await m.flybot.bot.create({ name: 'Music' })
  assert.equal(f(m, next, 'parent'), chief)
})

test('#446: placement keeps every parent within maxChildren and every Bot within maxDepth, at every step', async () => {
  const { m, tree, chief, over, warns } = await fullChief(4, ['Cooking', 'Budget', 'Novelist'])
  const names = ['FlyBot Dev', 'FlyBot Test', 'FlyBot Repo', 'FlyBot Docs', 'Shopping', 'Grocery', 'Taxes', 'Invoices', 'Translator', 'Poet', 'Tutor', 'Math Coach', 'Recipe Finder', 'Code Reviewer']
  await Promise.all(names.map(name => m.flybot.bot.create({ name })))
  await tree.settled()
  const nodes = tree.snapshot()
  for (const name of names) assert.ok(Object.values(nodes).some(n => n.name === name), `${name} is in the tree`)
  for (const id of Object.keys(nodes)) {
    assert.ok(tree.childrenOf(nodes, id).length <= 4, `${nodes[id].name} within maxChildren`)
    assert.ok(tree.depthOf(nodes, id) <= 5, `${nodes[id].name} within maxDepth`)
  }
  assert.deepEqual(over, [])
  assert.equal(nodes[chief].parent, null)
  assert.doesNotMatch(warns.join('\n'), /left outside/)
  // Every Bot sits under the root, under a lead of a group it belongs to, or (in a full group) under
  // the member of that group closest to its role. Never under an unrelated Bot.
  const { profileOf, keysOf } = await import('../src/roles.js')
  const leadOf = id => f(m, id, 'lead')
  for (const n of Object.values(nodes)) {
    if (n.root || n.parent === chief || leadOf(n.id)) continue
    const keys = keysOf(profileOf({ name: n.name, treeRole: n.role }))
    const lead = leadOf(n.parent) ?? leadOf(nodes[n.parent].parent)
    assert.ok(lead && keys.includes(lead.key), `${n.name} fits the group it is in (${nodes[n.parent].name})`)
  }
  const id = name => Object.values(nodes).find(n => n.name === name).id
  assert.equal(nodes[id('FlyBot Docs')].parent, id('FlyBot Lead'))
  assert.equal(nodes[id('Taxes')].parent, id('Finance Lead'))
  assert.equal(nodes[id('Recipe Finder')].parent, id('Life Lead'))
  assert.equal(nodes[id('Life Lead')].parent, id('Personal Lead')) // life and learning: the personal area
  assert.equal(nodes[id('Code Reviewer')].parent, id('Work Lead'))
})

test('#446: daily tidy groups related Bots, merges duplicates (old one archived, not deleted), marks idle leaves and archives them after 30 days', async () => {
  const DAY = 24 * 60 * 60 * 1000
  let clock = Date.UTC(2026, 9, 19, 12)
  const { m, tree, chief, kids, children, idOf, warns } = await fullChief(8, ['Cooking', 'Shopping', 'Grocery', 'Editor', 'Budget'], { now: () => clock })
  const dup = await m.flybot.bot.create({ name: 'editor' }) // joins its namesake
  assert.equal(f(m, dup, 'parent'), kids.Editor)
  await tree.tidy() // first pass: everyone is new (merge grace), so only the life group forms
  assert.deepEqual(children(chief), ['Editor', 'Budget', 'Life Lead'])
  assert.deepEqual(children(idOf('Life Lead')), ['Cooking', 'Shopping', 'Grocery'])
  assert.equal(f(m, dup, 'archived'), undefined)
  clock += 2 * DAY
  await tree.tidy()
  const rec = f(m, dup, 'archived')
  assert.equal(rec.reason, 'merged'); assert.equal(rec.into, kids.Editor)
  assert.ok(m.bots.has(dup), 'archived, never deleted')
  assert.equal(f(m, dup, 'parent'), undefined); assert.equal(tree.isMember(dup), false)
  assert.doesNotMatch(sp(m, dup), /flybot-tree:start/)
  assert.match(sp(m, kids.Editor), /You took over the role of editor/)
  assert.match(warns.join('\n'), /reorganized \(daily\): merged editor into Editor/)
  // Idle: Budget keeps working, the others do not.
  for (let d = 0; d < 15; d++) { clock += DAY; m.feed('turn.start', { botId: kids.Budget, place: 'chat', sessionId: 's', turnId: 't', turn: 1, time: clock }) }
  await tree.tidy()
  assert.equal(f(m, kids.Editor, 'idle'), clock)
  assert.equal(f(m, kids.Budget, 'idle'), undefined)
  assert.equal(f(m, idOf('Life Lead'), 'idle'), undefined, 'a Bot with children is never idle')
  m.feed('tool.start', { botId: kids.Cooking, place: 'chat', sessionId: 's', turnId: 't', callId: 'c', name: 'web_search', time: clock })
  assert.equal(f(m, kids.Cooking, 'idle'), undefined, 'activity clears idle')
  assert.deepEqual(f(m, kids.Cooking, 'activity').tools, ['web_search'])
  clock += 30 * DAY
  m.feed('turn.start', { botId: kids.Budget, place: 'chat', sessionId: 's', turnId: 't', turn: 2, time: clock })
  await tree.tidy()
  assert.equal(f(m, kids.Editor, 'archived').reason, 'idle')
  assert.ok(m.bots.has(kids.Editor))
  assert.equal(f(m, kids.Budget, 'archived'), undefined)
  assert.equal(f(m, chief, 'archived'), undefined)
  assert.equal(m.bots.size, 1 + 5 + 1 + 1, 'no Bot was deleted')
})

test('#446: the last reorganization is journaled on the root and undone in one click (tree/reorg, tree/undo, tree/dismiss)', async () => {
  const { m, tree, chief, kids, children, idOf } = await fullChief(8, ['Cooking', 'Shopping', 'Grocery', 'Budget'])
  await tree.tidy()
  const lead = idOf('Life Lead')
  const overview = await m.api('tree/reorg')
  const [run] = overview.runs
  assert.equal(run.trigger, 'daily')
  assert.deepEqual(run.summary, ['created Life Lead under Chief to lead the Life group', 'moved Cooking from Chief to Life Lead', 'moved Shopping from Chief to Life Lead', 'moved Grocery from Chief to Life Lead'])
  assert.deepEqual(f(m, chief, 'reorg').runs[0].id, run.id)
  assert.match((await m.api('tree/undo', { runId: 'nope' })).error, /only the last reorganization/)
  const undone = await m.api('tree/undo', { runId: run.id })
  assert.deepEqual(undone.kept, [])
  assert.deepEqual(children(chief), ['Cooking', 'Shopping', 'Grocery', 'Budget'])
  assert.equal(f(m, lead, 'archived').reason, 'undo', 'the lead it made is archived, not deleted')
  assert.ok(m.bots.has(lead))
  assert.ok(f(m, kids.Cooking, 'pinned') > Date.now())
  assert.ok((await m.api('tree/reorg')).runs[0].undone)
  assert.match((await m.api('tree/undo', { runId: run.id })).error, /already undone/)
  assert.doesNotMatch(sp(m, chief), /Last automatic tree reorganization/, 'an undone run is not reported to the Main Bot')
  // Pinned Bots are left alone by the next daily pass.
  await tree.tidy()
  assert.deepEqual(children(chief), ['Cooking', 'Shopping', 'Grocery', 'Budget'])
  assert.deepEqual(await m.api('tree/dismiss', { runId: run.id }), { dismissed: run.id })
  assert.equal((await m.api('tree/reorg')).dismissed, run.id)
})

test('#446: undoing a merge brings the archived Bot back into the tree', async () => {
  const DAY = 24 * 60 * 60 * 1000
  let clock = Date.UTC(2026, 9, 19, 12)
  const { m, tree, kids } = await fullChief(8, ['Editor', 'Travel'], { now: () => clock })
  const dup = await m.flybot.bot.create({ name: 'Editor Bot' }) // same role once "bot" is dropped
  await tree.tidy(); clock += 2 * DAY; await tree.tidy()
  assert.equal(f(m, dup, 'archived').into, kids.Editor)
  const { runs } = tree.overview()
  const r = tree.undo(runs[0].id)
  assert.deepEqual(r.kept, [])
  assert.equal(f(m, dup, 'archived'), undefined)
  assert.ok(tree.isMember(dup))
  assert.deepEqual(f(m, kids.Editor, 'mergedFrom'), [])
})

test('#446: the daily check runs the tidy once a day, starting a day after install', async () => {
  const DAY = 24 * 60 * 60 * 1000
  let clock = Date.UTC(2026, 9, 19, 12)
  const { m, tree, chief, children } = await fullChief(8, ['Cooking', 'Shopping', 'Grocery', 'Budget'], { now: () => clock })
  assert.equal(tree.maybeTidy(), undefined) // first check: only records the time
  assert.equal(f(m, chief, 'reorg').dailyAt, clock)
  clock += DAY - 1
  assert.equal(tree.maybeTidy(), undefined)
  clock += 1
  await tree.maybeTidy()
  assert.deepEqual(children(chief), ['Budget', 'Life Lead'])
  assert.equal(f(m, chief, 'reorg').dailyAt, clock)
})

test('#446: role profiles read name, role label, description and recent tools; duplicates by role', async () => {
  const { profileOf, keysOf, sameRole, canLead } = await import('../src/roles.js')
  const keys = info => keysOf(profileOf(info))
  assert.deepEqual(keys({ name: 'FlyBot Dev' }).slice(0, 2), ['project:flybot', 'domain:dev'])
  assert.ok(keys({ name: 'Shopping', treeRole: 'buys groceries' }).includes('domain:life'))
  assert.ok(keys({ name: '做饭助手' }).includes('domain:life'))
  assert.ok(keys({ name: 'Helper Alpha', tools: ['github_pr', 'bash'] }).includes('domain:dev'), 'recent tools count')
  assert.ok(keys({ name: 'Mystery' }).includes('area:other'))
  assert.equal(sameRole(profileOf({ name: 'Editor' }), profileOf({ name: 'editor bot' })), true)
  assert.equal(sameRole(profileOf({ name: 'Editor', treeRole: 'edits novels' }), profileOf({ name: 'Editor', treeRole: 'video cutting and color grading' })), false)
  assert.equal(sameRole(profileOf({ name: 'Cooking' }), profileOf({ name: 'Shopping' })), false)
  assert.equal(canLead(profileOf({ name: 'Kitchen Manager' }), 'domain:life'), true)
  assert.equal(canLead(profileOf({ name: 'Cooking' }), 'domain:life'), false, 'a plain member is not a lead')
  assert.equal(canLead(profileOf({ name: 'Cooking' }), 'domain:life', { hasChildren: true }), true, 'already coordinating')
  // The classify hook may override the domain (e.g. a model-based classifier later).
  assert.ok(keysOf(profileOf({ name: 'Mystery' }, () => ({ domain: 'finance' }))).includes('domain:finance'))
})

test('#446 client: reorganization notice (what moved, Undo, Dismiss), idle / archived / outside tags; reorgNotice: false hides it', async () => {
  const mod = loadClient()
  const reg = []
  mod.apply({ flybot: { slots: { register: (n) => { reg.push(n); return () => {} } } } }, { reorgNotice: false })
  assert.deepEqual(reg, ['flybot.sidebar.structure'])
  const at = Date.now() - 60_000
  const run = { id: 'r1', at, trigger: 'full', summary: ['created FlyBot Lead under Chief to lead the FlyBot group', 'moved FlyBot Dev from Chief to FlyBot Lead'], actions: [] }
  assert.equal(mod.noticeRun({ runs: [run] }), run)
  assert.equal(mod.noticeRun({ runs: [run], dismissed: 'r1' }), null)
  assert.equal(mod.noticeRun({ runs: [{ ...run, at: at - 8 * 24 * 60 * 60 * 1000 }] }), null, 'older than a week: no notice')
  assert.equal(mod.noticeRun({ runs: [] }), null)
  const undone = []
  const card = reactStub.createElement(mod.ReorgCard, { run, onUndo: () => undone.push('undo'), onDismiss: () => undone.push('dismiss') })
  const html = renderToString(card)
  assert.match(html, /Tree reorganized/)
  assert.match(html, /created FlyBot Lead under Chief to lead the FlyBot group/)
  const buttons = findAll(card, n => n.props.className === 'flybot-reorg-btn')
  assert.deepEqual(buttons.map(b => b.children[0]), ['Undo', 'Dismiss'])
  buttons[0].props.onClick(); buttons[1].props.onClick()
  assert.deepEqual(undone, ['undo', 'dismiss'])
  const after = renderToString(reactStub.createElement(mod.ReorgCard, { run: { ...run, undone: { at, restored: [], kept: ['FlyBot Dev: moved again since'] } } }))
  assert.match(after, /Tree reorganization undone/); assert.doesNotMatch(after, />Undo</); assert.match(after, /Kept: FlyBot Dev: moved again since/)
  const many = renderToString(reactStub.createElement(mod.ReorgCard, { run: { ...run, summary: Array.from({ length: 9 }, (_, i) => `line ${i}`) } }))
  assert.match(many, /and 3 more/)
  // Tags after a Bot's row.
  const tag = own => mod.statusOf({ id: 'x', name: 'X', fields: { 'flybot-tree': own } })
  assert.equal(tag({ parent: 'c', treeRole: '', idle: 5 }), 'idle')
  assert.equal(tag({ archived: { reason: 'merged', intoName: 'Editor' } }), 'archived · merged into Editor')
  assert.equal(tag({ archived: { reason: 'idle' } }), 'archived')
  assert.equal(tag({}), 'outside the tree')
  assert.equal(mod.statusOf({ id: 'c', isMain: true, fields: {} }), null)
  assert.equal(tag({ parent: 'c', treeRole: 'x' }), null)
  const Tag = mod.makeStatusTag(() => new Map([['x', 'idle']]))
  assert.match(renderToString(reactStub.createElement(Tag, { bot: { id: 'x' } })), /class="flybot-tree-tag"[^>]*>idle</)
  assert.equal(renderToString(reactStub.createElement(Tag, { bot: { id: 'y' } })), '')
})

// #452 (owner decision 2026-10-19 22:23): reorg MOVEs / reparents; never renames to 归档- + recreate;
// archived Bots (and leftover 归档-* names) stay out of the default Bot list; repair restores names.
test('#452: reorganization MOVEs bots and never renames any Bot to 归档- / Archive-', async () => {
  const { m, tree, kids } = await fullChief(4, ['Cooking', 'Shopping', 'Garden', 'Travel'])
  const before = new Map([...m.bots.entries()].map(([id, b]) => [id, b.name]))
  for (const name of ['FlyBot Dev', 'FlyBot Test', 'FlyBot Maint', 'FlyBot Repo']) await m.flybot.bot.create({ name })
  await tree.settled()
  for (const [id, name] of before) assert.equal(m.bots.get(id).name, name, `reorg must not rename ${name}`)
  for (const b of m.bots.values()) assert.doesNotMatch(b.name, /^(?:归档|Archive)[-—–]/)
  // Existing life Bots moved under Life Lead; names unchanged.
  for (const id of Object.values(kids)) assert.equal(m.bots.get(id).name, before.get(id))
})

test('#452: archive sets hidden; undo clears it', async () => {
  const DAY = 24 * 60 * 60 * 1000
  let clock = Date.UTC(2026, 9, 19, 12)
  const { m, tree, kids } = await fullChief(8, ['Editor', 'Travel'], { now: () => clock })
  const dup = await m.flybot.bot.create({ name: 'Editor Bot' })
  await tree.tidy(); clock += 2 * DAY; await tree.tidy()
  assert.equal(f(m, dup, 'archived').into, kids.Editor)
  assert.equal(m.bots.get(dup).hidden, true, 'archived Bot is hidden from the default list')
  const { runs } = tree.overview()
  assert.deepEqual(tree.undo(runs[0].id).kept, [])
  assert.equal(f(m, dup, 'archived'), undefined)
  assert.notEqual(m.bots.get(dup).hidden, true, 'undo clears hidden')
})

test('#452: repairArchiveNames restores 归档- when bare name is free; archives+hides when taken', async () => {
  const { m, tree, chief } = await fullChief(8, ['Budget'])
  const alone = m.addBot({ name: '归档-SoloDev', fields: { 'flybot-tree': { parent: chief, treeRole: 'dev' } } })
  const live = m.addBot({ name: 'FlyBot 测试', fields: { 'flybot-tree': { parent: chief, treeRole: 'test' } } })
  const dup = m.addBot({ name: '归档-FlyBot 测试', fields: { 'flybot-tree': { parent: chief, treeRole: 'test' } } })
  await tree.repairArchiveNames()
  assert.equal(m.bots.get(alone).name, 'SoloDev')
  assert.notEqual(m.bots.get(alone).hidden, true)
  assert.equal(m.bots.get(live).name, 'FlyBot 测试')
  assert.equal(f(m, dup, 'archived').reason, 'prefix-duplicate')
  assert.equal(m.bots.get(dup).hidden, true)
  assert.equal(m.bots.get(dup).name, '归档-FlyBot 测试', 'name kept when bare name is taken; Bot is archived+hidden')
})

test('#452 client: structure.include is false for archived and 归档-* names', async () => {
  const mod = loadClient()
  const bots = [
    { id: 'c', name: 'Chief', createdAt: 1, isMain: true, fields: { 'flybot-tree': { parent: null, treeRole: 'root' } } },
    { id: 'live', name: 'FlyBot 开发', createdAt: 2, fields: { 'flybot-tree': { parent: 'c', treeRole: 'dev' } } },
    { id: 'arch', name: 'Old', createdAt: 3, fields: { 'flybot-tree': { archived: { reason: 'idle' } } } },
    { id: 'pref', name: '归档-FlyBot 维护', createdAt: 4, fields: { 'flybot-tree': { parent: 'c', treeRole: 'maint' } } },
  ]
  const entries = []
  const dispose = mod.registerStructure({ slots: { register: (n, e) => { entries.push(e); return () => {} } }, bots: async () => bots })
  await new Promise(r => setTimeout(r, 10))
  const entry = entries.at(-1)
  assert.equal(typeof entry.include, 'function')
  assert.equal(entry.include('live'), true)
  assert.equal(entry.include('arch'), false)
  assert.equal(entry.include('pref'), false)
  assert.equal(entry.include('c'), true)
  dispose()
})

// #447 (owner decisions 2026-10-19 ~19:45 and 21:27 Asia/Shanghai): forward allocation. Reuse before
// create (find_bots, same role anywhere in the branch), create_child_bot(parent?) only in the caller's
// own downstream with limits at the target, project teams as a lead plus children, all on #446's
// shared primitives; orphans are reattached, never left outside for good.
const child = (m, parent, name, role, extra = {}) => m.call(parent, 'create_child_bot', { name, role_description: role, ...extra })
const kidsOf = (m, id) => m.tree.childrenOf(m.tree.snapshot(), id).map(c => c.name)

test('#447: create_child_bot reuses a Bot with the same role at depth 3 instead of a duplicate; find_bots shows name, role, parent, depth', async () => {
  const m = await setup()
  const eng = (await child(m, m.root, 'Engineering', 'Builds and tests the software')).created.id
  const tester = (await child(m, eng, 'Tester', 'Runs the test suite and reports failures')).created.id
  const life = (await child(m, m.root, 'Life', 'Home and family')).created.id
  const before = m.bots.size
  for (const [name, role] of [['Tester', 'Runs the test suite and reports failures'], ['tester bot', 'Runs the test suite']]) {
    const r = await child(m, m.root, name, role)
    assert.equal(r.created, undefined, `${name}: nothing created`)
    assert.equal(r.reused.id, tester)
    assert.equal(r.reused.depth, 3)
    assert.equal(r.reused.path, 'Chief → Engineering → Tester')
    assert.equal(r.reused.via, 'Engineering')
    assert.match(r.note, /already exists: Chief → Engineering → Tester\. Reuse it \(delegate through Engineering\)/)
  }
  assert.equal(m.bots.size, before)
  // find_bots: the root sees the whole tree; a match at depth 3 comes first.
  const found = await m.call(m.root, 'find_bots', { query: 'tester' })
  assert.equal(found.scope, 'the whole tree')
  assert.deepEqual({ ...found.bots[0], role: undefined }, { id: tester, name: 'Tester', role: undefined, depth: 3, path: 'Chief → Engineering → Tester', parent: 'Engineering', children: 0, via: 'Engineering', match: 'same role' })
  assert.equal(found.bots[0].role, 'Runs the test suite and reports failures')
  assert.ok((await m.call(m.root, 'find_bots', { query: 'test' })).bots.some(b => b.id === tester), 'a stem of a role word matches')
  const all = await m.call(m.root, 'find_bots', {})
  assert.deepEqual(all.bots.map(b => [b.name, b.depth, b.parent]), [['Engineering', 2, 'Chief'], ['Life', 2, 'Chief'], ['Tester', 3, 'Engineering']])
  assert.deepEqual(all.limits, { maxDepth: 5, maxChildren: 8 })
  // A Bot sees and reuses only its own downstream.
  const mine = await m.call(life, 'find_bots', { query: 'tester' })
  assert.equal(mine.scope, 'the branch under Life')
  assert.deepEqual(mine.bots, [])
  assert.match((await m.call(life, 'find_bots', { query: 5 })).error, /query must be a string/)
  const own = await child(m, life, 'Tester', 'Runs the test suite and reports failures')
  assert.equal(f(m, own.created.id, 'parent'), life, 'outside its branch: created; the daily tidy merges duplicates')
  // A different role with the same name is not a match.
  assert.ok((await child(m, m.root, 'Tester', 'Tastes recipes in the kitchen')).created.id)
})

test('#447: create_child_bot with parent accepts only the caller or its descendants; limits are checked at the target parent', async () => {
  const m = await setup({ maxChildren: 3, maxDepth: 3 })
  const alpha = (await child(m, m.root, 'Alpha', 'a')).created.id
  const beta = (await child(m, m.root, 'Beta', 'b')).created.id
  // By name or id, under a descendant.
  const a1 = await child(m, m.root, 'A1', 'one', { parent: 'alpha' })
  assert.equal(f(m, a1.created.id, 'parent'), alpha)
  assert.deepEqual(a1.created.parent, { id: alpha, name: 'Alpha' })
  assert.equal(a1.created.path, 'Chief → Alpha → A1')
  assert.equal(a1.created.depth, 3)
  assert.equal(f(m, (await child(m, m.root, 'A2', 'two', { parent: alpha })).created.id, 'parent'), alpha)
  assert.equal(f(m, (await child(m, alpha, 'A3', 'three', { parent: alpha })).created.id, 'parent'), alpha, 'the caller itself')
  // Not the caller's downstream: a sibling, an ancestor, a stranger, an unknown name. Nothing created.
  const size = m.bots.size
  for (const parent of [beta, 'Beta', m.root, 'Chief', 'Nobody']) assert.match((await child(m, alpha, 'X', 'x', { parent })).error, /parent must be you or one of your descendants/, String(parent))
  const o = await outsider(m)
  assert.match((await child(m, m.root, 'X', 'x', { parent: o })).error, /parent must be you or one of your descendants/)
  assert.equal(m.bots.size, size + 1)
  // Limits at the target, not at the caller (Chief still has room).
  assert.match((await child(m, m.root, 'A4', 'x', { parent: 'Alpha' })).error, /limit reached: Alpha already has 3 children \(maxChildren=3\)/)
  assert.match((await child(m, m.root, 'Deep', 'x', { parent: a1.created.id })).error, /limit reached: a child of A1 would be at depth 4 \(maxDepth=3\)/)
  assert.match((await child(m, m.root, 'a1', 'dup', { parent: 'Alpha' })).error, /already exists under Alpha/)
  // The per-parent lock: parallel creates under one target never pass maxChildren.
  await Promise.all(Array.from({ length: 6 }, (_, i) => child(m, m.root, `B${i}`, `b${i}`, { parent: 'Beta' })))
  assert.equal(kidsOf(m, beta).length, 3)
  assert.equal(kidsOf(m, m.root).length, 2)
})

test('#447: a project with several roles becomes a lead plus children, one slot under Chief; later Bots of the group join its lead', async () => {
  const m = await setup()
  for (const name of ['Cooking', 'Travel']) await make(m, m.root, name)
  const before = m.bots.size
  const roles = ['Dev: writes and fixes the FlyBot code', 'Test: runs the FlyBot test suite', 'Maintenance: keeps FlyBot dependencies and CI healthy', 'Repo: manages FlyBot issues and pull requests']
  const r = await m.call(m.root, 'create_team', { team: 'FlyBot', members: roles })
  assert.equal(r.error, undefined)
  assert.deepEqual(kidsOf(m, m.root), ['Cooking', 'Travel', 'FlyBot Lead'], 'one new slot under Chief')
  const lead = r.team.lead.id
  assert.deepEqual(r.team.lead, { id: lead, name: 'FlyBot Lead', path: 'Chief → FlyBot Lead', created: true })
  assert.deepEqual(kidsOf(m, lead), ['Dev', 'Test', 'Maintenance', 'Repo'])
  assert.equal(m.bots.size, before + 5, 'exactly the lead and its four members')
  assert.deepEqual(f(m, lead, 'lead'), { key: 'project:flybot', label: 'FlyBot' })
  assert.match(f(m, lead, 'treeRole'), /^Lead of the FlyBot group: coordinates Dev, Test, Maintenance, Repo/)
  assert.ok(r.team.members.every(x => x.created))
  assert.match(r.note, /Team: Chief → FlyBot Lead → \{Dev, Test, Maintenance, Repo\}/)
  assert.match(sp(m, r.team.members[3].id), /Chief → FlyBot Lead → Repo/)
  assert.match(sp(m, lead), /COORDINATOR[\s\S]*- Dev: writes and fixes the FlyBot code/)
  assert.deepEqual(m.tree.overview().runs, [], 'a fresh team is a plain create, not a reorganization')
  // A later Bot of the group goes under its lead (no parent given); one that could lead it stays at the caller.
  const docs = await child(m, m.root, 'FlyBot Docs', 'Writes the FlyBot docs')
  assert.equal(docs.created.path, 'Chief → FlyBot Lead → FlyBot Docs')
  assert.equal(f(m, (await child(m, m.root, 'Translator', 'Translates texts')).created.id, 'parent'), m.root)
  // Asking again reuses the lead and the members with the same role; only the new role is created.
  const again = await m.call(m.root, 'create_team', { team: 'FlyBot', members: ['Dev: writes and fixes the FlyBot code', 'Release: ships FlyBot versions'] })
  assert.equal(again.team.lead.id, lead)
  assert.equal(again.team.lead.reused, true)
  assert.deepEqual(again.team.members.map(x => [x.name, Boolean(x.reused), Boolean(x.created)]), [['Dev', true, false], ['Release', false, true]])
  assert.deepEqual(kidsOf(m, m.root), ['Cooking', 'Travel', 'FlyBot Lead', 'Translator'])
  // Chief's prompt states the placement rules and the automatic safety net.
  assert.match(sp(m, m.root), /find_bots[\s\S]*create_team[\s\S]*6 or more of your 8 children[\s\S]*automatic reorganization/)
  // Bad input.
  assert.match((await m.call(m.root, 'create_team', { team: 'X', members: ['Solo: alone'] })).error, /at least 2 members/)
  assert.match((await m.call(m.root, 'create_team', { team: 'X', members: 'Dev: x' })).error, /members must be a list/)
  assert.match((await m.call(m.root, 'create_team', { team: 'X', members: ['Dev', 'Test: t'] })).error, /"Name: role"/)
  assert.match((await m.call(m.root, 'create_team', { team: 'x'.repeat(36), members: ['A: a', 'B: b'] })).error, /team must be at most 35/)
  assert.match((await m.call(Object.values(m.tree.snapshot()).find(n => n.name === 'Cooking').id, 'create_team', { team: 'X', members: ['A: a', 'B: b'], parent: lead })).error, /parent must be you or one of your descendants/)
})

test('#447: a team at a full level takes the slot of a flat member it reuses; the move is journaled and undoable; no room is refused', async () => {
  const m = await setup({ maxChildren: 3 })
  for (const name of ['Cooking', 'Travel']) await make(m, m.root, name)
  const dev = (await child(m, m.root, 'Dev', 'writes and fixes the FlyBot code')).created.id
  assert.match((await m.call(m.root, 'create_team', { team: 'Garden', members: ['Planter: plants', 'Waterer: waters'] })).error, /limit reached: Chief already has 3 children[\s\S]*regroups this level by role on its own/)
  const r = await m.call(m.root, 'create_team', { team: 'FlyBot', members: ['Dev: writes and fixes the FlyBot code', 'Test: runs the FlyBot test suite'] })
  assert.equal(r.error, undefined)
  assert.deepEqual(kidsOf(m, m.root), ['Cooking', 'Travel', 'FlyBot Lead'])
  assert.deepEqual(kidsOf(m, r.team.lead.id), ['Dev', 'Test'])
  assert.deepEqual(r.team.members.map(x => [x.name, Boolean(x.reused), Boolean(x.moved)]), [['Dev', true, true], ['Test', false, false]])
  const run = m.tree.overview().runs[0]
  assert.equal(run.trigger, 'team')
  assert.deepEqual(run.summary, ['created FlyBot Lead under Chief to lead the FlyBot group', 'moved Dev from Chief to FlyBot Lead', 'placed new Test under FlyBot Lead'])
  // Undo puts Dev back once Chief has room again; the lead keeps leading Test.
  m.removeBot(Object.values(m.tree.snapshot()).find(n => n.name === 'Travel').id)
  const u = await m.api('tree/undo', { runId: run.id })
  assert.ok(u.restored.includes('Dev back under Chief'))
  assert.equal(f(m, dev, 'parent'), m.root)
  assert.ok(u.kept.some(k => /FlyBot Lead: still leads Test/.test(k)))
})

test('#447: an orphan (its parent gone) is reattached by role, never left outside for good', async () => {
  const m = await setup()
  const team = await m.call(m.root, 'create_team', { team: 'FlyBot', members: ['Dev: writes the FlyBot code', 'Test: runs the FlyBot tests'] })
  const scoped = m.flybot.scope('flybot-tree')
  const qa = await scoped.bot.create({ name: 'FlyBot QA', fields: { parent: 'gone', treeRole: 'Checks FlyBot releases' } })
  const plain = await scoped.bot.create({ name: 'Poet', fields: { parent: 'gone-too', treeRole: 'Writes poems' } })
  await m.tree.ensureRoot(); await m.tree.settled()
  assert.equal(f(m, qa, 'parent'), team.team.lead.id, 'into the lead of its group')
  assert.equal(f(m, plain, 'parent'), m.root, 'else under the root')
  const lines = m.tree.overview().runs.flatMap(r => r.summary)
  assert.ok(lines.includes('moved FlyBot QA from a removed Bot to FlyBot Lead'), 'journaled (undoable)')
  assert.ok(lines.includes('moved Poet from a removed Bot to Chief'))
  assert.match(sp(m, qa), /Chief → FlyBot Lead → FlyBot QA/)
})

test('#447: without parent, a new Bot goes only down leads of groups it belongs to', async () => {
  const m = await setup()
  const team = await m.call(m.root, 'create_team', { team: 'FlyBot', members: ['Dev: writes the FlyBot code', 'Test: runs the FlyBot tests'] })
  const quality = (await child(m, m.root, 'Code Quality', 'reviews code and lint', { parent: 'FlyBot Lead' })).created.id
  m.flybot.scope('flybot-tree').fields.set(quality, 'lead', { key: 'domain:dev', label: 'Dev' })
  // A dev Bot that is not FlyBot's does not end up inside FlyBot's dev group.
  assert.equal(f(m, (await child(m, m.root, 'Code Reviewer', 'reviews pull requests')).created.id, 'parent'), m.root)
  // A FlyBot Bot goes under the FlyBot lead (the project group first).
  assert.equal(f(m, (await child(m, m.root, 'FlyBot Linter', 'lints FlyBot code')).created.id, 'parent'), team.team.lead.id)
  // Asked from inside FlyBot Lead, its dev group takes a dev Bot.
  assert.equal(f(m, (await child(m, team.team.lead.id, 'Style Checker', 'checks code style')).created.id, 'parent'), quality)
})

test('#507: a child\'s running turns show as load in the coordinator\'s stored prompt and list_children', async () => {
  const m = await setup()
  const work = await make(m, m.root, 'Work')
  m.feed('turn.start', { botId: work, place: 'chat', sessionId: 's', turnId: 't1', turn: 1, time: 1 })
  m.feed('turn.start', { botId: work, place: 'chat', sessionId: 's', turnId: 't2', turn: 2, time: 2 })
  // The coordinator's prompt is rewritten at the child's turn boundary, not only read live.
  assert.match(sp(m, m.root), /Child load right now — Work: busy \(2 running\)/)
  assert.deepEqual((await m.call(m.root, 'list_children')).children.map(c => [c.name, c.load]), [['Work', 2]])
  m.feed('turn.end', { botId: work, place: 'chat', sessionId: 's', turnId: 't1', turn: 1, time: 3 })
  m.feed('turn.end', { botId: work, place: 'chat', sessionId: 's', turnId: 't2', turn: 2, time: 4 })
  assert.equal(m.tree.loadOf(work), 0)
  assert.match(sp(m, m.root), /Child load right now — Work: idle/)
})
