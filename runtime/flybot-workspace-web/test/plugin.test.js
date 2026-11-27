import { COMPUTER_PATH } from '../src/computer.js'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, name, inject } from '../index.js'
import { createPageHandler, resolvePagePath, writeChatAssetManifest, PAGE_PATH, SERVED_BY_HEADER } from '../src/pages.js'
import { API_PATH, GATEWAY_PATH, LEGACY_PATH, REPLY_STREAM_PATH } from '../src/dispatch.js'
import { loadIdentity } from '../src/identity.js'

function fakeCtx() {
  const routes = new Map()
  const effects = []
  return {
    routes,
    effects,
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => routes.delete(route.path) } } },
    effect(fn, label) { effects.push(label); fn() },
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ot-web-'))
  const pages = join(root, 'pages')
  mkdirSync(join(pages, 'chat'), { recursive: true })
  mkdirSync(join(pages, 'home'), { recursive: true })
  mkdirSync(join(pages, 'shell'), { recursive: true })
  writeFileSync(join(pages, 'chat', 'index.html'), '<!doctype html><html><head><title>Chat</title></head><body>chat</body></html>')
  writeFileSync(join(pages, 'home', 'index.html'), '<html><head></head><body>home</body></html>')
  writeFileSync(join(pages, 'shell', 'app.css'), 'body{}')
  mkdirSync(join(pages, 'settings'), { recursive: true })
  writeFileSync(join(pages, 'settings', 'index.html'), '<html><head></head><body>settings</body></html>')
  writeFileSync(join(root, 'secret.txt'), 'outside')
  symlinkSync(join(root, 'secret.txt'), join(pages, 'shell', 'leak.txt'))
  const data = join(root, 'data')
  mkdirSync(data)
  return { root, pages, data }
}

const get = (route, path, headers) => route.fetch(new Request(`http://10.0.0.2:8080${PAGE_PATH}?path=${encodeURIComponent(path)}`, {headers}))
const post = (route, body) => route.fetch(new Request(`http://10.0.0.2:8080${API_PATH}`, { method: 'POST', body: JSON.stringify(body) }))

test('plugin identifies itself and only asks DSH for the connection service', () => {
  assert.equal(name, 'flybot-workspace-web')
  assert.deepEqual(inject, ['connection'])
})

test('registers exact authenticated routes on the shared /api channel', () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  apply(ctx, { pagesDir: pages, dataDir: data })
  assert.deepEqual([...ctx.routes.keys()].sort(), [API_PATH, COMPUTER_PATH, GATEWAY_PATH, LEGACY_PATH, PAGE_PATH, REPLY_STREAM_PATH].sort())
  assert.deepEqual(ctx.routes.get(PAGE_PATH).methods, ['GET'])
  assert.deepEqual(ctx.routes.get(API_PATH).methods, ['POST'])
  assert.deepEqual(ctx.routes.get(COMPUTER_PATH).methods, ['GET', 'POST', 'DELETE'])
  assert.deepEqual(ctx.routes.get(REPLY_STREAM_PATH).methods, ['GET'])
  assert.deepEqual(ctx.routes.get(GATEWAY_PATH).methods, ['GET', 'POST'])
  assert.deepEqual(ctx.routes.get(LEGACY_PATH).methods, ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'])
  for (const path of ctx.routes.keys()) assert.ok(path.startsWith('/api/'), 'DSH authenticates /api only')
})

test('serves pages from this runtime, marked with this runtime identity', async () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  const { identity } = apply(ctx, { pagesDir: pages, dataDir: data })
  const route = ctx.routes.get(PAGE_PATH)
  const chat = await get(route, '/chat/')
  assert.equal(chat.status, 200)
  assert.match(chat.headers.get('content-type'), /text\/html/)
  assert.equal(chat.headers.get(SERVED_BY_HEADER), `ds-bot; instance=${identity.instanceId}`)
  const html = await chat.text()
  assert.match(html, new RegExp(`<meta name="flybot-workspace-instance" content="${identity.instanceId}">`))
  assert.match(html, /<head><meta name="flybot-workspace-served-by" content="ds-bot">/)
  assert.equal((await get(route, '/')).status, 200)
  const css = await get(route, '/shell/app.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /text\/css/)
})

