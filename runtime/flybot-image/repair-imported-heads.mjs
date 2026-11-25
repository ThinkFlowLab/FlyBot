// One-shot, backed-up protected-head repair of source-marked FlyBot imports.
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
// Structural native initialization only: no historical content, prompt, reply,
// provider, tool result or usage is inferred. All old message payloads survive.
import {createSystemMessage} from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'
const pending=[], all=[]
for(const file of files(root)){
 const original=fs.readFileSync(file),rows=zlib.zstdDecompressSync(original).toString('utf8').trim().split('\n').map(JSON.parse)
 all.push({file,original,rows})
}
for(const {file,original,rows} of all){
 const oldEvents=rows.slice(1), surface=oldEvents.find(e=>['system/message','user/message','assistant/message','tool/result'].includes(e.type))
 if(!surface||surface.type==='system/message'||surface.data?.source?.imported!==true)continue
 assert(!rows[0].parentSession,'Seeded child needs separate inherited-reference migration')
 // No other native artifact may inherit or refer to these local coordinates.
 for(const other of all)if(other.file!==file)assert(!JSON.stringify(other.rows).includes(rows[0].id),'External Session reference needs a separate migration')
 const first=Math.min(oldEvents.indexOf(surface),...oldEvents.flatMap((e,i)=>e.type==='turn/start'?[i]:[]))
 assert(oldEvents.slice(0,first).every(e=>!['turn/start','step/start'].includes(e.type)))
 const time=Date.now(),source={kind:'flybot-workspace-initialization',reason:'protect-native-history-head',noModelCall:true}
 const seed=[{type:'turn/start',data:{turn:1,source}},{type:'step/start',data:{turn:1,step:1,source}},{type:'system/message',data:{turn:1,step:1,message:createSystemMessage('')},surfaceOp:'append'},{type:'step/end',data:{turn:1,step:1,source}},{type:'turn/end',data:{turn:1,source}}].map((e,i)=>({...e,seq:first+i,time}))
 const mapping=oldEvents.map((e,i)=>i<first?i:i+seed.length),seqMap=[],fixed=[]
 const reference=(v,at)=>{assert(Number.isInteger(v)&&v>=0&&v<at,'Invalid local source reference');return mapping[v]}
 for(const [index,old]of oldEvents.entries()){
  if(index===first)fixed.push(...seed)
  const e=structuredClone(old),ref=v=>reference(v,old.seq),refs=v=>{assert(Array.isArray(v));return v.map(ref)}
  e.seq=mapping[index];seqMap.push([old.seq,e.seq])
  if(e.data.turn!==undefined){assert(Number.isInteger(e.data.turn)&&e.data.turn>=1&&!e.type.startsWith('plugin:'),'Unsupported turn metadata');e.data.turn++}
  if(e.sourceEventSeqs)e.sourceEventSeqs=refs(e.sourceEventSeqs)
  if(e.surfaceOp&&e.surfaceOp!=='append'){assert(typeof e.surfaceOp==='object');e.surfaceOp={...e.surfaceOp,startSeq:ref(e.surfaceOp.startSeq),endSeq:ref(e.surfaceOp.endSeq)}}
  // Released first-party coordinate fields (not arbitrary numeric payloads).
  if(e.type==='command/done'&&e.data.sourceEventSeq!==undefined)e.data.sourceEventSeq=ref(e.data.sourceEventSeq)
  if(['compaction/summary','compaction/prune'].includes(e.type)){e.data.shadowedRange={...e.data.shadowedRange,start:ref(e.data.shadowedRange.start),end:ref(e.data.shadowedRange.end)};e.data.shadowedSeqs=refs(e.data.shadowedSeqs)}
  if(['session/title','session/title-llm-request'].includes(e.type))e.data.messageSeqs=refs(e.data.messageSeqs)
  if(e.type==='image/offload')e.data.targets=e.data.targets.map(t=>({...t,seq:ref(t.seq)}))
  // Message data, including real provider streams and source facts, is exact.
  if(old.data.message)assert.deepEqual(e.data.message,old.data.message)
  if(e.type==='user/message')assert.deepEqual(e.data,old.data)
  fixed.push(e)
 }
 rows.splice(1,rows.length-1,...fixed)
 const restore=catalog.createRestore(rows[0],{recovery:'strict',validation:'current'})
 for(const e of fixed)restore.decodeRow(e)
 const artifact=restore.finish()
 assert.equal(artifact.events.length,oldEvents.length+5)
 pending.push({file,original,rows,artifact,changed:0,seqMap})
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
