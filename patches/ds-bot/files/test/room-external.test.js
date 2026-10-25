import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanExternal, createExternalRoomParticipant } from '../src/host/room-participant-external.js'

// The child protocol: one JSON object per line, `{ text }` answers the turn it was given.
const ANSWER = (reply) => `let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);const m=JSON.parse(l);if(m.type==='turn')process.stdout.write(JSON.stringify({text:${JSON.stringify(reply)} + m.text})+'\\n')}})`
const DIE = 'process.exit(3)'

function fixture(t) {
  const lines = []
  const rt = {
    live: new Map(), groupOwners: new Map(), roomWaiters: new Map(),
    workDirOf: () => undefined,
    warn: () => {},
    externalRoomLine: async (room, line) => { lines.push({ roomId: room.id, ...line }); return line },
  }
  const driver = createExternalRoomParticipant(rt)
  const room = { id: 'ops', name: 'Ops', seq: 0 }
  const controller = new AbortController()
  t.after(() => { controller.abort(); driver.close() })
  const run = (member, text = 'hello') => driver.runTurn({
    room, member, sessionId: `external:ops:${member.id}`, text, note: 'your turn',
    signal: controller.signal, started: [], by: 'chief', exchangeId: `x-${member.id}`,
  })
  return { driver, rt, room, lines, run }
}

test('an external Bot whose process dies answers with a failure and lands in the room, not in silence (#198)', async (t) => {
  const { driver, lines, run } = fixture(t)
  const member = { id: 'ext', name: 'Runner', external: { driver: 'subprocess', command: [process.execPath, '-e', DIE] } }
  const reply = await run(member)
  assert.equal(reply?.failure?.reason, 'crashed')
  const entry = await new Promise((resolve) => {
    const started = Date.now()
    const tick = () => (lines.length > 0 || Date.now() - started > 4000 ? resolve(lines[0]) : setTimeout(tick, 10))
    tick()
  })
  assert.ok(entry, 'the room carries the state of a participant that died')
  assert.equal(entry.roomId, 'ops')
  assert.equal(entry.botId, 'ext')
  assert.match(entry.text, /crashed/)
  assert.match(entry.text, /exit 3/)
  assert.equal(driver.snapshot('external:ops:ext').state, 'crashed')
})

test('an external Bot answers a room turn with the line its process writes (#198)', async (t) => {
  const { driver, run } = fixture(t)
  const member = { id: 'echo', name: 'Echo', external: { driver: 'subprocess', command: [process.execPath, '-e', ANSWER('echo: ')] } }
  assert.equal(await run(member, 'hello'), 'echo: hello')
  assert.equal(await driver.snapshot('external:ops:echo').state, 'idle')
  await driver.cancel({ sessionId: 'external:ops:echo' })
})

test('a crashed external Bot starts a fresh process on its next turn (#198)', async (t) => {
  const { lines, run } = fixture(t)
  const member = { id: 'gone', name: 'Gone', external: { driver: 'subprocess', command: [process.execPath, '-e', DIE] } }
  assert.equal((await run(member))?.failure?.reason, 'crashed')
  await waitFor(() => lines.length >= 1)
  // A turn after the crash is not a dead end: the next one spawns again, and this one dies too.
  assert.equal((await run(member, 'again'))?.failure?.reason, 'crashed')
  await waitFor(() => lines.length >= 2)
  assert.equal(lines.filter(line => line.botId === 'gone').length, 2)
})

test('a seat that is closed takes its process with it (#198)', async (t) => {
  const { driver, run } = fixture(t)
  const member = { id: 'seat', name: 'Seat', external: { driver: 'subprocess', command: [process.execPath, '-e', ANSWER('ok: ')] } }
  assert.equal(await run(member, 'one'), 'ok: one')
  assert.equal(driver.closeParticipant('ops', 'seat'), true)
  assert.equal(driver.snapshot('external:ops:seat').working, false)
  // The seat is gone, so the next turn opens a new process rather than reusing a closed one.
  assert.equal(await run(member, 'two'), 'ok: two')
  assert.equal(driver.closeParticipant('ops', 'not-there'), false)
})

test('a stop is asked for on the protocol before the signal, and a shell is not a program (#198)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-external-'))
  const seen = join(dir, 'seen.txt')
  writeFileSync(seen, '')
  const script = `const fs=require('node:fs');let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);fs.appendFileSync(process.env.SEEN,l+'\\n')}})`
  const { driver, run } = fixture(t)
  const member = {
    id: 'stop', name: 'Stop',
    external: { driver: 'subprocess', command: [process.execPath, '-e', script], env: { SEEN: seen } },
  }
  const turn = run(member, 'work')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(await driver.cancel({ sessionId: 'external:ops:stop' }), true)
  assert.equal(await turn, null)
  await waitFor(() => readFileSync(seen, 'utf8').includes('"type":"stop"'))
  const lines = readFileSync(seen, 'utf8').split('\n').filter(Boolean)
  assert.match(lines[0], /"type":"turn"/)
  assert.match(lines[1], /"type":"stop"/)
})

