import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dependencyEnvironment, prepareDependencyEnvironment, executionOutcome, copyDependencyCacheScript } from '../src/host/project-execution-environment.js'
const exec = promisify(execFile)

test('environment outcomes retain non-success and separate dependency, assertion, timeout and unknown exit', () => {
  assert.equal(executionOutcome(null).status, 'passed')
  assert.equal(executionOutcome({ code: 1 }, 'npm error ENOTCACHED only-if-cached').status, 'environment-blocked')
  assert.equal(executionOutcome({ code: 1 }, 'AssertionError ERR_ASSERTION').status, 'assertion-failed')
  assert.equal(executionOutcome({ code: 3 }, 'compiler failed').status, 'test-process-failed')
  assert.equal(executionOutcome({ code: 'ENOENT' }).status, 'environment-blocked')
  assert.equal(executionOutcome({ killed: true }).status, 'execution-timeout')
  assert.equal(executionOutcome({ killed: true }, '', { remote: true }).exitConfirmed, false)
  assert.equal(executionOutcome({ code: 'ECONNRESET' }, '', { remote: true }).status, 'execution-unknown')
  assert.equal(executionOutcome({ code: 37 }, '', { stage: 'preparation' }).status, 'environment-blocked')
  for (const output of ['sh: 1: vitest: not found', '/bin/sh: vitest: command not found']) {
    assert.equal(executionOutcome({ code: 127 }, output).status, 'environment-blocked')
    assert.equal(executionOutcome({ code: 127 }, output).stage, 'runner-startup')
  }
  assert.equal(executionOutcome({ code: 127 }, '').reason, 'test-runner-unavailable')
  assert.equal(executionOutcome({ code: 1 }, 'AssertionError: expected true to be false').status, 'assertion-failed')
})
test('dependency contract rejects escaping paths, arbitrary network modes and malformed commands', () => {
  for (const spec of [{ lockFiles: ['../package-lock.json'] }, { npmCachePath: '/owner/cache' }, { tools: [{ argv: 'npm --version' }] }, { network: 'full-access' }, { timeoutMs: 0 }, { arbitraryAuthority: true }]) assert.throws(() => dependencyEnvironmentCheck(spec), { code: 'bot/repository-config' })
  function dependencyEnvironmentCheck(spec) { return dependencyEnvironment({ dependencyEnvironment: spec }) }
})

test('actual offline cache miss is not a code assertion failure; prepared offline dependencies execute real tests', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'flybot-dependency-env-'))
  try {
    const env = { PATH: process.env.PATH, HOME: cwd, npm_config_cache: join(cwd, 'fresh-cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false', LANG: 'C.UTF-8' }
    let miss
    try { await exec('npm', ['exec', '--offline', '--yes', '--package=flybot-no-cached-package-2334@1.0.0', '--', 'nonexistent-command'], { cwd, env, timeout: 15_000 }) } catch (error) { miss = error }
    assert.ok(miss)
    assert.match(miss.stderr, /ENOTCACHED|only-if-cached/)
    assert.equal(executionOutcome(miss, miss.stdout + miss.stderr).status, 'environment-blocked')
    await writeFile(join(cwd, 'package-lock.json'), '{"lockfileVersion":3}')
    const settings = { dependencyEnvironment: { packageManager: 'npm', lockFiles: ['package-lock.json'], requiredPaths: ['node_modules/local-fixture/index.js'], tools: [{ argv: [process.execPath, '--version'], expectedOutput: process.version }], network: 'offline' }, workspacePrepareCommand: [process.execPath, '-e', 'const fs=require("fs");fs.mkdirSync("node_modules/local-fixture",{recursive:true});fs.writeFileSync("node_modules/local-fixture/index.js","module.exports=42")'] }
    const run = (argv, timeout) => exec(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { cwd, env, timeout })
    const scope = { projectId: 'p', attemptId: 'a', workspaceId: 'w', resourceId: 'isolated-test-resource', candidateSha: 'a'.repeat(40), executor: process.env.FLYBOT_TEST_ENV_EXECUTOR ?? 'local-resource' }
    const receipt = await prepareDependencyEnvironment({ settings, scope, run })
    assert.equal(receipt.status, 'ready')
    assert.equal(receipt.candidateSha, scope.candidateSha)
    assert.match(receipt.locks['package-lock.json'], /^[a-f0-9]{64}$/)
    assert.equal(receipt.tools[0].output, process.version)
    await run([process.execPath, '-e', 'require("node:assert/strict").equal(require("local-fixture"),42)'], 5000)
    const original = receipt.identitySha256
    await writeFile(join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}')
    assert.notEqual((await prepareDependencyEnvironment({ settings, scope, run })).identitySha256, original)
    await assert.rejects(prepareDependencyEnvironment({ settings: { ...settings, dependencyEnvironment: { ...settings.dependencyEnvironment, network: 'operator-preparation' } }, scope, run }), error => error.environmentReceipt.status === 'environment-blocked')
    const bad = { ...settings, workspacePrepareCommand: [process.execPath, '-e', 'process.exit(37)'] }
    await assert.rejects(prepareDependencyEnvironment({ settings: bad, scope, run }), error => error.code === 37 && error.environmentReceipt.status === 'environment-blocked')
    const changed = { ...settings, workspacePrepareCommand: [process.execPath, '-e', 'require("fs").writeFileSync("package-lock.json","changed")'] }
    await assert.rejects(prepareDependencyEnvironment({ settings: changed, scope, run }), error => error.environmentReceipt.reason === 'dependency-contract-unavailable')
    assert.equal(await readFile(join(cwd, 'package-lock.json'), 'utf8'), 'changed')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('warmed dependency caches copy into a unique scratch and refuse outside or symbolic sources', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'flybot-cache-copy-'))
  try {
    const source = join(cwd, 'prepared'), target = join(cwd, 'scratch-cache')
    await mkdir(source)
    await writeFile(join(source, 'warm'), 'cached')
    const run = (relative, destination) => exec(process.execPath, ['-e', copyDependencyCacheScript, relative, destination], { cwd, env: { PATH: process.env.PATH }, timeout: 5000 })
    await run('prepared', target)
    assert.equal(await readFile(join(target, 'warm'), 'utf8'), 'cached')
    await writeFile(join(target, 'warm'), 'private-write')
    assert.equal(await readFile(join(source, 'warm'), 'utf8'), 'cached')
    await assert.rejects(run('../outside', join(cwd, 'escape')))
    await symlink(join(target, 'warm'), join(source, 'symbolic'))
    await assert.rejects(run('prepared', join(cwd, 'symbolic-copy')))
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
