// Performance baseline on the mock bench (dev/bench.sh): the four numbers #356 fixed, measured
// from the same Session events the activity feed folds, plus the web process's resident RSS.
//
//   dev/bench.sh perf 3097 8797 reset
//   node dev/perf-baseline.mjs perf 3097 --out /tmp/perf.json
//   dev/bench.sh perf 3097 8797 stop
//
// A baseline, not a gate: there are no thresholds. It is a baseline only for this box and this
// scripted model, and the doc says so (docs/performance-baseline.md). Tooling only: it reads the
// bench, writes the file named by --out, and leaves no process of its own behind.
//
// The Session events are read through dev/turn-split.mjs, which already decodes the zstd
// `.jsonl.zstd` frames, so a measurement here means the same events the feed folds.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { cpus, totalmem, type as osType, release as osRelease } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

import { findSessionFiles, readSessionFile, sessionIdFromPath } from './turn-split.mjs'

const USAGE = 'usage: node dev/perf-baseline.mjs <bench-name> <port> --out <file.json> '
  + '[--turns 20] [--warmup 3] [--timeout 120000] [--message <text>]'

// The mock model is scripted; this is a prompt the bench answers with one tool call, which is
// what makes the tool-call latency sample exist at all.
const DEFAULT_MESSAGE = '请读一下项目根目录的 README.md 第一段，然后告诉我它讲了什么。'

export function nearestRank(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) throw new Error('nearestRank: no samples')
  if (!(p > 0 && p <= 100)) throw new Error(`nearestRank: p out of range: ${p}`)
  const rank = Math.ceil((p / 100) * sortedAsc.length)
  return sortedAsc[Math.min(sortedAsc.length, Math.max(1, rank)) - 1]
}

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('percentile: no samples')
  const numbers = values.map(Number)
  if (numbers.some((value) => !Number.isFinite(value))) throw new Error('percentile: non-finite sample')
  return nearestRank([...numbers].sort((a, b) => a - b), p)
}

// One scenario row: p50/p95 by nearest rank (no interpolation, so a number is always a sample),
// `peak` the largest sample, `samples` how many the row rests on.
export function summarize(metric, unit, values) {
  if (!Array.isArray(values) || values.length === 0) return { metric, unit, samples: 0, p50: null, p95: null, peak: null }
  const rounded = values.map((value) => round1(Number(value)))
  return {
    metric,
    unit,
    samples: rounded.length,
    p50: round1(percentile(rounded, 50)),
    p95: round1(percentile(rounded, 95)),
    peak: round1(Math.max(...rounded)),
  }
}

export function round1(value) {
  return Math.round(Number(value) * 10) / 10
}

export function machineLine() {
  const cpu = cpus()[0]
  const cores = cpus().length
  const ramGb = round1(totalmem() / 1024 ** 3)
  return `${osType()} ${osRelease()}; ${cpu?.model?.trim() ?? 'unknown CPU'}; ${cores} cores; ${ramGb} GB RAM`
}

export function buildReport({ machine, commit, node, date, scenarios }) {
  return { machine, commit, node, date, scenarios }
}

export const REPORT_KEYS = ['machine', 'commit', 'node', 'scenarios']
export const SCENARIO_KEYS = ['metric', 'unit', 'samples', 'p50', 'p95', 'peak']

// The shape the doc and the diff rely on: two runs must be comparable field by field.
export function validateReport(report) {
  const problems = []
  if (!report || typeof report !== 'object') return ['report is not an object']
  for (const key of REPORT_KEYS) if (!(key in report)) problems.push(`missing ${key}`)
  if (typeof report.commit !== 'string' || !/^[0-9a-f]{40}$/.test(report.commit)) problems.push('commit is not a 40-character sha')
  if (typeof report.machine !== 'string' || report.machine.length < 5) problems.push('machine is not a line')
  if (typeof report.node !== 'string' || !report.node.startsWith('v')) problems.push('node is not a version')
  if (!Array.isArray(report.scenarios) || report.scenarios.length === 0) problems.push('scenarios is empty')
  for (const [index, assumed] of (report.scenarios ?? []).entries()) {
    for (const key of SCENARIO_KEYS) if (!(key in (assumed ?? {}))) problems.push(`scenarios[${index}] missing ${key}`)
    if (!(assumed?.samples >= 0)) problems.push(`scenarios[${index}] samples is not a count`)
  }
  return problems
}

