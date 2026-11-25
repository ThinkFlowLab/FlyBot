// Official per-user import bundle (flybot_workspace/dsbot_bundle.py, format
// flybot-workspace-dsbot-import v1). The platform exports only this account's rows
// and delivers the file into /data/flybot-workspace/import/; defineFeature-style
// features pick those up automatically. This feature is not on featurekit yet,
// so host.migrate(bundle) and automations/import accept the same shape.
//
// After a successful import the current schedule slot is marked skipped, so the
// DS-Bot clock will not fire that slot again. The platform must stop the legacy
// server scheduler for this user at the same cutover (flip the feature or stop
// ticking), or both clocks could still fire.
import { createHash } from 'node:crypto'
import { dueAt, normalizeSchedule, validSchedule } from './schedule.js'

export const DOCUMENTATION = {
  format: 'flybot-workspace-dsbot-import',
  version: 1,
  feature: 'automations',
  tables: {
    automations: 'all automations in workspaces this account owns',
    automation_editors: 'editor fields keyed by automation_id (optional)',
    automation_runs: 'historical runs; queued rows are recorded as skipped/migrated and are not executed',
  },
  after_import: 'Current due slot is marked skipped (no double-fire in DS-Bot). Platform must stop the server scheduler for this user at the same cutover.',
}

const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

export function verifyOfficial(bundle) {
  if (!bundle || bundle.format !== 'flybot-workspace-dsbot-import' || bundle.version !== 1) throw Object.assign(new Error('unsupported bundle format'), { code: 'automations/invalid', status: 400 })
  if (bundle.feature !== 'automations') throw Object.assign(new Error('bundle feature mismatch'), { code: 'automations/invalid', status: 400 })
  const tables = {}, manifest = bundle.manifest ?? {}, raw = bundle.tables ?? {}
  for (const [name, text] of Object.entries(raw)) {
    if (typeof text !== 'string' || manifest[name]?.sha256 !== sha256(text)) throw Object.assign(new Error(`table ${name} digest mismatch`), { code: 'automations/invalid', status: 400 })
    const rows = JSON.parse(text)
    if (!Array.isArray(rows) || rows.length !== manifest[name].rows) throw Object.assign(new Error(`table ${name} row count mismatch`), { code: 'automations/invalid', status: 400 })
    tables[name] = rows
  }
  return tables
}

export async function importOfficialBundle(endpoints, bundle) {
  const tables = verifyOfficial(bundle)
  const automationsById = new Map((tables.automations ?? []).map(row => [row.id, row]))
  for (const row of tables.automation_runs ?? []) {
    if (automationsById.get(row.automation_id)?.workspace_id !== row.workspace_id) throw new Error('run ownership mismatch')
  }
  const editors = new Map((tables.automation_editors ?? []).map((row) => [row.automation_id, row]))
  const automations = (tables.automations ?? []).map((row) => {
    const editor = editors.get(row.id) ?? {}
    let schedule = row.schedule
    if (typeof schedule === 'string') try { schedule = JSON.parse(schedule) } catch { schedule = null }
    let participants = row.participants
    if (typeof participants === 'string') try { participants = JSON.parse(participants) } catch { participants = [] }
    participants = (Array.isArray(participants) ? participants : []).map((item) => typeof item === 'string' ? { username: item } : item)
    let agents = editor.agents ?? []
    if (typeof agents === 'string') try { agents = JSON.parse(agents) } catch { agents = [] }
    return {
      id: row.id, workspace_id: row.workspace_id, title: row.title, prompt: row.prompt, template_id: row.template_id,
      schedule, participants, enabled: !!row.enabled, revision: row.revision, created: row.created, updated: row.updated,
      intent: editor.intent ?? '', scope: editor.scope ?? 'once', agents, compiled: !!editor.compiled,
    }
  })
  const result = endpoints.import({ automations })
  // Historical runs: record finished ones; never execute a queued legacy run
  // (the server may already have fired it, or still will until cutover).
  const runs = tables.automation_runs ?? []
  if (runs.length && typeof endpoints.importRuns === 'function') endpoints.importRuns({ runs })
  return result
}

// Used by importOfficialBundle when the feature exposes it.
export function recordLegacyRuns(db, { runs, clock = () => Math.floor(Date.now() / 1000) }) {
  const insert = db.prepare(`INSERT OR IGNORE INTO ot_automation_runs
    (id,automation_id,workspace_id,due_at,started,finished,status,error_code,dispatch,attempt_of)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
  let imported = 0
  for (const row of runs) {
    if (!row?.id || !row.automation_id) continue
    const stored = row.status === 'queued' ? 'skipped' : (row.status ?? 'skipped')
    const error = row.status === 'queued' ? 'migrated' : (row.error_code ?? null)
    let dispatch
    try { dispatch = JSON.parse(row.dispatch) } catch { dispatch = {} }
    insert.run(row.id, row.automation_id, row.workspace_id, Number(row.due_at) || 0, Number(row.started) || clock(),
      row.finished ?? clock(), stored, error, JSON.stringify({ ...dispatch, backend: 'legacy' }), null)
    imported += 1
  }
  return imported
}

export { validSchedule, normalizeSchedule, dueAt }
