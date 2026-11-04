import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createProjectResources } from '../src/host/project-resources.js'
import { createProjectHarness } from '../src/host/project-harness.js'
import { createProjectRuntimeSetup } from '../src/host/project-runtime-setup.js'
const owner = { memberId: 'owner', sessionId: 's' }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'flybot-private-pty-'))
  const rt = { home: root, state: { bots: {}, authSessions: { s: { id: 's', memberId: 'owner' } } }, config: { projectResources: {
    local: { type: 'local', root, profileRoot: join(root, 'profiles'), capacity: 2, allowedProjectOwnerIds: ['owner'], adminMemberIds: ['owner'], harnesses: ['codex'], runtimeDir: resolve(import.meta.dirname, '..') },
  } }, save: async () => {}, readProject: () => ({ id: 'p', ownerUserId: 'owner' }),
    projectAgents: { deliveryDefinitions: () => ({ roles: [] }) },
    requireProjectAccess(actor, projectId) { if (actor.memberId !== 'owner' || projectId !== 'p') throw new Error('Project access denied'); return rt.readProject() } }
  rt.projectResources = createProjectResources(rt); rt.projectHarness = createProjectHarness(rt)
  const setup = createProjectRuntimeSetup(rt)
  t.after(async () => { await setup.dispose(); await rm(root, { recursive: true, force: true }) })
  return { rt, setup, root, body: { projectId: 'p', resourceId: 'local', harness: 'codex' } }
}
async function screen(setup, id, match) {
  for (let n = 0; n < 80; n++) {
    const value = await setup.endpoint('project-terminal-poll', { terminalId: id }, owner)
    const output = value.output.map(row => row.text).join('')
    if (match.test(output)) return output
    await wait(25)
  }
  throw new Error('Actual PTY output did not match')
}

test('configuration terminal uses a real PTY/profile and retains no raw input/screen in persistent audit', async t => {
  const { setup, rt, body } = await fixture(t)
  const opened = await setup.endpoint('project-terminal-open', body, owner)
  await setup.endpoint('project-terminal-input', { terminalId: opened.terminalId, text: "test -t 0 && printf 'REAL_%s\\n' PTY_OK\n" }, owner)
  assert.match(await screen(setup, opened.terminalId, /REAL_PTY_OK/), /REAL_PTY_OK/)
  await setup.endpoint('project-terminal-resize', { terminalId: opened.terminalId, rows: 30, cols: 100 }, owner)
  const closed = await setup.endpoint('project-terminal-close', { terminalId: opened.terminalId }, owner)
  assert.equal(closed.released, true)
  const audit = rt.state.projectTerminalAudit[opened.terminalId]
  assert.equal(audit.released, true)
  assert.equal(JSON.stringify(audit).includes('REAL_PTY_OK'), false)
  assert.equal(audit.text, undefined)
})

test('terminal requires an explicit resource admin grant and binds one authenticated Session', async t => {
  const { setup, rt, body } = await fixture(t)
  await assert.rejects(setup.endpoint('project-terminal-open', body, { memberId: 'member', sessionId: 'm' }), /denied/)
  rt.config.projectResources.local.adminMemberIds = []
  await assert.rejects(setup.endpoint('project-terminal-open', body, owner), /administration/)
  rt.config.projectResources.local.adminMemberIds = ['owner']
  const opened = await setup.endpoint('project-terminal-open', body, owner)
  await assert.rejects(setup.endpoint('project-terminal-poll', { terminalId: opened.terminalId }, { ...owner, sessionId: 'another' }), /another authenticated/)
  rt.state.authSessions.s.revokedAt = Date.now()
  await assert.rejects(setup.endpoint('project-terminal-poll', { terminalId: opened.terminalId }, owner), /revoked/)
  assert.equal(rt.state.projectTerminalAudit[opened.terminalId].released, true)
})

