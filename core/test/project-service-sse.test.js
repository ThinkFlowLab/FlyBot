// Actual HTTP/SSE transport with explicit in-memory event/authorization fixtures.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { createWorkbenchGateway } from '../src/host/workbench-gateway.js'
import { createProjectServiceEvents } from '../src/host/project-service-events.js'
async function fixture(t, maxStreams = 4) {
  const state = { projects: { p: { id: 'p', status: 'active' } }, tasks: { task: { id: 'task', projectId: 'p', status: 'open' } } }, seen = []
  let bus = createProjectServiceEvents({ maxPerProject: 2 }), allowed = true
  bus.load(state)
  const upstream = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text), input = body.payload
    seen.push({ token: req.headers['x-flybot-member-session'], cookie: req.headers.cookie, name: input.name })
    let result
    try {
      if (!allowed || req.headers['x-flybot-member-session'] !== 'fixture-member') throw Object.assign(new Error('Fixture revoked'), { code: 'bot/forbidden' })
      if (body.endpoint !== 'project-development' || input.kind !== 'query' || input.projectId !== 'p') throw Error('Wrong service query')
      result = { ok: true, value: { result: input.name === 'events' ? bus.query(input.projectId, input.payload) : bus.snapshot(input.projectId, input.payload) } }
    } catch (error) { result = { ok: false, error: { code: error.code ?? 'bot/error', details: error.details } } }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'private-owner=do-not-forward' }); res.end(JSON.stringify(result))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const gateway = createWorkbenchGateway({ upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, upstreamCookie: 'owner=private-owner', eventPollMs: 10, eventMaxStreams: maxStreams })
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening')
  const base = `http://127.0.0.1:${gateway.address().port}`
  t.after(async () => { gateway.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(done => gateway.close(done)), new Promise(done => upstream.close(done))]) })
  function update(status) { state.tasks.task.status = status; const prepared = bus.prepare(structuredClone(state)); bus.saved(prepared); return prepared.snapshot }
  return { base, seen, gateway, state, bus: () => bus, update, revoke: () => { allowed = false }, restart(snapshot) { bus = createProjectServiceEvents({ maxPerProject: 2 }); bus.load(snapshot) },
    open: (headers = {}, signal) => fetch(`${base}/api/project-events?projectId=p`, { headers: { 'x-flybot-member-session': 'fixture-member', ...headers }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) }) }
}
async function readUntil(reader, match, initial = '') {
  let text = initial
  while (!match(text)) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value) }
  return text
}

test('SSE uses the original authenticated query service and reauthenticates before subsequent facts', async t => {
  const f = await fixture(t), response = await f.open()
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/)
  assert.equal(response.headers.get('set-cookie'), null)
  const reader = response.body.getReader(), first = await readUntil(reader, text => text.includes('event: snapshot'))
  f.revoke(); f.update('after-revocation')
  const all = await readUntil(reader, () => false, first)
  assert.ok(all.includes('event: access-revoked'))
  assert.equal(all.includes('after-revocation'), false)
  assert.equal(all.includes('private-owner'), false)
  assert.ok(f.seen.every(row => row.token === 'fixture-member' && row.cookie === 'owner=private-owner'))
  assert.deepEqual(f.seen.slice(0, 2).map(row => row.name), ['project.snapshot', 'events'])
})

test('SSE Last-Event-ID resumes ordered committed facts after restart without replaying the acknowledged event', async t => {
  const f = await fixture(t), start = f.bus().snapshot('p').cursor
  f.update('working'); const snapshot = f.update('blocked')
  f.restart(snapshot)
  const control = new AbortController(), response = await f.open({ 'last-event-id': start }, control.signal), reader = response.body.getReader()
  const first = await readUntil(reader, text => (text.match(/event: fact/g) ?? []).length >= 2)
  const facts = [...first.matchAll(/data: (.+)\n/g)].map(match => JSON.parse(match[1])).filter(row => row.type)
  assert.deepEqual(facts.map(row => row.data.status), ['working', 'blocked'])
  control.abort()
  const secondControl = new AbortController(), resumed = await f.open({ 'last-event-id': facts[0].cursor }, secondControl.signal)
  const second = await readUntil(resumed.body.getReader(), text => text.includes('event: fact'))
  assert.equal(second.includes('"status":"working"'), false)
  assert.ok(second.includes('"status":"blocked"'))
  secondControl.abort()
})

test('expired SSE cursors require snapshots; credentials in URLs, missing headers and cross-scope IDs are refused', async t => {
  const f = await fixture(t), old = f.bus().snapshot('p').cursor
  for (const status of ['one', 'two', 'three']) f.update(status)
  const expired = await f.open({ 'last-event-id': old })
  assert.equal(expired.status, 409)
  assert.equal((await expired.json()).error.details.nextAction, 'project.snapshot')
  const missing = await fetch(`${f.base}/api/project-events?projectId=p`)
  assert.equal(missing.status, 401)
  assert.equal((await fetch(`${f.base}/api/project-events?projectId=p&token=secret`)).status, 400)
  const foreign = JSON.parse(Buffer.from(f.bus().snapshot('p').cursor, 'base64url').toString('utf8'))
  foreign.p = 'another-project'
  const cross = await f.open({ 'last-event-id': Buffer.from(JSON.stringify(foreign)).toString('base64url') })
  assert.equal(cross.status, 409)
  assert.equal((await cross.json()).error.code, 'bot/conflict')
})

test('SSE connections are bounded and server shutdown aborts open streams', async t => {
  const f = await fixture(t, 1), response = await f.open(), reader = response.body.getReader()
  await readUntil(reader, text => text.includes('event: snapshot'))
  const over = await f.open()
  assert.equal(over.status, 429); assert.equal((await over.json()).error.code, 'bot/busy')
  const closed = once(f.gateway, 'close'); f.gateway.close()
  await readUntil(reader, () => false)
  await closed
})
