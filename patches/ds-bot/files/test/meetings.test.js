// #1731 (Stage 4.1): a meeting is a record with a lifecycle, and a `decided` meeting must pass a
// governance check written as code before it writes one archived decision and produces tasks.
// These tests hold the refusals — a missing position, a missing owner, a dissent without its
// owner, a second open meeting on one question — and the end-to-end path from question to
// decision file to linked tasks. A `blocked` meeting writes no file and no task.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2,
  revision: 1,
  mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Chief', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
    r1: { id: 'r1', name: 'Reviewer', role: 'Reviewer', sessionId: 'r1', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
    pa: { id: 'pa', name: 'Project Assistant (X)', role: 'Project Assistant', sessionId: 'pa', createdAt: 4, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {}, grants: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function boot() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-meetings-'))
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
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-meetings-work-'))
  const exec = (id = 'a') => ({ agent: { id, session: { header: { cwd: dir } } } })
  const meeting = (args, id = 'a') => ctx.registeredTools.get('meeting').execute(args, exec(id))
  const open = async (question, participants = ['Chief', 'Dev', 'Reviewer'], extra = {}) => {
    const text = await meeting({ action: 'open', question, participants, ...extra })
    return text.split(' ')[0]
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
  return { ctx, rt, dir, exec, meeting, open, stop }
}

const positionAll = async (meeting, id) => {
  for (const name of ['Chief', 'Dev', 'Reviewer']) await meeting({ action: 'position', meeting: id, as: name, stance: 'agree', text: `${name} agrees` })
}

test('#1731: decided refuses without a position from every invited participant', async (t) => {
  const { meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'the existing store' })
  await meeting({ action: 'position', meeting: id, as: 'Dev', stance: 'agree', text: 'the existing store' })
  await assert.rejects(
    meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Use the existing store.', evidence: [{ pr: 1731 }] }),
    /no position recorded for: Reviewer/,
  )
})

test('#1731: decided refuses without a named owner', async (t) => {
  const { meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await positionAll(meeting, id)
  await assert.rejects(
    meeting({ action: 'decide', meeting: id, decision: 'Use the existing store.', evidence: [{ pr: 1731 }] }),
    /names no owner/,
  )
})

test('#1731: a dissent with no owner is refused', async (t) => {
  const { meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await positionAll(meeting, id)
  await assert.rejects(
    meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Use the existing store.', dissent: { text: 'a new store is cleaner' }, evidence: [{ pr: 1731 }] }),
    /dissent is written down without its owner/,
  )
})

test('#1731: blocked writes no decision file and produces no task', async (t) => {
  const { ctx, rt, dir, meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await meeting({ action: 'block', meeting: id, blocking: 'Nobody can name the store owner.' })
  assert.equal(rt.state.meetings[id].status, 'blocked')
  assert.equal(existsSync(join(dir, 'decisions')), false, 'a blocked meeting archives nothing')
  assert.equal(Object.keys(rt.state.tasks ?? {}).length, 0, 'a blocked meeting produces no task')
  assert.equal(ctx.registeredTools.get('meeting') !== undefined, true)
})

test('#1731: a second open meeting on the same question is refused', async (t) => {
  const { open, stop } = await boot()
  t.after(stop)
  await open('Which storage shape should Stage 4 use?')
  await assert.rejects(open('  which   STORAGE shape should stage 4 use? '), /already open: meeting-/)
})

test('#1731: a decision file carries participants, owner and evidence shas, and linked tasks carry the file', async (t) => {
  const { rt, dir, meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?', ['Chief', 'Dev', 'Reviewer'], { issue: 1731 })
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'the existing store' })
  await meeting({ action: 'position', meeting: id, as: 'Dev', stance: 'agree', text: 'the existing store, one collection' })
  await meeting({ action: 'position', meeting: id, as: 'Reviewer', stance: 'dissent', text: 'a separate meetings file is easier to audit' })
  const sha = 'a'.repeat(40)
  await meeting({
    action: 'decide', meeting: id, owner: 'Chief', class: 'major',
    decision: 'Meetings live in the existing store; decisions are one markdown file each.',
    evidence: [{ sha }, { pr: 1731 }],
    tasks: [{ assignee: 'Dev', title: 'Write the meetings tests' }],
  })
  const record = rt.state.meetings[id]
  assert.equal(record.status, 'decided')
  assert.match(record.decisionFile, /^decisions\/\d{4}-\d{2}-\d{2}-which-storage-shape.*\.md$/)
  const body = readFileSync(join(dir, record.decisionFile), 'utf8')
  for (const name of ['Chief', 'Dev', 'Reviewer']) assert.ok(body.includes(`**${name}**`), `${name} is in the record`)
  assert.ok(body.includes(sha), 'the evidence sha is in the record')
  assert.ok(body.includes('a separate meetings file is easier to audit — **Reviewer**'), 'dissent carries its owner')
  assert.match(body, /Written-by: Chief/)
  assert.equal(record.decisionSha256.length, 64)
  const tasks = Object.values(rt.state.tasks)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].taskClass, 'work')
  assert.equal(tasks[0].evidence[0].check, record.decisionFile)
})

test('#1731: a Project Assistant takes a position but does not close the meeting', async (t) => {
  const { meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?', ['Chief', 'Project Assistant (X)'])
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'the existing store' })
  await meeting({ action: 'position', meeting: id, as: 'Project Assistant (X)', stance: 'agree', text: 'the existing store' }, 'pa')
  await assert.rejects(
    meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Use the existing store.', evidence: [{ pr: 1731 }] }, 'pa'),
    /does not close the meeting/,
  )
})

