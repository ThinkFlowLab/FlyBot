// #2704: a second window on one home starts read-only because the first one holds
// `state.lock`. When that window dies the second takes the lock, and until now it kept
// the copy of `workflows.json` it loaded at construction and never ran its reaper again:
// its first write put the stale copy back over what the dead window had saved, and the
// dead window's `running` run held the lane for good.
//
// Becoming the writer is a state change: the first call that finds the host writable
// re-reads the store once (the way core's store.mutate() refreshes before a change) and
// reaps the runs the dead window left. These tests drive that with real child processes,
// a real `state.lock` and a real `kill -9`; neither the lock nor the store is mocked.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const SERVICE = `${REPO}plugins/workflow/src/service.js`
const LOCK = `${REPO}core/src/host/home-lock.js`
const J = JSON.stringify
const NOW = 1_700_000_000_000
const DELIVERY = 'delivery'

const live = []

// A real node child: the script is the module graph under test, argv carries its home.
function start(code, args = []) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
  live.push(proc)
  let out = ''
  let err = ''
  const waiters = []
  const sweep = () => {
    for (let index = 0; index < waiters.length;) {
      const waiter = waiters[index]
      if (!waiter.re.test(out)) { index += 1; continue }
      waiters.splice(index, 1)
      waiter.resolve(out)
    }
  }
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', chunk => { out += chunk; sweep() })
  proc.stderr.on('data', chunk => { err += chunk })
  const exited = new Promise(resolve => proc.on('exit', (code, signal) => resolve({ code, signal })))
  return {
    proc,
    get output() { return out },
    get errors() { return err },
    exited,
    waitFor(re, timeoutMs = 15_000) {
      if (re.test(out)) return Promise.resolve(out)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${re}\nstdout: ${out}\nstderr: ${err}`)), timeoutMs)
        waiters.push({ re, resolve: value => { clearTimeout(timer); resolve(value) } })
      })
    },
    send() { proc.stdin.write('go\n') },
  }
}

const readStore = (dir) => JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8'))
const laneOf = (dir, workflowId = DELIVERY) => readStore(dir).lanes?.[workflowId] ?? {}
const taskIds = (dir) => (laneOf(dir).active ?? []).map(run => run.task?.id)

test.after(() => {
  for (const proc of live) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
})

const lockPrelude = `
  import { join } from 'node:path'
  import { homeLock } from ${J(LOCK)}
  import { createWorkflowService } from ${J(SERVICE)}
`
const readOnlyByLock = 'readOnly: () => (lock.owns() ? undefined : \'read-only\'),'

// ---------------------------------------------------------------------------
// F1. The second window loads while the first holds state.lock, so it holds an older
// copy of the store. The first window records another task and is killed with -9; the
// second takes the lock and writes. Its first write has to land on the file the dead
// window left, not on the copy it loaded before that record existed.
test('F1 a window that takes over re-reads the store before its first write (#2704)', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-takeover-f1-'))
  try {
    const writer = `${lockPrelude}
      const dir = process.argv[1]
      const lock = homeLock(join(dir, 'state.lock'))
      if (lock.claim() !== undefined) { console.error('lock not free'); process.exit(2) }
      const svc = createWorkflowService({ dir, persist: true, now: () => ${NOW}, bots: () => [], ${readOnlyByLock} })
      svc.setConcurrency({ workflowId: '${DELIVERY}', maxConcurrent: 2 })
      svc.assign({ workflowId: '${DELIVERY}', taskId: 'before', title: 'before' })
      process.stdout.write('@@ready\\n')
      process.stdin.once('data', () => {
        svc.assign({ workflowId: '${DELIVERY}', taskId: 'after', title: 'after' })
        process.stdout.write('@@after\\n')
      })
      setInterval(() => {}, 1000)
    `
    const second = `${lockPrelude}
      const dir = process.argv[1]
      const lock = homeLock(join(dir, 'state.lock'))
      lock.claim()
      const svc = createWorkflowService({ dir, persist: true, now: () => ${NOW}, bots: () => [], ${readOnlyByLock} })
      const current = () => svc.state().workflows.find(item => item.id === '${DELIVERY}')?.run?.task?.id ?? null
      process.stdout.write('@@loaded ' + JSON.stringify(current()) + '\\n')
      // A reader refuses every write and leaves the writer's file alone (#2673).
      const refused = svc.assign({ workflowId: '${DELIVERY}', taskId: 'stale-write', title: 'stale' })
      process.stdout.write('@@refused ' + JSON.stringify({ ok: refused.ok, code: refused.code }) + '\\n')
      process.stdin.once('data', () => {
        if (lock.claim() !== undefined) { console.error('takeover failed'); process.exit(3) }
        svc.setConcurrency({ workflowId: '${DELIVERY}', maxConcurrent: 1 })
        process.stdout.write('@@wrote\\n')
        process.exit(0)
      })
    `

    const first = start(writer, [dir])
    await first.waitFor(/@@ready/)
    const other = start(second, [dir])
    // It opens on the copy without the record the writer is about to add.
    assert.match(await other.waitFor(/@@loaded/), /@@loaded "before"/)
    assert.match(await other.waitFor(/@@refused/), /@@refused \{"ok":false,"code":"read-only"\}/)
    assert.deepEqual(taskIds(dir), ['before'], 'a read-only window wrote over the writer')

    first.send()
    await first.waitFor(/@@after/)
    assert.deepEqual([...taskIds(dir)].sort(), ['after', 'before'])
    first.proc.kill('SIGKILL')
    await first.exited

    other.send()
    await other.waitFor(/@@wrote/)
    await other.exited

    // The takeover reloaded before it wrote: the record the dead window saved is still
    // there. Without the reload this is ['before'] — the case #2704 reports.
    assert.deepEqual([...taskIds(dir)].sort(), ['after', 'before'], 'the takeover dropped the record the dead window wrote after this window loaded')
    const restarted = readStore(dir)
    const persisted = (restarted.lanes[DELIVERY].active ?? []).map(run => run.task?.id)
    assert.deepEqual([...persisted].sort(), ['after', 'before'], 'the restart does not read both records')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// F2. The reaper ran once at load, and a read-only host returns from it without touching
// the record (#2673). After the takeover it must run once more: the run the dead window
// left `running` is ended `host-ended`, its step Bots are released exactly once, and a
// card that was merely `queued` is not killed — it keeps its place and starts.
test('F2 a takeover reaps the run the dead window left running, and leaves queued cards (#2704)', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-takeover-f2-'))
  try {
    const writer = `${lockPrelude}
      const dir = process.argv[1]
      const lock = homeLock(join(dir, 'state.lock'))
      if (lock.claim() !== undefined) { console.error('lock not free'); process.exit(2) }
      const svc = createWorkflowService({
        dir, persist: true, now: () => ${NOW}, bots: () => [], dispatch: async () => ({ ok: true }),
        spawn: async (spec) => 'eph-' + spec.nodeId, release: async () => {}, ${readOnlyByLock}
      })
      const made = svc.define({
        name: 'Lane',
        nodes: [{ id: 'plan', name: 'Planner', prompt: 'Plan.' }, { id: 'code', name: 'Coder', prompt: 'Code.' }],
        edges: [{ from: 'plan', to: 'code' }],
      }).workflows.find(item => item.name === 'Lane')
      await svc.setConcurrency({ workflowId: made.id, maxConcurrent: 1 })
      await svc.runNamed({ workflow: 'Lane', brief: 'dead run', task: 'dead-running' })
      await svc.assign({ workflowId: made.id, taskId: 'dead-queued', title: 'dead queued' })
      const item = svc.state().workflows.find(row => row.id === made.id)
      process.stdout.write('@@started ' + JSON.stringify({
        id: made.id,
        task: item.run?.task?.id ?? null,
        status: item.run?.status ?? null,
        active: item.activeCount,
        queue: item.queueDepth,
      }) + '\\n')
      setInterval(() => {}, 1000)
    `
    const second = `${lockPrelude}
      const dir = process.argv[1]
      const workflowId = process.argv[2]
      const lock = homeLock(join(dir, 'state.lock'))
      lock.claim()                         // the other window is alive: this one is a reader
      const released = []
      const svc = createWorkflowService({
        dir, persist: true, now: () => ${NOW}, bots: () => [], dispatch: async () => ({ ok: true }),
        spawn: async (spec) => 'eph-second-' + spec.nodeId, release: async (id) => { released.push(id) }, ${readOnlyByLock}
      })
      const view = () => {
        const item = svc.state().workflows.find(row => row.id === workflowId)
        return {
          task: item.run?.task?.id ?? null,
          status: item.run?.status ?? null,
          active: item.activeCount,
          queue: item.queueDepth,
          queued: item.queue.map(card => card.id),
        }
      }
      await svc.reap()                     // what loading does: read-only, so nothing happens
      process.stdout.write('@@startup ' + JSON.stringify({ view: view(), released }) + '\\n')
      process.stdin.once('data', async () => {
        if (lock.claim() !== undefined) { console.error('takeover failed'); process.exit(3) }
        const assigned = svc.assign({ workflowId, taskId: 'new-card', title: 'new' })
        if (typeof assigned?.then === 'function') await assigned
        process.stdout.write('@@after ' + JSON.stringify({ view: view(), released: [...released].sort() }) + '\\n')
        process.exit(0)
      })
    `

    const first = start(writer, [dir])
    const started = JSON.parse((await first.waitFor(/@@started/)).match(/@@started (.*)/)[1])
    assert.equal(started.status, 'running')
    assert.equal(started.active, 1)
    assert.equal(started.queue, 1)

    const other = start(second, [dir, started.id])
    const startup = JSON.parse((await other.waitFor(/@@startup/)).match(/@@startup (.*)/)[1])
    // The reader opened on the dead window's run and does not reap it (#2673).
    assert.deepEqual(startup.view, { task: 'dead-running', status: 'running', active: 1, queue: 1, queued: ['dead-queued'] })
    assert.deepEqual(startup.released, [], "a read-only host released the writer's step Bots")
    first.proc.kill('SIGKILL')
    await first.exited

    other.send()
    const after = JSON.parse((await other.waitFor(/@@after/)).match(/@@after (.*)/)[1])
    await other.exited

    // The dead run is over and its Bots are released exactly once, so the lane moved:
    // the card that was already queued starts, and only the card this window added waits.
    assert.deepEqual(after.released, ['eph-code', 'eph-plan'], "the takeover did not release the dead run's step Bots once")
    assert.deepEqual(after.view, { task: 'dead-queued', status: 'running', active: 1, queue: 1, queued: ['new-card'] })

    const lane = laneOf(dir, started.id)
    assert.deepEqual((lane.active ?? []).map(run => run.task?.id), ['dead-queued'], 'the queued card was killed or the dead run still holds a slot')
    assert.deepEqual((lane.queue ?? []).map(card => card.id), ['new-card'])
    assert.equal(lane.last?.task?.id, 'dead-running')
    assert.equal(lane.last?.status, 'failed')
    assert.equal(lane.last?.failure?.code, 'host-ended')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

