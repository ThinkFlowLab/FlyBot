import assert from 'node:assert/strict'
import test from 'node:test'
import {startToolServer} from '../features/connectors/tool-server.js'

test('only the private native MCP endpoint can opt into automatic Composio reads', async t => {
  const seen = []
  const tools = startToolServer({
    async callTool(_name, _args, options) {
      seen.push(options.automaticReads)
      return {success:true}
    },
  })
  t.after(tools.close)
  const manual = await tools.ready
  const owner = await tools.ownerPrivateToolUrl(manual + '?v=7')
  assert.notEqual(new URL(owner).pathname, new URL(manual).pathname)
  assert.equal(new URL(owner).search, '?v=7')
  assert.equal(await tools.ownerPrivateToolUrl('https://example.com/mcp?v=7'), undefined)

  const call = (url, headers = {}) => fetch(url, {
    method:'POST', headers:{'Content-Type':'application/json', ...headers},
    body:JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/call',
      params:{name:'GITHUB_CHECK_IF_PULL_REQUEST_MERGED', arguments:{pull_number:1}}}),
  })
  const ordinary = await call(manual + '?automaticReads=true')
  assert.equal(ordinary.status, 200)
  const privateChat = await call(owner)
  assert.equal(privateChat.status, 200)
  const browser = await call(owner, {Origin:'https://botawaken.com'})
  assert.equal(browser.status, 403)
  assert.deepEqual(seen, [false,true])
})
