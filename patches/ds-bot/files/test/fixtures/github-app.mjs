import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
export function appFixture(t, handle, repository = 'org/repo') {
  const directory = mkdtempSync(join(tmpdir(), 'flybot-app-contract-')), privateKeyFile = join(directory, 'app.pem'), pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  writeFileSync(privateKeyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const settings = { credential: 'github-app', appId: 7, installationId: 12, privateKeyFile }, tokens = new Map(), minted = []
  let suspended = false
  const request = async (url, options = {}) => {
    assert(url.startsWith('https://api.github.com/')); assert.equal(options.redirect, 'error')
    const authorization = options.headers.authorization.slice(7)
    if (url.endsWith('/installation') || url.endsWith('/access_tokens')) {
      const parts = authorization.split('.')
      assert(verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), pair.publicKey, Buffer.from(parts[2], 'base64url')))
      if (url.endsWith('/installation')) return Response.json({ id: 12, app_id: 7, app_slug: 'contract-app', account: { login: repository.split('/')[0] }, suspended_at: suspended ? 'now' : null, permissions: { contents: 'write', issues: 'write', pull_requests: 'write', checks: 'read', actions: 'read' } })
      const body = JSON.parse(options.body); assert.deepEqual(body.repositories, [repository.split('/')[1]])
      minted.push(body.permissions); const token = 'ghs_7_contract.' + minted.length; tokens.set(token, body.permissions)
      return Response.json({ token, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: body.permissions, repositories: [{ full_name: repository }] })
    }
    assert(tokens.has(authorization), 'External operation uses a minted installation token, never JWT/ambient credentials')
    return handle(url, options, tokens.get(authorization))
  }
  return { settings, request, minted, suspend() { suspended = true } }
}
