// Skill runs and readiness on this user's DS-Bot (moved from the platform's
// skill_execution.py, which queued central runtime tasks). A run is one native
// DS-Bot turn with the skill attached to the Main Bot; history lives on this volume.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { compatHandler } from '../../lib/b4/compat.js'
import { Fault } from '../../lib/b4/http.js'
import { openJsonStore } from '../../lib/b4/json-store.js'
import { importJsonBundles } from '../../lib/b4/importer.js'

const IDEM = /^[A-Za-z0-9_-]{16,64}$/
const SKILL = /^[a-z][a-z0-9-]{0,63}$/
const TASK = /^[0-9a-f]{32}$/
const MAX_RUNS = 50
const scopeOk = scope => scope === 'account' || /^(?:automation:)?[0-9a-f]{32}:[0-9a-f]{32}$/.test(scope || '')

function archivedHistory(host) {
  const store = openJsonStore(host.featureDir(), 'archived-skill-runs', () => ({ runs: {} }))
  const { instanceId, routingInstanceId } = host.identity ?? {}
  return () => {
    const target = routingInstanceId ?? instanceId
    if (!TASK.test(target ?? '')) return {}
    importJsonBundles({
      host, feature: { name: 'skill-run-history', importTables: { skill_run_history: [] } }, store,
      apply(draft, { skill_run_history }) {
        if (!Array.isArray(skill_run_history)) throw new Error('missing skill history')
        for (const row of skill_run_history) {
          if (!TASK.test(row.id) || !scopeOk(row.scope)
            || !SKILL.test(row.skill_id) || !['succeeded', 'failed'].includes(row.status)
            || !Number.isSafeInteger(row.created) || !Number.isSafeInteger(row.updated)
            || typeof row.prompt !== 'string' || (row.result_text !== null && typeof row.result_text !== 'string')) {
            throw new Error('invalid historical skill record')
          }
          draft.runs[row.id] ??= {
            task: {
              id: row.id, kind: 'infer', status: row.status, prompt: row.prompt,
              created: row.created, updated: row.updated,
              result: row.result_text === null ? null : { text: row.result_text },
            },
            loaded: row.loaded === 1, scope: row.scope, skill_id: row.skill_id,
            skills: [{ id: row.skill_id }], historical: true,
          }
        }
      },
      log: () => host.log('skill history import rejected; bundle retained'),
    })
    return store.read().runs ?? {}
  }
}

