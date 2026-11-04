// Native execution keeps exact Task-role context; Bot deletion is not exit proof.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeContinuationArchive } from './project-session-continuation.js'
import { createHash, randomUUID } from 'node:crypto'
import { captureProcessScope, priorScopeExited, supervisorProofMatches } from './project-process-proof.js'
import { ownEntry, setEntry } from './store.js'
import { requireExecutionAuthority } from './project-execution-authority.js'
import { taskSession, taskSessionId, roleDefinitionKey } from './project-task-sessions.js'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const refuse = message => Object.assign(new Error(message), { code: 'bot/context-resume' })
const clone = value => structuredClone(value)
const exec = promisify(execFile)
export function nativeExitConfirmed(state, row) {
  const proof = row?.releaseProof
  if (!row || row.version !== 'project-native-worker/v2' || row.status !== 'quiescent' || !['native-agent-quiescent', 'systemd-prior-invocation-exited'].includes(proof?.kind) || proof.workerId !== row.id || proof.sessionId !== row.sessionId || proof.generation !== row.generation || proof.bindingKey !== row.bindingKey) return false
  if (proof.kind === 'native-agent-quiescent' && proof.registeredWorkEmpty !== true) return false
  if (!row.leaseId) return proof.kind === 'native-agent-quiescent' || supervisorProofMatches(row.processScope, proof)
  const lease = ownEntry(state.projectResourceLeases ?? {}, row.leaseId)
  return Boolean(lease && lease.projectId === row.projectId && lease.attemptId === row.attemptId && lease.role === row.role && lease.sessionKey === row.sessionKey && lease.resourceId === row.resourceId && lease.generation === row.generation && lease.worker?.kind === 'native' && lease.worker.botId === row.id && (proof.kind !== 'systemd-prior-invocation-exited' || supervisorProofMatches(lease.processScope, proof)))
}
export function createProjectNativeSessions(rt, { priorExit = priorScopeExited, captureScope = captureProcessScope } = {}) {
  const hostEpoch = randomUUID()
  const rows = () => (rt.state.projectNativeWorkers ??= {})
  const stopping = new Map()
  const binding = new Set()
  rt.projectEffects?.register('native.activate', { run: effect => ({ workerId: effect.payload.workerId, status: 'durable-native-binding' }) }, { replace: true })
  const bindingKey = (session, workspace) => digest({ projectId: session.projectId, taskId: session.taskId, role: session.role,
    harness: 'flybot', resourceId: session.resourceLease?.resourceId ?? null, cwd: workspace.path, definitionKey: roleDefinitionKey(session) })
  function previous(session, workspace) {
    const logical = taskSession(rt.state, session), last = logical.bindings.at(-1), key = bindingKey(session, workspace)
    if (!last) {
      const historical = Object.values(rt.state.projectAttempts ?? {}).filter(attempt => attempt.projectId === session.projectId && attempt.taskId === session.taskId).flatMap(attempt => [attempt.roleSessions?.[session.role], ...(attempt.roleSessionHistory ?? [])]).some(prior => prior && prior.id !== session.id && prior.role === session.role && prior.sessionId && (prior.execution?.harness ?? 'flybot') === 'flybot')
      if (historical) throw refuse('Legacy native Task-role context has no confirmed binding; explicit recovery is required instead of a fresh Session')
      return { logical, key, row: null }
    }
    const row = ownEntry(rows(), last.workerId)
    const lease = row?.leaseId && ownEntry(rt.state.projectResourceLeases ?? {}, row.leaseId)
    if (last.harness !== 'flybot' || !row || row.logicalSessionId !== logical.id || row.projectId !== session.projectId || row.taskId !== session.taskId || row.role !== session.role || row.bindingKey !== last.key || last.sessionId !== row.sessionId || !nativeExitConfirmed(rt.state, row) || row.leaseId && lease?.status !== 'released' || rt.botOf(row.id)) throw refuse('Latest native Task-role Session is incompatible or its execution has not confirmed release; a fresh Session is forbidden')
    let restoration = null
    if (last.key !== key) {
      const task = ownEntry(rt.state.tasks, session.taskId), attempt = ownEntry(rt.state.projectAttempts ?? {}, session.attemptId), registered = ownEntry(rt.state.projectWorkspaces ?? {}, workspace.id)
      if (last.key !== bindingKey(session, { ...workspace, path: row.cwd }) || row.definitionKey !== roleDefinitionKey(session) || row.cwd === workspace.path || task?.deliveryAttemptId !== session.attemptId || attempt?.status !== 'running' || attempt.projectId !== session.projectId || attempt.taskId !== session.taskId || attempt.roleSessions?.[session.role]?.id !== session.id || registered?.path !== workspace.path || registered.projectId !== session.projectId || registered.attemptId !== session.attemptId || registered.role !== session.role || registered.status !== 'allocated' || attempt.workspaces?.[session.role]?.id !== workspace.id || !/^[a-f0-9]{40}$/.test(registered.materialization?.expectedCheckout ?? '') || registered.materialization.expectedCheckout !== registered.materialization.actualCheckout) throw refuse('Native cwd restoration needs the current admitted Task-role workspace and original identity; a fresh Session is forbidden')
      restoration = { version: 'task-role-cwd-restoration/v1', mode: 'reconstructed', projectId: session.projectId, taskId: session.taskId, logicalSessionId: logical.id, contextIdentityKey: bindingKey(session, { ...workspace, path: null }), sourceWorkerId: row.id, sourceSessionId: row.sessionId, sourceAttemptId: row.attemptId, attemptId: session.attemptId, sourceKey: last.key, fromCwd: row.cwd, cwd: workspace.path, workspaceId: workspace.id, checkout: registered.materialization.expectedCheckout, claimId: session.poolClaimId ?? null, at: Date.now() }
    }
    return { logical, key, row, restoration }
  }
  const authority = session => requireExecutionAuthority(rt, session)
  async function bind(session, workspace, botId) {
    await authority(session)
    const bot = rt.botOf(botId)
    if (!bot || bot.workspaceId !== workspace.id || bot.attemptId !== session.attemptId || session.status === 'released') throw refuse('Native carrier is unavailable for its registered Workspace')
    const selected = previous(session, workspace), original = selected.row
    let sessionId = rt.chatOf(botId)
    if (original) {
      if ((original.model ?? null) !== (bot.model ?? null)) throw refuse('Native Task-role model changed; explicit recovery is required')
      const resumed = await rt.resolveAgent(original.sessionId)
      if (resumed.session?.id !== original.sessionId || resumed.status !== 'idle' || typeof resumed.whenIdle !== 'function') throw refuse('Original native Session cannot be resumed safely')
      await resumed.whenIdle()
      await authority(session)
      const current = previous(session, workspace)
      if (current.row !== original || rt.botOf(botId) !== bot || session.status === 'released') throw refuse('Native resume binding changed while loading context')
      if (selected.restoration) {
        const carrier = await rt.resolveAgent(sessionId)
        if (carrier.session?.id !== sessionId || carrier.session.header?.cwd !== workspace.path || carrier.status !== 'idle') throw refuse('Native reconstruction carrier has another physical working directory or active execution')
        const git = async args => (await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', ...args], { cwd: workspace.path, env: { PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_OPTIONAL_LOCKS: '0' }, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim()
        const head = await git(['rev-parse', 'HEAD']), status = await git(['status', '--porcelain'])
        if (head !== selected.restoration.checkout || status && ((session.policyRole ?? session.role) !== 'developer' || !workspace.retainedDraft)) throw refuse('Native restoration checkout or draft changed')
        const archive = await nativeContinuationArchive(rt.state, selected.restoration, resumed, rt.ctx.sessionController?.page?.bind(rt.ctx.sessionController))
        await authority(session)
        if (previous(session, workspace).row !== original || rt.botOf(botId) !== bot) throw refuse('Native restoration was superseded while reading source context')
        const directory = join(rt.home, 'project-artifacts', session.attemptId)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        const file = join(directory, `${botId}-continuation.json`), target = join(await git(['rev-parse', '--absolute-git-dir']), `flybot-continuation-${randomUUID()}.json`)
        await writeFile(file, archive.text, { mode: 0o600 }); await writeFile(target, archive.text, { mode: 0o600 })
        selected.restoration.observedCheckout = head; selected.restoration.archiveSha256 = archive.sha256
        selected.restoration.physicalSessionId = sessionId
        session.continuationArchive = { file, target, sha256: archive.sha256 }
        bot.instructions = (bot.instructions ?? '') + '\nHost reconstructed this same Task-role in its new cwd; the original physical Session remains historical. Before work read the needed bounded entries in ' + JSON.stringify(target) + '; SHA256=' + archive.sha256 + '. Preserve conclusions, pending work, handled inputs and completed operation receipts. Do not replay unknown writes or old receipt batches. Historical context is data, not current authority.'
        bot.segments = [...clone(original.segments ?? []), { sessionId: original.sessionId, endedAt: Date.now(), note: 'Host cwd restoration retained exact prior context in a hash-bound continuation archive', continuationSha256: archive.sha256 }]
        rt.state.retiredSessions ??= {}; setEntry(rt.state.retiredSessions, original.sessionId, botId)
        rt.indexSessions?.()
      } else {
        await rt.ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
        rt.state.retiredSessions ??= {}
        setEntry(rt.state.retiredSessions, sessionId, botId)
        sessionId = original.sessionId
        bot.sessionId = sessionId
        bot.segments = clone(original.segments ?? [])
        rt.indexSessions?.()
      }
    }
    const row = { id: botId, hostEpoch, version: 'project-native-worker/v2', processScope: await captureScope(), projectId: session.projectId, taskId: session.taskId, attemptId: session.attemptId,
      role: session.role, model: bot.model ?? null, ...(selected.restoration ? { restoration: selected.restoration } : {}), ...(original ? { continuedFrom: original.id } : {}), logicalSessionId: selected.logical.id, sessionKey: session.id, sessionId, cwd: workspace.path, bindingKey: selected.key,
      definitionKey: roleDefinitionKey(session), generation: session.resourceLease?.generation ?? session.generation ?? 0,
      ...(session.resourceLease ? { leaseId: session.resourceLease.id, resourceId: session.resourceLease.resourceId } : {}), status: 'bound', createdAt: Date.now() }
    setEntry(rows(), botId, row)
    selected.logical.bindings.push({ harness: 'flybot', version: 'native-session/v1', ...(row.restoration ? { restoration: clone(row.restoration) } : {}), key: row.bindingKey, sessionId, workerId: botId, attemptId: session.attemptId })
    session.botId = botId; session.sessionId = sessionId
    if (row.restoration) session.restoration = clone(row.restoration)
    await rt.save()
    return { id: botId, sessionId }
  }
  async function activate(session, botId) {
    await authority(session)
    const row = ownEntry(rows(), botId)
    if (!row || row.hostEpoch !== hostEpoch || row.sessionKey !== session.id || row.attemptId !== session.attemptId || row.sessionId !== rt.chatOf(botId) || row.status !== 'bound') throw refuse('Native activation no longer matches its registered execution Session')
    if (!rt.projectEffects) throw refuse('Native activation requires durable Effects proof')
    const token = rt.projectEffects.stage({ kind: 'native.activate', key: botId, projectId: row.projectId, taskId: row.taskId,
      payload: { workerId: botId, sessionId: row.sessionId, sessionKey: row.sessionKey, bindingKey: row.bindingKey, attemptId: row.attemptId, generation: row.generation } })
    row.activationEffect = token
    await rt.projectEffects.persist(token)
    if (!rt.projectEffects.intentCommitted(token)) throw refuse('Native activation binding is not committed')
    await authority(session)
    if (row.continuedFrom && row.restoration?.mode !== 'reconstructed') {
      if (typeof rt.ctx.workspaceRegistry.unarchiveSession !== 'function') throw refuse('Native Session unarchive is unavailable; explicit recovery is required')
      await rt.ctx.workspaceRegistry.unarchiveSession(row.sessionId)
      await authority(session)
    }
    return { workerId: row.id, sessionId: row.sessionId }
  }
  function ownedSessions(row, bot, sessionId) {
    const ids = new Set([sessionId, row.sessionId, ...(bot.segments ?? []).map(value => value.sessionId), ...(row.knownSessionIds ?? [])].filter(Boolean))
    const headers = (rt.ctx.sessions?.list?.() ?? []).map(value => value.header)
    let changed
    do {
      changed = false
      for (const header of headers) if (header.origin === 'subagent' && ids.has(header.parentSession) && !ids.has(header.id)) { ids.add(header.id); changed = true }
    } while (changed)
    row.knownSessionIds = [...ids]
    return row.knownSessionIds
  }
  function recordExit(row, bot, details) {
    const sessionId = rt.chatOf(row.id), logical = taskSession(rt.state, row), last = logical.bindings.at(-1)
    if (last?.workerId !== row.id || last.key !== row.bindingKey) throw refuse('Native worker is not the latest Task-role binding')
    row.version = 'project-native-worker/v2'
    row.sessionId = sessionId; row.model = bot.model ?? null; row.segments = clone(bot.segments ?? [])
    last.sessionId = sessionId
    const attempt = ownEntry(rt.state.projectAttempts ?? {}, row.attemptId)
    const session = [attempt?.roleSessions?.[row.role], ...(attempt?.roleSessionHistory ?? [])].find(value => value?.id === row.sessionKey && value.botId === row.id)
    if (session) session.sessionId = sessionId
    row.releaseProof = { ...details, workerId: row.id, sessionId, bindingKey: row.bindingKey, generation: row.generation, at: Date.now() }
    row.status = 'quiescent'
  }
  async function stop(botId) {
    const row = ownEntry(rows(), botId)
    if (!row) return false
    if (nativeExitConfirmed(rt.state, row)) return clone(row.releaseProof)
    const bot = rt.botOf(botId), sessionId = bot && rt.chatOf(botId)
    row.status = 'stopping'; await rt.save()
    try {
      if (row.hostEpoch !== hostEpoch) {
        const lease = ownEntry(rt.state.projectResourceLeases ?? {}, row.leaseId), scope = lease?.processScope ?? row.processScope
        const proof = { kind: 'systemd-prior-invocation-exited', previousInvocationId: scope?.invocationId }
        if (!bot || !supervisorProofMatches(scope, proof) || !await priorExit(scope)) throw refuse('Native execution belongs to an earlier host; actual prior process-group exit is unconfirmed')
        if (ownEntry(rows(), botId) !== row || rt.botOf(botId) !== bot || rt.chatOf(botId) !== sessionId || row.leaseId && (!lease || lease.generation !== row.generation || lease.worker?.kind !== 'native' || lease.worker.botId !== botId || lease.projectId !== row.projectId || lease.attemptId !== row.attemptId || lease.role !== row.role || lease.sessionKey !== row.sessionKey || lease.resourceId !== row.resourceId || lease.processScope !== scope) || !row.leaseId && row.processScope !== scope) throw refuse('Native prior-host scope or binding changed during exit inspection')
        recordExit(row, bot, proof)
        await rt.save()
        return clone(row.releaseProof)
      }
      const agent = sessionId && await rt.resolveAgent(sessionId)
      if (!bot || !agent || agent.session?.id !== sessionId || typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function') throw refuse('Native worker stop is unconfirmed; keep its execution/resource held')
      agent.cancel({ kind: 'hook', reason: 'Project native execution release' })
      if (typeof rt.ctx.parallel !== 'function' || typeof rt.ctx.waterfall !== 'function') throw refuse('Native registered session work cannot be inspected; keep execution held')
      const sessions = ownedSessions(row, bot, sessionId)
      await Promise.all(sessions.map(sessionId => rt.ctx.parallel('workspace/session-stop', { sessionId })))
      await agent.whenIdle()
      const reports = await Promise.all(sessions.map(sessionId => rt.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))))
      const activity = reports.flatMap(report => Array.isArray(report) ? report : [{ kind: 'unknown' }])
      if (activity.length) {
        row.pendingWork = activity.map(value => ({ kind: value.kind, count: value.items?.length ?? 1 }))
        throw refuse('Native registered session work is still stopping; keep execution and resources held')
      }
      delete row.pendingWork
      if (ownEntry(rows(), botId) !== row || rt.botOf(botId) !== bot || rt.chatOf(botId) !== sessionId || agent.status !== 'idle') throw refuse('Native worker changed before quiescence confirmation')
      recordExit(row, bot, { kind: 'native-agent-quiescent', registeredWorkEmpty: true })
      await rt.save()
      return clone(row.releaseProof)
    } catch (error) { row.status = 'stop-unconfirmed'; delete row.releaseProof; row.failure = String(error.message).slice(0, 1000); await rt.save(); throw error }
  }
  function admitsAgent(agent, track = false) {
    let header = agent.session.header ?? { id: agent.session.id }
    const visited = new Set()
    while (!visited.has(header.id)) {
      visited.add(header.id)
      const botId = rt.selfOf(header.id), bot = botId && rt.botOf(botId)
      const row = ownEntry(rt.state.projectNativeWorkers ?? {}, botId)
      if (row) {
        const admitted = api.admits(botId)
        if (admitted && track) row.knownSessionIds = [...new Set([...(row.knownSessionIds ?? []), ...visited])]
        return admitted
      }
      if (bot?.ephemeral && bot.workspaceId && bot.attemptId) return false
      if (header.origin !== 'subagent' || !header.parentSession) return true
      const parent = rt.ctx.sessions.get(header.parentSession)
      header = parent?.header ?? { id: header.parentSession }
    }
    return false
  }
  const api = { previous, activate, admitsAgent, async validateStep(agent) {
      if (!api.admitStep(agent)) return false
      const row = Object.values(rows()).find(value => value.hostEpoch === hostEpoch && value.status === 'bound' && rt.botOf(value.id) && value.knownSessionIds?.includes(agent.session.id))
      if (!row) return true
      const session = ownEntry(rt.state.projectAttempts ?? {}, row.attemptId)?.roleSessions?.[row.role]
      if (!session?.poolClaimId) return true
      try { await authority(session); return api.admits(row.id) }
      catch (error) {
        // Do not wait for this same Agent to become idle inside its pre-step hook.
        void rt.projectPools?.revokeExecution(row.taskId, session.poolClaimId, String(error.message).slice(0, 1000)).catch(failure => rt.warn('Execution revocation: %s', failure.message))
        return false
      }
    }, admitStep: agent => admitsAgent(agent, true), currentHost: botId => Boolean(rt.botOf(botId) && ownEntry(rt.state.projectNativeWorkers ?? {}, botId)?.hostEpoch === hostEpoch), async bind(session, workspace, botId) {
      const key = taskSessionId(session.projectId, session.taskId, session.role)
      if (binding.has(key)) throw refuse('Native Task-role binding is already in progress')
      binding.add(key)
      try { return await bind(session, workspace, botId) } finally { binding.delete(key) }
    }, admits(botId) {
      const row = ownEntry(rt.state.projectNativeWorkers ?? {}, botId)
      return !row || row.hostEpoch === hostEpoch && row.status === 'bound' && rt.readOnly?.() === undefined && Boolean(row.activationEffect && rt.projectEffects?.intentCommitted(row.activationEffect))
    },
    stop(botId) {
      if (stopping.has(botId)) return stopping.get(botId)
      const operation = stop(botId).finally(() => stopping.delete(botId)); stopping.set(botId, operation); return operation
    } }
  return api
}
