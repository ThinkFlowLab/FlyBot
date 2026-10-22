// Which Bot Social server this FlyBot talks to, changeable from Settings (#337).
//
// The profile patch (`flybot-social` config.server) stays the default and the fallback. A server the
// owner picks in Settings is kept in `flybot-social-server.json` next to the credentials file and wins
// while it exists. A server is an identity: every server has its own credentials file (the default
// server's stays where it always was; another server's gets the `.<tag>` suffix startSocial already
// used for backups), its own settings file, and its own member identities, grants and Auto-send marks
// on the local Bots (parked in `flybot-social-bots.<tag>.json` while another server is active).
// Nothing here deletes a credentials file, and nothing here reads, returns or logs a token.
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { socialFetch } from './mcp-client.js'

export const serverKey = url => String(url ?? '').trim().replace(/\/+$/, '').toLowerCase()
export const serverTag = key => createHash('sha256').update(serverKey(key)).digest('hex').slice(0, 8)

const refused = (message, code = 'bad_server') => Object.assign(new Error(message), { code: 'bot/refused', reason: code })
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const MAX_URL = 200
const PROBE_MS = 8_000
const START_MS = 45_000

// "https://social.example", or "http://localhost:8787" for development. Returns the normalized address
// (no trailing slash) or throws a refusal that says what to change.
export function parseServerUrl(input) {
  const text = String(input ?? '').trim()
  if (text === '') throw refused('Enter the Bot Social server address, for example https://social.example.')
  if (text.length > MAX_URL) throw refused('That address is too long.')
  const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${loopbackHost ? 'http' : 'https'}://${text}`
  let url
  try { url = new URL(withScheme) } catch { throw refused('That is not a valid web address.') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw refused('The address must start with https://.')
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw refused('The address must start with https://. Plain http:// is only accepted for localhost, for development.')
  }
  if (url.username !== '' || url.password !== '') throw refused('Leave the user name and password out of the address.')
  if (url.search !== '' || url.hash !== '') throw refused('Use the plain server address, without ? or # parts.')
  if (url.hostname === '') throw refused('That is not a valid web address.')
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

const cleanLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

// GET <server>/v1/platform: what the server is and which optional features it lists. A redirect is a
// refusal (the address saved is the address checked), and so is anything that does not look like Bot Social.
export async function probeServer(server, { fetch: fetchImpl = socialFetch, timeoutMs = PROBE_MS } = {}) {
  const host = (() => { try { return new URL(server).host } catch { return 'that server' } })()
  let response
  try {
    response = await fetchImpl(`${server}/v1/platform`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    const why = timedOut ? 'it did not answer in time' : cleanLine(error?.cause?.code ?? error?.code ?? 'the connection failed', 60)
    throw refused(`Could not reach ${host}: ${why}.`, 'unreachable')
  }
  if (response.status >= 300 && response.status < 400) throw refused(`${host} redirects somewhere else. Enter the address it redirects to.`, 'redirect')
  if (!response.ok) throw refused(`${host} answered HTTP ${response.status}. Is this a Bot Social server?`, 'not_social')
  let info
  try { info = JSON.parse((await response.text()).slice(0, 262_144)) } catch { info = undefined }
  const isObject = info !== null && typeof info === 'object' && !Array.isArray(info)
  if (!isObject || (typeof info.name !== 'string' && info.platform_key === undefined && !Array.isArray(info.features))) {
    throw refused(`${host} did not answer like a Bot Social server.`, 'not_social')
  }
  const features = (Array.isArray(info.features) ? info.features : []).map(item => cleanLine(item, 40)).filter(Boolean).slice(0, 40)
  return { name: cleanLine(info.name, 60) || 'Bot Social', version: cleanLine(info.version, 30) || undefined, features }
}

const writePrivate = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temp, path)
  try { chmodSync(path, 0o600) } catch { /* file systems that ignore the write mode */ }
}
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }

/**
 * @param base    the plugin config (yaml) with the plugin defaults; `server` is the default server
 * @param flybot  the plugin-scoped FlyBot service
 * @param start   (config) => Promise<social>: startSocial
 */
