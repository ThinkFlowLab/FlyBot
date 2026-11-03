import assert from 'node:assert/strict'
import { test } from 'node:test'
import { personalRoster, requirePersonalSession } from '../src/host/workbench-personal.js'

test('personal space retains original identities and excludes Project carriers and foreign histories', () => {
  const state = { mainBotIds: ['chief'], bots: { chief: { id: 'chief', ownerId: 'alice', instructions: 'Original persona', workDir: '/private/path' }, foreign: { id: 'foreign', ownerId: 'bob' }, public: { id: 'public', ownerId: 'alice', projectAgent: { visibility: 'public' } } }, rooms: { own: { id: 'own', members: ['chief'] }, foreign: { id: 'foreign', members: ['foreign'] }, mixed: { id: 'mixed', members: ['public'] } } }
  const rt = { state, botOwnedBy: (actor, id) => state.bots[id]?.ownerId === actor.memberId, roomMemberOf: (_, id) => ['own', 'mixed'].includes(id), roomOwnedBy: () => false, botOf: id => state.bots[id], roomOf: id => state.rooms[id] }
  const actor = { memberId: 'alice' }
  const roster = personalRoster(rt, actor)
  assert.deepEqual(roster.bots.map(row => row.id), ['chief'])
  assert.deepEqual(roster.rooms.map(row => row.id), ['own'])
  assert.deepEqual(roster.mainBotIds, ['chief'])
  assert.equal(roster.bots[0].instructions, 'Original persona')
  assert.equal(roster.bots[0].workDir, undefined)
  assert.equal(requirePersonalSession(rt, actor, 'chief'), 'chief')
  for (const id of ['foreign', 'public', 'mixed', '__proto__']) assert.throws(() => requirePersonalSession(rt, actor, id), /personal conversation/)
})

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

