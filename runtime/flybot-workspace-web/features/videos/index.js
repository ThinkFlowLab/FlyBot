// Video tasks and downloaded media stay inside the user's DS-Bot.
import { defineFeature } from '../../featurekit/feature.js'
import { idempotencyKey, newId, refuse, requireBodyKeys, validLongText } from '../../featurekit/http.js'
import { submitVideo, videoResult, VIDEO_RATIOS } from './provider.js'

const W = '([0-9a-f]{32})'
const SCHEMA = `
CREATE TABLE video_jobs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key TEXT NOT NULL, prompt TEXT NOT NULL, shape TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
  created INTEGER NOT NULL, next_check INTEGER NOT NULL, submitted INTEGER, provider_id TEXT, artifact_id TEXT, error TEXT,
  UNIQUE(workspace_id,key));
CREATE INDEX video_jobs_workspace ON video_jobs(workspace_id,created DESC,id);
CREATE INDEX video_jobs_due ON video_jobs(state,next_check);
`
const SUBMIT_TIMEOUT = 30_000
const POLL_INTERVAL = 5_000
const BUSY_BACKOFF = 15_000
const GENERATION_WINDOW = 30 * 60_000
const MAX_PENDING = 4
const messages = {
  unconfigured: '请先配置视频模型。',
  auth: '视频模型拒绝授权，请检查 API 密钥和模型权限。',
  busy: '视频模型暂时繁忙，请稍后重试。',
  uncertain: '未能确认视频任务是否已提交。请先在 Runway 查看任务，再决定是否重新生成。',
  failed: '视频生成失败，请检查提示词或视频模型配置。',
  timeout: '视频生成超时。可在 Runway 查看任务状态。',
  too_large: '视频超过 8 MB，无法保存或发送。',
  storage: '视频已生成，但暂时无法保存到资料空间。',
  workspace: '当前工作区不可访问。',
}

async function canAccess(host, workspace) {
  const binding = await host.call('agents/personal-binding',{}).catch(() => null)
  if (binding?.workspace_id === workspace) return true
  const items = await host.call('teams/activeWorkspaces',{}).catch(() => [])
  return items.some(item => item.id === workspace)
}

function provider(host) {
  return host.call('model-api/videoProvider',{}).then(config => {
    if (config?.provider === 'runway' && config.model === 'gen4.5' && typeof config.api_key === 'string' && config.api_key) return config
    return null
  }).catch(() => null)
}

function view(row) {
  return {id:row.id,prompt:row.prompt,shape:row.shape,state:row.state,artifact_id:row.artifact_id,
    ...(row.error ? {message:messages[row.error] || messages.failed} : {})}
}

async function videoRoute(req, workspace, id) {
  if (req.queryString) refuse(400,'invalid','无效的视频请求。')
  if (!await canAccess(req.host,workspace)) refuse(404,'not_found',messages.workspace)
  if (req.method === 'GET' && id) {
    const row = req.store.get('SELECT * FROM video_jobs WHERE workspace_id=? AND id=?',workspace,id)
    if (!row) refuse(404,'not_found','找不到视频任务。')
    return {body:{job:view(row)}}
  }
  if (req.method === 'GET') {
    const config = await provider(req.host)
    const row = req.store.get('SELECT * FROM video_jobs WHERE workspace_id=? ORDER BY created DESC,rowid DESC LIMIT 1',workspace)
    return {body:{configured:Boolean(config),job:row ? view(row) : null}}
  }
  if (req.method !== 'POST' || id) refuse(405,'method','该操作不可用。')
  const body = requireBodyKeys(await req.json(8192),['prompt','shape'])
  if (!validLongText(body.prompt,1000) || !body.prompt.trim() || typeof body.shape !== 'string' || !Object.hasOwn(VIDEO_RATIOS,body.shape)) {
    refuse(400,'invalid','请输入不超过 1000 字的视频描述并选择比例。')
  }
  const prompt = body.prompt.trim()
  const key = idempotencyKey(req.headers)
  const find = () => req.store.get('SELECT * FROM video_jobs WHERE workspace_id=? AND key=?',workspace,key)
  const matched = row => {
    if (row.prompt !== prompt || row.shape !== body.shape) refuse(409,'conflict','这个请求标识已用于另一条视频描述。')
    return {status:202,body:{job:view(row)}}
  }
  const prior = find()
  if (prior) return matched(prior)
  if (!await provider(req.host)) refuse(503,'video_unconfigured',messages.unconfigured)
  const result = req.store.transaction(() => {
    const current = find()
    if (current) return matched(current)
    const waiting = req.store.get("SELECT COUNT(*) AS total FROM video_jobs WHERE state IN ('queued','running')").total
    if (waiting >= MAX_PENDING) refuse(429,'busy','当前视频任务较多，请等待任务完成。')
    req.store.run(`INSERT INTO video_jobs(id,workspace_id,key,prompt,shape,state,created,next_check)
      VALUES(?,?,?,?,?,'queued',?,?)`,newId(),workspace,key,prompt,body.shape,req.now,Date.now())
    return {status:202,body:{job:view(find())}}
  })
  await req.host.call('videos/wake',{})
  return result
}