// One markdown table: a header, then a row per scenario. A run pins itself by commit and date,
// so two runs diff row by row instead of being read as prose.
export function markdownTable(report) {
  const lines = [
    `<!-- perf-baseline: ${report.commit} ${report.date ?? ''} ${report.node} -->`,
    '',
    `Machine: ${report.machine}. Commit \`${report.commit.slice(0, 12)}\`, Node ${report.node}, run ${report.date ?? 'unknown'}.`,
    '',
    '| metric | unit | samples | p50 | p95 | peak |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const scenario of report.scenarios) {
    lines.push(`| ${scenario.metric} | ${scenario.unit} | ${scenario.samples} | ${scenario.p50 ?? 'n/a'} | ${scenario.p95 ?? 'n/a'} | ${scenario.peak ?? 'n/a'} |`)
  }
  return lines.join('\n')
}

// VmRSS of the web process the bench recorded, plus its children: `web.pid` is the pnpm that
// starts `dsh`, so the page's memory lives one level down. Peak over the run is what is reported.
export function rssMb(pid) {
  const kb = rssKb(pid, 0)
  return kb === null ? null : round1(kb / 1024)
}

function rssKb(pid, depth) {
  if (!pid || depth > 5) return null
  let status
  try {
    status = readFileSync(`/proc/${pid}/status`, 'utf8')
  } catch {
    return null
  }
  const own = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0)
  let children = 0
  let childPids = []
  try {
    childPids = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
  } catch {
    childPids = []
  }
  for (const child of childPids) children += rssKb(child, depth + 1) ?? 0
  return own + children
}

// Plugin load time: the bench truncates web.log right before it boots `dsh`, so the log's birth
// is the process start; the ready line is `dsh web: http`, the same line bench.sh waits on.
// When the file system does not report a birth time, `null` is returned rather than a guess.
export function pluginLoadMs(home) {
  const logPath = join(home, 'web.log')
  let log
  try {
    log = readFileSync(logPath, 'utf8')
  } catch {
    return null
  }
  if (!/dsh web: http/.test(log)) return null
  let start
  try {
    const stat = statSync(logPath, { bigint: true })
    start = stat.birthtimeMs > 0n ? Number(stat.birthtimeMs) : Number(stat.ctimeMs)
  } catch {
    return null
  }
  // The ready line is appended once, when the server is up: the file's mtime is that moment as
  // long as nothing wrote afterwards. A later write only makes the number an over-estimate, and
  // the doc says the number is an upper bound for the boot.
  const end = Number(statSync(logPath).mtimeMs)
  const ms = end - start
  return Number.isFinite(ms) && ms >= 0 ? round1(ms) : null
}

export function parseArgs(argv) {
  const flags = { name: null, port: null, out: null, turns: 20, warmup: 3, timeout: 120_000, message: DEFAULT_MESSAGE }
  const rest = [...argv]
  while (rest.length > 0) {
    const value = rest.shift()
    if (value === '--out') flags.out = rest.shift() ?? null
    else if (value === '--turns') flags.turns = Number(rest.shift())
    else if (value === '--warmup') flags.warmup = Number(rest.shift())
    else if (value === '--timeout') flags.timeout = Number(rest.shift())
    else if (value === '--message') flags.message = rest.shift() ?? DEFAULT_MESSAGE
    else if (value.startsWith('--')) throw new Error(`unknown flag: ${value}`)
    else if (flags.name === null) flags.name = value
    else if (flags.port === null) flags.port = Number(value)
    else throw new Error(`unexpected argument: ${value}`)
  }
  if (!flags.name || !flags.port) throw new Error('bench name and port are required')
  if (!flags.out) throw new Error('--out is required')
  if (!(flags.turns > 0) || !(flags.warmup >= 0)) throw new Error('--turns must be positive and --warmup not negative')
  return flags
}

// The bench's own login: web.log carries a one-time URL, and the cookie it sets is the session.
async function login(home, port) {
  let log = ''
  try {
    log = readFileSync(join(home, 'web.log'), 'utf8')
  } catch {
    throw new Error(`bench is down: no ${join(home, 'web.log')}`)
  }
  const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  if (!url) throw new Error(`bench is down: no login URL in web.log for port ${port}`)
  const response = await fetch(url, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0])
  if (cookies.length === 0) throw new Error(`login returned no cookie (${response.status})`)
  return cookies.join('; ')
}