test('personal HTTP projection reuses original history and fences logout during paging', async t => {
  const home = mkdtempSync(join(tmpdir(), 'personal-channel-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ version: 2, revision: 1, mainBotIds: ['chief'], members: { 'owner-1': { id: 'owner-1' }, bob: { id: 'bob' } }, bots: { chief: { id: 'chief', name: 'Original Chief', ownerId: 'owner-1', sessionId: 'chief', createdAt: 1 }, other: { id: 'other', name: 'Bob', ownerId: 'bob', sessionId: 'other', createdAt: 1 } }, rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, grants: {} }))
  const ctx = fakeContext()
  let route, release, revoked = false, delayed = false
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = options => { if (options.path.endsWith('bot')) route = options; return register(options) }
  ctx.sessionController = { page: async () => {
    if (delayed) await new Promise(resolve => { release = resolve })
    return { records: [{ event: { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'Original history' }] } } } }], hasMore: false }
  }
  }
  const rt = createRuntime(ctx, { home, projectWorkbench: true })
  await rt.load()
  rt.authenticate = async token => revoked ? null : token === 'alice' ? { memberId: 'owner-1' } : { memberId: 'bob' }
  const nativeMessages = []
  let stopped = 0
  rt.resolveAgent = async id => ({ session: { id, seq: 2 }, cancel() { stopped++ }, followup(message) { nativeMessages.push(message) }, steer(message) { nativeMessages.push(message) } })
  rt.state.questions.chief = { id: 'question-own', question: 'Which branch?', options: [{ label: 'main' }], allowCustom: true }
  rt.state.questions.other = { id: 'question-other', question: 'Private Bob question' }
  rt.approvalsView = () => [{ id: 'approve-own', sessionId: 'chief', botId: 'chief', tool: 'read_file', reason: 'Read scope', answerable: true }, { id: 'approve-other', sessionId: 'other', botId: 'other', tool: 'private' }]
  const decisions = []
  rt.answerApproval = async (id, choice) => { decisions.push({ id, choice }) }
  t.after(async () => { release?.(); await ctx.dispose(); rmSync(home, { recursive: true, force: true }) })
  const call = async (operation, id, token = 'alice', extra = {}) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', headers: { 'x-flybot-member-session': token }, body: JSON.stringify({ endpoint: 'personal-space', payload: { operation, id, ...extra } }) }))).json()
  assert.equal((await call('list')).value.bots[0].id, 'chief')
  assert.equal((await call('read', 'chief')).value.messages[0].text, 'Original history')
  assert.equal((await call('read', 'chief', 'bob')).ok, false)
  const controls = (await call('read', 'chief')).value
  assert.equal(controls.question.id, 'question-own')
  assert.equal((await call('dismiss', 'chief', 'alice', { questionId: 'stale-question' })).ok, false)
  assert.equal(rt.state.questions.chief.id, 'question-own')
  assert.deepEqual(controls.approvals.map(row => row.id), ['approve-own'])
  assert.equal((await call('stop', 'chief', 'bob')).ok, false)
  assert.equal(stopped, 0)
  assert.equal((await call('stop', 'chief')).ok, true)
  assert.equal(stopped, 1)
  assert.equal((await call('approval', 'chief', 'alice', { approvalId: 'approve-other', choice: 'allow' })).ok, false)
  assert.equal(decisions.length, 0)
  assert.equal((await call('approval', 'chief', 'alice', { approvalId: 'approve-own', choice: 'allow' })).ok, true)
  assert.deepEqual(decisions, [{ id: 'approve-own', choice: 'allow' }])
  rt.state.rooms.group = { id: 'group', name: 'Original group', members: ['chief', 'other'], participants: [{ kind: 'human', id: 'owner-1', joinedSeq: 0 }] }
  await rt.save()
  rt.roomWorkView = () => ({ group: [{ botId: 'chief', tool: 'read_file' }, { botId: 'other', tool: 'bash' }] })
  const memberStops = []
  rt.stopMemberWork = async (room, bot) => { memberStops.push({ room, bot }); return true }
  const groupRead = await call('read', 'group')
  assert.equal(groupRead.ok, true, JSON.stringify(groupRead))
  const groupWork = groupRead.value.groupWork
  assert.deepEqual(groupWork.map(row => row.canStop), [true, false])
  assert.equal((await call('member-stop', 'group', 'alice', { botId: 'other' })).ok, false)
  assert.equal(memberStops.length, 0)
  assert.equal((await call('member-stop', 'group', 'alice', { botId: 'chief' })).ok, true)
  assert.deepEqual(memberStops, [{ room: 'group', bot: 'chief' }])

  rt.memoryEndpoint = async () => ({ entries: [{ scope: 'own', text: 'My memory' }, { scope: 'team', text: 'Other members' }] })
  assert.deepEqual((await call('memory', 'chief')).value.entries, [{ scope: 'own', text: 'My memory' }])
  const normalPage = ctx.sessionController.page
  const image = { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'photo.png', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
  ctx.sessionController.page = async () => ({ records: [{ event: { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: image }] } } }], hasMore: false })
  let attachmentReads = 0
  ctx.sessionController.attachment = async request => { attachmentReads++; assert.equal(request.sessionId, 'chief'); return { attachment: image, data: 'AA==' } }
  const attachmentMessages = (await call('read', 'chief')).value.messages
  assert.equal(attachmentMessages.length, 1, 'image-only native messages stay visible')
  assert.equal(attachmentMessages[0].attachments[0].id, image.attachmentId)
  assert.equal((await call('attachment-read', 'chief', 'bob', { seq: 1, attachmentId: image.attachmentId })).ok, false)
  assert.equal((await call('attachment-read', 'chief', 'alice', { seq: 1, attachmentId: 'sha256:' + 'b'.repeat(64) })).ok, false)
  assert.equal(attachmentReads, 0)
  assert.equal((await call('attachment-read', 'chief', 'alice', { seq: 1, attachmentId: image.attachmentId })).value.data, 'AA==')
  assert.equal(attachmentReads, 1)
  rt.ensureCapabilities = async () => {}
  ctx.sessions = { flush: async () => {} }
  ctx.attachments = { admitPromptContent: async content => content, admitEncodedFile: async file => ({ attachmentId: 'sha256:' + 'c'.repeat(64), name: file.name, bytes: Buffer.from(file.data, 'base64').length }) }
  assert.equal((await call('send', 'chief', 'alice', { text: '', images: [{ name: 'photo.png', mediaType: 'image/png', data: 'AA==' }] })).ok, true)
  assert.deepEqual(nativeMessages[0].content, [{ type: 'image', name: 'photo.png', mediaType: 'image/png', data: 'AA==' }])
  assert.equal((await call('send', 'chief', 'bob', { text: '', images: [{ mediaType: 'image/png', data: 'AA==' }] })).ok, false)
  assert.equal(nativeMessages.length, 1)
  assert.equal((await call('send', 'chief', 'alice', { text: 'Read', files: [{ name: 'spec.txt', data: 'SGk=' }] })).ok, true)
  assert.equal(nativeMessages[1].content[1].type, 'file')
  assert.equal(nativeMessages[1].content[1].attachment.name, 'spec.txt')
  assert.equal((await call('send', 'group', 'alice', { text: 'Read this document', files: [{ name: 'spec.txt', data: 'SGk=' }] })).ok, true)
  const groupMessage = (await call('read', 'group')).value.messages.at(-1)
  assert.equal(groupMessage.attachments[0].name, 'spec.txt')
  let fileReads = 0
  ctx.attachments.readFileStream = async function* () { fileReads++; yield Buffer.from('Hi') }
  assert.equal((await call('attachment-read', 'group', 'bob', { seq: groupMessage.attachments[0].seq, attachmentId: groupMessage.attachments[0].id })).ok, false)
  assert.equal(fileReads, 0)
  const groupFile = await call('attachment-read', 'group', 'alice', { seq: groupMessage.attachments[0].seq, attachmentId: groupMessage.attachments[0].id })
  assert.equal(groupFile.ok, true, JSON.stringify(groupFile))
  assert.equal(groupFile.value.data, 'SGk=')
  assert.equal(fileReads, 1)
  ctx.attachments.admitEncodedFile = async file => { revoked = true; return { attachmentId: 'sha256:' + 'c'.repeat(64), name: file.name, bytes: 2 } }
  assert.equal((await call('send', 'chief', 'alice', { text: 'Read', files: [{ name: 'spec.txt', data: 'SGk=' }] })).ok, false)
  assert.equal(nativeMessages.length, 3, 'revocation during registration cannot publish a message')
  revoked = false
  ctx.sessionController.page = normalPage
  delayed = true
  const pending = call('read', 'chief')
  for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setTimeout(resolve, 2))
  assert.ok(release)
  revoked = true; release()
  assert.equal((await pending).ok, false)
})

