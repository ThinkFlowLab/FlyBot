import test from 'node:test';
import assert from 'node:assert/strict';
import {mountImportedSkills,ORIGINAL_TEMPLATE} from '../flybot_workspace/static/skills/imports.mjs';
function fixture(){
 const ids=['skill-import-form','skill-import-json','skill-import-consent','skill-import-status','skill-import-submit','skill-import-template'];
 const all=Object.fromEntries(ids.map(id=>[id,{value:'',checked:false,disabled:false,textContent:'',addEventListener(n,fn){this[n]=fn},focus(){this.focused=true}}]));
 return {all,document:{getElementById:id=>all[id],defaultView:{confirm:()=>true}}};
}
const submit=f=>f.all['skill-import-form'].submit({preventDefault(){}});
test('import requires actual reviewed JSON, explicit consent and successful API persistence; it does not install',async()=>{
 const f=fixture(),calls=[];let changed=0;
 mountImportedSkills(f.document,{request:async(method,path,body)=>{calls.push({method,path,body});return {id:body.package.id,revision:1}},onChange:async()=>changed++});
 f.all['skill-import-template'].click();assert.deepEqual(JSON.parse(f.all['skill-import-json'].value),ORIGINAL_TEMPLATE);
 await submit(f);assert.equal(calls.length,0);assert.match(f.all['skill-import-status'].textContent,/请先阅读/);
 f.all['skill-import-consent'].checked=true;await submit(f);assert.equal(calls.length,1);assert.equal(calls[0].path,'/v1/skills/packages');assert.equal(calls[0].body.revision,0);assert.equal(changed,1);
 assert.equal(calls.some(c=>c.path.includes('/bindings')),false);assert.match(f.all['skill-import-status'].textContent,/未自动安装/);assert.equal(f.all['skill-import-consent'].checked,false);
});
test('version edit reads owner revision and revoke executes actual persisted lifecycle then refreshes state',async()=>{
 const f=fixture(),calls=[];let changed=0;
 const mount=mountImportedSkills(f.document,{request:async(method,path,body)=>{calls.push({method,path,body});return {revision:7,id:ORIGINAL_TEMPLATE.id}},onChange:async()=>changed++});
 await mount.edit(ORIGINAL_TEMPLATE);assert.equal(f.all['skill-import-json'].focused,true);
 const item={...ORIGINAL_TEMPLATE,version:'1.1.0'};f.all['skill-import-json'].value=JSON.stringify(item);f.all['skill-import-consent'].checked=true;await submit(f);
 assert.equal(calls.find(c=>c.method==='POST').body.revision,7);
 await mount.revoke(item);assert.equal(calls.at(-1).path,'/v1/skills/packages/'+item.id+'/revoke');assert.equal(calls.at(-1).body.revision,7);assert.equal(changed,2);
});
test('invalid JSON and API rejection never show success or leave submit stuck',async()=>{
 const f=fixture();let changed=false;
 mountImportedSkills(f.document,{request:async()=>{throw new Error('Version immutable; reload')},onChange:async()=>{changed=true}});
 f.all['skill-import-json'].value='not JSON';f.all['skill-import-consent'].checked=true;await submit(f);assert.equal(changed,false);assert.equal(f.all['skill-import-submit'].disabled,false);
 f.all['skill-import-json'].value=JSON.stringify(ORIGINAL_TEMPLATE);await submit(f);assert.match(f.all['skill-import-status'].textContent,/immutable/);assert.equal(changed,false);assert.equal(f.all['skill-import-submit'].disabled,false);
});