test('a stop the child obeys is not reported to the room as a crash (#198)', async (t) => {
  // The child honours the protocol message: on { type: 'stop' } it leaves on its own, exit 0.
  const POLITE = `let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);if(JSON.parse(l).type==='stop')process.exit(0)}})`
  const { driver, lines, run } = fixture(t)
  const member = { id: 'polite', name: 'Polite', external: { driver: 'subprocess', command: [process.execPath, '-e', POLITE] } }
  const turn = run(member, 'work')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(driver.closeParticipant('ops', 'polite'), true)
  assert.equal(await turn, null)
  // Give the exit handler time to run: a clean stop posts nothing, least of all a crash notice.
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.deepEqual(lines.filter(line => line.botId === 'polite'), [])
})

test('a turn that times out comes back as no answer, not as a model failure (#198)', async (t) => {
  const SILENT = 'process.stdin.resume()'
  const { driver, rt, lines, run } = fixture(t)
  rt.roomReplyTimeoutMs = 200
  const member = { id: 'slow', name: 'Slow', external: { driver: 'subprocess', command: [process.execPath, '-e', SILENT] } }
  const reply = await run(member, 'work')
  // The DSH driver answers a room-turn timeout with { missed: true }; a round reads that as
  // silence, so { failure } here would count a slow process as a failed model call.
  assert.deepEqual(reply, { missed: true })
  assert.equal(driver.snapshot('external:ops:slow').state, 'timeout')
  const entry = await new Promise((resolve) => {
    const started = Date.now()
    const tick = () => (lines.length > 0 || Date.now() - started > 4000 ? resolve(lines[0]) : setTimeout(tick, 10))
    tick()
  })
  assert.match(entry.text, /timeout/)
  assert.equal(entry.botId, 'slow')
})

test('a child that ignores the stop is killed after the grace (#1164)', async (t) => {
  // SIGTERM is handled and deliberately ignored: only an escalation can take this child.
  const STUBBORN = "const fs=require('node:fs');fs.appendFileSync(process.env.SEEN,'start '+process.pid+'\\n');process.on('SIGTERM',()=>{});process.stdin.resume()"
  const dir = mkdtempSync(join(tmpdir(), 'flybot-external-'))
  const seen = join(dir, 'pids.txt')
  writeFileSync(seen, '')
  const { driver, run } = fixture(t)
  const member = { id: 'stubborn', name: 'Stubborn', external: { driver: 'subprocess', command: [process.execPath, '-e', STUBBORN], env: { SEEN: seen } } }
  const turn = run(member, 'work')
  await waitFor(() => /start \d+/.test(readFileSync(seen, 'utf8')))
  const pid = Number(readFileSync(seen, 'utf8').match(/start (\d+)/)[1])
  assert.equal(driver.closeParticipant('ops', 'stubborn'), true)
  assert.equal(await turn, null)
  await waitFor(() => { try { process.kill(pid, 0); return false } catch { return true } }, 4000)
})

test('a seat that was closed is never handed the next turn (#1164)', async (t) => {
  // The child records each turn with its own pid and never answers. A stopped turn leaves the
  // entry in place while the child may still be running: that is the reuse path — the next turn
  // must reach a fresh process, not the one the user just stopped.
  const PID_LOG = "const fs=require('node:fs');fs.appendFileSync(process.env.SEEN,'start '+process.pid+'\\n');process.on('SIGTERM',()=>{});let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);if(JSON.parse(l).type==='turn')fs.appendFileSync(process.env.SEEN,'turn '+process.pid+'\\n')}})"
  const dir = mkdtempSync(join(tmpdir(), 'flybot-external-'))
  const seen = join(dir, 'pids.txt')
  writeFileSync(seen, '')
  const { driver, run } = fixture(t)
  const member = { id: 'seat2', name: 'Seat2', external: { driver: 'subprocess', command: [process.execPath, '-e', PID_LOG], env: { SEEN: seen } } }
  const turns = () => readFileSync(seen, 'utf8').split('\n').filter(row => row.startsWith('turn ')).map(row => row.slice(5))
  const stopped = run(member, 'one')
  await waitFor(() => turns().length === 1)
  const first = turns()[0]
  assert.equal(await driver.cancel({ sessionId: 'external:ops:seat2' }), true)
  assert.equal(await stopped, null)
  const next = run(member, 'two')
  await waitFor(() => turns().length === 2)
  const second = turns()[1]
  assert.notEqual(second, first, 'the closed process must not answer the next turn')
  await driver.cancel({ sessionId: 'external:ops:seat2' })
  assert.equal(await next, null)
})
test('the timeout state line says timed out (#1164)', async (t) => {
  const { rt, lines, run } = fixture(t)
  rt.roomReplyTimeoutMs = 200
  const member = { id: 'late', name: 'Late', external: { driver: 'subprocess', command: [process.execPath, '-e', 'process.stdin.resume()'] } }
  assert.deepEqual(await run(member, 'work'), { missed: true })
  const entry = await waitForLine(lines, 'late')
  assert.match(entry.text, /external process timed out/)
  assert.doesNotMatch(entry.text, /process timeout/)
})

