import { defineFeature } from '../../featurekit/feature.js'
import { idempotencyKey, newId, refuse, requireBodyKeys, validLongText } from '../../featurekit/http.js'
import { generateWebsite } from './provider.js'

const SCHEMA = `
CREATE TABLE website_jobs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key TEXT NOT NULL, prompt TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
  created INTEGER NOT NULL, artifact_id TEXT, error TEXT, UNIQUE(workspace_id,key));
CREATE INDEX website_jobs_workspace ON website_jobs(workspace_id,created DESC);
CREATE INDEX website_jobs_queue ON website_jobs(state,created);
`
const PROMPT_MAX = 1600
const QUEUE_MAX = 4
const messages = {
  unconfigured: 'DS-Bot 暂时无法生成网站，请稍后再试。',
  uncertain: '上次生成中断，无法确认网站是否已生成。你可以重新发起生成。',
  failed: '网站生成失败，请调整描述后重试。',
  storage: '网站已生成，但暂时无法保存到资料空间。',
  access: '已无法访问任务所在的工作区。',
}

async function canAccess(host, workspace) {
  const binding = await host.call('agents/personal-binding', {}).catch(() => null)
  if (binding?.workspace_id === workspace) return true
  const workspaces = await host.call('teams/activeWorkspaces', {}).catch(() => [])
  return Array.isArray(workspaces) && workspaces.some(item => item?.id === workspace)
}

const configured = runtime => typeof runtime?.backgroundTextOnly === 'function'

function view(row) {
  return {
    id: row.id, prompt: row.prompt, state: row.state, artifact_id: row.artifact_id,
    ...(row.error ? { message: messages[row.error] || messages.failed } : {}),
  }
}

async function websiteRoute(req, workspace, id) {
  if (req.queryString) refuse(400, 'invalid', '无效的网站请求。')
  if (!await canAccess(req.host, workspace)) refuse(404, 'not_found', '无法访问当前工作区。')
  if (req.method === 'GET' && id) {
    const row = req.store.get('SELECT * FROM website_jobs WHERE workspace_id=? AND id=?', workspace, id)
    if (!row) refuse(404, 'not_found', '找不到网站生成任务。')
    return { body: { job: view(row) } }
  }
  if (req.method === 'GET') {
    const row = req.store.get('SELECT * FROM website_jobs WHERE workspace_id=? ORDER BY created DESC,rowid DESC LIMIT 1', workspace)
    return { body: { configured: configured(req.host.currentRuntime?.()), job: row ? view(row) : null } }
  }
  if (req.method !== 'POST' || id) refuse(405, 'method', '该操作不可用。')
  const body = requireBodyKeys(await req.json(16384), ['prompt'])
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt || !validLongText(prompt, PROMPT_MAX)) refuse(400, 'invalid', `请输入不超过 ${PROMPT_MAX} 字的网站描述。`)
  const key = idempotencyKey(req.headers)
  const find = () => req.store.get('SELECT * FROM website_jobs WHERE workspace_id=? AND key=?', workspace, key)
  const result = req.store.transaction(() => {
    const previous = find()
    if (previous) {
      if (previous.prompt !== prompt) refuse(409, 'conflict', '这个请求标识已用于其他网站描述。')
      return { status: 202, body: { job: view(previous) } }
    }
    if (!configured(req.host.currentRuntime?.())) refuse(503, 'website_unconfigured', messages.unconfigured)
    const waiting = req.store.get("SELECT COUNT(*) AS total FROM website_jobs WHERE state IN ('queued','running')").total
    if (waiting >= QUEUE_MAX) refuse(429, 'busy', '网站生成任务较多，请等待当前任务完成。')
    req.store.run(`INSERT INTO website_jobs (id,workspace_id,key,prompt,state,created) VALUES (?,?,?,?,'queued',?)`,
      newId(), workspace, key, prompt, req.now)
    return { status: 202, body: { job: view(find()) } }
  })
  void req.host.call('websites/wake', {}).catch(() => req.host.log?.('Website worker could not be notified'))
  return result
}

function worker({ store, host }) {
  let running = false
  let timer = null
  const address = row => ({ workspace_id: row.workspace_id, job_id: row.id })
  const findArtifact = row => host.call('artifacts/generatedWebsite', address(row)).catch(() => null)
  const finish = (row, artifact, reason) => store.run(
    "UPDATE website_jobs SET state=?,artifact_id=?,error=? WHERE id=? AND state='running'",
    artifact?.id ? 'succeeded' : 'failed', artifact?.id ?? null, artifact?.id ? null : reason, row.id)

  async function execute(row, runtime) {
    if (!await canAccess(host, row.workspace_id)) return finish(row, null, 'access')
    if (!configured(runtime)) return finish(row, null, 'unconfigured')
    let draft
    try { draft = await generateWebsite(runtime, row.prompt) }
    catch { return finish(row, null, 'failed') }
    if (!await canAccess(host, row.workspace_id)) return finish(row, null, 'access')
    const artifact = await host.call('artifacts/generatedWebsite', { ...address(row), ...draft })
      .catch(() => findArtifact(row))
    finish(row, artifact, 'storage')
  }

  async function drain() {
    running = true
    let waitingForRuntime = false
    try {
      // A running job may already have asked the model. Recover its saved artifact without another model call.
      for (const row of store.all("SELECT * FROM website_jobs WHERE state='running'")) {
        if (await canAccess(host, row.workspace_id)) finish(row, await findArtifact(row), 'uncertain')
        else finish(row, null, 'access')
      }
      while (true) {
        const row = store.get("SELECT * FROM website_jobs WHERE state='queued' ORDER BY created,rowid LIMIT 1")
        if (!row) break
        const runtime = host.currentRuntime?.()
        if (!runtime) {
          waitingForRuntime = true
          break
        }
        const claim = store.run("UPDATE website_jobs SET state='running' WHERE id=? AND state='queued'", row.id)
        if (claim.changes === 1) await execute(row, runtime)
      }
    } finally {
      running = false
      if (waitingForRuntime) schedule(1000)
    }
  }

  function schedule(delay = 0) {
    if (timer || running) return
    timer = setTimeout(() => {
      timer = null
      void drain().catch(() => host.log?.('Website worker failed'))
    }, delay)
    timer.unref?.()
  }

  schedule(100)
  return { async wake(_payload, call) { if (call?.internal) schedule() } }
}

export default defineFeature({
  name: 'websites', migrations: [SCHEMA], routes: [{
    pattern: /^\/v1\/workspaces\/([0-9a-f]{32})\/websites(?:\/([0-9a-f]{32}))?$/,
    handle: websiteRoute,
  }],
  endpoints: worker,
})
