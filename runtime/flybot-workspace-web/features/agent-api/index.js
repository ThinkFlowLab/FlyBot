// External Agent API inside the user's own DS-Bot (batch B2; moved from
// flybot-workspace/gateway.py + gateway_dispatch in app.py).
//
// Keys, rate windows and invocations live in this DS-Bot's storage. A key reads
// `ota_<instance id>_<secret>`: the instance id is a routing hint only (the platform
// forwards `/v1/gateway/*` for that id to this DS-Bot); the secret is verified here
// against a SHA-256 digest and never stored. An invocation is a native DS-Bot turn
// of the named agent (agents/turn), run in the background and polled by id.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { openDatabase, newId } from '../../src/store.js'
import { agentApiV1 } from './v1.js'

export const MAX_KEYS_PER_AGENT = 10
export const DEFAULT_RATE = 10
const NAME = /^[^\u0000-\u001f\u007f]{1,60}$/
const ID = /^[0-9a-f]{32}$/
const IDEM = /^[A-Za-z0-9_-]{16,64}$/
const TOKEN = /^ota_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/
const PROMPT_MAX = 8000
const sha = (t) => createHash('sha256').update(String(t)).digest('hex')
const now = () => Math.floor(Date.now() / 1000)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL CHECK(scope IN ('invoke')), rate_per_minute INTEGER NOT NULL CHECK(rate_per_minute BETWEEN 1 AND 60),
  created INTEGER NOT NULL, last_used INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS api_rate (key_id TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(key_id, window));
CREATE TABLE IF NOT EXISTS api_invocations (id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  error_code TEXT, body TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', created INTEGER NOT NULL, updated INTEGER NOT NULL,
  key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, UNIQUE(key_id, key_hash));
