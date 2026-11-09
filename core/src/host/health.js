// GET /api/health (#2128, P-392): the one answer the instance gives without a session, so
// "does this process run the build I just published?" is asked of the service instead of
// counted from startup banners. It is an exact WebServer route — the web server matches an
// exact path before the /api prefix whose admission is the sign-in wall — and the four fields
// are the whole contract: no environment, path, host name or dependency version.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HEALTH_PATH = '/api/health'

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
// The package root (`core/` in the repository, the installed directory otherwise), and the
// directory a clone puts it in.
const PKG_ROOT = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)))

/**
 * HEAD of the clone this package sits in, or null for a package/path install.
 * Only the one directory that holds the package is asked: a path install lives at
 * `<project>/node_modules/ds-bot`, and climbing to `<project>` would report the user's own
 * checkout as this package's commit, against the `commit: null` promise in core-host.md.
 */
export function readCommit(start = dirname(PKG_ROOT)) {
  if (!existsSync(join(start, '.git'))) return null
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: start, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch {
    // `git` may not exist on this machine, and a .git that is not a repository is no checkout.
    return null
  }
}

/** The moment this process started, from its own uptime: stable while it runs, new after a restart. */
export function startedAtOf(now = Date.now(), uptimeMs = process.uptime() * 1000) {
  return new Date(now - uptimeMs).toISOString()
}

/** Exactly the four fields, whatever the caller passes in. */
export function healthPayload({ version = PKG.version, commit = readCommit(), startedAt = startedAtOf() } = {}) {
  // JSON.stringify drops an undefined value silently, and a missing `version` key breaks the
  // four-key contract the tests and the issue hold to, so a bad input answers a readable value.
  const name = typeof version === 'string' ? version.trim() : ''
  return { ok: true, version: name || 'unknown', commit, startedAt }
}

export function install(rt) {
  const { ctx } = rt
  // The connection service owns the Host/Origin fence. Reading the decision from it keeps one
  // implementation: the same loopback/bind/trusted-Host and Origin rules every /api path gets.
  const connection = ctx.get?.('connection')
  const attach = sub => {
    if (sub?.webServer === undefined || connection === undefined) return
    // Built here, not in install(): a composition with no web server registers no route and must
    // not pay for a `git` call on behalf of one.
    const payload = healthPayload()
    const route = {
      kind: 'exact',
      path: HEALTH_PATH,
      handler: (req, res) => {
        // An exact route is matched before the /api prefix, so the wall's own admission never
        // runs for it. Keep its first half: a request whose Host is not loopback, the bind
        // address or a trusted authority (or whose Origin is foreign) is refused, exactly as
        // the wall refuses it. Only the session half — the 401 — is skipped. The fence is read
        // as a hard member of the service, the way `admit()` reads it, and its answer is used as
        // it comes instead of compared with the one code seen so far: a refusal this route does
        // not know (a newer status, or the 400 a connection answers for a request it cannot
        // read) is written with that code, and an answer that is not a status throws into the
        // web server's 400 arm — never a health answer without the wall's verdict.
        const rejection = connection.requestRejection(req)
        if (rejection !== undefined && rejection !== 401) {
          if (!Number.isInteger(rejection) || rejection < 400 || rejection > 599) {
            throw new Error(`connection answered a rejection that is not an HTTP status: ${String(rejection)}`)
          }
          res.writeHead(rejection)
          res.end(rejection === 403 ? 'forbidden' : undefined)
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        }
        const body = JSON.stringify(payload)
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        res.end(body)
      },
    }
    sub.effect(() => sub.webServer.register(route), 'ds-bot: /api/health route')
  }
  // No `webServer` outside the Web composition (Electron serves files over IPC): then the
  // endpoint simply does not exist, and nothing else changes.
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], attach)
  else if (ctx.get?.('webServer') !== undefined) attach({ webServer: ctx.get('webServer'), effect: (execute, label) => ctx.effect(execute, label) })
}
