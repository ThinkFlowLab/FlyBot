// Actual viewer component; effects are covered by history-hit-state separately.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
const bundle=await build({entryPoints:[fileURLToPath(new URL('../src/client/history-hit.js',import.meta.url))],bundle:true,platform:'browser',format:'cjs',write:false,external:['react']})
const h=(type,props,...children)=>({type,props:{...props,children:children.flat(Infinity)}})
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):node?text(node.props?.children):''
const nodes=(node,out=[])=>{if(Array.isArray(node)){for(const child of node)nodes(child,out)}else if(node&&typeof node==='object'){out.push(node);nodes(node.props?.children,out)}return out}
function draw(status='ready',{deleted=false}={}){
 const bot={id:'bot',ownerId:'alice',sessionId:'live',parts:['old','live']}
 const roster={byId:deleted?{}:{bot},self:{memberId:'alice'}}
 const access=JSON.stringify([true,'alice','live',['old','live'],'alice'])
 const value={scope:'read-only-history',sessionId:'old',part:1,partCount:2,entries:[{seq:1,turn:0,role:'user',hit:true,text:'原始 ＡＢＣ <b>历史</b>',truncated:true,omittedBefore:true},{seq:2,turn:0,role:'assistant',hit:false,text:'相邻文本'}]}
 const react={createElement:h,useRef:initial=>({current:initial}),useEffect(){},useState:initial=>[initial&&typeof initial==='object'&&'key'in initial?{key:`token:${access}:0`,status,value}:initial,()=>{}]}
 const module={exports:{}}
 runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,require:()=>react})
 let back=0
 const result=module.exports.HistoryHitDialog({hit:{botId:'bot',sessionId:'old',hitToken:'token',snippet:'NEVER USE SEARCH SNIPPET'},roster,actions:{openSession(){throw Error('must not navigate')},readHistoryHit:async()=>value},onBack:()=>back++})
 return {all:nodes(result),back:()=>back}
}
test('read-only viewer identifies its real segment and displays original escaped text, hit marker and truncation notice',()=>{
 const {all,back}=draw()
 assert.ok(all.some(node=>node.props?.role==='dialog'&&node.props['aria-label']==='Read-only history match'))
 assert.ok(all.some(node=>text(node)==='Segment 1 of 2'))
 assert.ok(all.some(node=>node.type==='code'&&text(node)==='old'))
 assert.ok(all.some(node=>node.type==='pre'&&text(node)==='原始 ＡＢＣ <b>历史</b>'&&node.props.dangerouslySetInnerHTML===undefined))
 assert.ok(all.some(node=>node.props?.['data-hit']===true))
 assert.ok(all.some(node=>text(node)==='Text truncated by the byte limit; this is not complete history.'))
 assert.equal(all.some(node=>node.type==='input'||node.type==='textarea'),false)
 const buttons=all.filter(node=>node.type==='button')
 assert.ok(buttons.every(node=>['Back to search','Reload history context'].includes(text(node))||node.props['aria-label']==='Back to search'))
 buttons.find(node=>text(node)==='Back to search').props.onClick();assert.equal(back(),1)
})
test('loading/error/deleted-roster states never render cached context or the search snippet',()=>{
 for(const [status,deleted] of [['loading',false],['error',false],['ready',true]]){
  const {all}=draw(status,{deleted})
  assert.equal(all.some(node=>node.type==='pre'),false)
  assert.equal(all.some(node=>text(node).includes('NEVER USE SEARCH SNIPPET')),false)
 }
})
