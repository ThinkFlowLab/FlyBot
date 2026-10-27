// Agent inbox, step 1 (#349): one list of what needs me, what is in progress and what is
// done across my own Bots, opened from the Inbox row at the top of the sidebar. Built
// only from data the client already has: the work snapshot's approvals and running
// turns, the held-message counts on chats, the Bot chats' last activity and the task
// records (src/host/tasks.js), and the ended turns the finish/fail notifications use
// (work.ended, #353) for failed turns (#471). A tool approval the inbox can answer uses
// the same answer the group chat's card gives (actions.answerApproval). An ask_user card,
// in a group or in the Bot's own chat, and a task waiting on an answer are answered
// here too (#1140). A held Bot message is still approved in its chat, so that card only has Open.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { BotAvatar, RoomAvatar } from './mark.js'
import { CloseIcon } from './icons.js'
import { workPhrase } from './cells.js'
import { elapsedLabel } from './activity-row.js'
import { useEscape } from './overlay-hooks.js'
import { alwaysChoices } from './member-status.js'
import { currentPart, previewOf, relativeShort } from './text.js'
import { hostText, t } from './i18n.js'
import { failureSentence } from '../shared/failure-copy.js'

// Done (and a failed task) ages out after 7 days.
export const KEEP_MS = 7 * 86_400_000
const POLL_MS = 30_000
const DONE_MAX = 20
const FEEDBACK_MS = 5000

const line = d => h('path', { d })
const icon = (...paths) => function StatusIcon() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, paths.map(line))
}
const RING = 'M10 3.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5z'
export const InboxIcon = icon('M3.5 11.5l1.9-6.1A1.5 1.5 0 0 1 6.83 4.35h6.34a1.5 1.5 0 0 1 1.43 1.05l1.9 6.1', 'M3.5 11.5v3.25a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V11.5', 'M3.5 11.5h3.75l1 1.75h3.5l1-1.75h3.75')
const AskIcon = icon(RING, 'M10 6.75v3.75', 'M10 13.25h.01')
const HeldIcon = icon(RING, 'M10 6.5V10l2.25 1.5')
const QuestionIcon = icon(RING, 'M8.1 8a2 2 0 1 1 2.65 1.9c-.45.18-.75.6-.75 1.1v.25', 'M10 13.5h.01')
const ResultIcon = icon(RING, 'M7 10.25l2 2 4-4.25')
const FailedIcon = icon(RING, 'M7.75 7.75l4.5 4.5M12.25 7.75l-4.5 4.5')
const RunIcon = icon(RING, 'M8.5 7.25v5.5l4.25-2.75z')
const DoneIcon = icon('M4.5 10.5l3.5 3.5 7.5-8')
const CancelledIcon = icon(RING, 'M5.25 14.75l9.5-9.5')

// Every card has exactly one status: a tone (its color), an icon and a word, so the
// color never says it alone.
export const STATUSES = {
  approval: { label: 'Needs approval', tone: 'ask', Icon: AskIcon },
  held: { label: 'Waiting to send', tone: 'ask', Icon: HeldIcon },
  input: { label: 'Needs your answer', tone: 'ask', Icon: QuestionIcon },
  result: { label: 'Result ready', tone: 'ask', Icon: ResultIcon },
  failed: { label: 'Failed', tone: 'danger', Icon: FailedIcon },
  running: { label: 'Working', tone: 'run', Icon: RunIcon },
  task: { label: 'In progress', tone: 'run', Icon: RunIcon },
  done: { label: 'Done', tone: 'done', Icon: DoneIcon },
  cancelled: { label: 'Cancelled', tone: 'muted', Icon: CancelledIcon },
}

// The groups, in order. The words are fixed here so the row, the dialog and the docs agree.
export const GROUPS = [
  { id: 'needs', title: 'Needs you', empty: 'Nothing needs you right now.' },
  { id: 'progress', title: 'In progress', empty: 'Nothing is running.' },
  { id: 'done', title: 'Done', empty: 'Nothing finished in the last 7 days.' },
]

// One view of the task records for the row and the dialog; each asks again when it mounts.
let sharedTasks = []
const taskListeners = new Set()
function publishTasks(list) {
  sharedTasks = Array.isArray(list) ? list : []
  for (const listener of taskListeners) listener(sharedTasks)
}
export function useTasks(actions) {
  const [tasks, setTasks] = useState(sharedTasks)
  useEffect(() => {
    taskListeners.add(setTasks)
    let stopped = false
    let timer
    // #1252: the default read is active work only, but this inbox classifies finished and failed
    // cards too (Done, and Needs you after a failure). It asks for the archive so those rows reach
    // it; the board's own bounded read is a separate call.
    const load = () => Promise.resolve(actions?.tasks?.({ archive: true }))
      .then((list) => { if (!stopped && list !== undefined) publishTasks(list) })
      // A host that cannot list tasks (a reading host, an older core) shows none.
      .catch(() => {})
      .finally(() => { if (!stopped) timer = setTimeout(load, POLL_MS) })
    load()
    return () => { stopped = true; clearTimeout(timer); taskListeners.delete(setTasks) }
  }, [])
  return tasks
}

