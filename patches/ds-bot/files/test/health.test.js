// GET /api/health (#2128, P-392) must answer without credentials: the instance cannot be
// checked from outside today, because the sign-in wall answers 401 for every /api request.
// The route is an exact WebServer route, which the web server matches before the /api prefix
// that owns the wall, and its whole contract is the four fields.
//
// The doubles below mirror the shipped host packages rather than a guess, and no dependency is
// added for them: `@deepseek-ai/dsh-host-webserver@0.2.1-rc.2` `lib/index.js` `:381` builds the
// path with `new URL(req.url ?? "/", "http://x").pathname` and `:494-504` matches the exact table
// before the longest prefix. The Host/Origin half belongs to the connection service:
// `@deepseek-ai/dsh-client-connection@0.2.1-rc.2` `lib/index.js` `:742-749` answers 403 for an
// untrusted authority and only then 401 for a missing session, `:777-779` is `isTrusted`, and
// `:862-865` / `:1049-1052` write those refusals (403 → `forbidden`, 401 → `unauthorized`).
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeContext } from './fake-ctx.js'
import { HEALTH_PATH, healthPayload, install, readCommit, startedAtOf } from '../src/host/health.js'

const FIELDS = ['commit', 'ok', 'startedAt', 'version']
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const CORE_ROOT = fileURLToPath(new URL('..', import.meta.url))
// What a local probe sends: the listener on loopback, with no browser markers.
const LOOPBACK = { host: '127.0.0.1:3080' }
const TRUSTED_HOSTS = ['monitor.example']

// The fence from isTrustedApiRequest(): the Host must be loopback, the bind address or one
// configured authority, and a cross-site marker or a foreign Origin is refused even then.
function isLoopbackName(name) {
  const bare = name.replace(/^\[|\]$/g, '')
  return bare === 'localhost' || bare === '::1' || /^127(?:\.\d{1,3}){3}$/.test(bare)
}

function isTrusted(req, { trustedHosts = TRUSTED_HOSTS, bindHost = '127.0.0.1' } = {}) {
  const host = req.headers.host
  if (host === undefined) return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackName(hostUrl.hostname) && !trustedHosts.includes(hostUrl.hostname) && hostUrl.hostname !== bindHost) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

// The two tables @deepseek-ai/dsh-host-webserver keeps: an exact path wins over a prefix, and
// among prefixes the longest wins. Registration duplicates throw, as they do there.
function webServer() {
  const exact = new Map()
  const prefixes = new Map()
  return {
    exact,
    prefixes,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`webserver: route ${route.kind} ${route.path} is already registered`)
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
  }
}

// The connection service the route reads its fence from: 403 for an untrusted authority, then
// 401 for a request with no session — the order admit() uses.
function connection(options = {}) {
  return { requestRejection: req => (isTrusted(req, options) ? 401 : 403) }
}

// The sign-in wall the connection plugin mounts as the /api prefix: the fence first, then a
// browser session before any handler sees it.
function signInWall(options = {}) {
  return {
    kind: 'prefix',
    path: '/api',
    handler: (req, res) => {
      if (!isTrusted(req, options)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.headers.cookie === undefined) {
        res.writeHead(401)
        res.end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ signedIn: true }))
    },
  }
}

async function serve(route, { method = 'GET', headers = LOOPBACK, path = HEALTH_PATH } = {}) {
  const res = {
    status: undefined,
    headers: {},
    chunks: [],
    writeHead(status, next = {}) {
      this.status = status
      for (const [name, value] of Object.entries(next)) this.headers[name.toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk))
    },
  }
  await route.handler({ method, url: path, headers }, res)
  return { status: res.status, headers: res.headers, body: Buffer.concat(res.chunks).toString('utf8') }
}

