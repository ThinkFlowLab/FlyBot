// What a group turn shows the model of the room (#1203). The log on disk stays
// whole. The turn gets a newer-first slice under a character budget, and a long
// status essay is collapsed so it cannot fill that slice. Progress for the open
// job is a compact board snapshot in the same turn, not those essays.
import { compareForWork, progressOf } from '../shared/task-board.js'

// Characters, not a tokenizer. The essays this was measured on are mostly CJK,
// about one token per character, so a character ceiling is the conservative one:
// English fits fewer tokens than this, never more.
export const ROOM_CONTEXT_BUDGET = 4000

// A bot line shorter than this is a handoff or a question, not an essay.
const STATUS_MIN = 400

const TERMINAL = new Set(['accepted', 'cancelled', 'failed'])

// Two of these in a long bot line is CI / merge / review narration. A work
// assignment that only cites an issue number stays whole.
const STATUS_HINTS = [
  /merge[_ -]?group/i,
  /tests-ok/i,
  /\benqueue/i,
  /\bmergeable\b/i,
  /\bCI\b/,
  /\bPASS\b/,
  /Verdict/i,
  /全绿/,
  /入队/,
  /合入/,
  /队列/,
  /\b[0-9a-f]{7,40}\b/,
]

const oneLine = (value, max) => {
  let flat = ''
  for (const char of String(value ?? '')) {
    const code = char.codePointAt(0)
    flat += code < 0x20 || code === 0x7f || char === '<' || char === '>' ? ' ' : char
  }
  flat = flat.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

export function statusShaped(text) {
  const body = String(text ?? '')
  if (body.length < STATUS_MIN) return false
  let hits = 0
  for (const hint of STATUS_HINTS) if (hint.test(body)) hits += 1
  return hits >= 2
}

const DRIVING_STATUS = new Set(['open', 'claimed', 'working', 'blocked', 'result-ready'])

// A bare acknowledgement. Anything that asks for work stays a turn.
const CUE_ACK = /^(done|ok|okay|noted|shipped|passed|继续|好了|完成|已完成|搞定|收到)[.!。！]?$/i

const foldCue = (value) => String(value ?? '')
  .replace(/@[^\s@,，。]{1,40}/g, ' ')
  .replace(/\p{P}+/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()

// A Bot @ is already on the board when this member has an open card in the room
// and the whole line, with @names and punctuation folded out, is already in that
// card (#1205). A title that only begins a new instruction is not covered.
// A question is never covered: that line is the one short ask a person may need.
export function boardCoversCue(tasks, { roomId, botId, text } = {}) {
  if (!roomId || !botId) return false
  const cards = Object.values(tasks ?? {}).filter(task =>
    task?.origin?.roomId === roomId
    && task.ownerBotId === botId
    && task.kind !== 'group'
    && task.waitingFor !== 'input'
    && DRIVING_STATUS.has(task.status))
  if (cards.length === 0) return false
  const line = String(text ?? '')
  if (/[?？]/.test(line)) return false
  if (statusShaped(line)) return true
  const body = foldCue(line)
  if (body.length === 0 || CUE_ACK.test(body)) return true
  const hay = foldCue(cards.map(task => `${task.title ?? ''} ${task.note ?? ''}`).join('\n'))
  return body.length >= 8 && hay.includes(body)
}

// The first hundred characters, plus up to four @names, so a call is still visible
// after the essay is gone. The character count is the length before the cut.
export function compactStatus(text) {
  const flat = oneLine(text, 100000)
  const mentions = [...new Set([...flat.matchAll(/@[^\s@,，。]{1,40}/g)].map(match => match[0]))].slice(0, 4)
  const head = flat.slice(0, 100).trim()
  const more = flat.length > 100 ? '…' : ''
  const called = mentions.length > 0 ? ` ${mentions.join(' ')}` : ''
  return `[status on the board, ${flat.length} chars] ${head}${more}${called}`
}

// Bot speech only. A person's line, and a short line, stay as stored. The log
// object is not modified: a collapsed line is a copy.
export function prepareRoomLine(line) {
  if (line == null || typeof line !== 'object') return line
  if (line.kind || line.botId === undefined || typeof line.text !== 'string') return line
  if (!statusShaped(line.text)) return line
  return { ...line, text: compactStatus(line.text) }
}

// Newest line first until `budget` characters of rendered text. A line that does
// not fit is skipped, so a short older line can still land when a long one
// between them cannot. One line longer than the budget is clipped to it.
export function fitRoomLines(lines, { budget = ROOM_CONTEXT_BUDGET, render, prepare = line => line } = {}) {
  const source = Array.isArray(lines) ? lines : []
  const kept = []
  let used = 0
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const line = prepare(source[index])
    let text = String(render(line))
    const gap = kept.length > 0 ? 1 : 0
    if (kept.length > 0 && used + gap + text.length > budget) continue
    if (used + gap + text.length > budget) {
      const room = budget - used - gap
      if (room < 48) break
      text = `${text.slice(0, room - 1)}…`
      kept.push({ line, text })
      break
    }
    used += gap + text.length
    kept.push({ line, text })
  }
  kept.reverse()
  return {
    entries: kept,
    text: kept.map(item => item.text).join('\n'),
    omitted: source.length - kept.length,
  }
}

function cardLine(task, nameOf) {
  const who = oneLine(typeof nameOf === 'function' ? nameOf(task) : '', 40) || 'unassigned'
  const title = oneLine(task.title || '(untitled)', 80)
  const status = oneLine(task.status || 'open', 24)
  const pct = typeof task.progress === 'number' && Number.isFinite(task.progress) ? ` ${progressOf(task)}%` : ''
  const wait = task.waitingFor === 'input' ? ' waiting' : ''
  const note = task.note ? ` — ${oneLine(task.note, 80)}` : ''
  return `${who} [${status}${pct}${wait}] ${title}${note}`
}

// Open cards for one room: the newest overall task, then its subtasks and any
// room card that is not under a different overall task. Done cards stay off.
export function formatRoomBoard(tasks, { roomId, nameOf, limit = 8 } = {}) {
  if (!roomId) return ''
  const open = Object.values(tasks ?? {}).filter(task => task && task.origin?.roomId === roomId && !TERMINAL.has(task.status))
  if (open.length === 0) return ''
  const overall = open.filter(task => task.kind === 'group').sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
  const cards = []
  if (overall) cards.push({ task: overall, indent: '' })
  for (const task of open.filter(item => item !== overall && item.kind !== 'group').sort(compareForWork)) {
    if (cards.length >= limit) break
    if (overall && task.parentId && task.parentId !== overall.id) continue
    cards.push({ task, indent: overall && task.parentId === overall.id ? '  ' : '' })
  }
  if (cards.length === 0) return ''
  const lines = ['Task board (assign, claim, and progress live here; update it with track_tasks, do not restate it in chat):']
  for (const { task, indent } of cards) lines.push(`${indent}- ${cardLine(task, nameOf)}`)
  const hidden = open.length - cards.length
  if (hidden > 0) lines.push(`- ${hidden} more open card(s) not shown`)
  return lines.join('\n')
}