export function skillRunsV1(host, { userSkillName }) {
  const archived = archivedHistory(host)
  const file = () => join(host.featureDir(), 'skill-runs.json')
  const load = () => { try { return JSON.parse(readFileSync(file(), 'utf8')).runs ?? [] } catch { return [] } }
  const save = (runs) => {
    const tmp = `${file()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, runs: runs.slice(0, MAX_RUNS) }), { mode: 0o600 })
    renameSync(tmp, file())
  }
  const update = (id, patch) => save(load().map((r) => (r.task.id === id ? { ...r, task: { ...r.task, ...patch } } : r)))
  const find = id => load().find(run => run.task.id === id) ?? archived()[id]
  const services = () => host.currentRuntime?.() ?? null
  const attached = async (skillId) => {
    const s = services()
    if (!s || typeof s.mainBot !== 'function') return false
    const caps = s.rt.botOf(await s.mainBot())?.capabilities ?? []
    return caps.includes(userSkillName(skillId))
  }
  const readiness = async (scope) => {
    const s = services()
    const base = { scope, ready: false, runtime_url: '/settings', model_url: '/settings#model-api-form', hostname: 'ds-bot' }
    if (!s || typeof s.chatTurn !== 'function') return { ...base, code: 'runtime_offline' }
    const settings = await host.call('model-api/get')
    if (!settings.effective?.api_key_set) return { ...base, code: 'no_model' }
    await host.call('skills/materialForScope', { scope })
    return { ...base, ready: true, code: 'ready', model_source: settings.effective.source || 'ds-bot' }
  }
  const view = (r) => ({ ...r, verified: r.loaded && r.task.status === 'succeeded' && !!String(r.task.result?.text ?? '').trim() })

  return compatHandler([
    { method: 'GET', path: /^\/v1\/skills\/scopes$/, handle: async () => [200, { items: [{ scope: 'account', kind: 'account', label: '我的账户', workspace_id: null }] }] },
    {
      method: 'GET', path: /^\/v1\/skills\/readiness$/,
      async handle({ query }) {
        const scope = new URLSearchParams(query || '').get('scope') || 'account'
        if (!scopeOk(scope)) throw new Fault(404, 'not_found', 'Scope not available')
        return [200, await readiness(scope)]
      },
    },
    {
      method: 'GET', path: /^\/v1\/skills\/runs$/,
      async handle() {
        const native = load()
        const ids = new Set(native.map(run => run.task.id))
        const runs = [...native, ...Object.values(archived()).filter(run => !ids.has(run.task.id))]
        runs.sort((a, b) => b.task.created - a.task.created)
        return [200, { items: runs.slice(0, MAX_RUNS).map(view) }]
      },
    },
    {
      method: 'POST', path: /^\/v1\/skills\/runs$/,
      async handle({ body, idempotency_key: key }) {
        if (!IDEM.test(String(key || ''))) throw new Fault(400, 'invalid', 'Supply a 16–64 character Idempotency-Key')
        const scope = body?.scope, skillId = body?.skill_id, prompt = body?.prompt
        if (!scopeOk(scope) || !SKILL.test(String(skillId || '')) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
          throw new Fault(400, 'invalid', 'Provide a scope, installed skill and 1–4000 character task')
        }
        const keyHash = createHash('sha256').update('skill-run:' + key).digest('hex')
        const requestHash = createHash('sha256').update(JSON.stringify([scope, skillId, prompt])).digest('hex')
        const prior = load().find((r) => r.key_hash === keyHash)
        if (prior) {
          if (prior.request_hash !== requestHash) throw new Fault(409, 'conflict', 'Idempotency key was used for a different skill run')
          return [200, view(prior)]
        }
        const material = await host.call('skills/materialForScope', { scope })
        if (!material.items.some(i => i.id === skillId) && !(scope === 'account' && await attached(skillId))) throw new Fault(409, 'skill_not_installed', 'Install the current skill version in this scope first')
        const ready = await readiness(scope)
        if (!ready.ready) throw new Fault(409, ready.code, 'Skill runtime is not ready: ' + ready.code)
        const id = randomBytes(16).toString('hex')
        const now = Math.floor(Date.now() / 1000)
        const record = {
          task: { id, kind: 'infer', status: 'claimed', prompt, created: now, updated: now, result: null },
          scope, skill_id: skillId, loaded: true, skills: [{ id: skillId }], key_hash: keyHash, request_hash: requestHash,
        }
        save([record, ...load()])
        const selected = material.items.find(i => i.id === skillId)
        const text = selected ? `${selected.content}\n\nTask:\n${prompt}` : `Use your "${skillId}" skill for this task.\n\n${prompt}`
        Promise.resolve()
          .then(async () => {
            const agentScope = /^([0-9a-f]{32}):([0-9a-f]{32})$/.exec(scope)
            if (agentScope) {
              const turn = await host.call('agents/turn', { agent_id: agentScope[2], key: `skill-run:${id}`, text, request_id: `ot-skill:${id}` })
              return { text: turn.text, sessionId: turn.session_id, turnId: turn.turn_id }
            }
            return services().chatTurn(`skill-run:${id}`, text, `ot-skill:${id}`)
          })
          .then((turn) => update(id, { status: load().find((r) => r.task.id === id)?.task.status === 'cancelled' ? 'cancelled' : 'succeeded', result: { text: String(turn?.text ?? '') }, updated: Math.floor(Date.now() / 1000) }))
          .catch((error) => update(id, { status: 'failed', error: String(error?.message ?? error).slice(0, 300), updated: Math.floor(Date.now() / 1000) }))
        return [201, view(record)]
      },
    },
    {
      method: 'POST', path: /^\/v1\/skills\/runs\/([0-9a-f]{32})\/cancel$/,
      async handle({ match }) {
        const run = find(match[1])
        if (!run) throw new Fault(404, 'not_found', 'Task not found')
        if (['queued', 'claimed'].includes(run.task.status)) update(run.task.id, { status: 'cancelled' })
        return [200, { task: find(match[1]).task }]
      },
    },
    {
      method: 'POST', path: /^\/v1\/skills\/runs\/([0-9a-f]{32})\/artifact$/,
      async handle({ match, body }) {
        const run = find(match[1])
        if (!run || !TASK.test(match[1])) throw new Fault(404, 'not_found', 'Task not found')
        if (!view(run).verified) throw new Fault(409, 'not_ready', 'Only a verified skill result can be saved')
        const out = await host.call('artifacts/create', {
          workspace_id: body?.workspace_id, kind: 'document', title: `技能结果：${run.skill_id}`.slice(0, 80),
          body: run.task.result.text, idempotency_key: ('skill-' + run.task.id).slice(0, 64),
        })
        return [201, out]
      },
    },
  ])
}
