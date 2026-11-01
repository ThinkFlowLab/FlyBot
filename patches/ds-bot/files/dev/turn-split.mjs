// Splits one real turn's prompt into the four parts #796 asks about: the fixed block
// (system prompt plus tool schemas, re-sent on every call), the history, the tool results,
// and the task (the message that opened the turn).
//
//   node dev/turn-split.mjs [--sessions <dir>] [--session <id>] [--turn <n>]
//                           [--tz <zone>] [--top <n>] [--stats] [--room <session-id>] [--json]
//
// `--sessions` is the DSH session root (default `$DSH_HOME/sessions`); the script walks it
// for `session.v4.jsonl.zstd` files. Every Session log carries, per call, the provider's own
// usage (`inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`) and the exact
// surface sent: the surviving `system/message`, the `request/header` tool list, and every
// message and `tool/result` appended so far. The prompt total is therefore measured, not
// estimated; the split across the four parts is derived from the characters each part holds
// and the fixed block is measured separately, by fitting one Session's prompts against its
// message characters (the fixed block is the intercept, because it is constant per call).
//
// Fresh input, cache read and cache write are never added into one another: `prompt` is
// their sum and is its own column, as on the usage page (`docs/reports/2026-10-25-token-spend.md`).
//
// A character count is printed as a character count. A token figure for one part is
// `derived` and carries its formula, because a Chinese system prompt and an ASCII tool
// schema do not share one characters-per-token ratio (see the report this script backs,
// `docs/reports/2026-10-26-turn-input-split.md`).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path, { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const USAGE = 'usage: node dev/turn-split.mjs [--sessions <dir>] [--session <id>] [--turn <n>] [--tz <zone>] [--days] [--top <n>] [--stats] [--room <session-id>] [--json]'
const ZSTD_MAGIC = 4247762216

