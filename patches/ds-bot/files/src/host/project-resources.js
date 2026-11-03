// Operator-provisioned execution capabilities; Project configuration only references IDs.
import { nativeExitConfirmed } from './project-native-sessions.js'
import { captureProcessScope, priorScopeExited } from './project-process-proof.js'
import { execFile, spawn } from 'node:child_process'
import { realpath, copyFile, stat } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { ownEntry, setEntry } from './store.js'
import { executionProfile } from './project-execution-profile.js'
const exec = promisify(execFile)
const failure = message => Object.assign(new Error(message), { code: 'bot/resource' })
const active = lease => lease.status !== 'released'
const contains = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
const safeEnv = () => ({ PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' })

export function createProjectResources(rt) {
  const { state, config } = rt
  const leases = () => (state.projectResourceLeases ??= {})
  const resources = () => config.projectResources ?? {}
  let recovered = false
  let tail = Promise.resolve()
  const serial = fn => { const result = tail.then(fn, fn); tail = result.then(() => {}, () => {}); return result }
  const occupied = id => Object.values(leases()).filter(row => row.resourceId === id && active(row)).length
  function setting(projectId, resourceId) {
    executionProfile(config)
    const project = rt.readProject(projectId)
    const resource = ownEntry(resources(), resourceId)
    if (!project || !resource || !resource.allowedProjectOwnerIds?.includes(project.ownerUserId) || resource.projectIds && !resource.projectIds.includes(projectId)) throw failure('Execution resource is not authorized for this Project')
    if (!['local', 'docker'].includes(resource.type) || !isAbsolute(resource.root ?? '') || !Number.isInteger(resource.capacity) || resource.capacity < 1 || resource.capacity > 64) throw failure('Execution resource configuration is invalid')
    if (resource.nodePath !== undefined && !isAbsolute(resource.nodePath) || resource.runtimeDir !== undefined && !isAbsolute(resource.runtimeDir)) throw failure('Resource runtime paths must be absolute')
    if (resource.type === 'docker' && (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(resource.container ?? '') || !/^\d+(?::\d+)?$/.test(resource.user ?? ''))) throw failure('Docker resource needs an explicit container and numeric UID')
    return resource
  }
  const bindingHash = item => createHash('sha256').update(JSON.stringify([item.type, item.root, item.container ?? null, item.user ?? null, item.runtimeDir ?? null, item.nodePath ?? null])).digest('hex')
  function requireBinding(projectId, lease) {
    const item = setting(projectId, lease.resourceId)
    if (lease.bindingHash && bindingHash(item) !== lease.bindingHash) throw failure('Execution resource binding changed; migration is not permitted')
    return item
  }
  function list(projectId, actor) {
    return Object.keys(resources()).flatMap(id => {
      try {
        const item = setting(projectId, id)
        const observation = ownEntry(state.projectResourceHealth ?? {}, id)
        return [{ id, type: item.type, canManage: Boolean(actor && item.adminMemberIds?.includes(actor.memberId)), capacity: { configured: item.capacity, occupied: occupied(id) }, harnesses: item.harnesses ?? [],
          harnessStatus: (item.harnesses ?? []).map(harness => ({ harness, ...(ownEntry(state.projectHarnessHealth ?? {}, `${projectId}:${id}:${harness}`) ?? { status: harness === 'flybot' ? 'native-host-provider' : 'unconfigured' }) })),
          health: observation ?? { status: 'unconfigured', reason: 'Environment has not been probed', at: null },
          metrics: { cpu: null, memory: null, basis: 'unavailable' }, platformInstanceId: item.platformInstanceId ?? null }]
      } catch { return [] /* Unauthorized/malformed resources are not enumerable. */ }
    })
  }
  function checkPool(projectId, execution = {}) {
    for (const id of execution.resourceIds ?? []) setting(projectId, id)
  }
  function select(request, pending = []) {
    const { projectId, harness, resourceIds, role, maxConcurrent } = request
    checkPool(projectId, { resourceIds })
    const usage = id => occupied(id) + pending.filter(row => row.resourceId === id).length
    if (maxConcurrent && [...Object.values(leases()).filter(active), ...pending].filter(row => row.projectId === projectId && row.role === role).length >= maxConcurrent) throw failure('Role capacity is full')
    const candidates = resourceIds.map(id => ({ id, item: setting(projectId, id) })).filter(({ item }) => !item.disabled && item.harnesses?.includes(harness) && (harness !== 'flybot' || item.type === 'local'))
    if (!candidates.length) throw failure('No compatible execution resource in the selected pool')
    const available = candidates.filter(({ id, item }) => {
      const health = ownEntry(state.projectResourceHealth ?? {}, id)
      const auth = ownEntry(state.projectHarnessHealth ?? {}, `${projectId}:${id}:${harness}`)
      return health?.status === 'ready' && (harness === 'flybot' || request.purpose === 'probe' || auth?.status === 'ready') && usage(id) < item.capacity
    })
    if (!available.length) throw failure('Execution resource capacity or readiness is unavailable')
    available.sort((a, b) => usage(a.id) / a.item.capacity - usage(b.id) / b.item.capacity || a.id.localeCompare(b.id))
    return available[0]
  }
  function plan(projectId, definitions) {
    const pending = []
    for (const role of definitions?.roles ?? []) {
      if (role.role !== 'chief' && role.execution?.harness && role.execution.harness !== 'flybot' && !role.execution.resourceIds?.length) throw failure('SDK role has no authorized execution resource pool')
      if (role.role === 'chief' || !role.execution?.resourceIds?.length) continue
      const execution = role.execution
      const selected = select({ projectId, role: role.role, harness: execution.harness, resourceIds: execution.resourceIds, maxConcurrent: execution.maxConcurrent }, pending)
      pending.push({ resourceId: selected.id, projectId, role: role.role })
    }
    return pending
  }
  async function reserve(request) {
    const existing = Object.values(leases()).find(row => row.sessionKey === request.sessionKey)
    if (existing) {
      if (existing.projectId !== request.projectId || existing.attemptId !== request.attemptId || existing.role !== request.role || existing.harness !== request.harness || existing.status === 'released') throw failure('Execution resource Session key is already bound or released')
      return structuredClone(existing)
    }
    const selected = select(request)
    const lease = { id: `resource-lease-${randomUUID()}`, generation: 1, projectId: request.projectId, attemptId: request.attemptId, role: request.role,
      sessionKey: request.sessionKey, purpose: request.purpose ?? 'execution', resourceId: selected.id, harness: request.harness, principalId: rt.readProject(request.projectId).ownerUserId, runtimeUser: selected.item.type === 'docker' ? selected.item.user : `uid:${process.getuid?.() ?? 'unknown'}`,
      bindingHash: bindingHash(selected.item), status: 'reserved', createdAt: Date.now() }
    setEntry(leases(), lease.id, lease)
    await rt.save()
    return structuredClone(lease)
  }
  async function reserveRoles(projectId, attemptId, definitions) {
    plan(projectId, definitions)
    const reserved = {}
    for (const role of definitions?.roles ?? []) {
      if (role.role === 'chief' || !role.execution?.resourceIds?.length) continue
      reserved[role.role] = await reserve({ projectId, attemptId, role: role.role, sessionKey: `${attemptId}:${role.role}`, ...role.execution })
    }
    return reserved
  }
  function requireLease(id, generation) {
    const lease = ownEntry(leases(), id)
    if (!lease || lease.generation !== generation) throw failure('Execution lease generation mismatch')
    return lease
  }
  async function markStarted(id, generation, worker) {
    const lease = requireLease(id, generation)
    if (lease.status === 'released') throw failure('Execution resource lease was released')
    if (lease.worker && JSON.stringify(lease.worker) !== JSON.stringify(worker)) throw failure('Execution resource worker is already bound')
    const scope = setting(lease.projectId, lease.resourceId).type === 'local' ? await captureProcessScope() : null
    lease.worker = structuredClone(worker); lease.status = 'running'
    if (scope) lease.processScope = scope
    await rt.save()
  }
  async function release(id, generation, confirmation) {
    const lease = requireLease(id, generation)
    if (lease.status === 'released') return
    const worker = lease.worker
    const native = worker?.kind === 'native' && ownEntry(state.projectNativeWorkers ?? {}, worker.botId)
    const confirmed = !worker || worker.kind === 'native' && !ownEntry(state.bots ?? {}, worker.botId) && native?.leaseId === lease.id && nativeExitConfirmed(state, native) || worker.kind !== 'native' && typeof worker.handle === 'string' && worker.handle.length > 0 && confirmation?.handle === worker.handle && confirmation?.exited === true
    lease.status = confirmed ? 'released' : 'stopping'
    if (confirmed) { lease.releasedAt = Date.now(); lease.releaseProof ??= confirmation?.proof ?? native?.releaseProof ?? { kind: worker ? 'host-confirmed-worker-exit' : 'unbound-reservation-release', at: lease.releasedAt } }
    await rt.save()
    if (confirmed) rt.projectScheduler?.wake()
  }
  function recover() {
    if (recovered || rt.readOnly?.()) return false
    recovered = true
    let changed = false
    for (const lease of Object.values(leases()).filter(active)) {
      if (lease.status === 'unreachable') continue
      lease.status = 'unreachable'; changed = true
    }
    return changed
  }
  async function reconcile() {
    let changed = false
    for (const lease of Object.values(leases()).filter(active)) {
      if (lease.processScope?.hostPid === process.pid && (lease.worker?.kind === 'native' || lease.worker?.kind === 'sdk' && rt.projectHarness?.hasController(lease.worker.handle) || lease.worker?.kind === 'native-turn' && rt.projectAgents?.hasExchange(lease.worker.handle))) continue
      const priorExited = lease.processScope && await priorScopeExited(lease.processScope)
      // The supervisor read yields: a confirmed concurrent release is final.
      if (!active(lease)) continue
      if (priorExited) {
        requireBinding(lease.projectId, lease)
        if (lease.worker?.kind === 'native' && ownEntry(rt.state.bots ?? {}, lease.worker.botId)) {
          const bot = rt.state.bots[lease.worker.botId]
          if (!bot.ephemeral || !bot.attemptId) continue
          await rt.flybot.scope('flybot-workflow').bot.remove(bot.id)
        }
        lease.releaseProof = { kind: 'systemd-prior-invocation-exited', previousInvocationId: lease.processScope.invocationId, at: Date.now() }
        await release(lease.id, lease.generation, { handle: lease.worker?.handle, exited: true })
        const row = rt.state.projectHarnessWorkers?.[lease.worker?.handle]
        if (row) { row.status = 'released'; row.releasedAt = Date.now(); row.releaseProof = lease.releaseProof; await rt.projectDelivery?.releaseSession(row.id); changed = true }
        continue
      }
      if (lease.processScope?.hostPid === process.pid) {
        if (lease.worker?.kind === 'native' || lease.worker?.kind === 'sdk' && rt.projectHarness?.hasController(lease.worker.handle) || lease.worker?.kind === 'native-turn' && rt.projectAgents?.hasExchange(lease.worker.handle)) continue
      }
      if (!lease.worker) { if (lease.status === 'unreachable') await release(lease.id, lease.generation); continue }
      if (lease.worker.kind === 'native' && !ownEntry(state.bots ?? {}, lease.worker.botId)) await release(lease.id, lease.generation)
      else if (lease.worker.kind !== 'native' && lease.status !== 'unreachable') { lease.status = 'unreachable'; changed = true }
    }
    if (changed) await rt.save()
  }
  function startProcess(projectId, resourceId, { argv, cwd }) {
    const item = setting(projectId, resourceId)
    if (!Array.isArray(argv) || !argv.length || !isAbsolute(cwd ?? '') || !contains(item.root, cwd)) throw failure('Invalid resource process target')
    if (argv[0] === 'node') argv = [item.nodePath ?? (item.type === 'local' ? process.execPath : 'node'), ...argv.slice(1)]
    const options = { env: safeEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: item.type === 'local' }
    return item.type === 'local' ? spawn(argv[0], argv.slice(1), { ...options, cwd })
      : spawn('docker', ['exec', '-i', '--user', item.user, '--workdir', cwd, item.container, 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', ...argv], options)
  }
  async function command(projectId, resourceId, { argv, cwd, timeout = 30_000, input } = {}) {
    const item = setting(projectId, resourceId)
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || value.includes('\0')) || !isAbsolute(cwd ?? '') || !contains(item.root, cwd)) throw failure('Invalid resource command or working directory')
    if (argv[0] === 'node') argv = [item.nodePath ?? (item.type === 'local' ? process.execPath : 'node'), ...argv.slice(1)]
    const options = { timeout: Math.min(timeout, 120_000), maxBuffer: 2 * 1024 * 1024, env: safeEnv() }
    // No shell interpolation. Target paths and credentials never become host shell code.
    if (input !== undefined) throw failure('Resource command input requires a streaming adapter')
    if (item.type === 'local') {
      const [actualRoot, actualCwd] = await Promise.all([realpath(item.root), realpath(cwd)])
      if (!contains(actualRoot, actualCwd)) throw failure('Resource working directory escapes its registered root')
      return exec(argv[0], argv.slice(1), { ...options, cwd: actualCwd })
    }
    return exec('docker', ['exec', '--user', item.user, '--workdir', cwd, item.container, 'env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', ...argv], options)
  }
  async function uploadFile(projectId, resourceId, source, target, maxBytes = 128 * 1024 * 1024) {
    const item = setting(projectId, resourceId)
    const sourceInfo = await stat(source)
    if (!sourceInfo.isFile() || sourceInfo.size > maxBytes || !isAbsolute(target) || !contains(item.root, target)) throw failure('Transfer exceeds file/scope limit')
    if (item.type === 'local') await copyFile(source, target)
    else await exec('docker', ['cp', source, `${item.container}:${target}`], { env: safeEnv(), timeout: 120_000, maxBuffer: 64 * 1024 })
  }
  async function downloadFile(projectId, resourceId, source, target, maxBytes = 128 * 1024 * 1024) {
    const item = setting(projectId, resourceId)
    if (!isAbsolute(source) || !contains(item.root, source) || !isAbsolute(target)) throw failure('Transfer exceeds resource scope')
    const info = await command(projectId, resourceId, { cwd: item.root, argv: ['node', '-e', 'const fs=require("fs");const p=process.argv[1];const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(p)!==p)throw Error("Invalid artifact path");console.log(s.size)', source] })
    if (!Number.isFinite(Number(info.stdout)) || Number(info.stdout) > maxBytes) throw failure('Transfer exceeds size limit')
    if (item.type === 'local') await copyFile(source, target)
    else await exec('docker', ['cp', `${item.container}:${source}`, target], { env: safeEnv(), timeout: 120_000, maxBuffer: 64 * 1024 })
    if ((await stat(target)).size > maxBytes) throw failure('Transferred artifact exceeds size limit')
  }
  async function probe(projectId, resourceId) {
    const item = setting(projectId, resourceId)
    let row
    try {
      const result = await command(projectId, resourceId, { argv: ['node', '-p', 'JSON.stringify({node:process.version,uid:process.getuid?.(),platform:process.platform})'], cwd: item.root, timeout: 5000 })
      row = { status: 'ready', environment: JSON.parse(result.stdout.trim()), at: Date.now(), authentication: 'not-probed' }
    } catch { row = { status: 'unreachable', reason: 'Resource runtime probe failed; check configured target, UID and directory', at: Date.now(), authentication: 'not-probed' } }
    state.projectResourceHealth ??= {}; setEntry(state.projectResourceHealth, resourceId, row); await rt.save()
    return structuredClone(row)
  }
  return { setting, requireBinding, uploadFile, downloadFile, list, checkPool, plan, command, startProcess, probe, occupied, reconcile, recover,
    reserveRoles: (...args) => serial(() => reserveRoles(...args)),
    reserve: request => serial(() => reserve(request)), markStarted: (...args) => serial(() => markStarted(...args)), release: (...args) => serial(() => release(...args)) }
}
export function install(rt) { rt.projectResources = createProjectResources(rt) }
