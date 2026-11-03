import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { backendConfig, callApi, optionsOf, prepareBackend, privateJson, requestBody } from '../../scripts/backend-lib.mjs'
import { createServer } from 'node:http'

test('backend source profile preserves original plugins and uses real persistent pools rather than fixtures', t => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-backend-profile-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const config = backendConfig(), profile = prepareBackend(home, config)
  const path = join(profile, 'package.json'), manifest = JSON.parse(readFileSync(path, 'utf8'))
  for (const name of ['ds-bot', '@flybot/tree', '@flybot/workflow', '@flybot/social', '@flybot/timeline']) assert.ok(manifest.dsh.profile.bundles.includes(name))
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-base'], '0.2.1-rc.2')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh-web-app'], '0.2.1-rc.2')
  assert.equal(config.bot.stateStorage, 'sqlite')
  assert.equal(config.bot.projectWorkbench, true)
  assert.equal(config.bot.projectDispatch, 'pools')
  manifest.dependencies.custom = '1.0.0'; manifest.dsh.profile.bundles.push('custom'); privateJson(path, manifest)
  prepareBackend(home, config)
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).dsh.profile.bundles.includes('custom'))
  assert.equal(statSync(join(home, 'backend.json')).mode & 0o777, 0o600)
  const overlay = readFileSync(join(home, 'backend.patch.yml'), 'utf8')
  assert.match(overlay, /projectWorkbench/)
  assert.doesNotMatch(overlay, /fixture|mock|API_KEY|sessionToken/)
})

test('backend rejects ambiguous configuration and malformed CLI command identity', () => {
  for (const config of [{ port: 0 }, { port: '3080' }, { unknown: true }, { bot: [] }, { bot: { projectWorkbench: false } }, { bot: { projectDispatch: 'workflow' } }, { bot: { home: '/somewhere' } }]) assert.throws(() => backendConfig(config))
  assert.deepEqual(optionsOf(['query', 'tasks', '--project', 'p', '--home', '/tmp/user-home']), { command: 'query', positional: ['tasks'], options: { project: 'p', home: '/tmp/user-home' } })
  for (const args of [['start', '--home'], ['start', '--password', 'secret'], ['start', '--home', 'a', '--home', 'b']]) assert.throws(() => optionsOf(args))
  assert.throws(() => requestBody('command', 'task.propose', { project: 'p' }), /request-id/)
  assert.throws(() => requestBody('query', 'tasks', { project: 'p', json: '[]' }), /object/)
  const request = requestBody('command', 'task.propose', { project: 'p', 'request-id': 'one-intent', json: '{"title":"Project change"}' })
  assert.equal(request.endpoint, 'project-development')
  assert.equal(request.payload.version, 'project-development/v1')
  assert.equal(request.payload.requestId, 'one-intent')
  assert.equal(request.payload.payload.title, 'Project change')
})

test('CLI HTTP client uses existing authenticated API and reports domain/transport failures', async t => {
  let seen
  const server = createServer(async (request, response) => {
    let text = ''; for await (const bytes of request) text += bytes
    seen = { url: request.url, cookie: request.headers.cookie, member: request.headers['x-flybot-member-session'], request: JSON.parse(text) }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(seen.request.endpoint === 'deny' ? { ok: false, error: { code: 'bot/forbidden', message: 'Current membership required' } } : { ok: true, value: { projectId: 'p' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const transport = { baseUrl: `http://127.0.0.1:${server.address().port}`, cookie: 'transport=private' }
  assert.deepEqual(await callApi(transport, 'project-read', { id: 'p' }, 'member-secret'), { projectId: 'p' })
  assert.equal(seen.url, '/api/bot'); assert.equal(seen.member, 'member-secret'); assert.equal(seen.cookie, 'transport=private')
  await assert.rejects(callApi(transport, 'deny', {}, 'member-secret'), /bot\/forbidden/)
})