// One request through the same order the web server uses, so a test proves where the route sits.
// The path is reduced the way the server reduces it (`new URL(...).pathname`), query and all.
async function request(server, path, { method = 'GET', headers = LOOPBACK } = {}) {
  const pathname = new URL(path, 'http://x').pathname
  const exact = server.exact.get(pathname)
  if (exact !== undefined) return serve(exact, { method, headers, path })
  let best
  for (const route of server.prefixes.values()) {
    if (pathname === route.path || pathname.startsWith(`${route.path}/`)) {
      if (best === undefined || route.path.length > best.path.length) best = route
    }
  }
  if (best === undefined) return { status: 404, headers: {}, body: 'not found' }
  return serve(best, { method, headers, path })
}

// The plugin context cordis gives install(): an injected service scope, or the get() fallback.
function boot({ server, fence = connection(), inject = server !== undefined } = {}) {
  const services = {}
  if (server !== undefined) {
    services.webServer = server
    services.connection = fence
  }
  const ctx = fakeContext({ services })
  if (inject) {
    ctx.inject = (names, attach) => {
      assert.deepEqual(names, ['webServer'])
      attach({ webServer: server, effect: (execute, label) => ctx.effect(execute, label) })
    }
  }
  const rt = { ctx }
  install(rt)
  return { ctx, rt }
}

async function health(server, options = {}) {
  const { status, headers, body } = await request(server, HEALTH_PATH, options)
  return { status, headers, body, json: status === 200 ? JSON.parse(body) : undefined }
}

test('health: GET /api/health answers 200 with exactly four fields, ahead of the sign-in wall', async () => {
  const server = webServer()
  server.register(signInWall())
  boot({ server })

  const { status, headers, json } = await health(server)
  assert.equal(status, 200)
  assert.match(headers['content-type'], /application\/json/)
  assert.deepEqual(Object.keys(json).sort(), FIELDS, 'a fifth field must fail this test')
  assert.equal(json.ok, true)
  assert.equal(json.version, PKG.version)
  assert.ok(typeof json.version === 'string' && json.version.length > 0, 'version is a non-empty string')
  assert.ok(json.commit === null || /^[0-9a-f]{40}$/.test(json.commit), `commit is a 40-hex sha or null, not ${json.commit}`)
  assert.equal(new Date(json.startedAt).toISOString(), json.startedAt, 'startedAt is an ISO timestamp')
})

test('health: the answer is the same while authz is enforced, and needs no credentials', async () => {
  const server = webServer()
  server.register(signInWall())
  const { rt } = boot({ server })
  rt.authzEnforced = () => true

  const first = await health(server)
  const second = await health(server)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.deepEqual(Object.keys(first.json).sort(), FIELDS)
  assert.deepEqual(second.json, first.json, 'two requests in one process agree')
})

test('health: the rest of /api still meets the wall, and a disposed route gives it back', async () => {
  const server = webServer()
  server.register(signInWall())
  const { ctx } = boot({ server })

  for (const path of ['/api/state', '/api/bot', '/api/health/extra']) {
    const { status, body } = await request(server, path)
    assert.equal(status, 401, `${path} is still behind the wall`)
    assert.equal(body, 'unauthorized')
  }
  assert.equal((await request(server, '/')).status, 404)

  await ctx.dispose()
  assert.equal((await request(server, HEALTH_PATH)).status, 401, 'the route went away with the plugin')
})

