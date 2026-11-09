// #2717: a settings or identity file that exists but does not parse is not "nothing was saved".
// Reading it as absent lost a parked Bot identity and let the next park() replace the only copy;
// a torn server choice silently fell back to the config server. Absent (ENOENT) still means
// "nothing saved yet", so first runs and servers never visited keep working.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServerController, serverTag } from '../src/server-config.js'

const homeOf = (t) => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-social-damaged-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return home
}

// One local Bot holding the identity the server it is on issued: a member handle and one grant.
function fakeFlybot() {
  const fields = new Map([['b1', { member: { id: 'm1', handle: '@b1.home' }, autoApprove: undefined }]])
  const grants = new Map([['b1', [{ scope: 'friends' }]]])
  return {
    bot: { list: () => [{ id: 'b1' }], get: id => (id === 'b1' ? { id: 'b1' } : undefined) },
    fields: {
      get: (id, key) => fields.get(id)?.[key],
      set: (id, key, value) => {
        const entry = fields.get(id) ?? {}
        entry[key] = value
        fields.set(id, entry)
      },
    },
    grants: { of: id => grants.get(id) ?? [], set: async (id, value) => { grants.set(id, value) } },
    readOnly: () => false,
  }
}

const controllerFor = (home, flybot, { server = 'https://a.test', warn } = {}) => createServerController({
  base: { server, credentialsPath: join(home, 'flybot-social.json'), displayName: 'Me' },
  flybot,
  warn,
  probe: async () => ({ name: 'Bot Social', features: [] }),
  start: async () => ({ home: { handle: '@me.home' }, dispose: () => {} }),
  startTimeoutMs: 20,
})

const warningsOf = () => {
  const lines = []
  const warn = (...args) => lines.push(args.map(value => String(value)).join(' '))
  return { lines, warn }
}

test('#2717: a torn parked identity file refuses the switch and keeps its bytes', async (t) => {
  const home = homeOf(t)
  const say = warningsOf()
  const controller = controllerFor(home, fakeFlybot(), { warn: say.warn })
  t.after(() => controller.dispose())
  // A real switch parks the identity of the server being left.
  await controller.set({ server: 'https://b.test', confirm: true })
  assert.equal(controller.status().server, 'https://b.test')
  const parked = join(home, `flybot-social-bots.${serverTag('https://a.test')}.json`)
  const whole = readFileSync(parked)
  assert.ok(whole.length > 0, 'the switch parked the identity')
  const torn = whole.subarray(0, Math.floor(whole.length / 2))
  writeFileSync(parked, torn)

  await assert.rejects(controller.set({ server: 'https://a.test', confirm: true }), (error) => {
    assert.equal(error.code, 'bot/refused')
    assert.ok(error.message.includes(parked), `the refusal names the path: ${error.message}`)
    assert.match(error.message, /does not parse as JSON/i)
    assert.match(error.message, /nothing here changed it/i)
    return true
  })
  assert.deepEqual(readFileSync(parked), torn, 'the file it could not read is byte for byte where it was')
  assert.equal(controller.status().server, 'https://b.test', 'the live server did not move')

  // Switching somewhere else afterwards still does not write over the torn file.
  await controller.set({ server: 'https://c.test', confirm: true })
  assert.deepEqual(readFileSync(parked), torn, 'a later switch leaves the unreadable file alone')
})

test('#2717: a missing parked identity file is still "nothing saved yet"', async (t) => {
  const home = homeOf(t)
  const say = warningsOf()
  const controller = controllerFor(home, fakeFlybot(), { warn: say.warn })
  t.after(() => controller.dispose())
  await controller.set({ server: 'https://b.test', confirm: true })
  assert.equal(controller.status().server, 'https://b.test', 'a server never visited starts fine')
  assert.deepEqual(say.lines, [], 'nothing to warn about')
  assert.equal(existsSync(join(home, `flybot-social-bots.${serverTag('https://b.test')}.json`)), false)
})

test('#2717: a torn server choice refuses instead of falling back to the config server', (t) => {
  const home = homeOf(t)
  const override = join(home, 'flybot-social-server.json')
  writeFileSync(override, '{"server":"https://picked-in-settings.test","savedAt":"')
  assert.throws(() => controllerFor(home, fakeFlybot()), (error) => {
    assert.equal(error.code, 'bot/refused')
    assert.ok(error.message.includes(override), `the refusal names the path: ${error.message}`)
    assert.match(error.message, /does not parse as JSON/i)
    return true
  })
})

test('#2717: no server choice still reads as the config default', (t) => {
  const home = homeOf(t)
  const controller = controllerFor(home, fakeFlybot())
  t.after(() => controller.dispose())
  assert.equal(controller.status().server, 'https://a.test')
  assert.equal(controller.status().source, 'config')
})

test('#2717: a torn credentials file of another server is warned about, not read as absent', (t) => {
  const home = homeOf(t)
  const other = join(home, `flybot-social.json.${serverTag('https://b.test')}`)
  writeFileSync(other, '{"server":"https://b.test","token":"')
  const say = warningsOf()
  const controller = controllerFor(home, fakeFlybot(), { warn: say.warn })
  t.after(() => controller.dispose())
  assert.deepEqual(controller.status().known, [], 'the unreadable entry is not listed as a known server')
  assert.ok(say.lines.some(line => line.includes(other)), `a warning names the path, saw ${JSON.stringify(say.lines)}`)
})
