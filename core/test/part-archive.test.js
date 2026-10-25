import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// A Main Bot and a Bot, both idle in their own chat.
const TEAM = {
  version: 1,
  mainBotIds: ['a'],
  workspaceId: 'w1',
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

// DSH's schedule service, as the host sees it: tasks are stored per Session, and a
// Session with an active task refuses to be archived unless its activity is stopped.
function scheduleService({ listDelay = 0, failCreate = false } = {}) {
  const tasks = new Map()
  let next = 1
  const armedOn = (sessionId) => [...tasks.entries()].filter(([, task]) => task.sessionId === sessionId).map(([id]) => id)
  return {
    tasks,
    listDelay,
    failCreate,
    armedOn,
    stop(sessionId) {
      for (const id of armedOn(sessionId)) tasks.delete(id)
    },
    arm(sessionId, title = 'nightly check') {
      const id = `schedule-${next++}`
      tasks.set(id, { sessionId, record: { id, title, prompt: 'Wake up.', kind: 'at', scheduledAt: '2030-01-01T01:00:00.000Z' } })
      return id
    },
    async list({ sessionId }) {
      if (listDelay > 0) await new Promise(resolve => setTimeout(resolve, listDelay))
      return [...tasks.values()].filter(task => task.sessionId === sessionId).map(task => task.record)
    },
    async create(sessionId, request) {
      if (failCreate) throw new Error('create failed')
      const id = `schedule-${next++}`
      tasks.set(id, { sessionId, record: { id, title: request.title, prompt: request.prompt, kind: 'at', scheduledAt: request.at } })
      return tasks.get(id).record
    },
    async delete({ sessionId, id }) {
      if (tasks.get(id)?.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
      tasks.delete(id)
      return { id, deleted: true }
    },
  }
}

// DSH's refusal, with the activity kinds it reports (`schedule`, `job`, …).
function activeSessionError(sessionId, kinds) {
  return Object.assign(new Error(`cannot archive session '${sessionId}': the session is active (${kinds.join(', ')})`), {
    name: 'WorkspaceActiveSessionError',
    sessionId,
    activity: kinds.map(kind => ({ kind })),
  })
}

// The team's data in a temporary home, and a project folder beside it. The registry
// refuses an archive while a Session still has an active task or another activity,
// exactly as DSH does.
//
// The whole tree comes from `tmpdir()`, so `TMPDIR` has to stay outside `DSH_HOME`: a
// folder under the harness home is refused (`bot/refused`) before any part can move, and
// every case below asserts that answer, so the refusal names itself instead of reading as
// a two-second timeout (#1169).
async function start({ schedule, activities = {} } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-part-archive-')))
  const dsh = join(root, 'dsh')
  const home = join(dsh, 'bot')
  const team = join(home, 'workspace')
  const project = join(root, 'project')
  for (const dir of [team, project]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))

  const ctx = fakeContext({ services: schedule === undefined ? {} : { schedule } })
  const created = []
  const cwds = new Map()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      agents.set(sessionId, {
        id: sessionId,
        session: { id: sessionId, header: { cwd: cwds.get(sessionId) ?? team }, requestHeader: () => undefined, deriveMessages: () => [] },
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove() {} },
      })
    }
    return agents.get(sessionId)
  }
  const archived = []
  const stopped = []
  const registry = new Map([['w1', { id: 'w1', path: team, title: 'DS Bot' }]])
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: id => registry.get(id),
      list: () => [...registry.values()],
      resolveByPath: async path => [...registry.values()].find(workspace => workspace.path === path),
      create: async path => ({ id: 'w-new', path }),
      async archiveSession(sessionId, options) {
        const kinds = [...(schedule?.armedOn(sessionId).length > 0 ? ['schedule'] : []), ...(activities[sessionId] ?? [])]
        if (kinds.length > 0 && options?.stopActivity !== true) throw activeSessionError(sessionId, kinds)
        if (options?.stopActivity === true) {
          stopped.push(sessionId)
          schedule?.stop(sessionId)
          delete activities[sessionId]
        }
        archived.push(options === undefined ? sessionId : [sessionId, options])
      },
    },
    sessionController: {
      create: async (options) => {
        const sessionId = `s${created.length + 1}`
        created.push(options)
        cwds.set(sessionId, options.cwd ?? registry.get(options.workspaceId)?.path)
        return { sessionId }
      },
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: agentOf(sessionId), name, callId: 'c1' })
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const stop = () => {
    ctx.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  // Loading once fills the Session-owner indexes.
  await tool('list_bots', {}, 'a')
  return { ctx, created, agentOf, call, state, archived, stopped, activities, home, project, until, settle, stop }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('until: the condition did not hold within 2 s')
    await settle()
  }
}
// The part switch runs in the background; give its archive time to land (or not).
const drained = async () => { for (let i = 0; i < 25; i += 1) await settle() }
const archivedEntry = (archived, sessionId) => archived.find(entry => (Array.isArray(entry) ? entry[0] : entry) === sessionId)