function worker({store,host}) {
  let running = false
  let timer = null
  let nextRun
  const destination = row => ({workspace_id:row.workspace_id,job_id:row.id})
  const advance = (row, wait) => store.run(
    "UPDATE video_jobs SET next_check=? WHERE id=? AND state='running'",Date.now()+wait,row.id)
  const finish = (row, artifact, reason) => store.run(
    "UPDATE video_jobs SET state=?,artifact_id=?,error=? WHERE id=? AND state='running'",
    artifact?.id ? 'succeeded' : 'failed',artifact?.id ?? null,artifact?.id ? null : reason,row.id)

  async function submit(row) {
    if (!store.run(`UPDATE video_jobs SET state='running', submitted=?, next_check=?
        WHERE id=? AND state='queued'`, Date.now(),Date.now()+SUBMIT_TIMEOUT,row.id).changes) return
    if (!await canAccess(host,row.workspace_id)) { finish(row,null,'workspace'); return }
    const config = await provider(host)
    if (!config) { finish(row,null,'unconfigured'); return }
    let id
    try {
      id = await submitVideo(config,row)
    } catch (error) {
      finish(row,null,error?.code ?? 'uncertain')
      return
    }
    store.run(`UPDATE video_jobs SET provider_id=?,next_check=? WHERE id=? AND state='running'`,
      id,Date.now()+POLL_INTERVAL,row.id)
  }

  async function poll(row) {
    if (!await canAccess(host,row.workspace_id)) { finish(row,null,'workspace'); return }
    // A crash after writing the artifact can be reconciled without re-downloading it.
    const saved = await host.call('artifacts/generatedVideo',destination(row)).catch(() => null)
    if (saved?.id) { finish(row,saved); return }
    // No provider ID after the submission window means the POST may have arrived.
    // Never issue another paid request for this job.
    if (!row.provider_id) { finish(row,null,'uncertain'); return }
    if (Date.now() - row.submitted >= GENERATION_WINDOW) { finish(row,null,'timeout'); return }
    const config = await provider(host)
    if (!config) { finish(row,null,'unconfigured'); return }
    let data
    try {
      data = await videoResult(config,row.provider_id)
    } catch (error) {
      if (error?.code === 'busy' || error?.code === 'temporary') {
        advance(row,error.code === 'busy' ? BUSY_BACKOFF : POLL_INTERVAL)
      } else {
        finish(row,null,error?.code ?? 'failed')
      }
      return
    }
    if (!data) { advance(row,POLL_INTERVAL); return }
    if (!await canAccess(host,row.workspace_id)) { finish(row,null,'workspace'); return }
    try {
      const title = Array.from(row.prompt.replace(/\s+/g,' ')).slice(0,50).join('').trim() || '生成视频'
      const artifact = await host.call('artifacts/generatedVideo',{...destination(row),title,data})
      finish(row,artifact,'storage')
    } catch {
      finish(row,null,'storage')
    }
  }

  function schedule() {
    if (running) return
    const due = store.get("SELECT MIN(next_check) AS due FROM video_jobs WHERE state IN ('queued','running')").due
    if (due === null || (timer && nextRun <= due)) return
    clearTimeout(timer)
    nextRun = due
    timer = setTimeout(() => {
      timer = null
      void drain().catch(() => host.log?.('Video task worker failed'))
    },Math.max(25,due-Date.now()))
    timer.unref?.()
  }

  async function drain() {
    running = true
    try {
      while (true) {
        const row = store.get("SELECT * FROM video_jobs WHERE state IN ('queued','running') AND next_check<=? ORDER BY next_check,rowid LIMIT 1",Date.now())
        if (!row) break
        if (row.state === 'queued') await submit(row)
        else await poll(row)
      }
    } finally {
      running = false
      schedule()
    }
  }

  schedule()
  return {async wake(_payload,call) { if (call?.internal) schedule() }}
}

export default defineFeature({
  name:'videos', migrations:[SCHEMA], routes:[{
    pattern:new RegExp(`^/v1/workspaces/${W}/videos(?:/${W})?$`), handle:videoRoute,
  }],
  endpoints:worker,
})
