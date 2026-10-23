// Reads the usage ledger into the numbers #796 asks for: per Bot, per Session, per day,
// and the prompt a Session grows by from one call to the next. It is a report, not a
// change to what is sent: it opens the ledger read-only and prints.
//
//   node dev/token-report.mjs [--db <path>] [--from <date>] [--to <date>] [--tz <zone>]
//                             [--bot <name>] [--top <n>] [--growth <n>] [--json]
//
// `--db` defaults to `$DSH_HOME/usage.sqlite` (see src/host/usage.js). A missing file is an
// error, never an empty table: an empty report is exactly what a broken path looks like.
//
// Fresh input, cache read and cache write are kept apart in every total. A cache read is
// not a fresh input token and summing them hides which one moved (`#796`). `prompt` is the
// sum of the three and is printed as its own column, never used as the input figure.
//
// `--from` / `--to` take `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]`, read in `--tz`
// (default UTC) unless they carry `Z` or an offset. A bare `--to` date ends at the end of
// that day in `--tz`. `--bot` matches a Bot name (case-insensitive) or a Session id
// prefix. `--top` is how many Sessions the "top by prompt" table shows (default 10) and
// `--growth` how many carry the per-call growth table (default 5, 0 turns it off).
//
// Percentiles are nearest-rank: the sorted value at `ceil(p/100 * n) - 1`, so a p99 of a
// small sample is its maximum. The report prints that definition too.
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = 'usage: node dev/token-report.mjs [--db <path>] [--from <date>] [--to <date>] [--tz <zone>] [--bot <name|session>] [--top <n>] [--growth <n>] [--json]'

function die(message) {
  console.error(`token-report: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const flags = { db: null, from: null, to: null, tz: 'UTC', bot: null, top: 10, growth: 5, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) die(`${arg} needs a value`)
      index += 1
      return next
    }
    switch (arg) {
      case '--db': flags.db = value(); break
      case '--from': flags.from = value(); break
      case '--to': flags.to = value(); break
      case '--tz': flags.tz = value(); break
      case '--bot': flags.bot = value(); break
      case '--top': flags.top = Number(value()); break
      case '--growth': flags.growth = Number(value()); break
      case '--json': flags.json = true; break
      case '--help': case '-h': console.log(USAGE); process.exit(0); break
      default: die(`unknown argument ${arg}\n${USAGE}`)
    }
  }
  for (const key of ['top', 'growth']) {
    if (!Number.isSafeInteger(flags[key]) || flags[key] < 0) die(`--${key} must be a whole number`)
  }
  return flags
}

// The local wall-clock parts of an instant in a zone, and the epoch of those parts read
// as UTC (that difference is the zone's offset at that instant).
function localParts(tz, time) {
  let format
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
  } catch {
    die(`unknown time zone ${tz}`)
  }
  const part = Object.fromEntries(format.formatToParts(new Date(time)).map(({ type, value }) => [type, value]))
  return { year: Number(part.year), month: Number(part.month), day: Number(part.day), hour: Number(part.hour), minute: Number(part.minute), second: Number(part.second) }
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:\d{2})?$/

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()
const pad = value => String(value).padStart(2, '0')
const cannotRead = (text, why) => die(`cannot read ${JSON.stringify(text)} as a date${why === undefined ? '' : ` (${why})`}`)

// An instant from a date in the report's zone; `endOfDay` turns a bare date into the last
// millisecond of that day. Two passes settle a zone whose offset itself depends on the
// instant (a DST boundary). The next day is a calendar step, not 24 hours: the day a zone
// falls back is 25 hours long, so adding a day in milliseconds stays inside the same one.
function parseInstant(text, tz, endOfDay) {
  const match = DATE.exec(text)
  if (match === null) cannotRead(text, 'expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS]')
  const [, year, month, day, hour, minute, second, offset] = match
  const [y, mo, d] = [Number(year), Number(month), Number(day)]
  const [h, mi, s] = [Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0)]
  if (mo < 1 || mo > 12) cannotRead(text, `month ${mo} does not exist`)
  if (d < 1 || d > daysInMonth(y, mo)) cannotRead(text, `day ${d} does not exist in ${year}-${month}`)
  if (h > 23 || mi > 59 || s > 59) cannotRead(text, 'time out of range')
  const start = instantOf(y, mo, d, h, mi, s, offset, tz, text)
  if (!endOfDay || hour !== undefined) return start
  const next = new Date(Date.UTC(y, mo - 1, d + 1))
  const nextStart = instantOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, offset, tz, text)
  return nextStart - 1
}

// The epoch of those wall-clock parts: in `offset` when the date states one, in `tz`
// otherwise. Anything Date.parse refuses — or an offset outside the real range — is an
// error rather than a NaN: a NaN binds as NULL, matches no row, and prints an empty report.
function instantOf(y, mo, d, h, mi, s, offset, tz, text) {
  const date = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`
  if (offset !== undefined) {
    const instant = Date.parse(`${date}${offset}`)
    if (!Number.isFinite(instant)) cannotRead(text, `offset ${offset}`)
    return instant
  }
  const guess = Date.UTC(y, mo - 1, d, h, mi, s)
  let instant = guess
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localParts(tz, instant)
    const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
    instant = guess - (asUtc - instant)
  }
  if (!Number.isFinite(instant)) cannotRead(text, `zone ${tz}`)
  return instant
}