function sessionFilePath(home, sessionId) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return null
  for (const file of findSessionFiles(root)) {
    if (sessionIdFromPath(file).startsWith(sessionId)) return file
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main(argv) {
  let flags
  try {
    flags = parseArgs(argv)
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`)
    return 2
  }
  const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const HOME = join(ROOT, `.dsh-test-${flags.name}`)
  const BASE = `http://127.0.0.1:${flags.port}`

  const cookie = await login(HOME, flags.port)
  const api = async (endpoint, payload = {}) => {
    const response = await fetch(`${BASE}/api/bot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ endpoint, payload }),
    })
    const result = await response.json()
    if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
    return result.value
  }

  const state = await api('state')
  const bots = Object.values(state?.bots ?? {})
  const chief = bots.find((bot) => bot.name === 'Chief') ?? bots.find((bot) => (state.mainBotIds ?? []).includes(bot.id))
  if (!chief?.sessionId) throw new Error('no Chief Session on this bench: reset it with bench.sh')
  const file = sessionFilePath(HOME, chief.sessionId)
  if (!file) throw new Error(`no Session file for ${chief.name} under ${join(HOME, 'sessions')}`)

  const rssSamples = []
  const sampleRss = () => {
    let pid = null
    try {
      pid = Number(readFileSync(join(HOME, 'web.pid'), 'utf8').trim())
    } catch {
      return
    }
    const value = rssMb(pid)
    if (value !== null) rssSamples.push(value)
  }
  sampleRss()

  const turnSamples = []
  const toolSamples = []
  const turnText = flags.message
  const total = flags.warmup + flags.turns

  for (let index = 0; index < total; index += 1) {
    const before = readSessionFile(file)
    const beforeKeys = new Set(before.map((event) => `${event.time}:${event.type}:${JSON.stringify(event.data ?? {}).slice(0, 40)}`))
    const started = performance.now()
    await api('send', { sessionId: chief.sessionId, text: turnText })
    const deadline = Date.now() + flags.timeout
    let events = null
    while (Date.now() < deadline) {
      await sleep(50)
      sampleRss()
      const current = readSessionFile(file)
      const fresh = current.filter((event) => !beforeKeys.has(`${event.time}:${event.type}:${JSON.stringify(event.data ?? {}).slice(0, 40)}`))
      const ended = fresh.find((event) => event.type === 'turn/end') ?? null
      if (ended) {
        events = { ended, fresh }
        break
      }
    }
    if (!events) throw new Error(`turn ${index + 1}/${total} timed out after ${flags.timeout} ms`)
    const elapsed = performance.now() - started
    sampleRss()

    const callTimes = new Map()
    let toolsThisTurn = 0
    for (const event of events.fresh) {
      if (event.type === 'tool/call' && event.data?.callId) callTimes.set(event.data.callId, Number(event.time))
      if (event.type === 'tool/result') {
        const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId
        const startedAt = callId === undefined ? undefined : callTimes.get(callId)
        if (startedAt !== undefined && Number.isFinite(startedAt) && Number(event.time) >= startedAt) {
          toolsThisTurn += 1
          const latency = Number(event.time) - startedAt
          if (index >= flags.warmup) toolSamples.push(latency)
        }
      }
    }
    if (index >= flags.warmup) {
      turnSamples.push(round1(elapsed))
    }
    if (toolsThisTurn === 0) console.error(`warning: turn ${index + 1}/${total} carried no tool call; the mock prompt did not trigger one`)
  }

  if (turnSamples.length === 0) throw new Error('no measured turn')
  if (toolSamples.length === 0) throw new Error('no measured tool call: the mock prompt triggered none, see the warnings')

  const load = pluginLoadMs(HOME)
  const report = buildReport({
    machine: machineLine(),
    commit: process.env.PERF_COMMIT ?? benchCommit(ROOT),
    node: process.version,
    date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    scenarios: [
      summarize('turn end-to-end', 'ms', turnSamples),
      summarize('tool-call latency', 'ms', toolSamples),
      summarize('resident RSS', 'MB', rssSamples),
      summarize('plugin load time', 'ms', load === null ? [] : [load]),
    ],
  })
  const problems = validateReport(report)
  if (problems.length > 0) throw new Error(`report is not the agreed shape: ${problems.join('; ')}`)

  writeFileSync(flags.out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(markdownTable(report))
  return 0
}

// The commit of the checkout the bench links. The bench runs without git on this host, so the
// caller may pass PERF_COMMIT instead of asking the file system.
function benchCommit(root) {
  const fromEnv = process.env.PERF_COMMIT
  if (fromEnv && /^[0-9a-f]{40}$/.test(fromEnv)) return fromEnv
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/.test(head)) return head
    const ref = /^ref:\s+(\S+)$/.exec(head)?.[1]
    if (ref) {
      const sha = readFileSync(join(root, '.git', ref), 'utf8').trim()
      if (/^[0-9a-f]{40}$/.test(sha)) return sha
    }
  } catch {
    // no git metadata next to the checkout: a baseline still records that it cannot name one.
  }
  return '0'.repeat(40)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(`perf-baseline: ${error.message}`)
    process.exit(1)
  })
}
