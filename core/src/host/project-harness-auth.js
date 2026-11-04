// Model login belongs to an explicit resource profile, not a Task-role Session.
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
const ownEntry = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const legacyProfileHash = value => createHash('sha256').update(value).digest('hex')
export function harnessProfile(resource, project, resourceId, harness) {
  const principalId = project.ownerUserId
  const configured = ownEntry(ownEntry(resource.profiles ?? {}, principalId) ?? {}, harness)
  const generated = harness !== 'flybot' && isAbsolute(resource.profileRoot ?? '') ? { home: join(resource.profileRoot, legacyProfileHash(`${project.id}\n${principalId}`).slice(0, 24), harness), configDir: join(resource.profileRoot, legacyProfileHash(`${project.id}\n${principalId}`).slice(0, 24), harness, 'config') } : null
  const selected = configured ?? generated
  if (!selected || !isAbsolute(selected.home ?? '') || !isAbsolute(selected.configDir ?? '')) throw Object.assign(Error('Resource Harness needs an explicitly authorized principal/profile and model'), { code: 'bot/harness' })
  const profile = { id: hash([resourceId, resource.type, resource.container ?? null, resource.user ?? null, resource.runtimeDir ?? null, principalId, harness, selected.home, selected.configDir, selected.baseUrl ?? null, selected.envRefs ?? {}]), source: configured ? 'configured' : 'generated', resourceId, principalId, harness }
  return { selected, principalId, profile }
}
const codes = new Set(['refresh_token_reused', 'refresh_token_expired', 'refresh_token_invalidated', 'invalid_refresh_token', 'invalid_grant', 'invalid_api_key', 'authentication_required', 'authentication_error'])
export function sdkAuthenticationFailure(value, harness) {
  const error = value?.error && typeof value.error === 'object' ? value.error : value
  let code = error?.code
  const message = typeof error?.message === 'string' ? error.message.slice(0, 16000).toLowerCase() : ''
  if (!codes.has(code)) {
    code = [...codes].find(item => message.includes(item))
    if (!code && /refresh token.{0,160}(?:already.{0,20}used|reused)/s.test(message)) code = 'refresh_token_reused'
    if (!code && /refresh token.{0,80}(?:expired|invalidated|revoked)/s.test(message)) code = 'invalid_refresh_token'
    if (!code && /(?:not logged in|please (?:log|sign) in|invalid (?:api key|x-api-key)|incorrect api key)/.test(message)) code = 'authentication_required'
    if (!code && (error?.status === 401 || error?.statusCode === 401)) code = 'authentication_required'
  }
  return codes.has(code) ? { harness, code, reauthenticationRequired: true } : null
}
export function authenticationError(failure) {
  return Object.assign(Error(`${failure.harness} authentication requires configuration on the selected resource profile (${failure.code})`), { code: 'bot/harness-auth', authenticationFailure: failure })
}
