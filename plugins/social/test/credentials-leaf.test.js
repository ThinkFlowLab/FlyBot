// The credentials file (`flybot-social.json`) is one leaf of its own (leaf-first sweep, the
// plugin package's turn after the core's journals, workflow store and decision log). `lstat` does
// not follow the last component, so a link left at that path reports itself and is refused before
// the first byte: the token, the owner id and the display name of an onboarding stay where they
// are, and a link that names a file outside the team folder takes nothing there.
//
// The same function writes the file itself, the `.bak` copy kept for another server (see
// `startSocial`) and `flybot-social-settings.json`, so one check covers all three.
import assert from 'node:assert/strict'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readCredentials, startSocial, writeCredentials } from '../src/social.js'

const CREDENTIALS = '{"token":"connector-SECRET-abc","ownerId":"owner-1","displayName":"Me"}'
const outsideFile = (home, name = 'outside.json') => {
  const path = join(home, name)
  writeFileSync(path, CREDENTIALS)
  return path
}
const homeOf = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-social-leaf-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}
// The start is expected to refuse; keeping the reason instead of letting `assert.rejects` throw first
// lets each test state the bytes that matter before it states the message.
const settle = async (run) => {
  try { return { value: await run() } } catch (failure) { return { failure } }
}
const quiet = (t) => {
  const said = []
  const real = console.warn
  console.warn = (...args) => { said.push(args.join(' ')) }
  t.after(() => { console.warn = real })
  return said
}

test('a linked credentials file is refused before the first byte; the file behind it keeps its bytes', (t) => {
  const home = homeOf(t)
  const outside = outsideFile(home)
  const before = statSync(outside)
  const path = join(home, 'flybot-social.json')
  symlinkSync(outside, path)
  quiet(t)
  assert.throws(() => writeCredentials(path, { token: 'connector-SECRET-new' }), /not a plain file/)
  const after = statSync(outside)
  assert.equal(readFileSync(outside, 'utf8'), CREDENTIALS, 'nothing is written through the link')
  assert.equal(after.size, before.size, 'no byte was added to the file behind the link')
  assert.equal(after.mtimeMs, before.mtimeMs, 'the file behind the link was not touched at all')
  assert.equal(lstatSync(path).isSymbolicLink(), true, 'the link is left exactly as it was found')
  assert.deepEqual(readdirSync(home).sort(), ['flybot-social.json', 'outside.json'], 'no intermediate file is left behind')
})

test('a hard link at the credentials file is refused: the bytes are shared with another name', (t) => {
  const home = homeOf(t)
  const outside = outsideFile(home)
  const path = join(home, 'flybot-social.json')
  linkSync(outside, path)
  quiet(t)
  assert.throws(() => writeCredentials(path, { token: 'connector-SECRET-new' }), /not a plain file/)
  assert.equal(readFileSync(outside, 'utf8'), CREDENTIALS, 'the shared inode keeps its bytes')
  assert.equal(lstatSync(outside).nlink, 2, 'the file still carries the second name')
})

test('a directory at the credentials file is refused, and stays a directory', (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  mkdirSync(path)
  quiet(t)
  assert.throws(() => writeCredentials(path, { token: 'connector-SECRET-new' }), /not a plain file/)
  assert.equal(lstatSync(path).isDirectory(), true, 'the directory is left as it was found')
  assert.deepEqual(readdirSync(home), ['flybot-social.json'], 'no file is created beside it')
  assert.deepEqual(readdirSync(path), [], 'and nothing lands inside it')
})

test('a missing credentials file is created, mode 600, and a plain one is rewritten in place', (t) => {
  const home = homeOf(t)
  const path = join(home, 'bot', 'flybot-social.json')
  writeCredentials(path, { token: 'first' })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { token: 'first' }, 'a missing leaf is ours to create')
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600)
  writeCredentials(path, { token: 'second' })
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { token: 'second' }, 'a plain leaf is written in place')
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600, 'the rewrite keeps mode 600')
})

test('the refusal names the path once, and never the values it would have written', (t) => {
  const home = homeOf(t)
  const outside = outsideFile(home)
  const path = join(home, 'flybot-social.json')
  symlinkSync(outside, path)
  const said = quiet(t)
  assert.throws(() => writeCredentials(path, { token: 'connector-SECRET-new' }))
  assert.throws(() => writeCredentials(path, { token: 'connector-SECRET-new' }))
  assert.equal(said.length, 1, 'one line per path, however often the write is tried')
  assert.ok(said[0].includes(path), 'the line names the path a reader has to look at')
  assert.ok(!said[0].includes('connector-SECRET'), 'the line carries no token, not even a fragment')
  assert.ok(!said[0].includes('owner-1') && !said[0].includes('Me'), 'and no other value from the file')
})

