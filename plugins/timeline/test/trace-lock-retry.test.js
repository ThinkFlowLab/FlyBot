// #2706: a window that opens while another process writes the trace starts in memory.
// The lock is asked for again when there is something to write, so the window begins
// persisting as soon as the other writer leaves; until then a flush that cannot write
// answers `false` and names the reason once instead of reporting success for a lost span.
//
// Real modules and real child processes, one temporary trace directory per test.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const TIMELINE = new URL('../src/timeline.js', import.meta.url).href
const NOW = 1_700_000_000_000
const J = JSON.stringify

const home = () => mkdtempSync(join(tmpdir(), 'flybot-timeline-lock-'))
const traceText = dir => readdirSync(dir)
  .filter(name => /^trace-\d+\.json$/.test(name))
  .map(name => readFileSync(join(dir, name), 'utf8'))
  .join('')
const warns = text => text.split('\n').filter(line => /not writable/i.test(line)).length
const payload = line => JSON.parse(line.slice(line.indexOf(' ') + 1))

const ADAPTER = `const adapter = {
  warn: (...args) => process.stderr.write('warn: ' + args.map(String).join(' ') + '\\n'),
  subscribe: () => () => {}, bots: () => [], rooms: () => [], handle: () => () => {}, readOnly: () => false,
}`

const live = []
// A real node child running the module graph under test; argv[1] is its trace directory.
// `waitFor` answers each marker once, from the output produced after the previous answer.
function start(code, dir) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: ['pipe', 'pipe', 'pipe'] })
  live.push(proc)
  let out = ''
  let err = ''
  let cursor = 0
  const waiters = []
  const take = (waiter) => {
    const match = out.slice(cursor).match(waiter.re)
    if (!match) return false
    cursor += match.index + match[0].length
    waiter.resolve(match[0])
    return true
  }
  const sweep = () => {
    for (const waiter of waiters.slice()) {
      if (!take(waiter)) continue
      clearTimeout(waiter.timer)
      waiters.splice(waiters.indexOf(waiter), 1)
    }
  }
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (chunk) => { out += chunk; sweep() })
  proc.stderr.on('data', (chunk) => { err += chunk })
  const exited = new Promise(resolve => proc.on('exit', (exitCode, signal) => resolve({ exitCode, signal })))
  return {
    proc,
    get output() { return out },
    get errors() { return err },
    exited,
    waitFor(re, timeoutMs = 15_000) {
      const found = out.slice(cursor).match(re)
      if (found) { cursor += found.index + found[0].length; return Promise.resolve(found[0]) }
      return new Promise((resolve, reject) => {
        const waiter = { re, resolve, timer: undefined }
        waiter.timer = setTimeout(() => reject(new Error(`timeout waiting for ${re}\nstdout: ${out}\nstderr: ${err}`)), timeoutMs)
        waiters.push(waiter)
      })
    },
    send(line) { proc.stdin.write(`${line}\n`) },
  }
}

const writerCode = `
  import { createTimeline } from ${J(TIMELINE)}
  ${ADAPTER}
  const tl = createTimeline(adapter, { dir: process.argv[1], now: () => ${NOW}, flushMs: 60_000 })
  tl.trace.append({ t: ${NOW}, k: 'ts', id: 'first-writer' })
  process.stdout.write('@@flushed ' + JSON.stringify({ ok: tl.trace.flush(), stats: tl.trace.stats() }) + '\\n')
  process.stdin.once('data', () => { tl.dispose(); process.exit(0) })
`

// The window behind the writer appends on demand and reports what flush() answered.
const behindCode = `
  import { createTimeline } from ${J(TIMELINE)}
  ${ADAPTER}
  const tl = createTimeline(adapter, { dir: process.argv[1], now: () => ${NOW}, flushMs: 60_000 })
  process.stdout.write('@@open ' + JSON.stringify(tl.trace.stats()) + '\\n')
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    for (const line of chunk.split('\\n')) {
      if (line.startsWith('append:')) {
        tl.trace.append({ t: ${NOW}, k: 'ts', id: line.slice(7) })
        const ok = tl.trace.flush()
        process.stdout.write('@@tried ' + JSON.stringify({ ok, stats: tl.trace.stats() }) + '\\n')
      }
      if (line === 'exit') { tl.dispose(); process.exit(0) }
    }
  })
`

test('a window that started behind another writer persists once that writer leaves', { timeout: 30_000 }, async (t) => {
  const dir = home()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const first = start(writerCode, dir)
  await first.waitFor(/@@flushed/)
  assert.ok(traceText(dir).includes('first-writer'), 'the first writer is on disk')

  const behind = start(behindCode, dir)
  const opened = payload(await behind.waitFor(/@@open (.*)/))
  assert.equal(opened.persist, false, 'the second window starts without the lock')

  first.send('exit')
  await first.exited

  behind.send('append:after-the-writer-left')
  const tried = payload(await behind.waitFor(/@@tried (.*)/))
  assert.equal(tried.ok, true, 'flush succeeds once the lock is free')
  assert.equal(tried.stats.persist, true, 'the window is persisting now')
  assert.ok(traceText(dir).includes('after-the-writer-left'), 'the span written after the lock was taken reaches the disk')
  assert.ok(traceText(dir).includes('first-writer'), 'the segments already on disk are kept, not overwritten')

  behind.send('exit')
  await behind.exited
})

test('a flush that still cannot take the lock answers false and names it once', { timeout: 30_000 }, async (t) => {
  const dir = home()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const first = start(writerCode, dir)
  await first.waitFor(/@@flushed/)
  const behind = start(behindCode, dir)
  await behind.waitFor(/@@open/)

  behind.send('append:blocked-one')
  const blocked = payload(await behind.waitFor(/@@tried (.*)/))
  assert.equal(blocked.ok, false, 'a span that was not written is not a successful flush')
  assert.equal(blocked.stats.persist, false)
  assert.ok(blocked.stats.records >= 1, 'the record is kept in memory')
  assert.equal(warns(behind.errors), 1, 'the reason is said once')

  behind.send('append:blocked-two')
  const second = payload(await behind.waitFor(/@@tried (.*)/))
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(second.ok, false)
  assert.equal(warns(behind.errors), 1, 'it is not repeated on the next failed flush')

  first.send('exit')
  await first.exited
  // Once the writer is gone the same window takes the lock and the held spans land on disk.
  behind.send('append:after-the-writer-left')
  const recovered = payload(await behind.waitFor(/@@tried (.*)/))
  assert.equal(recovered.ok, true, `stderr: ${behind.errors}`)
  assert.equal(recovered.stats.persist, true)
  const text = traceText(dir)
  for (const id of ['blocked-one', 'blocked-two', 'after-the-writer-left']) assert.ok(text.includes(id), `${id} reaches the disk`)

  behind.send('exit')
  await behind.exited
})

test('a window opened after the writer leaves takes the lock at once', { timeout: 30_000 }, async (t) => {
  const dir = home()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const first = start(writerCode, dir)
  await first.waitFor(/@@flushed/)
  first.send('exit')
  await first.exited

  const fresh = start(writerCode, dir)
  const flushed = payload(await fresh.waitFor(/@@flushed (.*)/))
  assert.equal(flushed.stats.persist, true)
  assert.ok(traceText(dir).includes('first-writer'))
  fresh.send('exit')
  await fresh.exited
})

test.after(() => {
  for (const proc of live) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
})
