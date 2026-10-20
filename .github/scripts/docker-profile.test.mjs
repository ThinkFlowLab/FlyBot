// docker/: the container's web profile (#352) and the files the image and compose rely on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imagePackages, linkPackages, prepareProfile } from '../../docker/profile.mjs'

const root = new URL('../../', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

function packagesDir() {
  const dir = mkdtempSync(join(tmpdir(), 'flybot-pkgs-'))
  for (const [folder, name] of [['ds-bot-0.2.1', 'ds-bot'], ['flybot-tree-0.1.0', '@flybot/tree'], ['flybot-social-0.1.0', '@flybot/social']]) {
    mkdirSync(join(dir, folder))
    writeFileSync(join(dir, folder, 'package.json'), JSON.stringify({ name }))
  }
  mkdirSync(join(dir, 'not-a-package'))
  return dir
}

test('imagePackages lists the unpacked packages by name', () => {
  const dir = packagesDir()
  try {
    assert.deepEqual(imagePackages(dir).map((p) => p.name), ['@flybot/social', '@flybot/tree', 'ds-bot'])
    assert.equal(imagePackages(dir).find((p) => p.name === 'ds-bot').dir, join(dir, 'ds-bot-0.2.1'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a new profile gets the web bundles plus every image package, linked', () => {
  const next = linkPackages(undefined, [{ name: 'ds-bot', dir: '/opt/p/core' }, { name: '@flybot/tree', dir: '/opt/p/tree' }])
  assert.deepEqual(next.dependencies, { 'ds-bot': 'link:/opt/p/core', '@flybot/tree': 'link:/opt/p/tree' })
  assert.deepEqual(next.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'ds-bot', '@flybot/tree'])
})

test('an existing profile keeps your own plugins and bundle order; old FlyBot entries are relinked', () => {
  const current = {
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'ds-bot': 'file:/old/ds-bot-0.2.0.tgz', 'my-plugin': '^1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'my-plugin', 'ds-bot'] }, other: true },
  }
  const before = structuredClone(current)
  const next = linkPackages(current, [{ name: 'ds-bot', dir: '/opt/p/core' }, { name: '@flybot/social', dir: '/opt/p/social' }])
  assert.deepEqual(current, before, 'the input is not changed')
  assert.deepEqual(next.dependencies, { 'ds-bot': 'link:/opt/p/core', 'my-plugin': '^1.0.0', '@flybot/social': 'link:/opt/p/social' })
  assert.deepEqual(next.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'my-plugin', 'ds-bot', '@flybot/social'])
  assert.equal(next.dsh.other, true)
})

test('prepareProfile writes package.json and pnpm-workspace.yaml and keeps your settings', () => {
  const pkgs = packagesDir()
  const home = mkdtempSync(join(tmpdir(), 'flybot-home-'))
  try {
    const profile = join(home, 'profiles', 'web')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: flybot-social\n')
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n# mine\n')
    assert.equal(prepareProfile(home, pkgs), profile)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    assert.equal(manifest.dependencies['ds-bot'], `link:${join(pkgs, 'ds-bot-0.2.1')}`)
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), '- id: flybot-social\n')
    assert.equal(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), 'packages:\n  - .\n# mine\n')
    prepareProfile(home, pkgs)
    assert.deepEqual(JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')), manifest, 'a second start changes nothing')
    rmSync(join(profile, 'pnpm-workspace.yaml'))
    prepareProfile(home, pkgs)
    assert.match(readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8'), /nodeLinker: hoisted\nautoInstallPeers: false/)
  } finally {
    rmSync(pkgs, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('secure defaults: loopback port, non-root user, no secret in the image, no registry push', () => {
  const compose = read('compose.yaml')
  assert.match(compose, /^ {6}- "127\.0\.0\.1:\$\{FLYBOT_PORT:-3080\}:3080"$/m, 'the port is published on the host loopback only')
  assert.match(compose, /^ {6}- data:\/data$/m, 'one data volume')
  assert.match(compose, /^ {6}- DEEPSEEK_API_KEY$/m, 'the key is passed through, never written into the file')
  const dockerfile = read('Dockerfile')
  assert.match(dockerfile, /^USER node$/m)
  assert.match(dockerfile, /^VOLUME \["\/data"\]$/m)
  assert.match(dockerfile, /^HEALTHCHECK /m)
  assert.doesNotMatch(dockerfile, /^(ENV|ARG)\s.*(KEY|TOKEN|SECRET)/im, 'no key in the image')
  const pinned = JSON.parse(read('core/dev/harness/package.json')).dependencies['@deepseek-ai/dsh']
  assert.match(dockerfile, new RegExp(`^ARG DSH_VERSION=${pinned.replace(/\./g, '\\.')}$`, 'm'), 'DSH is pinned like the tests and the README')
  const ignore = read('.dockerignore')
  for (const entry of ['**/.env', '**/.credentials.yaml', '**/.dsh*', '.git']) assert.ok(ignore.split('\n').includes(entry), `.dockerignore lists ${entry}`)
  const workflow = read('.github/workflows/docker.yml')
  assert.doesNotMatch(workflow, /docker (push|login)|docker\/(login|build-push)-action|packages: write/, 'CI builds and checks only')
  assert.match(read('docker/web.patch.yml'), /^ {4}host: 0\.0\.0\.0$/m)
})
