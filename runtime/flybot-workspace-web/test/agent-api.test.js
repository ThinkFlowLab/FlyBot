import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAgents } from '../features/agents/index.js'
import { createAgentApi } from '../features/agent-api/index.js'
import { loadFeatures } from '../src/features.js'
import { nativeAgentFixture } from './native-agent-fixture.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const W = 'a'.repeat(32)
const INSTANCE = 'f'.repeat(32)

async function fixture({ reply = () => 'DS-Bot answer', routingInstanceId } = {}) {
  const runtime = nativeAgentFixture({reply})
  const table = {}
  const host = { identity: { instanceId: INSTANCE, routingInstanceId }, runtime: async () => runtime.services,
    call: async (name, payload) => name === 'skills/materialForScope' ? {items: []} : table[name](payload) }
  const agents = createAgents({ db: new DatabaseSync(':memory:'), host }).endpoints
  for (const [k, v] of Object.entries(agents)) table[`agents/${k}`] = v
  const clock = { now: 1_800_000_000 }
  const api = createAgentApi({ db: new DatabaseSync(':memory:'), host, clock: () => clock.now })
  const { agent } = await agents.create({ workspace_id: W, name: '客服', instructions: 'Be brief.', idempotency_key: 'a'.repeat(16) })
  return { api, e: api.endpoints, agent, agents, clock, ...runtime }
}

test('a key is shown once, stored as a digest, and invokes its agent as a DS-Bot turn', async () => {
  const { e, api, agent, turns, bots } = await fixture()
  const made = await e['key-create']({ workspace_id: W, agent_id: agent.id, name: 'ci', rate_per_minute: 2 })
  assert.equal(made.status, 201)
  assert.match(made.token, new RegExp(`^ota_${INSTANCE}_[A-Za-z0-9_-]{43}$`))
  assert.ok(!JSON.stringify((await e.keys({ workspace_id: W, agent_id: agent.id }))).includes(made.token.slice(-43)))
  const inv = await e.invoke({ token: made.token, agent_id: agent.id, prompt: '你好', idempotency_key: 'i'.repeat(16) })
  assert.equal(inv.status, 202)
  await Promise.all(api.inflight.values())
  const done = await e.invocation({ token: made.token, id: inv.invocation.id })
  assert.equal(done.invocation.status, 'succeeded')
  assert.equal(done.invocation.reply, 'DS-Bot answer')
  assert.equal(done.invocation.engine, 'ds-bot')
  assert.match(turns[0].key, new RegExp(`^agent:${agent.id}:api:`))
  assert.equal(turns[0].bot, agent.native_bot_id)
  assert.equal(turns[0].text, '你好')
  assert.equal(bots[agent.native_bot_id].instructions, 'Be brief.')
  assert.equal((await e.invoke({ token: made.token, agent_id: agent.id, prompt: '你好', idempotency_key: 'i'.repeat(16) })).status, 200)
  await assert.rejects(e.invoke({ token: made.token, agent_id: agent.id, prompt: '别的', idempotency_key: 'i'.repeat(16) }), (err) => err.status === 409)
})

test('a preserved volume issues and verifies keys with its assigned gateway identity', async () => {
  const routed = 'b'.repeat(32)
  const { e, api, agent, turns } = await fixture({ routingInstanceId: routed })
  const { token } = await e['key-create']({ workspace_id: W, agent_id: agent.id, name: 'migrated' })
  assert.ok(token.startsWith(`ota_${routed}_`), 'the edge must be able to route the key')
  const body = { agent_id: agent.id, prompt: 'hello', idempotency_key: 'm'.repeat(16) }
  await assert.rejects(e.invoke({ ...body, token: token.replace(routed, INSTANCE) }), error => error.status === 401)
  const submitted = await e.invoke({ ...body, token })
  assert.equal(submitted.status, 202)
  await Promise.all(api.inflight.values())
  assert.equal((await e.invocation({ token, id: submitted.invocation.id })).invocation.reply, 'DS-Bot answer')
  assert.equal(turns.length, 1)
})

test('rate limit, wrong agent, revoked and forged keys are refused', async () => {
  const { e, agent, agents, clock } = await fixture()
  const { token, key } = await e['key-create']({ workspace_id: W, agent_id: agent.id, name: 'k', rate_per_minute: 1 })
  await e.invoke({ token, agent_id: agent.id, prompt: 'a', idempotency_key: 'a'.repeat(16) })
  await assert.rejects(e.invoke({ token, agent_id: agent.id, prompt: 'b', idempotency_key: 'b'.repeat(16) }), (err) => err.status === 429)
  clock.now += 60
  assert.equal((await e.invoke({ token, agent_id: agent.id, prompt: 'b', idempotency_key: 'b'.repeat(16) })).status, 202)
  const other = (await agents.create({ workspace_id: W, name: '另一个', idempotency_key: 'o'.repeat(16) })).agent
  await assert.rejects(e.invoke({ token, agent_id: other.id, prompt: 'c', idempotency_key: 'c'.repeat(16) }), (err) => err.status === 403)
  await assert.rejects(e.invoke({ token: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), agent_id: agent.id, prompt: 'c', idempotency_key: 'c'.repeat(16) }), (err) => err.status === 401)
  await assert.rejects(e.invoke({ token: token.replace(INSTANCE, 'e'.repeat(32)), agent_id: agent.id, prompt: 'c', idempotency_key: 'c'.repeat(16) }), (err) => err.status === 401)
  await e['key-revoke']({ workspace_id: W, agent_id: agent.id, key_id: key.id })
  await assert.rejects(e.invoke({ token, agent_id: agent.id, prompt: 'd', idempotency_key: 'd'.repeat(16) }), (err) => err.status === 401)
})

test('a DS-Bot failure is recorded on the invocation', async () => {
  const { e, api, agent } = await fixture({ reply: async () => { throw new Error('DS-Bot turn timed out') } })
  const { token } = await e['key-create']({ workspace_id: W, agent_id: agent.id, name: 'k' })
  const inv = await e.invoke({ token, agent_id: agent.id, prompt: 'x', idempotency_key: 'x'.repeat(16) })
  await Promise.all(api.inflight.values())
  const row = (await e.invocation({ token, id: inv.invocation.id })).invocation
  assert.equal(row.status, 'failed')
  assert.equal(row.error_code, 'timeout')
  assert.equal(row.reply, null)
})

test('agent-api loads through the extension point next to agents', async () => {
  process.env.FLYBOT_WORKSPACE_AUTOMATIONS_CLOCK = '0'
  const { table, loaded } = await loadFeatures({ dir: join(HERE, '../features'), identity: { instanceId: INSTANCE }, dataDir: mkdtempSync(join(tmpdir(), 'ot-api-load-')), log: () => {} })
  assert.ok(loaded.includes('agent-api') && loaded.includes('agents'))
  assert.ok(table['agent-api/invoke'])
})



test('v1 lists and creates keys in the legacy /v1 shape', async () => {
  const { e, agent } = await fixture()
  const listed = await e.v1({ method: 'GET', path: `/v1/workspaces/${W}/agents/${agent.id}/api-keys` })
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.items, [])
  const key = await e.v1({ method: 'POST', path: `/v1/workspaces/${W}/agents/${agent.id}/api-keys`, body: { name: 'ci', rate_per_minute: 10 } })
  assert.equal(key.status, 201)
  assert.match(key.body.token, /^ota_/)
  assert.ok(key.body.key.id)
})
