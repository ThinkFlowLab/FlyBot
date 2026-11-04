import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createGithubAppProvider } from '../src/host/project-github-app.js'
const keys = () => generateKeyPairSync('rsa', { modulusLength: 2048 })
function fixture() {
  let time = 1800000000000, pair = keys(), mints = 0, suspended = false, permissions = { contents: 'write', pull_requests: 'write' }, installed = 12, tokenOverride = {}
  const settings = { credential: 'github-app', appId: 7, installationId: 12, privateKeyFile: '/private/test.pem' }
  const request = async (url, options) => {
    const jwt = options.headers.authorization.slice(7), [header, payload, signature] = jwt.split('.')
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256')
    assert(verify('RSA-SHA256', Buffer.from(header + '.' + payload), pair.publicKey, Buffer.from(signature, 'base64url')))
    const claims = JSON.parse(Buffer.from(payload, 'base64url'))
    assert.equal(claims.iss, '7'); assert.equal(claims.iat, Math.floor(time / 1000) - 60); assert(claims.exp <= time / 1000 + 600)
    if (url.endsWith('/installation')) return Response.json({ id: installed, app_id: 7, app_slug: 'flybot-test', account: { login: 'example' }, suspended_at: suspended ? 'yesterday' : null, permissions })
    assert.equal(url, 'https://api.github.com/app/installations/12/access_tokens')
    const body = JSON.parse(options.body); assert.deepEqual(body.repositories, ['demo'])
    mints++
    return Response.json({ token: 'ghs_7_new.format.' + mints, expires_at: new Date(time + 3600000).toISOString(), permissions: body.permissions, repositories: [{ full_name: 'example/demo' }], ...tokenOverride })
  }
  const makeProvider = () => createGithubAppProvider({ request, now: () => time, readKey: async () => pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) })
  const provider = makeProvider()
  return { settings, provider, restart: makeProvider, count: () => mints, token(value) { tokenOverride = value }, advance() { time += 3600000 }, rotate() { pair = keys() }, suspend() { suspended = true }, wrong() { installed = 99 }, reduce() { permissions = { contents: 'read' } } }
}
test('App JWT, scoped tokens, concurrent refresh, expiry, rotation and restart preserve logical identity', async () => {
  const f = fixture(), options = { repository: 'example/demo', permissions: { contents: 'write', pull_requests: 'write' } }
  const rows = await Promise.all(Array.from({ length: 8 }, () => f.provider.resolve(f.settings, options)))
  assert.equal(f.count(), 1); assert.equal(rows[0].login, 'flybot-test[bot]'); assert.equal(rows[0].provider, 'github-app')
  assert(rows.every(row => row.token === rows[0].token)); const binding = rows[0].credentialIdentity
  f.advance(); assert.notEqual((await f.provider.resolve(f.settings, options)).token, rows[0].token); assert.equal(f.count(), 2)
  f.rotate(); assert.equal((await f.provider.resolve(f.settings, options)).credentialIdentity, binding); assert.equal(f.count(), 3)
  await assert.rejects(f.provider.resolve(f.settings, { ...options, repository: 'other/demo' }), /installation|scope/)
  await f.restart().resolve(f.settings, options); assert.equal(f.count(), 4, 'restart remints instead of restoring tokens from state')
  f.suspend(); await assert.rejects(f.provider.resolve(f.settings, options), /installation/); assert.equal(f.count(), 4)
})
test('App installation and permissions fail closed even with a cached token', async () => {
  for (const action of ['wrong', 'reduce']) {
    const f = fixture(), options = { repository: 'example/demo', permissions: { contents: 'write' } }
    await f.provider.resolve(f.settings, options); f[action]()
    await assert.rejects(f.provider.resolve(f.settings, options), /installation|permission/); assert.equal(f.count(), 1)
  }
})

test('App provider sanitizes key/network failures and refuses oversized, widened or stale tokens', async () => {
  const f = fixture()
  await assert.rejects(f.provider.resolve({ ...f.settings, appId: '7' }, { repository: 'example/demo' }), /scope/)
  const provider = createGithubAppProvider({ readKey: async () => { throw Error('PRIVATE-KEY-SENTINEL') } })
  await assert.rejects(provider.resolve(f.settings, { repository: 'example/demo' }), error => !error.message.includes('SENTINEL') && /private key/.test(error.message))
})

test('widened repository scope, missing permission, stale expiry and malformed tokens are rejected', async () => {
  for (const bad of [{ repositories: [{ full_name: 'other/repo' }] }, { repositories: [{ full_name: 'example/demo' }, { full_name: 'other/repo' }] }, { permissions: {} }, { expires_at: '2000-01-01T00:00:00Z' }, { token: 'injected\r\nheader' }, { token: 'x'.repeat(8193) }]) {
    const f = fixture(); f.token(bad)
    await assert.rejects(f.provider.resolve(f.settings, { repository: 'example/demo' }), /scope|expiry|permission/)
  }
})
