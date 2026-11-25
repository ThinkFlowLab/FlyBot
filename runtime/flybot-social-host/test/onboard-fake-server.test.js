// Live Bot Social onboarding against an in-process fake server (ot-fake- tokens only).
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../../ds-bot-upstream/ds-bot/index.js'
import { fakeAttachments, fakeContext } from '../../ds-bot-upstream/ds-bot/test/fake-ctx.js'
import { applyOnRuntime } from '../index.js'
import { isFakeToken, startFakeBotSocial } from '../../flybot-image/test/fake-bot-social.mjs'

const seed = {
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

function startHost(t, { social = {}, state = seed, home, cleanupHome = true } = {}) {
  const created = home === undefined
  const dir = home ?? mkdtempSync(join(tmpdir(), 'ot-social-onboard-'))
  if (!existsSync(join(dir, 'state.json'))) writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  const ctx = fakeContext({ services: { attachments: fakeAttachments() } })
  ctx.set = (name, value) => { ctx[name] = value }
  const logs = []
  const capture = (level) => (...args) => { logs.push([level, args.map((item) => String(item)).join(' ')]) }
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  console.log = capture('log')
  console.warn = capture('warn')
  console.error = capture('error')
  console.info = capture('info')
  const restoreLogs = () => {
    console.log = orig.log
    console.warn = orig.warn
    console.error = orig.error
    console.info = orig.info
  }
  const rt = createRuntime(ctx, { home: dir, github: false, diagnosticsFile: false })
  const attached = applyOnRuntime(rt, ctx, {
    inboxPollMs: 0,
    facePollMs: 0,
    presence: false,
    credentialsPath: join(dir, 'bot', 'flybot-social.json'),
    ...social,
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    restoreLogs()
    await ctx.dispose()
    // Honor cleanupHome even when this helper created the directory, so a second
    // start can reuse the first start's credentials.
    if (cleanupHome) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
  t.after(close)
  return { rt, ctx, flybot: attached.flybot, ready: attached.social, home: dir, logs, restoreLogs, close }
}

function credentialsPath(home) {
  return join(home, 'bot', 'flybot-social.json')
}

test('without a server the host stays idle and writes no credentials', async (t) => {
  const { ready, home, flybot } = startHost(t, { social: {} })
  await ready.catch(() => undefined)
  const status = await flybot.api.call('social/server')
  assert.equal(status.server, null)
  assert.equal(existsSync(credentialsPath(home)), false)
})

test('a configured server onboards once, writes mode 0600 credentials, and does not log the token', async (t) => {
  const fake = await startFakeBotSocial()
  t.after(() => fake.close())
  const first = startHost(t, { social: { server: fake.url, displayName: 'FlyBot' }, cleanupHome: false })
  await first.ready
  const path = credentialsPath(first.home)
  const info = lstatSync(path)
  assert.equal(info.isFile(), true)
  assert.equal(info.mode & 0o777, 0o600)
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.token, fake.token)
  assert.equal(isFakeToken(saved.token), true)
  assert.equal(typeof saved.home?.id, 'string')
  assert.ok(saved.home.id)
  const leaked = first.logs.some(([, line]) => line.includes(fake.token))
  assert.equal(leaked, false, 'connector token must not appear in console output')
  assert.equal(fake.stats.onboard, 1)
  const status = await first.flybot.api.call('social/server')
  assert.equal(status.server, fake.url)
  assert.equal(status.state, 'connected', status.error || JSON.stringify(status))
  await first.close()

  const second = startHost(t, { home: first.home, social: { server: fake.url, displayName: 'FlyBot' }, cleanupHome: true })
  await second.ready
  assert.equal(fake.stats.onboard, 1, 'a second start must reuse saved credentials')
  const again = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(again.token, fake.token)
  const leakedAgain = second.logs.some(([, line]) => line.includes(fake.token))
  assert.equal(leakedAgain, false)
  const status2 = await second.flybot.api.call('social/server')
  assert.equal(status2.state, 'connected', status2.error || JSON.stringify(status2))
})

test('a torn credentials file is refused and does not trigger another onboard', async (t) => {
  const fake = await startFakeBotSocial()
  t.after(() => fake.close())
  const home = mkdtempSync(join(tmpdir(), 'ot-social-torn-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const path = credentialsPath(home)
  mkdirSync(join(home, 'bot'), { recursive: true })
  writeFileSync(path, '{', { mode: 0o600 })
  const { ready, flybot } = startHost(t, { home, social: { server: fake.url }, cleanupHome: false })
  // controller.ready() swallows start failures so Settings can still show the error.
  await ready
  const status = await flybot.api.call('social/server')
  assert.equal(status.state, 'error')
  assert.match(String(status.error || ''), /does not parse as JSON|damaged|credentials/i)
  assert.equal(fake.stats.onboard, 0)
  assert.equal(readFileSync(path, 'utf8'), '{')
})
