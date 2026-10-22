// Scheduled tasks. DSH's schedule service stores each task with the Session it belongs
// to and, when it is due, sends its prompt to that Session as a new message. This
// module lists the team's tasks for Settings, creates and removes them there, and moves
// a Bot's tasks along when its chat goes on in a fresh part, so the Bot keeps seeing
// them. A group chat's task lives on the group's own Session, so the reminder reaches
// the group like a message from the user (see reminderText). DSH 0.2.0 mounts the service only with its Automation tasks bundle on, so
// the service is optional and every endpoint reports whether it is there.
//
// Edit and Pause (#354). Edit keeps a task where it is: on the same Session it goes
// through DSH's own compare-and-update (the id and delivery records stay); to another
// Bot or group chat, or for a finished one-shot, the new task is created before the old
// one goes, so a failure keeps the old task. DSH has no pause, so Pause keeps the task's
// record in FlyBot's state (`pausedSchedules`) before it removes it from DSH, and Resume
// creates it again on the Bot's current part. A missed run is DSH's: after the app was
// closed a recurring task runs once, for its latest missed time, never once per missed
// time (docs/subsystems/core-host.md).
//
// Last run and Retry (#473). DSH's `lastDelivery` says a reminder reached the Session's
// inbox, not how the Bot's turn went, so FlyBot keeps each task's last run in
// `state.scheduleRuns[<id>]`: running, ran, stopped, or failed with a reason. A run fails
// only when DSH could not deliver it (the task stays due past MISSED_MS while the app runs)
// or the Bot's turn errored; a turn that ends without an answer has run. Retry sends the
// task's prompt once now, framed as DSH frames a reminder; it never backfills missed times.
// A failure also joins the ended turns the notifications and the Agent inbox read (#353).

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { textOf } from './text.js'
import { output } from './tools.js'

const MAX_TITLE = 120
// How long a due task may stay undelivered while the app runs before it counts as failed.
const MISSED_MS = 120_000
const CHECK_MS = 60_000
const RUNS_KEPT = 200
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// What a group sees of a due reminder: DSH frames it for one Session's model
// ("[SCHEDULE REMINDER]" with JSON fields); the group gets each prompt as one line.
export function reminderText(text) {
  const prompts = []
  const one = /^reminder_prompt_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    if (one) prompts.push(JSON.parse(one[1]))
    if (batch) for (const entry of JSON.parse(batch[1])) prompts.push(entry.reminder_prompt)
  } catch {
    // A framing this module cannot read goes to the group as it came.
    return text
  }
  const lines = prompts.filter(prompt => typeof prompt === 'string' && prompt.trim() !== '')
  return lines.length === 0 ? text : lines.map(prompt => `[Scheduled task] ${prompt}`).join('\n')
}

// The task ids a reminder's framing names (one, or each of a batch).
export function reminderIds(text) {
  const one = /^schedule_id_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    const ids = one ? [JSON.parse(one[1])] : batch ? JSON.parse(batch[1]).map(entry => entry?.schedule_id) : []
    return ids.filter(id => typeof id === 'string' && id !== '')
  } catch {
    return []
  }
}

// A run again of one task, in DSH's reminder framing, so the turn reads it like the task's
// own run and a group gets its prompt (reminderText).
export const retryText = (record, at) => [
  '[SCHEDULE REMINDER]',
  'This is a scheduled message from the user',
  `schedule_id_json: ${JSON.stringify(record.id)}`,
  `occurrence_at: ${new Date(at).toISOString()}`,
  `reminder_prompt_json: ${JSON.stringify(record.prompt)}`,
].join('\n')

// The create request that gives a stored record its timing again, for a move.
function requestOf(record) {
  const base = { title: record.title, prompt: record.prompt }
  if (record.kind === 'after' || record.kind === 'at') return { ...base, at: record.scheduledAt }
  if (record.kind === 'every') return { ...base, every_seconds: record.everySeconds }
  if (record.kind === 'daily') return { ...base, daily: { time: record.time, time_zone: record.timeZone } }
  if (record.kind === 'weekly') return { ...base, weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } }
  if (record.kind === 'cron') return { ...base, cron: { expression: record.expression, time_zone: record.timeZone } }
  return null
}

