import assert from 'node:assert/strict'
import { test } from 'node:test'
import { historyHookHarness } from './history-hook-harness.js'
const mount=await historyHookHarness('../src/client/history-hit.js','useHistoryHit')
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve()}
const view=id=>({scope:'read-only-history',sessionId:id,entries:[{text:'authorized '+id}]})
test('context uses only the opaque ticket and AbortSignal; switching hit discards stale content immediately',async()=>{
 const env=mount(),pending=[],calls=[]
 const read=(body,signal)=>{calls.push({body,signal});return new Promise(resolve=>pending.push(resolve))}
 env.draw(read,'old-ticket','alice');await settle();pending[0](view('old'));await settle()
 assert.equal(env.draw(read,'old-ticket','alice').value.sessionId,'old')
 const changed=env.draw(read,'new-ticket','alice');assert.equal(changed.value,null);assert.equal(changed.status,'loading')
 assert.equal(calls[0].signal.aborted,true);await settle()
 assert.equal(JSON.stringify(calls[1].body),JSON.stringify({hitToken:'new-ticket'}))
 pending[1](view('new'));await settle();assert.equal(env.draw(read,'new-ticket','alice').value.sessionId,'new')
})
test('account/ownership/part changes clear context before revalidation, and a revoked response exposes no old text',async()=>{
 const env=mount();let count=0
 const read=async()=>{if(count++)throw Error('/secret/config');return view('old')}
 env.draw(read,'ticket','alice:old-parts');await settle();assert.ok(env.draw(read,'ticket','alice:old-parts').value)
 assert.equal(env.draw(read,'ticket','bob:new-parts').value,null);await settle()
 const state=env.draw(read,'ticket','bob:new-parts');assert.equal(state.status,'error');assert.equal(state.value,null);assert.equal(JSON.stringify(state).includes('config'),false)
})
test('late response after unmount is ignored; deletion disables reads and retry reauthenticates',async()=>{
 const env=mount();let finish,seen
 const read=(_body,signal)=>{seen=signal;return new Promise(resolve=>{finish=resolve})}
 env.draw(read,'ticket','alive');await settle();env.unmount();assert.equal(seen.aborted,true)
 finish(view('late'));await settle();assert.equal(env.draw(read,'ticket','alive').value,null)
 const deleted=mount();let reads=0
 const quick=async()=>{reads++;return view('restored')}
 deleted.draw(quick,null,'deleted');await settle();assert.equal(reads,0);assert.equal(deleted.draw(quick,null,'deleted').status,'error')
 deleted.draw(quick,'ticket','restored');await settle();const ready=deleted.draw(quick,'ticket','restored');assert.equal(ready.value.sessionId,'restored')
 ready.reload();deleted.draw(quick,'ticket','restored');await settle();assert.equal(reads,2)
})