// My own Bots only: a friend's Bot, and on a shared host another member's, stay out (#349 step 1).
const ownBot = (roster, id) => {
  const bot = roster.byId?.[id]
  if (bot === undefined || bot.remote) return undefined
  const me = roster.self?.memberId
  return me && bot.ownerId && bot.ownerId !== me ? undefined : bot
}
// Every card names who assigned it, who answers for it and which Bot does it, so team
// views (phase 2) can filter without a new card shape. In step 1 the first two are me.
const people = (roster, botId) => ({ assigner: roster.self?.memberId ?? 'me', owner: roster.self?.memberId ?? 'me', executingBot: botId ?? null })
const roomName = (roster, id) => roster.roomsById?.[id]?.name
const placeOf = (roster, roomId) => (roomId && roomName(roster, roomId) ? t('in {name}', { name: roomName(roster, roomId) }) : '')
const lastWhy = task => [...(task.actors ?? [])].reverse().find(entry => typeof entry.why === 'string' && entry.why !== '')?.why ?? ''
const chatOfTask = task => task.origin?.roomId ?? task.origin?.sessionId ?? task.ownerBotId
// The Bot's own chat, when that session is where this ask_user card actually sits.
const ownAskChat = (roster, bot, text) => {
  if (bot === undefined || typeof text !== 'string' || text === '') return undefined
  for (const [key, question] of Object.entries(roster.questions ?? {})) {
    if (question == null || typeof question !== 'object' || roster.roomsById?.[key]) continue
    if (question.question !== text) continue
    if (key === bot.id || key === currentPart(bot)) return bot.id
  }
  return undefined
}
const placeKey = (botId, roomId) => `${botId}|${roomId ?? ''}`
// The Session a card's chat reads from: a group's own, a Bot's current part, else the id itself.
const partOf = (roster, chat) => (roster.roomsById?.[chat] || !roster.byId?.[chat] ? chat : currentPart(roster.byId[chat]))
// What a Bot runs in a place right now: its own chat's turn or its turn in that group.
const runningIn = (work, botId, roomId) => (roomId === undefined
  ? (work.bots?.[botId]?.roomId === undefined ? work.bots?.[botId] : undefined)
  : (work.rooms?.[roomId] ?? []).find(entry => entry.botId === botId) ?? (work.bots?.[botId]?.roomId === roomId ? work.bots[botId] : undefined))

// The card's one-line latest activity (#471): a task's newest note, else what its Bot runs
// there now (not for a card that waits for me), else that chat's last line. Left out when it
// only repeats the title or the reason.
function latestActivity(card, { roster, work, sessions }) {
  const options = []
  if (card.kind === 'task') options.push(lastWhy(card.task))
  if (card.kind === 'run' || card.kind === 'task') {
    const entry = card.executingBot ? runningIn(work, card.executingBot, roster.roomsById?.[card.chat] ? card.chat : undefined) : undefined
    if (entry) options.push(`${workPhrase(entry.tool)}…`)
  }
  if (sessions?.byId && card.chat) options.push(previewOf(sessions, partOf(roster, card.chat)))
  return options.find(text => typeof text === 'string' && text !== '' && text !== card.title && text !== card.reason) ?? ''
}

// The tool calls of the turn a card shows for its place (#471): the turn running there now,
// else the newest ended turn there. One place only — never added across places, and 0
// when that turn used no tool or the place has no count.
function toolCalls(card, { roster, work }) {
  const botId = card.bot?.id
  if (botId === undefined) return 0
  const roomId = roster.roomsById?.[card.chat] ? card.chat : undefined
  const running = runningIn(work, botId, roomId)
  if (running !== undefined) return running.calls ?? 0
  let newest
  for (const entry of work.ended ?? []) {
    if (entry.botId !== botId || (entry.roomId ?? '') !== (roomId ?? '')) continue
    if ((entry.at ?? 0) >= (newest?.at ?? -Infinity)) newest = entry
  }
  return newest?.calls ?? 0
}

/**
 * The three groups of cards, newest first in each.
 * `sessions` is the shell's Session list ({ byId }); `now` the current time.
 */