test('health: the Host/Origin fence decides before either the answer or the method', async () => {
  const server = webServer()
  server.register(signInWall())
  boot({ server })

  const foreign = await health(server, { headers: { host: 'rebind.example:3080' } })
  assert.equal(foreign.status, 403, 'a Host that is neither loopback, the bind address nor trusted is refused')
  assert.equal(foreign.body, 'forbidden')
  assert.equal((await request(server, '/api/state', { headers: { host: 'rebind.example:3080' } })).status, 403, 'and the wall refuses it the same way')

  const crossSite = await health(server, { headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403, 'a cross-site marker is refused even from loopback')
  const foreignOrigin = await health(server, { headers: { ...LOOPBACK, origin: 'http://rebind.example' } })
  assert.equal(foreignOrigin.status, 403, 'an Origin that is not this authority is refused')
  const sameOrigin = await health(server, { headers: { ...LOOPBACK, origin: 'http://127.0.0.1:3080' } })
  assert.equal(sameOrigin.status, 200, 'a same-origin loopback request still answers')

  const noHost = await health(server, { headers: {} })
  assert.equal(noHost.status, 403, 'a request without a Host is not trusted')

  const trusted = await health(server, { headers: { host: 'monitor.example:3080' } })
  assert.equal(trusted.status, 200, 'a configured authority is served without a session, as elsewhere')
  assert.deepEqual(Object.keys(trusted.json).sort(), FIELDS)
  assert.equal((await request(server, '/api/state', { headers: { host: 'monitor.example:3080' } })).status, 401, 'but the rest of /api still wants a session')

  const headFromForeign = await request(server, HEALTH_PATH, { method: 'HEAD', headers: { host: 'rebind.example:3080' } })
  assert.equal(headFromForeign.status, 403, 'the fence runs before the method is read')
})

// The web server's own answer to a handler that throws: `handle(...).catch` logs and, while no
// header went out, writes 400 (`@deepseek-ai/dsh-host-webserver@0.2.1-rc.2` `lib/index.js:248-256`).
// `serve()` calls a handler directly, so this repeats that arm: a route that throws must reach it.
async function serveThroughServer(server, path, { method = 'GET', headers = LOOPBACK } = {}) {
  const res = {
    status: undefined,
    chunks: [],
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk))
    },
  }
  try {
    await server.exact.get(new URL(path, 'http://x').pathname).handler({ method, url: path, headers }, res)
  } catch {
    if (res.status === undefined) {
      res.status = 400
      res.end()
    }
  }
  return { status: res.status, body: Buffer.concat(res.chunks).toString('utf8') }
}

// The fence capability is not optional: a composition that hands the plugin a connection without
// `requestRejection` must not get a health answer, because the answer would have skipped the
// Host/Origin fence every other /api path meets. `admit()` reads the same call as a hard member,
// so a missing one is a server error — 400 from the arm above — and never a 200 (#2129, Security).
test('health: a connection without the fence capability answers 400, not a health answer', async () => {
  const server = webServer()
  server.register(signInWall())
  boot({ server, fence: {} })

  const { status, body } = await serveThroughServer(server, HEALTH_PATH, { headers: { host: 'rebind.example:3080' } })
  assert.equal(status, 400, 'a missing fence capability is a server error, not a request that passed the fence')
  for (const field of FIELDS) assert.doesNotMatch(body, new RegExp(`"${field}"`), `no ${field} leaves without the fence's answer`)

  const loopback = await serveThroughServer(server, HEALTH_PATH)
  assert.equal(loopback.status, 400, 'and a request that would have been trusted is refused the same way')
})

test('health: a method other than GET is not served as health', async () => {
  const server = webServer()
  server.register(signInWall())
  boot({ server })
  const { status, headers } = await health(server, { method: 'POST' })
  assert.equal(status, 405)
  assert.equal(headers.allow, 'GET')
})

test('health: HEAD and OPTIONS get 405 with allow: GET and no body', async () => {
  const server = webServer()
  server.register(signInWall())
  boot({ server })

  for (const method of ['HEAD', 'OPTIONS']) {
    const { status, headers, body } = await request(server, HEALTH_PATH, { method })
    assert.equal(status, 405, `${method} is not GET`)
    assert.equal(headers.allow, 'GET')
    assert.equal(body, '', `${method} carries no payload`)
  }
})

test('health: a query string does not change the route or the answer', async () => {
  const server = webServer()
  server.register(signInWall())
  boot({ server })

  const plain = await health(server)
  const queried = await request(server, `${HEALTH_PATH}?x=1`)
  assert.equal(queried.status, 200, 'the pathname decides, not the query')
  assert.deepEqual(Object.keys(JSON.parse(queried.body)).sort(), FIELDS)
  assert.deepEqual(JSON.parse(queried.body), plain.json)
})

