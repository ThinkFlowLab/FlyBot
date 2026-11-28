import assert from 'node:assert/strict'
import test from 'node:test'
import { botSchedules } from '../features/automations/bot-schedules.js'
import { automationsV1 } from '../features/automations/v1.js'

const workspace = '1'.repeat(32), other = '2'.repeat(32)
const agent = '3'.repeat(32), chat = '4'.repeat(32)

function fixture() {
  const own = {name:'Personal Bot', flybotWorkspace:{workspace_id:workspace, agent_id:agent,
    sessionKeys:{[`agent:${agent}:${chat}`]:'old-part'}},
  openParts:[{sessionId:'live-part', segments:[{sessionId:'old-part'}]}]}
  const tasks = [
    {id:'own-schedule', botId:'own', sessionId:'live-part', title:'Morning digest', state:'scheduled', kind:'daily',
      timeZone:'Asia/Shanghai', time:'09:00', scheduledAt:'2026-11-29T01:00:00Z', prompt:'Private execution instructions'},
    {id:'other-schedule', botId:'foreign', sessionId:'foreign-part', title:'Foreign schedule', state:'scheduled'},
    {id:'room-schedule', sessionId:'room-part', roomId:'room', title:'Shared-room schedule', state:'scheduled'},
  ]
  const calls = []
  const rt = {
    botOf: id => id === 'own' ? own : {flybotWorkspace:{workspace_id:other}},
    chatOwners:new Map([['live-part','own'], ['foreign-part','foreign']]),
    pastOwners:new Map([['old-part',{botId:'own'}]]),
    load:async () => {},
    async scheduleEndpoint(name, data) {
      calls.push([name,data])
      if (name === 'schedule-pause') tasks[0].state = data.active ? 'scheduled' : 'paused'
      return {available:true, canPause:true, tasks}
    },
  }
  const host = {currentRuntime:()=>({rt}), call:async name =>
    name === 'agents/personal-binding' ? {workspace_id:workspace} : [{id:other}]}
  return {rt, host, calls}
}

test('Tasks lists only the current workspace’s private Bot schedules and returns an exact chat link', async () => {
  const {host,calls} = fixture()
  const result = await botSchedules(host,{workspace_id:workspace})
  assert.deepEqual(result,{available:true,can_pause:true,items:[{
    id:'own-schedule', title:'Morning digest', bot_name:'Personal Bot', state:'scheduled', kind:'daily',
    next_run:'2026-11-29T01:00:00.000Z', time_zone:'Asia/Shanghai', time:'09:00', agent_id:agent, conversation_id:chat,
  }]})
  await assert.rejects(botSchedules(host,{workspace_id:workspace,id:'other-schedule',active:false}),{status:404})
  await assert.rejects(botSchedules(host,{workspace_id:workspace,id:'room-schedule',active:false}),{status:404})
  assert.equal(calls.some(([name])=>name==='schedule-pause'),false)
  const paused = await botSchedules(host,{workspace_id:workspace,id:'own-schedule',active:false})
  assert.equal(paused.items[0].state,'paused')
  assert.deepEqual(calls.at(-1),['schedule-pause',{id:'own-schedule',sessionId:'live-part',active:false}])
})

test('the Bot schedules endpoint requires the signed owner and validates mutations before going native', async () => {
  const {host,rt,calls} = fixture()
  const v1 = automationsV1({endpoints:{},readBotSchedules:p=>botSchedules(host,p)})
  const path = `/v1/workspaces/${workspace}/automations/bot-schedules`
  const context = username => ({request:{headers:new Headers({'x-ot-owner-username':username})}})
  const owner = context('owner')
  assert.equal((await v1({method:'GET',path},context(''))).status,403)
  assert.equal((await v1({method:'POST',path,body:{id:'own-schedule',active:'false'}},owner)).status,400)
  assert.equal((await v1({method:'GET',path},owner)).status,200)
  rt.readOnly = () => true
  assert.equal((await v1({method:'POST',path,body:{id:'own-schedule',active:false}},owner)).status,409)
  assert.equal(calls.some(([name])=>name==='schedule-pause'),false)
})
