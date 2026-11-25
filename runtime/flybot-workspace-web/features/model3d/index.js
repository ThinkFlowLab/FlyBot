// The queue, provider task IDs and finished works belong to this user's DS-Bot.
import { defineFeature } from '../../featurekit/feature.js'
import { digest, idempotencyKey, newId, refuse, requireBodyKeys, validLongText } from '../../featurekit/http.js'
import { MAX_MEDIA_BYTES } from '../artifacts/model.js'
import { sniffMime } from '../artifacts/render.js'
import { model3dProviderConfigured, model3dResult, submitModel3d } from './provider.js'

const ID = '([0-9a-f]{32})'
const SCHEMA = `
CREATE TABLE model3d_jobs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key TEXT NOT NULL, input_hash TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('text','image')), prompt TEXT NOT NULL,
  image_mime TEXT, image_base64 TEXT,
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
  stage TEXT CHECK(stage IN ('preview','refine','image')), progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  created INTEGER NOT NULL, next_check INTEGER NOT NULL, submitted INTEGER, preview_id TEXT, provider_id TEXT,
  artifact_id TEXT, error TEXT, UNIQUE(workspace_id,key));
CREATE INDEX model3d_jobs_workspace ON model3d_jobs(workspace_id,created DESC);
CREATE INDEX model3d_jobs_due ON model3d_jobs(state,next_check);
`
const JOB_FIELDS = 'id,prompt,source,state,stage,progress,artifact_id,error'
const MAX_IMAGE_BASE64 = Math.ceil(MAX_MEDIA_BYTES / 3) * 4
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const SUBMIT_WINDOW = 30_000
const FIRST_CHECK = 1_500
const POLL_INTERVAL = 5_000
const BUSY_BACKOFF = 15_000
const GENERATION_WINDOW = 30 * 60_000
const MAX_PENDING = 4
const messages = {
  unconfigured: '请先配置 3D 模型。',
  auth: 'Meshy 拒绝了这次请求，请检查 API 密钥和模型权限。',
  rejected: 'Meshy 拒绝了这次生成，请修改描述或更换参考图片。',
  busy: '3D 模型服务暂时繁忙，请稍后重试。',
  uncertain: '未能确认 3D 任务是否已经提交。请先在 Meshy 查看任务，再决定是否重新生成。',
  failed: '3D 生成失败，请检查描述、参考图片或模型配置。',
  timeout: '3D 任务等待超时。可在 Meshy 查看任务状态。',
  too_large: '生成的 3D 模型超过 8 MB，无法保存或发送。',
  storage: '3D 模型已生成，但暂时无法保存到资料空间。',
  workspace: '当前工作区不可访问。',
}

async function canAccess(host, workspace) {
  const binding = await host.call('agents/personal-binding', {}).catch(() => null)
  if (binding?.workspace_id === workspace) return true
  const workspaces = await host.call('teams/activeWorkspaces', {}).catch(() => [])
  return Array.isArray(workspaces) && workspaces.some(item => item?.id === workspace)
}

async function provider(host) {
  const config = await host.call('model-api/model3dProvider', {}).catch(() => null)
  return model3dProviderConfigured(config) ? config : null
}

function view(row) {
  const {id, prompt, source, state, stage, progress, artifact_id, error} = row
  return {id, prompt, source, state, stage, progress, artifact_id,
    ...(error ? {message: messages[error] ?? messages.failed} : {})}
}

function generationInput(body) {
  requireBodyKeys(body, ['prompt', 'image'])
  const hasPrompt = Object.hasOwn(body, 'prompt')
  const hasImage = Object.hasOwn(body, 'image')
  if (hasPrompt === hasImage) refuse(400, 'invalid', '请输入模型描述或选择一张参考图片。')
  if (hasPrompt) {
    if (!validLongText(body.prompt, 800) || !body.prompt.trim()) refuse(400, 'invalid', '请输入不超过 800 字的模型描述。')
    const prompt = body.prompt.trim()
    return {source: 'text', prompt, mime: null, base64: null, hash: digest('text:' + prompt)}
  }
  const {mime, data: base64} = requireBodyKeys(body.image, ['mime', 'data'])
  if (!IMAGE_MIMES.has(mime) || typeof base64 !== 'string' || !base64) {
    refuse(400, 'invalid', '请选择 PNG、JPEG 或 WebP 参考图片。')
  }
  if (base64.length > MAX_IMAGE_BASE64) refuse(413, 'too_large', '参考图片不能超过 2 MB。')
  const data = Buffer.from(base64, 'base64')
  if (data.length > MAX_MEDIA_BYTES) refuse(413, 'too_large', '参考图片不能超过 2 MB。')
  if (data.toString('base64') !== base64 || sniffMime(data) !== mime) {
    refuse(400, 'invalid', '参考图片格式有误，请重新选择。')
  }
  return {source: 'image', prompt: '', mime, base64, hash: digest(mime + ':' + base64)}
}