export function inboxModel({ roster, work = {}, tasks = [], sessions, now = Date.now() }) {
  const needs = []
  const progress = []
  const done = []
  const fresh = at => typeof at === 'number' && now - at <= KEEP_MS
  const waitingAt = new Set()
  for (const approval of work.approvals ?? []) {
    const bot = ownBot(roster, approval.botId)
    if (bot === undefined) continue
    waitingAt.add(`${approval.botId}|${approval.roomId ?? ''}`)
    needs.push({
      id: `approval:${approval.id}`, kind: 'approval', status: 'approval', bot, at: approval.at,
      title: [approval.tool, approval.detail?.text].filter(Boolean).join(' · ') || t('A tool call'),
      place: placeOf(roster, approval.roomId), reason: approval.reason ?? '',
      chat: approval.roomId ?? bot.id, approval, ...people(roster, bot.id),
    })
  }
  // ask_user cards (#1140). A group card sits on the room (#550). A card in the Bot's own
  // chat is keyed by that session, and Open must land there — a task handed out from a
  // group does not make the group the place the card is.
  for (const [key, question] of Object.entries(roster.questions ?? {})) {
    if (question == null || typeof question !== 'object') continue
    const room = roster.roomsById?.[key]
    const bot = room
      ? ownBot(roster, question.botId)
      : (roster.bots ?? []).find(candidate => ownBot(roster, candidate.id) && (candidate.id === key || currentPart(candidate) === key))
    if (bot === undefined) continue
    waitingAt.add(room ? `${bot.id}|${room.id}` : `${bot.id}|`)
    needs.push({
      id: `question:${question.id ?? key}`, kind: 'question', status: 'input', bot, ...(room ? { room } : {}), at: question.askedAt,
      title: question.question ?? '', reason: question.detail ?? '',
      place: room ? placeOf(roster, key) : '', chat: room ? key : bot.id, sessionId: key, question, ...people(roster, bot.id),
    })
  }
  // Messages a Bot wants to send wait for me in their chat; they are approved there (#349 decision).
  const held = (chat, count, extra) => needs.push({
    id: `held:${chat}`, kind: 'held', status: 'held', chat, at: undefined,
    title: count === 1 ? t('1 message waits for your approval') : t('{count} messages wait for your approval', { count }),
    hint: t('Approve it in the chat'), ...extra,
  })
  for (const bot of roster.bots ?? []) {
    const count = bot.pendingCount ?? 0
    if (count <= 0) continue
    if (bot.remote) held(bot.id, count, { bot, place: '', ...people(roster, null) })
    else if (ownBot(roster, bot.id)) held(bot.id, count, { bot, place: '', ...people(roster, bot.id) })
  }
  for (const room of roster.rooms ?? []) {
    const count = room.pendingCount ?? 0
    if (count > 0) held(room.id, count, { room, place: placeOf(roster, room.id), ...people(roster, null) })
  }
  // Turns running now: a Bot's own chat, and each group it works in.
  const seen = new Set()
  const running = (botId, entry, roomId) => {
    const bot = ownBot(roster, botId)
    const key = `${botId}|${roomId ?? ''}`
    if (bot === undefined || seen.has(key) || waitingAt.has(key)) return
    seen.add(key)
    progress.push({
      id: `run:${key}`, kind: 'run', status: 'running', bot, at: entry.since, since: entry.since,
      title: `${workPhrase(entry.tool)}…`, place: placeOf(roster, roomId), chat: roomId ?? bot.id, ...people(roster, bot.id),
    })
  }
  for (const [botId, entry] of Object.entries(work.bots ?? {})) running(botId, entry, entry.roomId)
  for (const [roomId, entries] of Object.entries(work.rooms ?? {})) for (const entry of entries) running(entry.botId, entry, roomId)
  // Failed turns (#471), from the ended turns the finish/fail notifications read (#353): a
  // failure needs me while it is the latest ended turn in its place (a Bot's own chat or one
  // group) and the Bot is not working or waiting there again. A later finished turn clears it.
  const lastEnded = new Map()
  for (const entry of work.ended ?? []) {
    const key = placeKey(entry.botId, entry.roomId)
    if ((entry.at ?? 0) >= (lastEnded.get(key)?.at ?? -Infinity)) lastEnded.set(key, entry)
  }
  for (const [key, entry] of lastEnded) {
    const bot = ownBot(roster, entry.botId)
    if (bot === undefined || entry.failed === undefined || !fresh(entry.at) || seen.has(key) || waitingAt.has(key)) continue
    const chat = entry.roomId ?? bot.id
    const asked = sessions?.byId ? previewOf(sessions, partOf(roster, chat)) : ''
    needs.push({
      id: `turn:${entry.id}`, kind: 'turn', status: 'failed', bot, at: entry.at,
      title: asked || t('The last turn did not finish'), reason: entry.failed,
      place: placeOf(roster, entry.roomId), chat, ...people(roster, bot.id),
    })
  }
  // Task records (#54).
  for (const task of tasks) {
    const bot = ownBot(roster, task.ownerBotId)
    if (bot === undefined) continue
    const askedIn = task.waitingFor === 'input' ? ownAskChat(roster, bot, task.inputRequest?.question) : undefined
    const card = {
      id: `task:${task.id}`, kind: 'task', bot, at: task.updatedAt, title: task.title || t('Untitled task'),
      place: placeOf(roster, task.origin?.roomId), chat: askedIn ?? chatOfTask(task), task, ...people(roster, task.workBotId ?? bot.id),
    }
    if (task.status === 'failed') { if (fresh(task.updatedAt)) needs.push({ ...card, status: 'failed', reason: lastWhy(task) }) }
    else if (task.status === 'result-ready') needs.push({ ...card, status: 'result', reason: task.result?.summary ?? '' })
    else if (task.status === 'blocked') needs.push({ ...card, status: task.waitingFor === 'input' ? 'input' : 'approval', reason: task.inputRequest?.question ?? '' })
    else if (task.status === 'open' || task.status === 'claimed' || task.status === 'working') progress.push({ ...card, status: 'task', since: task.createdAt })
    else if ((task.status === 'accepted' || task.status === 'cancelled') && fresh(task.updatedAt)) done.push({ ...card, status: task.status === 'accepted' ? 'done' : 'cancelled' })
  }
  // A Bot's chat whose last turn finished in the last 7 days, with its last line.
  if (sessions?.byId) {
    for (const bot of roster.bots ?? []) {
      if (ownBot(roster, bot.id) === undefined || work.bots?.[bot.id] !== undefined || waitingAt.has(`${bot.id}|`)) continue
      // Its last turn failed: that card is in Needs you.
      if (lastEnded.get(placeKey(bot.id))?.failed !== undefined) continue
      const part = currentPart(bot)
      const at = sessions.byId[part]?.updatedAt
      if (!fresh(at)) continue
      const text = previewOf(sessions, part)
      if (text === '') continue
      done.push({ id: `chat:${bot.id}`, kind: 'chat', status: 'done', bot, at, title: text, place: '', chat: bot.id, ...people(roster, bot.id) })
    }
  }
  const newest = (a, b) => (b.at ?? Infinity) - (a.at ?? Infinity)
  for (const card of [...needs, ...progress, ...done]) {
    card.activity = latestActivity(card, { roster, work, sessions })
    card.calls = toolCalls(card, { roster, work })
  }
  return { needs: needs.sort(newest), progress: progress.sort(newest), done: done.sort(newest).slice(0, DONE_MAX) }
}

