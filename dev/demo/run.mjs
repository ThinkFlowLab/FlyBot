import { chiefRestartModel, checkChiefRestart } from './chief-restart.mjs'
// M0: real pinned DSH, disposable data, deterministic model, actual shell execution.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mockModel } from './mock.mjs'
import { nativePoolModel, checkNativePools } from './native-pools.mjs'
import { checkLiveWorkbench } from './live-workbench.mjs'
import { serveWorkbench } from './serve.mjs'
import { checkWorkbench } from './workbench.mjs'
import { checkQueue, provisionQueueGate } from './queue.mjs'
import { agentReply, checkAgents } from './agents.mjs'
import { openSqliteState } from '../../core/src/host/project-state-sqlite.js'
import { checkDelivery, deliveryReply, provisionDeliveryFixture } from './delivery.mjs'
import { checkShared } from './shared.mjs'
import { verifyArtifact } from './artifact.mjs'
import { codexSettings, checkCodexDelivery } from './codex-check.mjs'

const root = resolve(import.meta.dirname, '../..')
const shutdown = new AbortController()
const sleep = ms => new Promise(done => setTimeout(done, ms))
const json = path => JSON.parse(readFileSync(path, 'utf8'))

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}

async function waitFor(read, label, milliseconds = 90_000) {
  const end = Date.now() + milliseconds
  while (Date.now() < end) {
    if (shutdown.signal.aborted) throw new Error('Demo stopped')
    const value = await read()
    if (value) return value
    await sleep(200)
  }
  throw new Error(`Timeout: ${label}`)
}