test('legacy Messenger entry resolves to the native Chat inbox', async () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  apply(ctx, { pagesDir: pages, dataDir: data })
  const route = ctx.routes.get(PAGE_PATH)
  for (const path of ['/messenger', '/messenger/', '/messenger/index.html']) {
    const response = await get(route, path)
    assert.equal(response.status, 302, path)
    assert.equal(response.headers.get('location'), '/chat')
    assert.equal(await response.text(), '')
  }
  assert.equal((await get(route, '/messenger/app.mjs')).status, 404)
})

test('authenticated package assets revalidate against their actual bytes; personalised pages do not', async () => {
  const {pages, data} = fixture()
  const ctx = fakeCtx()
  apply(ctx, {pagesDir: pages, dataDir: data})
  const route = ctx.routes.get(PAGE_PATH)
  const path = '/shell/app.css'
  const first = await get(route, path)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('cache-control'), 'private, no-cache')
  assert.equal(await first.text(), 'body{}')
  const etag = first.headers.get('etag')
  assert.match(etag, /^"sha256-[0-9a-f]{64}"$/)
  const unchanged = await get(route, path, {'If-None-Match': '"older", W/' + etag})
  assert.equal(unchanged.status, 304)
  assert.equal(unchanged.headers.get('etag'), etag)
  assert.equal(await unchanged.text(), '')
  writeFileSync(join(pages, path.slice(1)), 'body{margin:0}')
  const changed = await get(route, path, {'If-None-Match': etag})
  assert.equal(changed.status, 200)
  assert.notEqual(changed.headers.get('etag'), etag)
  assert.equal(await changed.text(), 'body{margin:0}')
  const page = await get(route, '/chat', {'If-None-Match': '*'})
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.has('etag'), false)
})

test('Chat versions its static dependency graph, keeps HTML private, and never caches newer bytes under an old URL', async () => {
  const {pages, data} = fixture()
  const css = join(pages, 'shell', 'app.css')
  writeFileSync(join(pages, 'chat', 'index.html'), `<html><head>
    <link rel="stylesheet" href="/shell/app.css">
    <script type="module" src="/chat/app.mjs"></script>
  </head><body><a href="/chat">Chat</a></body></html>`)
  writeFileSync(join(pages, 'chat', 'app.mjs'), "import '../shell/utility.mjs'")
  const dependencyFile = join(pages, 'shell', 'utility.mjs')
  writeFileSync(dependencyFile, 'export const item = 1')
  const mountPages = () => {
    const ctx = fakeCtx()
    apply(ctx, {pagesDir: pages, dataDir: data})
    return ctx.routes.get(PAGE_PATH)
  }
  const route = mountPages()
  const doc = await get(route, '/chat')
  assert.equal(doc.headers.get('cache-control'), 'no-store')
  const html = await doc.text()
  const entry = /src="(\/chat\/assets\/[a-f0-9]{32}\/chat\/app\.mjs)"/.exec(html)?.[1]
  assert.ok(entry)
  const base = entry.slice(0, -'/chat/app.mjs'.length)
  assert.ok(html.includes(`href="${base}/shell/app.css"`))
  assert.ok(html.includes('<a href="/chat">'))
  const dep = base + '/shell/utility.mjs'
  const versioned = await get(route, dep)
  assert.equal(await versioned.text(), 'export const item = 1')
  assert.match(versioned.headers.get('cache-control'), /^private, max-age=31536000, immutable$/)
  assert.equal((await get(route, dep, {'If-None-Match': versioned.headers.get('etag')})).status, 304)
  assert.equal((await get(route, base + '/shell/leak.txt')).status, 404)
  assert.equal((await get(route, base + '/chat/index.html')).status, 404)

  writeFileSync(css, 'body{margin:0}')
  writeFileSync(dependencyFile, 'export const item = 2')
  const after = mountPages()
  const rewritten = await (await get(after, '/chat')).text()
  const revisedEntry = /src="(\/chat\/assets\/[a-f0-9]{32}\/chat\/app\.mjs)"/.exec(rewritten)?.[1]
  assert.ok(revisedEntry)
  assert.notEqual(revisedEntry, entry)
  const changed = await get(after, dep)
  assert.equal(changed.status, 302)
  assert.equal(changed.headers.get('cache-control'), 'no-store')
  const current = await get(after, changed.headers.get('location'))
  assert.equal(await current.text(), 'export const item = 2')
})

