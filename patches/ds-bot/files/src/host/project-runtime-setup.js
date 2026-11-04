import { harnessProfile, sdkAuthenticationFailure } from './project-harness-auth.js'
// Owner setup: bounded connectivity probes and private target-resource PTYs.
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ownEntry, setEntry } from './store.js'
import { createPluginModel } from './plugin-model.js'
const refuse = message => Object.assign(new Error(message), { code: 'bot/forbidden' })
const delay = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
export function createProjectRuntimeSetup(rt) {
  const terminals = new Map(), checks = new Map()
  const nativeProbe = createPluginModel(rt, { allow: ['project-runtime-probe'], limits: { maxTokens: 12, perMinute: 2, timeoutMs: 8000 } })
  const audits = () => (rt.state.projectTerminalAudit ??= {})
  async function authorized(body, actor, admin = false) {
    const project = rt.requireProjectAccess(actor, body.projectId, 'configure')
    const resource = rt.projectResources.setting(project.id, body.resourceId)
    if (admin && !resource.adminMemberIds?.includes(actor.memberId)) throw refuse('Explicit resource administration grant is required for a terminal')
    if (!['flybot', 'codex', 'claude-agent'].includes(body.harness) || !resource.harnesses?.includes(body.harness)) throw refuse('Harness is not authorized on this resource')
    return { project, resource }
  }
  async function probeSDK(body, project, resource) {
    const selected = await rt.projectHarness.profile(project.id, body.resourceId, body.harness)
    const definitions = rt.projectAgents.deliveryDefinitions(project.id)
    const role = definitions.roles.find(row => row.role === body.role) ?? definitions.roles.find(row => row.execution?.harness === body.harness)
    const model = role?.execution?.model ?? selected.selected.model
    if (!model) return { status: 'unconfigured', reason: 'Set an explicit SDK model on this role/profile' }
    const id = `probe-${randomUUID()}`, cwd = join(resource.root, 'connection-probes', id)
    const lease = await rt.projectResources.reserve({ projectId: project.id, attemptId: id, sessionKey: id, role: 'probe', harness: body.harness, resourceIds: [body.resourceId], purpose: 'probe' })
    let child, exited = false, stopped = false, completion = false, authError = false, authenticationFailure = null, observedSdkVersion = null, readyObserved = false, startupFailed = false
    try {
      await rt.projectResources.command(project.id, body.resourceId, { cwd: resource.root, argv: ['mkdir', '-p', cwd] })
      await rt.projectResources.command(project.id, body.resourceId, { cwd, argv: ['git', 'init', '-q'] })
      const runtime = resource.runtimeDir ?? resolve(import.meta.dirname, '../..')
      child = rt.projectResources.startProcess(project.id, body.resourceId, { cwd, argv: ['node', join(runtime, 'src/host/project-harness-worker.mjs')] })
      await rt.projectResources.markStarted(lease.id, lease.generation, { kind: 'sdk', handle: id })
      const closed = new Promise(resolve => child.once('close', () => { exited = true; if (!readyObserved) startupFailed = true; resolve() }))
      child.stdin.on('error', () => {}) // Missing/closed runtimes report an environment error below, never crash the host.
      child.once('error', () => { startupFailed = true }) // The exit/readiness check below reports a bounded environment error.
      child.stderr.resume() // Raw SDK stderr may contain credential material; never persist or relay it.
      let finish, handshake
      const ready = new Promise(resolve => { handshake = resolve })
      const finished = new Promise(resolve => { finish = resolve })
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        try {
          const event = JSON.parse(line)
          if (event.type === 'ready') { readyObserved = true; const version = event.sdk?.[body.harness]; observedSdkVersion = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/.test(version ?? '') ? version : null; handshake() }
          if (event.type === 'stopped') stopped = event.released === true
          if (event.type === 'completed') { completion = true; finish() }
          if (event.type === 'failure') { authenticationFailure = sdkAuthenticationFailure({ code: event.authenticationFailure?.code }, body.harness); if (authenticationFailure) authError = true; finish() }
          if (/401|403|api.key|authentication|unauthorized|login required/i.test(line)) authError = true
        } catch { /* Malformed probe output is not successful authentication. */ }
      })
      await Promise.race([ready, closed, delay(5000)])
      if (observedSdkVersion !== rt.projectHarness.versions[body.harness]) {
        if (!exited) { child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n'); await Promise.race([closed, delay(6000)]) }
        return { status: 'environmentError', reason: 'SDK on this resource is missing or incompatible with this FlyBot runtime', sdkVersion: observedSdkVersion }
      }
      child.stdin.write(JSON.stringify({ type: 'start', settings: { harness: body.harness, env: selected.env, cwd, model, probe: true, noTools: true, readOnly: true, maxBudgetUsd: 0.01,
        ...(selected.selected.baseUrl ? { baseUrl: selected.selected.baseUrl } : {}) }, prompt: 'Reply ready. Do not use tools.' }) + '\n')
      await Promise.race([finished, closed, delay(10_000)])
      if (!exited) { child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n'); await Promise.race([closed, delay(6000)]) }
      return { profile: selected.profile, ...(authenticationFailure ? { authenticationFailure } : {}), status: completion && exited && stopped ? 'ready' : authError ? 'authRequired' : 'environmentError', reason: completion && exited && stopped ? 'Minimal SDK inference completed; this is not task execution' : authError ? `SDK authentication requires configuration on the selected resource profile${authenticationFailure ? ' (' + authenticationFailure.code + ')' : ''}` : 'SDK/runtime probe did not complete within its bound', model, sdkVersion: observedSdkVersion }
    } finally {
      await rt.projectResources.release(lease.id, lease.generation, ...(child ? [{ handle: id, exited: exited && (stopped || startupFailed) }] : []))
      if (exited && (stopped || startupFailed) || !child) await rt.projectResources.command(project.id, body.resourceId, { cwd: resource.root, argv: ['rm', '-rf', '--', cwd] }).catch(() => {}) // Owned probe directory only; failed cleanup is not auth success.
    }
  }
  async function check(body, actor, { fresh = false } = {}) {
    const { project, resource } = await authorized(body, actor)
    const key = `${project.id}:${body.resourceId}:${body.harness}`
    let profile = null
    try { if (body.harness !== 'flybot') profile = harnessProfile(resource, project, body.resourceId, body.harness).profile } catch { /* The existing SDK configuration error result below owns incomplete profiles. */ }
    const checkKey = key + ':' + (profile?.id ?? 'native-or-unconfigured')
    if (checks.has(checkKey)) return checks.get(checkKey)
    const previous = rt.projectResources.harnessHealth(project.id, body.resourceId, body.harness)
    if (!fresh && previous && Date.now() - previous.at < 3000 && previous.status !== 'checking') return structuredClone(previous)
    const promise = (async () => {
      rt.state.projectHarnessHealth ??= {}
      setEntry(rt.state.projectHarnessHealth, key, { status: 'checking', profile, at: Date.now(), principalId: project.ownerUserId })
      await rt.save()
      let result
      const environment = await rt.projectResources.probe(project.id, body.resourceId)
      if (environment.status !== 'ready') result = { status: 'unreachable', reason: environment.reason }
      else if (body.harness === 'flybot') {
        if (resource.type !== 'local') result = { status: 'environmentError', reason: 'Native DSH requires the configured local host' }
        else {
          const role = rt.projectAgents.deliveryDefinitions(project.id).roles.find(row => row.role === body.role)
          const reply = await nativeProbe('project-runtime-probe', { prompt: 'Reply ready.', maxTokens: 8, model: role?.model || rt.config.projectModel })
          result = reply.ok ? { status: 'ready', reason: 'Minimal provider inference completed' } : { status: ['AUTH', 'NO_KEY'].includes(reply.code) ? 'authRequired' : 'environmentError', reason: reply.code }
        }
      } else {
        try { result = await probeSDK(body, project, resource) }
        catch (failure) { result = { status: failure.code === 'bot/resource' ? 'unreachable' : failure.code === 'bot/harness' ? 'unconfigured' : 'environmentError', reason: failure.code === 'bot/resource' ? 'Resource capacity or environment is unavailable' : 'Explicit SDK profile, model or runtime configuration is incomplete' } }
      }
      await authorized(body, actor)
      let currentProfile = null
      try { if (body.harness !== 'flybot') currentProfile = harnessProfile(rt.projectResources.setting(project.id, body.resourceId), rt.readProject(project.id), body.resourceId, body.harness).profile } catch { /* A changed/removed profile cannot inherit the old probe outcome. */ }
      if (profile?.id !== currentProfile?.id) return { status: 'unconfigured', reason: 'SDK profile changed during the check; inspect the current resource profile', profile: currentProfile, resourceId: body.resourceId, harness: body.harness, at: Date.now() }
      const row = { ...result, profile, at: Date.now(), principalId: project.ownerUserId, sdkVersion: result.sdkVersion ?? null, expectedSdkVersion: rt.projectHarness.versions[body.harness] ?? null, resourceId: body.resourceId, harness: body.harness }
      setEntry(rt.state.projectHarnessHealth, key, row); await rt.save(); rt.projectScheduler?.wake(); return structuredClone(row)
    })().finally(() => checks.delete(checkKey))
    checks.set(checkKey, promise); return promise
  }
  async function close(terminal, reason) {
    if (terminal.closed) return
    if (!terminal.processExited) terminal.process.stdin.end(JSON.stringify({ type: 'close' }) + '\n')
    await Promise.race([terminal.exited, delay(3000)])
    if (!terminal.released) { terminal.process.kill('SIGTERM'); await Promise.race([terminal.exited, delay(1000)]) }
    terminal.closed = true; terminal.output = []
    Object.assign(ownEntry(audits(), terminal.id), { closedAt: Date.now(), reason, released: terminal.released === true })
    await rt.save()
    if (reason === 'owner-close') void check(terminal.target, terminal.actor, { fresh: true }).catch(() => {}) // Current grants are rechecked; a failed recheck does not reopen the terminal.
  }
  async function open(body, actor) {
    const { project, resource } = await authorized(body, actor, true)
    if (!actor.sessionId) throw refuse('Terminal requires a live authenticated Session')
    if ([...terminals.values()].filter(row => (!row.closed || !row.released) && row.actor.memberId === actor.memberId).length >= 2) throw refuse('Close an existing configuration terminal first')
    const selected = await rt.projectHarness.profile(project.id, body.resourceId, body.harness, { forSetup: true })
    const runtime = resource.runtimeDir ?? resolve(import.meta.dirname, '../..')
    await rt.projectResources.command(project.id, body.resourceId, { cwd: resource.root, argv: ['mkdir', '-p', selected.selected.home, selected.selected.configDir] })
    let codexLoginAvailable = false
    if (body.harness === 'codex') {
      try {
        const module = pathToFileURL(join(runtime, 'src/host/project-codex-config.js')).href
        const result = await rt.projectResources.command(project.id, body.resourceId, { cwd: resource.root, argv: ['node', '--input-type=module', '-e', `import {codexExecutable} from ${JSON.stringify(module)}; process.stdout.write(JSON.stringify(codexExecutable()))`] })
        const executable = JSON.parse(result.stdout).executable
        if (!executable || !executable.startsWith('/')) throw Error('Invalid resource CLI path')
        selected.env.PATH = dirname(executable) + ':' + selected.env.PATH
        codexLoginAvailable = true
      } catch { /* A missing SDK must not block its own setup terminal; never substitute an ambient CLI. */ }
    }

    const process = rt.projectResources.startProcess(project.id, body.resourceId, { cwd: resource.root, argv: ['python3', '-u', join(runtime, 'src/host/project-terminal-worker.py')] })
    const terminal = { id: `terminal-${randomUUID()}`, profile: selected.profile, actor: { ...actor }, target: { projectId: project.id, resourceId: body.resourceId, harness: body.harness, role: body.role }, process,
      output: [], seq: 0, createdAt: Date.now(), lastSeen: Date.now(), expiresAt: Date.now() + 10 * 60_000, released: false }
    terminal.exited = new Promise(resolve => process.once('close', () => { terminal.processExited = true; resolve() }))
    process.stdin.on('error', () => { terminal.processInputEnded = true })
    process.once('error', () => { terminal.processInputEnded = true })
    process.stderr.resume()
    createInterface({ input: process.stdout }).on('line', line => {
      try {
        const event = JSON.parse(line)
        if (event.type === 'output' && !terminal.closed) {
          terminal.output.push({ seq: ++terminal.seq, text: Buffer.from(event.data, 'base64').toString('utf8') })
          while (terminal.output.reduce((sum, row) => sum + row.text.length, 0) > 65536) terminal.output.shift()
        }
        if (event.type === 'closed') terminal.released = event.released === true
      } catch { /* PTY protocol failures do not become screen/log output. */ }
    })
    terminals.set(terminal.id, terminal)
    setEntry(audits(), terminal.id, { id: terminal.id, projectId: project.id, resourceId: body.resourceId, harness: body.harness, principalId: selected.principalId, profile: selected.profile, initiatedBy: actor.memberId, createdAt: terminal.createdAt })
    process.stdin.write(JSON.stringify({ cwd: selected.selected.home, env: { ...selected.env, TERM: 'xterm-256color', FLYBOT_PROFILE_DIR: selected.selected.configDir, FLYBOT_SETUP_HARNESS: body.harness } }) + '\n')
    await rt.save()
    return { terminalId: terminal.id, expiresAt: terminal.expiresAt, resourceId: body.resourceId, harness: body.harness, profile: { ...selected.profile, home: selected.selected.home, configDir: selected.selected.configDir }, ...(body.harness === 'codex' ? { codexLoginAvailable } : {}),
      instructions: body.harness === 'flybot' ? 'Configure the explicitly registered native DSH profile using its provider setup commands. Close to recheck.' : `Configure this private profile. To save an API key with hidden input: node ${JSON.stringify(join(runtime, 'src/host/project-profile-auth.mjs'))}. ${body.harness === 'codex' ? codexLoginAvailable ? 'The SDK-resolved Codex CLI is on PATH; use codex login --device-auth here.' : 'The pinned Codex CLI is unavailable; provision the selected runtime before Codex login.' : ''} Codex login/device flow must run in this terminal's CODEX_HOME; this is the same profile used by the SDK worker. A cached login is not proof that token refresh succeeds. Do not copy old auth caches into new Attempts. Claude Agent SDK uses API/cloud credentials.` }
  }
  async function access(body, actor, heartbeat = true) {
    const terminal = terminals.get(body.terminalId)
    if (!terminal || terminal.actor.memberId !== actor.memberId || terminal.actor.sessionId !== actor.sessionId) throw refuse('This terminal belongs to another authenticated Session')
    try {
      await authorized(terminal.target, actor, true)
      const resource = rt.projectResources.setting(terminal.target.projectId, terminal.target.resourceId)
      if (harnessProfile(resource, rt.readProject(terminal.target.projectId), terminal.target.resourceId, terminal.target.harness).profile.id !== terminal.profile.id) { await close(terminal, 'profile-changed'); throw refuse('Resource profile changed; reopen its configuration terminal') }
      const session = ownEntry(rt.state.authSessions ?? {}, actor.sessionId)
      if (!session || session.revokedAt || Date.now() > terminal.expiresAt || rt.platformIdentityEnabled && !await (rt.validateHumanActor ? rt.validateHumanActor(actor) : rt.validatePlatformActor(actor))) throw refuse('Configuration terminal expired or access was revoked')
    } catch (error) { await close(terminal, 'authorization-ended'); throw error }
    if (heartbeat) terminal.lastSeen = Date.now()
    return terminal
  }
  async function endpoint(endpoint, body, actor) {
    if (endpoint === 'project-runtime-check') return check(body, actor)
    if (endpoint === 'project-terminal-open') return open(body, actor)
    const terminal = await access(body, actor)
    if (endpoint === 'project-terminal-close') { await close(terminal, 'owner-close'); return { closed: true, released: terminal.released } }
    if (terminal.closed || terminal.released || terminal.processExited || terminal.processInputEnded) return { closed: true, output: [], seq: terminal.seq, reason: terminal.closed ? 'Configuration terminal closed' : 'Target terminal runtime ended; check the resource environment before reconnecting' }
    if (endpoint === 'project-terminal-input') {
      if (typeof body.text !== 'string' || body.text.length > 8192) throw refuse('Invalid terminal input')
      terminal.process.stdin.write(JSON.stringify({ type: 'input', data: Buffer.from(body.text).toString('base64') }) + '\n'); return { sent: true }
    }
    if (endpoint === 'project-terminal-resize') {
      terminal.process.stdin.write(JSON.stringify({ type: 'resize', rows: Math.max(8, Math.min(100, Number(body.rows) || 24)), cols: Math.max(20, Math.min(240, Number(body.cols) || 80)) }) + '\n'); return { resized: true }
    }
    return { closed: terminal.closed, seq: terminal.seq, output: terminal.output.filter(row => row.seq > (Number(body.since) || 0)) }
  }
  async function sweep() {
    for (const terminal of terminals.values()) {
      if (terminal.closed) { if (Date.now() - terminal.createdAt > 15 * 60_000) terminals.delete(terminal.id); continue }
      if (Date.now() - terminal.lastSeen > 15_000) { await close(terminal, 'connection-ended'); continue }
      try { await access({ terminalId: terminal.id }, terminal.actor, false) } catch { /* access closes revoked/expired terminals. */ }
    }
  }
  return { endpoint, check, sweep, revoke: (sessionId, projectId, memberId) => Promise.all([...terminals.values()].filter(row => sessionId ? row.actor.sessionId === sessionId : row.target.projectId === projectId && row.actor.memberId === memberId).map(row => close(row, 'authorization-ended'))), dispose: () => Promise.all([...terminals.values()].map(row => close(row, 'host-shutdown'))) }
}
export function install(rt) {
  rt.projectRuntimeSetup = createProjectRuntimeSetup(rt)
  if (!rt.sharedProjectMode?.()) return
  rt.ctx.effect(() => { const timer = setInterval(() => { void rt.projectRuntimeSetup.sweep().catch(error => rt.warn('Terminal grant check: %s', error.message)) }, 5000); timer.unref?.(); return () => { clearInterval(timer); return rt.projectRuntimeSetup.dispose() } }, 'ds-bot: private resource terminals')
}
