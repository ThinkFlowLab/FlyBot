// Optional Bot Social collaboration endpoint for this container.
// The file carries only a server URL (and optional display name). Connector
// tokens are issued by onboarding and stay on the /data volume — never in
// this file, the image, or logs. No credits or usage limits are involved.
import { readFileSync, realpathSync, statSync } from 'node:fs'

export const DEFAULT_FILES = [
  '/run/secrets/flybot-workspace-bot-social.json',
  '/data/secrets/bot-social.json',
]
export const ENV_FILE = 'FLYBOT_WORKSPACE_BOT_SOCIAL_FILE'
export const ENV_SERVER = 'FLYBOT_WORKSPACE_BOT_SOCIAL_SERVER'
export const ENV_SERVER_ALT = 'FLYBOT_SOCIAL_SERVER'
const ALLOWED_PREFIXES = ['/run/secrets/', '/data/secrets/']
const MAX_BYTES = 8 * 1024
const MAX_URL = 200
const MAX_NAME = 40
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export class BotSocialConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BotSocialConfigError'
  }
}

function flatten(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function parseServerUrl(input) {
  const text = String(input ?? '').trim()
  if (text === '') return undefined
  if (text.length > MAX_URL) throw new BotSocialConfigError('Bot Social server address is too long')
  const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(text)
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${loopbackHost ? 'http' : 'https'}://${text}`
  let url
  try { url = new URL(withScheme) } catch { throw new BotSocialConfigError('Bot Social server address is not a valid URL') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BotSocialConfigError('Bot Social server address must start with https://')
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    throw new BotSocialConfigError('http:// is only accepted for localhost')
  }
  if (url.username !== '' || url.password !== '') {
    throw new BotSocialConfigError('leave user name and password out of the Bot Social server address')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new BotSocialConfigError('use the plain Bot Social server address, without ? or # parts')
  }
  if (url.hostname === '') throw new BotSocialConfigError('Bot Social server address is not a valid URL')
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
}

function assertAllowedPath(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) {
    throw new BotSocialConfigError('Bot Social config file path is invalid')
  }
  if (input.includes('\0') || input.includes('\n')) {
    throw new BotSocialConfigError('Bot Social config file path is invalid')
  }
  let resolved
  try { resolved = realpathSync(input) } catch {
    throw new BotSocialConfigError('Bot Social config file is not readable')
  }
  if (!ALLOWED_PREFIXES.some((prefix) => resolved === prefix.slice(0, -1) || resolved.startsWith(prefix))) {
    throw new BotSocialConfigError('Bot Social config file must live under /run/secrets or /data/secrets')
  }
  const st = statSync(resolved)
  if (!st.isFile()) throw new BotSocialConfigError('Bot Social config path is not a file')
  if (st.size > MAX_BYTES) throw new BotSocialConfigError('Bot Social config file is too large')
  return resolved
}

export function parseBotSocialConfig(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return {}
  let data
  try { data = JSON.parse(text) } catch {
    throw new BotSocialConfigError('Bot Social config file is not valid JSON')
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new BotSocialConfigError('Bot Social config file must be a JSON object')
  }
  const server = parseServerUrl(data.server)
  const displayName = data.displayName == null ? undefined : flatten(data.displayName, MAX_NAME) || undefined
  // Tokens never come from this file, even if an operator left one in it.
  return server ? { server, ...(displayName ? { displayName } : {}) } : {}
}

function readOptionalFile(path) {
  try {
    return readFileSync(assertAllowedPath(path), 'utf8')
  } catch (error) {
    if (error instanceof BotSocialConfigError) throw error
    if (error?.code === 'ENOENT') return undefined
    throw new BotSocialConfigError('Bot Social config file is not readable')
  }
}

export function loadBotSocialConfig(env = process.env, { readFile = readOptionalFile } = {}) {
  const pointed = typeof env[ENV_FILE] === 'string' ? env[ENV_FILE].trim() : ''
  if (pointed) {
    const raw = readFile(pointed)
    if (raw === undefined) throw new BotSocialConfigError('Bot Social config file is not readable')
    const parsed = parseBotSocialConfig(raw)
    if (parsed.server) return parsed
  } else {
    for (const path of DEFAULT_FILES) {
      let raw
      try { raw = readFile(path) } catch (error) {
        if (error instanceof BotSocialConfigError && /not readable|ENOENT/i.test(error.message)) continue
        // Missing default files are skipped; a present, broken default file fails closed.
        if (error?.code === 'ENOENT') continue
        throw error
      }
      if (raw === undefined) continue
      const parsed = parseBotSocialConfig(raw)
      if (parsed.server) return parsed
    }
  }
  const fromEnv = parseServerUrl(env[ENV_SERVER] || env[ENV_SERVER_ALT])
  return fromEnv ? { server: fromEnv } : {}
}
