// Legacy /v1 routes for /automations/ once the core stream flips that page
// into moved_pages. The browser shim (shell/dsbot-api.mjs) posts
// {endpoint:'automations/v1', payload:{method,path,body,idempotency_key}}.
import { FeatureError, HEX32, requireBodyKeys } from '../../featurekit/http.js'
import { createV1Endpoint } from '../../featurekit/v1.js'

const HEX = '([0-9a-f]{32})'

function wrap(fn) {
  return async (...args) => {
    try { return await fn(...args) } catch (error) {
      if (error instanceof FeatureError) throw error
      const code = String(error?.code ?? 'error').replace(/^automations\//, '')
      throw new FeatureError(error?.status ?? 500, code, error?.message ?? 'Request failed', error?.details)
    }
  }
}

export function automationsV1({ endpoints, log, personalBinding, readSavedWorks }) {
  const call = (name, payload) => endpoints[name](payload)

  async function withSavedWorks(result, workspace, automation) {
    const runs = result.items ?? [result.run]
    const eligible = runs.filter(run => run.status === 'succeeded')
    if (!readSavedWorks || !eligible.length) return result
    let receipts
    try {
      receipts = await readSavedWorks({workspace_id: workspace, automation_id: automation, run_ids: eligible.map(run => run.id)})
    } catch {
      // Opening an automation run does not depend on Space being available.
      return result
    }
    if (!Array.isArray(receipts?.items)) return result
    const saved = new Map(receipts.items
      .filter(work => typeof work?.id === 'string' && HEX32.test(work.id) && typeof work.title === 'string')
      .map(({run_id, id, title}) => [run_id, {id, title}]))
    const attach = run => run.status === 'succeeded' ? {...run, saved_work: saved.get(run.id) ?? null} : run
    return result.items ? {...result, items: runs.map(attach)} : {...result, run: attach(result.run)}
  }

  const routes = [
    { pattern: /^\/v1\/onboarding\/automations$/, handle: wrap(async (req) => {
      if (req.method !== 'POST' || req.query.size) throw new FeatureError(400, 'invalid', 'Invalid onboarding automation request')
      const { workspace_id, template_ids } = await req.json(4096)
      const binding = await personalBinding?.()
      if (!binding?.workspace_id) throw new FeatureError(503, 'unavailable', 'Personal workspace is still being initialized')
      if (workspace_id !== binding.workspace_id) throw new FeatureError(403, 'forbidden', 'Onboarding requires the personal workspace')
      if (!req.ownerUsername) throw new FeatureError(403, 'forbidden', 'Onboarding requires the workspace owner')
      const { status, created, skipped } = await call('createOnboarding', { workspace_id, template_ids, username: req.ownerUsername })
      return { status, body: { created, skipped } }
    }) },
    { pattern: /^\/v1\/automation-templates$/, handle: wrap(async () => ({ status: 200, body: await call('templates') })) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/automations/schedule-preview$`), handle: wrap(async (req, workspaceId) => {
      if (req.method !== 'POST' || req.query.size) throw new FeatureError(405, 'method', 'Only POST is supported')
      if (!req.ownerUsername) throw new FeatureError(403, 'forbidden', 'Schedule preview requires an authenticated owner')
      const {schedule} = requireBodyKeys(await req.json(2048), ['schedule'])
      const preview = await call('previewSchedule', {workspace_id:workspaceId, schedule})
      return {body:{...preview, workspace_id:workspaceId, viewer_username:req.ownerUsername}}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/automations/draft$`), handle: wrap(async (req, workspaceId) => {
      if (req.method !== 'POST' || req.query.size) throw new FeatureError(405, 'method', 'Only POST is supported')
      if (!req.ownerUsername) throw new FeatureError(403, 'forbidden', 'Drafts require an authenticated owner')
      const {description} = requireBodyKeys(await req.json(8192), ['description'])
      const draft = await call('prepareTaskDraft', {workspace_id:workspaceId, description})
      return {body:{...draft, workspace_id:workspaceId, viewer_username:req.ownerUsername}}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/automations/tick$`), handle: wrap(async (req, workspaceId) => {
      if (req.method !== 'POST' || req.query.size) throw new FeatureError(405, 'method', 'Only POST is supported')
      return { status: 200, body: await call('tick', { workspace_id: workspaceId }) }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/automations/${HEX}/run$`), handle: wrap(async (req, workspaceId, id) => {
      const key = req.headers.get('idempotency-key')
      if (req.method === 'GET' && !req.query.size) return { status: 200, body: await call('receipt', { workspace_id: workspaceId, id, idempotency_key: key }) }
      if (req.method !== 'POST' || req.query.size) throw new FeatureError(405, 'method', 'Only POST is supported')
      const {expected_revision} = requireBodyKeys(await req.json(512), ['expected_revision'])
      const result = await call('runNow', { workspace_id: workspaceId, id, idempotency_key: key, expected_revision })
      return { status: result.status, body: { run: result.run } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/automations/${HEX}/runs/${HEX}/(cancel|retry|artifact)$`), handle: wrap(async (req, workspaceId, id, runId, action) => {
      const payload = { workspace_id: workspaceId, id, run_id: runId, idempotency_key: req.headers.get('idempotency-key') }
      if (action === 'retry' && req.method === 'GET' && !req.query.size) return { status: 200, body: await call('receipt', payload) }
      if (req.method !== 'POST' || req.query.size) throw new FeatureError(405, 'method', 'Only POST is supported')
      if (action === 'artifact') {
        const {status, artifact} = await call('saveRun', payload)
        return {status, body: {artifact}}
      }
      const result = action === 'cancel' ? await call('cancel', payload)
        : await call('retry', {...payload, ...requireBodyKeys(await req.json(512), ['expected_revision'])})
      return { status: result.status ?? 200, body: { run: result.run, ...(result.retried ? { retried: result.retried } : {}) } }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/automations/${HEX}/runs/${HEX}/studio$`), handle: wrap(async (req, workspaceId, id, runId) => {
      const target = {workspace_id: workspaceId, id, run_id: runId}
      if (req.query.size) throw new FeatureError(400, 'invalid', 'Invalid studio request')
      if (req.method === 'GET') return {status: 200, body: await call('studioPreview', target)}
      const body = await req.json(512)
      if (Object.keys(body).length !== 1 || typeof body.review !== 'string' || !/^[a-f0-9]{64}$/.test(body.review)) {
        throw new FeatureError(400, 'invalid', 'Review the result before sharing')
      }
      return {status: 200, body: await call('studioPublish', {...target, review: body.review})}
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/automations/${HEX}/runs(?:/${HEX})?$`), handle: wrap(async (req, workspaceId, id, runId) => {
      if (runId) {
        const result = await call('run', { workspace_id: workspaceId, id, run_id: runId })
        return { status: 200, body: await withSavedWorks(result, workspaceId, id) }
      }
      const limit = req.query.get('limit')
      const result = await call('runs', { workspace_id: workspaceId, id, status: req.query.get('status') || undefined, cursor: req.query.get('cursor') || undefined, limit: limit ? Number(limit) : undefined })
      return { status: 200, body: await withSavedWorks(result, workspaceId, id) }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/automations/${HEX}/remove$`), handle: wrap(async (req, workspaceId, id) => {
      if (req.method !== 'POST' || req.query.size) throw new FeatureError(405, 'method', 'Only POST is supported')
      return { status: 200, body: await call('remove', { workspace_id: workspaceId, id }) }
    }) },
    { pattern: new RegExp(`^/v1/workspaces/${HEX}/automations(?:/${HEX})?$`), handle: wrap(async (req, workspaceId, id) => {
      if (!id && req.method === 'GET') {
        if (req.query.has('memory_action')) {
          const fields = ['memory_action', 'revision']
          if (req.query.size !== fields.length || fields.some(name => req.query.getAll(name).length !== 1)
            || !/^[1-9][0-9]*$/.test(req.query.get('revision'))) {
            throw new FeatureError(400, 'invalid', '请选择已保存的记忆行动项。')
          }
          if (!req.ownerUsername) throw new FeatureError(403, 'forbidden', 'Follow-up requires an authenticated owner')
          const body = await call('memoryFollowup', {workspace_id: workspaceId, action_id: req.query.get('memory_action'),
            revision: Number(req.query.get('revision'))})
          return {status: 200, body: {...body, viewer_username: req.ownerUsername}}
        }
        const fields = ['meeting', 'revision', 'action']
        if (fields.some(name => req.query.has(name))) {
          if (req.query.size !== fields.length || fields.some(name => req.query.getAll(name).length !== 1)
            || !/^[1-9][0-9]*$/.test(req.query.get('revision')) || !/^(?:0|[1-9][0-9]?)$/.test(req.query.get('action'))) {
            throw new FeatureError(400, 'invalid', '请选择已保存的行动项。')
          }
          if (!req.ownerUsername) throw new FeatureError(403, 'forbidden', 'Follow-up requires an authenticated owner')
          const body = await call('meetingFollowup', { workspace_id: workspaceId, meeting_id: req.query.get('meeting'),
            revision: Number(req.query.get('revision')), action_index: Number(req.query.get('action')) })
          return { status: 200, body: { ...body, viewer_username: req.ownerUsername } }
        }
        return { status: 200, body: await call('list', { workspace_id: workspaceId, q: req.query.get('q') || undefined, category: req.query.get('category') || undefined, username: req.ownerUsername }) }
      }
      if (!id && req.method === 'POST') {
        const body = await req.json()
        if (['source_meeting', 'source_memory_action'].some(name => Object.hasOwn(body, name)) && !req.ownerUsername) {
          throw new FeatureError(403, 'forbidden', 'Follow-up requires an authenticated owner')
        }
        const result = await call('create', { ...body, workspace_id: workspaceId, idempotency_key: req.headers.get('idempotency-key') })
        return { status: result.status ?? 201, body: { automation: result.automation, ...(result.sample_run ? {sample_run: result.sample_run} : {}) } }
      }
      if (id && req.method === 'GET') return { status: 200, body: await call('get', { workspace_id: workspaceId, id }) }
      if (id && req.method === 'POST') {
        const body = await req.json()
        return { status: 200, body: await call('update', { workspace_id: workspaceId, id, revision: body.revision, changes: body.changes }) }
      }
      throw new FeatureError(400, 'invalid', 'Invalid automation request')
    }) },
  ]
  return createV1Endpoint({ feature: 'automations', routes, context: { log } })
}
