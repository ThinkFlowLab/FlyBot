import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { applyNativeOverlay } from '../native-ds-bot-overlay.mjs'

const upstream = fileURLToPath(new URL('../../ds-bot-upstream/ds-bot', import.meta.url))

test('the native shared round relays local → remote → local without opening a private Session', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ot-native-shared-groups-'))
  t.after(() => rmSync(root, {recursive:true, force:true}))
  cpSync(upstream, root, {recursive:true})
  applyNativeOverlay(root)
  const stubs = new Map([
    ['@deepseek-ai/dsh-llm', 'export function createUserMessage() { throw Error("Unexpected private tool message") }'],
    ['@deepseek-ai/dsh-tools', 'export const defineTool = tool => tool'],
    ['./tools.js', 'export const GROUP_REF = {}; export const output = {}'],
    ['./turns.js', 'export const failureLine = failure => failure.message'],
  ])
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith('/src/host/groups.js') && stubs.has(specifier)) {
        return {url:'data:text/javascript,' + encodeURIComponent(stubs.get(specifier)), shortCircuit:true}
      }
      return nextResolve(specifier, context)
    },
  })
  let install
  try { ({install} = await import(pathToFileURL(join(root, 'src/host/groups.js')))) }
  finally { loader.deregister() }
  const local = {id:'writer',name:'Writer'}
  const remote = {id:'owner-b:reviewer',name:'Reviewer',remote:true,owner_id:'owner-b',agent_ref:'reviewer'}
  const other = {id:'owner-c:designer',name:'Designer',remote:true,owner_id:'owner-c',agent_ref:'designer'}
  const room = {
    id:'room', name:'Shared group', members:[local.id], admin:null, mode:'admin', seq:0, seen:{}, log:[],
    flybotWorkspace:{conversation_id:'shared-room', native_exchange:{id:'message-1',dispatched:true},
      native_bot_seats:[local.id,remote,other]},
  }
  const records = []
  const outbound = []
  const warnings = []
  const waiting = Promise.withResolvers()
  const replies = ['@Reviewer Please review this outline.', waiting.promise, '[PASS]']
  const rt = {
    ctx:{effect:() => {}, on:() => {}}, teamTools:[], state:{}, live:new Map(), roomProgress:new Map(),
    roomOf:id => id === room.id ? room : undefined, botOf:id => id === local.id ? local : undefined,
    isAdminOf:(active,id) => id !== undefined && active.admin === id,
    ledger:{
      importer:() => {},
      append:(_book,line) => records.push(line),
      after:(_book,since) => records.filter(line => line.seq > since),
      range:(_book,from,to) => records.filter(line => line.seq >= from && line.seq <= to),
    },
    resolveAgent:() => assert.fail('A shared text turn tried to open a private Session'),
    goalUserMessage:() => assert.fail('A shared text turn ran a local group goal'),
    goalTaskWorking:() => assert.fail('A shared text turn changed a local group goal'),
    goalDrive:() => assert.fail('A shared text turn ran a local group goal'),
    save:async () => {},
    warn:(...args) => warnings.push(args),
    sharedRoomTextTurn:async turn => {
      outbound.push(turn)
      return replies[outbound.length - 1]
    },
  }
  install(rt)
  rt.logRoom(room,{who:'Private',text:'local-only context'})
  rt.logRoom(room,{who:'Morgan',text:'earlier shared context',flybotWorkspaceMessageId:'message-0'})
  await rt.beginSharedRoomRound(room.id,{text:'review my copy',sourceId:'message-1',author:'Olivia',mentions:[local.id],textOnly:true})
  await setImmediate()
  assert.deepEqual(outbound.map(({bot}) => bot.id), [local.id,remote.id])
  assert.equal(rt.roomActive(room.id),true)
  assert.equal(rt.workingInRoom(room).length,0,'a pending remote lease is not local activity')
  assert.match(outbound[0].text,/earlier shared context/)
  assert.match(outbound[0].text,/Olivia: review my copy/)
  assert.doesNotMatch(outbound[0].text,/local-only context/)
  assert.match(outbound[1].text,/Writer mentioned you/)
  waiting.resolve({text:'@Writer The second section needs an example.',turnId:'remote-receipt'})
  await Promise.all(rt.roomRounds(room.id))
  assert.deepEqual(warnings,[])
  assert.deepEqual(outbound.map(({bot}) => bot.id),[local.id,remote.id,local.id])
  assert.equal(new Set(outbound.map(({callKey}) => callKey)).size,3)
  assert.match(outbound[2].text,/Reviewer mentioned you/)
  const lines = await rt.groupLinesAfter(room.id,3)
  assert.deepEqual(lines.map(({botId,nativeTurnId,flybotWorkspaceSharedRoundId}) => [botId,nativeTurnId,flybotWorkspaceSharedRoundId]),[
    [local.id,undefined,'message-1'],
    [remote.id,'remote-receipt','message-1'],
  ])
  assert.deepEqual(records.at(-1).passed,['Writer'])
  assert.equal(rt.roomBatchPending(room.id),false)
  assert.equal(rt.roomActive(room.id),false)

  async function run(id, options = {}) {
    room.flybotWorkspace.native_exchange = {id,dispatched:true}
    outbound.length = 0
    replies.splice(0,replies.length,'[PASS]','[PASS]','[PASS]')
    await rt.beginSharedRoomRound(room.id,{text:'who should answer?',sourceId:id,author:'Olivia',textOnly:true,...options})
    await Promise.all(rt.roomRounds(room.id))
    return outbound.map(({bot}) => bot.id)
  }
  room.flybotWorkspace.native_group_admin = remote.id
  assert.deepEqual(await run('message-2'),[remote.id],'a deliberate remote admin answers a plain message')
  assert.deepEqual(await run('message-3',{mentions:[other.id]}),[other.id],'an explicit @ takes precedence over the remote admin')
  room.flybotWorkspace.native_group_admin = null
  assert.deepEqual(await run('message-4'),[local.id,remote.id,other.id],'with no admin, DS-Bot gives each Bot its turn')
  assert.deepEqual(await run('message-5',{all:true}),[local.id,remote.id,other.id],'a human broadcast selects all Bots')
  assert.deepEqual(warnings,[])
})