`

export function fail(code, message, status) { throw Object.assign(new Error(message), { code: `agent-api/${code}`, status }) }

export const keyView = (r) => ({ id: r.id, workspace_id: r.workspace_id, agent_id: r.agent_id, name: r.name, scope: r.scope,
  rate_per_minute: r.rate_per_minute, created: r.created, last_used: r.last_used, revoked: !!r.revoked })
export const invocationView = (r) => ({ id: r.id, agent_id: r.agent_id, status: r.status, error_code: r.error_code, created: r.created,
  updated: r.updated, reply: r.status === 'succeeded' ? r.body : null, engine: 'ds-bot' })

export function createAgentApi({ db, host, clock = now }) {
  db.exec(SCHEMA)
  const one = (sql, ...a) => db.prepare(sql).get(...a)
  const all = (sql, ...a) => db.prepare(sql).all(...a)
  const run = (sql, ...a) => db.prepare(sql).run(...a)
  const inflight = new Map()
  // The edge routes by the manager's instance id. A migrated volume keeps
  // its existing DS-Bot identity, which can differ from that routing id.
  const routingId = host.identity.routingInstanceId ?? host.identity.instanceId
  const ws = (p) => { if (typeof p?.workspace_id !== 'string' || !ID.test(p.workspace_id)) fail('invalid', 'workspace_id required', 400); return p.workspace_id }
  const agentOf = async (workspaceId, agentId) => (await host.call('agents/get', { workspace_id: workspaceId, id: agentId })).agent

  // Constant-time check of a presented key; 401 for anything that does not match.
  function authenticate(token) {
    const m = typeof token === 'string' ? TOKEN.exec(token) : null
    if (!m || m[1] !== routingId) fail('unauthorized', 'Invalid API key', 401)
    const digest = sha(token)
    const row = one('SELECT * FROM api_keys WHERE token_hash=?', digest)
    if (!row || row.revoked || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(digest))) fail('unauthorized', 'Invalid API key', 401)
    return row
  }

  function consumeRate(key) {
    const window = Math.floor(clock() / 60)
    run('DELETE FROM api_rate WHERE key_id=? AND window<?', key.id, window)
    const row = one('SELECT count FROM api_rate WHERE key_id=? AND window=?', key.id, window)
    if (row && row.count >= key.rate_per_minute) return false
    run('INSERT INTO api_rate VALUES(?,?,1) ON CONFLICT(key_id, window) DO UPDATE SET count=count+1', key.id, window)
    return true
  }

  function execute(id) {
    if (inflight.has(id)) return inflight.get(id)
    const job = (async () => {
      const inv = one('SELECT * FROM api_invocations WHERE id=?', id)
      if (!inv || inv.status !== 'queued') return
      run("UPDATE api_invocations SET status='running', updated=? WHERE id=?", clock(), id)
      try {
        const reply = await host.call('agents/turn', { agent_id: inv.agent_id, key: `api:${inv.key_id}:${id}`, text: inv.prompt, request_id: `ot-api:${id}` })
        run("UPDATE api_invocations SET status='succeeded', body=?, meta=?, updated=? WHERE id=? AND status='running'", reply.text, JSON.stringify({ session_id: reply.session_id ?? null, turn_id: reply.turn_id ?? null }), clock(), id)
      } catch (error) {
        const code = /not-found$/.test(String(error?.code)) ? 'no_agent' : /runtime-unavailable$/.test(String(error?.code)) ? 'runtime_failed'
          : /empty-reply$/.test(String(error?.code)) ? 'empty_reply' : /timed out/i.test(String(error?.message)) ? 'timeout' : 'runtime_failed'
        run("UPDATE api_invocations SET status='failed', error_code=?, updated=? WHERE id=? AND status='running'", code, clock(), id)
      }
    })().finally(() => inflight.delete(id))
    inflight.set(id, job)
    return job
  }

  const endpoints = {
    // Owner-side key management (browser, through the platform gateway).
    async keys(p) {
      const workspaceId = ws(p)
      await agentOf(workspaceId, p.agent_id)
      return { items: all('SELECT * FROM api_keys WHERE workspace_id=? AND agent_id=? ORDER BY created, id', workspaceId, p.agent_id).map(keyView) }
    },
    async 'key-create'(p) {
      const workspaceId = ws(p)
      const agent = await agentOf(workspaceId, p.agent_id)
      if (agent.archived) fail('conflict', 'Agent is archived', 409)
      const name = typeof p.name === 'string' ? p.name.trim() : ''
      if (!NAME.test(name)) fail('invalid', 'Provide a key name (1–60 characters)', 400)
      const rate = p.rate_per_minute ?? DEFAULT_RATE
      if (!Number.isInteger(rate) || rate < 1 || rate > 60) fail('invalid', 'rate_per_minute must be 1–60', 400)
      if (one('SELECT COUNT(*) AS n FROM api_keys WHERE agent_id=? AND revoked=0', agent.id).n >= MAX_KEYS_PER_AGENT) fail('quota', 'API key capacity reached', 429)
      const token = `ota_${routingId}_${randomBytes(32).toString('base64url')}`
      const id = newId()
      run('INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,?,?,0)', id, workspaceId, agent.id, name, sha(token), 'invoke', rate, clock(), null)
      // Shown once; only the digest is kept.
      return { status: 201, key: keyView(one('SELECT * FROM api_keys WHERE id=?', id)), token }
    },
    async 'key-revoke'(p) {
      const workspaceId = ws(p)
      const row = typeof p.key_id === 'string' && ID.test(p.key_id) ? one('SELECT * FROM api_keys WHERE id=? AND workspace_id=? AND agent_id=?', p.key_id, workspaceId, p.agent_id) : undefined
      if (!row) fail('not-found', 'API key not found', 404)
      run('UPDATE api_keys SET revoked=1 WHERE id=?', row.id)
      return { key: keyView(one('SELECT * FROM api_keys WHERE id=?', row.id)) }
    },
    // External caller side (platform forwards Authorization: Bearer as `token`).
    async invoke(p) {
      const key = authenticate(p.token)
      if (p.agent_id !== key.agent_id) fail('forbidden', 'This key cannot invoke that agent', 403)
      const prompt = typeof p.prompt === 'string' ? p.prompt.trim() : ''
      if (!prompt || prompt.length > PROMPT_MAX) fail('invalid', 'prompt must be 1–8000 characters', 400)
      if (!IDEM.test(String(p.idempotency_key ?? ''))) fail('invalid', 'Supply a 16–64 character Idempotency-Key', 400)
      const keyHash = sha(p.idempotency_key)
      const requestHash = sha(prompt)
      const prior = one('SELECT * FROM api_invocations WHERE key_id=? AND key_hash=?', key.id, keyHash)
      if (prior) {
        if (prior.request_hash !== requestHash) fail('conflict', 'Idempotency key was used for a different request', 409)
        return { status: 200, invocation: invocationView(prior) }
      }
      if (!consumeRate(key)) fail('rate_limited', 'Rate limit exceeded', 429)
      const id = newId()
      const t = clock()
      run('INSERT INTO api_invocations (id, key_id, agent_id, prompt, status, created, updated, key_hash, request_hash) VALUES(?,?,?,?,?,?,?,?,?)', id, key.id, key.agent_id, prompt, 'queued', t, t, keyHash, requestHash)
      run('UPDATE api_keys SET last_used=? WHERE id=?', t, key.id)
      void execute(id)
      return { status: 202, invocation: invocationView(one('SELECT * FROM api_invocations WHERE id=?', id)) }
    },
    async invocation(p) {
      const key = authenticate(p.token)
      const row = typeof p.id === 'string' && ID.test(p.id) ? one('SELECT * FROM api_invocations WHERE id=? AND key_id=?', p.id, key.id) : undefined
      if (!row) fail('not-found', 'Invocation not found', 404)
      return { invocation: invocationView(row) }
    },
  }
  endpoints.v1 = agentApiV1({ endpoints, log: host?.log })
  return { endpoints, inflight, execute }
}

export default async function agentApi(host) {
  const db = await openDatabase(host, 'agent-api.sqlite3')
  const api = createAgentApi({ db, host })
  // Invocations a previous process left queued/running are re-run once.
  db.exec("UPDATE api_invocations SET status='queued' WHERE status='running'")
  host.runtime({ timeoutMs: 10 * 60_000 }).then(() => {
    for (const { id } of db.prepare("SELECT id FROM api_invocations WHERE status='queued'").all()) void api.execute(id)
  }, () => {})
  const wrapped = {}
  for (const [name, fn] of Object.entries(api.endpoints)) wrapped[name] = async (payload) => fn(payload ?? {})
  return { pages: [], endpoints: wrapped }
}