test('startSocial refuses loudly when the credentials path is a link, and the token already there still reads back', async (t) => {
  const home = homeOf(t)
  const outside = outsideFile(home)
  const path = join(home, 'flybot-social.json')
  symlinkSync(outside, path)
  quiet(t)
  // No `server` in the file: this start is the one that would add it and write the file back.
  const { failure } = await settle(() => startSocial({}, { server: 'https://social.test', credentialsPath: path, onboard: false }))
  assert.equal(readFileSync(outside, 'utf8'), CREDENTIALS, 'the token already there is untouched')
  assert.equal(readCredentials(path)?.token, 'connector-SECRET-abc', 'and it still reads back')
  assert.match(String(failure?.message ?? 'no failure: the start went on'), /not a plain file/, 'the start says why it did not finish')
})

test('a refused .bak write on a server switch leaves the old credentials file exactly as it was', async (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  const old = JSON.stringify({ token: 'old-token', home: { id: 'h1', handle: '@me.home' }, server: 'https://old.example' })
  writeFileSync(path, old)
  const sha8 = createHash('sha256').update('https://old.example').digest('hex').slice(0, 8)
  const outside = outsideFile(home)
  const before = statSync(outside)
  symlinkSync(outside, `${path}.${sha8}`)
  quiet(t)
  const onboarded = async () => new Response(JSON.stringify({
    connector: { token: 'new-token' },
    home: { bot_id: 'h2', handle: '@me2.home' },
    owner_id: 'owner-2',
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const { failure } = await settle(() => startSocial({}, { server: 'https://new.test', credentialsPath: path, fetch: onboarded }))
  assert.equal(readFileSync(outside, 'utf8'), CREDENTIALS, 'nothing lands in the file behind the backup link')
  assert.equal(statSync(outside).mtimeMs, before.mtimeMs)
  assert.equal(readFileSync(path, 'utf8'), old, 'the credentials in use are byte for byte what they were')
  assert.equal(readCredentials(path)?.token, 'old-token', 'and they still read back')
  assert.equal(lstatSync(path).isSymbolicLink(), false)
  assert.match(String(failure?.message ?? 'no failure: the start went on'), /not a plain file/, 'the start says why it did not finish')
})

// Onboarding is a real home on the server: it costs a round-trip and a home that cannot be reached
// once the token is dropped. A credentials path that cannot be written refuses before it, not after.
test('a linked credentials path is refused before onboarding: no server call, and no file appears', async (t) => {
  for (const shape of ['dangling', 'outside']) {
    const home = homeOf(t)
    const path = join(home, 'flybot-social.json')
    let expected
    if (shape === 'dangling') {
      symlinkSync(join(home, 'missing-target.json'), path)
      expected = ['flybot-social.json']
    } else {
      const outside = join(home, 'notes.txt')
      writeFileSync(outside, 'not a credentials file')
      symlinkSync(outside, path)
      expected = ['flybot-social.json', 'notes.txt']
    }
    quiet(t)
    const asked = []
    const onboarded = async (url) => {
      asked.push(String(url))
      return new Response(JSON.stringify({ connector: { token: 'new-token' }, home: { bot_id: 'h9', handle: '@me.home' }, owner_id: 'owner-9' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const { failure } = await settle(() => startSocial({}, { server: 'https://social.test', credentialsPath: path, onboard: true, fetch: onboarded }))
    assert.equal(asked.length, 0, `${shape}: the server was not asked for a home`)
    assert.equal(failure?.code, 'bot/refused', `${shape}: the start refuses, it does not finish`)
    assert.match(String(failure?.message ?? 'no failure: the start went on'), /not a plain file/, `${shape}: the refusal says why`)
    assert.equal(lstatSync(path).isSymbolicLink(), true, `${shape}: the link is left exactly as it was found`)
    assert.deepEqual(readdirSync(home).sort(), expected, `${shape}: no file is created beside it`)
  }
})

// The `.bak` copy kept for another server is a leaf of its own, and its name follows from the file
// already on disk — a local read — so it can be asked before the onboarding too, not after it.
test('a linked .bak path is refused before onboarding: no server call, and no home is created', async (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  const old = JSON.stringify({ token: 'old-token', home: { id: 'h1', handle: '@me.home' }, server: 'https://old.example' })
  writeFileSync(path, old)
  const sha8 = createHash('sha256').update('https://old.example').digest('hex').slice(0, 8)
  const outside = outsideFile(home)
  const before = statSync(outside)
  symlinkSync(outside, `${path}.${sha8}`)
  quiet(t)
  const asked = []
  const onboarded = async (url) => {
    asked.push(String(url))
    return new Response(JSON.stringify({ connector: { token: 'new-token' }, home: { bot_id: 'h9', handle: '@me.home' }, owner_id: 'owner-9' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const { failure } = await settle(() => startSocial({}, { server: 'https://new.test', credentialsPath: path, onboard: true, fetch: onboarded }))
  assert.equal(asked.length, 0, 'the server was not asked for a home')
  assert.equal(failure?.code, 'bot/refused', 'the start refuses, it does not finish')
  assert.match(String(failure?.message ?? 'no failure: the start went on'), /not a plain file/, 'the refusal says why')
  assert.equal(readFileSync(path, 'utf8'), old, 'the credentials in use are byte for byte what they were')
  assert.equal(readFileSync(outside, 'utf8'), CREDENTIALS, 'nothing lands in the file behind the backup link')
  assert.equal(statSync(outside).mtimeMs, before.mtimeMs, 'and the file behind it is not touched at all')
  assert.deepEqual(readdirSync(home).sort(), ['flybot-social.json', `flybot-social.json.${sha8}`, 'outside.json'], 'no file is created beside them')
})

// The other side of the same shape: with the `.bak` name free, the home is asked once and the old
// credentials land under their server, so the check above cannot pass by refusing every switch.
test('a free .bak name still onboards once, and the old credentials are kept under their server', async (t) => {
  const home = homeOf(t)
  const path = join(home, 'flybot-social.json')
  const old = JSON.stringify({ token: 'old-token', home: { id: 'h1', handle: '@me.home' }, server: 'https://old.example' })
  writeFileSync(path, old)
  const sha8 = createHash('sha256').update('https://old.example').digest('hex').slice(0, 8)
  quiet(t)
  const asked = []
  const onboarded = async (url) => {
    asked.push(String(url))
    return new Response(JSON.stringify({ connector: { token: 'new-token' }, home: { bot_id: 'h9', handle: '@me.home' }, owner_id: 'owner-9' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  // The layer below `startSocial` is not built here: the write happens before it, so this stub stops
  // the start there and leaves the two facts under test intact.
  const service = { scope() { throw new Error('the plugin scope is not built in this test') } }
  const { failure } = await settle(() => startSocial(service, { server: 'https://new.test', credentialsPath: path, onboard: true, fetch: onboarded }))
  assert.equal(asked.length, 1, 'exactly one home is asked for')
  assert.deepEqual(JSON.parse(readFileSync(`${path}.${sha8}`, 'utf8')), JSON.parse(old), 'the old credentials are kept under their server')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'new-token', 'the token that was just minted is kept')
  assert.match(String(failure?.message ?? 'no failure: the start went on'), /plugin scope is not built in this test/, 'the start gets past the write')
})

test('an absent or plain credentials path still onboards exactly once and writes the file', async (t) => {
  for (const shape of ['absent', 'plain']) {
    const home = homeOf(t)
    const path = join(home, 'flybot-social.json')
    if (shape === 'plain') writeFileSync(path, 'not a credentials file')
    quiet(t)
    const asked = []
    const onboarded = async (url) => {
      asked.push(String(url))
      return new Response(JSON.stringify({ connector: { token: 'new-token' }, home: { bot_id: 'h9', handle: '@me.home' }, owner_id: 'owner-9' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    // The layer below `startSocial` is not built here: the write happens before it, so this stub
    // stops the start there and leaves the two facts under test intact.
    const service = { scope() { throw new Error('the plugin scope is not built in this test') } }
    const { failure } = await settle(() => startSocial(service, { server: 'https://social.test', credentialsPath: path, onboard: true, fetch: onboarded }))
    assert.equal(asked.length, 1, `${shape}: exactly one home is asked for`)
    assert.match(String(failure?.message ?? 'no failure: the start went on'), /plugin scope is not built in this test/, `${shape}: the start gets past the write`)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'new-token', `${shape}: the token that was just minted is kept`)
    assert.equal(lstatSync(path).isFile() && lstatSync(path).isSymbolicLink() === false, true, `${shape}: the credentials file is a plain file of its own`)
  }
})

test('the settings file goes through the same leaf check, and the credentials beside it stay readable', (t) => {
  const home = homeOf(t)
  const outside = outsideFile(home)
  const before = statSync(outside)
  const credsPath = join(home, 'flybot-social.json')
  writeFileSync(credsPath, CREDENTIALS)
  const credsBefore = statSync(credsPath)
  const settingsPath = join(home, 'flybot-social-settings.json')
  symlinkSync(outside, settingsPath)
  quiet(t)
  assert.throws(() => writeCredentials(settingsPath, { autoAccept: { '@bob.home': true } }), /not a plain file/)
  assert.equal(readFileSync(outside, 'utf8'), CREDENTIALS)
  assert.equal(statSync(outside).mtimeMs, before.mtimeMs)
  assert.equal(existsSync(settingsPath) && lstatSync(settingsPath).isSymbolicLink(), true)
  assert.equal(readFileSync(credsPath, 'utf8'), CREDENTIALS, 'a refused settings write leaves the credentials byte for byte')
  assert.equal(statSync(credsPath).mtimeMs, credsBefore.mtimeMs)
  assert.equal(readCredentials(credsPath)?.token, 'connector-SECRET-abc', 'and they still read back')
  assert.deepEqual(readdirSync(home).sort(), ['flybot-social-settings.json', 'flybot-social.json', 'outside.json'], 'no intermediate file is left behind')
})
