// In-process fake Bot Social server for CI. Issues only ot-fake- tokens.
// Never a real connector, never a third-party service.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const FAKE_TOKEN_PREFIX = 'ot-fake-'

export function mintFakeToken() {
  return `${FAKE_TOKEN_PREFIX}${randomBytes(16).toString('hex')}`
}

export function isFakeToken(value) {
  return typeof value === 'string'
    && value.startsWith(FAKE_TOKEN_PREFIX)
    && value.length === FAKE_TOKEN_PREFIX.length + 32
    && /^[0-9a-f]+$/.test(value.slice(FAKE_TOKEN_PREFIX.length))
}

export function startFakeBotSocial(options = {}) {
  const token = options.token ?? mintFakeToken()
  if (!isFakeToken(token)) throw new Error('CI tokens must be ot-fake- plus 32 hex characters')
  const stats = { onboard: 0, platform: 0, other: 0 }
  const handle = options.handle ?? 'flybot'
  const botId = options.botId ?? 'bot_fake_home'
  const ownerId = options.ownerId ?? 'owner_fake'
  let takeFirst = options.takeFirstHandle === true

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const send = (status, body) => {
      const text = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
    }
    if (req.method === 'GET' && url.pathname === '/v1/platform') {
      stats.platform += 1
      send(200, { name: 'Bot Social', version: 'fake', platform_key: 'bot-social-fake', features: [] })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/onboard/flybot') {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        stats.onboard += 1
        if (takeFirst) {
          takeFirst = false
          send(409, { error: 'handle_taken' })
          return
        }
        let body = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { body = {} }
        const display = typeof body.display_name === 'string' && body.display_name.trim()
          ? body.display_name.trim()
          : handle
        send(200, {
          connector: { token },
          home: { bot_id: botId, handle: display.toLowerCase().replace(/[^a-z0-9]+/g, '-') || handle },
          owner_id: ownerId,
        })
      })
      return
    }
    stats.other += 1
    send(404, { error: 'not_implemented' })
  })

  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', onError)
      const addr = server.address()
      resolve({
        url: `http://${addr.address}:${addr.port}`,
        token,
        stats,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      })
    })
  })
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href
if (isCli) {
  const args = new Map()
  for (let i = 2; i < process.argv.length; i += 1) {
    const key = process.argv[i]
    if (key === '--host' || key === '--port') args.set(key.slice(2), process.argv[++i])
  }
  const started = await startFakeBotSocial({
    host: args.get('host') ?? '127.0.0.1',
    port: args.get('port') ? Number(args.get('port')) : 8787,
  })
  // Do not print the token.
  console.log(`fake Bot Social listening on ${started.url}`)
}
