// The credentials root is the DSH home, resolved the way the core does (#2643): a blank
// DSH_HOME counts as unset and `~` expands, and the file must not move with the process's
// working directory (a wrong root is a wrong-file write, not a display matter). The default
// subdirectory (`bot/flybot-social.json`) is unchanged.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { dshHomeOf } from '../src/dsh-home.js'

const fakeFlybot = (handlers) => {
  const fb = {
    api: { handle: (name, fn) => { handlers.set(name, fn); return () => {} } },
    fields: { get: () => undefined, set: () => {} },
    grants: { of: () => [], set: async () => {}, has: () => false },
    bot: { list: () => [] },
    rooms: { list: () => [] },
    readOnly: () => true,
    warn: () => {},
    on: () => () => {},
  }
  return { ...fb, pluginEnabled: () => true, scope: () => fb }
}

const credentialsFile = home => join(home, '.dsh', 'bot', 'flybot-social.json')

function credentialsAt(home, server) {
  mkdirSync(join(home, '.dsh', 'bot'), { recursive: true })
  writeFileSync(credentialsFile(home), JSON.stringify({ server, token: 'test-token' }), { mode: 0o600 })
}

async function statusAt(cwd) {
  process.chdir(cwd)
  const handlers = new Map()
  const ctx = { flybot: fakeFlybot(handlers), effect(fn) { this.off = fn() } }
  apply(ctx)
  try {
    return await handlers.get('social/server')()
  } finally {
    ctx.off?.()
  }
}

async function withEnv(env, run) {
  const saved = { DSH_HOME: process.env.DSH_HOME, HOME: process.env.HOME, cwd: process.cwd() }
  Object.assign(process.env, env)
  try {
    return await run()
  } finally {
    for (const key of ['DSH_HOME', 'HOME']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    process.chdir(saved.cwd)
  }
}

test('the credentials file follows the DSH home whatever the working directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-social-home-'))
  const a = mkdtempSync(join(tmpdir(), 'flybot-social-cwd-a-'))
  const b = mkdtempSync(join(tmpdir(), 'flybot-social-cwd-b-'))
  try {
    credentialsAt(home, 'https://peer.test')
    await withEnv({ DSH_HOME: '', HOME: home }, async () => {
      const first = await statusAt(a)
      const second = await statusAt(b)
      assert.equal(isAbsolute(dshHomeOf()), true, 'the resolved root is absolute')
      assert.deepEqual(first.known, ['https://peer.test'], 'the saved server is read from the DSH home')
      assert.deepEqual(second.known, first.known, 'two working directories resolve to one credentials root')
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('a blank DSH_HOME counts as unset and ~ expands like the core', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-social-home-'))
  try {
    await withEnv({ DSH_HOME: '  ', HOME: home }, () => {
      assert.equal(dshHomeOf(), join(home, '.dsh'))
    })
    await withEnv({ DSH_HOME: '~/.dsh', HOME: home }, () => {
      assert.equal(dshHomeOf(), join(home, '.dsh'))
    })
    await withEnv({ DSH_HOME: '~/data', HOME: home }, () => {
      assert.equal(dshHomeOf(), join(home, 'data'))
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
