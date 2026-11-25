// One-shot, backed-up repair of ONLY malformed FlyBot-import assistant events.
// Uses the published native current-format codec and persistence writer. No model/replay/network.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import {Context} from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
import * as persistence from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
import {sessionFormatCatalog as catalog} from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js'
const mode=process.env.REPAIR_MODE || 'plan', root='/data/sessions', output='/repair'
assert(['plan','apply'].includes(mode))
const sha=b=>crypto.createHash('sha256').update(b).digest('hex')
function* files(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())yield*files(p);else if(e.isFile()&&e.name==='session.v4.jsonl.zstd')yield p}}
const pending=[]
for(const file of files(root)){
 const original=fs.readFileSync(file), rows=zlib.zstdDecompressSync(original).toString('utf8').trim().split('\n').map(JSON.parse)
 const oldEvents=rows.slice(1), first=oldEvents.findIndex(e=>e.data?.source?.imported===true&&(/^[0-9a-f]{32}$/).test(e.data.source.flybotWorkspaceMessageId||'')&&((e.type==='assistant/message'&&!e.data.turn)||(e.type==='user/message'&&(!e.data.id||e.data.role!=='user'))||e.type==='flybot-workspace/message-status'))
 if(first<0)continue
 let changed=0, turn=Math.max(0,...oldEvents.slice(0,first).filter(e=>e.type==='turn/end').map(e=>e.data.turn))+1
 const fixed=[],seqMap=[]
 for(const [index,e] of oldEvents.entries()){
  const imported=e.data?.source?.imported===true
  if(index>=first){
   assert(['user/message','assistant/message','model/selection','flybot-workspace/message-status'].includes(e.type),'Unsupported native suffix event; no mutation')
   assert(e.type==='model/selection'||imported,'Unmarked suffix; no mutation')
   assert(e.surfaceOp===undefined||e.surfaceOp==='append','Surface replacement requires separate reference migration')
   const inspect=o=>{if(o&&typeof o==='object')for(const [k,v]of Object.entries(o)){assert(!['sourceEventSeq','headerSeq','startSeq','endSeq'].includes(k),'External sequence reference requires explicit migration');inspect(v)}}
   inspect(e.data)
  }
  const old=e.seq
  if(e.type==='flybot-workspace/message-status'&&imported){e.type='plugin:flybot-workspace/message-status';e.ignorable=true}
  if(e.type==='user/message'&&imported)e.data={...e.data,id:e.data.id||e.data.source.flybotWorkspaceMessageId,role:'user'}
  if(e.type==='assistant/message'&&imported){
   const source={...e.data.source,kind:'flybot-workspace-history',originalNativeSeq:old}
   fixed.push({type:'turn/start',seq:fixed.length,time:e.time,data:{turn,source,imported:true}})
   fixed.push({type:'step/start',seq:fixed.length,time:e.time,data:{turn,step:1,source,imported:true}})
   e.data={...e.data,turn,step:1,stream:e.data.stream||[],message:{...e.data.message,id:e.data.message.id||source.flybotWorkspaceMessageId,source:e.data.message.source||{...source,kind:'model',provider:'flybot-workspace-history',model:'historical-unknown'}}}
   e.seq=fixed.length;seqMap.push([old,e.seq]);fixed.push(e)
   fixed.push({type:'step/end',seq:fixed.length,time:e.time,data:{turn,step:1,source,imported:true}})
   fixed.push({type:'turn/end',seq:fixed.length,time:e.time,data:{turn,source,imported:true}})
   turn++;changed++
  }else{e.seq=fixed.length;seqMap.push([old,e.seq]);fixed.push(e)}
 }
 rows.splice(1,rows.length-1,...fixed)
 const restore=catalog.createRestore(rows[0],{recovery:'strict',validation:'current'})
 for(const e of fixed)restore.decodeRow(e)
 const artifact=restore.finish()
 assert.equal(artifact.events.length,oldEvents.length+changed*4)
 pending.push({file,original,rows,artifact,changed,seqMap})
}
const report={mode,affected_sessions:pending.length,changes:pending.reduce((n,p)=>n+p.changed,0),sessions:[]}
if(mode==='apply'){
 fs.mkdirSync(output,{recursive:true,mode:0o700})
 const ctx=new Context(), fork=ctx.plugin(persistence,{root:path.join(output,'generated'),compression:'zstd'})
 await fork.await()
 const replacements=[]
 for(const p of pending){
  const {header,events,inheritedEventCount}=p.artifact
  const h=await ctx.sessionPersistence.create(header,{inheritedEventCount})
  await h.append(events);await h.flush();await h.close()
  const snapshot=await ctx.sessionPersistence.stat(header.id), generated=fs.readFileSync(snapshot.location.path)
  const actual=zlib.zstdDecompressSync(generated).toString('utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(actual,p.rows)
  assert.equal(fs.statSync(p.file).nlink,1)
  assert.equal(sha(fs.readFileSync(p.file)),sha(p.original),'Log changed during offline repair')
  const relative=path.relative(root,p.file),backup=path.join(output,'originals',relative)
  fs.mkdirSync(path.dirname(backup),{recursive:true,mode:0o700})
  fs.copyFileSync(p.file,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600)
  assert.equal(sha(fs.readFileSync(backup)),sha(p.original))
  report.sessions.push({session_id:header.id,relative_path:relative,event_count:events.length,imported_assistant_messages:p.changed,sequence_mapping:p.seqMap,original_sha256:sha(p.original),repaired_sha256:sha(generated)})
  replacements.push({p,generated})
 }
 // Every original and sequence mapping is durable BEFORE replacing the first log.
 const mf=fs.openSync(path.join(output,'manifest.json'),'wx',0o600)
 try{fs.writeFileSync(mf,JSON.stringify(report));fs.fsyncSync(mf)}finally{fs.closeSync(mf)}
 const dirfd=fs.openSync(output,'r');fs.fsyncSync(dirfd);fs.closeSync(dirfd)
 for(const {p,generated}of replacements){
  assert.equal(sha(fs.readFileSync(p.file)),sha(p.original))
  const replacement=p.file+'.flybot-workspace-schema-repair'
  const fd=fs.openSync(replacement,'wx',fs.statSync(p.file).mode&0o777)
  try{fs.writeFileSync(fd,generated);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  fs.renameSync(replacement,p.file)
  const d=fs.openSync(path.dirname(p.file),'r');fs.fsyncSync(d);fs.closeSync(d)
 }
 await fork.dispose()
}
console.log(JSON.stringify({mode:report.mode,affected_sessions:report.affected_sessions,imported_assistant_messages:report.changes,manifest_durable:mode==='apply'}))
