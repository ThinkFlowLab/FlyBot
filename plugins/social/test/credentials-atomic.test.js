// A credentials write that dies half way must not take the previous identity with it (#2631).
//
// `writeCredentials` writes the credentials file, the `.bak` copy and
// `flybot-social-settings.json`; writing in place truncates first, so a torn file is what is
// left when the write stops early. The write lands through `<path>.<pid>.tmp` and a rename
// instead, and a start refuses a file that exists but does not parse rather than reading it as
// "nothing configured" — the difference is a fresh Bot Social home onboarded over the old one.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSocial, readCredentials, startSocial, writeCredentials } from '../src/social.js'

const homeOf = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-social-atomic-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

const settle = async (run) => {
  try { return { value: await run() } } catch (failure) { return { failure } }
}

const quiet = (t) => {
  const real = console.warn
  console.warn = () => {}
  t.after(() => { console.warn = real })
}

// The bytes the 16th audit round left behind: the first write was cut inside the token.
const TORN = '{\n "token": "tok-OLD-12'

test('a torn credentials file does not read as "not configured", and the start does not onboard over it', async (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  writeFileSync(path, TORN)
  quiet(t)
  assert.throws(() => readCredentials(path), (error) => {
    assert.match(String(error?.message), /damaged/, 'the read says the file is damaged')
    assert.ok(String(error?.message).includes(path), 'and names the file a reader has to look at')
    return true
  }, 'a file that exists and does not parse is not "nothing saved yet"')

  // The start used to onboard a new home here and overwrite the torn file (issue steps D and E).
  const asked = []
  const onboarded = async (url) => {
    asked.push(String(url))
    return new Response(JSON.stringify({ connector: { token: 'tok-NEW-9999' }, home: { bot_id: 'h9', handle: '@me.home' }, owner_id: 'owner-9' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { failure } = await settle(() => startSocial({ scope() { throw new Error('the plugin scope is not built in this test') } }, { server: 'https://social.test', credentialsPath: path, onboard: true, fetch: onboarded }))
  assert.equal(asked.length, 0, 'the server was not asked for a new home')
  assert.match(String(failure?.message ?? 'no failure: the start went on'), /damaged/, 'the start refuses instead of onboarding')
  assert.equal(readFileSync(path, 'utf8'), TORN, 'the torn bytes are left where the operator can see them, not overwritten')
  assert.deepEqual(readdirSync(home).sort(), ['flybot-social.json'], 'and no new identity was written beside them')
})

test('a failed credentials write leaves the previous file byte for byte', (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  const old = { token: 'tok-OLD-12', home: { id: 'h1', handle: '@me.home' }, server: 'https://social.test' }
  writeCredentials(path, old)
  const before = readFileSync(path, 'utf8')
  // The temp file cannot be created while the directory is read-only; the file in it is still
  // writable, so the truncate-then-write shape would replace the credentials without failing.
  chmodSync(home, 0o500)
  try {
    assert.throws(() => writeCredentials(path, { token: 'tok-NEW-9999' }), (error) => error?.code === 'EACCES' || error?.code === 'EPERM')
    assert.equal(readFileSync(path, 'utf8'), before, 'the credentials are byte for byte what they were')
    assert.deepEqual(readdirSync(home).sort(), ['flybot-social.json'], 'a failed write leaves no intermediate file behind')
  } finally {
    chmodSync(home, 0o700)
  }
})

test('a successful write lands in one rename and leaves no intermediate file', (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  writeCredentials(path, { token: 'tok-OLD-12' })
  writeCredentials(path, { token: 'tok-NEW-9999' })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { token: 'tok-NEW-9999' })
  assert.deepEqual(readdirSync(home).sort(), ['flybot-social.json'], 'no *.tmp is left beside the file')
})

test('a torn settings file is refused too, instead of being read as empty', (t) => {
  const home = homeOf(t)
  const credentialsPath = join(home, 'flybot-social.json')
  const settingsPath = join(home, 'flybot-social-settings.json')
  writeFileSync(credentialsPath, JSON.stringify({ token: 'tok-OLD-12', home: { id: 'h1', handle: '@me.home' }, server: 'https://social.test' }))
  writeFileSync(settingsPath, '{"autoAccept": {')
  quiet(t)
  // Every host service is unused before the settings load: the start refuses there, so one
  // stand-in for all of them keeps the test on the file and not on the host shape.
  const anything = new Proxy(function () {}, { get: (target, key) => (key === 'then' ? undefined : anything), apply: () => undefined, construct: () => ({}) })
  const flybot = new Proxy({}, { get: (target, key) => (key === 'then' ? undefined : anything) })
  assert.throws(() => createSocial({ scope: () => flybot }, { server: 'https://social.test', token: 'tok-OLD-12', credentialsPath, settingsPath, fetch: async () => { throw new Error('no network in this test') } }, { setInterval: () => 0, clearInterval: () => {} }), (error) => {
    assert.match(String(error?.message), /settings/, 'the start says which file is damaged')
    assert.ok(String(error?.message).includes(settingsPath), 'and names it')
    return true
  }, 'a settings file that exists and does not parse is not "nothing saved yet"')
  assert.equal(readFileSync(settingsPath, 'utf8'), '{"autoAccept": {', 'the damaged file is left as it was found')
})