test('#1731: question → positions → decided → one decision file → linked task, end to end', async (t) => {
  const { rt, dir, meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Should Stage 4.1 record meetings in the existing store?', ['Chief', 'Dev'], { issue: 1731, title: 'Stage 4.1 meeting storage' })
  assert.equal(rt.state.meetings[id].status, 'open')
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'yes' })
  assert.equal(rt.state.meetings[id].status, 'deliberating')
  await meeting({ action: 'position', meeting: id, as: 'Dev', stance: 'agree', text: 'yes, no second store' })
  await meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Record meetings in the existing store and archive one decision file.', evidence: [{ pr: 1731 }], tasks: [{ botId: 'd1', title: 'Ship the record' }] })
  assert.equal(rt.state.meetings[id].status, 'decided')
  assert.deepEqual(readdirSync(join(dir, 'decisions')), [rt.state.meetings[id].decisionFile.replace('decisions/', '')])
  assert.equal(Object.values(rt.state.tasks).length, 1)
  assert.equal(Object.values(rt.state.tasks)[0].evidence[0].check, rt.state.meetings[id].decisionFile)
})

test('#1731: a refused produced task archives nothing, leaves the meeting open, and a retry succeeds', async (t) => {
  const { rt, dir, meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await positionAll(meeting, id)
  await assert.rejects(
    meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Use the existing store.', evidence: [{ pr: 1731 }], tasks: [{ botId: 'ghost', title: 'x' }] }),
    /no Bot named ghost/,
  )
  assert.deepEqual(existsSync(join(dir, 'decisions')) ? readdirSync(join(dir, 'decisions')) : [], [], 'a refused task archives no decision file')
  assert.equal(rt.state.meetings[id].status, 'deliberating', 'the meeting did not close')
  await meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Use the existing store.', evidence: [{ pr: 1731 }], tasks: [{ botId: 'd1', title: 'Ship the record' }] })
  assert.equal(rt.state.meetings[id].status, 'decided', 'the valid retry closes the meeting')
  assert.equal(readdirSync(join(dir, 'decisions')).length, 1, 'exactly one decision file appears')
})

test('#1731: a refused decision writes no decision text onto the stored meeting', async (t) => {
  const { rt, meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?')
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'the existing store' })
  await assert.rejects(
    meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'A decision nobody was present for.', evidence: [{ pr: 1731 }] }),
    /no position recorded for: Dev, Reviewer/,
  )
  assert.equal(rt.state.meetings[id].decision, undefined, 'the refused decision text is not stored')
  assert.equal(rt.state.meetings[id].owner, undefined, 'the refused owner is not stored')
  assert.equal(rt.state.meetings[id].evidence.length, 0, 'the refused evidence is not stored')
  await positionAll(meeting, id)
  await meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Use the existing store.', evidence: [{ pr: 1731 }] })
  assert.equal(rt.state.meetings[id].status, 'decided')
})

test('#1731: a participant recorded silent lets the meeting close', async (t) => {
  const { rt, dir, meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Which storage shape should Stage 4 use?', ['Chief', 'Dev'])
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'the existing store' })
  await meeting({ action: 'position', meeting: id, as: 'Dev', silent: true })
  await meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Use the existing store.', evidence: [{ pr: 1731 }] })
  assert.equal(rt.state.meetings[id].status, 'decided')
  const body = readFileSync(join(dir, rt.state.meetings[id].decisionFile), 'utf8')
  assert.match(body, /\*\*Dev\*\* — invited; recorded no position \(silent\)/)
})

