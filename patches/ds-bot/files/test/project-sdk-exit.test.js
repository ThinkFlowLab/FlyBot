import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SDK_EXIT_VERSION, registerSdkExit, acknowledgeSdkStop, inspectSdkExit, forgetSdkExit } from '../src/host/project-sdk-exit.mjs'
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'flybot-sdk-exit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const value = { version: SDK_EXIT_VERSION, root, workerId: 'sdk-exit-fixture', leaseId: 'lease-fixture', generation: 1 }
  return { value, path: join(root, '.flybot-sdk-exit', value.workerId + '.json') }
}
async function worker(t) {
  const f = await fixture(t)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/host/project-harness-worker.mjs', import.meta.url)), JSON.stringify(f.value)], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume(); child.stdin.on('error', () => {})
  const exit = once(child, 'close'), lines = createInterface({ input: child.stdout })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; lines.close() })
  const [line] = await Promise.race([once(lines, 'line'), exit.then(() => { throw Error('Worker did not register') })])
  assert.equal(JSON.parse(line).exitRecovery, SDK_EXIT_VERSION)
  return { ...f, child, exit }
}
test('invalid/missing SDK exit evidence never implies release and registration cannot overwrite another record', async t => {
  const f = await fixture(t)
  assert.equal((await inspectSdkExit(f.value)).status, 'unknown')
  await assert.rejects(registerSdkExit({ ...f.value, workerId: '../foreign' }), /identity/)
  await registerSdkExit(f.value)
  await assert.rejects(registerSdkExit(f.value), /EEXIST/)
  assert.equal((await inspectSdkExit({ ...f.value, generation: 2 }, { stop: true })).status, 'unknown')
  await acknowledgeSdkStop(f.value)
  assert.equal((await inspectSdkExit(f.value)).status, 'unknown', 'A stopped receipt alone cannot prove the writer process exited')
  await writeFile(f.path, 'malformed receipt')
  assert.equal((await inspectSdkExit(f.value)).status, 'unknown')
  await rm(f.path); await symlink(join(f.value.root, 'private'), f.path)
  assert.equal((await inspectSdkExit(f.value)).status, 'unknown')
  await unlink(f.path); await writeFile(f.path, 'x'.repeat(9000))
  assert.equal((await inspectSdkExit(f.value)).status, 'unknown')
})
test('SDK exit records refuse a symlinked supervisor directory', async t => {
  const f = await fixture(t), foreign = join(f.value.root, 'foreign')
  await mkdir(foreign); await symlink(foreign, join(f.value.root, '.flybot-sdk-exit'))
  await assert.rejects(registerSdkExit(f.value), /directory changed/)
})
test('resource exit CLI rejects unsupported operations with a bounded machine-readable result', () => {
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('../src/host/project-sdk-exit.mjs', import.meta.url)), 'unsupported', '{}'], { encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.deepEqual(JSON.parse(error.stdout), { status: 'unknown', reason: 'exit-evidence-unavailable' }); return true
  })
})
if (process.platform === 'linux') {
  test('actual idle SDK worker can be stopped by exact resource process identity after controller loss', { timeout: 15000 }, async t => {
    const f = await worker(t)
    assert.equal((await inspectSdkExit(f.value)).status, 'unknown')
    assert.equal((await inspectSdkExit(f.value, { stop: true })).status, 'exited')
    await f.exit
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).status, 'stopped')
    await forgetSdkExit(f.value)
    assert.equal((await inspectSdkExit(f.value)).status, 'unknown')
  })
  test('closed controller pipes still produce a durable settled stop receipt', { timeout: 10000 }, async t => {
    const f = await worker(t)
    f.child.stdout.destroy(); f.child.stdin.end()
    await f.exit
    assert.equal((await inspectSdkExit(f.value)).status, 'exited')
  })
  test('a killed worker without settled stop acknowledgement remains unknown', { timeout: 10000 }, async t => {
    const f = await worker(t)
    f.child.kill('SIGKILL'); await f.exit
    assert.equal((await inspectSdkExit(f.value)).status, 'unknown')
  })
  test('a process that cannot acknowledge settled shutdown retains unknown exit after the stop budget', { timeout: 10000 }, async t => {
    const f = await fixture(t)
    const module = new URL('../src/host/project-sdk-exit.mjs', import.meta.url).href
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {registerSdkExit} from ${JSON.stringify(module)};process.on('SIGTERM',()=>{});await registerSdkExit(${JSON.stringify(f.value)});console.log('ready');setInterval(()=>{},1000)`], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] })
    const exit = once(child, 'close'), lines = createInterface({ input: child.stdout }); child.stderr.resume()
    t.after(async () => { child.kill('SIGKILL'); await exit; lines.close() })
    await once(lines, 'line')
    assert.equal((await inspectSdkExit(f.value, { stop: true })).status, 'unknown')
    assert.equal(child.exitCode, null)
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).status, 'running')
  })
  test('a mismatched birth cannot signal a reused PID or release another generation', { timeout: 15000 }, async t => {
    const f = await worker(t), original = await readFile(f.path, 'utf8'), row = JSON.parse(original)
    row.scope.startTicks = String(Number(row.scope.startTicks) + 1)
    await writeFile(f.path, JSON.stringify(row))
    assert.equal((await inspectSdkExit(f.value, { stop: true })).status, 'unknown')
    assert.equal(f.child.exitCode, null)
    await writeFile(f.path, original)
    assert.equal((await inspectSdkExit(f.value, { stop: true })).status, 'exited')
    await f.exit
  })
}