test('a crash line carries the last words from stderr (#1164)', async (t) => {
  const BOOM = "process.stderr.write('boom: missing config\\n',()=>process.exit(3))"
  const { lines, run } = fixture(t)
  const member = { id: 'boom', name: 'Boom', external: { driver: 'subprocess', command: [process.execPath, '-e', BOOM] } }
  assert.equal((await run(member))?.failure?.reason, 'crashed')
  const entry = await waitForLine(lines, 'boom')
  assert.match(entry.text, /crashed \(exit 3: boom: missing config\)/)
  // The tail is capped: 400 characters of stderr keep only the last 200.
  const NOISE = "process.stderr.write('x'.repeat(400),()=>process.exit(3))"
  const noisy = { id: 'noise', name: 'Noise', external: { driver: 'subprocess', command: [process.execPath, '-e', NOISE] } }
  assert.equal((await run(noisy))?.failure?.reason, 'crashed')
  const noise = await waitForLine(lines, 'noise')
  assert.match(noise.text, /x{200}/)
  assert.doesNotMatch(noise.text, /x{201}/)
})
test('a crash is reported when a grandchild holds the stdio open (#1164)', async (t) => {
  // On the first launch the child leaves a grandchild on its inherited stdio and exits 1, so
  // 'close' is postponed for as long as the grandchild lives (measured here: exit at ~40 ms,
  // close at ~1280 ms). The crash line must not wait for 'close', and the seat must be free at
  // once. The marker makes the second launch a normal responder.
  const HELD = "const fs=require('node:fs');const cp=require('node:child_process');if(!fs.existsSync(process.env.MARK)){fs.writeFileSync(process.env.MARK,'1');fs.writeSync(2,'boom: helper holds the pipe\\n');cp.spawn(process.execPath,['-e','setTimeout(()=>{},1200)'],{stdio:'inherit'});process.exit(1)}let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);const m=JSON.parse(l);if(m.type==='turn')process.stdout.write(JSON.stringify({text:'again: '+m.text})+'\\n')}})"
  const dir = mkdtempSync(join(tmpdir(), 'flybot-external-'))
  const mark = join(dir, 'mark')
  const { lines, run } = fixture(t)
  const member = { id: 'held', name: 'Held', external: { driver: 'subprocess', command: [process.execPath, '-e', HELD], env: { MARK: mark } } }
  const started = Date.now()
  const first = run(member)
  // 900 ms is before the grandchild's 1.2 s: only reporting from 'exit' can meet this.
  const entry = await waitForLine(lines, 'held', 900)
  const elapsed = Date.now() - started
  assert.match(entry.text, /crashed \(exit 1: boom: helper holds the pipe\)/)
  assert.ok(elapsed < 900, `the crash line waited for close (${elapsed} ms)`)
  assert.equal((await first)?.failure?.reason, 'crashed')
  // The seat was cleared on 'exit', so the next turn reaches a fresh process, not a dead pipe.
  assert.equal(await run(member, 'ok'), 'again: ok')
})
test('a record may not carry a command line, only arguments (#198)', () => {
  assert.throws(() => cleanExternal({ command: 'node agent.js' }), /array of arguments/)
  assert.throws(() => cleanExternal({ command: [] }), /1 to 32/)
  assert.throws(() => cleanExternal({ driver: 'shell', command: ['sh', '-c', 'id'] }), /driver must be one of subprocess/)
  assert.throws(() => cleanExternal({ command: ['sh', '-c', 'id'] }), /may not start with an interpreter/)
  assert.throws(() => cleanExternal({ command: ['/bin/bash', '-lc', 'id'] }), /may not start with an interpreter/)
  assert.throws(() => cleanExternal({ command: ['pwsh', '-c', 'id'] }), /may not start with an interpreter/)
  assert.deepEqual(cleanExternal({ command: ['node', 'agent.js'], cwd: '/tmp', env: { HOME: '/tmp' } }),
    { driver: 'subprocess', command: ['node', 'agent.js'], cwd: '/tmp', env: { HOME: '/tmp' } })
})

const waitForLine = async (lines, botId, ms = 4000) => {
  await waitFor(() => lines.some(line => line.botId === botId), ms)
  return lines.find(line => line.botId === botId)
}
const waitFor = async (done, ms = 4000) => {
  const started = Date.now()
  while (!done()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for the child')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