test('health: the payload keeps four fields and a non-empty version whatever it is handed', () => {
  const fromOptions = healthPayload({ version: '9.9.9', commit: null, startedAt: '2026-01-01T00:00:00.000Z', env: 'production', host: 'box' })
  assert.deepEqual(Object.keys(fromOptions).sort(), FIELDS)
  assert.equal(fromOptions.version, '9.9.9')
  assert.deepEqual(Object.keys(healthPayload()).sort(), FIELDS)
  for (const version of ['', '   ', undefined, null, 42]) {
    const payload = healthPayload({ version, commit: null, startedAt: '2026-01-01T00:00:00.000Z' })
    assert.deepEqual(Object.keys(payload).sort(), FIELDS, `version ${JSON.stringify(version)} must not drop the key`)
    assert.ok(typeof payload.version === 'string' && payload.version.trim().length > 0, `version ${JSON.stringify(version)} became ${JSON.stringify(payload.version)}`)
  }
  assert.throws(() => assert.deepEqual(Object.keys({ ...healthPayload(), host: 'box' }).sort(), FIELDS), /Expected values to be strictly deep-equal|host/)
})

test('health: startedAt is the process start, stable in one process and new in the next', async () => {
  const now = Date.now()
  const early = startedAtOf(now, 60_000)
  const late = startedAtOf(now, 1_000)
  assert.notEqual(early, late)
  assert.equal(Date.parse(early), now - 60_000)

  const server = webServer()
  server.register(signInWall())
  boot({ server })
  const a = (await health(server)).json.startedAt
  const b = (await health(server)).json.startedAt
  assert.equal(a, b)
  assert.ok(Math.abs(Date.now() - Date.parse(a)) < 10 * 60_000, 'the process started minutes ago, not at request time')
})

test('health: commit is the checkout HEAD inside a git clone and null without one', t => {
  const repoRoot = dirname(CORE_ROOT)
  let expected
  let gitError
  try {
    expected = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
  } catch (error) {
    gitError = error
    expected = undefined
  }
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-health-'))
  try {
    assert.equal(readCommit(home), null, 'no .git above the module means no commit')
    // `ok` here would claim the checkout half ran when it did not (#2702): skip instead, naming
    // which half of the environment is missing, so the suite's skipped count carries the gap.
    if (expected === undefined) {
      t.skip(gitError?.code === 'ENOENT'
        ? 'git is not available here; the checkout half of this test did not run'
        : 'git cannot name the HEAD of this copy; the checkout half of this test did not run')
      return
    }
    assert.equal(readCommit(repoRoot), expected)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("health: commit is null when the package sits in someone else's checkout", t => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-health-'))
  try {
    const project = join(home, 'project')
    const nodeModules = join(project, 'node_modules')
    const installed = join(nodeModules, 'ds-bot')
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), '{"name":"ds-bot","version":"0.0.0"}\n')
    let head
    try {
      execFileSync('git', ['init', '-q', project])
      execFileSync('git', ['-C', project, 'config', 'user.email', 'dev1@flybot.local'])
      execFileSync('git', ['-C', project, 'config', 'user.name', 'Dev-1'])
      writeFileSync(join(project, 'README.md'), "the user's project\n")
      execFileSync('git', ['-C', project, 'add', '.'])
      execFileSync('git', ['-C', project, 'commit', '-qm', 'project'])
      head = execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    } catch {
      t.diagnostic('git is not available here; the nested-checkout half is skipped')
      return
    }
    assert.equal(readCommit(nodeModules), null, `the project's HEAD ${head} at the layer above node_modules is not this package's commit`)
    assert.equal(readCommit(project), head, 'the directory a checkout put core/ in is still read')
    assert.equal(readCommit(installed), null, 'the package directory itself is not a checkout')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('health: install without a web server registers nothing and does not throw', () => {
  const { ctx } = boot({ server: undefined })
  assert.equal(ctx.calls.filter(call => call.startsWith('effect')).length, 0)
})
