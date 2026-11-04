import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { harnessProfile, sdkAuthenticationFailure, authenticationError } from '../src/host/project-harness-auth.js'
test('profile identity preserves generated paths and explicit existing login reuse without Task/role copies', () => {
  const project = { id: 'p', ownerUserId: 'owner' }, resource = { type: 'docker', container: 'one', user: '1000', profileRoot: '/profiles' }
  const first = harnessProfile(resource, project, 'r', 'codex')
  assert.equal(first.selected.configDir, '/profiles/' + createHash('sha256').update('p\nowner').digest('hex').slice(0,24) + '/codex/config')
  assert.deepEqual(harnessProfile(resource, { ...project, taskId: 'another', role: 'reviewer' }, 'r', 'codex').profile, first.profile)
  resource.profiles = { owner: { codex: { home: '/existing', configDir: '/existing/codex' } } }
  const configured = harnessProfile(resource, project, 'r', 'codex')
  assert.equal(configured.profile.source, 'configured'); assert.equal(configured.selected.configDir, '/existing/codex')
  assert.notEqual(configured.profile.id, first.profile.id)
  assert.ok(!JSON.stringify(configured.profile).includes('/existing'))
  resource.profiles.owner.codex.configDir = '/other'
  assert.notEqual(harnessProfile(resource, project, 'r', 'codex').profile.id, configured.profile.id)
  assert.throws(() => harnessProfile({}, project, 'r', 'codex'), /explicitly authorized/)
})
test('known SDK auth failure shapes retain safe codes without provider text or treating network errors as login failures', () => {
  for (const value of [{ error: { code: 'refresh_token_reused', message: 'private details' } }, { message: 'Your refresh token has already been used to generate a new access token.' }, { message: 'refresh_token_reused' }]) {
    const failure = sdkAuthenticationFailure(value, 'codex')
    assert.equal(failure.code, 'refresh_token_reused'); assert.equal(failure.reauthenticationRequired, true)
    assert.equal(authenticationError(failure).code, 'bot/harness-auth'); assert.ok(!authenticationError(failure).message.includes('private details'))
  }
  for (const value of [{ code: 'refresh_token_expired' }, { code: 'invalid_grant' }, { message: 'Refresh token has expired' }, { message: 'Invalid API key' }, { status: 401 }]) assert.ok(sdkAuthenticationFailure(value, 'codex'))
  for (const value of [null, {}, { message: 'Network timeout' }, { status: 503 }, { code: 'ECONNREFUSED' }]) assert.equal(sdkAuthenticationFailure(value, 'codex'), null)
})
