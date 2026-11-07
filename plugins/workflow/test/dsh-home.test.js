// The workflow store root is the DSH home, resolved the way the core does (#2643): a blank
// DSH_HOME counts as unset and `~` expands, and the store must not move with the process's
// working directory. The default subdirectory (`bot/flybot-workflow`) is unchanged.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'

const fakeFlybot = (handlers) => {
  const fb = {
    api: { handle: (name, fn) => { handlers.set(name, fn); return () => {} } },
    tools: { register: () => () => {} },
    bot: { list: () => [] },
    rooms: { list: () => [] },
    readOnly: () => false,
    warn: () => {},
  }
  return { ...fb, pluginEnabled: () => true, scope: () => fb }
}

async function startAt(cwd, handlers) {
  process.chdir(cwd)
  const ctx = { flybot: fakeFlybot(handlers), effect(fn) { this.off = fn() } }
  const plugin = apply(ctx, {})
  return { plugin, stop: async () => { await plugin.dispose() } }
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

const storeFile = (home, name) => join(home, '.dsh', 'bot', 'flybot-workflow', name)

test('the workflow store lands in the DSH home whatever the working directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-workflow-home-'))
  const a = mkdtempSync(join(tmpdir(), 'flybot-workflow-cwd-a-'))
  const b = mkdtempSync(join(tmpdir(), 'flybot-workflow-cwd-b-'))
  try {
    await withEnv({ DSH_HOME: '', HOME: home }, async () => {
      const first = await startAt(a, new Map())
      try {
        const created = first.plugin.service.create({ name: 'Root', nodes: [{ id: 'n1', name: 'Step', prompt: 'Do the thing' }], layers: [['n1']] })
        assert.equal(created.ok, true, `create answered ${JSON.stringify(created)}`)
        assert.equal(isAbsolute(storeFile(home, 'workflows.json')), true)
        assert.equal(existsSync(storeFile(home, 'workflows.json')), true, 'the store is under the DSH home')
        assert.equal(existsSync(join(a, 'bot', 'flybot-workflow', 'workflows.json')), false, 'nothing is written beside the cwd')
      } finally {
        await first.stop()
      }

      const second = await startAt(b, new Map())
      try {
        const names = second.plugin.service.state().workflows.map(item => item.name)
        assert.equal(names.includes('Root'), true, `another working directory reads the same store (${names.join(', ')})`)
      } finally {
        await second.stop()
      }
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('a blank DSH_HOME counts as unset and ~ expands like the core', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flybot-workflow-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'flybot-workflow-cwd-'))
  try {
    await withEnv({ DSH_HOME: '  ', HOME: home }, async () => {
      const run = await startAt(cwd, new Map())
      try {
        assert.equal(run.plugin.service.create({ name: 'Blank', nodes: [{ id: 'n1', name: 'Step', prompt: 'Do the thing' }], layers: [['n1']] }).ok, true)
        assert.equal(existsSync(storeFile(home, 'workflows.json')), true)
      } finally {
        await run.stop()
      }
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
