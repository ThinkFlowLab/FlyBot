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

const MAX_TITLE = 120
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
    const tasks = []
    for (const entry of await service.catalog()) {
      const owner = ownerOf(entry.sessionId)
      if (!known(owner)) continue
      tasks.push({ ...entry, ...owner })
    }
    for (const entry of Object.values(paused())) {
      const owner = ownerOf(entry.sessionId)
      if (!known(owner)) continue
      tasks.push({ ...entry.record, id: entry.id, sessionId: entry.sessionId, status: 'paused', pausedAt: entry.pausedAt, ...owner })
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

  Object.assign(rt, { scheduleEndpoint: (endpoint, body) => endpoints[endpoint](body ?? {}), moveSchedules })
}
