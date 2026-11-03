// Public command recovery over original handlers. Unknown execution outcomes are
// retained, never blindly redispatched. Role acceptance has its own scoped proof.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableStateFile } from './project-state-storage.js'
import { sourcePage } from './project-service-views.js'
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const fail = (message, code = 'bot/conflict', details = {}) => Object.assign(new Error(message), { code, details })
export function commandPrincipal(actor, state) {
  const carrier = actor.watchGrantId && state?.projectAgents?.[actor.agentId]
  const agentId = actor.personalAgentCredentialId ? actor.agentId : carrier?.personalAgentId ?? actor.agentId ?? null
  return hash([actor.memberId, agentId, actor.watchGrantId && !carrier?.personalAgentId ? actor.watchGrantId : null])
}
export function commandEffectVisible(state, effect, actor) {
  if (['consultation.notify', 'agent.inbox.state'].includes(effect.kind)) {
    if (effect.payload.memberId !== actor?.memberId) return false
    const agentId = actor.personalAgentCredentialId ? actor.agentId : actor.consultationProxyAgentId ?? state.projectAgents?.[actor.agentId]?.personalAgentId
    if (agentId && agentId !== effect.payload.agentId) return false
  }
  const id = effect.payload?.commandReceiptId
  if (!id) return true
  const receipt = Object.hasOwn(state.projectCommandReceipts ?? {}, id) ? state.projectCommandReceipts[id] : null
  return Boolean(receipt && receipt.projectId === effect.projectId && receipt.principal === commandPrincipal(actor, state))
}
export function createCommandReceipts(rt) {
  const pending = new Map(), context = new AsyncLocalStorage()
  const table = () => (rt.state.projectCommandReceipts ??= {})
  const identity = (projectId, name, requestId, actor) => `command-${hash([projectId, commandPrincipal(actor, rt.state), name, requestId])}`
  const rows = () => rt.state.projectCommandReceipts ?? {}
  const lookup = id => Object.hasOwn(rows(), id) ? rows()[id] : undefined
  function resultCommitted(row) {
    const effect = row.resultEffect && rt.state.projectEffects?.[row.resultEffect.id]
    return Boolean(rt.projectEffects.intentCommitted(row.resultEffect) && effect?.payload.commandReceiptId === row.id && effect.payload.phase === 'result' && effect.payload.resultSha256 === row.resultSha256)
  }
  const summary = row => {
    const committed = row.status === 'completed' ? resultCommitted(row) : rt.projectEffects.intentCommitted(row.beginEffect ?? row.intentEffect)
    const status = row.status === 'completed' && !committed ? 'completion-pending-commit' : row.status
    return { version: row.version, id: row.id, projectId: row.projectId, requestId: row.requestId, name: row.name, status, committed, origin: structuredClone(row.origin), createdAt: row.createdAt, updatedAt: row.updatedAt,
      resultSha256: row.resultSha256 ?? null, resultBytes: row.resultBytes ?? null, resultRef: row.resultSha256 ? { query: 'command.result', commandName: row.name, commandRequestId: row.requestId, expectedSha256: row.resultSha256 } : null,
      outcome: ['running', 'unknown'].includes(status) ? 'unknown-until-reconciled' : status, nextAction: ['running', 'unknown'].includes(status) ? 'query-target-or-Chief' : status === 'completion-pending-commit' ? 'retry-command' : null }
  }
  rt.projectEffects.register('service.command', { run: effect => ({ commandReceiptId: effect.payload.commandReceiptId, phase: effect.payload.phase, status: 'durable-command-marker' }) })
  function commandOrigin(spec) {
    const actor = spec.actor, carrier = actor.watchGrantId && rt.state.projectAgents?.[actor.agentId]
    const agentId = actor.personalAgentCredentialId ? actor.agentId : carrier?.personalAgentId
    return { kind: actor.chiefJobId ? 'project-chief' : agentId ? 'personal-agent' : actor.watchGrantId || actor.agentId ? 'delegated-bot' : 'human', memberId: actor.memberId,
      ...(agentId ? { agentId } : {}), ...(actor.chiefJobId ? { botId: `${spec.projectId}:chief` } : {}) }
  }
  async function authorize(spec) {
    if (rt.state.members?.[spec.actor.memberId]?.status === 'disabled') throw fail('Command principal was disabled', 'bot/forbidden')
    if (rt.validateHumanActor && !await rt.validateHumanActor(spec.actor)) throw fail('Command principal was revoked', 'bot/forbidden')
    if (!rt.platformIdentityEnabled && !spec.actor.agentId && !spec.actor.watchGrantId && !spec.actor.chiefJobId && spec.actor.sessionId) {
      const session = rt.state.authSessions?.[spec.actor.sessionId]
      if (!session || session.memberId !== spec.actor.memberId || session.revokedAt) throw fail('Command session was revoked', 'bot/unauthorized')
    }
    const task = spec.taskId && rt.state.tasks?.[spec.taskId]
    rt.requireProjectAccess(spec.actor, spec.projectId, spec.action ?? 'read', task)
  }
  async function commit(row, phase) {
    const token = rt.projectEffects.stage({ kind: 'service.command', key: `${row.id}:${phase}`, projectId: row.projectId,
      payload: { commandReceiptId: row.id, phase, intentSha256: row.intentSha256, ...(phase === 'result' ? { resultSha256: row.resultSha256 } : {}) } })
    row[`${phase}Effect`] = token
    try { await rt.projectEffects.persist(token) }
    catch (error) { rt.projectEffects.discardUncommitted(token); throw error }
  }
  function resultOf(row) {
    let text = row.resultText
    if (row.resultFile) {
      if (!/^[a-f0-9]{64}$/.test(row.resultSha256)) throw fail('Invalid command result reference')
      const file = join(rt.home, 'project-command-results', row.resultSha256 + '.json')
      if (!existsSync(file)) throw fail('Command result is unavailable', 'bot/outcome-unknown', { nextAction: 'query-target-or-Chief' })
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw fail('Command result must be a bounded regular file', 'bot/outcome-unknown')
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const current = fstatSync(fd)
        if (current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) throw fail('Command result file changed', 'bot/outcome-unknown')
        const buffer = Buffer.alloc(info.size + 1), size = readSync(fd, buffer, 0, buffer.length, 0)
        if (size !== info.size) throw fail('Command result file changed during read', 'bot/outcome-unknown')
        text = buffer.subarray(0, size).toString('utf8')
      } finally { closeSync(fd) }
    }
    if (typeof text !== 'string' || Buffer.byteLength(text) > 8 * 1024 * 1024 || hash(text) !== row.resultSha256) throw fail('Command result hash changed', 'bot/outcome-unknown', { nextAction: 'query-target-or-Chief' })
    return JSON.parse(text)
  }
  async function complete(row, result) {
    const text = JSON.stringify(result ?? null), bytes = Buffer.byteLength(text)
    if (bytes > 8 * 1024 * 1024) throw fail('Command result exceeds its recovery bound', 'bot/outcome-unknown', { nextAction: 'query-target-or-Chief' })
    row.resultSha256 = hash(text); row.resultBytes = bytes
    if (bytes > 65536) { writeDurableStateFile(join(rt.home, 'project-command-results', row.resultSha256 + '.json'), text, { exclusive: true }); row.resultFile = true }
    else row.resultText = text
    row.status = 'completed'; row.updatedAt = Date.now()
    await commit(row, 'result')
  }
  async function run(spec, invoke, check) {
    await authorize(spec)
    const id = identity(spec.projectId, spec.name, spec.requestId, spec.actor), intentSha256 = hash(stable({ name: spec.name, args: spec.args, expectedGeneration: spec.expectedGeneration, expectedCandidateSha: spec.expectedCandidateSha }))
    const prior = lookup(id)
    if (prior && (prior.version !== 'project-command/v1' || prior.intentSha256 !== intentSha256)) throw fail('Command requestId was reused with different content', 'bot/idempotency-conflict')
    if (pending.has(id)) { const result = await pending.get(id); await authorize(spec); return result }
    const operation = (async () => {
      let row = prior
      if (row?.status === 'completed') {
        if (!resultCommitted(row)) await commit(row, 'result')
        await authorize(spec)
        return { result: resultOf(row), receipt: summary(row), replayed: true }
      }
      if (row && ['running', 'unknown'].includes(row.status)) {
        const recovered = await spec.reconcile?.(row)
        if (!recovered) throw fail('Previous command outcome needs reconciliation; it was not re-executed', 'bot/outcome-unknown', { receiptId: row.id, nextAction: 'command.receipt', targetAction: 'query-target-or-Chief' })
        await complete(row, recovered.result)
        await authorize(spec)
        return { result: resultOf(row), receipt: summary(row), replayed: true, reconstructed: true }
      }
      if (row?.status === 'rejected') throw fail('Command was rejected; use a new requestId for changed preconditions', row.failure?.code ?? 'bot/conflict', { nextAction: 'new-command' })
      check?.()
      if (!row) {
        row = { id, version: 'project-command/v1', projectId: spec.projectId, requestId: spec.requestId, name: spec.name, principal: commandPrincipal(spec.actor, rt.state), intentSha256,
          origin: commandOrigin(spec), status: 'prepared', createdAt: Date.now(), updatedAt: Date.now() }
        Object.defineProperty(table(), id, { value: row, enumerable: true, writable: true, configurable: true })
        try { await commit(row, 'intent') }
        catch (error) { if (!rt.projectEffects.intentCommitted(row.intentEffect) && lookup(id) === row) delete table()[id]; throw error }
      }
      if (!rt.projectEffects.intentCommitted(row.intentEffect)) await commit(row, 'intent')
      row.status = 'running'; row.updatedAt = Date.now()
      try { await commit(row, 'begin') }
      catch (error) { if (!rt.projectEffects.intentCommitted(row.beginEffect)) row.status = 'prepared'; throw error }
      let invoked = false
      try {
        await authorize(spec); check?.(); invoked = true
        const result = await context.run({ commandReceiptId: id, projectId: spec.projectId, name: spec.name, origin: row.origin, taskStamped: false }, invoke)
        await complete(row, result)
        await authorize(spec)
        return { result: resultOf(row), receipt: summary(row), replayed: false }
      } catch (error) {
        if (row.status !== 'completed') {
          row.status = invoked ? 'unknown' : 'rejected'; row.updatedAt = Date.now()
          row.failure = { code: typeof error.code === 'string' && error.code.startsWith('bot/') ? error.code : 'bot/command-failed' }
          // Retain ambiguous outcome even if recording it fails. The durable begin
          // marker still fences automatic replay after a restart.
          try { await commit(row, 'failure') } catch { /* Existing begin intent remains the conservative recovery fact. */ }
        }
        throw error
      }
    })()
    pending.set(id, operation)
    try { return await operation } finally { if (pending.get(id) === operation) pending.delete(id) }
  }
  function get(projectId, requestId, actor, commandName) {
    rt.requireProjectAccess(actor, projectId)
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw fail('Choose a stable command requestId', 'bot/invalid')
    const matches = commandName === undefined ? Object.values(rows()).filter(row => row.projectId === projectId && row.principal === commandPrincipal(actor, rt.state) && row.requestId === requestId) : [lookup(identity(projectId, commandName, requestId, actor))].filter(Boolean)
    if (matches.length > 1) throw fail('Choose commandName for this reused operation-scoped requestId', 'bot/ambiguous-command', { nextAction: 'specify-command-name' })
    const row = matches[0]
    if (!row) throw fail('Command receipt is unavailable to this principal', 'bot/not-found')
    return row
  }
  return { run, source(projectId) {
    const current = context.getStore()
    if (!current || current.projectId !== projectId || !['task.propose', 'proposal.publish'].includes(current.name) || current.taskStamped) return null
    current.taskStamped = true
    return { commandReceiptId: current.commandReceiptId, projectId, origin: structuredClone(current.origin) }
  },
    get: (projectId, requestId, actor, commandName) => summary(get(projectId, requestId, actor, commandName)),
    result(projectId, body, actor) { const row = get(projectId, body.commandRequestId, actor, body.commandName); if (row.status !== 'completed' || !resultCommitted(row)) throw fail('Command result is not committed', 'bot/outcome-unknown'); return { receiptId: row.id, ...sourcePage(resultOf(row), body, hash) } },
  }
}