async function main() {
  const chiefRestart = process.argv.includes('--chief-restart'), chiefModel = chiefRestart ? chiefRestartModel() : null
  const nativePools = process.argv.includes('--native-pools')
  const sqlite = process.argv.includes('--sqlite')
  const nativeModel = nativePools ? nativePoolModel() : null
  const agents = process.argv.includes('--agents')
  const serve = process.argv.includes('--workbench-serve')
  const live = process.argv.includes('--live-check')
  const codex = process.argv.includes('--codex-check') ? codexSettings(process.argv) : null
  const realModel = process.argv.includes('--real-model') || live
  const workbench = process.argv.includes('--workbench') || serve || live
  if (realModel && (!serve && !live || !process.env.DEEPSEEK_API_KEY || !process.env.DEEPSEEK_BASE_URL)) throw new Error('Real-model demo requires --workbench-serve or --live-check and explicit DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL environment configuration')
  const requestStop = () => shutdown.abort()
  if (serve) { process.on('SIGINT', requestStop); process.on('SIGTERM', requestStop) }
  const queue = process.argv.includes('--queue')
  const delivery = nativePools || process.argv.includes('--delivery') || queue || workbench || Boolean(codex)
  const githubRepository = process.argv.includes('--github-repo') ? process.argv[process.argv.indexOf('--github-repo') + 1] : undefined
  const githubConfigDir = process.argv.includes('--github-config-dir') ? process.argv[process.argv.indexOf('--github-config-dir') + 1] : undefined
  if (githubRepository && (!delivery || !githubConfigDir)) throw new Error('GitHub demo requires --delivery and explicit --github-config-dir')
  const shared = process.argv.includes('--shared') ? JSON.parse(readFileSync(0, 'utf8')) : null
  const harness = join(root, 'core/dev/harness/node_modules')
  const cli = join(harness, '@deepseek-ai/dsh/lib/bin.js')
  assert.ok(existsSync(cli), 'Run npm ci and npm run harness in core/ first')
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'flybot-m0-')))
  const home = join(directory, 'data')
  const workspace = join(directory, 'workspace')
  const scratch = join(directory, 'scratch')
  const profile = join(home, 'profiles/web')
  const modules = join(profile, 'node_modules')
  mkdirSync(modules, { recursive: true })
  mkdirSync(workspace)
  mkdirSync(scratch)
  if (delivery) provisionDeliveryFixture(workspace, githubRepository)
  const queueGate = queue ? provisionQueueGate(directory) : null
  const golden = join(directory, 'golden-test.mjs')
  if (live || codex) writeFileSync(golden, `import assert from 'node:assert/strict'; import {pathToFileURL} from 'node:url'; import {resolve} from 'node:path'; const {add}=await import(pathToFileURL(resolve('code.mjs'))); for(const [a,b] of [[2,3],[-7,2],[11,13],[0,0],[0,-4],[1.5,2.5]]) assert.equal(add(a,b),a+b); console.log('Immutable host addition tests passed'); if(process.argv.includes('--force-failure')) {console.error('Intentional host-test failure for negative acceptance');process.exit(9)}`)
  for (const entry of readdirSync(harness)) {
    if (entry.startsWith('.')) continue
    symlinkSync(join(harness, entry), join(modules, entry))
  }
  symlinkSync(join(root, 'core'), join(modules, 'ds-bot'))
  mkdirSync(join(modules, '@flybot'), { recursive: true })
  symlinkSync(join(root, 'plugins/workflow'), join(modules, '@flybot/workflow'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'm0-profile', private: true,
    dependencies: { 'ds-bot': `link:${root}/core`, '@flybot/workflow': `link:${root}/plugins/workflow`,
      '@deepseek-ai/dsh-base': '0.2.1-rc.2', '@deepseek-ai/dsh-web-app': '0.2.1-rc.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot', '@flybot/workflow'] } } }))
  const observations = []
  const model = mockModel(observations, { reply: chiefModel ? input => chiefModel.reply(input) : nativeModel ? input => nativeModel.reply(input) ?? deliveryReply(input) : (workbench ? input => deliveryReply(input) ?? agentReply(input) : delivery ? deliveryReply : agents ? agentReply : undefined) })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const port = await freePort()
  const logPath = join(directory, 'web.log')
  const log = openSync(logPath, 'w', 0o600)
  const env = { ...process.env, HOME: directory, DSH_HOME: home,
    TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    DEEPSEEK_API_KEY: realModel ? process.env.DEEPSEEK_API_KEY : 'mock-key', DEEPSEEK_BASE_URL: realModel ? process.env.DEEPSEEK_BASE_URL : `http://127.0.0.1:${model.address().port}/v1`,
    NODE_OPTIONS: `--import=${join(import.meta.dirname, 'resolve.mjs')}` }
  // External connector credentials are not needed in this transport check.
  for (const name of Object.keys(env)) if (/TOKEN|SECRET|API_KEY/.test(name) && name !== 'DEEPSEEK_API_KEY') delete env[name]
  let patch = join(root, 'docker/web.patch.yml')
  if (shared || delivery || agents || chiefRestart) {
    patch = join(directory, 'shared.patch.yml')
    const botConfig = { projectWorkbench: true,
      ...(nativePools ? { projectResources: { 'native-local': { type: 'local', root: directory, capacity: 1, allowedProjectOwnerIds: ['owner-1'], harnesses: ['flybot'] } } } : {}),
      ...(codex ? { projectResources: { 'codex-local': { type: 'local', root: directory, capacity: 3, nodePath: process.execPath, allowedProjectOwnerIds: ['owner-1'], adminMemberIds: ['owner-1'], harnesses: ['codex'], profiles: { 'owner-1': { codex: { home: codex.home, configDir: codex.configDir, model: codex.model } } } } } } : {}),
      ...(workbench && !live ? { projectResources: { 'demo-local': { type: 'local', root: directory, profileRoot: join(directory, 'private-sdk-profiles'), capacity: 2,
        allowedProjectOwnerIds: ['owner-1'], adminMemberIds: ['owner-1'], harnesses: ['codex'], profiles: { 'owner-1': { codex: { home: join(directory, 'sdk-home'), configDir: join(directory, 'sdk-config'), model: 'fixture-sdk-probe', baseUrl: 'http://127.0.0.1:1' } } } } } } : {}), ...(workbench ? { projectDemoMode: realModel ? 'real-provider' : 'deterministic-fixture' } : {}),
      ...(shared ? { controlPlane: { origin: shared.origin, ownerSubject: shared.ownerSubject } } : {}),
      ...(sqlite ? { stateStorage: 'sqlite' } : {}), ...(delivery ? { projectDispatch: nativePools ? 'pools' : 'workflow', projectRepositories: { [githubRepository ?? 'example/delivery-fixture']: { ...(githubRepository ? { github: { credential: 'gh-cli', configDir: githubConfigDir, ...(codex ? { login: codex.login } : {}) } } : {}), path: workspace, testCommand: queueGate?.command ?? (live || codex ? [process.execPath, golden] : [process.execPath, '--test', 'code.test.mjs']), allowedPaths: ['code.mjs', 'code.test.mjs'] }, ...(live ? { 'example/intentional-failure': { path: workspace, testCommand: [process.execPath, golden, '--force-failure'], allowedPaths: ['code.mjs', 'code.test.mjs'] } } : {}) } } : {}) }
    writeFileSync(patch, readFileSync(join(root, 'docker/web.patch.yml'), 'utf8') + (live ? '\n- id: llm-deepseek\n  config: { thinking: disabled, reasoningEffort: off, maxTokens: 8192 }\n' : '') + `\n- id: bot\n  config: ${JSON.stringify(botConfig)}\n`, { mode: 0o600 })
  }
  if (chiefRestart) delete env.INVOCATION_ID
  let child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch,
    '--no-open', '--port', String(port)], { cwd: workspace, env, stdio: ['ignore', log, log], detached: true })
  closeSync(log)
  let childError
  child.on('error', error => { childError = error })
  const statePath = join(home, 'bot/state.json')
  const saved = () => {
    if (!existsSync(statePath)) return null
    if (!sqlite) return json(statePath)
    const database = openSqliteState({ path: join(home, 'bot/state.sqlite'), readOnly: true })
    try { return database.read() } finally { database.close() }
  }
  const teamWorkspace = join(home, 'bot/workspace')
  let keep = false
  const stop = signal => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch (error) {
      if (error.code !== 'ESRCH') console.error(`Could not stop demo process group: ${error.code}`)
    }
  }
  try {
    const login = await waitFor(() => {
      if (childError || child.exitCode !== null) throw new Error('DSH exited before startup')
      return readFileSync(logPath, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
    }, 'DSH startup')
    const response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    let cookie = response.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
    assert.ok(cookie, 'DSH login cookie')
    const call = async (endpoint, payload = {}, member) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/bot`, { method: 'POST',
        headers: { 'content-type': 'application/json', cookie, ...(member ? { 'x-flybot-member-session': member } : {}) },
        body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(10_000) })
      return response.json()
    }
    const api = async (...args) => {
      const result = await call(...args)
      assert.equal(result.ok, true, `API ${args[0]}: ${result.error?.code ?? 'failed'}`)
      return result.value
    }
    if (chiefRestart) {
      const restart = async () => {
        const previous = child, offset = readFileSync(logPath, 'utf8').length
        stop('SIGKILL'); await once(previous, 'exit')
        const output = openSync(logPath, 'a', 0o600)
        childError = null
        child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)], { cwd: workspace, env, stdio: ['ignore', output, output], detached: true })
        closeSync(output)
        child.on('error', error => { childError = error })
        const login = await waitFor(() => {
          if (childError || child.exitCode !== null) throw new Error('Restarted disposable DSH exited before startup')
          return readFileSync(logPath, 'utf8').slice(offset).match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
        }, 'unmanaged DSH restart')
        const response = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
        cookie = response.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
      }
      console.log(JSON.stringify(await checkChiefRestart({ api, saved, waitFor, restart, model: chiefModel })))
      return
    }
    if (codex) {
      const report = await checkCodexDelivery({ api, saved, waitFor: (read, label) => waitFor(read, label, 600_000), settings: codex, artifacts: process.env.FLYBOT_DEMO_ARTIFACTS })
      assert.equal(observations.length, 0, 'Codex acceptance must never call the deterministic native model')
      console.log(JSON.stringify({ ...report, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '' }))
      return
    }
    if (live) {
      if (!shared || !githubRepository || !githubConfigDir) throw new Error('Live acceptance requires platform accounts and explicit GitHub repository/config directory')
      const report = await checkLiveWorkbench({ credentials: shared, port, cookie, saved, waitFor: (read, label) => waitFor(read, label, 600_000), githubRepository, githubConfigDir, artifacts: process.env.FLYBOT_DEMO_ARTIFACTS })
      assert.equal(observations.length, 0, 'Real acceptance must not contact the mock model')
      console.log(JSON.stringify({ ...report, source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '' }))
      return
    }
    if (serve) {
      if (!shared) throw new Error('Workbench serving requires --shared credentials on stdin')
      await serveWorkbench({ port, cookie, platformOrigin: shared.origin, realModel, signal: shutdown.signal })
      return
    }
    if (workbench) {
      if (!shared) throw new Error('Workbench browser acceptance requires --shared credentials on stdin')
      console.log(JSON.stringify({ ...await checkWorkbench({ credentials: shared, port, cookie, saved, waitFor, artifacts: process.env.FLYBOT_DEMO_ARTIFACTS }), source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '' }))
      return
    }
    if (agents) {
      console.log(JSON.stringify(await checkAgents({ api, call, saved, waitFor })))
      return
    }
    if (queue) {
      console.log(JSON.stringify(await checkQueue({ api, call, saved, waitFor, releaseVerification: queueGate.release })))
      return
    }
    if (nativePools) {
      console.log(JSON.stringify(await checkNativePools({ api, saved, waitFor, repository: workspace, model: nativeModel, storage: sqlite ? 'sqlite' : 'json' })))
      return
    }
    if (delivery) {
      console.log(JSON.stringify(await checkDelivery({ api, call, saved, waitFor, repository: workspace, githubRepository })))
      return
    }
    if (shared) {
      const report = await checkShared({ credentials: shared, api, call, saved, waitFor, workspace: teamWorkspace, verifyArtifact })
      console.log(JSON.stringify(report))
      return
    }
    const state = await api('state')
    const modelRef = state.models.find(row => /deepseek-flash/.test(row.ref))?.ref ?? state.models.at(-1)?.ref
    assert.ok(modelRef, 'Mock model route catalog')
    const chief = Object.values(saved().bots).find(bot => saved().mainBotIds.includes(bot.id))
    await api('update-bot', { id: chief.id, model: modelRef })
    const { project } = await api('project-create', { name: 'M1 stable ownership' })
    await api('project-bind', { kind: 'bot', id: chief.id, projectId: project.id })
    const task = await api('task-create', { botId: chief.id, title: 'M1 execution probe' })
    assert.equal(task.projectId, project.id)
    const { project: other } = await api('project-create', { name: 'M1 other routing' })
    await api('project-bind', { kind: 'bot', id: chief.id, projectId: other.id })
    assert.equal(saved().tasks[task.id].projectId, project.id)
    const board = await api('project-board', { id: project.id })
    assert.ok(board.tasks.some(row => row.id === task.id), 'Task stays on original Project board')
    const created = await api('flybot/workflow/create', { name: 'M0 probe', nodes: [
      { id: 'probe', name: 'Probe', role: 'M0 verifier', model: modelRef, prompt: 'Execute the isolated M0 shell probe.', tools: [], outputs: [{ name: 'proof' }] },
    ], edges: [], maxConcurrent: 1 })
    const workflow = created.workflows.find(row => row.name === 'M0 probe')
    assert.ok(workflow, 'Workflow created')
    await api('flybot/workflow/assign', { workflowId: workflow.id, taskId: task.id, projectId: project.id, title: 'M0 probe', brief: 'Write probe.mjs and proof.json and execute the test.' })
    const ephemeral = await waitFor(() => Object.values(saved().bots).find(bot => bot.ephemeral), 'ephemeral Bot creation')
    assert.equal(ephemeral.hidden, true)
    assert.ok(ephemeral.ownerId, 'Ephemeral Bot has an owner')
    await waitFor(() => existsSync(join(teamWorkspace, 'proof.json')), 'real bash writes and test')
    await verifyArtifact(teamWorkspace)
    await waitFor(() => !saved().bots[ephemeral.id], 'ephemeral Bot cleanup')
    const completed = await waitFor(() => json(join(home, 'bot/flybot-workflow/workflows.json')).lanes[workflow.id].last, 'persisted Workflow terminal checkpoint after worker cleanup')
    assert.equal(completed.status, 'done')
    assert.equal(completed.projectId, project.id)
    await waitFor(() => saved().projectExecutions[completed.id]?.status === 'done', 'canonical terminal Run report')
    assert.equal(saved().projectExecutions[completed.id].projectId, project.id)
    assert.equal(saved().projectExecutions[completed.id].taskId, task.id)
    const worker = await api('create-bot', { name: 'Explicit cwd probe', model: modelRef, workDir: workspace })
    await api('update-bot', { id: worker.id, permission: 'danger-full-access' })
    await api('send', { sessionId: worker.id, text: 'Execute the M0 shell probe in the configured working folder.' })
    await waitFor(() => existsSync(join(workspace, 'proof.json')), 'explicit Bot cwd')
    await verifyArtifact(workspace)
    await waitFor(async () => Object.keys((await api('state')).activity ?? {}).length === 0, 'explicit Bot idle')
    await api('delete-bot', { id: worker.id })
    assert.ok(observations.some(row => row.toolRequested) && observations.some(row => row.toolResult), 'Tool call/result round trip')
    assert.ok(observations.some(row => row.sessionHeader), 'DSH session header')
    const invitation = await api('auth-invite')
    const alice = await api('auth-redeem', { token: invitation.token, displayName: 'Alice' })
    const second = await api('auth-invite', {}, alice.sessionToken)
    const bob = await api('auth-redeem', { token: second.token, displayName: 'Bob' })
    assert.notEqual(alice.memberId, bob.memberId)
    assert.equal((await api('auth-whoami', {}, alice.sessionToken)).memberId, alice.memberId)
    assert.equal((await api('auth-whoami', {}, bob.sessionToken)).memberId, bob.memberId)
    const blocked = await call('flybot/workflow/create', { name: 'Unauthorized shared write', nodes: [] }, bob.sessionToken)
    assert.equal(blocked.error?.code, 'bot/blocked-shared')
    const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '',
      dsh: json(join(harness, '@deepseek-ai/dsh/package.json')).version,
      model: 'deterministic mock (not real-model acceptance)', transport: 'real DSH HTTP',
      checks: ['authenticated API', 'ephemeral creation/owner/cleanup', 'default team cwd and explicit Bot cwd', 'actual bash write/test',
        'independent code verification', 'tool call/result and session header', 'two distinct member sessions', 'shared plugin write denied'],
      blockers: ['Platform users are not linked to DSH members (M2).',
        'Shared project Workflow writes remain blocked with multiple members (M2).',
        'Workflow spawn does not accept a per-run cwd; run Bots inherit the FlyBot team workspace, not the DSH process cwd (M3).'],
      notRun: ['real model', 'GitHub PR', 'browser UI', 'production deployment'] }
    console.log(JSON.stringify(report, null, 2))
    if (process.env.M0_REPORT) writeFileSync(resolve(process.env.M0_REPORT), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  } catch (error) {
    if (!serve || !shutdown.signal.aborted) {
      keep = true
      console.error(`M0 failed: ${error.message}\nPrivate diagnostics retained at ${directory}; do not publish web.log.`)
      process.exitCode = 1
    }
  } finally {
    if (child.pid && child.exitCode === null) {
      stop('SIGTERM')
      await Promise.race([once(child, 'exit'), sleep(5000)])
      stop('SIGKILL')
    }
    chiefModel?.finishHeld()
    model.closeAllConnections()
    await new Promise(done => model.close(done))
    if (!keep) rmSync(directory, { recursive: true, force: true })
    if (serve) { process.off('SIGINT', requestStop); process.off('SIGTERM', requestStop) }
  }
}

await main()
