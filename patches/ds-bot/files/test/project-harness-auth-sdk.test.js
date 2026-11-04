// Opt-in actual pinned Codex SDK/CLI + worker; provider response is an isolated fixture.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
if (process.env.FLYBOT_TEST_AUTH_SDK === '1') test('actual Codex SDK worker preserves refresh-token failure without provider payload or successful completion', { timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(),'flybot-auth-sdk-')), home=join(root,'home'), cwd=join(root,'cwd')
  await mkdir(home); await mkdir(cwd); execFileSync('git',['init','-q',cwd])
  const secret='fixture-private-provider-auth-details', server=createServer(async (request,response)=>{
    await new Promise(resolve => { request.on('end', resolve); request.resume() })
    response.writeHead(401,{'content-type':'application/json'})
    response.end(JSON.stringify({error:{type:'authentication_error',code:'refresh_token_reused',message:'Your refresh token has already been used. Please log in again. '+secret}}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const child=spawn(process.execPath,[resolve(import.meta.dirname,'../src/host/project-harness-worker.mjs')],{env:{PATH:process.env.PATH},stdio:['pipe','pipe','pipe']})
  const frames=[],lines=createInterface({input:child.stdout}); child.stderr.resume()
  let finish, reject, timer
  const result=new Promise((resolve,rejected)=>{finish=resolve;reject=rejected;timer=setTimeout(()=>rejected(Error('Actual worker auth fixture timed out')),30000)})
  const exit=new Promise(resolve=>child.once('close',resolve))
  lines.on('line',line=>{
    const frame=JSON.parse(line);frames.push(frame)
    if(frame.type==='ready')child.stdin.write(JSON.stringify({type:'start',settings:{harness:'codex',cwd,model:'fixture-model',noTools:true,env:{HOME:home,CODEX_HOME:home,PATH:process.env.PATH},config:{model_provider:'fixture',model_providers:{fixture:{name:'fixture',base_url:`http://127.0.0.1:${server.address().port}`,wire_api:'responses',requires_openai_auth:false}}}},prompt:'Isolated auth failure probe'})+'\n')
    if(frame.type==='failure'){finish(frame);child.stdin.end(JSON.stringify({type:'stop'})+'\n')}
    if(frame.type==='completed')reject(Error('Authentication failure must not become a completed turn'))
  })
  try{
    const failure=await result
    assert.equal(failure.authenticationFailure?.code,'refresh_token_reused',JSON.stringify(frames))
    assert.ok(!JSON.stringify(frames).includes(secret))
    await exit
    assert.ok(frames.some(frame=>frame.type==='stopped'&&frame.released===true))
  }finally{clearTimeout(timer);child.kill('SIGTERM');lines.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
})
