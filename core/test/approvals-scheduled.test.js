// #2818: a scheduled run that hits an approval has nobody to answer the card. DSH's `ask()` has
// an abort exit and no timeout, so the turn never ends, `state.scheduleRuns` stays `running`, and
// the next delivery for that Session stacks behind it. The denial is in place and visible — never
// an allow — and the turn still ends through the existing `runEnded` path.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime, provideFlyBot } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Chief in its own chat 'a' and in group 'r1' (Session 'ga'); Writer has its own chat too; a run
// Bot proves the ephemeral verdict still answers before a reminder is asked about.
const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    run1: { id: 'run1', name: 'Coder ab', role: 'Code', sessionId: 'run1', createdAt: 3, ephemeral: true, stepTools: ['github'], permission: 'workspace-write' },
  },
  rooms: {
    r1: { id: 'r1', name: 'Ops', named: true, members: ['a', 'b'], admin: 'a', mode: 'admin', sessions: { a: 'ga' }, log: [], seq: 0, seen: {} },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-approvals-scheduled-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const injected = []
      const held = []
      const inbox = {
        nextStep: [],
        nextTurn: held,
        remove(id) {
          const at = held.findIndex(message => message.id === id)
          if (at === -1) return false
          held.splice(at, 1)
          return true
        },
      }
      const keep = (message) => { calls.push(message); held.push(message) }
      agents.set(sessionId, {
        session: { id: sessionId },
        calls,
        injected,
        cancelled: [],
        inbox,
        followup: keep,
        steer: keep,
        inject: (message) => { injected.push(message) },
        cancel(reason) { this.cancelled.push(reason) },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  provideFlyBot(ctx, rt.flybot)
  await rt.load()
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const ask = (sessionId, toolName, next, reason = '') => ctx.listeners.get('approval/request')[0](
    { agent: { session: { id: sessionId } }, toolName, reason },
    next,
  )
  const textOfMessage = message => message.content.map(block => block.text ?? '').join('\n')
  const stop = async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) }
  return { ctx, rt, home, agentOf, emit, ask, textOfMessage, stop }
}

// DSH's reminder framing, as schedules.js parses it (reminderIds).
const reminder = (id, prompt) => [
  '[SCHEDULE REMINDER]',
  'This is a scheduled message from the user',
  `schedule_id_json: ${JSON.stringify(id)}`,
  'occurrence_at: 2030-01-01T09:00:00.000Z',
  `reminder_prompt_json: ${JSON.stringify(prompt)}`,
].join('\n')

// A reminder turn of task `sched-1` in 'a', started the way DSH starts it.
function runTurn({ emit }, turn = 1, message = {}) {
  const data = {
    id: `msg-${turn}`,
    content: [{ type: 'text', text: reminder('sched-1', 'Audit the repo') }],
    source: { kind: 'schedule' },
    ...message,
  }
  emit('a', 'turn/start', { turn })
  emit('a', 'user/message', { content: data.content, source: data.source })
  return data
}

// A promise that never settles, the way DSH waits for a person.
const noOne = () => new Promise(() => {})

const race = (promise, ms = 200) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => resolve('still-pending'), ms)),
])

test('#2818: a reminder turn\'s approval is denied in place, visibly, and the run still ends', async (t) => {
  const host = await start()
  t.after(host.stop)

  runTurn(host)
  assert.equal(host.rt.state.scheduleRuns['sched-1'].result, 'running', 'the reminder turn owns a running run')

  // Red on the base: the request is handed to DSH, whose ask() has no timeout, so it is still
  // pending after 200 ms.
  const outcome = await race(host.ask('a', 'bash', noOne))
  assert.equal(outcome, 'rejected', 'the scheduled run\'s request settles rejected at once')

  // The user sees it: one line in the Session the run already owns, naming the tool and the way out.
  const said = host.agentOf('a').injected.map(host.textOfMessage).join('\n')
  assert.match(said, /bash/, 'it names the tool')
  assert.match(said, /standing approval/i, 'it says how to make it run next time')
  assert.match(said, /(chat|yourself)/i, 'it says to run it from the chat')
  assert.match(said, /skip/i, 'it says the request was skipped')

  // Nothing was left waiting in the team view: the denial settled the entry.
  assert.deepEqual(host.rt.approvalsView(), [], 'no card is left pending for the owner')

  // Still running while the turn runs, so this is the row a stuck run would leave behind.
  assert.equal(host.rt.state.scheduleRuns['sched-1'].result, 'running')
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(host.rt.state.scheduleRuns['sched-1'].result, 'ran', 'the turn ends through the existing runEnded path')
})

test('#2818: the controls are unchanged — an owner turn still waits, a group still waits, a run Bot keeps its verdict', async (t) => {
  const host = await start()
  t.after(host.stop)

  // A non-reminder turn in the same own chat: the card still comes from DSH.
  host.emit('a', 'turn/start', { turn: 1 })
  host.emit('a', 'user/message', { content: [{ type: 'text', text: 'Please clean up' }], source: { kind: 'user' } })
  let waited = 0
  const ownerOutcome = await host.ask('a', 'bash', () => { waited += 1; return 'from-dsh' })
  assert.equal(ownerOutcome, 'from-dsh', 'the non-reminder turn still hands the ask to DSH')
  assert.equal(waited, 1, 'next() was called')
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })

  // A group Session: the group's DS Bot answers, so the ask waits for that answer.
  const groupOutcome = await race(host.ask('ga', 'bash', () => 'from-dsh'), 100)
  assert.equal(groupOutcome, 'still-pending', 'a group ask still waits for the group')
  assert.equal(host.rt.approvalsView().length, 1, 'the group card is listed for the group to answer')
  assert.equal(host.rt.approvalsView()[0].sessionId, 'ga')

  // A workflow run Bot is answered by ephemeralToolVerdict before any reminder is consulted.
  assert.equal(await host.ask('run1', 'mcp__github__create_pull_request', noOne), 'allowed-once')
  assert.equal(await host.ask('run1', 'message_bot', noOne), 'rejected')
  assert.deepEqual(host.agentOf('run1').injected, [], 'a run Bot is never told about a reminder')
})

test('#2818: no auto-allow — the denial never answers a reminder ask with an allow', async (t) => {
  const host = await start()
  t.after(host.stop)
  runTurn(host)
  // Every tool name and a sandbox escalation alike: the only auto verdict a reminder can get is
  // `rejected` (the `allowed-once` a standing grant would give is the standing path's, above).
  for (const [tool, reason] of [['bash', ''], ['bash', 'escalate sandbox to danger-full-access: rm -rf build'], ['mcp__github__create_pull_request', '']]) {
    const outcome = await race(host.ask('a', tool, noOne, reason))
    assert.equal(outcome, 'rejected', `${tool}${reason ? ` (${reason})` : ''} is denied, never allowed`)
  }
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
})

test('#2818: the base row is still in state.json the way the page reads it', async (t) => {
  const host = await start()
  t.after(host.stop)
  runTurn(host)
  assert.equal(await race(host.ask('a', 'bash', noOne)), 'rejected')
  const saved = () => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8')).scheduleRuns?.['sched-1']?.result
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  for (let tries = 0; tries < 100 && saved() !== 'ran'; tries++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(saved(), 'ran', 'the run leaves `running` in the file too')
  assert.ok(existsSync(join(host.home, 'state.json')))
})
