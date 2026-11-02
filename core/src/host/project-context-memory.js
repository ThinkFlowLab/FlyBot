// Working summaries reuse public role-memory records. They are scoped snapshots,
// not a new knowledge store or proof that model assertions were independently tested.
import { createHash } from 'node:crypto'
import { ownEntry, setEntry } from './store.js'
import { looksSecret } from './memory.js'
import { taskSession, taskSessionId } from './project-task-sessions.js'
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = text => Object.assign(new Error(text), { code: 'bot/context-resume' })
const VERSION = 'project-work-summary/v1'
const excerpt = value => {
  const text = typeof value === 'string' ? value : ''
  const points = Array.from(text)
  return { text: points.slice(0, 240).join(''), representation: points.length > 240 ? 'source-excerpt' : 'complete', sha256: hash(text) }
}
const memoryId = (projectId, taskId, role) => `work-summary-${hash(taskSessionId(projectId, taskId, role))}`
function validated(row, projectId, taskId, role) {
  if (row.version !== VERSION || row.projectId !== projectId || row.taskId !== taskId || row.role !== role || hash(row.text) !== row.sha256) throw fail('Working summary scope or content changed')
  let data
  try { data = JSON.parse(row.text) } catch { throw fail('Working summary cannot be decoded') }
  if (data.version !== VERSION || data.projectId !== projectId || data.taskId !== taskId || data.role !== role) throw fail('Working summary source scope changed')
  return data
}
export function readRoleSummary(state, projectId, taskId, role) {
  const task = ownEntry(state.tasks ?? {}, taskId)
  if (!task || task.projectId !== projectId) return null
  const logical = ownEntry(state.projectTaskSessions ?? {}, taskSessionId(projectId, taskId, role))
  if (!logical?.workSummaryRef) return null
  const row = ownEntry(state.projectRoleMemory ?? {}, logical.workSummaryRef.id)
  if (!row || row.sha256 !== logical.workSummaryRef.sha256 || row.revision !== logical.workSummaryRef.revision) throw fail('Working summary reference is unavailable or changed')
  return { ...validated(row, projectId, taskId, role), id: row.id, revision: row.revision, sha256: row.sha256 }
}
export function stageRoleSummary(state, { task, claim, role, summary, receiptId }) {
  if (!task || ownEntry(state.tasks ?? {}, task.id) !== task || claim.projectId !== task.projectId || claim.taskId !== task.id || !['chief', 'developer', 'tester', 'reviewer'].includes(role) || !receiptId) throw fail('Working summary execution scope changed')
  let logical
  if (role === 'chief') {
    const carrier = ownEntry(state.projectAgents ?? {}, `public-${task.projectId}`)
    if (!carrier || carrier.projectId !== task.projectId || carrier.visibility !== 'public') throw fail('Resident Chief summary scope is unavailable')
    carrier.workingTopics ??= {}
    logical = ownEntry(carrier.workingTopics, task.id)
    if (!logical) { logical = {}; setEntry(carrier.workingTopics, task.id, logical) }
  } else logical = taskSession(state, { projectId: task.projectId, taskId: task.id, role })
  state.projectRoleMemory ??= {}
  const id = memoryId(task.projectId, task.id, role), previous = ownEntry(state.projectRoleMemory, id)
  if (previous) {
    const old = validated(previous, task.projectId, task.id, role)
    if (previous.source.claimId === claim.id) {
      if (old.sources.receiptId !== receiptId || old.progress.sha256 !== hash(summary?.completed ?? '') || old.next.sha256 !== hash(summary?.next ?? '')) throw fail('Working summary source claim was reused with another intent')
      return { changed: false, id, row: previous }
    }
  }
  const attempt = ownEntry(state.projectAttempts ?? {}, claim.attemptId)
  if (attempt && (attempt.projectId !== task.projectId || attempt.taskId !== task.id)) throw fail('Working summary Attempt scope changed')
  const sha = /^[a-f0-9]{40}$/.test(attempt?.candidateSha ?? '') ? attempt.candidateSha : null
  const tests = attempt?.evidence?.tests, review = attempt?.evidence?.review
  const data = { version: VERSION, projectId: task.projectId, taskId: task.id, role,
    requirements: { taskId: task.id, titleSha256: hash(task.title ?? ''), criteriaSha256: hash(task.criteria ?? ''), representation: 'current-task-constraints-and-original-Task-record' },
    progress: { ...excerpt(summary?.completed), classification: 'role-claim', independentlyVerified: false },
    next: { ...excerpt(summary?.next), classification: 'requested-next-step' },
    evidence: { candidateSha: sha, taskStatus: task.status ?? null,
      tests: { sha: tests?.sha ?? null, status: !tests ? 'not-run' : !sha || tests.sha !== sha ? 'stale' : tests.passed === true ? 'passed' : 'failed', passed: Boolean(sha && tests?.sha === sha && tests.passed === true), logSha256: tests?.sha256 ?? null },
      review: { sha: review?.sha ?? null, recommendation: sha && review?.sha === sha ? review.verdict : null, scope: 'candidate-recommendation', repositoryVerdict: 'INC' } },
    unresolved: ['return', 'arbitrate'].includes(claim.decision?.action) ? [{ sourceClaimId: claim.id, reason: 'Read the original return/arbitration decision; this is not Task completion' }] : [],
    sources: { claimId: claim.id, generation: claim.generation, attemptId: claim.attemptId, receiptId, decisionSha256: claim.decision?.intentHash ?? null },
    previousSha256: previous?.sha256 ?? null }
  const text = JSON.stringify(data)
  if (Buffer.byteLength(text) > 12000) throw fail('Working summary exceeds its bounded record limit; previous version retained')
  const row = { id, version: VERSION, kind: 'work-summary', projectId: task.projectId, taskId: task.id, role, status: 'active', classification: 'execution-summary',
    text, sha256: hash(text), revision: (previous?.revision ?? 0) + 1, at: Date.now(),
    source: { kind: 'role-execution', reference: receiptId, claimId: claim.id, attemptId: claim.attemptId },
    versions: previous ? [...(previous.versions ?? []), { revision: previous.revision, sha256: previous.sha256, text: previous.text, source: previous.source, at: previous.at }] : [] }
  const previousRef = logical.workSummaryRef
  setEntry(state.projectRoleMemory, id, row)
  logical.workSummaryRef = { id, revision: row.revision, sha256: row.sha256 }
  return { changed: true, id, row, previous, previousRef, logical, candidateHash: hash(JSON.stringify(row)) }
}
export function chiefSummarySources(state, projectId) {
  const carrier = ownEntry(state.projectAgents ?? {}, `public-${projectId}`)
  if (!carrier || carrier.projectId !== projectId || carrier.visibility !== 'public') return []
  return Object.entries(carrier.workingTopics ?? {}).filter(([, topic]) => topic?.workSummaryRef).map(([taskId, topic]) => {
    const row = ownEntry(state.projectRoleMemory ?? {}, topic.workSummaryRef?.id)
    if (!row || row.sha256 !== topic.workSummaryRef.sha256 || row.revision !== topic.workSummaryRef.revision) throw fail('Chief working topic reference changed')
    validated(row, projectId, taskId, 'chief')
    return { id: row.id, taskId, text: row.text, sha256: row.sha256, revision: row.revision, at: row.at }
  })
}
export function rollbackRoleSummary(state, candidate) {
  if (!candidate?.changed || ownEntry(state.projectRoleMemory ?? {}, candidate.id) !== candidate.row || hash(JSON.stringify(candidate.row)) !== candidate.candidateHash || candidate.logical.workSummaryRef?.sha256 !== candidate.row.sha256) return false
  if (candidate.previous) setEntry(state.projectRoleMemory, candidate.id, candidate.previous)
  else delete state.projectRoleMemory[candidate.id]
  if (candidate.previousRef) candidate.logical.workSummaryRef = candidate.previousRef
  else delete candidate.logical.workSummaryRef
  return true
}