test('native pages and their module dependencies are served from one versioned package', async () => {
  const pagesDir = fileURLToPath(new URL('../../../flybot_workspace/static/', import.meta.url))
  const route = {fetch: createPageHandler({pagesDir, identity:{instanceId:'page-modules'}})}
  const modules = new Set()
  let base
  for (const path of ['/agents', '/artifacts', '/automations', '/chat', '/contacts', '/discover',
    '/meetings', '/members', '/memory', '/onboarding', '/profile', '/settings/connectors', '/skills', '/team', '/team-runs']) {
    const page = await get(route, path)
    assert.equal(page.status, 200, path)
    assert.equal(page.headers.get(SERVED_BY_HEADER), 'ds-bot; instance=page-modules')
    const html = await page.text()
    if (path === '/chat') {
      const startup = /<script type="module" async>([\s\S]*?)<\/script>/.exec(html)?.[1]
      assert.ok(startup?.startsWith('export function chatStartFromHash'))
      const hash = createHash('sha256').update(startup).digest('base64')
      assert.equal(page.headers.get('content-security-policy'), `script-src 'self' 'sha256-${hash}'`)
      assert.doesNotMatch(html, /<script[^>]+src="[^"]*\/chat\/startup\.mjs"/)
    }
    const stylesheet = /href="(\/chat\/assets\/[a-f0-9]{32})\/shell\/app\.css"/.exec(html)?.[1]
    assert.ok(stylesheet, path + ' uses the runtime shell stylesheet')
    base ??= stylesheet
    assert.equal(stylesheet, base, path)
    for (const [, asset] of html.matchAll(/(?:href|src)="(\/[^"]+\.mjs)"/g)) modules.add(asset)
  }
  for (const module of ['dsbot.mjs', 'files.mjs', 'translation.mjs']) {
    assert.ok(modules.has(base + '/chat/' + module), 'Missing Chat preload for ' + module)
  }

  // Follow shipped imports, including literal paths passed to Chat's deferred loader.
  const origin = 'https://runtime.test'
  for (const path of modules) {
    assert.ok(path.startsWith(base + '/'), 'Native module escaped its package: ' + path)
    const response = await get(route, path)
    assert.equal(response.status, 200, path)
    assert.match(response.headers.get('content-type'), /^text\/javascript/, path)
    assert.match(response.headers.get('cache-control'), /immutable$/, path)
    const source = await response.text()
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\bdeferModule\s*\(\s*)['"](\.{1,2}\/[^'"]+\.m?js)['"]/g)) {
      modules.add(new URL(specifier, origin + path).pathname)
    }
  }
  const publicPage = await get(route, '/help')
  assert.match(await publicPage.text(), /href="\/shell\/app\.css"/)
})

test('built Chat pages can open before an optional dependency is read', async t => {
  const {root, pages} = fixture()
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const file = join(pages, 'shell', 'viewer.mjs')
  const script = 'export const view = 1'
  writeFileSync(join(pages, 'chat', 'index.html'), '<head><link rel="stylesheet" href="/shell/app.css"></head>')
  writeFileSync(file, script)
  const mount = () => ({fetch: createPageHandler({pagesDir: pages, identity: {instanceId: 'test'}})})
  const original = await (await get(mount(), '/chat')).text()
  const base = /href="(\/chat\/assets\/[a-f0-9]{32})\/shell\//.exec(original)[1]
  await writeChatAssetManifest(pages)
  rmSync(file)

  const built = mount()
  const doc = await get(built, '/chat')
  assert.equal(doc.status, 200)
  assert.equal(await doc.text(), original)
  assert.equal(await (await get(built, base + '/shell/app.css')).text(), 'body{}')
  assert.equal((await get(built, '/.chat-assets-v1.json')).status, 404)
  assert.equal((await get(built, base + '/shell/viewer.mjs')).status, 404)
  writeFileSync(file, 'export const view = 2')
  const changed = await get(built, base + '/shell/viewer.mjs')
  assert.equal(changed.status, 404)
  assert.equal(changed.headers.get('cache-control'), 'no-store')
  writeFileSync(file, script)
  const restored = await get(built, base + '/shell/viewer.mjs')
  assert.equal(await restored.text(), script)
  assert.match(restored.headers.get('cache-control'), /immutable$/)

  writeFileSync(join(pages, '.chat-assets-v1.json'), '[["/../secret.txt","invalid"]]')
  assert.equal(await (await get(mount(), '/chat')).text(), original)
})