// A create request's timing as the record fields a paused task keeps (the inverse of
// requestOf), so a paused task reads like any other in the list.
function timingOf(selector) {
  if (selector.at !== undefined) return { kind: 'at', scheduledAt: selector.at }
  if (selector.every_seconds !== undefined) return { kind: 'every', everySeconds: selector.every_seconds }
  if (selector.daily !== undefined) return { kind: 'daily', time: selector.daily.time, timeZone: selector.daily.time_zone }
  if (selector.weekly !== undefined) return { kind: 'weekly', time: selector.weekly.time, timeZone: selector.weekly.time_zone, weekdays: selector.weekly.weekdays }
  if (selector.cron !== undefined) return { kind: 'cron', expression: selector.cron.expression, timeZone: selector.cron.time_zone }
  return {}
}
const TIMING_FIELDS = ['at', 'every_seconds', 'daily', 'weekly', 'cron']
const timingPart = request => Object.fromEntries(TIMING_FIELDS.filter(key => request[key] !== undefined).map(key => [key, request[key]]))
// DSH's update takes a timing change as one discriminated value.
function changeOf(selector) {
  if (selector.at !== undefined) return { kind: 'at', at: selector.at }
  if (selector.every_seconds !== undefined) return { kind: 'every', every_seconds: selector.every_seconds }
  if (selector.daily !== undefined) return { kind: 'daily', daily: selector.daily }
  if (selector.weekly !== undefined) return { kind: 'weekly', weekly: selector.weekly }
  return { kind: 'cron', cron: selector.cron }
}
const UPDATE_MISSES = { schedule_not_found: 'No such task', schedule_ended: 'This task has finished', schedule_conflict: 'The task changed meanwhile. Try again' }

// The settings form's timing as a create request selector.
function selectorOf(when) {
  const zone = typeof when?.timeZone === 'string' && when.timeZone !== '' ? when.timeZone : 'UTC'
  switch (when?.kind) {
    case 'at': {
      const at = new Date(String(when.at ?? ''))
      if (Number.isNaN(at.getTime())) throw invalid('Pick a date and time')
      if (at.getTime() <= Date.now()) throw invalid('Pick a time in the future')
      return { at: at.toISOString() }
    }
    case 'daily':
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      return { daily: { time: `${when.time}:00`, time_zone: zone } }
    case 'weekly': {
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      const weekdays = [...new Set((Array.isArray(when.weekdays) ? when.weekdays : []).map(Number))].filter(day => Number.isInteger(day) && day >= 1 && day <= 7).sort()
      if (weekdays.length === 0) throw invalid('Pick at least one day')
      return { weekly: { time: `${when.time}:00`, time_zone: zone, weekdays } }
    }
    case 'every': {
      const minutes = Number(when.minutes)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw invalid('Repeat every 1 minute to 7 days')
      return { every_seconds: minutes * 60 }
    }
    default:
      throw invalid('Pick when it runs')
  }
}

