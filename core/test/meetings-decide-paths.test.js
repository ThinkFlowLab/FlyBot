// #1731 follow-ups on the `decide` path, all found on `07e2b98e`:
// - P-191: the decision was rendered, the temp written and the cards created before the produced
//   tasks were validated, so `- Tasks:` could never appear and a refused task left cards behind.
// - P-196: `decisions/<date>-<slug>.md` refused `exists` on the second decision of one day, so the
//   same question could not be decided twice and two questions sharing a slug could not both land.
// - P-192: `blocked` had no way back; the meeting stayed blocked for good.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: {
    'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' },
    'owner-2': { id: 'owner-2', createdAt: 2 },
  },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Chief', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
    d2: { id: 'd2', name: 'Other Dev', role: 'Dev', sessionId: 'd2', createdAt: 3, ownerId: 'owner-2' },
    r1: { id: 'r1', name: 'Reviewer', role: 'Reviewer', sessionId: 'r1', createdAt: 4, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {}, grants: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-meetings-paths-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async id => ({ agent: { session: { id }, id, status: 'idle', cancel() {} } }), selectModel: async () => {}, page: async () => ({ records: [], hasMore: false }) },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  await rt.load()
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-meetings-paths-work-'))
  const exec = (id = 'a') => ({ agent: { id, session: { header: { cwd: dir } } } })
  const meeting = (args, id = 'a') => ctx.registeredTools.get('meeting').execute(args, exec(id))
  const open = async (question, participants = ['Chief', 'Dev'], extra = {}) => {
    const text = await meeting({ action: 'open', question, participants, ...extra })
    return text.split(' ')[0]
  }
  const decide = async (id, extra = {}) => meeting({
    action: 'decide', meeting: id, owner: 'Chief', decision: 'Record the decision.', evidence: [{ pr: 1731 }], ...extra,
  })
  const closeAll = async (id) => {
    for (const name of ['Chief', 'Dev']) await meeting({ action: 'position', meeting: id, as: name, stance: 'agree', text: `${name} agrees` })
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, dir, exec, meeting, open, decide, closeAll, stop }
}

const filesIn = dir => (existsSync(join(dir, 'decisions')) ? readdirSync(join(dir, 'decisions')) : [])
const tempsIn = dir => filesIn(dir).filter(name => name.includes('.tmp-'))
const sha256 = text => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

// #1982: the "unwritable folder" has to be one on every platform. `chmodSync(folder, 0o555)` is
// a POSIX idea Windows ignores — the write succeeds, no EACCES is thrown, and the test fails for
// the wrong reason. Inject the refusal at the one call the decide path makes inside the folder
// (`claimTemp`'s `open` of its temp file in `decisions/`, meetings.js) and keep the assertions.
function refuseWritesUnder(folder) {
  const original = fsp.open
  fsp.open = async (path, ...args) => {
    if (typeof path === 'string' && path.startsWith(folder)) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES', path })
    }
    return original.call(fsp, path, ...args)
  }
  syncBuiltinESMExports()
  return () => {
    fsp.open = original
    syncBuiltinESMExports()
  }
}

