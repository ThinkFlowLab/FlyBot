// #2865: the temp a decision lands through is a name this write creates, not one it may write
// through. A link (or a folder) planted at `<decision file>.tmp-<8 hex>` used to take the bytes:
// `open(..., 'w')` follows the link, so the decision lands outside the folder and the `link` after
// it puts that link where the decision file belongs — with the tool still answering `decided`,
// because a decision is written before the answer (#1781) and nothing here would have noticed.
//
// The suffix comes from `randomBytes(4)`, so this test pins the generator with the same
// `syncBuiltinESMExports()` seam `meetings-decide-paths.test.js` uses to inject a refused write,
// and plants a real link/folder on disk at the name the write will ask for. Only the names are
// pinned; the check itself runs against the real filesystem.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const team = () => ({
  version: 2, revision: 1, mainBotIds: ['a'],
  members: { 'owner-1': { id: 'owner-1', createdAt: 1, designatedChiefId: 'a' } },
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Chief', sessionId: 'a', createdAt: 1, ownerId: 'owner-1' },
    d1: { id: 'd1', name: 'Dev', role: 'Dev', sessionId: 'd1', createdAt: 2, ownerId: 'owner-1', createdBy: 'a' },
    r1: { id: 'r1', name: 'Reviewer', role: 'Reviewer', sessionId: 'r1', createdAt: 3, ownerId: 'owner-1', createdBy: 'a' },
  },
  rooms: {}, grants: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {},
})

async function runtime(home) {
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
  return { ctx, rt }
}