// Current public memory is short; previous assertions retain their source/version.
// Callers enforce current configure authority. Classification cannot alter a role.
export function stagePublicRoleMemory(state, { projectId, body, actor, idFactory }) {
  state.projectRoleMemory ??= {}
  const rows = state.projectRoleMemory
  if (body.factKey !== undefined && (typeof body.factKey !== 'string' || !/^[A-Za-z0-9_./:-]{1,100}$/.test(body.factKey))) throw fail('Invalid role memory fact key')
  const previous = body.memoryId ? ownEntry(rows, body.memoryId) : Object.values(rows).find(row => row.projectId === projectId && row.role === body.role && body.factKey && row.factKey === body.factKey)
  if (body.memoryId && (!previous || previous.projectId !== projectId || previous.role !== body.role)) throw fail('Role memory belongs to another scope')
  if (previous?.kind === 'work-summary') throw fail('Task-role summaries use their execution-scoped contract')
  if (body.factKey && previous?.factKey && body.factKey !== previous.factKey) throw fail('Role memory fact key changed')
  if (body.factKey && Object.values(rows).some(row => row.id !== previous?.id && row.projectId === projectId && row.role === body.role && row.factKey === body.factKey)) throw fail('Role memory fact key is already used')
  if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== (previous?.revision ?? 0))) throw fail('Role memory revision changed')
  const text = body.text === undefined ? previous?.text : body.text
  if (typeof text !== 'string' || !text.trim() || Array.from(text).length > 4000 || body.source?.kind !== 'human' || typeof body.source.reference !== 'string' || !body.source.reference.trim() || body.source.reference.length > 300) throw fail('Role memory needs bounded text and explicit human source')
  const classification = body.classification ?? previous?.classification ?? 'unclassified'
  if (!['unclassified', 'fact', 'inference', 'unresolved', 'conflict'].includes(classification)) throw fail('Invalid role memory classification')
  const status = body.status ?? previous?.status ?? 'active'
  if (!['active', 'archived'].includes(status)) throw fail('Invalid role memory status')
  const source = { kind: 'human', reference: body.source.reference.trim(), memberId: actor.memberId }
  if (previous && previous.factKey === (body.factKey ?? previous.factKey) && previous.text === text.trim() && (previous.classification ?? 'unclassified') === classification && (previous.status ?? 'active') === status && JSON.stringify(previous.source) === JSON.stringify(source)) return { row: previous, changed: false }
  const at = Date.now()
  const row = { id: previous?.id ?? idFactory(), ...(previous?.kind ? { kind: previous.kind } : {}), projectId, role: body.role, text: text.trim(), classification, status,
    ...(body.factKey ?? previous?.factKey ? { factKey: body.factKey ?? previous.factKey } : {}),
    revision: (previous?.revision ?? 0) + 1, source, at, createdAt: previous?.createdAt ?? previous?.at ?? at, updatedAt: at,
    versions: previous ? [...(previous.versions ?? []), { revision: previous.revision, text: previous.text, classification: previous.classification ?? 'unclassified', status: previous.status ?? 'active', source: previous.source, at: previous.at }] : [] }
  setEntry(rows, row.id, row)
  return { row, changed: true }
}
export function roleMemoryView(row, { offset = 0, limit = 20, versions = false } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('Invalid role memory history page')
  const { versions: history = [], ...head } = row
  return { ...structuredClone(head), versionHistory: { total: history.length, retained: true, nextOffset: versions && offset + limit < history.length ? offset + limit : null },
    ...(versions ? { versions: structuredClone(history.slice(offset, offset + limit)) } : {}) }
}