test('#896: a part whose task moved is archived once the move finished', async (t) => {
  const schedule = scheduleService({ listDelay: 40 })
  const h = await start({ schedule })
  t.after(h.stop)
  schedule.arm('b')
  // A folder change moves an idle Bot's chat to a fresh part, the same switch a context
  // check takes.
  const answer = await h.call('update-bot', { id: 'b', workDir: h.project })
  assert.equal(answer.ok, true, answer.error?.message)
  await h.until(() => h.state().bots.b.sessionId === 's1')
  await drained()
  assert.deepEqual(archivedEntry(h.archived, 'b'), 'b', 'the earlier part is archived')
  assert.deepEqual(schedule.armedOn('b'), [], 'the earlier part keeps no task')
  assert.equal(schedule.armedOn('s1').length, 1, 'the task moved to the fresh part')
})

test('#896: a failed task move does not leave an armed earlier part active', async (t) => {
  const schedule = scheduleService({ failCreate: true })
  const h = await start({ schedule })
  t.after(h.stop)
  schedule.arm('b')
  const answer = await h.call('update-bot', { id: 'b', workDir: h.project })
  assert.equal(answer.ok, true, answer.error?.message)
  await h.until(() => h.state().bots.b.sessionId === 's1')
  await drained()
  assert.deepEqual(archivedEntry(h.archived, 'b'), ['b', { stopActivity: true }], 'the earlier part is archived with its activity stopped')
  assert.deepEqual(schedule.armedOn('b'), [], 'no armed task is left on the finished part')
})

test('#896: a part held by a job is never force-archived', async (t) => {
  const schedule = scheduleService()
  const h = await start({ schedule, activities: { b: ['job'] } })
  t.after(h.stop)
  const answer = await h.call('update-bot', { id: 'b', workDir: h.project })
  assert.equal(answer.ok, true, answer.error?.message)
  await h.until(() => h.state().bots.b.sessionId === 's1')
  await drained()
  assert.equal(archivedEntry(h.archived, 'b'), undefined, 'the earlier part stays active, as before this fix')
  assert.deepEqual(h.stopped, [], 'a stop request never reaches a job')
  assert.deepEqual(h.activities.b, ['job'], 'the job still runs')
})

// The refusal the three cases above can meet when `TMPDIR` sits inside `DSH_HOME`, from a
// folder this case names itself: the guard answers, no part is made and the Bot stays put.
// `cleanWorkDir` refuses a folder that holds the harness data (`folders.js`).
test('#1169: a folder under the harness home refuses the move and names itself', async (t) => {
  const schedule = scheduleService()
  const h = await start({ schedule })
  t.after(h.stop)
  const answer = await h.call('update-bot', { id: 'b', workDir: h.home })
  assert.equal(answer.ok, false, 'a folder under the harness home is refused')
  assert.equal(answer.error?.code, 'bot/refused')
  assert.match(answer.error.message, /holds DeepSeek Harness data/)
  assert.ok(answer.error.message.includes(h.home), 'the refusal names the folder')
  assert.equal(h.state().bots.b.sessionId, 'b', 'the Bot stays in its own chat')
  assert.deepEqual(h.created, [], 'no part is created for a refused folder')
})