// The row's badge: how many cards need me. The Done list needs no Session list for this.
export const needsCount = (roster, work, tasks, now) => inboxModel({ roster, work, tasks, now }).needs.length

// Cards the owner already answered leave the Needs you list. The dialog keeps that
// set until the next roster poll drops the underlying record.
export function visibleNeeds(model, answered) {
  return { ...model, needs: model.needs.filter(card => !answered?.[card.id]) }
}

// One inbox action clears one pending item: an ask_user card, a task waiting on
// an answer, or a policy approval the inbox already lists (#1140).
export function inboxAnswer(actions, card, choice) {
  if (card?.kind === 'question') {
    const reply = choice !== null && typeof choice === 'object' ? choice : {}
    const selected = Array.isArray(reply.selected) ? reply.selected.filter(item => typeof item === 'string' && item !== '') : []
    const custom = typeof reply.custom === 'string' ? reply.custom.trim() : ''
    if (selected.length === 0 && custom === '') return undefined
    return Promise.resolve(actions.answerQuestion(card.sessionId, card.question.id, { selected, custom }))
  }
  if (card?.kind === 'task' && card.status === 'input') {
    const text = typeof choice === 'string' ? choice.trim() : ''
    const questionId = card.task?.inputRequest?.id
    if (text === '' || typeof questionId !== 'string') return undefined
    return Promise.resolve(actions.answerTaskInput(card.task.id, questionId, text))
  }
  if (card?.kind === 'task' && card.status === 'result') {
    if (choice === 'accept') return Promise.resolve(actions.acceptTaskResult(card.task.id))
    const note = choice !== null && typeof choice === 'object' ? String(choice.note ?? '').trim() : ''
    if (note === '') return undefined
    return Promise.resolve(actions.sendBackTask(card.task.id, note))
  }
  if (card?.kind === 'approval' && card.approval?.answerable === true) {
    return Promise.resolve(actions.answerApproval(card.approval.id, choice))
  }
  return undefined
}

