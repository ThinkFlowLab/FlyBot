import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyArtifact } from '../artifact.mjs'

function fixture(t, code = 'export const add = (a, b) => a + b', proof = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flybot-proof-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'probe.mjs'), code)
  writeFileSync(join(dir, 'proof.json'), JSON.stringify({ cwd: dir, test: 'passed', sum: 5, ...proof }))
  return dir
}

test('accept actual executable code with a matching cwd and successful test evidence', async t => {
  const dir = fixture(t)
  assert.equal((await verifyArtifact(dir)).cwd, dir)
})

test('a completion claim without a file cannot pass', async t => {
  const dir = fixture(t)
  rmSync(join(dir, 'proof.json'))
  await assert.rejects(verifyArtifact(dir), { code: 'ENOENT' })
})

test('reject evidence from another directory even if the model reports success', async t => {
  await assert.rejects(verifyArtifact(fixture(t, undefined, { cwd: '/a/different/worktree' })), /assigned directory/)
})

test('reject failed test evidence or a fabricated numeric result', async t => {
  await assert.rejects(verifyArtifact(fixture(t, undefined, { test: 'failed' })), /executed test/)
  await assert.rejects(verifyArtifact(fixture(t, undefined, { sum: 999 })), /recorded result/)
})

test('regression: constant-five code must not pass independent verification', async t => {
  // The original M0 checker asked only add(7, -2), also 5: a false implementation passed.
  await assert.rejects(verifyArtifact(fixture(t, 'export const add = () => 5')), /Independent case/)
})

test('reject a missing code export even when the proof JSON claims success', async t => {
  await assert.rejects(verifyArtifact(fixture(t, 'export const other = 5')), /must export add/)
})

test('Codex live acceptance requires explicit profile/model and an owned GitHub repository', async () => {
  const { codexSettings } = await import('../codex-check.mjs')
  const flags = ['--codex-profile', '/private/config', '--codex-model', 'test-model', '--github-login', 'owner', '--github-repo', 'owner/fork', '--github-config-dir', '/private/gh']
  assert.equal(codexSettings(flags).repository, 'owner/fork')
  for (const option of ['--codex-profile', '--codex-model', '--github-login', '--github-repo', '--github-config-dir']) {
    const missing = flags.slice(), index = missing.indexOf(option)
    missing.splice(index, 2)
    assert.throws(() => codexSettings(missing), /requires explicit/)
  }
  assert.throws(() => codexSettings(flags.map(value => value === 'owner/fork' ? 'someone-else/fork' : value)), /requires explicit/)
  assert.throws(() => codexSettings(flags.map(value => value === '/private/config' ? 'relative' : value)), /requires explicit/)
})

test('agent fixture recognizes independent personal identities and retains legacy persona compatibility', async () => {
  const { agentReply } = await import('../agents.mjs')
  for (const system of ['You are this human’s personal agent participating in this Project through an isolated context.', 'You are this human’s private Project agent. Your identity is one human in one Project.']) {
    const body = { system, messages: [{ role: 'user', content: 'Propose a shared task privately' }] }
    assert.equal(agentReply({ body, result: false })?.[0].name, 'project_agent_context')
    assert.equal(agentReply({ body, result: true })?.[0].name, 'project_agent_task')
  }
  assert.equal(agentReply({ body: { system: 'Unrelated worker', messages: [] }, result: false }), undefined)
})
