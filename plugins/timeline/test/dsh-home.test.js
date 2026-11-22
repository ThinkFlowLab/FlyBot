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
  const saved = { DSH_HOME: process.env.DSH_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, cwd: process.cwd() }
  Object.assign(process.env, env)
  // Windows resolves a bare home from USERPROFILE, not HOME (os.homedir()).
  if (process.platform === 'win32' && env.HOME !== undefined) process.env.USERPROFILE = env.HOME
  try {
    return run()
  } finally {
    for (const key of ['DSH_HOME', 'HOME', 'USERPROFILE']) {
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
    // An absolute DSH_HOME is used as it is; on Windows that absolute path carries a drive letter.
    const absolute = process.platform === 'win32' ? join(tmpdir(), 'flybot-timeline-absolute') : '/var/lib/flybot'
    withEnv({ DSH_HOME: absolute, HOME: home }, () => {
      assert.equal(traceDirAt(cwd), join(absolute, 'bot', 'flybot-timeline'))
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