// One slot per card. A roster, work or clock poll re-renders the card; a fresh object
// each time would drop the text and the toggled options before Submit (#1140).
const answerSlots = new Map()
const answerSlot = (id) => {
  let slot = answerSlots.get(id)
  if (slot === undefined) {
    slot = { text: '', picked: [] }
    answerSlots.set(id, slot)
  }
  return slot
}

// The Done list is the acceptance surface (#401): a result card is accepted here, or sent back with a
// note that returns the same task to the Bot. The box opens in place, and the note survives a roster poll
// because the slot is keyed by the card, like the answer slot above (#1140).
const resultSlots = new Map()
const resultSlot = (id) => {
  let slot = resultSlots.get(id)
  if (slot === undefined) {
    slot = { open: false, text: '' }
    resultSlots.set(id, slot)
  }
  return slot
}

function ResultActions({ card, busy, onAnswer }) {
  const [, redraw] = useState(0)
  if (!(card.kind === 'task' && card.status === 'result')) return null
  const slot = resultSlot(card.id)
  const send = () => {
    const note = slot.text.trim()
    if (busy || note === '') return
    onAnswer(card, { note })
  }
  return h('span', { className: 'bt-inbox-result' },
    slot.open ? h('input', {
      type: 'text', className: 'bt-inbox-answer-text', value: slot.text, disabled: busy,
      'aria-label': t('What should change'), placeholder: t('What should change'),
      onChange: (event) => { slot.text = String(event.target?.value ?? ''); redraw(count => count + 1) },
      onKeyDown: (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
        event.preventDefault()
        send()
      },
    }) : null,
    slot.open
      ? h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy, onClick: send }, t('Send it back'))
      : h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { slot.open = true; redraw(count => count + 1) } }, t('Send back')),
    h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy, onClick: () => onAnswer(card, 'accept') }, t('Accept')))
}

// Options and a short answer, drawn inside the card so a click answers here.
function AnswerFields({ card, busy, onAnswer }) {
  const [, redraw] = useState(0)
  const question = card.kind === 'question'
  const taskInput = card.kind === 'task' && card.status === 'input' && typeof card.task?.inputRequest?.id === 'string'
  if (!question && !taskInput) return null
  const slot = answerSlot(card.id)
  const multi = question && card.question?.multiSelect === true
  const options = question && Array.isArray(card.question?.options) ? card.question.options : []
  const send = () => {
    if (busy) return
    const custom = slot.text.trim()
    if (question) {
      const selected = multi ? slot.picked.filter(label => label !== '') : []
      if (selected.length === 0 && custom === '') return
      onAnswer(card, { selected, custom })
      return
    }
    if (custom === '') return
    onAnswer(card, custom)
  }
  const choose = (label) => {
    if (busy) return
    // One choice sends at once. Several toggle, and Submit sends the set (#1140).
    if (!multi) {
      onAnswer(card, { selected: [label], custom: '' })
      return
    }
    slot.picked = slot.picked.includes(label) ? slot.picked.filter(item => item !== label) : [...slot.picked, label]
    redraw(count => count + 1)
  }
  return h('span', { className: 'bt-inbox-answer' },
    ...options.map((option, index) => h('button', {
      key: `${option.label}-${index}`, type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
      'aria-pressed': multi ? slot.picked.includes(option.label) : undefined,
      onClick: () => choose(option.label),
    }, option.label)),
    h('input', {
      type: 'text', className: 'bt-inbox-answer-text', value: slot.text, disabled: busy,
      'aria-label': t('Your own answer'), placeholder: t('Type your own answer'),
      onChange: (event) => { slot.text = String(event.target?.value ?? ''); redraw(count => count + 1) },
      onKeyDown: (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
        event.preventDefault()
        send()
      },
    }),
    h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy, onClick: send }, t('Submit')))
}

// The Inbox row at the top of the sidebar (owner decision 2026-10-20, option a).
export function InboxRow({ wide, useRoster, useWork, useUi, actions }) {
  const roster = useRoster(value => value)
  const work = useWork ? useWork(value => value) : {}
  const open = useUi ? useUi(value => Boolean(value.inbox)) : false
  const tasks = useTasks(actions)
  const count = needsCount(roster, work, tasks)
  const label = count > 0 ? t('Inbox, {count} need you', { count }) : t('Inbox')
  return h('button', {
    type: 'button', className: 'bt-row bt-inbox-row', 'aria-label': label, title: wide ? undefined : label,
    'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => actions.openInbox(),
  },
  h('span', { className: 'bt-inbox-mark' }, h(InboxIcon)),
  wide ? h('span', { className: 'bt-inbox-label' }, t('Inbox')) : null,
  count > 0 ? h('span', { className: 'bt-inbox-count', 'aria-hidden': true }, count > 99 ? '99+' : String(count)) : null)
}

