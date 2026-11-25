import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createAgents } from '../features/agents/index.js'

const personal = 'a'.repeat(32)
const source = {workspace_id:'b'.repeat(32),share_id:'c'.repeat(32),revision:2}
const trusted = {internal:true}

test('shared meeting drafts are authorized on open and only become a conversation with the first accepted send', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  const bots = {main:{id:'main',name:'Main',capabilities:[]}}
  let available = true
  let sessions = 0
  let modelCalls = 0
  const runtime = {
    mainBot:async ()=>'main', chatTurn:async()=>{},
    ctx:{sessions:{flush:async()=>{}}},
    rt:{
      state:{bots}, botOf:id=>bots[id], chatOwners:new Map(), save:async()=>{},
      async createBot(fields) { return bots.agent = {...fields,id:'agent',capabilities:[]} },
      async createSession() { return 'fixture-session-'+ ++sessions },
      workDirOf:()=>'/fixture', resolveAgent:async id=>({session:{id}}),
      async* eventsBackwards() {},
    },
    async nativeTurn(_bot,sessionId,text) {
      modelCalls += 1
      assert.equal(text,'Reviewed question')
      return {text:'Native reply',sessionId,turnId:1}
    },
  }
  const {endpoints} = createAgents({db,host:{
    runtime:async()=>runtime, currentRuntime:()=>runtime,
    async call(name,payload) {
      if (name !== 'meetings/discussionSource') return {}
      assert.deepEqual(payload,source)
      if (!available) throw Object.assign(new Error('Revoked'),{status:404})
      return {title:'Reviewed meeting'}
    },
  }})
  const {agent} = await endpoints.create({workspace_id:personal,name:'Owner',idempotency_key:'meeting-draft-agent-fixture'})
  const personalAgent = {workspace_id:personal,id:agent.id}
  await endpoints['adopt-personal-chat']({...personalAgent,conversations:[]},false)
  const request = {source,idempotency_key:'meeting-draft-review-fixture'}
  await assert.rejects(endpoints.prepareMeetingDiscussion(request),{status:404})
  const draft = await endpoints.prepareMeetingDiscussion(request,trusted)
  assert.deepEqual(await endpoints.prepareMeetingDiscussion(request,trusted),draft)
  const address = {...personalAgent,conversation_id:draft.id}
  const before = sessions
  const preview = await endpoints.openConversation(address)
  assert.equal(preview.conversation.deferred,true)
  assert.equal(preview.conversation.memory_recall,false)
  assert.deepEqual(preview.items,[])
  assert.equal(sessions,before)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_conversations').get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n,0)

  const send = {...address,text:'Reviewed question',idempotency_key:'meeting-draft-first-send'}
  available = false
  await assert.rejects(endpoints.openConversation(address),{status:404})
  await assert.rejects(endpoints.send(send),{status:404})
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_conversations').get().n,0)
  assert.equal(modelCalls,0)

  available = true
  await assert.rejects(endpoints.send({...send,text:' '}),{status:400})
  await assert.rejects(endpoints.send({...send,attachments:[]}),{status:400})
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_conversations').get().n,0)
  const [first,retry] = await Promise.all([endpoints.send(send),endpoints.send(send)])
  assert.equal(first.message.id,retry.message.id)
  assert.equal(first.reply.id,retry.reply.id)
  assert.equal(modelCalls,1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_conversations').get().n,1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n,2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_meeting_discussions').get().n,0)

  available = false
  const delivered = await endpoints.openConversation(address)
  assert.equal(delivered.conversation.deferred,undefined)
  assert.equal(delivered.conversation.memory_recall,false)
  assert.deepEqual(delivered.items.map(item=>item.text),['Reviewed question','Native reply'])
  assert.equal((await endpoints.send(send)).message.id,first.message.id)
  assert.equal(modelCalls,1)
})
