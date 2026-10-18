import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  nodeMeetsFloor,
  checkPluginPackage,
  buildInstallCommands,
  runDoctor,
  defaultRoot,
} from '../scripts/install-doctor.mjs'

function makePluginFixture(manifest, { patchFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-doctor-'))
  mkdirSync(join(dir, 'patch'), { recursive: true })
  if (patchFile !== undefined) writeFileSync(join(dir, 'patch', 'cordis.patch.yml'), patchFile)
  writeFileSync(join(dir, 'package.json'), manifest)
  return dir
}

test('nodeMeetsFloor: below the floor fails, the floor and newer majors pass', () => {
  assert.equal(nodeMeetsFloor('v22.18.0'), false)
  assert.equal(nodeMeetsFloor('v22.19.0'), true)
  assert.equal(nodeMeetsFloor('v24.0.0'), true)
})

test('checkPluginPackage: a missing package.json fails without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-doctor-'))
  try {
    const result = checkPluginPackage(dir, 'ds-bot')
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => error.includes('no package.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPluginPackage: a wrong package name fails', () => {
  const dir = makePluginFixture(
    JSON.stringify({ name: 'other', dsh: { bundle: { patch: './patch/cordis.patch.yml' } } }),
    { patchFile: 'patch: {}\n' },
  )
  try {
    const result = checkPluginPackage(dir, 'ds-bot')
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => error.includes('other')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPluginPackage: a declared but missing cordis patch fails', () => {
  const dir = makePluginFixture(JSON.stringify({ name: 'ds-bot', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  try {
    const result = checkPluginPackage(dir, 'ds-bot')
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => error.includes('dsh.bundle.patch')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPluginPackage: a valid fixture passes', () => {
  const dir = makePluginFixture(
    JSON.stringify({ name: 'ds-bot', dsh: { bundle: { patch: './patch/cordis.patch.yml' } } }),
    { patchFile: 'patch: {}\n' },
  )
  try {
    const result = checkPluginPackage(dir, 'ds-bot')
    assert.deepEqual(result, { ok: true, errors: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPluginPackage: a JSON null body fails without throwing', () => {
  const dir = makePluginFixture('null')
  try {
    const result = checkPluginPackage(dir, 'ds-bot')
    assert.equal(result.ok, false)
    assert.doesNotThrow(() => checkPluginPackage(dir, 'ds-bot'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checkPluginPackage: a numeric dsh.bundle.patch fails without throwing', () => {
  const dir = makePluginFixture(JSON.stringify({ name: 'ds-bot', dsh: { bundle: { patch: 42 } } }))
  try {
    const result = checkPluginPackage(dir, 'ds-bot')
    assert.equal(result.ok, false)
    assert.ok(result.errors.some(error => error.includes('dsh.bundle.patch')))
    assert.doesNotThrow(() => checkPluginPackage(dir, 'ds-bot'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildInstallCommands: three install commands for the core, social and tree; timeline only on request (#281)', () => {
  const commands = buildInstallCommands()
  assert.equal(commands.length, 3)
  assert.ok(commands.every(command => command.includes('0.2.0-rc.2')))
  assert.ok(commands[0].includes('path:/core'))
  assert.ok(commands[1].includes('path:/plugins/social'))
  assert.ok(commands[2].includes('path:/plugins/tree'))
  assert.equal(commands.some(command => command.includes('timeline')), false)
  const all = buildInstallCommands({ timeline: true })
  assert.equal(all.length, 4)
  assert.ok(all[3].includes('path:/plugins/timeline'))
})

test('runDoctor: the real repository passes on a Node version at the floor', () => {
  const report = runDoctor({ root: defaultRoot(), nodeVersion: 'v22.19.0' })
  assert.equal(report.ok, true)
  assert.equal(report.checks.every(check => check.ok), true)
})

test('runDoctor: the real repository fails on Node v20', () => {
  const report = runDoctor({ root: defaultRoot(), nodeVersion: 'v20.19.2' })
  assert.equal(report.ok, false)
  assert.ok(report.checks.some(check => !check.ok && check.label.includes('Node')))
})

test('runDoctor: an empty root fails the plugin checks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-doctor-'))
  try {
    const report = runDoctor({ root: dir, nodeVersion: 'v22.19.0' })
    assert.equal(report.ok, false)
    const pluginChecks = report.checks.filter(check => check.label.includes('plugin package'))
    assert.equal(pluginChecks.length, 4)
    assert.ok(pluginChecks.every(check => !check.ok))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
