// P-673: `store.save()` has three paths that write nothing and still resolve — a stopped host, a
// team another dsh holds, and a team file this host cannot write (store.js:1037, 1046-1047, 1050).
// `approvals.js` treats only a *thrown* save as a refusal (#2764), so a silent skip read as a
// success: "Always allow" stayed in memory while the file held no grant, and the settings card said
// a removal had happened while the grant was still on disk and still answered the next ask.
// The fixture is the real store: the lock of another live dsh, and a disposed host.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const KIND = 'bash:escalate:danger-full-access'
const seed = (grants) => {
  const state = {
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], mode: 'admin', admin: 'b', named: true, sessions: { b: 'gb' }, log: [], seq: 0, seen: {} } },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
  if (grants !== undefined) state.bots.b.standingApprovals = grants
  return state
}
const kindsOf = grants => (grants ?? []).map(grant => grant.kind)
const onDisk = home => kindsOf(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).bots.b?.standingApprovals)
// Another dsh on this host holds the team: its pid answers, so this window only reads.
const holdElsewhere = home => writeFileSync(join(home, 'state.lock'), JSON.stringify({ pid: process.ppid, host: hostname(), token: 'the-other-window', since: Date.now() }))

async function start(t, grants, { locked = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'approval-silent-save-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(grants)))
  if (locked) holdElsewhere(home)
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async () => ({ agent: { session: { id: 'gb' }, calls: [], cancelled: [], inbox: { nextStep: [], nextTurn: [], remove: () => false }, followup() {}, steer() {}, cancel() {} } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  const ask = (toolName, reason) => ctx.listeners.get('approval/request')[0]({ agent: { session: { id: 'gb' } }, toolName, reason }, () => 'from-dsh')
  return { rt, ctx, home, ask }
}
const refused = outcome => {
  assert.notEqual(outcome, 'accepted', 'the store wrote nothing, yet the change reported success')
  return outcome
}

test('P-673: a read-only window refuses "Always allow" instead of keeping a grant the file does not hold', async (t) => {
  const { rt, home, ask } = await start(t, undefined, { locked: true })
  assert.match(String(rt.readOnly()), /open in another dsh/, 'the fixture is the read-only window')
  void ask('bash', 'escalate sandbox to danger-full-access: read AGENTS.md')
  const [card] = rt.approvalsView()
  assert.equal(card.answerable, true)

  const outcome = refused(await rt.answerApproval(card.id, 'always-bot').then(() => 'accepted', error => error))
  // The refusal is the host's own sentence, so the card can say why nothing changed.
  assert.match(String(outcome.message), /open in another dsh/)
  // The grant existed only in the failed call: memory equals the file, and the card still waits.
  assert.deepEqual(kindsOf(rt.botOf('b').standingApprovals), [], 'a grant the file never received stayed in memory')
  assert.deepEqual(onDisk(home), [], 'the file gained a grant')
  assert.deepEqual(rt.approvalsView().map(entry => entry.id), [card.id], 'the card was answered by a grant that was never saved')
  // And the next matching ask is a card again: a grant left in memory would have answered it
  // `allowed-once` on the owner's behalf and never drawn one.
  void ask('bash', 'escalate sandbox to danger-full-access: read AGENTS.md')
  assert.deepEqual(rt.approvalsView().map(entry => entry.answerable), [true, true], 'a grant the file never received answered the next ask')
})

test('P-673: a removed grant is refused when the read-only window cannot write the removal', async (t) => {
  const { rt, home } = await start(t, [{ kind: KIND, label: 'bash · danger-full-access', at: 1 }], { locked: true })
  assert.deepEqual(onDisk(home), [KIND], 'the fixture starts with the grant on disk')
  const outcome = refused(await rt.removeStandingApproval('bot', 'b', KIND).then(() => 'accepted', error => error))
  assert.match(String(outcome.message), /open in another dsh/)
  // Still on disk, so still in memory, and still answering the asks it covers.
  assert.deepEqual(kindsOf(rt.botOf('b').standingApprovals), [KIND], 'the settings card said "removed" while the grant still answered')
  assert.deepEqual(onDisk(home), [KIND], 'the file lost a grant the window never wrote')
})

test('P-673: a stopped host refuses "Always allow" instead of claiming a save it skipped', async (t) => {
  const { rt, ctx, ask } = await start(t)
  void ask('bash', 'escalate sandbox to danger-full-access: read AGENTS.md')
  const [card] = rt.approvalsView()
  await ctx.dispose()
  const outcome = refused(await rt.answerApproval(card.id, 'always-bot').then(() => 'accepted', error => error))
  assert.equal(typeof outcome.message, 'string')
  assert.deepEqual(kindsOf(rt.botOf('b').standingApprovals), [], 'the stopped host kept a grant it never wrote')
})

// The boundary: Allow once and Reject change nothing on disk on purpose, so a read-only window
// keeps answering them — `approval-answer` is in the channel's READS for exactly that (#2310).
test('P-673: a read-only window still answers Allow once and Reject, which write nothing', async (t) => {
  const { rt, ask } = await start(t, undefined, { locked: true })
  const first = ask('bash', 'escalate sandbox to danger-full-access: read AGENTS.md')
  const [card] = rt.approvalsView()
  await rt.answerApproval(card.id, 'allow')
  assert.equal(await first, 'allowed-once')
  const second = ask('pwsh', 'run the migration script')
  const [next] = rt.approvalsView()
  await rt.answerApproval(next.id, 'reject')
  assert.equal(await second, 'rejected')
  assert.equal(rt.approvalsView().length, 0)
})
