import assert from 'node:assert/strict'
import test from 'node:test'
import {startToolServer} from '../features/connectors/tool-server.js'

test('the native connector endpoint only accepts calls at its loopback capability path', async t => {
  const seen = []
  const tools = startToolServer({
    async callTool(...args) {
      seen.push(args)
      return {successful:true}
    },
  })
  t.after(tools.close)
  const url = await tools.ready
  const name = 'GITHUB_CREATE_AN_ISSUE_COMMENT'
  const args = {issue_number:1, body:'Fixture'}
  const call = (address, headers = {}) => fetch(address, {
    method:'POST', headers:{'Content-Type':'application/json', ...headers},
    body:JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/call', params:{name, arguments:args}}),
  })
  assert.equal(new URL(url).hostname, '127.0.0.1')
  const rejected = await call(new URL('/mcp/invalid',url))
  assert.equal(rejected.status, 404)
  const browser = await call(url, {Origin:'https://botawaken.com'})
  assert.equal(browser.status, 403)
  const runtime = await call(url + '?v=7')
  assert.equal(runtime.status, 200)
  assert.deepEqual(seen, [[name,args]])
})
