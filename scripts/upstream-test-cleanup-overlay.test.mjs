import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {target,marker,replacements,transformRestartFixture} from './upstream-test-cleanup-overlay.mjs';
import {load} from './upstream-test-clock-loader.mjs';
const original=readFileSync(new URL(target),'utf8');
const patched=transformRestartFixture(original);
function hooks(source,stop,remove){
 const begin=source.indexOf(marker),end=source.indexOf('\n})',begin)+3;
 const block=source.slice(begin,end),registered=[];
 const prefix=block.slice(block.indexOf('  const { call,'),block.indexOf('  const room ='));
 const late=block.includes('stopRestarted =')?'stopRestarted = () => again.stop({ keep: true })':'t.after(() => again.stop({ keep: true }))';
 // Execute the exact pinned/transformed cleanup registrations, not a reworded
 // imitation. Runtime behavior is represented by a deliberately pending stop.
 Function('start','t','rmSync','again',prefix+';'+late)(()=>({home:'synthetic-only',stop}),{after:fn=>registered.push(fn)},remove,{stop});
 return registered;
}
test('actual Node after hooks run in registration order, matching the red Node22 cleanup stack',()=>{
 const code=`import test from 'node:test';const order=[];await test('order',t=>{t.after(()=>order.push('remove'));t.after(()=>order.push('stop'));});console.log('TRACE '+order.join(','));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:3000});
 assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/TRACE remove,stop/);
});
test('original exact fixture removes while restarted runtime is still live',async()=>{
 let stopped=false;
 const callbacks=hooks(original,async()=>{stopped=true},()=>{assert.equal(stopped,false);throw Error('synthetic ENOTEMPTY: writer still live')});
 assert.equal(callbacks.length,2);assert.throws(callbacks[0],/writer still live/);
 await callbacks[1]();assert.equal(stopped,true);
});
test('same awaited disposer must finish before any directory removal; stop/removal failures remain failures',async()=>{
 let release,removed=0,stopped=false;
 const callbacks=hooks(patched,async()=>{await new Promise(resolve=>{release=resolve});stopped=true},()=>{assert.equal(stopped,true);removed++});
 assert.equal(callbacks.length,1);const pending=callbacks[0]();assert.equal(typeof release,'function');assert.equal(removed,0);
 release();await pending;assert.equal(removed,1);
 const failed=hooks(patched,async()=>{throw Error('stop failed')},()=>assert.fail('must not remove while shutdown failed'));
 await assert.rejects(failed[0](),/stop failed/);
 const cleanupFailure=hooks(patched,async()=>{},()=>{throw Error('rm failed')});await assert.rejects(cleanupFailure[0](),/rm failed/);
});
test('overlay retains every assertion byte, reverses exactly, rejects drift and never touches other modules',async()=>{
 assert.deepEqual(patched.split('\n').filter(line=>line.includes('assert.')),original.split('\n').filter(line=>line.includes('assert.')));
 let restored=patched;for(const [before,after]of [...replacements].reverse())restored=restored.replace(after,before);assert.equal(restored,original);
 assert.throws(()=>transformRestartFixture(original+'\n'),/fixture changed/);
 assert.throws(()=>transformRestartFixture(original.replace('assert.equal(new Set(seqs).size, seqs.length)','assert.equal(true, true)')),/fixture changed/);
 assert.equal((await load(target,{},async()=>({format:'module',source:Buffer.from(original)}))).source,patched);
 const other={format:'module',source:'untouched'};assert.equal(await load('file:///production.js',{},async()=>other),other);
});
