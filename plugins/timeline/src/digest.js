// A team run report (#357/#401, #582): the window's per-Bot numbers and the team's rollup, as one
// short Markdown digest a person reads in a standup or a routine posts into a chat. Pure: a window
// in, text out. It reads what the window carries and quietly skips a field an older answer does not
// have (tools, waits), so it stays useful as the timeline grows. Read-only: nothing is written and
// no Session is touched.
const K = 1_000
const M = 1_000_000
const BUSY_MIN = 0.9
const ERROR_RATE_MIN = 0.5
const ERROR_TURNS_MIN = 3
const TOP_TOOLS = 5

/** A count a person reads at a glance: `840`, `12.3k`, `1.2M`. */
export function formatCount(value) {
  const n = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
  if (n >= M) return `${(n / M).toFixed(1)}M`
  if (n >= K) return `${(n / K).toFixed(1)}k`
  return String(n)
}

/** A duration a person reads at a glance: `40s`, `12m`, `1h05m`. */
export function formatMs(ms) {
  const value = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
  if (value < 60_000) return `${Math.round(value / 1000)}s`
  if (value < 3_600_000) return `${Math.round(value / 60_000)}m`
  const minutes = Math.round((value % 3_600_000) / 60_000)
  return `${Math.floor(value / 3_600_000)}h${String(minutes).padStart(2, '0')}m`
}

const percent = (part) => `${Math.round(part * 100)}%`
const pad = n => String(n).padStart(2, '0')
// The reader's own clock, the hours the panel header prints (`fmtClock` in client.js): a report
// copied from the panel must not name a different time than the header above the button.
const clock = (ms) => {
  const at = new Date(ms)
  return Number.isFinite(at.getTime()) ? `${pad(at.getHours())}:${pad(at.getMinutes())}` : ''
}

/**
 * `window` is a `timeline/window` answer. Resolves `{ title, range, live, bots, team, markdown,
 * line }`. `bots` is the per-Bot view in the order the window lists it (the Main Bot first, as the
 * panel draws it), `team` the rollup, `markdown` the report, `line` a one-line summary a reminder
 * can post.
 */