import { personalToolRows } from '../src/host/workbench-personal.js'
test('personal tool projection excludes hidden turns, arguments and non-text content and bounds redacted output', () => {
  const event = (type, data) => ({ event: { type, data } })
  const rows = personalToolRows([
    event('tool/call', { turn: 1, callId: 'hidden', name: 'bash' }),
    event('tool/result', { message: { toolCallId: 'hidden', content: [{ type: 'text', text: 'Private exchange' }] } }),
    event('tool/call', { turn: 2, callId: 'own', name: 'read_file', arguments: { secret: 'No arguments' } }),
    event('tool/result', { message: { toolCallId: 'own', content: [{ type: 'text', text: 'sk-abcdefghijklmnop ' + 'x'.repeat(5000) }, { type: 'image', url: 'file:///private/image' }] } }),
  ], new Set([1]), text => text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'own')
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].text.includes('sk-abcdefghijklmnop'), false)
  assert.ok(rows[0].text.length <= 2000)
  assert.equal(JSON.stringify(rows).includes('No arguments'), false)
  assert.equal(JSON.stringify(rows).includes('file:///'), false)
})

import { createPersonalStreams } from '../src/host/workbench-personal.js'
test('native personal streams use only current own Session, hide exchange turns and clean up on exit', async () => {
  const bot = { id: 'own', name: 'Original Chief' }
  const rt = { state: { exchangeTurns: {} }, botOf: id => id === 'own' ? bot : undefined, selfOf: id => id === 'session' ? 'own' : undefined, chatOf: () => 'session', live: new Map([['session', { turn: 4 }]]), redactSecrets: text => text.replaceAll('saved-secret', '[hidden]') }
  const streams = createPersonalStreams(rt)
  async function* chunks() { yield { type: 'text-delta', text: '**Hello** saved-secret' }; yield { type: 'text-delta', text: ' world' } }
  const running = streams.stream('session', chunks)
  await running.next()
  assert.equal(streams.read('session').text, '**Hello** [hidden]')
  assert.equal(streams.read('other'), null)
  rt.state.exchangeTurns.session = [4]
  assert.equal(streams.read('session'), null)
  rt.state.exchangeTurns.session = []
  rt.live.set('session', { turn: 5 })
  assert.equal(streams.read('session'), null)
  await running.return()
  assert.equal(streams.read('session'), null)
})

