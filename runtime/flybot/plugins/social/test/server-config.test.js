// #2675: a read-only window still shows the Bot Social home another window onboarded, but it
// must never ask Bot Social for one and never write the shared credentials file. `startSocial`
// is reached from the plugin lifecycle (`apply` → `controller.ready()` → `launch()`), which the
// core's read-only endpoint guard cannot see, so the guard has to live on this path too.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { startSocial } from '../src/social.js'
import { createServerController } from '../src/server-config.js'

const homeOf = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-social-readonly-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

// The plugin service `startSocial` receives, reduced to what a start touches; `readOnly` is the
// host switch (`flybot.readOnly()`), the same one the social endpoints already read.
function fakeFlybot(readOnly) {
  return {
    readOnly,
    bot: {
      list: () => [], get: () => undefined, update: async () => {}, hasAnyGrant: () => false,
      send: { use: () => () => {}, priority: { APPROVAL: 900 } },
    },
    fields: { get: () => undefined, set: () => {} },
    grants: { of: () => [], set: async () => {}, has: () => false },
    rooms: { list: () => [], ofFace: () => undefined },
    transports: { add: () => () => {} },
    tools: { register: () => () => {} },
    api: { handle: () => () => {} },
    remote: { publish: value => value },
    on: () => () => {},
    ready: async () => undefined,
    warn: () => {},
  }
}
const serviceOf = (flybot) => ({ scope: () => flybot })

// A Bot Social server that records every request: onboarding is the one write this issue is about,
// the MCP and face-room reads answer empty so a started layer settles without a real server.
function mockServer() {
  let onboarded = 0
  const calls = []
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  const fetch = async (url, init = {}) => {
    const text = String(url)
    calls.push({ url: text, method: init.method ?? 'GET' })
    if (text.endsWith('/v1/onboard/flybot')) {
      onboarded += 1
      return json({ owner_id: 'o1', connector: { token: 'tok-new' }, home: { bot_id: 'h1', handle: '@me.home' } })
    }
    if (text.includes('/v1/face-rooms')) return json({ rooms: [] })
    if (text.endsWith('/mcp')) {
      const body = JSON.parse(init.body)
      const results = { list_remote_bots: { homes: [] }, list_friends: { friends: [] }, whoami: { kind: 'owner' }, list_bot_grants: [] }
      return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(results[body.params.name] ?? {}) }] } })
    }
    return json({})
  }
  return { fetch, calls, onboarded: () => onboarded }
}

const configOf = (path, server, extra = {}) => ({ server: 'https://social.test', credentialsPath: path, fetch: server.fetch, inboxPollMs: 0, ...extra })

test('#2675: a read-only window without credentials never onboards and writes no credentials', async (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  const server = mockServer()
  const before = readdirSync(home)
  const social = await startSocial(serviceOf(fakeFlybot(() => true)), configOf(path, server, { readOnly: true }))
  social?.dispose?.()
  assert.equal(server.calls.length, 0, `a read-only start made no HTTP request, saw ${server.calls.map(call => `${call.method} ${call.url}`).join(', ')}`)
  assert.equal(server.onboarded(), 0, 'no home was onboarded')
  assert.equal(existsSync(path), false, 'no credentials file was written')
  assert.deepEqual(readdirSync(home), before, 'the data folder is what it was')
})

test('#2675: a read-only window leaves a credentials file that has no server field byte for byte', async (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  writeFileSync(path, JSON.stringify({ token: 'tok-old', home: { id: 'h1', handle: '@me.home' }, displayName: 'Me' }, null, 2))
  const before = readFileSync(path)
  const server = mockServer()
  const social = await startSocial(serviceOf(fakeFlybot(() => true)), configOf(path, server, { readOnly: true }))
  t.after(() => social?.dispose?.())
  assert.deepEqual(readFileSync(path), before, 'the file the writable window owns is not rewritten')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).server, undefined)
})

test('#2675: a writable window still onboards once and writes the credentials once', async (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  const server = mockServer()
  const social = await startSocial(serviceOf(fakeFlybot(() => false)), configOf(path, server, { readOnly: false }))
  t.after(() => social?.dispose?.())
  assert.equal(server.onboarded(), 1, 'the onboarding still happens in a writable window')
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.token, 'tok-new')
  assert.deepEqual(saved.home, { id: 'h1', handle: '@me.home' })
  assert.equal(saved.server, 'https://social.test')
  assert.deepEqual(readdirSync(home).filter(name => name.startsWith('flybot-social.json')), ['flybot-social.json'], 'one credentials file, no temp leftover')
})

test('#2675: a read-only window with saved credentials still starts the layer and writes nothing', async (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  const saved = { token: 'tok-old', home: { id: 'h1', handle: '@me.home' }, server: 'https://social.test' }
  writeFileSync(path, JSON.stringify(saved, null, 2))
  const before = readFileSync(path)
  const server = mockServer()
  const social = await startSocial(serviceOf(fakeFlybot(() => true)), configOf(path, server, { readOnly: true }))
  t.after(() => social?.dispose?.())
  assert.ok(social, 'the read-only window still gets the social layer so friends and messages stay visible')
  assert.deepEqual(social.home, { id: 'h1', handle: '@me.home' }, 'the saved home is the one it shows')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(readFileSync(path), before, 'a start from a read-only window writes neither the credentials nor their server field')
  assert.deepEqual(readdirSync(home).sort(), ['flybot-social.json'], 'no settings or backup file is created')
  assert.equal(server.onboarded(), 0)
})

test('#2675: the start the server controller composes carries the live read-only switch', async (t) => {
  const home = homeOf(t)
  const seen = []
  const controller = createServerController({
    base: {
      server: 'https://social.test',
      credentialsPath: join(home, 'flybot-social.json'),
      settingsPath: join(home, 'flybot-social-settings.json'),
      inboxPollMs: 0,
    },
    flybot: fakeFlybot(() => true),
    start: async (config) => { seen.push(config.readOnly); return { dispose() {} } },
  })
  t.after(() => controller.dispose())
  await controller.ready()
  assert.deepEqual(seen, [true], 'the start config reads the host switch instead of a snapshot')
})
