// `inflight.json` is the one record of the turns a crash cut off, so the write that keeps it must
// never leave the file empty or half written: the writer stages a temp name beside it and renames
// it over, so a crash at any point leaves either the previous complete notes or the new complete
// notes (#2705). These cases run real child processes and a real `kill -9` in a temp home, so the
// window is the one the shipped code has, and a file nothing can parse is still reported instead of
// passing for "nothing was in flight".
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const RESUME = fileURLToPath(new URL('../src/host/resume.js', import.meta.url))
// The core modules resolve `@deepseek-ai/*` through this hook; the child processes need it too.
const HARNESS = fileURLToPath(new URL('./harness-resolve.mjs', import.meta.url))

const NOTE = {
  turns: { 'sess-cut-off': { botId: 'bot-1', since: 1, turn: 3, trigger: { role: 'request', exchangeId: 'ex-1', senderSessionId: 'sess-peer' } } },
  queued: { 'sess-peer': [{ at: 2, args: { toId: 'bot-1', sessionId: 'sess-cut-off', exchangeId: 'ex-2', text: 'answer me' } }] },
}
const NOTE_TEXT = JSON.stringify(NOTE, null, 2)

const children = []
const start = (code, args = []) => {
  const child = spawn(process.execPath, ['--import', HARNESS, '--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let output = ''
  let errors = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = new Promise(resolve => child.on('exit', (code_, signal) => resolve({ code: code_, signal })))
  return { child, exited, get output() { return output }, get errors() { return errors } }
}
// Waits for the child's last printed line, which carries its answer as JSON.
const answer = async (run, tag, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs
  while (!new RegExp(`^@@${tag} `, 'm').test(run.output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  const matched = run.output.match(new RegExp(`^@@${tag} (.*)$`, 'm'))
  assert.ok(matched, `the child never answered ${tag}\nstdout: ${run.output}\nstderr: ${run.errors}`)
  return JSON.parse(matched[1])
}
// A real install of the module under test: the pickup timer is captured, not run, so the case can
// read what the next start would schedule without the pickup itself racing the assertions.
const STUB = `
const home = process.argv[1]
const timers = []
const warns = []
globalThis.setTimeout = (fn, ms) => { timers.push(ms); return { unref() {} } }
const effects = []
const ctx = { on() {}, effect(fn) { effects.push(fn) }, sessionController: undefined }
const rt = {
  ctx, home, load: async () => {}, readOnly: () => undefined, deliver: async () => {},
  chatOf: id => id, botOf: () => undefined, isBotSession: () => false,
  warn: (...args) => warns.push(args.map(value => String(value)).join(' ')),
}
`
const READER = `
import { install as installResume } from ${JSON.stringify(RESUME)}
${STUB}
installResume(rt)
for (const fn of effects) fn()
process.stdout.write('@@read ' + JSON.stringify({ timers, warns }) + '\\n')
`
const readNextStart = async (home) => {
  const run = start(READER, [home])
  const seen = await answer(run, 'read')
  await run.exited
  return seen
}
// A real writer: it notes one delivery and then sits there, so the parent can kill it inside the
// window a real crash would land in.
const WRITER = `
import { install as installResume } from ${JSON.stringify(RESUME)}
${STUB}
installResume(rt)
for (const fn of effects) fn()
process.stdout.write('@@ready ' + JSON.stringify({}) + '\\n')
// A real handle: the stubbed timer above would otherwise let the loop empty and the child exit
// before the write it is here for.
setInterval(() => {}, 1000)
await rt.deliver({ toId: 'bot-1', text: 'x'.repeat(40 * 1024 * 1024) })
await new Promise(() => {})
`
const tempNames = home => readdirSync(home).filter(name => name.startsWith('inflight.json.') && name.endsWith('.tmp'))
// The window a crash has to land in: the write is under way, so the in-place writer has already
// shortened the target and the atomic one has a temp name growing beside it.
const cutWindow = (home, previous) => {
  for (const name of tempNames(home)) {
    const size = statSync(join(home, name)).size
    if (size > 0) return { temp: name, size }
  }
  const target = join(home, 'inflight.json')
  if (!existsSync(target)) return { target: 'missing' }
  const size = statSync(target).size
  return size < previous ? { target: size } : undefined
}
const scratch = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-resume-atomic-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  return home
}

test('a write cut off by kill -9 keeps the complete notes on disk, and the next start picks them up', { timeout: 60_000 }, async (t) => {
  const home = scratch(t)
  writeFileSync(join(home, 'inflight.json'), NOTE_TEXT, { mode: 0o600 })

  const run = start(WRITER, [home])
  await answer(run, 'ready')
  let window
  const deadline = Date.now() + 30_000
  while (window === undefined && Date.now() < deadline) {
    window = cutWindow(home, NOTE_TEXT.length)
    if (window === undefined) await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.ok(window, 'the writer never showed a write in flight')
  run.child.kill('SIGKILL')
  const { signal } = await run.exited
  assert.equal(signal, 'SIGKILL')
  t.diagnostic(`cut the write inside the window: ${JSON.stringify(window)}`)

  // Whatever the crash landed on, the target itself is a complete record: a torn write in a temp
  // name that was never renamed over it cannot shorten it.
  const bytes = readFileSync(join(home, 'inflight.json'), 'utf8')
  assert.equal(bytes.length, NOTE_TEXT.length, 'the killed write left the previous notes, not a half-written snapshot')
  let onDisk
  assert.doesNotThrow(() => { onDisk = JSON.parse(bytes) }, 'the killed write left a complete inflight.json behind')
  assert.deepEqual(onDisk, NOTE, 'the notes on disk are the last complete ones')
  const next = await readNextStart(home)
  assert.deepEqual(next.timers, [3000], 'the next start schedules the pickup of the cut-off turn')
  assert.deepEqual(next.warns, [], 'a complete file says nothing')
})

test('a file nothing can parse is reported once instead of passing for "nothing was in flight"', { timeout: 30_000 }, async (t) => {
  const home = scratch(t)
  const file = join(home, 'inflight.json')

  writeFileSync(file, '', { mode: 0o600 })
  const empty = await readNextStart(home)
  assert.deepEqual(empty.timers, [], 'nothing is picked up from a file with no notes in it')
  assert.equal(empty.warns.length, 1, 'the empty file is named once')
  assert.match(empty.warns[0], /inflight\.json/)
  assert.match(empty.warns[0], /not picked up|nothing is picked up|could not be read/i)

  writeFileSync(file, NOTE_TEXT.slice(0, Math.floor(NOTE_TEXT.length / 2)), { mode: 0o600 })
  const half = await readNextStart(home)
  assert.deepEqual(half.timers, [])
  assert.equal(half.warns.length, 1, 'the half-written file is named once')

  // A file that parses but is not the notes shape cannot be resumed either, and says so.
  writeFileSync(file, '[]', { mode: 0o600 })
  const wrong = await readNextStart(home)
  assert.deepEqual(wrong.timers, [])
  assert.equal(wrong.warns.length, 1)

  // A missing file is the ordinary case: no pickup, and nothing to report.
  rmSync(file)
  const absent = await readNextStart(home)
  assert.deepEqual(absent, { timers: [], warns: [] })
})

test('a temp name a crash left behind is not read as state, and the next write clears it', { timeout: 30_000 }, async (t) => {
  const home = scratch(t)
  const stale = join(home, 'inflight.json.999999.deadbeef.tmp')
  writeFileSync(stale, '{"turns":{},"queued":{}}', { mode: 0o600 })

  const run = start(`
    import { existsSync, readFileSync } from 'node:fs'
    import { install as installResume } from ${JSON.stringify(RESUME)}
    const home = process.argv[1]
    const effects = []
    const ctx = { on() {}, effect(fn) { effects.push(fn) }, sessionController: undefined }
    const rt = {
      ctx, home, load: async () => {}, readOnly: () => undefined, deliver: async () => {},
      chatOf: id => id, botOf: () => undefined, isBotSession: () => false,
      warn: message => process.stderr.write('warn: ' + String(message) + '\\n'),
    }
    installResume(rt)
    for (const fn of effects) fn()
    await rt.deliver({ toId: 'bot-1', text: 'after the crash' })
    const notes = home + '/inflight.json'
    for (let i = 0; i < 2000; i += 1) {
      await new Promise(resolve => setImmediate(resolve))
      try { if (JSON.parse(readFileSync(notes, 'utf8')).queued !== undefined) break } catch {}
    }
    process.stdout.write('@@wrote ' + JSON.stringify({ exists: existsSync(notes) }) + '\\n')
  `, [home])
  const wrote = await answer(run, 'wrote')
  await run.exited
  assert.equal(wrote.exists, true)
  assert.equal(existsSync(stale), false, 'the crashed write\'s temp name is not left in the home')
  assert.match(readFileSync(join(home, 'inflight.json'), 'utf8'), /after the crash/)
})

test.after(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})
