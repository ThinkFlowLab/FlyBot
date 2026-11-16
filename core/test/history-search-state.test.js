// Effect-capable VM hooks, following palette-ui/message-tools harness conventions.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyHookHarness } from './history-hook-harness.js'
const mount=await historyHookHarness('../src/client/history-search.js','useHistorySearch')
const reply=(items=[],cursor=null,extra={})=>({scope:'local-bot-chats',items,cursor,...extra})
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()}
test('debounces Chinese query; history is async and continuation uses opaque cursor',async()=>{
 const env=mount(),calls=[]
 const search=async body=>{calls.push(body);return body.cursor?reply([{seq:2}]):reply([{seq:1}],'opaque')}
 env.draw(search,'中');env.draw(search,'中文');env.tick();await settle()
 let state=env.draw(search,'中文');assert.equal(calls.length,1);assert.equal(calls[0].query,'中文');assert.equal(state.status,'ready');assert.equal(state.items.length,1)
 state.more();await settle();state=env.draw(search,'中文')
 assert.equal(calls[1].cursor,'opaque');assert.equal(state.items.length,2)
})
test('stale responses cannot replace the new query, and unmount ignores delayed results',async()=>{
 const env=mount(),pending=[]
 const search=()=>new Promise(resolve=>pending.push(resolve))
 env.draw(search,'old');env.tick();env.draw(search,'new');env.tick()
 pending[1](reply([{seq:2}]));await settle();pending[0](reply([{seq:1}]));await settle()
 assert.equal(env.draw(search,'new').items[0].seq,2)
 env.draw(search,'third');env.tick();env.unmount();pending[2](reply([{seq:3}]));await settle()
 assert.equal(env.draw(search,'third').items.length,0)
})
test('empty/long/unsupported/filter-disabled queries never call the host; backend failure degrades explicitly',async()=>{
 const env=mount();let count=0
 const search=async()=>{count++;throw Error('backend path/config must not appear')}
 for(const query of ['', 'x'.repeat(257)]){env.draw(search,query);env.tick();await settle()}
 env.draw(undefined,'query');env.tick();assert.equal(count,0)
 env.draw(search,'needle');env.tick();await settle();const result=env.draw(search,'needle')
 assert.equal(result.status,'error');assert.equal(result.items.length,0);assert.equal(JSON.stringify(result).includes('config'),false)
})
test('display cap stops pagination and marks incomplete/limited results honestly',async()=>{
 const env=mount();let batch=0
 const search=async()=>reply(Array.from({length:20},(_,seq)=>({seq:++batch*20+seq})),'more',{incomplete:true})
 env.draw(search,'query');env.tick();await settle()
 for(let n=0;n<4;n++){env.draw(search,'query').more();await settle()}
 const result=env.draw(search,'query');assert.equal(result.items.length,100);assert.equal(result.cursor,null);assert.equal(result.limited,true);assert.equal(result.incomplete,true)
})