test('refuses traversal, symlink escape, hidden and unknown files', async () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  apply(ctx, { pagesDir: pages, dataDir: data })
  const route = ctx.routes.get(PAGE_PATH)
  for (const bad of ['', 'chat/', '/../secret.txt', '/chat/../../secret.txt', '/shell/leak.txt', '/.git/', '/chat/%2e%2e/', '/chat//', '/chat/x.exe', '/nope/']) {
    assert.equal((await get(route, bad)).status, 404, bad)
  }
  assert.equal(resolvePagePath('/a\\b/'), null)
  assert.equal(resolvePagePath('/' + 'a'.repeat(300) + '/'), null)
})

test('extensionless settings subpaths serve the settings page, not 404', async () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  apply(ctx, { pagesDir: pages, dataDir: data })
  const route = ctx.routes.get(PAGE_PATH)
  for (const path of ['/settings', '/settings/', '/settings/connectors', '/settings/language']) {
    const response = await get(route, path)
    assert.equal(response.status, 200, path)
    assert.match(await response.text(), /settings/)
  }
  assert.deepEqual(resolvePagePath('/settings/connectors'), ['settings', 'index.html'])
  assert.deepEqual(resolvePagePath('/settings'), ['settings', 'index.html'])
  assert.deepEqual(resolvePagePath('/chat/app.mjs'), ['chat', 'app.mjs'])
  assert.equal(resolvePagePath('/settings/x.exe'), null)
  assert.equal((await get(route, '/settings/missing-asset.css')).status, 404)
})

test('dispatch answers shell/identity and rejects unknown endpoints', async () => {
  const { pages, data } = fixture()
  const ctx = fakeCtx()
  const { identity } = apply(ctx, { pagesDir: pages, dataDir: data })
  const route = ctx.routes.get(API_PATH)
  const ok = await (await post(route, { endpoint: 'shell/identity' })).json()
  assert.equal(ok.ok, true)
  assert.equal(ok.value.served_by, 'ds-bot')
  assert.equal(ok.value.instance_id, identity.instanceId)
  const missing = await (await post(route, { endpoint: 'constructor' })).json()
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'flybot-workspace/not-found')
  const bad = await (await route.fetch(new Request('http://x/api/flybot-workspace', { method: 'POST', body: 'nope' }))).json()
  assert.equal(bad.error.code, 'flybot-workspace/invalid')
})

test('identity: manager id wins, otherwise one stable random id per volume', () => {
  const { data } = fixture()
  const manager = 'a'.repeat(32)
  assert.deepEqual({ ...loadIdentity({ env: { FLYBOT_WORKSPACE_INSTANCE_ID: manager }, dataDir: data }) }, { instanceId: manager, source: 'manager' })
  const first = loadIdentity({ env: { FLYBOT_WORKSPACE_INSTANCE_ID: 'not-hex' }, dataDir: data })
  const again = loadIdentity({ env: {}, dataDir: data })
  assert.equal(first.instanceId, again.instanceId)
  assert.match(first.instanceId, /^[0-9a-f]{32}$/)
  assert.equal(JSON.parse(readFileSync(join(data, 'flybot-workspace', 'instance.json'), 'utf8')).instance_id, first.instanceId)
  const other = fixture()
  assert.notEqual(loadIdentity({ env: {}, dataDir: other.data }).instanceId, first.instanceId)
})

test('missing pages bundle answers 404, never an error page from elsewhere', async () => {
  const { root, data } = fixture()
  const ctx = fakeCtx()
  apply(ctx, { pagesDir: join(root, 'absent'), dataDir: data })
  assert.equal((await get(ctx.routes.get(PAGE_PATH), '/chat/')).status, 404)
})
