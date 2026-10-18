// Same-room acceptance smoke (#198): one real bench (dev/bench.sh), real DSH sessions
// and the scripted mock model, no real tokens. The room runs the acceptance
// choreography — delegation → forced clarification → answer → real edit + narrow
// self-test → report → requester-requested independent verification — and the
// requester disposes of the returned result through the task API. This is evidence
// for the "real room entry, deterministic model" tier only, not a real-model trial
// or human acceptance. Use a free port pair per bench and stop it afterwards.
//
//   dev/bench.sh roomlab 3196 8896 reset && node dev/room-smoke.mjs roomlab 3196
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, port] = process.argv.slice(2)
if (!name || !port) {
  console.error('usage: node dev/room-smoke.mjs <bench-name> <web-port>')
  process.exit(2)
}
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HOME = join(ROOT, `.dsh-test-${name}`)
const BASE = `http://127.0.0.1:${port}`
const QUIET_MS = 2500
const STEP_TIMEOUT_MS = 180_000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const mockLog = () => {
  try {
    return readFileSync(join(HOME, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function login() {
  const log = readFileSync(join(HOME, 'web.log'), 'utf8')
  const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  if (!url) throw new Error('no login URL in web.log')
  const response = await fetch(url, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0])
  if (cookies.length === 0) throw new Error(`login returned no cookie (${response.status})`)
  return cookies.join('; ')
}

const cookie = await login()
async function api(endpoint, payload = {}) {
  const response = await fetch(`${BASE}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
  return result.value
}

const state = () => readJson(join(HOME, 'bot', 'state.json'))
const botNamed = wanted => Object.values(state().bots).find(bot => bot.name === wanted)

// Quiet: no Bot shows an activity and the mock has taken no call for QUIET_MS. Late
// posts start new rounds, so activity alone is not enough.
async function settle() {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let calls = mockLog().length
  let since = Date.now()
  while (Date.now() < deadline) {
    await sleep(400)
    const { activity = {} } = await api('state')
    const now = mockLog().length
    if (now !== calls || Object.keys(activity).length > 0) {
      calls = now
      since = Date.now()
    } else if (Date.now() - since >= QUIET_MS) {
      return
    }
  }
  throw new Error('the team did not go quiet')
}

const failures = []
async function step(title, run, check) {
  const before = mockLog().length
  const started = Date.now()
  let value
  try {
    value = await run()
    await settle()
  } catch (error) {
    failures.push(`${title}: ${error.message}`)
    console.log(`FAIL ${title}: ${error.message}`)
    return undefined
  }
  const calls = mockLog().slice(before)
  const problem = (() => {
    try { return check?.(value, calls) } catch (error) { return error.message }
  })()
  if (problem) {
    failures.push(`${title}: ${problem}`)
    console.log(`FAIL ${title}: ${problem}`)
  } else {
    console.log(`ok   ${title} (${((Date.now() - started) / 1000).toFixed(1)} s, ${calls.length} model calls)`)
  }
  return value
}
const expect = (condition, message) => (condition ? undefined : message)

const send = (sessionId, text) => api('send', { sessionId, text })
const roomLog = room => room ? (room.log ?? []) : []
const shellCalls = calls => calls.flatMap(call => call.out ?? []).filter(block => block.type === 'tool_use' && ['bash', 'pwsh'].includes(block.name))

// The two Bots share the room folder; the independence of the check is in the Chief's
// own verify.mjs cases, which the Writer never sees. The host stores the canonical
// path, so compare against the realpath from the start.
const workdir = realpathSync(mkdtempSync(join(tmpdir(), 'flybot-room-smoke-')))
let taskId

await step('bootstrap: Chief gets a model', async () => {
  const { models } = await api('state')
  const chief = botNamed('Chief')
  if (chief === undefined) throw new Error('no Chief on a fresh bench (run bench.sh with reset)')
  if (chief.model !== undefined) throw new Error('the bench was not reset: Chief already has a model')
  await api('update-bot', { id: chief.id, model: models.at(-1).ref })
}, () => expect(botNamed('Chief').model !== undefined, 'Chief did not get a model'))

await step('Chief creates Writer', () => send(botNamed('Chief').id, '创建一个叫Writer的bot'), () =>
  expect(botNamed('Writer') !== undefined, 'no Writer'))

const room = await step('create the Pilot room over the shared workdir', async () => {
  const created = await api('create-room', { name: 'Pilot', members: [botNamed('Chief').id, botNamed('Writer').id], admin: botNamed('Chief').id })
  await api('update-room', { id: created.id, workDir: workdir })
  return created
}, created => {
  const saved = state().rooms[created.id]
  return expect(saved !== undefined, 'room not saved')
    ?? expect(saved.workDir === workdir, `room workDir is ${saved.workDir}`)
})

await step('the requester files and starts the task', async () => {
  const task = await api('task-create', { botId: botNamed('Chief').id, roomId: room.id,
    title: '实现 totalPaid(orders, region)：只合计 paid 订单，可按 region 过滤。动手前必须澄清 omitted region。',
    criteria: 'The member self-tests; the admin independently verifies; the requester accepts.' })
  taskId = task.id
  await api('task-accept', { id: task.id })
  return api('task-start', { id: task.id })
}, value => expect(value.status === 'working', `task is ${value.status}`))

await step('the room delegates and must clarify before editing', () => send(room.id, '协作任务'), () => {
  const log = roomLog(state().rooms[room.id])
  const at = pattern => log.findIndex(line => pattern.test(`${line.who}: ${line.text}`))
  const askedAt = at(/^Writer: @Chief 追问：/)
  return expect(at(/^Chief: @Writer 实现协作任务/) !== -1, 'Chief did not delegate in the room')
    ?? expect(askedAt !== -1, 'Writer did not ask about omitted region')
    ?? expect(at(/: @Writer omitted region 按全部/) > askedAt, 'the answer came before the question')
    ?? expect(at(/干完了：total\.mjs/) > askedAt, 'the member worked before the clarification')
})
const question = roomLog(state().rooms[room.id])
  .find(line => line.who === 'Writer' && line.text.startsWith('@Chief 追问'))?.text.replace(/^@\S+\s*/, '')
if (question === undefined) {
  console.log('room smoke: aborted — no clarification question in the room')
  process.exit(1)
}

const answer = 'omitted region 按全部 region 合计；未知 region 返回 0。'
let questionId
await step('the requester records the wait and answers the question', async () => {
  const wait = await api('task-wait-input', { id: taskId, question })
  questionId = wait.inputRequest?.id
  return api('task-answer-input', { id: taskId, questionId, answer })
}, (value, calls) => expect(value.status === 'working' && value.waitingFor === undefined, `task is ${value.status}/${value.waitingFor}`)
  ?? expect(questionId !== undefined, 'no question id on the wait')
  ?? expect(calls.length === 0, 'task bookkeeping must not call the model'))

// A fast tool finishes inside the round's work grace, so the member reports in-round
// and the admin's turns are spent; the requester asks for the independent check in a
// round of its own. The work evidence is checked against the full mock log.
await step('the member edits and self-tests; on request the admin independently verifies', () => send(room.id, '@Chief 请独立核验 total.mjs，不要复述它的结论。'), () => {
  const log = roomLog(state().rooms[room.id])
  const at = pattern => log.findIndex(line => pattern.test(`${line.who}: ${line.text}`))
  const done = at(/干完了：total\.mjs 已写好，自测退出码 0。/)
  const verified = at(/独立核验通过：/)
  return expect(done !== -1, 'Writer did not report its real self-test exit code')
    ?? expect(verified !== -1, 'Chief did not independently verify')
    ?? expect(verified > done, 'verification came before the report')
    ?? expect(shellCalls(mockLog()).length === 2, `expected one write and one verify shell call, got ${shellCalls(mockLog()).length}`)
    ?? expect(readFileSync(join(workdir, 'total.mjs'), 'utf8').includes('status === \'paid\''), 'total.mjs is not the agreed implementation')
    ?? expect(existsSync(join(workdir, 'selftest.mjs')) && existsSync(join(workdir, 'verify.mjs')) && existsSync(join(workdir, 'orders.json')), 'the work files are missing')
})

await step('the requester returns the result and accepts it', async () => {
  const log = roomLog(state().rooms[room.id])
  const summary = log.findLast(line => line.who === 'Chief' && line.text.includes('独立核验通过'))?.text
  const returned = await api('task-return', { id: taskId, summary })
  const accepted = await api('task-accept-result', { id: taskId })
  return { returned, accepted }
}, ({ returned, accepted }) => expect(returned.status === 'result-ready', `return went to ${returned.status}`)
  ?? expect(accepted.status === 'accepted', `acceptance went to ${accepted.status}`)
  ?? expect((accepted.inputRequest?.answer ?? '').includes('按全部'), 'the recorded answer was lost'))

rmSync(workdir, { recursive: true, force: true, maxRetries: 5 })
console.log(failures.length === 0 ? `\nroom smoke: all steps passed` : `\nroom smoke: ${failures.length} failed\n${failures.join('\n')}`)
process.exit(failures.length === 0 ? 0 : 1)
