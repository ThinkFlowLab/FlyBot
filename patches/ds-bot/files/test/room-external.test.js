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
  const warnings = []
  const rt = {
    live: new Map(), groupOwners: new Map(), roomWaiters: new Map(),
    workDirOf: () => undefined,
    warn: (...args) => warnings.push(args.join(' ')),
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
  return { driver, rt, room, lines, warnings, run }
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

test('a timed-out turn never settles the next one with its late answer (#2634)', async (t) => {
  // The child holds its answer to the first turn until the marker appears and handles turns one
  // at a time, so the stale line lands while the second turn is in flight (#2634).
  const HELD = `const fs=require('node:fs');
const queue=[];
let pumping=false;
function pump(){
  if(pumping||queue.length===0)return;
  if(queue[0].text==='one'&&!fs.existsSync(process.env.MARK)){setTimeout(pump,5);return}
  pumping=true;
  const m=queue.shift();
  process.stdout.write(JSON.stringify({text:'answer to '+m.text})+'\\n');
  setTimeout(()=>{pumping=false;pump()},0);
}
fs.appendFileSync(process.env.SEEN,'start '+process.pid+'\\n');
let b='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{
  b+=c;
  let i;
  while((i=b.indexOf('\\n'))!==-1){
    const l=b.slice(0,i);
    b=b.slice(i+1);
    const m=JSON.parse(l);
    if(m.type!=='turn')continue;
    fs.appendFileSync(process.env.SEEN,'turn '+process.pid+' '+m.text+'\\n');
    queue.push(m);
    pump();
  }
});`
  const dir = mkdtempSync(join(tmpdir(), 'flybot-external-'))
  const seen = join(dir, 'seen.txt')
  const mark = join(dir, 'mark')
  writeFileSync(seen, '')
  const { rt, run } = fixture(t)
  rt.roomReplyTimeoutMs = 300
  const member = { id: 'held2', name: 'Held2', external: { driver: 'subprocess', command: [process.execPath, '-e', HELD], env: { SEEN: seen, MARK: mark } } }
  const rows = () => readFileSync(seen, 'utf8').split('\n').filter(Boolean)
  const seenTurns = () => rows().filter(row => row.startsWith('turn '))
  const starts = () => rows().filter(row => row.startsWith('start '))
  const first = run(member, 'one')
  await waitFor(() => seenTurns().length === 1)
  assert.deepEqual(await first, { missed: true })
  // The second turn goes to whatever the driver believes answers it; the marker then releases the
  // first turn's answer, which must not become the second turn's answer.
  const second = run(member, 'two')
  await waitFor(() => seenTurns().length === 2)
  writeFileSync(mark, '1')
  const answer = await second
  assert.notDeepEqual(answer, 'answer to one', "the next turn was settled by the timed-out turn's late answer")
  if (typeof answer === 'string') assert.equal(answer, 'answer to two')
  await waitFor(() => starts().length === 2)
  assert.notEqual(starts()[1], starts()[0], 'a timed-out process must not answer the next turn')
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

test('a crash line reports the ending, and the last words stay in this host\'s log (#1164, #2699)', async (t) => {
  const BOOM = "process.stderr.write('boom: missing config\\n',()=>process.exit(3))"
  const { lines, warnings, run } = fixture(t)
  const member = { id: 'boom', name: 'Boom', external: { driver: 'subprocess', command: [process.execPath, '-e', BOOM] } }
  assert.equal((await run(member))?.failure?.reason, 'crashed')
  const entry = await waitForLine(lines, 'boom')
  assert.match(entry.text, /crashed \(exit 3\)/)
  // The room reads how the process ended; its last words name this host's files, and the room's line
  // is read by the other homes in it (#2699).
  assert.doesNotMatch(entry.text, /missing config/)
  assert.ok(warnings.some(line => line.includes('boom: missing config')), 'the log keeps what the child said')
  // The tail is capped: 400 characters of stderr keep only the last 200.
  const NOISE = "process.stderr.write('x'.repeat(400),()=>process.exit(3))"
  const noisy = { id: 'noise', name: 'Noise', external: { driver: 'subprocess', command: [process.execPath, '-e', NOISE] } }
  assert.equal((await run(noisy))?.failure?.reason, 'crashed')
  const noise = await waitForLine(lines, 'noise')
  assert.match(noise.text, /crashed \(exit 3\)/)
  assert.doesNotMatch(noise.text, /x{2,}/)
  const logged = warnings.find(line => line.includes('xxxxxxxx')) ?? ''
  assert.match(logged, /x{200}/)
  assert.doesNotMatch(logged, /x{201}/)
})
test('a crash is reported when a grandchild holds the stdio open (#1164)', async (t) => {
  // On the first launch the child leaves a grandchild on its inherited stdio and exits 1, so
  // 'close' is postponed for as long as the grandchild lives (measured here: exit at ~40 ms,
  // close at ~1280 ms). The crash line must not wait for 'close', and the seat must be free at
  // once. The marker makes the second launch a normal responder.
  const HELD = "const fs=require('node:fs');const cp=require('node:child_process');if(!fs.existsSync(process.env.MARK)){fs.writeFileSync(process.env.MARK,'1');fs.writeSync(2,'boom: helper holds the pipe\\n');cp.spawn(process.execPath,['-e','setTimeout(()=>{},1200)'],{stdio:'inherit'});process.exit(1)}let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))!==-1){const l=b.slice(0,i);b=b.slice(i+1);const m=JSON.parse(l);if(m.type==='turn')process.stdout.write(JSON.stringify({text:'again: '+m.text})+'\\n')}})"
  const dir = mkdtempSync(join(tmpdir(), 'flybot-external-'))
  const mark = join(dir, 'mark')
  const { lines, warnings, run } = fixture(t)
  const member = { id: 'held', name: 'Held', external: { driver: 'subprocess', command: [process.execPath, '-e', HELD], env: { MARK: mark } } }
  const started = Date.now()
  const first = run(member)
  // 900 ms is before the grandchild's 1.2 s: only reporting from 'exit' can meet this.
  const entry = await waitForLine(lines, 'held', 900)
  const elapsed = Date.now() - started
  assert.match(entry.text, /crashed \(exit 1\)/)
  assert.doesNotMatch(entry.text, /helper holds the pipe/)
  assert.ok(warnings.some(line => line.includes('helper holds the pipe')), 'the log keeps what the child said')
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

// ---- #2689: a line that outgrows the 4 KB in-flight buffer -------------------------------
// A line is settled only when its newline arrives, so an answer split across the buffer cap used
// to be erased: the turn then hit the reply timeout, the room was told the process timed out, and
// an answer that did exist was counted as silence. The cap bounds the unparsed tail, so an
// over-long line is now a reported failure of the turn, and the process stays for the next one.
const LONG_ANSWER = (text, splitAt) => `const fs=require('node:fs');
fs.appendFileSync(process.env.SEEN,'start '+process.pid+'\\n');
let b='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{
  b+=c;
  let i;
  while((i=b.indexOf('\\n'))!==-1){
    const l=b.slice(0,i);
    b=b.slice(i+1);
    const m=JSON.parse(l);
    if(m.type!=='turn')continue;
    if(m.text==='big'){
      const j=JSON.stringify({text:${JSON.stringify(text)}});
      process.stdout.write(j.slice(0,${splitAt}));
      setTimeout(()=>process.stdout.write(j.slice(${splitAt})+'\\n'),60);
    } else process.stdout.write(JSON.stringify({text:'ok: '+m.text})+'\\n');
  }
});`

test('an answer line split past the 4 KB buffer is a failure, not a timeout, and keeps the process (#2689)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-external-'))
  const seen = join(dir, 'seen.txt')
  writeFileSync(seen, '')
  const { driver, rt, lines, run } = fixture(t)
  rt.roomReplyTimeoutMs = 700
  const member = { id: 'long', name: 'Long', external: { driver: 'subprocess', command: [process.execPath, '-e', LONG_ANSWER('x'.repeat(5000), 4200)], env: { SEEN: seen } } }
  const starts = () => readFileSync(seen, 'utf8').split('\n').filter(row => row.startsWith('start '))

  const reply = await run(member, 'big')
  assert.deepEqual(reply, { failure: { reason: 'error', detail: 'answer exceeded 4096 bytes' } },
    'the answer existed; it is reported as too large, not as silence')
  const line = await waitForLine(lines, 'long')
  assert.doesNotMatch(line.text, /timed out/, 'an over-long answer is not an unanswered turn')
  assert.match(line.text, /more than 4096 bytes/)
  assert.equal(driver.snapshot('external:ops:long').state, 'idle')

  // The process was not killed for timing out: the same one answers the next turn.
  assert.equal(await run(member, 'two'), 'ok: two')
  assert.equal(starts().length, 1, 'a long answer cost the seat its process')
})

test('bytes after an over-long line are dropped, never parsed as the answer (#2689)', async (t) => {
  // The tail after the overflow happens to be a well-formed answer object; it is the remainder of
  // the line that already overflowed, so it must not settle the turn with its text.
  const SPLIT_FRAGMENT = `let b='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{
  b+=c;
  let i;
  while((i=b.indexOf('\\n'))!==-1){
    const l=b.slice(0,i);
    b=b.slice(i+1);
    const m=JSON.parse(l);
    if(m.type!=='turn')continue;
    process.stdout.write('{"text":"'+'x'.repeat(4200));
    setTimeout(()=>process.stdout.write('{"text":"sneaky"}\\n'),60);
  }
});`
  const { rt, run } = fixture(t)
  rt.roomReplyTimeoutMs = 700
  const member = { id: 'frag', name: 'Frag', external: { driver: 'subprocess', command: [process.execPath, '-e', SPLIT_FRAGMENT] } }
  const reply = await run(member, 'big')
  assert.deepEqual(reply, { failure: { reason: 'error', detail: 'answer exceeded 4096 bytes' } })
})

test('a long line logged while no turn is open is discarded to its newline, not buffered (#2689)', async (t) => {
  // A child may log; a log line past the cap must not grow the buffer without bound, and it must
  // not leave the entry in a state where the next real answer is mangled or the turn fails.
  const NOISY = `const fs=require('node:fs');
fs.appendFileSync(process.env.SEEN,'start '+process.pid+'\\n');
setTimeout(()=>process.stdout.write('z'.repeat(20000)),50);
setTimeout(()=>process.stdout.write('\\n'),150);
let b='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{
  b+=c;
  let i;
  while((i=b.indexOf('\\n'))!==-1){
    const l=b.slice(0,i);
    b=b.slice(i+1);
    const m=JSON.parse(l);
    if(m.type==='turn')process.stdout.write(JSON.stringify({text:'ok: '+m.text})+'\\n');
  }
});`
  const dir = mkdtempSync(join(tmpdir(), 'flybot-external-'))
  const seen = join(dir, 'seen.txt')
  writeFileSync(seen, '')
  const { driver, room, lines, run } = fixture(t)
  const member = { id: 'noisy', name: 'Noisy', external: { driver: 'subprocess', command: [process.execPath, '-e', NOISY], env: { SEEN: seen } } }
  // `open` starts the process without a turn: the noise line is written while the seat is idle.
  await driver.open({ room, member })
  await waitFor(() => readFileSync(seen, 'utf8').includes('start '))
  // The turn opens after the noise line is closed: the noise never becomes its answer or line.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await run(member, 'hi'), 'ok: hi')
  assert.deepEqual(lines.filter(line => line.botId === 'noisy'), [])
})

test('a log line that overflowed while idle does not settle a turn opened before its newline (#2689)', async (t) => {
  // The line owned no turn when it overflowed, and the turn opens while its tail is still in
  // flight: that line's newline is not its answer, so it must not settle the turn.
  const CROSSING = `const fs=require('node:fs');
fs.appendFileSync(process.env.SEEN,'start '+process.pid+'\\n');
setTimeout(()=>process.stdout.write('z'.repeat(6000)),50);
setTimeout(()=>process.stdout.write('\\n'),400);
let b='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{
  b+=c;
  let i;
  while((i=b.indexOf('\\n'))!==-1){
    const l=b.slice(0,i);
    b=b.slice(i+1);
    const m=JSON.parse(l);
    if(m.type==='turn')setTimeout(()=>process.stdout.write(JSON.stringify({text:'ok: '+m.text})+'\\n'),200);
  }
});`
  const dir = mkdtempSync(join(tmpdir(), 'flybot-external-'))
  const seen = join(dir, 'seen.txt')
  writeFileSync(seen, '')
  const { driver, room, lines, run } = fixture(t)
  const member = { id: 'cross', name: 'Cross', external: { driver: 'subprocess', command: [process.execPath, '-e', CROSSING], env: { SEEN: seen } } }
  await driver.open({ room, member })
  await waitFor(() => readFileSync(seen, 'utf8').includes('start '))
  // The 6000-byte log line has overflowed while the seat is idle; the turn opens before its
  // newline lands at ~400 ms, and the child answers 200 ms after that.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(await run(member, 'hi'), 'ok: hi', 'the idle log line did not swallow the turn')
  assert.deepEqual(lines.filter(line => line.botId === 'cross'), [], 'an idle log line is not an answer')
});

test('a log line and a second object next to the answer are still ignored (#2689)', async (t) => {
  const THREE = `let b='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{
  b+=c;
  let i;
  while((i=b.indexOf('\\n'))!==-1){
    const l=b.slice(0,i);
    b=b.slice(i+1);
    const m=JSON.parse(l);
    if(m.type==='turn')process.stdout.write('starting up\\n'+JSON.stringify({text:'ok: '+m.text})+'\\n'+JSON.stringify({text:'not this turn'})+'\\n');
  }
});`
  const { run } = fixture(t)
  const member = { id: 'three', name: 'Three', external: { driver: 'subprocess', command: [process.execPath, '-e', THREE] } }
  assert.equal(await run(member, 'one'), 'ok: one')
  assert.equal(await run(member, 'two'), 'ok: two')
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