const count = value => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0)

// Nearest-rank percentile of an ascending array.
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]
}

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0)
const promptOf = row => row.input + row.cacheRead + row.cacheWrite

function readRows(dbPath, { from, to, bot }) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const where = []
    const params = []
    if (from !== null) { where.push('c.time >= ?'); params.push(from) }
    if (to !== null) { where.push('c.time <= ?'); params.push(to) }
    const sql = `SELECT c.session, c.time, c.provider, c.model, c.kind, c.input, c.cache_read, c.cache_write, c.output, o.name AS bot
      FROM calls c LEFT JOIN owners o ON o.session = c.session
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY c.session, c.time, c.key`
    const rows = db.prepare(sql).all(...params).map(row => ({
      session: String(row.session),
      time: Number(row.time),
      provider: String(row.provider ?? ''),
      model: String(row.model ?? ''),
      kind: String(row.kind ?? ''),
      input: count(row.input),
      cacheRead: count(row.cache_read),
      cacheWrite: count(row.cache_write),
      output: count(row.output),
      bot: row.bot === null || row.bot === undefined ? null : String(row.bot),
    }))
    if (bot === null) return rows
    const needle = bot.toLowerCase()
    return rows.filter(row => (row.bot ?? '').toLowerCase() === needle || row.session.toLowerCase().startsWith(needle))
  } finally {
    db.close()
  }
}

function totals(rows) {
  const input = sum(rows, 'input')
  const cacheRead = sum(rows, 'cacheRead')
  const cacheWrite = sum(rows, 'cacheWrite')
  const output = sum(rows, 'output')
  const prompts = rows.map(promptOf).sort((a, b) => a - b)
  const prompt = input + cacheRead + cacheWrite
  return {
    calls: rows.length,
    input,
    cacheRead,
    cacheWrite,
    output,
    prompt,
    promptPerCall: {
      p50: percentile(prompts, 50),
      p90: percentile(prompts, 90),
      p99: percentile(prompts, 99),
      max: prompts.length === 0 ? 0 : prompts[prompts.length - 1],
    },
    cacheReadShare: prompt === 0 ? 0 : cacheRead / prompt,
  }
}

// A Session's calls are appended, so the prompt difference between one call and the next
// is what that turn added. A smaller prompt means a compaction, a checkpoint or a new part:
// the turn after it does not grow the old prompt, so that crossing starts a new run and is
// not a delta. Reported deltas are therefore comparable, and the boundaries are counted.
function growthOf(rows) {
  let previous = null
  let resets = 0
  const points = []
  const deltas = []
  for (const row of rows) {
    const prompt = promptOf(row)
    let delta = previous === null ? null : prompt - previous
    if (delta !== null && delta < 0) { delta = null; resets += 1 }
    points.push({ time: row.time, prompt, delta })
    if (delta !== null) deltas.push(delta)
    previous = prompt
  }
  deltas.sort((a, b) => a - b)
  return {
    points,
    deltas: {
      count: deltas.length,
      median: percentile(deltas, 50),
      p90: percentile(deltas, 90),
      resets,
    },
  }
}

function groupBy(rows, key) {
  const groups = new Map()
  for (const row of rows) {
    const name = key(row)
    const group = groups.get(name) ?? []
    group.push(row)
    groups.set(name, group)
  }
  return groups
}

