// Short-lived installation credentials are host-only and never serialized into state.
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { privateCredentialFile } from './project-private-file.js'
const hash = value => createHash('sha256').update(value).digest('hex')
const denied = message => Object.assign(new Error(message), { code: 'bot/forbidden' })
const validId = value => Number.isSafeInteger(value) && value > 0
export function githubCredentialBinding(settings = {}, repository) {
  return hash(JSON.stringify(settings.credential === 'github-app'
    ? ['github-app', settings.appId, settings.installationId, repository, settings.connectionId ?? null, settings.connectionRevision ?? null]
    : ['gh-cli', settings.configDir, settings.login?.toLowerCase(), repository, settings.connectionId ?? null, settings.connectionRevision ?? null]))
}
export function githubIdentityMetadata(identity) {
  return { provider: identity.provider ?? 'gh-cli', login: identity.login, appId: identity.appId ?? null, installationId: identity.installationId ?? null, credentialIdentity: identity.credentialIdentity ?? null }
}
export function createGithubAppProvider({ request = fetch, now = Date.now, readKey = privateCredentialFile } = {}) {
  const cache = new Map(), refreshing = new Map()
  async function resolve(settings, { repository, permissions = { contents: 'read' } } = {}) {
    if (!validId(settings.appId) || !validId(settings.installationId) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !Object.keys(permissions).length || Object.entries(permissions).some(([key, value]) => !['contents', 'pull_requests', 'issues', 'checks'].includes(key) || !['read', 'write'].includes(value))) throw denied('GitHub App installation scope is not configured')
    let key, material
    try {
      material = await readKey(settings.privateKeyFile)
      key = createPrivateKey(material)
      if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw Error('Invalid key')
    } catch { throw denied('GitHub App private key is unavailable; operator must repair its private file') }
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
    const seconds = Math.floor(now() / 1000), unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iat: seconds - 60, exp: seconds + 540, iss: String(settings.appId) })
    const jwt = unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')
    const api = async (path, body) => {
      let response
      try { response = await request('https://api.github.com' + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' }, ...(body ? { body: JSON.stringify(body) } : {}) }) }
      catch { throw denied('GitHub App installation verification is unavailable') }
      if (!response.ok) throw denied('GitHub App installation is unavailable; check installation, key and repository permissions')
      try { return await response.json() } catch { throw denied('GitHub App installation returned invalid metadata') }
    }
    // Always verify current installation, even when a token is cached.
    const installation = await api(`/repos/${repository}/installation`)
    if (installation.id !== settings.installationId || installation.app_id !== settings.appId || installation.suspended_at || installation.account?.login?.toLowerCase() !== repository.split('/')[0].toLowerCase() || !/^[a-z0-9-]+$/.test(installation.app_slug ?? '')) throw denied('GitHub App installation or repository scope does not match')
    for (const [permission, level] of Object.entries(permissions)) if (!['read', 'write'].includes(installation.permissions?.[permission]) || level === 'write' && installation.permissions[permission] !== 'write') throw denied('GitHub App installation permission is insufficient')
    const login = installation.app_slug + '[bot]'
    if (settings.login && settings.login.toLowerCase() !== login.toLowerCase()) throw denied('GitHub App installation login does not match')
    const binding = githubCredentialBinding(settings, repository), cacheKey = binding + hash(material) + JSON.stringify(Object.entries(permissions).sort())
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt - now() > 60000 && cached.login === login) return { ...cached }
    if (refreshing.has(cacheKey)) return { ...await refreshing.get(cacheKey) }
    const pending = (async () => {
      const result = await api(`/app/installations/${settings.installationId}/access_tokens`, { repositories: [repository.split('/')[1]], permissions })
      const expiresAt = Date.parse(result.expires_at)
      if (typeof result.token !== 'string' || !/^[A-Za-z0-9_.-]{10,8192}$/.test(result.token) || !Number.isFinite(expiresAt) || expiresAt <= now() + 60000 || expiresAt > now() + 3660000 || !Array.isArray(result.repositories) || result.repositories.length !== 1 || result.repositories[0].full_name?.toLowerCase() !== repository.toLowerCase()) throw denied('GitHub App token scope or expiry is invalid')
      for (const [permission, level] of Object.entries(permissions)) if (result.permissions?.[permission] !== level) throw denied('GitHub App token permission does not match')
      const value = { token: result.token, login, provider: 'github-app', appId: settings.appId, installationId: settings.installationId, repository, credentialIdentity: binding, expiresAt }
      if (cache.size >= 128) cache.delete(cache.keys().next().value)
      cache.set(cacheKey, value)
      return value
    })()
    refreshing.set(cacheKey, pending)
    try { return { ...await pending } } finally { refreshing.delete(cacheKey) }
  }
  return { resolve, invalidate(settings, repository) { const binding = githubCredentialBinding(settings, repository); for (const [key, value] of cache) if (value.credentialIdentity === binding) cache.delete(key) } }
}
const providers = new WeakMap()
export function resolveGithubApp(settings, options = {}) {
  const request = options.request ?? fetch
  let provider = providers.get(request)
  if (!provider) { provider = createGithubAppProvider({ request }); providers.set(request, provider) }
  return provider.resolve(settings, options)
}

export function invalidateGithubApp(settings, repository, request = fetch) { providers.get(request)?.invalidate(settings, repository) }
