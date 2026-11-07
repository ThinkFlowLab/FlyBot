// The trace root is the DSH home, resolved the way the core does (#2643): a blank DSH_HOME
// counts as unset and `~` expands, and the answer must not move with the process's working
// directory. The default subdirectory (`bot/flybot-timeline`) is unchanged.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'

const flybot = () => ({
  scope: () => ({
    on: () => () => {},
    bot: { list: () => [] },
    rooms: { list: () => [] },
    readOnly: () => true,
    warn: () => {},
    api: { handle: () => () => {} },
  }),
})

function traceDirAt(cwd) {
  process.chdir(cwd)
  const ctx = { flybot: flybot(), effect(fn) { this.off = fn() } }
  const result = apply(ctx, { enabled: true, persist: false })
  const dir = result.timeline.trace.dir
  result.dispose()
  return dir
}

function withEnv(env, run) {
  const saved = { DSH_HOME: process.env.DSH_HOME, HOME: process.env.HOME, cwd: process.cwd() }
  Object.assign(process.env, env)
  try {
    return run()
  } finally {
    for (const key of ['DSH_HOME', 'HOME']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    process.chdir(saved.cwd)
  }
}

test('the trace root is absolute and does not follow the working directory', () => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-timeline-home-'))
  const a = mkdtempSync(join(tmpdir(), 'flybot-timeline-cwd-a-'))
  const b = mkdtempSync(join(tmpdir(), 'flybot-timeline-cwd-b-'))
  try {
    withEnv({ DSH_HOME: '', HOME: home }, () => {
      const first = traceDirAt(a)
      const second = traceDirAt(b)
      assert.equal(isAbsolute(first), true, 'the trace root is absolute')
      assert.equal(first, join(home, '.dsh', 'bot', 'flybot-timeline'))
      assert.equal(second, first, 'two working directories resolve to one trace root')
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('a blank DSH_HOME counts as unset and ~ expands like the core', () => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-timeline-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'flybot-timeline-cwd-'))
  try {
    withEnv({ DSH_HOME: '  ', HOME: home }, () => {
      assert.equal(traceDirAt(cwd), join(home, '.dsh', 'bot', 'flybot-timeline'))
    })
    withEnv({ DSH_HOME: '~/.dsh', HOME: home }, () => {
      assert.equal(traceDirAt(cwd), join(home, '.dsh', 'bot', 'flybot-timeline'))
    })
    withEnv({ DSH_HOME: '/var/lib/flybot', HOME: home }, () => {
      assert.equal(traceDirAt(cwd), '/var/lib/flybot/bot/flybot-timeline')
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