// Execution-authored experience is always unverified data. It cannot overwrite
// human-controlled facts, reactivate an archive or change the role contract.
export function stageExecutionMemory(state, { task, claim, role, requestId, text, factKey, classification = 'inference' }) {
  if (!task || ownEntry(state.tasks ?? {}, task.id) !== task || claim.projectId !== task.projectId || claim.taskId !== task.id || !['developer', 'tester', 'reviewer'].includes(role)) throw fail('Execution memory scope changed')
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId) || typeof text !== 'string' || !text.trim() || Array.from(text).length > 300) throw fail('Execution memory needs a stable request and at most300 characters')
  if (!['inference', 'unresolved', 'conflict'].includes(classification)) throw fail('Execution memory cannot declare verified facts or permissions')
  if (looksSecret(text)) throw fail('Execution memory cannot store secrets')
  if (factKey !== undefined && (typeof factKey !== 'string' || !/^[A-Za-z0-9_./:-]{1,80}$/.test(factKey))) throw fail('Invalid experience key')
  state.projectRoleMemory ??= {}
  const id = `role-experience-${hash(JSON.stringify([task.projectId, role, factKey ?? [claim.id, requestId]]))}`
  const previous = ownEntry(state.projectRoleMemory, id)
  if (previous && (previous.projectId !== task.projectId || previous.role !== role)) throw fail('Experience memory belongs to another scope')
  const intentHash = hash(JSON.stringify({ text: text.trim(), classification, factKey }))
  const replay = previous && [previous, ...(previous.versions ?? [])].find(row => row.source?.claimId === claim.id && row.source.requestId === requestId)
  if (replay) {
    if (replay.source.intentHash !== intentHash) throw fail('Experience request was reused with another intent')
    return { id, row: { ...previous, ...replay, updatedAt: replay.at, versions: [] }, changed: false, historical: replay !== previous }
  }
  if (previous && (previous.projectId !== task.projectId || previous.role !== role || previous.kind !== 'learned-experience' || previous.source?.kind !== 'role-execution' || previous.status === 'archived')) throw fail('Human-controlled or archived memory cannot be overwritten by an execution')
  const at = Date.now()
  const row = { id, kind: 'learned-experience', projectId: task.projectId, role, text: text.trim(), classification, status: 'active', ...(factKey ? { factKey } : {}),
    revision: (previous?.revision ?? 0) + 1, createdAt: previous?.createdAt ?? previous?.at ?? at, updatedAt: at, at,
    source: { kind: 'role-execution', taskId: task.id, claimId: claim.id, generation: claim.generation, requestId, intentHash, independentlyVerified: false },
    versions: previous ? [...(previous.versions ?? []), { revision: previous.revision, text: previous.text, classification: previous.classification, status: previous.status, source: previous.source, at: previous.at }] : [] }
  setEntry(state.projectRoleMemory, id, row)
  return { id, row, previous, changed: true, candidateHash: hash(JSON.stringify(row)) }
}
export function rollbackExecutionMemory(state, candidate) {
  if (!candidate?.changed || ownEntry(state.projectRoleMemory ?? {}, candidate.id) !== candidate.row || hash(JSON.stringify(candidate.row)) !== candidate.candidateHash) return false
  if (candidate.previous) setEntry(state.projectRoleMemory, candidate.id, candidate.previous)
  else delete state.projectRoleMemory[candidate.id]
  return true
}
