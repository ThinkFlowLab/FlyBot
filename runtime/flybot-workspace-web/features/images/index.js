// Generation and job state stay in the owner's DS-Bot. The finished image is
// stored through the same private media library as other works.
import { defineFeature } from '../../featurekit/feature.js'
import { idempotencyKey, newId, refuse, requireBodyKeys, validLongText } from '../../featurekit/http.js'
import { generateImage, IMAGE_SIZES } from './provider.js'

const W = '([0-9a-f]{32})'
const SCHEMA = `
CREATE TABLE image_jobs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, key TEXT NOT NULL, prompt TEXT NOT NULL, shape TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed')),
  created INTEGER NOT NULL, artifact_id TEXT, error TEXT, UNIQUE(workspace_id,key));
CREATE INDEX image_jobs_workspace ON image_jobs(workspace_id,created DESC,id);
CREATE INDEX image_jobs_queue ON image_jobs(state,created,id);
`
const messages = {
  unconfigured:'请先配置图片模型。',
  auth:'图片模型拒绝授权，请检查 API 密钥和模型权限。',
  busy:'图片模型暂时繁忙，请稍后重试。',
  interrupted:'图片任务因 DS-Bot 重启而中断，可以重新生成。',
  failed:'图片生成失败，请重试或检查图片模型配置。',
  storage:'图片已生成，但暂时无法保存到资料空间。',
}

async function canAccess(host, workspace) {
  const binding = await host.call('agents/personal-binding',{}).catch(() => null)
  if (binding?.workspace_id === workspace) return true
  const items = await host.call('teams/activeWorkspaces',{}).catch(() => [])
  return Array.isArray(items) && items.some(item => item?.id === workspace)
}

function view(row) {
  return {id:row.id,prompt:row.prompt,shape:row.shape,state:row.state,artifact_id:row.artifact_id,
    ...(row.error ? {message:messages[row.error] || messages.failed} : {})}
}

async function imageRoute(req, workspace, id) {
  if (req.queryString) refuse(400,'invalid','无效的图片请求。')
  if (req.method === 'GET') {
    if (!await canAccess(req.host,workspace)) refuse(404,'not_found','无法访问当前工作区。')
    if (id) {
      const row = req.store.get('SELECT * FROM image_jobs WHERE workspace_id=? AND id=?',workspace,id)
      if (!row) refuse(404,'not_found','找不到图片任务。')
      return {body:{job:view(row)}}
    }
    const key = req.headers.has('idempotency-key') ? idempotencyKey(req.headers) : null
    const row = key
      ? req.store.get('SELECT * FROM image_jobs WHERE workspace_id=? AND key=?',workspace,key)
      : req.store.get('SELECT * FROM image_jobs WHERE workspace_id=? ORDER BY created DESC,rowid DESC LIMIT 1',workspace)
    const config = await req.host.call('model-api/imageProvider',{}).catch(() => null)
    return {body:{configured:Boolean(config),job:row ? view(row) : null}}
  }
  if (req.method !== 'POST' || id) refuse(405,'method','该操作不可用。')
  const body = requireBodyKeys(await req.json(16384),['prompt','shape'])
  if (!validLongText(body.prompt,2000) || !body.prompt.trim() || typeof body.shape !== 'string' || !Object.hasOwn(IMAGE_SIZES,body.shape)) {
    refuse(400,'invalid','请输入不超过 2000 字的图片描述并选择比例。')
  }
  const prompt = body.prompt.trim()
  const key = idempotencyKey(req.headers)
  const find = () => req.store.get('SELECT * FROM image_jobs WHERE workspace_id=? AND key=?',workspace,key)
  const matched = row => {
    if (row.prompt !== prompt || row.shape !== body.shape) refuse(409,'conflict','这个请求标识已用于另一条图片描述。')
    return {status:202,body:{job:view(row)}}
  }
  if (!await canAccess(req.host,workspace)) refuse(404,'not_found','无法访问当前工作区。')
  const prior = find()
  if (prior) return matched(prior)
  if (!await req.host.call('model-api/imageProvider',{}).catch(() => null)) refuse(503,'image_unconfigured',messages.unconfigured)
  const result = req.store.transaction(() => {
    const current = find()
    if (current) return matched(current)
    const waiting = req.store.get("SELECT COUNT(*) AS total FROM image_jobs WHERE state IN ('queued','running')").total
    if (waiting >= 8) refuse(429,'busy','图片任务较多，请等待当前任务完成。')
    req.store.run("INSERT INTO image_jobs VALUES(?,?,?,?,?,'queued',?,NULL,NULL)",newId(),workspace,key,prompt,body.shape,req.now)
    return {status:202,body:{job:view(find())}}
  })
  await req.host.call('images/wake',{})
  return result
}

function worker({store,host}) {
  let running = false
  let timer = null
  const fill = (row,artifact,reason) => store.run(
    'UPDATE image_jobs SET state=?,artifact_id=?,error=? WHERE id=? AND state=\'running\'',
    artifact ? 'succeeded' : 'failed',artifact?.id ?? null,artifact ? null : reason,row.id)
  const destination = row => ({workspace_id:row.workspace_id,job_id:row.id})
  function schedule() {
    if (timer || running) return
    timer = setTimeout(() => {
      timer = null
      void run().catch(() => host.log?.('Image task worker failed'))
    },50)
    timer.unref?.()
  }
  async function run() {
    running = true
    try {
      for (const row of store.all("SELECT * FROM image_jobs WHERE state='running'")) {
        const artifact = await host.call('artifacts/generatedImage',destination(row)).catch(() => null)
        fill(row,artifact,'interrupted')
      }
      while (true) {
        const row = store.get("SELECT * FROM image_jobs WHERE state='queued' ORDER BY created,rowid LIMIT 1")
        if (!row) break
        store.run("UPDATE image_jobs SET state='running' WHERE id=?",row.id)
        const provider = await host.call('model-api/imageProvider',{}).catch(() => null)
        if (!provider) { fill(row,null,'unconfigured'); continue }
        let data
        try { data = await generateImage(provider,row) }
        catch (error) { fill(row,null,['auth','busy'].includes(error?.code) ? error.code : 'failed'); continue }
        try {
          const title = row.prompt.replace(/\s+/g,' ').slice(0,50).trim() || '生成图片'
          const artifact = await host.call('artifacts/generatedImage',{...destination(row),title,data})
          fill(row,artifact,'storage')
        } catch { fill(row,null,'storage') }
      }
    } finally { running = false }
  }
  schedule()
  return {
    async wake(_payload,call) { if (call?.internal) schedule() },
  }
}

export default defineFeature({
  name:'images', migrations:[SCHEMA], routes:[{
    pattern:new RegExp(`^/v1/workspaces/${W}/images(?:/${W})?$`), handle:imageRoute,
  }],
  endpoints:worker,
})
