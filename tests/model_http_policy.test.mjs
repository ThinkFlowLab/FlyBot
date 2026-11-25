import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import {createServer,request as httpRequest} from 'node:http'
import {once} from 'node:events'
import {MODEL_HTTP_FORMAT,publicHttpBase,validHttpGrant,validateModelEndpoint} from '../runtime/flybot-image/model-http-policy.mjs'
import {parseModelApi,applyModelApi} from '../runtime/flybot-image/model-api.js'
import {createBridgeServer,forwardModel} from '../runtime/flybot-image/ds-bot-bridge.mjs'

const base='http://8.8.4.4:8080/v1' // fixture only; never dialed
const key='synthetic-only-http-model-key'
const grant=url=>({format:MODEL_HTTP_FORMAT,base_url:url})
const doc=url=>({provider:'custom',base_url:url,model:'synthetic-model',api_key:key,source:'platform',http_endpoint_grant:grant(url)})

test('shared Python/JS canonical public IPv4 corpus rejects multicast/special/aliases',()=>{
  const cases=JSON.parse(readFileSync(new URL('./fixtures/model_http_urls.json',import.meta.url)))
  for(const {url,allowed} of cases) assert.equal(publicHttpBase(url),allowed,url)
})
test('exact grant and every field binding fail closed',()=>{
  assert.equal(validHttpGrant(base,grant(base)),true)
  for(const g of [undefined,null,true,{}, {...grant(base),format:'old'}, {...grant(base),base_url:base+'/other'},{...grant(base),allow_all:true}]) {
    assert.equal(validHttpGrant(base,g),false)
    assert.throws(()=>validateModelEndpoint(base,g))
  }
  for(const changed of [base+'2',base.replace('8080','8081'),base.replace('8.8.4.4','9.9.9.9')]) assert.equal(validHttpGrant(changed,grant(base)),false)
  assert.equal(validateModelEndpoint('https://provider.test/v1'),false)
  assert.equal(validateModelEndpoint('http://127.0.0.1:8080/v1'),false)
})
test('secret parser preserves grant but native SDK never receives this HTTP key',()=>{
  const parsed=parseModelApi(JSON.stringify(doc(base)))
  assert.deepEqual(parsed.http_endpoint_grant,grant(base))
  const env={CUSTOM_API_KEY:'stale',FLYBOT_WORKSPACE_MODEL_BASE_URL:'https://stale.test'};const lines=[]
  applyModelApi(parsed,env,{info:line=>lines.push(line)})
  assert.equal(env.CUSTOM_API_KEY,undefined);assert.equal(env.FLYBOT_WORKSPACE_MODEL_BASE_URL,undefined)
  assert.match(lines[0], /DS-Bot loopback proxy/);assert.equal(JSON.stringify(lines).includes(key),false)
  for(const altered of [{...doc(base),http_endpoint_grant:null},{...doc(base),http_endpoint_grant:grant(base+'/other')},{...doc(base),base_url:' '+base},{...doc(base),http_endpoint_grant:undefined}]) assert.throws(()=>parseModelApi(JSON.stringify(altered)))
  const secure=parseModelApi(JSON.stringify({...doc('https://provider.test/v1'),http_endpoint_grant:undefined}))
  applyModelApi(secure,env,{info:()=>{}});assert.equal(env.CUSTOM_API_KEY,key)
})
async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  return server.address().port
}

function callProxy(port) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method:'POST', redirect:'error',
    headers:{Authorization:'Bearer synthetic-loopback-key'},
    body:JSON.stringify({model:'flybot-workspace-model',messages:[{role:'user',content:'benign'}]}),
  })
}

test('native loopback model proxy applies the exact HTTP grant and never follows redirects', async t => {
  let status = 200
  let redirectTarget
  let redirected = 0
  const seen = []
  const trap = await listen(t, createServer((_req, res) => {
    redirected++
    res.end('unexpected')
  }))
  const upstream = await listen(t, createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.url !== '/v1/chat/completions') redirected++
    seen.push({path:req.url, auth:req.headers.authorization, body:JSON.parse(raw)})
    res.writeHead(status, status === 200 ? {'Content-Type':'application/json'} : {Location:redirectTarget})
    res.end(status === 200 ? JSON.stringify({choices:[{message:{content:'synthetic native reply'}}]}) : '')
  }))
  const url = `http://8.8.4.4:${upstream}/v1`
  let configured = doc(url)
  const requester = (options, callback) => {
    assert.equal(options.hostname, '8.8.4.4')
    assert.equal(Number(options.port), upstream)
    assert.equal(options.agent, false)
    assert.equal(options.family, 4)
    return httpRequest({...options, hostname:'127.0.0.1'}, callback)
  }
  const proxy = await listen(t, createBridgeServer({
    token:'synthetic-loopback-key', startupModel:() => configured,
  },{forward:(api, raw, res) => forwardModel(api, raw, res, {httpRequester:requester})}))
  const response = await callProxy(proxy)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, 'synthetic native reply')
  assert.deepEqual(seen[0], {
    path:'/v1/chat/completions', auth:'Bearer ' + key,
    body:{model:'synthetic-model', messages:[{role:'user', content:'benign'}]},
  })
  for (const code of [301,302,303,307,308]) {
    status = code
    for (const target of [`http://127.0.0.1:${trap}/steal`, `http://127.0.0.1:${upstream}/other`]) {
      redirectTarget = target
      assert.equal((await callProxy(proxy)).status, 502)
    }
  }
  for (const invalid of [{...doc(url), http_endpoint_grant:undefined},
    {...doc(url), http_endpoint_grant:grant(url+'/other')}, doc('http://224.0.0.1:8080/v1')]) {
    configured = invalid
    assert.equal((await callProxy(proxy)).status, 502)
  }
  assert.equal(seen.length, 11)
  assert.equal(redirected, 0)
})

test('native loopback proxy uses the verified HTTPS transport without an HTTP grant', async t => {
  const upstream = await listen(t, createServer((req, res) => {
    assert.equal(req.url,'/v1/chat/completions')
    assert.equal(req.headers.authorization,'Bearer ' + key)
    req.resume()
    res.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}')
  }))
  const httpsRequester = (url, options, callback) => {
    assert.equal(url.href,'https://provider.test/v1/chat/completions')
    assert.equal(options.agent,false)
    return httpRequest(`http://127.0.0.1:${upstream}${url.pathname}`, options, callback)
  }
  const secure = {...doc('https://provider.test/v1'), http_endpoint_grant:undefined}
  const proxy = await listen(t, createBridgeServer({
    token:'synthetic-loopback-key', startupModel:() => secure,
  },{forward:(api, raw, res) => forwardModel(api, raw, res, {httpsRequester})}))
  const response = await callProxy(proxy)
  assert.equal(response.status,200)
  assert.deepEqual(await response.json(),{ok:true})
})