test('#1731: two Chinese questions decided on one day keep separate decision files', async (t) => {
  const { rt, dir, meeting, open, stop } = await boot()
  t.after(stop)
  const first = await open('会议记录应该放在现有 store 里吗？', ['Chief'])
  await meeting({ action: 'position', meeting: first, as: 'Chief', stance: 'agree', text: '是' })
  await meeting({ action: 'decide', meeting: first, owner: 'Chief', decision: '记录放现有 store。', evidence: [{ pr: 1731 }] })
  const second = await open('会议记录应该单独建一个库吗？', ['Chief'])
  await meeting({ action: 'position', meeting: second, as: 'Chief', stance: 'abstain', text: '否' })
  await meeting({ action: 'decide', meeting: second, owner: 'Chief', decision: '不单独建库。', evidence: [{ pr: 1731 }] })
  const files = [rt.state.meetings[first].decisionFile, rt.state.meetings[second].decisionFile]
  assert.notEqual(files[0], files[1])
  assert.deepEqual(readdirSync(join(dir, 'decisions')).sort(), files.map(f => f.replace('decisions/', '')).sort())
})

// #1861: a Project Chief or an owner's agent speaks for a person. The position is recorded once,
// the record says whose it is, and a severe decision may not rest on a proxy alone.
test('#1861: a proxy position is stored, counted once, and the record names whom it speaks for', async (t) => {
  const { rt, dir, meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Who holds the storage decision?', ['Chief', 'Owner', { name: 'Project Chief', speaksFor: 'Owner' }])
  const text = await meeting({ action: 'position', meeting: id, as: 'Project Chief', stance: 'agree', text: 'the existing store', speaksFor: 'Owner' })
  assert.match(text, /positions 1\/3/)
  assert.match(text, /Project Chief: agree — the existing store \(speaks for Owner\)/)
  const stored = rt.state.meetings[id].participants.find(p => p.name === 'Project Chief')
  assert.equal(stored.speaksFor, 'Owner')
  assert.equal(stored.position.speaksFor, 'Owner')
  // The same position read again is one position, not two.
  await meeting({ action: 'position', meeting: id, as: 'Owner', silent: true })
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'the existing store' })
  await meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Use the existing store.', evidence: [{ pr: 1861 }] })
  const body = readFileSync(join(dir, rt.state.meetings[id].decisionFile), 'utf8')
  assert.match(body, /\*\*Project Chief\*\* — agree — the existing store \(speaks for Owner\)/)
  assert.match(body, /Written-by: Chief/)
})

test('#1861: a severe decision is refused when its only agree position is a proxy and the person is absent', async (t) => {
  const { rt, dir, meeting, open, stop } = await boot()
  t.after(stop)
  const id = await open('Should the storage migration be irreversible?', ['Chief', 'Owner', 'Reviewer'], { level: 'severe' })
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'ship it', speaksFor: 'Owner' })
  await meeting({ action: 'position', meeting: id, as: 'Reviewer', stance: 'dissent', text: 'wait' })
  await assert.rejects(
    meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Ship the migration.', evidence: [{ pr: 1861 }] }),
    /governance: the agree side of a severe decision rests only on a proxy: Owner must take the position itself or be recorded silent/,
  )
  assert.equal(rt.state.meetings[id].status, 'deliberating')
  assert.equal(existsSync(join(dir, 'decisions')), false, 'a refused severe decision writes no file')
  // The same proxy carries it once the person is recorded silent, and the file says so.
  await meeting({ action: 'position', meeting: id, as: 'Owner', silent: true })
  await meeting({ action: 'decide', meeting: id, owner: 'Chief', decision: 'Ship the migration.', evidence: [{ pr: 1861 }] })
  const body = readFileSync(join(dir, rt.state.meetings[id].decisionFile), 'utf8')
  assert.match(body, /\*\*Owner\*\* — invited; recorded no position \(silent\)/)
  assert.match(body, /\*\*Chief\*\* — agree — ship it \(speaks for Owner\)/)
})

test('#1861: the decision card exposes the participants and their proxies', async (t) => {
  const { rt, open, meeting, stop } = await boot()
  t.after(stop)
  const { decisionCardOf } = await import('../src/host/project-board.js')
  const id = await open('Who holds the storage decision?', ['Chief', 'Owner'])
  await meeting({ action: 'position', meeting: id, as: 'Chief', stance: 'agree', text: 'ship it', speaksFor: 'Owner' })
  const card = decisionCardOf(rt.state.meetings[id])
  assert.deepEqual(card.participants, [
    { name: 'Chief', speaksFor: 'Owner', stance: 'agree', silent: false },
    { name: 'Owner', speaksFor: null, stance: null, silent: false },
  ])
})
