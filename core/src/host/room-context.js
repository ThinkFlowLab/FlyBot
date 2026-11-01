// What a group turn shows the model of the room (#1203). Both writers of the
// log store the same stub these turns show (#1251), and a fenced peer line is
// collapsed inside its wrap, never through it. The turn gets a newer-first slice
// under a character budget, and a long status essay is collapsed so it cannot
// fill that slice. Progress for the open job is a compact board snapshot in the
// same turn, not those essays.
import { columnOf, compareForWork, progressOf } from '../shared/task-board.js'
import { cut } from '../shared/text-boundary.js'
import { fenceUntrusted } from './delivery.js'

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
  return `${cut(flat, Math.max(0, max - 1)).text}…`
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
  const head = cut(flat, 100).text.trim()
  const more = flat.length > 100 ? '…' : ''
  const called = mentions.length > 0 ? ` ${mentions.join(' ')}` : ''
  return `[status on the board, ${flat.length} chars] ${head}${more}${called}`
}

// A room line a writer has already wrapped for another home's Bot (#98): the opener, the sender it
// names, and the inner text.
const FENCED_LINE = /^<untrusted-message from="([^"]*)">\n?([\s\S]*?)\n?<\/untrusted-message>$/

// Bot speech only. A person's line, and a short line, stay as stored. The log
// object is not modified: a collapsed line is a copy.
export function prepareRoomLine(line) {
  if (line == null || typeof line !== 'object') return line
  if (typeof line.text !== 'string') return line
  // A line a writer already fenced for another home's Bot keeps its fence, and while it is fenced
  // neither `kind` nor `authorKind` is an exemption: both travel from the other home
  // (room-membership.js copies them), so a peer could otherwise mark an essay `notice` or type it as a
  // person and store it whole. `compactStatus` flattens `<` and `>` on purpose (#98 review), so the
  // stub goes back inside the same wrap — one rule for both writers of the log (#1251).
  const fenced = line.text.match(FENCED_LINE)
  if (fenced) {
    if (!statusShaped(fenced[2])) return line
    return { ...line, text: fenceUntrusted(fenced[1], compactStatus(fenced[2])) }
  }
  // Unfenced lines are this home's own: only Bot speech is a status essay, and a person's long line is
  // stored whole. A short line stays as stored too.
  if (line.kind || line.botId === undefined) return line
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
      text = `${cut(text, room - 1).text}…`
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

// How long an item has waited (#1247). Same shape as the presence age: minutes, then hours,
// then days — one compact token, because it rides inside the card's bracket.
const ageLabel = (ms) => {
  const minutes = Math.max(0, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

// An unclaimed queue item has no holder yet, so the card says `unassigned` and carries which
// role it is queued for and how long it has waited (#1247) — the same card line the board
// already had, with the queue's two extra facts in the bracket.
function cardLine(task, nameOf, now) {
  const queued = Boolean(task.queueRole) && !task.claimedBy
  const who = queued ? 'unassigned' : oneLine(typeof nameOf === 'function' ? nameOf(task) : '', 40) || 'unassigned'
  const title = oneLine(task.title || '(untitled)', 80)
  const status = oneLine(task.status || 'open', 24)
  const pct = typeof task.progress === 'number' && Number.isFinite(task.progress) ? ` ${progressOf(task)}%` : ''
  const wait = task.waitingFor === 'input' ? ' waiting' : ''
  const created = Number.isFinite(task.createdAt) ? task.createdAt : now
  const queue = queued ? ` ${ageLabel(now - created)} ${oneLine(task.queueRole, 24)}` : ''
  const note = task.note ? ` — ${oneLine(task.note, 80)}` : ''
  return `${who} [${status}${pct}${wait}${queue}] ${title}${note}`
}

// One line per role that has something waiting: depth and the age of the oldest item, so
// starvation is visible without reading every card (#1247). A role with nothing waiting is
// omitted; the count is unclaimed items only, because a claimed one is already a card above.
function queueLines(open, now) {
  const roles = new Map()
  for (const task of open) {
    if (!task.queueRole || task.claimedBy) continue
    const role = oneLine(task.queueRole, 24)
    const key = role.toLowerCase()
    const entry = roles.get(key) ?? { role, count: 0, oldest: now }
    entry.count += 1
    entry.oldest = Math.min(entry.oldest, Number.isFinite(task.createdAt) ? task.createdAt : now)
    roles.set(key, entry)
  }
  return [...roles.values()]
    .sort((a, b) => a.role.localeCompare(b.role))
    .map(entry => `- Queue ${entry.role}: ${entry.count} waiting, oldest ${ageLabel(now - entry.oldest)}`)
}

// Open cards for one room: the newest overall task, then its subtasks and any
// room card that is not under a different overall task. Done cards stay off.
export function formatRoomBoard(tasks, { roomId, nameOf, limit = 8, now = Date.now() } = {}) {
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
  for (const { task, indent } of cards) lines.push(`${indent}- ${cardLine(task, nameOf, now)}`)
  const hidden = open.length - cards.length
  if (hidden > 0) lines.push(`- ${hidden} more open card(s) not shown`)
  lines.push(...queueLines(open, now))
  return lines.join('\n')
}

// Who is on what, read from the board at the moment the turn is built (#1213). Members
// followed the rule — claim the card, update it, say nothing — and the room became
// unreadable: silence meant "idle" only because nothing rendered the board's holders.
// One line per member who holds an open card in THIS room, one line per member who does
// not, so "nobody is working" is readable too. Read-only: no write, no message, no
// heartbeat. Columns, progress and age only — never CI, the queue or a verdict, which
// #1203 keeps off the chat.
export const ROOM_PRESENCE_BUDGET = 400
const PRESENCE_MEMBERS = 8
const OPEN_STATES = new Set(['open', 'claimed', 'working', 'blocked', 'result-ready'])

const columnWord = column => (column === 'in-progress' ? 'in progress' : column === 'not-started' ? 'not started' : column)
const minutesBetween = (from, now) => Math.max(0, Math.round((now - from) / 60000))

// `- Dev2 — #1081 title (in progress 15%, open 27 min)`: the card's own fields, flattened
// to one line. A 0% card says `just claimed` instead of a percentage, and a tag is
// counted from `createdAt` — the fields the record already has, no new one.
function presenceLine(task, name, now, extra = 0) {
  const ref = typeof task.target?.number === 'number' ? `#${task.target.number} ` : ''
  const title = oneLine(task.title || '(untitled)', 60)
  const waiting = task.waitingFor === 'input'
  const head = waiting ? 'waiting on an answer' : columnWord(columnOf(task))
  const pct = progressOf(task)
  const detail = waiting ? '' : pct > 0 ? ` ${pct}%` : ', just claimed'
  const created = Number.isFinite(task.createdAt) ? task.createdAt : now
  const open = `open ${minutesBetween(created, now)} min`
  const moved = Number.isFinite(task.updatedAt) && task.updatedAt - created >= 60000
    ? `, moved ${minutesBetween(task.updatedAt, now)} min ago`
    : ''
  const more = extra > 0 ? ` +${extra} more` : ''
  return `- ${name} — ${ref}${title} (${head}${detail}, ${open}${moved})${more}`
}

export function formatRoomPresence(tasks, { roomId, members, now = Date.now(), nameOf } = {}) {
  if (!roomId) return ''
  const list = (members ?? []).filter(member => member && member.id !== undefined)
  if (list.length === 0) return ''
  const nameOfMember = member => oneLine(typeof nameOf === 'function' ? nameOf(member) : (member.name ?? member.id), 40) || String(member.id)
  const cardsOf = new Map()
  for (const task of Object.values(tasks ?? {})) {
    if (!task || task.origin?.roomId !== roomId || !OPEN_STATES.has(task.status)) continue
    if (task.ownerBotId === undefined) continue
    const cards = cardsOf.get(task.ownerBotId) ?? []
    cards.push(task)
    cardsOf.set(task.ownerBotId, cards)
  }
  const holders = list.filter(member => cardsOf.has(member.id))
  if (holders.length === 0) return 'Who is working: nobody (no open card).'
  const built = []
  for (const member of holders) {
    const cards = cardsOf.get(member.id).sort(compareForWork)
    built.push(presenceLine(cards[0], nameOfMember(member), now, cards.length - 1))
  }
  for (const member of list.filter(item => !cardsOf.has(item.id))) built.push(`- ${nameOfMember(member)} — idle (no open card)`)
  const header = 'Who is working (from the task board; nobody has to post here):'
  const render = count => [header, ...built.slice(0, count), built.length > count ? `- +${built.length - count} more member(s)` : ''].filter(Boolean)
  let count = Math.min(PRESENCE_MEMBERS, built.length)
  let lines = render(count)
  while (count > 1 && lines.join('\n').length > ROOM_PRESENCE_BUDGET) {
    count -= 1
    lines = render(count)
  }
  return lines.join('\n')
}