async function modelRoute(req, workspace, id) {
  if (req.queryString) refuse(400, 'invalid', '无效的 3D 请求。')
  if (!await canAccess(req.host, workspace)) refuse(404, 'not_found', messages.workspace)
  if (req.method === 'GET' && id) {
    const row = req.store.get(`SELECT ${JOB_FIELDS} FROM model3d_jobs WHERE workspace_id=? AND id=?`, workspace, id)
    if (!row) refuse(404, 'not_found', '找不到 3D 任务。')
    return {body: {job: view(row)}}
  }
  if (req.method === 'GET') {
    const config = await provider(req.host)
    const row = req.store.get(`SELECT ${JOB_FIELDS} FROM model3d_jobs WHERE workspace_id=?
      ORDER BY created DESC,rowid DESC LIMIT 1`, workspace)
    return {body: {configured: Boolean(config), job: row ? view(row) : null}}
  }
  if (req.method !== 'POST' || id) refuse(405, 'method', '该操作不可用。')
  const input = generationInput(await req.json(MAX_IMAGE_BASE64 + 4096))
  const key = idempotencyKey(req.headers)
  const find = () => req.store.get(`SELECT ${JOB_FIELDS},input_hash FROM model3d_jobs WHERE workspace_id=? AND key=?`, workspace, key)
  const replay = row => {
    if (row.input_hash !== input.hash) refuse(409, 'conflict', '这个请求标识已用于另一项 3D 任务。')
    return {status: 202, body: {job: view(row)}}
  }
  const previous = find()
  if (previous) return replay(previous)
  if (!await provider(req.host)) refuse(503, 'model3d_unconfigured', messages.unconfigured)
  const result = req.store.transaction(() => {
    const current = find()
    if (current) return replay(current)
    const waiting = req.store.get("SELECT COUNT(*) AS total FROM model3d_jobs WHERE state IN ('queued','running')").total
    if (waiting >= MAX_PENDING) refuse(429, 'busy', '当前 3D 任务较多，请等待任务完成。')
    req.store.run(`INSERT INTO model3d_jobs(id,workspace_id,key,input_hash,source,prompt,image_mime,image_base64,state,created,next_check)
      VALUES(?,?,?,?,?,?,?,?,'queued',?,?)`, newId(), workspace, key, input.hash, input.source, input.prompt, input.mime, input.base64,
      req.now, Date.now())
    return {status: 202, body: {job: view(find())}}
  })
  void req.host.call('model3d/wake', {}).catch(() => req.host.log?.('3D task worker could not be notified'))
  return result
}