// P-191: the file is rendered once, after the cards exist, so the ids it lists are the ids the
// meeting keeps — and the sha it records is the sha of the bytes on disk.
test('meetings: a decision lists the produced cards in its file, in order, under its sha', async (t) => {
  const { rt, dir, open, decide, closeAll, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await closeAll(id)
  await decide(id, { tasks: [{ botId: 'd1', title: 'Write the record' }, { botId: 'r1', title: 'Review the record' }] })
  const record = rt.state.meetings[id]
  const body = readFileSync(join(dir, record.decisionFile), 'utf8')
  assert.equal(record.taskIds.length, 2)
  assert.ok(body.includes(`- Tasks: ${record.taskIds.join(', ')}`), `the file lists the produced ids in order: ${record.taskIds.join(', ')}`)
  assert.equal(record.decisionSha256, sha256(body), 'the recorded sha covers the bytes that were archived')
  assert.match(await (async () => body)(), new RegExp(`- Tasks: ${record.taskIds[0]}, ${record.taskIds[1]}`))
})

// The other half of the same rule: a decision with no card has no `- Tasks:` line at all.
test('meetings: a decision that produces no card carries no Tasks line', async (t) => {
  const { rt, dir, open, decide, closeAll, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await closeAll(id)
  await decide(id)
  const record = rt.state.meetings[id]
  const body = readFileSync(join(dir, record.decisionFile), 'utf8')
  assert.equal(record.taskIds.length, 0)
  assert.ok(!/^- Tasks:/m.test(body), 'no card, no Tasks line')
  assert.equal(record.decisionSha256, sha256(body))
})

// P-191: a produced task that cannot be created takes the whole decide down before any card is
// written, leaving no temp file and no half-closed meeting.
test('meetings: a refused task writes no card at all, only the first one is not created', async (t) => {
  const { rt, dir, open, decide, closeAll, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await closeAll(id)
  await assert.rejects(
    decide(id, { tasks: [{ botId: 'd1', title: 'Write the record' }, { botId: 'ghost', title: 'Own nothing' }] }),
    /no Bot named ghost/,
  )
  assert.equal(Object.keys(rt.state.tasks ?? {}).length, 0, 'the valid task ahead of the refused one was not created')
  assert.deepEqual(tempsIn(dir), [], 'no temp file is left behind')
  assert.deepEqual(filesIn(dir), [], 'no decision file is archived')
  assert.equal(rt.state.meetings[id].status, 'deliberating', 'the meeting did not close')
})

// P-191: the authorization `task-create` applies is part of the same pre-check. The requester owns
// d1 and not d2, so the first card would have been written before the refusal without it.
test('meetings: an unauthorized produced task creates no card either', async (t) => {
  const { rt, dir, open, closeAll, stop } = await boot()
  t.after(stop)
  rt.state.authSessions = { s1: { memberId: 'owner-1' } }
  const id = await open('Which storage shape should Stage 4 use?')
  await closeAll(id)
  await assert.rejects(
    rt.meetingEndpoint('decide', {
      meeting: id, dir, owner: 'Chief', decision: 'Record the decision.', evidence: [{ pr: 1731 }],
      tasks: [{ botId: 'd1', title: 'Write the record' }, { botId: 'd2', title: 'Own nothing' }],
    }, { memberId: 'owner-1', name: 'Chief' }),
    /You cannot assign a task to that Bot/,
  )
  assert.equal(Object.keys(rt.state.tasks ?? {}).length, 0, 'no card is created before the gate answers')
  assert.deepEqual(filesIn(dir), [], 'no decision file is archived')
  assert.equal(rt.state.meetings[id].status, 'deliberating')
})

// P-196: one question decided twice on one day is two records; the earlier file is never rewritten.
test('meetings: the same question decided twice in a day keeps both files, the first untouched', async (t) => {
  const { rt, dir, meeting, open, decide, closeAll, stop } = await boot()
  t.after(stop)
  const first = await open('Which storage shape should Stage 4 use?')
  await closeAll(first)
  await decide(first)
  const firstFile = rt.state.meetings[first].decisionFile
  const firstBytes = readFileSync(join(dir, firstFile), 'utf8')

  const second = await open('which STORAGE shape should stage 4 use?')
  await meeting({ action: 'position', meeting: second, as: 'Chief', stance: 'agree', text: 'yes' })
  await meeting({ action: 'position', meeting: second, as: 'Dev', stance: 'agree', text: 'yes' })
  await decide(second, { decision: 'Record the decision, second sitting.' })

  const secondFile = rt.state.meetings[second].decisionFile
  assert.notEqual(secondFile, firstFile, 'the second decision takes its own name')
  assert.match(secondFile, /-2\.md$/)
  assert.equal(readFileSync(join(dir, firstFile), 'utf8'), firstBytes, 'the earlier decision is not rewritten')
  assert.deepEqual(filesIn(dir).sort(), [firstFile.replace('decisions/', ''), secondFile.replace('decisions/', '')].sort())
  assert.equal(rt.state.meetings[second].decisionSha256, sha256(readFileSync(join(dir, secondFile), 'utf8')))
})

// P-196: two different questions that fall back to one slug on one day also keep two files.
test('meetings: two different questions sharing a day and a slug keep two files', async (t) => {
  const { rt, dir, open, decide, closeAll, stop } = await boot()
  t.after(stop)
  const first = await open('Ship it?!')
  await closeAll(first)
  await decide(first)
  const second = await open('Ship it.')
  await closeAll(second)
  await decide(second, { decision: 'Ship it, after all.' })
  const one = rt.state.meetings[first].decisionFile
  const two = rt.state.meetings[second].decisionFile
  assert.match(one, /ship-it\.md$/)
  assert.match(two, /ship-it-2\.md$/)
  assert.deepEqual(filesIn(dir).sort(), [one.replace('decisions/', ''), two.replace('decisions/', '')].sort())
  for (const [id, file] of [[first, one], [second, two]]) {
    assert.equal(rt.state.meetings[id].decisionSha256, sha256(readFileSync(join(dir, file), 'utf8')), `${file} carries its own sha`)
  }
})

// P-192: `blocked` is not a dead end — the answer to the blocking question reopens the meeting with
// everything it recorded, and `decided` stays terminal.
test('meetings: a blocked meeting resumes on its answer and then decides', async (t) => {
  const { rt, meeting, open, decide, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?', ['Chief', 'Dev'], { options: ['the existing store', 'a second store'] })
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'the existing store' })
  await meeting({ action: 'position', meeting: id, as: 'Dev', stance: 'abstain', text: 'either' })
  await meeting({ action: 'block', meeting: id, blocking: 'Who owns the store long term?' })
  assert.equal(rt.state.meetings[id].status, 'blocked')
  assert.ok(rt.state.meetings[id].blockedAt !== undefined)

  const resumed = await meeting({ action: 'resume', meeting: id, answer: 'The Chief owns it.' })
  assert.match(resumed, new RegExp(`${id} \\[deliberating\\]`))
  assert.equal(rt.state.meetings[id].status, 'deliberating')
  assert.equal(rt.state.meetings[id].blockingAnswer, 'The Chief owns it.')
  assert.equal(rt.state.meetings[id].blockedAt, undefined, 'the blocked stamp is cleared')
  assert.equal(rt.state.meetings[id].blockingQuestion, 'Who owns the store long term?', 'the question stays on the record')
  assert.deepEqual(rt.state.meetings[id].options, ['the existing store', 'a second store'], 'the options are kept')
  assert.equal(rt.state.meetings[id].participants.find(p => p.name === 'Dev').position.stance, 'abstain', 'the positions are kept')

  await decide(id)
  assert.equal(rt.state.meetings[id].status, 'decided')
  // The endpoint keeps the refusal code the tool surface wraps; `decided` is terminal either way.
  await assert.rejects(
    rt.meetingEndpoint('resume', { meeting: id, answer: 'again' }, { name: 'Chief' }),
    error => error?.code === 'meeting/closed',
  )
})

// The retry half of P-191/P-196: a decide that wrote nothing does not consume a name, so the retry
// lands on the same one.
test('meetings: a failed decide retries onto the same file name', async (t) => {
  const { rt, dir, open, decide, closeAll, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await closeAll(id)
  await assert.rejects(decide(id, { tasks: [{ botId: 'ghost', title: 'Own nothing' }] }), /no Bot named ghost/)
  await decide(id, { tasks: [{ botId: 'd1', title: 'Write the record' }] })
  const file = rt.state.meetings[id].decisionFile
  assert.match(file, /-which-storage-shape-should-stage-4-use\.md$/)
  assert.deepEqual(filesIn(dir), [file.replace('decisions/', '')], 'exactly one file, under the name the retry chose')
})

// P-191: the gate meetings pre-flight through is the one `task-create` writes through, so it is
// asserted directly — a change to that closure must fail here even if every meeting path stays green.
test('meetings: the shared create gate admits a body its owner may create', async (t) => {
  const { rt, stop } = await boot()
  t.after(stop)
  rt.state.authSessions = { s1: { memberId: 'owner-1' } }
  const bot = rt.taskCanCreate(
    { botId: 'd1', title: 'Write the record', taskClass: 'deliverable', criteria: 'the record exists', evidence: [{ pr: 1731 }] },
    { memberId: 'owner-1', name: 'Chief' },
  )
  assert.equal(bot?.id, 'd1', 'the gate answers with the Bot it would create the card on')
})

test('meetings: the shared create gate refuses a missing Bot and another owner\'s Bot', async (t) => {
  const { rt, stop } = await boot()
  t.after(stop)
  rt.state.authSessions = { s1: { memberId: 'owner-1' } }
  const gate = body => rt.taskCanCreate(body, { memberId: 'owner-1', name: 'Chief' })
  assert.throws(() => gate({ botId: 'ghost', title: 'Own nothing' }), /No such Bot/)
  assert.throws(() => gate({ botId: 'd2', title: 'Own nothing' }), /You cannot assign a task to that Bot/)
})

// P-191 control: sharing the gate must not widen it. Green on the base too — this pins the refusal,
// not the defect, so a later change to the closure fails here even though the base already refused.
test('meetings: a Bot without task-create permission is still refused after the gate is shared', async (t) => {
  const { rt, stop } = await boot()
  t.after(stop)
  rt.state.authSessions = { s1: { memberId: 'owner-1' } }
  await assert.rejects(
    rt.taskEndpoint('task-create', { botId: 'd2', title: 'Own nothing' }, { memberId: 'owner-1', name: 'Chief' }),
    /You cannot assign a task to that Bot/,
  )
  assert.equal(Object.keys(rt.state.tasks ?? {}).length, 0, 'the refused create wrote no card')
})

// P-191: the pre-flight fails closed. A runtime that carries no tasks library must refuse the
// produced task — never skip the authorization and create the card anyway.
test('meetings: a host without the create gate refuses the produced task instead of creating it', async (t) => {
  const { rt, dir, open, decide, closeAll, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await closeAll(id)
  delete rt.taskCanCreate
  const refusal = await decide(id, { tasks: [{ botId: 'd1', title: 'Write the record' }] }).then(() => undefined, error => error)
  assert.equal(Object.keys(rt.state.tasks ?? {}).length, 0, 'no card is created when the host carries no create gate')
  assert.match(String(refusal?.message ?? ''), /You cannot assign a task to that Bot/, 'the refusal is the one task-create gives')
  assert.deepEqual(tempsIn(dir), [], 'no temp file is left behind')
  assert.deepEqual(filesIn(dir), [], 'no decision file is archived')
  assert.equal(rt.state.meetings[id].status, 'deliberating', 'the meeting did not close')
})

// P-205: the archive step that fails leaves nothing behind. The `decisions` folder is writable by
// name but not by content here, and the decide must fail before a card exists — the base created
// the card first, so every retry added one more.
test('meetings: a decide that cannot archive its file creates no card, and its retry creates none either', async (t) => {
  const { rt, dir, open, decide, closeAll, stop } = await boot()
  const folder = join(dir, 'decisions')
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await closeAll(id)
  mkdirSync(folder)
  const restore = refuseWritesUnder(folder)
  t.after(restore)

  for (const attempt of [1, 2]) {
    const refusal = await decide(id, { tasks: [{ botId: 'd1', title: 'Write the record' }] })
      .then(() => undefined, error => error)
    assert.equal(refusal?.code, 'EACCES', `attempt ${attempt} fails on the folder itself`)
    assert.equal(Object.keys(rt.state.tasks ?? {}).length, 0, `attempt ${attempt} creates no card`)
    assert.deepEqual(tempsIn(dir), [], `attempt ${attempt} leaves no temp file behind`)
    assert.deepEqual(filesIn(dir), [], `attempt ${attempt} archives no decision file`)
    assert.equal(rt.state.meetings[id].status, 'deliberating', `attempt ${attempt} leaves the meeting open`)
  }
})

// P-205: once the folder takes the write again the same decide lands on the name the failures
// would have used, and the ids its file lists are exactly the cards on the board.
test('meetings: a retry once the folder is writable archives the file and lists every card', async (t) => {
  const { rt, dir, open, decide, closeAll, stop } = await boot()
  const folder = join(dir, 'decisions')
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await closeAll(id)
  mkdirSync(folder)
  const restore = refuseWritesUnder(folder)
  try {
    await assert.rejects(decide(id, { tasks: [{ botId: 'd1', title: 'Write the record' }] }), /EACCES: permission denied/)
  } finally {
    restore()
  }

  await decide(id, { tasks: [{ botId: 'd1', title: 'Write the record' }, { botId: 'r1', title: 'Review the record' }] })
  const record = rt.state.meetings[id]
  const body = readFileSync(join(dir, record.decisionFile), 'utf8')
  assert.match(record.decisionFile, /-which-storage-shape-should-stage-4-use\.md$/, 'the retry keeps the name the failures left free')
  assert.deepEqual(filesIn(dir), [record.decisionFile.replace('decisions/', '')], 'exactly one file, under that name')
  assert.equal(record.status, 'decided')
  assert.equal(record.taskIds.length, 2, 'both produced tasks are on the record')
  assert.equal(Object.keys(rt.state.tasks).length, 2, 'and both are on the board')
  assert.equal(record.taskIds.length, body.split('\n').filter(line => line.startsWith('- Tasks: '))[0].slice('- Tasks: '.length).split(', ').length, 'the file lists as many ids as the record keeps')
  assert.ok(body.includes(`- Tasks: ${record.taskIds.join(', ')}`), 'the file lists the kept ids in order')
  assert.equal(record.decisionSha256, sha256(body), 'the recorded sha covers the archived bytes')
  assert.equal(record.pendingTaskIds, undefined, 'a decided meeting carries no retry bookkeeping')
  assert.deepEqual(tempsIn(dir), [], 'no temp file survives the success')
})

// P-205, the window no filesystem lever opens in-process: a decide that died between the cards and
// the finished file left its ids on the meeting record. The retry must keep those cards rather than
// create a second one for the same produced task — and the file it writes lists the kept card.
test('meetings: a retry after the cards exist keeps them instead of creating another', async (t) => {
  const { rt, dir, open, decide, closeAll, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await closeAll(id)
  // The card an earlier attempt created, and the record it left behind: ids on the meeting, the
  // meeting still `deliberating`, no file.
  const card = await rt.taskEndpoint('task-create', { botId: 'd1', title: 'Write the record' }, { name: 'Chief', role: 'Chief' })
  rt.state.meetings[id].pendingTaskIds = [card.id]

  // Two more attempts while the folder still refuses the write: neither adds a card, and neither
  // leaves a file or a temp behind.
  const folder = join(dir, 'decisions')
  mkdirSync(folder)
  const restore = refuseWritesUnder(folder)
  t.after(restore)
  for (const attempt of [1, 2]) {
    await assert.rejects(decide(id, { tasks: [{ botId: 'd1', title: 'Write the record' }] }), /EACCES: permission denied/, `attempt ${attempt} still fails on the folder`)
    assert.deepEqual(Object.keys(rt.state.tasks), [card.id], `attempt ${attempt} adds no second card`)
    assert.deepEqual(filesIn(dir), [], `attempt ${attempt} archives nothing`)
    assert.deepEqual(tempsIn(dir), [], `attempt ${attempt} leaves no temp behind`)
  }
  restore()

  await decide(id, { tasks: [{ botId: 'd1', title: 'Write the record' }] })
  const record = rt.state.meetings[id]
  const body = readFileSync(join(dir, record.decisionFile), 'utf8')
  assert.deepEqual(Object.keys(rt.state.tasks), [card.id], 'the retry built no second card')
  assert.deepEqual(record.taskIds, [card.id], 'the record keeps the card the first attempt made')
  assert.ok(body.includes(`- Tasks: ${card.id}`), 'the file names that card')
  assert.equal(record.pendingTaskIds, undefined, 'the bookkeeping is gone once the file lands')
  assert.deepEqual(filesIn(dir), [record.decisionFile.replace('decisions/', '')], 'one file, no second temp')
})