const dayKey = tz => (time) => {
  const local = localParts(tz, time)
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`
}

export function buildReport(rows, { db, from, to, tz }) {
  const bots = [...groupBy(rows, row => row.bot ?? row.session)]
    .map(([bot, group]) => ({ bot, ...totals(group) }))
    .sort((a, b) => b.prompt - a.prompt)
  const sessions = [...groupBy(rows, row => row.session)]
    .map(([session, group]) => {
      const sorted = [...group].sort((a, b) => a.time - b.time)
      const growth = growthOf(sorted)
      return {
        session,
        bot: sorted[0].bot ?? session,
        first: sorted[0].time,
        last: sorted[sorted.length - 1].time,
        ...totals(sorted),
        growth: growth.deltas,
        points: growth.points,
      }
    })
    .sort((a, b) => b.prompt - a.prompt)
  const days = [...groupBy(rows, row => dayKey(tz)(row.time))]
    .map(([day, group]) => ({ day, ...totals(group) }))
    .sort((a, b) => a.day.localeCompare(b.day))
  const pooled = sessions.flatMap(session => session.points).map(point => point.delta).filter(delta => delta !== null).sort((a, b) => a - b)
  return {
    db, from, to, tz, ...totals(rows), bots, sessions, days,
    growthAll: { count: pooled.length, median: percentile(pooled, 50), p90: percentile(pooled, 90), resets: sessions.reduce((total, session) => total + session.growth.resets, 0) },
  }
}

// ---------------------------------------------------------------------------
// Printing.

function table(title, columns, rows) {
  const cells = rows.map(row => columns.map(column => String(column.value(row))))
  const widths = columns.map((column, index) => Math.max(column.label.length, ...cells.map(row => row[index].length)))
  const line = values => values.map((value, index) => (columns[index].right ? value.padStart(widths[index]) : value.padEnd(widths[index]))).join('  ').trimEnd()
  const out = [title, '', line(columns.map(column => column.label)), line(widths.map(width => '-'.repeat(width)))]
  for (const row of cells) out.push(line(row))
  return out.join('\n')
}

const pct = share => `${(share * 100).toFixed(1)}%`
const utc = time => new Date(time).toISOString().replace('.000Z', 'Z')

function printText(report) {
  const window = `${report.from === null ? 'start' : utc(report.from)} .. ${report.to === null ? 'end' : utc(report.to)}`
  console.log(`ledger: ${report.db}`)
  console.log(`window: ${window} (days in ${report.tz})`)
  console.log(`calls: ${report.calls}`)
  console.log('')
  console.log(table('per Bot', [
    { label: 'bot', value: row => row.bot },
    { label: 'calls', value: row => row.calls, right: true },
    { label: 'fresh input', value: row => row.input, right: true },
    { label: 'cache read', value: row => row.cacheRead, right: true },
    { label: 'cache write', value: row => row.cacheWrite, right: true },
    { label: 'output', value: row => row.output, right: true },
    { label: 'prompt', value: row => row.prompt, right: true },
    { label: 'cache read share', value: row => pct(row.cacheReadShare), right: true },
  ], report.bots))
  console.log('')
  console.log('per call prompt (fresh input + cache read + cache write, nearest-rank)')
  console.log(`  all calls: p50 ${report.promptPerCall.p50}  p90 ${report.promptPerCall.p90}  p99 ${report.promptPerCall.p99}  max ${report.promptPerCall.max}`)
  console.log('')
  const top = report.sessions.slice(0, Math.max(0, report.top))
  if (top.length > 0) {
    console.log(table('top Sessions by prompt', [
      { label: 'session', value: row => row.session },
      { label: 'bot', value: row => row.bot },
      { label: 'calls', value: row => row.calls, right: true },
      { label: 'prompt', value: row => row.prompt, right: true },
      { label: 'fresh input', value: row => row.input, right: true },
      { label: 'cache read', value: row => row.cacheRead, right: true },
    ], top))
    console.log('')
  }
  if (report.days.length > 0) {
    console.log(table(`per day (${report.tz})`, [
      { label: 'day', value: row => row.day },
      { label: 'calls', value: row => row.calls, right: true },
      { label: 'fresh input', value: row => row.input, right: true },
      { label: 'cache read', value: row => row.cacheRead, right: true },
      { label: 'cache write', value: row => row.cacheWrite, right: true },
      { label: 'output', value: row => row.output, right: true },
      { label: 'prompt', value: row => row.prompt, right: true },
    ], report.days))
    console.log('')
  }
  const growth = report.sessions.slice(0, Math.max(0, report.growth))
  for (const session of growth) {
    const rows = session.points.map((point, index) => ({
      index,
      time: utc(point.time),
      prompt: point.prompt,
      delta: point.delta === null ? '(first or compaction)' : `+${point.delta}`,
    }))
    console.log(table(`prompt growth: ${session.session} (${session.bot}) — median delta ${session.growth.median}, p90 ${session.growth.p90}, ${session.growth.resets} compaction boundary(ies)`, [
      { label: 'call', value: row => row.index, right: true },
      { label: 'time', value: row => row.time },
      { label: 'prompt', value: row => row.prompt, right: true },
      { label: 'delta', value: row => row.delta, right: true },
    ], rows))
    console.log('')
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2))
  const dbPath = flags.db ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'usage.sqlite')
  if (!existsSync(dbPath)) die(`no ledger at ${dbPath} (pass --db <path>)`)
  const from = flags.from === null ? null : parseInstant(flags.from, flags.tz, false)
  const to = flags.to === null ? null : parseInstant(flags.to, flags.tz, true)
  if (from !== null && to !== null && from > to) die(`--from is after --to`)
  const rows = readRows(dbPath, { from, to, bot: flags.bot })
  const report = { ...buildReport(rows, { db: dbPath, from, to, tz: flags.tz }), top: flags.top, growth: flags.growth }
  if (flags.json) {
    const sessions = report.sessions.map(({ points, ...session }) => session)
    console.log(JSON.stringify({ ...report, sessions }, null, 2))
    return
  }
  printText(report)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
