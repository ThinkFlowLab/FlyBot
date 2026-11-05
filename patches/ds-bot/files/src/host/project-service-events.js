import { executionMetadataView } from './project-service-views.js'
// A committed read model over the original Store. No event reception grants
// initiative, and private conversations/credentials never enter this projection.
import { createHash } from 'node:crypto'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const copy = value => structuredClone(value)
const own = (table, id) => table && Object.hasOwn(table, id) ? table[id] : undefined
const text = value => typeof value === 'string' ? value.slice(0, 1000) : ''
const fail = (message, code = 'bot/invalid') => Object.assign(new Error(message), { code })
const VERSION = 'project-event/v1'
function projections(state) {
  const rows = new Map()
  for (const row of Object.values(state.projects ?? {})) {
    if (!row?.id) continue
    const data = { id: row.id, name: text(row.name), status: row.status, goal: text(row.goal), scope: text(row.scope), repository: row.repository ?? null, roleDefinitionRevision: own(state.projectAgentDefinitions, row.id)?.revision ?? 1 }
    rows.set(`project:${row.id}`, { projectId: row.id, entityType: 'project', id: row.id, data, fingerprint: hash([data, row.roles ?? {}, row.repositories ?? []]) })
  }
  for (const row of Object.values(state.tasks ?? {})) {
    if (!row?.projectId || !own(state.projects, row.projectId)) continue
    const c = row.collaboration, data = { id: row.id, projectId: row.projectId, title: text(row.title), status: row.status,
      generation: c?.generation ?? null, collaborationStatus: c?.status ?? null, claimId: c?.claim?.id ?? null, workerId: c?.claim?.workerId ?? null, botId: c?.botId ?? null, attemptId: row.deliveryAttemptId ?? null,
      admission: row.projectTask?.admission.status ?? null, requirementsRevision: row.projectTask?.requirements.revision ?? null,
      waitStatus: row.projectTask?.wait?.status ?? null, block: Boolean(c?.block || row.projectTask?.block), resultDecisionId: row.completedBy?.decisionId ?? null }
    rows.set(`task:${row.id}`, { projectId: row.projectId, entityType: 'task', id: row.id, data, fingerprint: hash([data, row.note ?? '', row.criteria ?? '', row.projectTask?.requirements ?? null]) })
  }
  for (const row of Object.values(state.projectAttempts ?? {})) {
    const task = own(state.tasks, row.taskId)
    if (!task || task.projectId !== row.projectId || !own(state.projects, row.projectId)) continue
    const data = { id: row.id, taskId: row.taskId, projectId: row.projectId, status: row.status, candidateSha: row.candidateSha ?? null,
      tests: row.evidence?.tests ? { sha: row.evidence.tests.sha, passed: row.evidence.tests.passed === true } : null,
      review: row.evidence?.review ? { sha: row.evidence.review.sha, verdict: row.evidence.review.verdict } : null,
      publication: row.pr ? { number: row.pr.number, sha: row.pr.sha } : null, stopping: Boolean(row.cancelRequested) }
    rows.set(`attempt:${row.id}`, { projectId: row.projectId, entityType: 'attempt', id: row.id, data, fingerprint: hash(data) })
  }
  for (const row of Object.values(state.projectRoleProposals ?? {})) {
    if (!row?.projectId || !own(state.projects, row.projectId)) continue
    const data = { id: row.id, projectId: row.projectId, role: row.role, action: row.action, status: row.status, baseRevision: row.baseRevision, createdAt: row.createdAt ?? null, decisionAt: row.decision?.at ?? null }
    rows.set(`role-proposal:${row.id}`, { projectId: row.projectId, entityType: 'role-proposal', id: row.id, data, fingerprint: hash(data) })
  }
  for (const row of Object.values(state.projectWarnings ?? {})) {
    if (!row?.projectId || !own(state.projects, row.projectId)) continue
    const data = { id: row.id, projectId: row.projectId, taskId: row.taskId ?? null, kind: row.kind, at: row.at, supersededBy: row.supersededBy ?? null, delivery: row.delivery ? { kind: row.delivery.kind, memberId: row.delivery.memberId ?? null } : null }
    rows.set(`warning:${row.id}`, { projectId: row.projectId, entityType: 'warning', id: row.id, data, fingerprint: hash(data) })
  }
  for (const [namespace, entityType] of [['projectHarnessWorkers', 'execution'], ['projectNativeWorkers', 'execution'], ['projectResourceLeases', 'resource'], ['projectTaskInputs', 'input']]) {
    for (const row of Object.values(state[namespace] ?? {})) {
      const attempt = own(state.projectAttempts, row.attemptId)
      const task = own(state.tasks, row.taskId ?? attempt?.taskId)
      if (!task || task.projectId !== row.projectId || row.chiefRunId || !own(state.projects, row.projectId)) continue
      const data = { id: row.id, projectId: row.projectId, taskId: task.id, attemptId: row.attemptId ?? null, status: row.status,
        ...(entityType === 'execution' ? executionMetadataView(state, row) : entityType === 'input' ? { kind: row.kind, sha256: row.sha256, deliveries: row.deliveries?.length ?? 0, readConfirmed: row.deliveries?.some(delivery => Boolean(delivery.readAt)) ?? false } : { role: row.role ?? null, resourceId: row.resourceId ?? null, generation: row.generation ?? null, pending: row.pending ? { id: row.pending.id, kind: row.pending.kind } : null }) }
      rows.set(`${entityType}:${row.id}`, { projectId: row.projectId, entityType, id: row.id, data, fingerprint: hash(data) })
    }
  }
  return rows
}
export function createProjectServiceEvents({ maxPerProject = 1024, maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxPerProject) || maxPerProject < 1 || maxPerProject > 4096 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000) throw fail('Invalid Project event retention policy')
  let committed = { projections: new Map(), streams: {}, events: {} }
  const epoch = (state, projectId) => hash([VERSION, state.workspaceId ?? 'legacy', projectId, own(state.projects, projectId)?.createdAt ?? 0]).slice(0, 32)
  function streamFor(state, projectId, streams) {
    const prior = own(streams, projectId)
    if (prior) return prior
    const stream = { epoch: epoch(state, projectId), nextSequence: 1, floor: 0, revision: 0, lastAt: 0 }
    Object.defineProperty(streams, projectId, { value: stream, enumerable: true, writable: true, configurable: true })
    return stream
  }
  function load(state) {
    const streams = copy(state.projectServiceEventStreams ?? {}), events = copy(state.projectServiceEvents ?? {})
    for (const row of Object.values(state.projects ?? {})) if (row?.id) streamFor(state, row.id, streams)
    for (const [projectId, stream] of Object.entries(streams)) if (!/^[a-f0-9]{32}$/.test(stream.epoch) || !Number.isSafeInteger(stream.nextSequence) || !Number.isSafeInteger(stream.floor) || stream.floor < 0 || stream.nextSequence <= stream.floor || !Number.isSafeInteger(stream.revision) || stream.revision < 0 || stream.lastAt !== undefined && (!Number.isSafeInteger(stream.lastAt) || stream.lastAt < 0)) throw fail(`Project event stream metadata is malformed: ${projectId}`)
    for (const row of Object.values(events)) if (row.version !== VERSION || !own(streams, row.projectId) || row.epoch !== streams[row.projectId].epoch || !Number.isSafeInteger(row.sequence) || row.sequence <= streams[row.projectId].floor || row.sequence >= streams[row.projectId].nextSequence) throw fail('Project event record is outside its committed stream')
    for (const [projectId, stream] of Object.entries(streams)) {
      const rows = Object.values(events).filter(row => row.projectId === projectId).sort((a, b) => a.sequence - b.sequence)
      if (rows.length !== stream.nextSequence - stream.floor - 1 || rows.some((row, index) => row.sequence !== stream.floor + index + 1 || !Number.isSafeInteger(row.at) || row.at < 0 || index && row.at < rows[index - 1].at)) throw fail('Committed Project events have a gap, duplicate or invalid timestamp')
      stream.lastAt = Math.max(stream.lastAt ?? 0, rows.at(-1)?.at ?? 0)
    }
    committed = { projections: projections(state), streams, events }
  }
  function prepare(snapshot) {
    const nextProjections = projections(snapshot), streams = copy(committed.streams), events = copy(committed.events), changes = [], touched = new Set()
    for (const [key, row] of nextProjections) if (committed.projections.get(key)?.fingerprint !== row.fingerprint) changes.push({ ...row, operation: 'upsert' })
    for (const [key, row] of committed.projections) if (!nextProjections.has(key)) changes.push({ ...row, operation: 'delete' })
    for (const row of changes) {
      const stream = streamFor(snapshot, row.projectId, streams)
      if (!touched.has(row.projectId)) { ++stream.revision; touched.add(row.projectId) }
      const sequence = stream.nextSequence++, event = { version: VERSION, projectId: row.projectId, epoch: stream.epoch, sequence,
        revision: stream.revision, at: Math.max(stream.lastAt ?? 0, now()), type: `${row.entityType}.${row.operation === 'delete' ? 'deleted' : 'changed'}`, entityType: row.entityType, entityId: row.id,
        data: row.operation === 'delete' ? { id: row.id } : row.data }
      stream.lastAt = event.at
      Object.defineProperty(events, hash([row.projectId, stream.epoch, sequence]), { value: event, enumerable: true, writable: true, configurable: true })
    }
    for (const [projectId, stream] of Object.entries(streams)) {
      const rows = Object.entries(events).filter(([, row]) => row.projectId === projectId).sort((a, b) => a[1].sequence - b[1].sequence)
      const retained = rows.filter(([, row]) => row.at >= now() - maxAgeMs).slice(-maxPerProject)
      const keep = new Set(retained.map(([key]) => key))
      for (const [key, row] of rows) if (!keep.has(key)) { stream.floor = Math.max(stream.floor, row.sequence); delete events[key] }
    }
    snapshot.projectServiceEventStreams = streams
    snapshot.projectServiceEvents = events
    return { snapshot, committed: { projections: nextProjections, streams, events } }
  }
  function saved(prepared) { committed = prepared.committed }
  function cursor(projectId, stream, sequence) { return Buffer.from(JSON.stringify({ v: 1, p: projectId, e: stream.epoch, s: sequence })).toString('base64url') }
  function streamOf(projectId) {
    const stream = own(committed.streams, projectId)
    if (!stream) throw fail('Project has no committed event snapshot', 'bot/not-found')
    return stream
  }
  function query(projectId, { after, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('Invalid event page limit')
    const stream = streamOf(projectId)
    const expired = Object.values(committed.events).filter(row => row.projectId === projectId && row.at < now() - maxAgeMs)
    const floor = Math.max(stream.floor, ...expired.map(row => row.sequence))
    let sequence = floor
    if (after !== undefined) {
      if (typeof after !== 'string' || after.length > 600 || !/^[A-Za-z0-9_-]+$/.test(after)) throw fail('Invalid event cursor')
      let parsed
      try { parsed = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')) } catch { throw fail('Invalid event cursor') }
      if (parsed.v !== 1 || parsed.p !== projectId || !Number.isSafeInteger(parsed.s) || parsed.s < 0) throw fail('Event cursor belongs to another scope', 'bot/conflict')
      if (parsed.e !== stream.epoch || parsed.s < floor || parsed.s > stream.nextSequence - 1) throw Object.assign(fail('Event cursor expired; read a current Project snapshot', 'bot/cursor-expired'), { nextAction: 'project.snapshot', details: { nextAction: 'project.snapshot' } })
      sequence = parsed.s
    }
    const rows = Object.values(committed.events).filter(row => row.projectId === projectId && row.sequence > sequence && row.at >= now() - maxAgeMs).sort((a, b) => a.sequence - b.sequence).slice(0, limit)
    return { version: VERSION, projectId, revision: stream.revision, events: rows.map(row => ({ ...copy(row), cursor: cursor(projectId, stream, row.sequence) })),
      next: cursor(projectId, stream, rows.at(-1)?.sequence ?? sequence), head: cursor(projectId, stream, stream.nextSequence - 1), oldest: cursor(projectId, stream, floor) }
  }
  function snapshot(projectId, { after, limit = 50, expectedRevision, entityType = 'task' } = {}) {
    const stream = streamOf(projectId)
    if (!['task', 'attempt', 'execution', 'resource', 'input', 'role-proposal', 'warning'].includes(entityType)) throw fail('Unknown public Project snapshot entity type')
    if (after !== undefined && expectedRevision === undefined) throw fail('Continuing a Project snapshot requires its expectedRevision', 'bot/conflict')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || expectedRevision !== undefined && expectedRevision !== stream.revision) throw fail('Project snapshot changed or page limit is invalid', 'bot/conflict')
    const rows = [...committed.projections.values()].filter(row => row.projectId === projectId && row.entityType === entityType).sort((a, b) => a.id.localeCompare(b.id))
    const index = after === undefined ? -1 : rows.findIndex(row => row.id === after)
    if (after !== undefined && index < 0) throw fail('Project snapshot cursor is unavailable')
    const page = rows.slice(index + 1, index + 1 + limit), project = committed.projections.get(`project:${projectId}`)
    return { version: VERSION, project: project ? copy(project.data) : null, revision: stream.revision, cursor: cursor(projectId, stream, stream.nextSequence - 1),
      ...(entityType === 'task' ? { tasks: page.map(row => copy(row.data)) } : { entityType, entities: page.map(row => copy(row.data)) }), next: index + 1 + page.length < rows.length ? page.at(-1).id : null }
  }
  return { load, prepare, saved, query, snapshot }
}