function worker({store, host}) {
  let running = false
  let timer = null
  let nextRun

  const destination = row => ({workspace_id: row.workspace_id, job_id: row.id})
  const savedWork = row => host.call('artifacts/generatedModel3d', destination(row)).catch(() => null)

  function finish(row, artifact, reason) {
    const success = Boolean(artifact?.id)
    store.run(`UPDATE model3d_jobs SET state=?,artifact_id=?,error=?,progress=?, image_mime=NULL,image_base64=NULL
      WHERE id=? AND state IN ('queued','running') AND stage IS ? AND submitted IS ? AND provider_id IS ?`,
    success ? 'succeeded' : 'failed', artifact?.id ?? null, success ? null : reason, success ? 100 : row.progress,
    row.id, row.stage, row.submitted, row.provider_id)
  }

  function reschedule(row, wait, progress = row.progress) {
    store.run(`UPDATE model3d_jobs SET next_check=?,progress=MAX(progress,?)
      WHERE id=? AND state='running' AND stage=? AND provider_id=?`,
    Date.now() + wait, progress, row.id, row.stage, row.provider_id)
  }

  async function submit(row, stage) {
    if (!await canAccess(host, row.workspace_id)) return finish(row, null, 'workspace')
    const config = await provider(host)
    if (!config) return finish(row, null, 'unconfigured')
    const now = Date.now()
    // Record that the paid request is in flight before issuing it. Input bytes are
    // only needed while queued. A restart cannot replay an ambiguous submission.
    const claim = store.run(`UPDATE model3d_jobs SET state='running',stage=?,submitted=?,next_check=?,
        image_mime=NULL,image_base64=NULL WHERE id=? AND submitted IS NULL
        AND (state='queued' OR (state='running' AND stage='refine' AND provider_id IS NULL))`,
    stage, now, now + SUBMIT_WINDOW, row.id)
    if (!claim.changes) return
    let id
    try { id = await submitModel3d(config, stage, row) }
    catch (error) { return finish({...row, stage, submitted: now}, null, error?.code ?? 'uncertain') }
    store.run(`UPDATE model3d_jobs SET provider_id=?,next_check=?
      WHERE id=? AND state='running' AND stage=? AND submitted=? AND provider_id IS NULL`,
    id, Date.now() + FIRST_CHECK, row.id, stage, now)
  }

  async function poll(row) {
    if (!await canAccess(host, row.workspace_id)) return finish(row, null, 'workspace')
    if (row.stage !== 'preview') {
      const saved = await savedWork(row)
      if (saved?.id) return finish(row, saved)
    }
    if (!row.provider_id) return finish(row, null, 'uncertain')
    if (Date.now() - row.submitted >= GENERATION_WINDOW) return finish(row, null, 'timeout')
    const config = await provider(host)
    if (!config) return finish(row, null, 'unconfigured')
    let result
    try { result = await model3dResult(config, row.stage, row.provider_id) }
    catch (error) {
      if (error?.code === 'busy' || error?.code === 'temporary') {
        reschedule(row, error.code === 'busy' ? BUSY_BACKOFF : POLL_INTERVAL)
        return
      }
      return finish(row, null, error?.code ?? 'failed')
    }
    if (!result.done) {
      const progress = row.stage === 'image' ? result.progress
        : Math.floor(result.progress / 2) + (row.stage === 'refine' ? 50 : 0)
      reschedule(row, POLL_INTERVAL, progress)
      return
    }
    if (row.stage === 'preview') {
      // Keep the finished preview ID before scheduling the next paid stage.
      store.run(`UPDATE model3d_jobs SET stage='refine',progress=50,preview_id=provider_id,provider_id=NULL,
        submitted=NULL,next_check=? WHERE id=? AND state='running' AND stage='preview'`, Date.now(), row.id)
      return
    }
    if (!await canAccess(host, row.workspace_id)) return finish(row, null, 'workspace')
    const title = Array.from(row.prompt.replace(/\s+/g, ' ')).slice(0, 30).join('').trim() || '图片生成的 3D 模型'
    const artifact = await host.call('artifacts/generatedModel3d', {...destination(row), title, data: result.data})
      .catch(() => savedWork(row))
    finish(row, artifact, 'storage')
  }

  function schedule() {
    if (running) return
    const due = store.get("SELECT MIN(next_check) AS due FROM model3d_jobs WHERE state IN ('queued','running')").due
    if (due === null || (timer && nextRun <= due)) return
    clearTimeout(timer)
    nextRun = due
    timer = setTimeout(() => {
      timer = null
      void drain().catch(() => host.log?.('3D task worker failed'))
    }, Math.max(25, due - Date.now()))
    timer.unref?.()
  }

  async function drain() {
    running = true
    try {
      while (true) {
        const row = store.get(`SELECT * FROM model3d_jobs WHERE state IN ('queued','running') AND next_check<=?
          ORDER BY next_check,rowid LIMIT 1`, Date.now())
        if (!row) break
        if (row.state === 'queued') await submit(row, row.source === 'image' ? 'image' : 'preview')
        else if (row.stage === 'refine' && row.submitted === null) await submit(row, 'refine')
        else await poll(row)
      }
    } finally {
      running = false
      schedule()
    }
  }

  schedule()
  return {async wake(_payload, call) { if (call?.internal) schedule() }}
}

export default defineFeature({
  name: 'model3d', migrations: [SCHEMA], routes: [{
    pattern: new RegExp(`^/v1/workspaces/${ID}/models-3d(?:/${ID})?$`), handle: modelRoute,
  }],
  endpoints: worker,
})
