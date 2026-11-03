// Keep original records authoritative; only pre-cutover Project work may use legacy drivers.
import { createHash, randomUUID } from 'node:crypto'
import { ownEntry } from './store.js'

const VERSION = 'project-compatibility/v1'
const fail = message => Object.assign(new Error(message), { code: 'bot/compatibility' })
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = task => ({ taskId: task.id, projectId: task.projectId, requesterId: task.requesterId ?? null, createdAt: task.createdAt ?? null })
const active = task => !['accepted', 'cancelled', 'failed'].includes(task.status)

export function install(rt) {
  rt.projectEffects.register('compat.cutover', { run: row => ({ cutoverId: row.payload.cutoverId, count: row.payload.count, sha256: row.payload.sha256 }) })
  function recover() {
    if (!rt.sharedProjectMode?.() || rt.readOnly?.() !== undefined || rt.state.projectCompatibility) return false
    const cutoverId = randomUUID(), projects = {}
    for (const project of Object.values(rt.state.projects ?? {})) {
      const tasks = Object.values(rt.state.tasks ?? {}).filter(task => task.projectId === project.id && !task.projectTask).sort((a, b) => a.id.localeCompare(b.id))
      const sha256 = hash(tasks.map(identity))
      for (const task of tasks) task.legacyProject = { version: VERSION, cutoverId, ...identity(task) }
      const effect = rt.projectEffects.stage({ kind: 'compat.cutover', projectId: project.id, key: cutoverId, payload: { cutoverId, count: tasks.length, sha256 } })
      projects[project.id] = { effect, count: tasks.length, sha256 }
    }
    rt.state.projectCompatibility = { version: VERSION, cutoverId, createdAt: Date.now(), projects }
    return true
  }
  function committed(projectId, cutover, project) {
    const effect = ownEntry(rt.state.projectEffects ?? {}, project?.effect?.id)
    return Boolean(effect?.kind === 'compat.cutover' && effect.projectId === projectId && effect.payload.cutoverId === cutover?.cutoverId
      && effect.payload.count === project.count && effect.payload.sha256 === project.sha256 && rt.projectEffects.intentCommitted(project.effect))
  }
  function legacyAllowed(task) {
    if (task.projectTask) return false
    if (!task.projectId || !rt.sharedProjectMode?.() && !rt.state.projectCompatibility) return true
    const cutover = rt.state.projectCompatibility, marker = task.legacyProject
    const project = ownEntry(cutover?.projects ?? {}, task.projectId)
    return Boolean(cutover?.version === VERSION && marker?.version === VERSION && marker.cutoverId === cutover.cutoverId
      && hash(identity(task)) === hash({ taskId: marker.taskId, projectId: marker.projectId, requesterId: marker.requesterId, createdAt: marker.createdAt })
      && project && committed(task.projectId, cutover, project))
  }
  function requireLegacy(task) {
    if (!legacyAllowed(task)) throw fail('Project Task contract requires Chief admission; unknown post-cutover legacy work cannot execute')
  }
  function registerContinuation(original, child) {
    requireLegacy(original)
    if (!original.projectId || !rt.state.projectCompatibility) return
    if (child.reworkOf !== original.id || child.projectId !== original.projectId || child.requesterId !== original.requesterId) throw fail('Legacy continuation identity changed')
    child.legacyProject = { version: VERSION, cutoverId: rt.state.projectCompatibility.cutoverId, ...identity(child), derivedFrom: original.id }
  }
  function report(projectId, body, actor) {
    rt.requireProjectAccess(actor, projectId)
    const limit = body.limit ?? 50, offset = body.offset ?? 0
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw fail('Invalid compatibility page')
    const tasks = Object.values(rt.state.tasks ?? {}).filter(task => task.projectId === projectId).sort((a, b) => a.id.localeCompare(b.id))
    const classify = task => task.projectTask ? 'contract' : legacyAllowed(task) ? 'legacy' : 'held'
    const totals = { contract: 0, legacy: 0, held: 0, active: 0 }
    for (const task of tasks) { ++totals[classify(task)]; if (active(task)) ++totals.active }
    const cutover = rt.state.projectCompatibility, proof = ownEntry(cutover?.projects ?? {}, projectId)
    return { version: VERSION, cutoverId: cutover?.cutoverId ?? null, committed: committed(projectId, cutover, proof),
      baseline: proof ? { count: proof.count, sha256: proof.sha256 } : null, totals,
      tasks: tasks.slice(offset, offset + limit).map(task => ({ id: task.id, projectId, parentId: task.parentId ?? null, status: task.status, mode: classify(task),
        attemptId: task.deliveryAttemptId ?? null, parentPresent: !task.parentId || ownEntry(rt.state.tasks ?? {}, task.parentId)?.projectId === projectId })),
      page: { offset, limit, total: tasks.length, nextOffset: offset + limit < tasks.length ? offset + limit : null } }
  }
  rt.projectCompatibility = { recover, legacyAllowed, requireLegacy, registerContinuation, report }
}
