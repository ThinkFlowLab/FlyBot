// Opt-in actual SDK/CLI abort and worker exit; provider is a held local fixture.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectSdkExit, SDK_EXIT_VERSION } from '../src/host/project-sdk-exit.mjs'
if (process.env.FLYBOT_TEST_EXIT_SDK === '1') test('actual Codex SDK settles after controller pipe loss and leaves verifiable resource exit', { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'flybot-sdk-exit-actual-')), cwd = join(root, 'work'), home = join(root, 'home')
  await mkdir(cwd); await mkdir(home)
  execFileSync('git', ['init', '-q', cwd])
  let reached
  const called = new Promise(resolve => { reached = resolve })
  const server = createServer((request, response) => { request.resume(); reached(); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': hold until SDK abort\n\n') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const identity = { version: SDK_EXIT_VERSION, root, workerId: 'actual-sdk-worker', leaseId: 'actual-sdk-lease', generation: 1 }
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '../src/host/project-harness-worker.mjs'), JSON.stringify(identity)], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] })
  const exit = once(child, 'close'), lines = createInterface({ input: child.stdout })
  child.stderr.resume(); child.stdin.on('error', () => {})
  try {
    const [first] = await once(lines, 'line'), ready = JSON.parse(first)
    assert.equal(ready.sdk.codex, '0.166.0')
    child.stdin.write(JSON.stringify({ type: 'start', settings: { harness: 'codex', cwd, model: 'fixture-model', noTools: true, env: { HOME: home, CODEX_HOME: home, PATH: process.env.PATH }, config: { model_provider: 'fixture', model_providers: { fixture: { name: 'fixture', base_url: `http://127.0.0.1:${server.address().port}`, wire_api: 'responses', requires_openai_auth: false } } } }, prompt: 'Wait for this isolated fixture response' }) + '\n')
    await Promise.race([called, new Promise((_, reject) => setTimeout(() => reject(Error('Actual SDK did not reach fixture provider')), 20000).unref())])
    const cliPids = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
    assert.ok(cliPids.length, 'Actual SDK spawned its CLI')
    assert.equal((await inspectSdkExit(identity)).status, 'unknown')
    child.stdout.destroy(); child.stdin.end()
    const [code] = await exit
    assert.equal(code, 0)
    assert.equal((await inspectSdkExit(identity)).status, 'exited', 'SDK abort must settle before the actual worker acknowledges stop')
    for (const pid of cliPids) {
      try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); assert.ok(['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]), 'SDK CLI must also have exited') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exit; lines.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true })
  }
})