export function buildDigest(window = {}, { title = 'Team report', now = Date.now() } = {}) {
  const lanes = new Map((window.lanes ?? []).map(lane => [lane.id, lane]))
  const usageBy = new Map((window.usage ?? []).map(use => [use.lane, use]))
  const toolUseBy = new Map((window.toolUse ?? []).map(use => [use.lane, use.tools ?? []]))
  const waitingBy = new Map()
  for (const edge of window.edges ?? []) {
    if (edge?.unanswered > 0 && typeof edge.from === 'string') waitingBy.set(edge.from, (waitingBy.get(edge.from) ?? 0) + edge.unanswered)
  }

  const bots = (window.utilization ?? []).map((use) => {
    const lane = lanes.get(use.lane)
    const usage = usageBy.get(use.lane) ?? {}
    const turns = use.turns ?? 0
    const errors = use.errors ?? 0
    const waiting = waitingBy.get(use.lane) ?? 0
    const errorRate = turns > 0 ? errors / turns : 0
    const busyShare = use.windowMs > 0 ? use.busyMs / use.windowMs : 0
    const flags = []
    if (turns >= ERROR_TURNS_MIN && errorRate >= ERROR_RATE_MIN) flags.push(`${errors} of ${turns} turns failed`)
    if (turns > 0 && busyShare >= BUSY_MIN) flags.push(`busy ${percent(busyShare)} of the window`)
    if (turns === 0) flags.push('no turns')
    if (waiting > 0) flags.push(`${waiting} request(s) unanswered`)
    return {
      id: use.lane,
      name: lane?.name ?? use.lane,
      main: lane?.main === true,
      turns, errors, errorRate, busyShare,
      running: use.running === true,
      tokens: { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, calls: usage.calls ?? 0 },
      tools: (toolUseBy.get(use.lane) ?? []).slice(0, TOP_TOOLS),
      waiting, flags,
    }
  })

  // The longest still-open request: `stuck` already carries the wait, worst first (#469); an older
  // host has none, so the waiting exchanges are measured against `now` instead.
  const openWaits = window.stuck ?? (window.exchanges ?? [])
    .filter(arrow => arrow.waiting === true)
    .map(arrow => ({ id: arrow.id, from: arrow.from, to: arrow.to, waitedMs: Math.max(0, now - (arrow.t ?? now)) }))
  const longest = openWaits.slice().sort((a, b) => (b.waitedMs ?? 0) - (a.waitedMs ?? 0))[0]

  const sumTokens = (key) => bots.reduce((total, bot) => total + bot.tokens[key], 0)
  const team = {
    turns: bots.reduce((sum, bot) => sum + bot.turns, 0),
    errors: bots.reduce((sum, bot) => sum + bot.errors, 0),
    tokens: { input: sumTokens('input'), output: sumTokens('output'), cacheRead: sumTokens('cacheRead'), cacheWrite: sumTokens('cacheWrite'), calls: sumTokens('calls') },
    longestWait: longest === undefined ? null : { id: longest.id, from: longest.from, to: longest.to, waitedMs: longest.waitedMs ?? 0 },
    unhealthy: bots.filter(bot => bot.turns >= ERROR_TURNS_MIN && bot.errorRate >= ERROR_RATE_MIN).map(bot => bot.id),
  }

  const from = clock(window.from)
  const to = clock(window.to)
  const range = from && to ? `${from}–${to}` : 'the window'
  const lines = [`# ${title}`, `Window: ${range}${window.live === true ? ' · live' : ''}`]

  if (bots.length === 0) {
    lines.push('', 'No activity in the window.')
  } else {
    for (const bot of bots) {
      lines.push('', `## ${bot.name}${bot.main ? ' (main)' : ''}${bot.running ? ' · running' : ''}`)
      if (bot.turns > 0) {
        const failed = bot.errors > 0 ? `, ${bot.errors} failed (${percent(bot.errorRate)})` : ''
        lines.push(`- ${bot.turns} turns${failed}`)
        lines.push(`- busy ${percent(bot.busyShare)} of the window`)
        lines.push(`- tokens: ${formatCount(bot.tokens.input)} in / ${formatCount(bot.tokens.output)} out / ${formatCount(bot.tokens.cacheRead)} cached`)
      } else {
        lines.push('- no turns in the window')
      }
      if (bot.waiting > 0) lines.push(`- ${bot.waiting} request(s) unanswered`)
      if (bot.tools.length > 0) lines.push(`- tools: ${bot.tools.map(tool => `${tool.name} ×${tool.calls}${tool.failed > 0 ? ` (${tool.failed} failed)` : ''}`).join(', ')}`)
      const look = bot.flags.filter(flag => flag !== 'no turns')
      if (look.length > 0) lines.push(`- look: ${look.join('; ')}`)
    }
  }

  lines.push('', '## Team', `- ${team.turns} turns, ${team.errors} failed`)
  lines.push(`- tokens: ${formatCount(team.tokens.input)} in / ${formatCount(team.tokens.output)} out (${team.tokens.calls} calls)`)
  if (team.longestWait !== null) lines.push(`- longest wait: ${team.longestWait.from} → ${team.longestWait.to}, ${formatMs(team.longestWait.waitedMs)}`)
  if (team.unhealthy.length > 0) lines.push(`- needs a look: ${team.unhealthy.join(', ')}`)

  const line = team.turns === 0
    ? `No Bot activity in ${range}.`
    : `${team.turns} turns, ${team.errors} failed, ${formatCount(team.tokens.input)} tokens in over ${range}.`
  return { title, range, live: window.live === true, bots, team, markdown: lines.join('\n'), line }
}