test('resource environment success cannot become authentication success without an SDK model/profile', async t => {
  const { setup, rt, body } = await fixture(t)
  const result = await setup.check(body, owner)
  assert.equal(rt.state.projectResourceHealth.local.status, 'ready')
  assert.equal(result.status, 'unconfigured')
  assert.equal(result.principalId, 'owner')
  assert.equal(result.harness, 'codex')
})


test('hidden PTY credential setup stores only the selected private profile and never echoes the key', async t => {
  const { setup, rt, body } = await fixture(t)
  const opened = await setup.endpoint('project-terminal-open', body, owner)
  const selected = await rt.projectHarness.profile('p', 'local', 'codex', { forSetup: true })
  const helper = resolve(import.meta.dirname, '../src/host/project-profile-auth.mjs')
  await setup.endpoint('project-terminal-input', { terminalId: opened.terminalId, text: `node '${helper}'\n` }, owner)
  await screen(setup, opened.terminalId, /API key \(hidden input\)/)
  const secret = 'unit-only-secret-never-echoed'
  await setup.endpoint('project-terminal-input', { terminalId: opened.terminalId, text: secret + '\n' }, owner)
  const output = await screen(setup, opened.terminalId, /Saved to this authorized resource/)
  assert.equal(output.includes(secret), false)
  const path = join(selected.selected.configDir, 'flybot-credentials.json')
  assert.equal(JSON.parse(await readFile(path, 'utf8')).CODEX_API_KEY, secret)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal((await rt.projectHarness.profile('p', 'local', 'codex')).env.CODEX_API_KEY, secret)
  assert.equal(JSON.stringify(rt.state).includes(secret), false)
  await setup.endpoint('project-terminal-close', { terminalId: opened.terminalId }, owner)
})

test('closing a resource terminal also stops its interactive background jobs', async t => {
  const { setup, body, root } = await fixture(t)
  const opened = await setup.endpoint('project-terminal-open', body, owner)
  const pidPath = join(root, 'owned-child.pid')
  await setup.endpoint('project-terminal-input', { terminalId: opened.terminalId, text: `node -e 'setInterval(()=>{},1000)' & echo $! > '${pidPath}'\n` }, owner)
  let pid
  for (let n = 0; n < 80; n++) { try { pid = Number(await readFile(pidPath, 'utf8')); if (pid) break } catch { /* Wait for the actual shell to write its own child PID. */ } await wait(25) }
  assert.ok(pid > 1)
  process.kill(pid, 0)
  await setup.endpoint('project-terminal-close', { terminalId: opened.terminalId }, owner)
  let running = true
  for (let n = 0; n < 40; n++) {
    try { const status = await readFile(`/proc/${pid}/stat`, 'utf8'); running = !/^\S+ \(.+\) Z /.test(status) } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; running = false }
    if (!running) break
    await wait(25)
  }
  assert.equal(running, false, 'The owned PTY job must not remain running after close')
})

test('a missing target PTY bridge ends as an environment error rather than a live terminal', async t => {
  const { setup, rt, body, root } = await fixture(t)
  rt.config.projectResources.local.runtimeDir = join(root, 'missing-runtime')
  const opened = await setup.endpoint('project-terminal-open', body, owner)
  let ended = false
  for (let n = 0; n < 40; n++) { const view = await setup.endpoint('project-terminal-poll', { terminalId: opened.terminalId }, owner); if (view.closed) { ended = true; break } await wait(25) }
  assert.equal(ended, true)
  const result = await setup.endpoint('project-terminal-input', { terminalId: opened.terminalId, text: 'must not be dispatched\n' }, owner)
  assert.equal(result.closed, true)
})