export function createServerController({ base, flybot, start, registerUnavailable, onFailure, probe = probeServer, warn = () => {}, startTimeoutMs = START_MS }) {
  const credentialsPath = base.credentialsPath
  const dir = dirname(credentialsPath)
  const overridePath = join(dir, 'flybot-social-server.json')
  const defaultSettings = base.settingsPath ?? join(dir, 'flybot-social-settings.json')
  const defaultKey = serverKey(base.server)
  const botsPath = tag => join(dir, `flybot-social-bots.${tag}.json`)

  const readOverride = () => {
    const saved = readJson(overridePath)
    if (typeof saved?.server !== 'string') return undefined
    try { return { server: parseServerUrl(saved.server), displayName: cleanLine(saved.displayName, 40) || undefined } } catch { return undefined }
  }
  const effective = () => {
    const override = readOverride()
    if (override) return { ...override, source: 'settings' }
    return { server: base.server ? String(base.server) : undefined, displayName: undefined, source: base.server ? 'config' : 'none' }
  }
  // The default server keeps its files; any other server gets its own beside them.
  const configFor = ({ server, displayName }) => {
    if (!server) return { ...base }
    const key = serverKey(server)
    const name = displayName ?? base.displayName
    if (key === defaultKey) return { ...base, server, ...(name ? { displayName: name } : {}) }
    const tag = serverTag(key)
    return {
      ...base,
      server,
      displayName: name ?? 'FlyBot',
      credentialsPath: `${credentialsPath}.${tag}`,
      settingsPath: defaultSettings.replace(/(\.json)?$/, `.${tag}$1`),
    }
  }

  let current = effective()
  let social
  let unavailableOff
  let state = current.server ? 'connecting' : 'not-configured'
  let error
  let generation = 0
  let busy = false
  let lastProbe

  const stop = () => {
    generation += 1
    unavailableOff?.()
    unavailableOff = undefined
    try { social?.dispose() } catch (failure) { warn('flybot-social: stop failed:', failure) }
    social = undefined
  }

  // A switched-away server's face-to-face rooms cannot be reached from the new one: keep them as
  // read-only transcripts (a past room) instead of an open room whose lines go nowhere. Switching
  // back does not reopen them: `faceSnapshotPast` keeps a room left here left, and a line to it is
  // refused (`bot/room-ended`). Never throws.
  async function endFaceRooms(faceRoomIds) {
    for (const faceRoomId of faceRoomIds ?? []) {
      try {
        const room = flybot.rooms?.ofFace?.(faceRoomId)
        if (!room) continue
        if (room.face?.status === 'left' || room.face?.status === 'closed') continue
        await flybot.rooms.upsertFace({ roomId: faceRoomId, localId: room.id, status: 'left' })
      } catch (failure) {
        warn('flybot-social: old face-to-face room not ended:', failure)
      }
    }
  }

  // Starts the social layer for a server and settles with it; a start that finishes after it was
  // replaced (or timed out) is disposed instead of kept.
  function launch(target) {
    const mine = ++generation
    state = target.server ? 'connecting' : 'not-configured'
    error = undefined
    const config = configFor(target)
    const run = start(config)
    let timeout
    const timer = new Promise((_, reject) => { timeout = setTimeout(() => reject(refused('the server did not finish connecting in time.', 'timeout')), startTimeoutMs); timeout.unref?.() })
    return Promise.race([run, timer]).finally(() => clearTimeout(timeout)).then((value) => {
      if (mine !== generation) { value.dispose(); throw refused('the connection was replaced.', 'replaced') }
      social = value
      state = target.server ? 'connected' : 'not-configured'
      return value
    }, (failure) => {
      void run.then(late => { if (mine !== generation || social !== late) late.dispose() }, () => { /* the start failed: nothing is running */ })
      if (mine === generation) {
        // Without a server the start fails as it always did ("server URL is required"); the page says "not set", not an error.
        const reason = cleanLine(failure?.message ?? failure, 240) || 'the plugin did not start'
        state = target.server ? 'error' : 'not-configured'
        error = target.server ? reason : undefined
        unavailableOff = registerUnavailable?.(flybot, reason)
        onFailure?.(failure)
      }
      throw failure
    })
  }

  // ---- the identities of the local Bots belong to the server that issued them
  function park(key) {
    const bots = {}
    for (const bot of flybot.bot.list()) {
      const entry = {}
      const member = flybot.fields.get(bot.id, 'member')
      const auto = flybot.fields.get(bot.id, 'autoApprove')
      const grants = flybot.grants?.of?.(bot.id) ?? []
      if (member) entry.member = member
      if (auto) entry.autoApprove = auto
      if (grants.length > 0) entry.grants = grants
      if (Object.keys(entry).length > 0) bots[bot.id] = entry
    }
    if (Object.keys(bots).length === 0) return Promise.resolve()
    // Saved before anything is cleared: a failed write stops the switch with the Bots untouched.
    writePrivate(botsPath(serverTag(key)), { server: serverKey(key), savedAt: new Date().toISOString(), bots })
    return Promise.all(Object.keys(bots).map(async (id) => {
      flybot.fields.set(id, 'member', undefined)
      flybot.fields.set(id, 'autoApprove', undefined)
      try { await flybot.grants?.set?.(id, []) } catch (failure) { warn('flybot-social: grants not cleared:', failure) }
    }))
  }
  async function restore(key) {
    const saved = readJson(botsPath(serverTag(key)))
    if (!saved || serverKey(saved.server) !== serverKey(key)) return
    for (const [id, entry] of Object.entries(saved.bots ?? {})) {
      if (!flybot.bot.get(id)) continue
      try {
        if (entry.member && !flybot.fields.get(id, 'member')) flybot.fields.set(id, 'member', entry.member)
        if (entry.autoApprove && !flybot.fields.get(id, 'autoApprove')) flybot.fields.set(id, 'autoApprove', entry.autoApprove)
        if (Array.isArray(entry.grants) && entry.grants.length > 0) await flybot.grants?.set?.(id, entry.grants)
      } catch (failure) { warn('flybot-social: saved Bot identity not restored:', failure) }
    }
  }
  const writeOverride = (target) => {
    if (target.server && serverKey(target.server) !== defaultKey) writePrivate(overridePath, { server: target.server, ...(target.displayName ? { displayName: target.displayName } : {}), savedAt: new Date().toISOString() })
    else rmSync(overridePath, { force: true })
  }

  // Servers this profile has saved credentials for (the address only, never the credentials).
  function knownServers() {
    const found = new Set()
    const add = path => { const saved = readJson(path); if (typeof saved?.server === 'string' && saved.token) found.add(saved.server) }
    add(credentialsPath)
    try {
      const stem = `${basename(credentialsPath)}.`
      for (const name of readdirSync(dir)) if (name.startsWith(stem) && /^[0-9a-f]{8}$/.test(name.slice(stem.length))) add(join(dir, name))
    } catch { /* no data folder yet */ }
    if (current.server) found.delete(serverKey(current.server))
    return [...found].filter(item => serverKey(item) !== serverKey(current.server)).slice(0, 6)
  }

  const view = () => ({
    server: current.server ?? null,
    source: current.source,
    defaultServer: base.server ? String(base.server) : null,
    displayName: current.displayName ?? (base.displayName ? String(base.displayName) : null),
    state,
    handle: social?.home?.handle ?? null,
    error: error ?? null,
    canChange: flybot.readOnly?.() !== true,
    known: knownServers(),
    ...(lastProbe && serverKey(lastProbe.server) === serverKey(current.server) ? { platform: lastProbe.info } : {}),
  })

  return {
    status: view,
    ready: () => launch(current).catch(() => undefined),
    async check({ server } = {}) {
      const address = server === undefined || server === '' ? current.server : parseServerUrl(server)
      if (!address) throw refused('No server is set yet.', 'no_server')
      const info = await probe(address, { fetch: base.fetch })
      if (serverKey(address) === serverKey(current.server)) lastProbe = { server: address, info }
      return { server: address, ...info, same: serverKey(address) === serverKey(current.server), known: knownServers().some(item => serverKey(item) === serverKey(address)) || serverKey(address) === defaultKey && Boolean(readJson(credentialsPath)?.token) }
    },
    async set({ server, displayName, confirm } = {}) {
      if (flybot.readOnly?.() === true) throw refused('Another FlyBot window holds this team. Change the server there.', 'read_only')
      const address = parseServerUrl(server)
      const name = cleanLine(displayName, 40) || undefined
      if (serverKey(address) === serverKey(current.server) && !name) return view()
      if (confirm !== true) throw refused('Confirm that you want to switch servers.', 'confirm_required')
      if (busy) throw refused('A server change is already running.', 'busy')
      busy = true
      try {
        const info = await probe(address, { fetch: base.fetch })
        const previous = current
        const target = { server: address, displayName: name, source: serverKey(address) === defaultKey ? 'config' : 'settings' }
        // Captured before the switch; only a successful switch ends them (a failed one reverts).
        const previousFaceRooms = (flybot.rooms?.list?.() ?? [])
          .filter(room => room.origin === 'face-to-face' && room.face?.roomId && (room.face.status === 'open' || room.face.status === 'candidate'))
          .map(room => room.face.roomId)
        stop()
        if (previous.server) await park(previous.server)
        writeOverride(target)
        await restore(address)
        current = target
        lastProbe = { server: address, info }
        try {
          await launch(target)
        } catch (failure) {
          // Back to the server that worked: its identities, its files, its override.
          stop()
          // A failed start leaves nothing of the new server worth parking: a failed park changes nothing here.
          if (target.server) await park(target.server).catch(() => undefined)
          writeOverride(previous)
          if (previous.server) await restore(previous.server)
          current = previous
          lastProbe = undefined
          // launch() has already recorded the failure (state, error, the unavailable answers); the message below reports it.
          await launch(previous).catch(() => undefined)
          const why = cleanLine(failure?.message ?? failure, 200) || 'the server did not accept this FlyBot'
          throw refused(`Could not connect to the new server: ${why} The previous server is back${state === 'connected' ? '' : ', but it did not reconnect either'}.`, 'switch_failed')
        }
        // A rename on the same server is not a switch (#729): that server still reaches these rooms, so
        // only a change of address ends them.
        if (serverKey(previous.server) !== serverKey(address)) await endFaceRooms(previousFaceRooms)
        return view()
      } finally {
        busy = false
      }
    },
    dispose: stop,
  }
}