export function install(rt) {
  const { ctx, state } = rt
  let service = null

  const attach = (sub) => {
    const own = sub.schedule
    service = own
    sub.effect(() => () => { if (service === own) service = null }, 'ds-bot: schedule service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['schedule'], attach)
  else if (ctx.get?.('schedule') !== undefined) attach({ schedule: ctx.get('schedule'), effect: (execute, label) => ctx.effect(execute, label) })

  // The Bot (and group chat) a task's Session speaks for, the group chat for a group's
  // own Session, or nothing for a Session outside the team.
  const ownerOf = (sessionId) => {
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) return { botId: chat }
    if (rt.roomOf(sessionId) !== undefined) return { roomId: sessionId }
    return rt.groupOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)
  }
  const known = owner => owner !== undefined && (owner.botId === undefined ? state.rooms[owner.roomId] !== undefined : state.bots[owner.botId] !== undefined)
  // Paused tasks, by their DSH id: { id, sessionId, record, pausedAt }. DSH ids are
  // unique across the host, so a paused task keeps the id it had.
  const paused = () => {
    if (state.pausedSchedules === null || typeof state.pausedSchedules !== 'object' || Array.isArray(state.pausedSchedules)) state.pausedSchedules = {}
    return state.pausedSchedules
  }
  const pausedEntry = (sessionId, id) => {
    const entry = Object.hasOwn(paused(), String(id ?? '')) ? paused()[id] : undefined
    return entry !== undefined && entry.sessionId === sessionId ? entry : undefined
  }
  // The Session a Bot's or group chat's new task goes to: the Bot's current part.
  const sessionFor = owner => (owner.botId !== undefined ? rt.chatOf(owner.botId) : owner.roomId)
  const ensureService = () => { if (service === null) throw invalid('Automation tasks are off in DSH') }

  // Each task's last run, by its DSH id: { at, result, reason?, messageId?, missed? }.
  const runs = () => {
    if (state.scheduleRuns === null || typeof state.scheduleRuns !== 'object' || Array.isArray(state.scheduleRuns)) state.scheduleRuns = {}
    return state.scheduleRuns
  }
  const noteRun = (id, run) => {
    const all = runs()
    delete all[id]
    all[id] = run
    const ids = Object.keys(all)
    if (ids.length > RUNS_KEPT) for (const old of ids.slice(0, ids.length - RUNS_KEPT)) delete all[old]
    void rt.save().catch(() => {})
  }
  // What a row shows: FlyBot's record, or DSH's newer delivery the Bot has not taken up yet.
  // A run still marked running from before this start has no known end: it shows as a run.
  const startedAt = Date.now()
  const lastRunOf = (entry) => {
    const run = Object.hasOwn(runs(), entry.id) ? runs()[entry.id] : undefined
    const delivered = entry.lastDelivery
    if (delivered !== undefined && run?.messageId !== delivered.messageId && Date.parse(delivered.deliveredAt) > (run?.at ?? 0)) {
      return { at: Date.parse(delivered.deliveredAt), result: 'delivered' }
    }
    if (run === undefined) return undefined
    const result = run.result === 'running' && run.at < startedAt ? 'delivered' : run.result
    return { at: run.at, result, ...(run.reason ? { reason: run.reason } : {}) }
  }

  // The turns that run a task, by Session: the task ids and a group round's failure.
  /** @type {Map<string, {ids:string[], failed?:string}>} */
  const runningRuns = new Map()
  const runStarted = (sessionId, message) => {
    const ids = reminderIds(textOf(message?.content))
    if (ids.length === 0) return
    const at = Date.now()
    const current = runningRuns.get(sessionId)
    runningRuns.set(sessionId, { ...current, ids: [...new Set([...(current?.ids ?? []), ...ids])] })
    for (const id of ids) noteRun(id, { at, result: 'running', ...(typeof message?.id === 'string' ? { messageId: message.id } : {}) })
  }
  // `failed`: the turn's error line (turns.js failureLine); `aborted`: the user stopped it.
  const runEnded = (sessionId, { failed, aborted = false } = {}) => {
    const entry = runningRuns.get(sessionId)
    if (entry === undefined) return
    runningRuns.delete(sessionId)
    const reason = failed ?? entry.failed
    for (const id of entry.ids) {
      const run = runs()[id]
      if (run === undefined) continue
      noteRun(id, { ...run, result: reason !== undefined ? 'failed' : aborted ? 'stopped' : 'ran', ...(reason !== undefined ? { reason: reason.slice(0, 200) } : {}) })
    }
  }
  // A group round whose members' turns failed: the task's run in that group failed.
  const roundFailed = (sessionId, names) => {
    const entry = runningRuns.get(sessionId)
    if (entry !== undefined && names.length > 0) entry.failed = `${names.join(', ')} could not answer: the model call failed`
  }

  // A due task DSH has not delivered: seen due at one check and still due MISSED_MS later
  // (DSH delivers a time missed while the app was closed as soon as it starts).
  /** @type {Map<string, {scheduledAt:string, since:number}>} */
  const due = new Map()
  async function checkMissed(now = Date.now()) {
    if (service === null) return
    const seen = new Set()
    for (const entry of await service.catalog()) {
      if (entry.status !== 'active' || !(Date.parse(entry.scheduledAt) <= now) || entry.lastDelivery?.scheduledAt === entry.scheduledAt) continue
      const owner = ownerOf(entry.sessionId)
      if (!known(owner)) continue
      seen.add(entry.id)
      const first = due.get(entry.id)
      if (first?.scheduledAt !== entry.scheduledAt) { due.set(entry.id, { scheduledAt: entry.scheduledAt, since: now }); continue }
      if (now - first.since < MISSED_MS || runs()[entry.id]?.missed === entry.scheduledAt) continue
      noteRun(entry.id, { at: Date.parse(entry.scheduledAt), result: 'failed', reason: 'DSH could not deliver it', missed: entry.scheduledAt })
      // The same event the finished and failed turns use (#353), for my own Bots only.
      const room = owner.roomId === undefined ? undefined : state.rooms[owner.roomId]
      const bot = state.bots[owner.botId ?? room?.admin ?? room?.members?.[0]]
      if (bot === undefined || bot.remote !== undefined || room?.origin !== undefined) continue
      rt.noteRunFailure?.({
        id: `schedule:${entry.id}:${entry.scheduledAt}`,
        botId: bot.id,
        ...(room ? { roomId: room.id } : { sessionId: entry.sessionId }),
        at: now,
        failed: `Scheduled task "${entry.title}" was not delivered`.slice(0, 160),
      })
    }
    for (const id of due.keys()) if (!seen.has(id)) due.delete(id)
  }
  ctx.effect(() => {
    const timer = setInterval(() => { void checkMissed().catch(error => rt.warn('ds-bot: checking scheduled tasks failed: %s', error?.message ?? error)) }, CHECK_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: missed scheduled runs')

  // The form's name, instruction and target, checked as creation checks them.
  function contentOf(body) {
    const bot = state.bots[body.target]
    const room = state.rooms[body.target]
    if (bot === undefined && room === undefined) throw invalid('No such Bot or group chat')
    const title = String(body.title ?? '').trim()
    const prompt = String(body.prompt ?? '').trim()
    if (title === '') throw invalid('Give the task a name')
    if (title.length > MAX_TITLE) throw invalid(`Keep the name under ${MAX_TITLE} characters`)
    if (prompt === '') throw invalid('Say what the Bot should do')
    return { sessionId: bot ? rt.chatOf(bot.id) : room.id, title, prompt }
  }

  // One stored task as DSH has it, active or finished, or undefined.
  const findRecord = async (sessionId, id) => (await service.catalog()).find(entry => entry.sessionId === sessionId && entry.id === id)

  async function schedulesView() {
    if (service === null) return { available: false, tasks: [] }
    // The page asks every 30 seconds, so a missed run shows without waiting for the timer.
    await checkMissed().catch(error => rt.warn('ds-bot: checking scheduled tasks failed: %s', error?.message ?? error))
    const tasks = []
    for (const entry of await service.catalog()) {
      const owner = ownerOf(entry.sessionId)
      if (!known(owner)) continue
      const lastRun = lastRunOf(entry)
      tasks.push({ ...entry, ...owner, ...(lastRun ? { lastRun } : {}) })
    }
    for (const entry of Object.values(paused())) {
      const owner = ownerOf(entry.sessionId)
      if (!known(owner)) continue
      const lastRun = lastRunOf({ id: entry.id })
      tasks.push({ ...entry.record, id: entry.id, sessionId: entry.sessionId, status: 'paused', pausedAt: entry.pausedAt, ...owner, ...(lastRun ? { lastRun } : {}) })
    }
    return { available: true, tasks }
  }

  // Edit: a paused task stays paused with its new content; an active one is updated in
  // place on the same Session, otherwise created anew before the old one is deleted.
  // `when: { kind: 'keep' }` keeps the timing (a cron rule the form cannot show).
  async function updateSchedule(body) {
    ensureService()
    const sessionId = String(body.sessionId ?? '')
    const id = String(body.id ?? '')
    if (ownerOf(sessionId) === undefined) throw invalid('No such task')
    const content = contentOf(body)
    const keep = body.when?.kind === 'keep'
    const held = pausedEntry(sessionId, id)
    if (held !== undefined) {
      const timing = keep ? timingPart(requestOf(held.record) ?? {}) : selectorOf(body.when)
      paused()[id] = { ...held, sessionId: content.sessionId, record: { title: content.title, prompt: content.prompt, ...timingOf(timing) } }
      await rt.save()
      return schedulesView()
    }
    // DSH's update compares the exact record `list` gives (active tasks only).
    const active = (await service.list({ sessionId })).find(entry => entry.id === id)
    const record = active ?? await findRecord(sessionId, id)
    if (record === undefined) throw invalid('No such task')
    const stored = requestOf(record)
    if (stored === null) throw invalid('This task cannot be edited here')
    const timing = keep ? timingPart(stored) : selectorOf(body.when)
    if (active !== undefined && content.sessionId === sessionId && typeof service.update === 'function') {
      const same = JSON.stringify(timingPart(stored)) === JSON.stringify(timing)
      const result = await service.update({ sessionId, id, expected: active, title: content.title, prompt: content.prompt, ...(same ? {} : { change: changeOf(timing) }) })
      if (result?.record === undefined) throw invalid(UPDATE_MISSES[result?.code] ?? result?.message ?? 'The task could not be saved')
      return schedulesView()
    }
    if (timing.at !== undefined && Date.parse(timing.at) <= Date.now()) throw invalid('Pick a time in the future')
    await service.create(content.sessionId, { title: content.title, prompt: content.prompt, ...timing })
    await service.delete({ sessionId, id })
    return schedulesView()
  }

  // Pause: the record is saved in FlyBot's state before DSH lets the task go, so a
  // failed delete leaves it running and never loses it.
  async function pauseSchedule(body) {
    ensureService()
    const sessionId = String(body.sessionId ?? '')
    const id = String(body.id ?? '')
    if (ownerOf(sessionId) === undefined) throw invalid('No such task')
    if (pausedEntry(sessionId, id) !== undefined) return schedulesView()
    const record = await findRecord(sessionId, id)
    if (record === undefined) throw invalid('No such task')
    if (record.status !== 'active') throw invalid('This task has finished')
    const request = requestOf(record)
    if (request === null) throw invalid('This task cannot be paused')
    paused()[id] = { id, sessionId, record: { title: record.title, prompt: record.prompt, ...timingOf(timingPart(request)) }, pausedAt: Date.now() }
    await rt.save()
    try {
      const result = await service.delete({ sessionId, id })
      if (result?.deleted === false) throw invalid('No such task')
    } catch (error) {
      delete paused()[id]
      await rt.save()
      throw error
    }
    return schedulesView()
  }

  // Resume: DSH gets the task again, on the Bot's current part, before FlyBot forgets
  // the paused copy. A one-time task whose time has passed waits for an edit.
  async function resumeSchedule(body) {
    ensureService()
    const sessionId = String(body.sessionId ?? '')
    const held = pausedEntry(sessionId, String(body.id ?? ''))
    const owner = ownerOf(sessionId)
    if (held === undefined || !known(owner)) throw invalid('No such task')
    const request = requestOf(held.record)
    if (request === null) throw invalid('No such task')
    if (request.at !== undefined && Date.parse(request.at) <= Date.now()) throw invalid('Its time has passed. Edit the task to pick a new one')
    await service.create(sessionFor(owner), request)
    delete paused()[held.id]
    await rt.save()
    return schedulesView()
  }

  // Retry: the task's prompt once now, to the Bot's current part or the group, as a run of
  // that task. DSH's own times are untouched: no missed time is delivered again.
  async function retrySchedule(body) {
    ensureService()
    const sessionId = String(body.sessionId ?? '')
    const owner = ownerOf(sessionId)
    if (!known(owner)) throw invalid('No such task')
    if (pausedEntry(sessionId, String(body.id ?? '')) !== undefined) throw invalid('Resume the task first')
    const record = await findRecord(sessionId, String(body.id ?? ''))
    if (record === undefined) throw invalid('No such task')
    const target = sessionFor(owner)
    const at = Date.now()
    await rt.ensureCapabilities?.(target)
    const agent = await rt.resolveAgent(target)
    // Noted first: the turn that takes the message up may start (and end) before the flush.
    const before = Object.hasOwn(runs(), record.id) ? runs()[record.id] : undefined
    noteRun(record.id, { at, result: 'running' })
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: retryText(record, at) }], source: { kind: 'schedule' } }))
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      if (before !== undefined) noteRun(record.id, before)
      else {
        delete runs()[record.id]
        void rt.save().catch(() => {})
      }
      throw error
    }
    return schedulesView()
  }

  // Which Session a task lives in, named as the Bot reads it: its own chat (now, or an
  // earlier part), or a group chat it speaks in (now, or an earlier part).
  const placeOf = (sessionId, botId) => {
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) return { botId: chat, place: sessionId === rt.chatOf(chat) ? 'own chat' : 'own chat, earlier part' }
    // A group chat's own Session (its id is the room id): the tasks the owner set for the
    // group itself. Only a member is told about them.
    const room = rt.roomOf(sessionId)
    if (room !== undefined) return room.members?.includes(botId) === true ? { botId, place: room.name === undefined ? 'this group chat' : `group chat "${room.name}"` } : undefined
    const live = rt.groupOwners.get(sessionId)
    const past = rt.pastOwners.get(sessionId)
    const owner = live ?? past
    if (owner === undefined) return undefined
    // An archived part of a Bot's own chat has no group: it is the same chat, earlier.
    if (live === undefined && past.roomId === undefined) return { botId: past.botId, place: 'own chat, earlier part' }
    const name = rt.roomOf(owner.roomId)?.name
    const place = name === undefined ? 'a group chat' : `group chat "${name}"`
    return { botId: owner.botId, place: live === undefined ? `${place}, earlier part` : place }
  }

  // DSH's own `schedule_list` answers for the Session the call runs in, and its empty
  // answer is indistinguishable from "this Bot has nothing scheduled" (#628): a task the
  // owner sees in the UI is invisible from another Session of the same Bot. This tool
  // answers for the Bot instead, from the host-wide catalog.
  ctx.tools.register(defineTool({
    name: 'bot_schedules',
    description: "List every scheduled task this Bot has, in every Session of its own — its own chat, the earlier parts of it, the group chats it speaks in, and the tasks set for those group chats themselves — with id, title, next run, state and owning Session. DSH's own `schedule_list` answers for one Session only; this one answers for the Bot.",
    parameters: {},
    output,
    async execute(_args, exec) {
      await rt.load()
      const botId = rt.selfOf(exec.agent?.id)
      const bot = rt.botOf(botId)
      if (bot === undefined) return 'This Session does not belong to a Bot, so there are no Bot-wide scheduled tasks.'
      const head = `Scheduled tasks of ${bot.name} — every Session of this Bot (DSH's own schedule_list answers for one Session only):`
      if (service === null) return `${head}\nnone — Automation tasks are off in DSH, so no scheduled task is visible.`
      const rows = []
      const add = (entry, status, when) => {
        const at = placeOf(entry.sessionId, botId)
        if (at?.botId !== botId) return
        rows.push({
          at: when ?? '',
          line: `- "${entry.title ?? 'untitled'}" (${entry.id}) — ${when === undefined ? 'no next run' : `next ${when}`}, ${status}, ${at.place}, session ${entry.sessionId}`,
        })
      }
      for (const entry of await service.catalog()) add(entry, entry.status ?? 'active', entry.scheduledAt)
      for (const entry of Object.values(paused())) add({ ...entry.record, id: entry.id, sessionId: entry.sessionId }, 'paused', undefined)
      if (rows.length === 0) return `${head}\nnone — no scheduled task in any of its Sessions, so this is the whole list for the Bot.`
      rows.sort((a, b) => a.at.localeCompare(b.at) || a.line.localeCompare(b.line))
      return [head, ...rows.map(row => row.line)].join('\n')
    },
  }))

  const endpoints = {
    schedules: () => schedulesView(),
    async 'schedule-create'(body) {
      ensureService()
      const { sessionId, title, prompt } = contentOf(body)
      await service.create(sessionId, { title, prompt, ...selectorOf(body.when) })
      return schedulesView()
    },
    'schedule-update': body => updateSchedule(body),
    'schedule-pause': body => pauseSchedule(body),
    'schedule-resume': body => resumeSchedule(body),
    'schedule-retry': body => retrySchedule(body),
    async 'schedule-delete'(body) {
      ensureService()
      if (ownerOf(body.sessionId) === undefined) throw invalid('No such task')
      if (pausedEntry(body.sessionId, body.id) !== undefined) {
        delete paused()[body.id]
        await rt.save()
        return schedulesView()
      }
      await service.delete({ sessionId: body.sessionId, id: body.id })
      return schedulesView()
    },
  }

  // A fresh part takes over the earlier part's active tasks: each is created again on
  // the fresh Session before the old one goes, so a failure leaves it where it was.
  async function moveSchedules(fromId, toId) {
    if (service === null) return
    let records
    try {
      records = await service.list({ sessionId: fromId })
    } catch (error) {
      rt.warn('ds-bot: tasks of %s not moved: %s', fromId, error?.message ?? error)
      return
    }
    for (const record of records) {
      const request = requestOf(record)
      if (request === null || (request.at !== undefined && Date.parse(request.at) <= Date.now())) continue
      try {
        await service.create(toId, request)
        await service.delete({ sessionId: fromId, id: record.id })
      } catch (error) {
        rt.warn('ds-bot: task %s stayed with the earlier part: %s', record.title, error?.message ?? error)
      }
    }
  }

  Object.assign(rt, {
    scheduleEndpoint: (endpoint, body) => endpoints[endpoint](body ?? {}),
    moveSchedules,
    scheduleRunStarted: runStarted,
    scheduleRunEnded: runEnded,
    scheduleRoundFailed: roundFailed,
    checkMissedSchedules: checkMissed,
  })
}
