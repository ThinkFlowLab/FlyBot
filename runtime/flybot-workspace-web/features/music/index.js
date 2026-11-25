import { defineFeature } from '../../featurekit/feature.js'
import { idempotencyKey, newId, refuse, requireBodyKeys, validLongText } from '../../featurekit/http.js'
import { generateMusic, MUSIC_DURATIONS, musicProviderConfigured } from './provider.js'

const W = '([0-9a-f]{32})'
const SCHEMA = `
CREATE TABLE music_jobs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key TEXT NOT NULL, prompt TEXT NOT NULL,
  duration INTEGER NOT NULL CHECK(duration IN (15,30,60)), instrumental INTEGER NOT NULL CHECK(instrumental IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
  created INTEGER NOT NULL, artifact_id TEXT, error TEXT, UNIQUE(workspace_id,key));
CREATE INDEX music_jobs_workspace ON music_jobs(workspace_id,created DESC);
CREATE INDEX music_jobs_queue ON music_jobs(state,created);
`
const messages = {
  unconfigured: '请先配置音乐模型。',
  auth: '音乐模型拒绝授权，请检查 API 密钥和音乐模型权限。',
  busy: '音乐模型暂时繁忙，请稍后再试。',
  uncertain: '无法确认音乐任务是否完成。请先在 ElevenLabs 查看任务和用量，再决定是否重新生成。',
  failed: '音乐生成失败，请检查提示词和音乐模型配置。',
  storage: '音乐已生成，但暂时无法保存到资料空间。',
  access: '已无法访问任务所在的工作区。',
}

async function canAccess(host, workspace) {
  const binding = await host.call('agents/personal-binding', {}).catch(() => null)
  if (binding?.workspace_id === workspace) return true
  const workspaces = await host.call('teams/activeWorkspaces', {}).catch(() => [])
  return Array.isArray(workspaces) && workspaces.some(item => item?.id === workspace)
}

async function resolveProvider(host) {
  const config = await host.call('model-api/musicProvider', {}).catch(() => null)
  return musicProviderConfigured(config) ? config : null
}

function view(row) {
  return {
    id: row.id, prompt: row.prompt, duration: row.duration, instrumental: Boolean(row.instrumental),
    state: row.state, artifact_id: row.artifact_id,
    ...(row.error ? { message: messages[row.error] || messages.failed } : {}),
  }
}

async function musicRoute(req, workspace, id) {
  if (req.queryString) refuse(400, 'invalid', '无效的音乐请求。')
  if (!await canAccess(req.host, workspace)) refuse(404, 'not_found', '无法访问当前工作区。')
  if (req.method === 'GET' && id) {
    const row = req.store.get('SELECT * FROM music_jobs WHERE workspace_id=? AND id=?', workspace, id)
    if (!row) refuse(404, 'not_found', '找不到音乐任务。')
    return { body: { job: view(row) } }
  }
  if (req.method === 'GET') {
    const config = await resolveProvider(req.host)
    const row = req.store.get('SELECT * FROM music_jobs WHERE workspace_id=? ORDER BY created DESC,rowid DESC LIMIT 1', workspace)
    return { body: { configured: Boolean(config), job: row ? view(row) : null } }
  }
  if (req.method !== 'POST' || id) refuse(405, 'method', '该操作不可用。')
  const body = requireBodyKeys(await req.json(16384), ['prompt', 'duration', 'instrumental'])
  if (!validLongText(body.prompt, 2000) || !body.prompt.trim() || !MUSIC_DURATIONS.has(body.duration) || typeof body.instrumental !== 'boolean') {
    refuse(400, 'invalid', '请输入不超过 2000 字的音乐描述，选择时长和是否仅生成纯音乐。')
  }
  const prompt = body.prompt.trim()
  const instrumental = Number(body.instrumental)
  const key = idempotencyKey(req.headers)
  const find = () => req.store.get('SELECT * FROM music_jobs WHERE workspace_id=? AND key=?', workspace, key)
  const replay = (row) => {
    if (row.prompt !== prompt || row.duration !== body.duration || row.instrumental !== instrumental) {
      refuse(409, 'conflict', '这个请求标识已用于其他音乐生成参数。')
    }
    return { status: 202, body: { job: view(row) } }
  }
  const previous = find()
  if (previous) return replay(previous)
  if (!await resolveProvider(req.host)) refuse(503, 'music_unconfigured', messages.unconfigured)
  const result = req.store.transaction(() => {
    const current = find()
    if (current) return replay(current)
    const waiting = req.store.get("SELECT COUNT(*) AS total FROM music_jobs WHERE state IN ('queued','running')").total
    if (waiting >= 4) refuse(429, 'busy', '音乐任务较多，请等待当前任务完成。')
    req.store.run("INSERT INTO music_jobs VALUES(?,?,?,?,?,?,'queued',?,NULL,NULL)", newId(), workspace, key, prompt, body.duration, instrumental, req.now)
    return { status: 202, body: { job: view(find()) } }
  })
  void req.host.call('music/wake', {}).catch(() => req.host.log?.('Music task worker could not be notified'))
  return result
}

function worker({ store, host }) {
  let running = false
  let timer = null

  const address = row => ({ workspace_id: row.workspace_id, job_id: row.id })
  const findArtifact = row => host.call('artifacts/generatedMusic', address(row)).catch(() => null)
  const finish = (row, artifact, reason) => store.run(
    "UPDATE music_jobs SET state=?,artifact_id=?,error=? WHERE id=? AND state='running'",
    artifact?.id ? 'succeeded' : 'failed', artifact?.id ?? null, artifact?.id ? null : reason, row.id)

  async function execute(row) {
    if (!await canAccess(host, row.workspace_id)) return finish(row, null, 'access')
    const provider = await resolveProvider(host)
    if (!provider) return finish(row, null, 'unconfigured')
    let data
    try { data = await generateMusic(provider, row) }
    catch (error) { return finish(row, null, Object.hasOwn(messages, error?.code) ? error.code : 'failed') }
    if (!await canAccess(host, row.workspace_id)) return finish(row, null, 'access')
    const title = Array.from(row.prompt.replace(/\s+/g, ' ')).slice(0, 30).join('').trim() || '生成音乐'
    const artifact = await host.call('artifacts/generatedMusic', { ...address(row), title, data })
      .catch(() => findArtifact(row))
    finish(row, artifact, 'storage')
  }

  async function run() {
    running = true
    try {
      for (const row of store.all("SELECT * FROM music_jobs WHERE state='running'")) {
        // A running request may already have been billed. Recover the saved work without another provider call.
        if (await canAccess(host, row.workspace_id)) finish(row, await findArtifact(row), 'uncertain')
        else finish(row, null, 'access')
      }
      while (true) {
        const row = store.get("SELECT * FROM music_jobs WHERE state='queued' ORDER BY created,rowid LIMIT 1")
        if (!row) break
        const claim = store.run("UPDATE music_jobs SET state='running' WHERE id=? AND state='queued'", row.id)
        if (claim.changes === 1) await execute(row)
      }
    } finally { running = false }
  }

  function schedule(delay = 0) {
    if (timer || running) return
    timer = setTimeout(() => {
      timer = null
      void run().catch(() => host.log?.('Music task worker failed'))
    }, delay)
    timer.unref?.()
  }

  schedule(100)
  return { async wake(_payload, call) { if (call?.internal) schedule() } }
}

export default defineFeature({
  name: 'music', migrations: [SCHEMA], routes: [{
    pattern: new RegExp(`^/v1/workspaces/${W}/music(?:/${W})?$`), handle: musicRoute,
  }],
  endpoints: worker,
})