test('missing SDK bridge cannot consume probe capacity or imply authentication readiness', async t => {
  const { setup, rt, body, root } = await fixture(t)
  rt.config.projectResources.local.runtimeDir = join(root, 'missing-sdk-runtime')
  rt.projectAgents.deliveryDefinitions = () => ({ roles: [{ role: 'developer', execution: { harness: 'codex', model: 'contract-model' } }] })
  const result = await setup.check(body, owner)
  assert.equal(result.status, 'environmentError')
  assert.equal(result.sdkVersion, null)
  assert.equal(rt.projectResources.occupied('local'), 0)
})

test('configuration PTY reports and actually uses the same persistent profile as SDK roles, and refuses changed profile input', async t => {
  const { setup, rt, body, root } = await fixture(t)
  const opened = await setup.endpoint('project-terminal-open', body, owner), selected = await rt.projectHarness.profile('p', 'local', 'codex')
  assert.equal(opened.profile.id, selected.profile.id)
  assert.equal(opened.codexLoginAvailable, true)
  assert.equal(opened.profile.configDir, selected.env.CODEX_HOME)
  await setup.endpoint('project-terminal-input', {terminalId:opened.terminalId,text:"printf 'ACTUAL_CODEX_PROFILE=%s\\n' \"$CODEX_HOME\"\n"}, owner)
  assert.ok((await screen(setup, opened.terminalId, /ACTUAL_CODEX_PROFILE=\//)).includes(selected.env.CODEX_HOME))
  await setup.endpoint('project-terminal-input', { terminalId: opened.terminalId, text: "printf 'PINNED_CODEX=%s\\n' \"$(command -v codex)\"\n" }, owner)
  assert.match(await screen(setup, opened.terminalId, /PINNED_CODEX=\//), /vendor.*codex/)
  const next = await rt.projectHarness.profile('p','local','codex')
  assert.equal(next.profile.id, opened.profile.id)
  rt.config.projectResources.local.profileRoot = join(root,'new-profiles')
  await assert.rejects(setup.endpoint('project-terminal-input',{terminalId:opened.terminalId,text:'must not run\n'},owner),/profile changed/)
  assert.equal(rt.state.projectTerminalAudit[opened.terminalId].released,true)
})

test('SDK probe preserves typed refresh-token failure and does not reuse readiness from another profile', async t => {
  const { setup, rt, body, root } = await fixture(t)
  const { mkdir, writeFile } = await import('node:fs/promises')
  const runtime = join(root,'runtime'); await mkdir(join(runtime,'src/host'),{recursive:true})
  rt.config.projectResources.local.runtimeDir = runtime
  rt.projectAgents.deliveryDefinitions = () => ({ roles:[{role:'reviewer',execution:{harness:'codex',model:'fixture-model'}}] })
  await writeFile(join(runtime,'src/host/project-harness-worker.mjs'), `import{createInterface}from'node:readline';const lines=createInterface({input:process.stdin});const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');send({type:'ready',sdk:{codex:'0.166.0'}});lines.on('line',line=>{const m=JSON.parse(line);if(m.type==='start')send({type:'failure',authenticationFailure:{code:'refresh_token_reused'},reason:'safe auth failure'});if(m.type==='stop'){send({type:'stopped',released:true});process.exit(0)}});`)
  const result = await setup.check(body,owner)
  assert.equal(result.status,'authRequired'); assert.equal(result.authenticationFailure.code,'refresh_token_reused')
  const selected = await rt.projectHarness.profile('p','local','codex')
  assert.equal(result.profile.id, selected.profile.id); assert.equal(rt.projectResources.occupied('local'),0)
  rt.state.projectHarnessHealth['p:local:codex'] = {...result,status:'ready'}
  assert.equal(rt.projectResources.harnessHealth('p','local','codex').status,'ready')
  rt.config.projectResources.local.profileRoot = join(root,'other-profile')
  assert.equal(rt.projectResources.harnessHealth('p','local','codex').status,'unconfigured')
  const again = await setup.check(body,owner)
  assert.equal(again.status,'authRequired'); assert.notEqual(again.profile.id,result.profile.id)
})