function Status({ status }) {
  const { label, tone, Icon } = STATUSES[status]
  return h('span', { className: 'bt-inbox-status', 'data-tone': tone }, h(Icon), h('span', null, t(label)))
}

function whenText(card, now) {
  if (card.status === 'running' || card.status === 'task') {
    return typeof card.since === 'number' && now - card.since >= 60_000 ? t('for {time}', { time: elapsedLabel(now - card.since) }) : t('just started')
  }
  return typeof card.at === 'number' ? relativeShort(card.at) : ''
}

export function InboxCard({ card, roster, now, busy, error, onAnswer, onOpen }) {
  const who = card.bot ? card.bot.name : card.room?.name ?? ''
  const produced = card.kind === 'task' && card.status === 'result' ? [card.bot?.model] : []
  const meta = [who, ...produced, card.place, whenText(card, now)].filter(Boolean).join(' · ')
  const answerable = card.kind === 'approval' && card.approval?.answerable === true
  const evidence = card.kind === 'task' && card.status === 'result' ? (card.task?.result?.links ?? []) : []
  const sentBack = card.kind === 'task' && card.status === 'task' ? card.task?.followUp?.note : undefined
  // Where a decision is written back (#1154): the issue or PR the task came from is on the card, and
  // a comment that could not be posted says so once, on the card, instead of staying in a log. A
  // comment nobody posted within a day is `unconfirmed` (#1172): its own quiet line, not an error.
  const target = card.kind === 'task' ? card.task?.target?.href : undefined
  const writeBack = card.kind === 'task' && card.task?.writeBack?.state === 'failed' ? card.task.writeBack : undefined
  const unconfirmed = card.kind === 'task' && card.task?.writeBack?.state === 'unconfirmed' ? card.task.writeBack : undefined
  return h('div', { className: 'bt-inbox-card', role: 'group', 'aria-label': `${t(STATUSES[card.status].label)}: ${card.title}`, 'data-status': card.status },
    h('span', { className: 'bt-inbox-ava' }, card.bot ? h(BotAvatar, { bot: card.bot, size: 28, badge: false, live: false }) : card.room ? h(RoomAvatar, { room: card.room, roster, size: 28 }) : null),
    h('span', { className: 'bt-inbox-copy' },
      h('span', { className: 'bt-inbox-top' },
        h(Status, { status: card.status }),
        h('span', { className: 'bt-inbox-meta', title: meta }, meta)),
      h('span', { className: 'bt-inbox-title', title: card.title }, card.title),
      card.calls > 0 ? h('span', { className: 'bt-inbox-calls' }, t('{count} tool calls', { count: card.calls })) : null,
      card.reason ? h('span', { className: 'bt-inbox-reason', title: card.reason }, failureSentence(card.reason, t)) : null,
      card.activity ? h('span', { className: 'bt-inbox-activity', title: card.activity }, t('Latest: {text}', { text: card.activity })) : null,
      card.hint ? h('span', { className: 'bt-inbox-hint' }, card.hint) : null,
      evidence.length > 0 ? h('span', { className: 'bt-inbox-evidence' }, ...evidence.map((href, index) => h('a', {
        key: `${href}-${index}`, href, target: '_blank', rel: 'noreferrer noopener', className: 'bt-inbox-evidence-link', title: href,
      }, href))) : null,
      sentBack ? h('span', { className: 'bt-inbox-reason', title: sentBack }, t('Sent back: {note}', { note: sentBack })) : null,
      target ? h('span', { className: 'bt-inbox-evidence' }, h('a', {
        href: target, target: '_blank', rel: 'noreferrer noopener', className: 'bt-inbox-evidence-link bt-inbox-target', title: target,
      }, t('Comment goes to {target}', { target: target.replace(/^https:\/\/github\.com\//, '') }))) : null,
      writeBack ? h('span', { className: 'bt-inbox-writeback', role: 'alert', title: writeBack.error }, t('Could not comment on {target}: {error}', { target: writeBack.target, error: writeBack.error })) : null,
      unconfirmed ? h('span', { className: 'bt-inbox-writeback', title: unconfirmed.target }, t('Could not confirm the comment on {target} went out', { target: unconfirmed.target })) : null,
      h(AnswerFields, { card, busy, onAnswer }),
      h(ResultActions, { card, busy, onAnswer }),
      error ? h('span', { className: 'bt-inbox-error', role: 'alert' }, error) : null),
    h('span', { className: 'bt-inbox-actions' },
      answerable ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => onAnswer(card, 'reject') }, t('Reject')) : null,
      answerable ? h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled: busy, onClick: () => onAnswer(card, 'allow') }, t('Allow once')) : null,
      ...(answerable ? alwaysChoices(card.approval, card.bot) : []).map(([choice, label]) => h('button', { key: choice, type: 'button', className: 'bt-soft bt-soft-sm', 'data-choice': choice, disabled: busy, onClick: () => onAnswer(card, choice) }, t(label))),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', 'aria-label': who ? t('Open {name}', { name: card.room?.name ?? who }) : t('Open'), onClick: () => onOpen(card) }, t('Open'))))
}

function useNow(ms) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

export function InboxDialog({ roster, useWork, useSessions, actions, leaving = false }) {
  const work = useWork(value => value)
  const sessions = useSessions(value => value)
  const tasks = useTasks(actions)
  const now = useNow(30_000)
  // Answers just given: their cards leave at once, and one line says what happened.
  const [answered, setAnswered] = useState({})
  const [busy, setBusy] = useState('')
  const [errors, setErrors] = useState({})
  const [feedback, setFeedback] = useState('')
  const close = useCallback(() => actions.closeInbox(), [])
  useEscape(close)
  useEffect(() => {
    if (!feedback) return undefined
    const timer = setTimeout(() => setFeedback(''), FEEDBACK_MS)
    return () => clearTimeout(timer)
  }, [feedback])
  const model = inboxModel({ roster, work, tasks, sessions, now })
  const groups = visibleNeeds(model, answered)
  const answer = (card, choice) => {
    setBusy(card.id)
    setErrors(value => ({ ...value, [card.id]: '' }))
    const pending = inboxAnswer(actions, card, choice)
    if (pending === undefined) {
      setBusy('')
      return
    }
    void Promise.resolve(pending)
      .then(() => {
        setAnswered(value => ({ ...value, [card.id]: true }))
        const name = card.bot?.name ?? ''
        setFeedback(card.kind === 'approval'
          ? (choice === 'allow' ? t('Allowed once for {name}', { name })
            : choice === 'always-bot' ? t('Always allowed for {name}', { name })
              : choice === 'always-room' ? t('Always allowed in this group') : t('Rejected for {name}', { name }))
          : t('Answered'))
      }, failure => setErrors(value => ({ ...value, [card.id]: hostText(failure?.message ?? String(failure)) })))
      .finally(() => setBusy(''))
  }
  const open = (card) => {
    actions.closeInbox()
    actions.openSession(card.chat)
  }
  return h('div', { className: 'bt-mem-layer bt-inbox-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim bt-mem-scrim', onMouseDown: close }),
    h('div', { className: 'bt-mem bt-inbox', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'bt-inbox-heading' },
      h('div', { className: 'bt-mem-head' },
        h('h2', { id: 'bt-inbox-heading' }, t('Inbox')),
        h('span', { className: 'bt-mem-status' }, t('Your Bots')),
        h('span', { className: 'bt-mem-head-gap' }),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close inbox'), autoFocus: true, onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-mem-body bt-inbox-body' },
        h('div', { className: 'bt-inbox-feedback', role: 'status', 'aria-live': 'polite' }, feedback),
        GROUPS.map(group => h('section', { key: group.id, className: 'bt-inbox-group', 'aria-labelledby': `bt-inbox-${group.id}` },
          h('h3', { id: `bt-inbox-${group.id}`, className: 'bt-inbox-head' },
            h('span', null, t(group.title)),
            groups[group.id].length > 0 ? h('span', { className: 'bt-inbox-head-count' }, String(groups[group.id].length)) : null),
          groups[group.id].length === 0
            ? h('p', { className: 'bt-inbox-empty' }, t(group.empty))
            : h('div', { className: 'bt-inbox-list' }, groups[group.id].map(card => h(InboxCard, {
                key: card.id, card, roster, now, busy: busy === card.id, error: errors[card.id], onAnswer: answer, onOpen: open,
              }))))))))
}

export const INBOX_CSS = `
.bt-inbox-row{min-height:40px;padding:6px 8px;gap:10px}
.bt-inbox-mark{flex:none;width:36px;height:28px;display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink-2)}
.bt-inbox-mark svg{width:18px;height:18px}
.bt-inbox-label{flex:1 1 auto;min-width:0;font-size:14px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-inbox-count{flex:none;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);font-size:11.5px;line-height:20px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums;box-sizing:border-box}
.bt-rail .bt-inbox-row{position:relative}
.bt-rail .bt-inbox-count{position:absolute;top:2px;right:calc(50% - 22px);min-width:16px;height:16px;padding:0 4px;font-size:10px;line-height:16px;box-shadow:0 0 0 1.5px var(--bt-sidebar)}
.bt-inbox-body{gap:18px}
.bt-inbox-feedback{min-height:0;font-size:13px;line-height:18px;color:var(--bt-ink-2)}
.bt-inbox-feedback:empty{display:none}
.bt-inbox-group{display:flex;flex-direction:column;gap:8px}
.bt-inbox-head{display:flex;align-items:center;gap:6px;margin:0;font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink-2)}
.bt-inbox-head-count{font-weight:500;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-inbox-empty{margin:0;font-size:13px;line-height:18px;color:var(--bt-ink-3)}
.bt-inbox-list{display:flex;flex-direction:column;gap:6px}
.bt-inbox-card{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:.5px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card,var(--bt-main))}
.bt-inbox-card:focus-within{box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent) 35%,transparent)}
.bt-inbox-ava{flex:none;line-height:0;padding-top:2px}
.bt-inbox-copy{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-inbox-top{display:flex;align-items:center;gap:8px;min-width:0}
.bt-inbox-status{flex:none;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px 0 5px;border-radius:999px;font-size:11.5px;line-height:20px;font-weight:600;white-space:nowrap}
.bt-inbox-status svg{flex:none}
.bt-inbox-status[data-tone=ask]{background:color-mix(in srgb,var(--bt-star) 18%,transparent);color:color-mix(in srgb,var(--bt-star) 70%,var(--bt-ink))}
.bt-inbox-status[data-tone=danger]{background:rgba(224,33,53,.12);color:#c21d2e}
.bt-inbox-status[data-tone=run]{background:color-mix(in srgb,var(--bt-accent) 14%,transparent);color:color-mix(in srgb,var(--bt-accent) 80%,var(--bt-ink))}
.bt-inbox-status[data-tone=done]{background:color-mix(in srgb,var(--bt-green) 16%,transparent);color:color-mix(in srgb,var(--bt-green) 70%,var(--bt-ink))}
.bt-inbox-status[data-tone=muted]{background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-inbox-meta{min-width:0;font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-inbox-title{font-size:13.5px;line-height:19px;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-inbox-reason,.bt-inbox-hint,.bt-inbox-activity{font-size:12px;line-height:16px;color:var(--bt-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Needs you is answered on the card, so its ask is the whole text (#1177). The phone sheet clamps these two classes to two lines at a lower specificity; this unsets that clamp. In progress and Done stay one line. */
.bt-inbox-card:is([data-status=approval],[data-status=held],[data-status=input],[data-status=result],[data-status=failed]) :is(.bt-inbox-title,.bt-inbox-reason){white-space:pre-wrap;overflow-wrap:anywhere;overflow:visible;text-overflow:clip;display:block;min-width:0;-webkit-line-clamp:unset;-webkit-box-orient:unset}
.bt-inbox-calls{font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.bt-inbox-activity{color:var(--bt-ink-3)}
.bt-inbox-error{font-size:12px;line-height:16px;color:#c21d2e;overflow-wrap:anywhere}
.bt-inbox-writeback{font-size:12px;line-height:16px;color:#c21d2e;overflow-wrap:anywhere}
.bt-inbox-evidence{display:flex;flex-wrap:wrap;gap:6px;font-size:12px;line-height:16px}
.bt-inbox-evidence-link{color:var(--bt-blue,#3a7afe);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.bt-inbox-evidence-link:hover{text-decoration:underline}
.bt-inbox-result{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px}
.bt-inbox-result .bt-send,.bt-inbox-result .bt-soft{height:28px;font-size:12px}
.bt-inbox-answer{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px}
.bt-inbox-answer-text{flex:1 1 140px;min-width:0;height:28px;padding:0 8px;border:.5px solid var(--bt-line-2);border-radius:8px;background:transparent;color:var(--bt-ink);font:inherit;font-size:12px}
.bt-inbox-answer .bt-send,.bt-inbox-answer .bt-soft{height:28px;font-size:12px}
.bt-inbox-answer button[aria-pressed=true]{background:var(--bt-active);color:var(--bt-ink)}
.bt-inbox-actions{flex:none;display:flex;align-items:center;gap:6px;align-self:center}
.bt-inbox-actions .bt-send{height:28px;font-size:12px}
`