async function setup(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-temp-name-home-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-temp-name-work-'))
  t.after(() => {
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  const first = await runtime(home)
  const meeting = (args, id = 'a') => first.ctx.registeredTools.get('meeting').execute(args, { agent: { id, session: { header: { cwd: dir } } } })
  return { home, dir, meeting, first }
}

const NOW = Date.UTC(2026, 10, 11, 12)
const DECISION_FILE = 'decisions/2026-11-11-which-storage-shape-should-stage-4-use.md'

const closeAll = async (meeting, id) => {
  for (const name of ['Chief', 'Dev', 'Reviewer']) await meeting({ action: 'position', meeting: id, as: name, stance: 'agree', text: `${name} agrees` })
}
const decide = (meeting, id, extra = {}) => meeting({
  action: 'decide', meeting: id, now: NOW, owner: 'Chief', decision: 'Use the existing store.', evidence: [{ pr: 1731 }], ...extra,
})
const openMeeting = async (meeting) => {
  const text = await meeting({ action: 'open', question: 'Which storage shape should Stage 4 use?', participants: ['Chief', 'Dev', 'Reviewer'] })
  const id = text.split(' ')[0]
  await closeAll(meeting, id)
  return id
}
const tempsIn = dir => (existsSync(join(dir, 'decisions')) ? readdirSync(join(dir, 'decisions')).filter(name => name.includes('.tmp-')) : [])

// Pin `randomBytes(4)` — the temp suffix — to the given names, one per call, and leave every other
// size (the meeting id asks for 5) on the real generator. Restoring the binding is part of the pin.
function pinSuffixes(...suffixes) {
  const original = crypto.randomBytes
  let next = 0
  crypto.randomBytes = (size, ...rest) => size === 4 && next < suffixes.length
    ? Buffer.from(suffixes[next++], 'hex')
    : original(size, ...rest)
  syncBuiltinESMExports()
  return () => {
    crypto.randomBytes = original
    syncBuiltinESMExports()
  }
}

// #2865: one planted link at the temp name must take no byte and must not become the decision
// file; the write moves on to a name of its own.
test('#2865: a link planted at the temp name takes no byte and does not become the decision file', async (t) => {
  const { dir, meeting, first } = await setup(t)
  const id = await openMeeting(meeting)
  mkdirSync(join(dir, 'decisions'))
  // The place the bytes would land if the temp name were followed, and the planted name itself.
  const outside = join(dir, 'outside.txt')
  writeFileSync(outside, 'outside\n')
  const planted = join(dir, `${DECISION_FILE}.tmp-deadbeef`)
  symlinkSync(outside, planted)
  const restore = pinSuffixes('deadbeef', 'cafebabe')
  t.after(restore)

  const answer = await decide(meeting, id)
  assert.match(answer, /\[decided\]/, 'the decision lands once the write has a temp name of its own')

  const record = first.rt.state.meetings[id]
  assert.equal(record.decisionFile, DECISION_FILE, 'the decision file keeps its own name')
  const info = lstatSync(join(dir, DECISION_FILE))
  assert.equal(info.isSymbolicLink(), false, 'the decision file is not the planted link')
  assert.equal(info.isFile(), true, 'the decision file is a plain file')
  assert.ok(readFileSync(join(dir, DECISION_FILE), 'utf8').includes('Use the existing store.'), 'the decision text is in the decision file')
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n', 'nothing outside the folder gained a byte')
  assert.equal(lstatSync(planted).isSymbolicLink(), true, 'the planted name is left as it was found')
  assert.deepEqual(tempsIn(dir), [DECISION_FILE.split('/')[1] + '.tmp-deadbeef'], 'the only temp left is the planted one')
})

// #2865: a folder at the temp name is not a name this write may take either.
test('#2865: a folder planted at the temp name does not take the decision file', async (t) => {
  const { dir, meeting, first } = await setup(t)
  const id = await openMeeting(meeting)
  mkdirSync(join(dir, 'decisions'))
  const planted = join(dir, `${DECISION_FILE}.tmp-deadbeef`)
  mkdirSync(planted)
  const restore = pinSuffixes('deadbeef', 'cafebabe')
  t.after(restore)

  const answer = await decide(meeting, id)
  assert.match(answer, /\[decided\]/)

  const record = first.rt.state.meetings[id]
  assert.equal(record.decisionFile, DECISION_FILE)
  assert.equal(lstatSync(join(dir, DECISION_FILE)).isFile(), true, 'the decision file is a plain file')
  assert.ok(readFileSync(join(dir, DECISION_FILE), 'utf8').includes('Use the existing store.'))
  assert.equal(lstatSync(planted).isDirectory(), true, 'the planted folder is left as it was found')
})

// #2865, the refusal half: a write that cannot find a free temp name refuses with the path it was
// tried under, and leaves no decision file behind — the folder is never renamed into place.
test('#2865: when every temp name is taken, decide refuses naming the temp path and archives nothing', async (t) => {
  const { dir, meeting, first } = await setup(t)
  const id = await openMeeting(meeting)
  mkdirSync(join(dir, 'decisions'))
  const outside = join(dir, 'outside.txt')
  writeFileSync(outside, 'outside\n')
  const planted = join(dir, `${DECISION_FILE}.tmp-deadbeef`)
  symlinkSync(outside, planted)
  // One name for every attempt: none of them can be claimed.
  const restore = pinSuffixes(...Array.from({ length: 8 }, () => 'deadbeef'))
  t.after(restore)

  const refusal = await decide(meeting, id).then(() => undefined, error => error)
  assert.equal(refusal?.code, 'meeting/exists', 'the refusal is the meeting write path, not a raw EEXIST')
  assert.match(String(refusal?.message), /2026-11-11-which-storage-shape-should-stage-4-use\.md\.tmp-deadbeef/, 'the refusal names the temp path')
  assert.equal(readFileSync(outside, 'utf8'), 'outside\n', 'nothing outside the folder gained a byte')
  assert.equal(existsSync(join(dir, DECISION_FILE)), false, 'no decision file was put in place')
  assert.equal(first.rt.state.meetings[id].status, 'deliberating', 'the meeting is still open for its retry')
})

// #2865, the positive half: no entry at the temp name changes nothing about the ordinary write, and
// the decision is still on disk after a restart (#1781/#209 semantics stay).
test('#2865: a temp name that is absent lands the decision, and a restart reads it back', async (t) => {
  const { home, dir, meeting, first } = await setup(t)
  const id = await openMeeting(meeting)

  const answer = await decide(meeting, id)
  assert.match(answer, /\[decided\]/)
  const record = first.rt.state.meetings[id]
  assert.equal(record.decisionFile, DECISION_FILE)
  assert.equal(lstatSync(join(dir, DECISION_FILE)).isFile(), true, 'the decision file is a plain file')
  assert.deepEqual(tempsIn(dir), [], 'no temp file survives the success')

  const again = await runtime(home)
  const read = await again.ctx.registeredTools.get('meeting').execute({ action: 'read', meeting: id }, { agent: { id: 'a', session: { header: { cwd: dir } } } })
  assert.match(read, /\[decided\]/, 'the restart reads the decided meeting')
  assert.ok(read.includes(`decision file: ${DECISION_FILE}`), 'and the file the decision was archived in')
  assert.ok(readFileSync(join(dir, DECISION_FILE), 'utf8').includes('Use the existing store.'), 'the archived bytes are readable after the restart')
})