import { personalQuestion } from '../src/host/workbench-personal.js'
test('personal group questions expose only answerable public card fields, never native routing authority', () => {
  const rt = { state: { questions: { group: { id: 'q', botId: 'own', question: 'Choose', options: [{ label: 'A' }], replyTo: { botId: 'private-source' }, origin: 'owner', secret: 'private' } } }, botOf: () => undefined, botOwnedBy: (actor, id) => actor.memberId === 'alice' && id === 'own', roomOwnedBy: () => false }
  const card = personalQuestion(rt, 'group', { memberId: 'alice' })
  assert.equal(card.id, 'q')
  for (const field of ['botId', 'replyTo', 'origin', 'secret']) assert.equal(card[field], undefined)
  assert.equal(personalQuestion(rt, 'group', { memberId: 'bob' }), null)
})

import { personalImageContent, personalMessageAttachments } from '../src/host/workbench-personal.js'
test('personal image admission accepts uploaded bytes, not arbitrary durable references or active content', () => {
  assert.deepEqual(personalImageContent('look', [{ mediaType: 'image/png', data: 'AA==', name: '/tmp/photo.png' }]), [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'AA==', name: 'photo.png' }])
  for (const image of [{ attachmentId: 'sha256:' + 'a'.repeat(64) }, { mediaType: 'image/svg+xml', data: 'AA==' }, { mediaType: 'image/png', data: 'not-base64' }, { mediaType: 'image/png', data: Buffer.alloc(256 * 1024 + 1).toString('base64') }]) assert.throws(() => personalImageContent('', [image]))
  const rows = personalMessageAttachments({ type: 'user/message', seq: 3, data: { content: [{ type: 'file', attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), name: '../../spec.txt', bytes: 2, path: '/private' } }] } })
  assert.equal(rows[0].name, 'spec.txt')
  assert.equal(rows[0].path, undefined)
  assert.equal(rows[0].seq, 3)
})

import { personalUploadContent } from '../src/host/workbench-personal.js'
test('native file registration prevalidates the complete batch and preserves native file references', async () => {
  const saved = []
  const store = { admitEncodedFile: async input => { saved.push(input); return { attachmentId: 'sha256:' + 'd'.repeat(64), name: input.name, bytes: 2 } }, admitPromptContent: async content => content }
  await assert.rejects(personalUploadContent(store, '', [], [{ name: 'first.txt', data: 'SGk=' }, { name: 'invalid', data: 'not base64' }]))
  assert.equal(saved.length, 0)
  const content = await personalUploadContent(store, 'Read', [], [{ name: '../../spec.txt', data: 'SGk=' }])
  assert.equal(content[1].type, 'file')
  assert.equal(content[1].attachment.name, 'spec.txt')
  assert.deepEqual(saved, [{ name: 'spec.txt', data: 'SGk=' }])
})

test('Project-associated original groups retain their history ACL and require current Project access', () => {
  const actor = { memberId: 'alice' }, state = { mainBotIds: ['chief'], bots: { chief: { id: 'chief', ownerId: 'alice' } }, rooms: {
    own: { id: 'own', members: ['chief'], projectId: 'p', participants: [{ id: 'alice', kind: 'human', displayName: 'Alice' }] },
    other: { id: 'other', members: ['chief'], projectId: 'p' }, personal: { id: 'personal', members: ['chief'] } } }
  let member = true
  const rt = { state, botOwnedBy: (who, id) => state.bots[id]?.ownerId === who.memberId, roomMemberOf: (who, id) => who.memberId === 'alice' && id !== 'other', roomOwnedBy: () => false,
    projectCan: () => member, botOf: id => state.bots[id], roomOf: id => state.rooms[id] }
  assert.deepEqual(personalRoster(rt, actor).rooms.map(row => row.id), ['own', 'personal'])
  assert.equal(requirePersonalSession(rt, actor, 'own'), 'own')
  assert.equal(personalRoster(rt, actor).rooms[0].projectId, 'p')
  assert.throws(() => requirePersonalSession(rt, { memberId: 'project-only' }, 'own'), /personal conversation/)
  state.bots.chief.projectId = 'p'
  assert.equal(requirePersonalSession(rt, actor, 'own'), 'own', 'original Project-bound group Bots retain the native group entry')
  delete state.bots.chief.projectId
  member = false
  assert.throws(() => requirePersonalSession(rt, actor, 'own'), /personal conversation/)
  assert.equal(requirePersonalSession(rt, actor, 'personal'), 'personal')
})