function die(message) {
  console.error(`turn-split: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const flags = { sessions: null, session: null, turn: null, tz: 'UTC', days: false, top: 5, json: false, stats: false, room: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) die(`${arg} needs a value`)
      index += 1
      return next
    }
    switch (arg) {
      case '--sessions': flags.sessions = value(); break
      case '--session': flags.session = value(); break
      case '--turn': flags.turn = Number(value()); break
      case '--tz': flags.tz = value(); break
      case '--top': flags.top = Number(value()); break
      case '--days': flags.days = true; break
      case '--stats': flags.stats = true; break
      case '--room': flags.room = value(); break
      case '--json': flags.json = true; break
      case '--help': case '-h': console.log(USAGE); process.exit(0); break
      default: die(`unknown argument ${arg}\n${USAGE}`)
    }
  }
  if (!Number.isSafeInteger(flags.top) || flags.top < 1) die('--top must be a whole number')
  if (flags.turn !== null && !Number.isSafeInteger(flags.turn)) die('--turn must be a whole number')
  // A zone the runtime does not know would otherwise reach `Intl.DateTimeFormat` and throw an
  // uncaught RangeError from inside `localDay`, after the whole sample has been read.
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: flags.tz })
  } catch {
    die(`unknown time zone ${flags.tz}`)
  }
  if (flags.stats && flags.days) die('--stats and --days measure different things; pass one of them')
  return flags
}

// A Session artifact is a concatenation of independently decodable Zstandard frames, one
// per appended batch. Node's one-shot decoder stops after the first frame, so the frame
// ranges are found by walking the container format (no decompression) and each frame is
// decoded on its own. This mirrors the reader in the Session backend.
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      offset += blockType === 1 ? 1 : blockSize
      if (offset > buffer.length) return { frames, tornStart: start }
      if (lastBlock) break
    }
    if (checksum) offset += 4
    if (offset > buffer.length) return { frames, tornStart: start }
    frames.push({ start, end: offset })
  }
  return { frames }
}

// The provider's reported usage is the last `usage` chunk of a settled attempt.
export function usageOf(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

function textOf(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  let text = ''
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') text += block.text
    else if (block.type === 'tool-call') text += JSON.stringify(block)
  }
  return text
}

const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)

// One Session's events, folded into the surface each call sent and the usage it reported.
// A message belongs to the turn that was open when it arrived; a message admitted just
// before `turn/start` (the runtime context, the time context, the user's own words) is the
// turn's task, so it is attributed to that turn when the turn opens.
export function foldSessionEvents(events) {
  const steps = []
  const turns = new Map()
  let system = ''
  let tools = ''
  let turn = null
  let open = false
  let pending = 0
  const messages = []
  let toolCallNames = new Map()
  const largestTool = new Map()
  const toolTotal = new Map()
  const toolCount = new Map()
  const toolAddedByName = new Map()
  const turnStarts = []
  const retries = []
  const attempts = []
  for (const event of events) {
    const data = event?.data ?? {}
    switch (event?.type) {
      case 'system/message':
        system = textOf(data.message?.content)
        break
      case 'request/header':
        tools = JSON.stringify(data.header?.tools ?? [])
        break
      case 'turn/start':
        turn = data.turn ?? null
        turnStarts.push({ turn, time: event.time })
        open = true
        for (let index = messages.length - pending; index < messages.length; index += 1) messages[index].turn = turn
        pending = 0
        break
      case 'turn/end':
        open = false
        break
      case 'compaction/end':
        messages.length = 0
        pending = 0
        break
      case 'tool/call':
        toolCallNames.set(data.callId, data.name ?? '')
        break
      case 'user/message': {
        const entry = { role: 'user', turn: open ? turn : null, chars: textOf(data.content).length }
        messages.push(entry)
        if (!open) pending += 1
        break
      }
      case 'tool/result': {
        const callId = data.message?.toolCallId ?? data.message?.source?.callId
        const resultTurn = open ? turn : (data.turn ?? null)
        const resultChars = textOf(data.message?.content).length
        const resultName = toolCallNames.get(callId) ?? data.message?.toolName ?? ''
        largestTool.set(resultTurn, Math.max(largestTool.get(resultTurn) ?? 0, resultChars))
        toolTotal.set(resultTurn, (toolTotal.get(resultTurn) ?? 0) + resultChars)
        toolCount.set(resultTurn, (toolCount.get(resultTurn) ?? 0) + 1)
        const byName = toolAddedByName.get(resultTurn) ?? {}
        byName[resultName] = (byName[resultName] ?? 0) + resultChars
        toolAddedByName.set(resultTurn, byName)
        messages.push({
          role: 'tool',
          turn: open ? turn : (data.turn ?? null),
          chars: textOf(data.message?.content).length,
          name: toolCallNames.get(callId) ?? data.message?.toolName ?? '',
        })
        break
      }
      case 'llm/retry':
        retries.push({ time: event.time })
        break
      case 'assistant/attempt':
        attempts.push({ time: event.time, usage: usageOf(data.stream) })
        break
      case 'assistant/message': {
        const usage = usageOf(data.stream)
        const current = data.turn ?? null
        if (usage) {
          const chars = { tool: 0, assistant: 0, task: 0, history: 0 }
          const toolCharsByName = {}
          for (const message of messages) {
            if (message.role === 'tool') {
              chars.tool += message.chars
              toolCharsByName[message.name] = (toolCharsByName[message.name] ?? 0) + message.chars
            }
            else if (message.role === 'assistant') chars.assistant += message.chars
            else if (message.role === 'user') {
              if (message.turn === current) chars.task += message.chars
              else chars.history += message.chars
            }
          }
          const step = {
            turn: current,
            step: data.step ?? null,
            time: event.time,
            input: count(usage.inputTokens),
            cacheRead: count(usage.cacheReadTokens),
            cacheWrite: count(usage.cacheWriteTokens),
            output: count(usage.outputTokens),
            systemChars: system.length,
            toolsChars: tools.length,
            messageChars: chars.task + chars.history + chars.assistant + chars.tool,
            chars: { task: chars.task, history: chars.history + chars.assistant, tool: chars.tool },
            toolCharsByName,
          }
          step.prompt = step.input + step.cacheRead + step.cacheWrite
          steps.push(step)
          const aggregate = turns.get(current) ?? { turn: current, calls: 0, prompt: 0, output: 0, first: step, last: step }
          aggregate.calls += 1
          aggregate.prompt += step.prompt
          aggregate.output += step.output
          aggregate.last = step
          turns.set(current, aggregate)
        }
        let assistantChars = 0
        for (const block of (data.message?.content ?? [])) {
          if (block.type === 'tool-call') assistantChars += JSON.stringify(block).length
          else if (typeof block.text === 'string') assistantChars += block.text.length
        }
        messages.push({ role: 'assistant', turn: current, chars: assistantChars })
        break
      }
      default:
        break
    }
  }
  return { steps, turns: [...turns.values()], largestTool, toolTotal, toolCount, toolAddedByName, turnStarts, retries, attempts, systemChars: system.length, toolsChars: tools.length }
}

// The fixed block is constant for every call of one Session, so it is that Session's
// intercept when its provider-reported prompts are fitted against its message characters:
// `prompt = fixed + k * messageChars`. `k` is the message cost per character and
// `charsPerToken` its inverse. Fewer than eight calls, or no variation in the message
// characters, leaves the Session without a fit rather than inventing one.
export function fitFixed(steps) {
  const usable = steps.filter((step) => step.prompt > 0 && step.messageChars > 0)
  if (usable.length < 8) return null
  const n = usable.length
  const meanX = usable.reduce((sum, step) => sum + step.messageChars, 0) / n
  const meanY = usable.reduce((sum, step) => sum + step.prompt, 0) / n
  let sxx = 0
  let sxy = 0
  for (const step of usable) {
    sxx += (step.messageChars - meanX) ** 2
    sxy += (step.messageChars - meanX) * (step.prompt - meanY)
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  const intercept = meanY - slope * meanX
  let residual = 0
  let total = 0
  for (const step of usable) {
    residual += (step.prompt - intercept - slope * step.messageChars) ** 2
    total += (step.prompt - meanY) ** 2
  }
  return {
    n,
    fixedTokens: intercept,
    charsPerToken: slope > 0 ? 1 / slope : null,
    r2: total > 0 ? 1 - residual / total : 1,
    fixedChars: usable[0].systemChars + usable[0].toolsChars,
  }
}

// One call's prompt, split into the four parts. The fixed block is the measured intercept;
// what is left after it is distributed over the parts by their character share, which is
// the only per-part evidence the log holds.
export function splitStep(step, fit) {
  const fixed = Math.max(0, Math.min(fit.fixedTokens, step.prompt))
  const rest = Math.max(0, step.prompt - fixed)
  const total = step.messageChars
  const share = (chars) => (total > 0 ? rest * chars / total : 0)
  return { fixed, task: share(step.chars.task), history: share(step.chars.history), tool: share(step.chars.tool) }
}

// The decoded artifact: its events, and the text they came from, which is how the fan-out
// statistic learns that a Session names a room.
export function decodeSession(file) {
  const buffer = readFileSync(file)
  const { frames } = scanZstdFrames(buffer)
  const events = []
  let text = ''
  for (const { start, end } of frames) {
    let frame
    try {
      frame = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch {
      continue
    }
    text += frame
    for (const line of frame.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // A torn or foreign line is skipped: one bad line must not hide the Session.
      }
    }
  }
  return { events, text }
}

export function readSessionFile(file) {
  return decodeSession(file).events
}

// `findSessionFiles` builds every path with `join`, so on Windows the separator is `\` and a
// `file.split('/')` reads one element: each row then carried `id: undefined`, which crashed the
// id column on `.padEnd`, the `--room` lookup on `.startsWith` and printed `undefined` in every
// derived table (#1989). The id is the directory holding the log, so it comes from the path API,
// which reads whichever separator the host joins with. `api` is a parameter so a test can read a
// Windows-shaped path on any host.
export const sessionIdFromPath = (file, api = path) => api.basename(api.dirname(file))

export function findSessionFiles(root) {
  const files = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0) walk(path, depth - 1)
      } else if (entry.name === 'session.v4.jsonl.zstd') files.push(path)
    }
  }
  walk(root, 2)
  return files.sort()
}

const localDay = (time, tz) => {
  if (!Number.isFinite(time)) return 'unknown'
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time))
  const part = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${part.year}-${part.month}-${part.day}`
}
const integer = (value) => Math.round(value).toLocaleString('en-US')

// The statistics §5, §7 and §8 of the report quote, so each number there has one command
// behind it. Every figure is either counted in the log or derived by the formula printed
// beside it; nothing here estimates.
const FANOUT_WINDOW = 10 * 60_000

function printStats({ flags, sessions, rows, root }) {
  const percentile = (values, q) => {
    if (values.length === 0) return 0
    const sorted = values.slice().sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]
  }
  const dayOf = (time) => localDay(time, flags.tz)
  const out = { sample: { root: resolve(root), sessions: sessions.length, tz: flags.tz }, toolResults: null, fanout: null, retries: [] }
  const lines = []

  // §5: the tool results of one turn — the one with the most tool text unless --turn names it.
  const sampleTurn = flags.turn !== null
    ? rows.find((row) => row.turn === flags.turn)
    : rows.slice().sort((a, b) => b.toolTotal - a.toolTotal)[0]
  lines.push('## Tool results')
  if (sampleTurn) {
    const added = sampleTurn.toolTotal
    const bash = sampleTurn.addedByName.bash ?? 0
    const share = added > 0 ? bash / added * 100 : 0
    out.toolResults = {
      session: sampleTurn.session,
      turn: sampleTurn.turn,
      results: sampleTurn.toolCount,
      characters: added,
      onLastSurface: sampleTurn.toolAdded,
      largest: sampleTurn.largestTool,
      bash,
      bashShare: share,
      carried: sampleTurn.tool,
    }
    lines.push(`${sampleTurn.session} turn ${sampleTurn.turn} (the turn with the most tool text): `
      + `results ${integer(sampleTurn.toolCount)}; characters added ${integer(added)}; largest single result ${integer(sampleTurn.largestTool)}; `
      + `bash ${integer(bash)} chars (${share.toFixed(1)}%); still on the last call's surface ${integer(sampleTurn.toolAdded)} chars; `
      + `carried in the turn's prompts ${integer(sampleTurn.tool)} tokens`)
  } else {
    lines.push('not measured: no turn in the sample could be split (every Session needs 8 calls)')
  }
  lines.push('')

  // §7: fan-out around one room's own Session — how many member Bots a single room message
  // wakes within the window, and what their calls cost that day.
  lines.push('## Fan-out')
  if (flags.room === null) {
    lines.push('not measured: pass --room <session-id>')
  } else {
    const room = sessions.find((session) => session.id.startsWith(flags.room))
    if (!room) die(`no Session matching --room ${flags.room}`)
    const members = sessions.filter((session) => session.id !== room.id && session.text.includes(room.id))
    const messages = room.turnStarts.map((start) => start.time).filter((time) => Number.isFinite(time))
    if (messages.length === 0) die(`no room message in ${room.id}`)
    const bots = []
    const turns = []
    for (const time of messages) {
      const waking = []
      for (const session of members) {
        for (const start of session.turnStarts) {
          if (start.time > time && start.time <= time + FANOUT_WINDOW) waking.push(session.id)
        }
      }
      bots.push(new Set(waking).size)
      turns.push(waking.length)
    }
    const days = new Map()
    for (const session of members) {
      for (const step of session.steps) {
        const day = dayOf(step.time)
        const row = days.get(day) ?? { day, calls: 0, prompt: 0, fixed: 0 }
        row.calls += 1
        row.prompt += step.prompt
        row.fixed += session.fixed ? splitStep(step, session.fixed).fixed : 0
        days.set(day, row)
      }
    }
    const rowsOut = [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
    const fixed = rowsOut.reduce((sum, row) => sum + row.fixed, 0)
    out.fanout = {
      room: room.id,
      windowMinutes: FANOUT_WINDOW / 60_000,
      messages: messages.length,
      members: members.length,
      bots: { p50: percentile(bots, 0.5), p90: percentile(bots, 0.9), max: Math.max(0, ...bots) },
      turns: { p50: percentile(turns, 0.5), p90: percentile(turns, 0.9), max: Math.max(0, ...turns) },
      days: rowsOut,
      fixedPerMessage: messages.length === 0 ? 0 : fixed / messages.length,
    }
    lines.push(`${room.id}: ${integer(messages.length)} user messages; ${integer(members.length)} member Sessions name it; window ${FANOUT_WINDOW / 60_000} minutes`)
    lines.push(`member Bots per message p50/p90/max ${percentile(bots, 0.5)}/${percentile(bots, 0.9)}/${Math.max(0, ...bots)}`)
    lines.push(`member turns per message p50/p90/max ${percentile(turns, 0.5)}/${percentile(turns, 0.9)}/${Math.max(0, ...turns)}`)
    lines.push('day         calls        prompt       fixed  fixed share')
    for (const row of rowsOut) {
      lines.push(`${row.day} ${String(row.calls).padStart(6)} ${integer(row.prompt).padStart(13)} ${integer(row.fixed).padStart(12)} ${(row.prompt > 0 ? row.fixed / row.prompt * 100 : 0).toFixed(1).padStart(11)}%`)
    }
    lines.push(`fixed block per user message: ${integer(fixed / messages.length)} tokens (${integer(fixed)} / ${integer(messages.length)} messages)`)
  }
  lines.push('')

  // §8: retries and attempts — how many, and how many attempts ever reported usage.
  const retryDays = new Map()
  const row = (time) => {
    const day = dayOf(time)
    const found = retryDays.get(day) ?? { day, retries: 0, attempts: 0, used: 0 }
    retryDays.set(day, found)
    return found
  }
  for (const session of sessions) {
    for (const retry of session.retries) row(retry.time).retries += 1
    for (const attempt of session.attempts) {
      const found = row(attempt.time)
      found.attempts += 1
      const usage = attempt.usage ?? {}
      if (['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'].some((key) => Number.isFinite(usage[key]) && usage[key] > 0)) found.used += 1
    }
  }
  const retryRows = [...retryDays.values()].sort((a, b) => a.day.localeCompare(b.day))
  out.retries = retryRows
  lines.push('## Retries')
  lines.push('day         llm/retry   attempts  attempts with non-zero usage')
  for (const values of retryRows) {
    lines.push(`${values.day} ${String(values.retries).padStart(9)} ${String(values.attempts).padStart(10)} ${String(values.used).padStart(27)}`)
  }

  if (flags.json) {
    console.log(JSON.stringify(out, null, 2))
    return
  }
  for (const line of lines) console.log(line)
}

function main(argv) {
  const flags = parseArgs(argv)
  const root = flags.sessions === null ? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions') : flags.sessions
  let files
  try {
    statSync(root)
    files = findSessionFiles(resolve(root))
  } catch {
    die(`no session root at ${resolve(root)}`)
  }
  if (files.length === 0) die(`no session.v4.jsonl.zstd under ${resolve(root)}`)
  const sessions = []
  for (const file of files) {
    const id = sessionIdFromPath(file)
    if (flags.session !== null && !id.startsWith(flags.session)) continue
    const { events, text } = decodeSession(file)
    const folded = foldSessionEvents(events)
    if (folded.steps.length === 0) continue
    sessions.push({ id, file, text, ...folded, fixed: fitFixed(folded.steps) })
  }
  if (sessions.length === 0) die('no Session in the sample carried a provider usage report')
  const rows = []
  for (const session of sessions) {
    if (!session.fixed) continue
    for (const turn of session.turns) {
      const steps = session.steps.filter((step) => step.turn === turn.turn)
      const total = { prompt: 0, fixed: 0, history: 0, tool: 0, task: 0 }
      for (const step of steps) total.prompt += step.prompt
      for (const step of steps) {
        const split = splitStep(step, session.fixed)
        total.fixed += split.fixed
        total.task += split.task
        total.history += split.history
        total.tool += split.tool
      }
      const calls = steps.length
      if (calls === 0) continue
      rows.push({
        session: session.id,
        turn: turn.turn,
        day: localDay(turn.first.time, flags.tz),
        calls,
        prompt: total.prompt,
        output: turn.output,
        toolAdded: steps.at(-1).chars.tool,
        toolCount: session.toolCount?.get(turn.turn) ?? 0,
        addedByName: session.toolAddedByName?.get(turn.turn) ?? {},
        largestTool: session.largestTool?.get(turn.turn) ?? 0,
        toolTotal: session.toolTotal?.get(turn.turn) ?? 0,
        fixed: total.fixed,
        history: total.history,
        tool: total.tool,
        task: total.task,
        first: steps[0].prompt,
        last: steps.at(-1).prompt,
        max: Math.max(...steps.map((step) => step.prompt)),
        fit: session.fixed,
        systemChars: session.systemChars,
        toolsChars: session.toolsChars,
        steps,
        toolNames: (() => {
          const names = new Map()
          for (const step of steps) for (const [name, chars] of Object.entries(step.toolCharsByName ?? {})) names.set(name, (names.get(name) ?? 0) + chars)
          return names
        })(),
      })
    }
  }
  const fits = sessions.map((session) => session.fixed).filter(Boolean)
  const median = (values) => (values.length === 0 ? 0 : values.slice().sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)])
  if (flags.days) {
    const days = new Map()
    for (const session of sessions) {
      for (const step of session.steps) {
        const day = localDay(step.time, flags.tz)
        const row = days.get(day) ?? { day, calls: 0, prompt: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, fixed: 0 }
        row.calls += 1
        row.prompt += step.prompt
        row.input += step.input
        row.cacheRead += step.cacheRead
        row.cacheWrite += step.cacheWrite
        row.output += step.output
        row.fixed += session.fixed ? splitStep(step, session.fixed).fixed : 0
        days.set(day, row)
      }
    }
    const rowsOut = [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
    if (flags.json) {
      console.log(JSON.stringify({ sample: { root: resolve(root), sessions: sessions.length, tz: flags.tz }, days: rowsOut }, null, 2))
      return
    }
    console.log(`sample: ${sessions.length} Sessions under ${resolve(root)}, zone ${flags.tz}`)
    console.log(`Sessions with a fixed-block fit: ${fits.length}; fixed tokens p50 ${integer(median(fits.map((fit) => fit.fixedTokens)))}`)
    console.log('')
    console.log('day         calls        prompt   fresh input    cache read   cache write       output  fixed share')
    for (const row of rowsOut) {
      console.log(`${row.day} ${String(row.calls).padStart(6)} ${integer(row.prompt).padStart(13)} ${integer(row.input).padStart(13)} ${integer(row.cacheRead).padStart(13)} ${integer(row.cacheWrite).padStart(13)} ${integer(row.output).padStart(12)} ${(row.fixed / row.prompt * 100).toFixed(1).padStart(11)}%`)
    }
    return
  }
  if (flags.stats) {
    printStats({ flags, sessions, rows, root })
    return
  }
  if (rows.length === 0) die('no turn in the sample could be split (every Session needs 8 calls)')
  if (flags.turn !== null) {
    const only = rows.filter((row) => row.turn === flags.turn)
    if (only.length === 0) die(`no turn ${flags.turn} in the sample`)
    rows.length = 0
    rows.push(...only)
  }
  rows.sort((a, b) => b.prompt - a.prompt)
  const top = rows.slice(0, flags.top)
  if (flags.json) {
    console.log(JSON.stringify({ sample: { root: resolve(root), sessions: sessions.length, tz: flags.tz }, turns: top.map((row) => ({ ...row, steps: undefined, toolNames: undefined, fit: row.fit })) }, null, 2))
    return
  }
  console.log(`sample: ${sessions.length} Sessions under ${resolve(root)}, zone ${flags.tz}`)
  console.log('')
  console.log('## Fixed block per call (measured: the intercept of each Session\'s prompt fit)')
  // A Session whose prompt falls as its messages grow has a fixed block but no
  // characters-per-token figure; the median is taken over the Sessions that have one.
  const perToken = fits.map((fit) => fit.charsPerToken).filter((value) => Number.isFinite(value))
  console.log(`Sessions with a fit: ${fits.length}; fixed tokens p50 ${integer(median(fits.map((fit) => fit.fixedTokens)))}; `
    + `fixed chars p50 ${integer(median(fits.map((fit) => fit.fixedChars)))} (first call's surface); `
    + `message chars/token p50 ${perToken.length === 0 ? 'n/a' : median(perToken).toFixed(2)}; `
    + `R2 p50 ${median(fits.map((fit) => fit.r2)).toFixed(3)}`)
  console.log('')
  console.log('## Top turns by prompt')
  console.log('session                          turn  calls   prompt   fixed  history    tool    task   first     last      max')
  for (const row of top) {
    const share = (value) => `${(value / row.prompt * 100).toFixed(1)}%`
    console.log(`${row.session.padEnd(32)} ${String(row.turn).padStart(4)} ${String(row.calls).padStart(6)} ${integer(row.prompt).padStart(8)} `
      + `${share(row.fixed).padStart(7)} ${share(row.history).padStart(7)} ${share(row.tool).padStart(7)} ${share(row.task).padStart(7)} `
      + `${integer(row.first).padStart(8)} ${integer(row.last).padStart(8)} ${integer(row.max).padStart(8)}`)
  }
  const first = top[0]
  if (first) {
    console.log('')
    // §4 of the report is the turn's LAST call, not its first: the surface grows inside a
    // turn, so the two are not interchangeable.
    const surface = first.steps.at(-1)
    const surfaceChars = surface.systemChars + surface.toolsChars
    console.log(`## Turn ${first.turn} of ${first.session}: the turn's last call's surface`)
    console.log(`system prompt ${integer(surface.systemChars)} chars; tool schemas ${integer(surface.toolsChars)} chars; `
      + `fixed block ${integer(first.fit.fixedTokens)} tokens (${(surfaceChars / first.fit.fixedTokens).toFixed(2)} chars/token)`)
    console.log(`calls ${first.calls}; provider prompt ${integer(first.prompt)} tokens (${integer(first.prompt / first.calls)} per call); output ${integer(first.output)} tokens`)
    console.log(`tool text added by the turn ${integer(first.toolTotal)} chars; still on the last call's surface ${integer(first.toolAdded)} chars; largest single result ${integer(first.largestTool)} chars`)
    if (first.toolNames.size > 0) {
      console.log(`tool text read again on every call, by tool: ${[...first.toolNames].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, chars]) => `${name} ${integer(chars)} chars`).join(', ')}`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
