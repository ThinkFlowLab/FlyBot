import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { cleanVersion, commitIn, commitOf, install, installedCommit, lockedCommit, newer, sourceOf } from '../src/host/update.js'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve() }
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

// The update module alone, on a stub plugin manager and a scripted fetch.
function start({ source, registries, answers = {}, result = { application: 'restart-required' }, config = {}, profileDir }) {
  const fetched = []
  const installs = []
  const warnings = []
  globalThis.fetch = async (url) => {
    fetched.push(url)
    const answer = answers[url]
    if (answer === undefined) return { ok: false, status: 404, json: async () => ({}) }
    if (answer instanceof Error) throw answer
    return { ok: true, status: 200, json: async () => answer }
  }
  const pluginManager = {
    listBundles: async () => [{ name: 'other', source: 'other@^1.0.0' }, ...(source === undefined ? [] : [{ name: PKG.name, source }])],
    registries: async () => registries ?? { registry: null, fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: 'https://registry.npmjs.org/' },
    installBundle: async (spec, options) => { installs.push([spec, options]); return typeof result === 'function' ? result() : result },
  }
  const rt = {
    ctx: { get: name => (name === 'pluginManager' ? pluginManager : name === 'profileContext' && profileDir ? { dir: profileDir } : undefined), effect() {} },
    config,
    warn: (...args) => warnings.push(args),
  }
  install(rt)
  return { rt, fetched, installs, warnings }
}

test('versions compare in semver order and lose their v and build metadata', () => {
  assert.equal(cleanVersion('v1.2.3+build.5'), '1.2.3')
  assert.equal(cleanVersion('latest'), null)
  assert.equal(newer('0.2.0', '0.1.9'), true)
  assert.equal(newer('0.10.0', '0.9.0'), true)
  assert.equal(newer('1.0.0', '1.0.0'), false)
  assert.equal(newer('1.0.0', '1.0.0-beta.2'), true)
  assert.equal(newer('1.0.0-beta.10', '1.0.0-beta.2'), true)
  assert.equal(newer('0.1.0', '0.2.0'), false)
})

test('the install source decides where a newer version is looked for', () => {
  assert.deepEqual(sourceOf('ds-bot@^0.1.0'), { kind: 'registry' })
  assert.deepEqual(sourceOf('@scope/ds-bot@latest'), { kind: 'registry' })
  // A profile's own dependency entry says the same without the package name.
  assert.deepEqual(sourceOf('^0.1.0'), { kind: 'registry' })
  assert.deepEqual(sourceOf('npm:ds-bot@^0.1.0'), { kind: 'registry' })
  assert.deepEqual(sourceOf('link:E:/项目库/My Bots/ds-bot'), { kind: 'path' })
  assert.deepEqual(sourceOf('/home/user/ds-bot'), { kind: 'path' })
  assert.deepEqual(sourceOf('github:Fei2411/DeepSeek-Bot#v0.1.0&path:/ds-bot'),
    { kind: 'git', owner: 'Fei2411', repo: 'DeepSeek-Bot', ref: 'v0.1.0', rest: ['path:/ds-bot'] })
  assert.deepEqual(sourceOf('git+https://github.com/Fei2411/DeepSeek-Bot.git#main'),
    { kind: 'git', owner: 'Fei2411', repo: 'DeepSeek-Bot', branch: 'main', rest: [] })
  // The README's install: a branch, and the core's folder.
  assert.deepEqual(sourceOf('github:ThinkFlowLab/FlyBot#main&path:/core'),
    { kind: 'git', owner: 'ThinkFlowLab', repo: 'FlyBot', branch: 'main', rest: ['path:/core'] })
  assert.deepEqual(sourceOf('https://example.com/ds-bot-0.1.0.tgz'), { kind: 'tarball' })
  assert.deepEqual(sourceOf(undefined), { kind: 'unknown' })
})

test('a 40-hex ref in the spec is a commit, not a branch or a tag (#379)', () => {
  const sha = '6d04db6682fa87033e58a176121f878b3ba293ce'
  assert.deepEqual(sourceOf(`github:ThinkFlowLab/FlyBot#${sha}&path:/core`),
    { kind: 'git', owner: 'ThinkFlowLab', repo: 'FlyBot', commit: sha, rest: ['path:/core'] })
  assert.equal(sourceOf(`github:ThinkFlowLab/FlyBot#${sha.toUpperCase()}`).commit, sha, 'lower-cased')
  assert.deepEqual(sourceOf(`git+https://github.com/ThinkFlowLab/FlyBot.git#${sha}`), { kind: 'git', owner: 'ThinkFlowLab', repo: 'FlyBot', commit: sha, rest: [] })
  // A short hash, or a hex run that is longer, cannot be told from a branch name: it stays one.
  assert.equal(sourceOf(`github:ThinkFlowLab/FlyBot#${sha.slice(0, 7)}`).branch, sha.slice(0, 7))
  assert.equal(sourceOf(`github:ThinkFlowLab/FlyBot#${sha}ab`).branch, `${sha}ab`)
  assert.equal(sourceOf('github:ThinkFlowLab/FlyBot#main&path:/core').commit, undefined)
})

test('a registry install finds the newest version on the next registry and installs it from there', async () => {
  const { rt, fetched, installs } = start({
    source: `${PKG.name}@^${PKG.version}`,
    answers: {
      [`https://registry.npmjs.org/${PKG.name}/latest`]: new Error('offline'),
      [`https://registry.npmmirror.com/${PKG.name}/latest`]: { version: '9.0.0' },
    },
    result: { application: 'restart-required', version: '9.0.0' },
  })
  const view = await rt.updateCheck()
  assert.deepEqual(fetched, [`https://registry.npmjs.org/${PKG.name}/latest`, `https://registry.npmmirror.com/${PKG.name}/latest`])
  assert.equal(view.available, true)
  assert.equal(view.latest, '9.0.0')
  assert.equal(view.current, PKG.version)
  assert.equal(view.source, 'registry')
  assert.equal(view.notesUrl, 'https://github.com/ThinkFlowLab/FlyBot/releases')
  assert.equal(rt.updateStart().phase, 'installing')
  await flush()
  assert.deepEqual(installs, [[`${PKG.name}@9.0.0`, { registry: 'https://registry.npmmirror.com/' }]])
  const done = await rt.updateCheck()
  assert.equal(done.phase, 'installed')
  assert.equal(done.installed, '9.0.0')
  assert.equal(done.available, false)
})

test('a private registry of pnpm\'s own is asked alone, and an answer stands for a while', async () => {
  const { rt, fetched } = start({
    source: `${PKG.name}@^${PKG.version}`,
    registries: { registry: null, fallbackRegistries: ['https://registry.npmmirror.com/'], resolved: 'https://npm.corp.example/' },
    answers: { [`https://npm.corp.example/${PKG.name}/latest`]: { version: PKG.version } },
  })
  const view = await rt.updateCheck()
  assert.equal(view.available, false)
  assert.deepEqual(fetched, [`https://npm.corp.example/${PKG.name}/latest`])
  await rt.updateCheck()
  assert.equal(fetched.length, 1)
  await rt.updateCheck({ fresh: true })
  assert.equal(fetched.length, 2)
})

test('a versioned GitHub install follows the latest release tag and keeps its path', async () => {
  const { rt, installs } = start({
    source: 'github:Fei2411/DeepSeek-Bot#v0.1.0&path:/ds-bot',
    answers: { 'https://api.github.com/repos/Fei2411/DeepSeek-Bot/releases/latest': { tag_name: 'v9.1.0' } },
  })
  const view = await rt.updateCheck()
  assert.equal(view.available, true)
  assert.equal(view.latest, '9.1.0')
  rt.updateStart()
  await flush()
  assert.deepEqual(installs, [['github:Fei2411/DeepSeek-Bot#v9.1.0&path:/ds-bot', {}]])
})

test('a versioned GitHub install follows the release to the repository\'s current address', async () => {
  const { rt, installs } = start({
    source: 'github:old-owner/DeepSeek-Bot#v0.1.0&path:/ds-bot',
    answers: {
      'https://api.github.com/repos/old-owner/DeepSeek-Bot/releases/latest': {
        tag_name: 'v9.1.0',
        html_url: 'https://github.com/Fei2411/DeepSeek-Bot/releases/tag/v9.1.0',
      },
    },
  })
  const view = await rt.updateCheck()
  assert.equal(view.available, true)
  assert.equal(view.latest, '9.1.0')
  rt.updateStart()
  await flush()
  assert.deepEqual(installs, [['github:Fei2411/DeepSeek-Bot#v9.1.0&path:/ds-bot', {}]])
})

test('a linked checkout, an unversioned git install, or a disabled check never asks the network', async () => {
  for (const source of [`link:/work/${PKG.name}`, 'github:Fei2411/DeepSeek-Bot#main', undefined]) {
    const { rt, fetched } = start({ source })
    const view = await rt.updateCheck()
    assert.equal(view.available, false)
    assert.deepEqual(fetched, [])
    assert.throws(() => rt.updateStart(), /No FlyBot core update/)
  }
  const { rt, fetched } = start({ source: `${PKG.name}@^${PKG.version}`, config: { updateCheck: false } })
  assert.equal((await rt.updateCheck({ fresh: true })).available, false)
  assert.deepEqual(fetched, [])
})

test('the star count comes from the repository, is kept for an hour, and survives a failed answer', async () => {
  const repo = 'https://api.github.com/repos/ThinkFlowLab/FlyBot'
  const answers = { [repo]: new Error('offline') }
  const { rt, fetched } = start({ source: `${PKG.name}@^${PKG.version}`, answers })
  assert.equal(rt.updateView().repoUrl, 'https://github.com/ThinkFlowLab/FlyBot')
  assert.equal(await rt.repoStars(), null)
  answers[repo] = { stargazers_count: 42 }
  assert.equal(await rt.repoStars(), 42)
  answers[repo] = new Error('offline')
  assert.equal(await rt.repoStars(), 42)
  assert.deepEqual(fetched, [repo, repo])
})

test('without a source from the plugin manager, the profile\'s own dependency entry decides', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PKG.name]: `^${PKG.version}` } }))
  const { rt } = start({
    profileDir: dir,
    answers: { [`https://registry.npmjs.org/${PKG.name}/latest`]: { version: '9.0.0' } },
  })
  const view = await rt.updateCheck()
  assert.equal(view.source, 'registry')
  assert.equal(view.available, true)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PKG.name]: 'link:/work/ds-bot' } }))
  assert.equal((await rt.updateCheck({ fresh: true })).source, 'path')
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

test('a check that finds nothing clears the version a check before it found', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-update-'))
  const setSource = source => writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { [PKG.name]: source } }))
  setSource(`^${PKG.version}`)
  const latest = `https://registry.npmjs.org/${PKG.name}/latest`
  const answers = { [latest]: { version: '9.0.0' } }
  const { rt } = start({ profileDir: dir, answers })
  const offered = await rt.updateCheck()
  assert.equal(offered.available, true)
  assert.equal(offered.latest, '9.0.0')
  // The profile now links a local checkout: the old registry offer must go.
  setSource('link:/work/ds-bot')
  const linked = await rt.updateCheck({ fresh: true })
  assert.equal(linked.available, false)
  assert.equal(linked.latest, null)
  assert.throws(() => rt.updateStart(), /No FlyBot core update/)
  // Back on the registry with no copy answering: the offer stays cleared.
  delete answers[latest]
  setSource(`^${PKG.version}`)
  const gone = await rt.updateCheck({ fresh: true })
  assert.equal(gone.available, false)
  assert.equal(gone.latest, null)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

test('a failed install reports why and can be tried again', async () => {
  let attempt = 0
  const { rt, installs } = start({
    source: `${PKG.name}@^${PKG.version}`,
    config: { updateRegistry: 'https://registry.example' },
    answers: { [`https://registry.example/${PKG.name}/latest`]: { version: '9.0.0' } },
    result: () => (++attempt === 1
      ? { application: 'failed', error: { code: 'incompatible-version', diagnostic: 'needs a newer DSH' } }
      : { application: 'restart-required', version: '9.0.0' }),
  })
  await rt.updateCheck()
  rt.updateStart()
  await flush()
  const failed = await rt.updateCheck()
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.error, 'needs a newer DSH')
  assert.equal(failed.available, true)
  rt.updateStart()
  await flush()
  assert.equal((await rt.updateCheck()).phase, 'installed')
  assert.equal(installs.length, 2)
  assert.deepEqual(installs[0][1], { registry: 'https://registry.example/' })
})

const SHA = '082563a1b2c3d4e5f60718293a4b5c6d7e8f9012'

test('the commit a git install runs is read from the package\'s real path, and a wrong one is never guessed', () => {
  const pnpm = `/home/u/.dsh/profiles/web/node_modules/.pnpm/ds-bot@github.com+ThinkFlowLab+FlyBot+${SHA}_react@19/node_modules/ds-bot/package.json`
  assert.equal(commitIn(pnpm, 'FlyBot'), SHA)
  assert.equal(commitIn(`/x/codeload.github.com+ThinkFlowLab+FlyBot+tar.gz+${SHA.toUpperCase()}/ds-bot`, 'FlyBot'), SHA, 'lower-cased')
  assert.equal(commitIn(`{commit: ${SHA}, repo: https://github.com/ThinkFlowLab/FlyBot.git, type: git}`, 'FlyBot'), SHA, 'commit before the name')
  // No commit, a shorter hash, a longer hex run, another repository's commit: nothing.
  assert.equal(commitIn('/home/u/work/FlyBot/core/package.json', 'FlyBot'), null)
  assert.equal(commitIn(`/x/FlyBot+${SHA.slice(0, 12)}/y`, 'FlyBot'), null)
  assert.equal(commitIn(`/x/FlyBot+${SHA}abcd/y`, 'FlyBot'), null)
  assert.equal(commitIn(`/x/Other+${SHA}/y`, 'FlyBot'), null)
  assert.equal(commitIn(undefined, 'FlyBot'), null)
  // Only a git install has one, and the running package's own path is the default (this checkout has none).
  assert.equal(installedCommit(sourceOf('github:ThinkFlowLab/FlyBot#main&path:/core'), pnpm), SHA)
  assert.equal(installedCommit(sourceOf('ds-bot@^0.1.0'), pnpm), null)
  assert.equal(installedCommit(sourceOf('github:ThinkFlowLab/FlyBot#main&path:/core')), null)
})

const LOCK_SHA = '6d04db6682fa87033e58a176121f878b3ba293ce'
// What pnpm 10 writes for `pnpm add "github:ThinkFlowLab/FlyBot#main&path:/core"` into a hoisted profile.
const LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      ds-bot:
        specifier: github:ThinkFlowLab/FlyBot#main&path:/core
        version: https://codeload.github.com/ThinkFlowLab/FlyBot/tar.gz/${LOCK_SHA}#path:/core

packages:

  ds-bot@https://codeload.github.com/ThinkFlowLab/FlyBot/tar.gz/${LOCK_SHA}#path:/core:
    resolution: {gitHosted: true, integrity: sha512-DHaU, tarball: https://codeload.github.com/ThinkFlowLab/FlyBot/tar.gz/${LOCK_SHA}}
    version: 0.1.5-flybot.1

snapshots:

  ds-bot@https://codeload.github.com/ThinkFlowLab/FlyBot/tar.gz/${LOCK_SHA}#path:/core: {}
`

test('the commit pnpm locked for ds-bot is read from the profile lockfile, and only for ds-bot (#379)', () => {
  assert.equal(lockedCommit(LOCK, 'ds-bot'), LOCK_SHA)
  // Quoted keys (a scoped name, or a key pnpm quotes) and the older leading slash.
  assert.equal(lockedCommit(`packages:\n  'ds-bot@https://codeload.github.com/ThinkFlowLab/FlyBot/tar.gz/${LOCK_SHA}#path:/core':\n    version: 1\n`, 'ds-bot'), LOCK_SHA)
  assert.equal(lockedCommit(`packages:\n  /ds-bot@https://codeload.github.com/ThinkFlowLab/FlyBot/tar.gz/${LOCK_SHA}:\n`, 'ds-bot'), LOCK_SHA)
  // The social plugin from the same repository, at another commit, does not answer for the core.
  const other = 'ffffffffffffffffffffffffffffffffffffffff'
  const both = `${LOCK}\n  '@flybot/social@https://codeload.github.com/ThinkFlowLab/FlyBot/tar.gz/${other}#path:/plugins/social':\n    version: 0.1.0\n`
  assert.equal(lockedCommit(both, 'ds-bot'), LOCK_SHA)
  assert.equal(lockedCommit(both, '@flybot/social'), other, 'each package has its own entry')
  // A package named ds-bot-extra is not ds-bot; a registry entry has no commit; two commits for ds-bot are none.
  assert.equal(lockedCommit(`packages:\n  ds-bot-extra@https://codeload.github.com/x/y/tar.gz/${LOCK_SHA}:\n`, 'ds-bot'), null)
  assert.equal(lockedCommit('packages:\n  ds-bot@0.1.5:\n    resolution: {integrity: sha512-x}\n', 'ds-bot'), null)
  assert.equal(lockedCommit(`${LOCK}\n  ds-bot@https://codeload.github.com/ThinkFlowLab/FlyBot/tar.gz/${other}#path:/core: {}\n`, 'ds-bot'), null)
  assert.equal(lockedCommit(LOCK.replaceAll(LOCK_SHA, LOCK_SHA.slice(0, 12)), 'ds-bot'), null, 'a short hash is not a commit')
  assert.equal(lockedCommit(undefined, 'ds-bot'), null)
  assert.equal(lockedCommit(LOCK, ''), null)
})

test('the commit comes from the spec first, then the lockfile, then the real path', () => {
  const branch = sourceOf('github:ThinkFlowLab/FlyBot#main&path:/core')
  const path = `/p/node_modules/.pnpm/ds-bot@github.com+ThinkFlowLab+FlyBot+${SHA}/node_modules/ds-bot/package.json`
  assert.equal(commitOf(branch, { lockText: LOCK, where: path }), LOCK_SHA, 'the lockfile outranks the path')
  assert.equal(commitOf(branch, { lockText: null, where: path }), SHA, 'no lockfile: the path')
  assert.equal(commitOf(branch, { lockText: 'lockfileVersion: 9', where: '/p/node_modules/ds-bot/package.json' }), null)
  assert.equal(commitOf(sourceOf(`github:ThinkFlowLab/FlyBot#${SHA}`), { lockText: LOCK, where: path }), SHA, 'the pinned hash outranks both')
  assert.equal(commitOf(sourceOf('link:/work/core'), { lockText: LOCK }), null)
  assert.equal(commitOf(sourceOf(`ds-bot@^0.1.0`), { lockText: LOCK }), null)
})

test('a hoisted git install shows the commit from the profile lockfile and compares it with its branch (#379)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsb-lock-'))
  writeFileSync(join(dir, 'pnpm-lock.yaml'), LOCK)
  const compare = `https://api.github.com/repos/ThinkFlowLab/FlyBot/compare/${LOCK_SHA}...main`
  const run = start({
    source: 'github:ThinkFlowLab/FlyBot#main&path:/core', profileDir: dir,
    config: { packagePath: '/p/node_modules/ds-bot/package.json' },
    answers: { [compare]: { status: 'ahead', ahead_by: 2 } },
  })
  const view = await run.rt.updateCheck()
  assert.deepEqual(view.build, { branch: 'main', commit: '6d04db6' })
  assert.equal(view.behind, 2)
  assert.deepEqual(run.fetched, [compare])
  // No lockfile in the profile: the branch alone, nothing compared.
  const empty = mkdtempSync(join(tmpdir(), 'dsb-nolock-'))
  const bare = start({ source: 'github:ThinkFlowLab/FlyBot#main&path:/core', profileDir: empty, config: { packagePath: '/p/node_modules/ds-bot/package.json' } })
  assert.deepEqual((await bare.rt.updateCheck()).build, { branch: 'main' })
  assert.deepEqual(bare.fetched, [])
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  rmSync(empty, { recursive: true, force: true, maxRetries: 5 })
})

test('an install pinned to a commit shows the commit, is no branch, and asks GitHub for nothing (#379)', async () => {
  const run = start({ source: `github:ThinkFlowLab/FlyBot#${LOCK_SHA}&path:/core` })
  const view = await run.rt.updateCheck()
  assert.deepEqual(view.build, { commit: '6d04db6', pinned: true })
  assert.equal(view.behind, null)
  assert.equal(view.available, false)
  assert.deepEqual(run.fetched, [])
  assert.throws(() => run.rt.updateStart(), /No FlyBot core update/)
})

test('a git install on a branch reports its branch and commit, and how many commits the branch is ahead', async () => {
  const spec = 'github:ThinkFlowLab/FlyBot#main&path:/core'
  const path = `/p/node_modules/.pnpm/ds-bot@github.com+ThinkFlowLab+FlyBot+${SHA}/node_modules/ds-bot/package.json`
  const compare = `https://api.github.com/repos/ThinkFlowLab/FlyBot/compare/${SHA}...main`
  const { rt, fetched, installs } = start({ source: spec, config: { packagePath: path }, answers: { [compare]: { status: 'ahead', ahead_by: 4 } } })
  assert.deepEqual([rt.updateView().build, rt.updateView().behind], [null, null], 'nothing before a check')
  const view = await rt.updateCheck()
  assert.deepEqual(view.build, { branch: 'main', commit: '082563a' })
  assert.equal(view.behind, 4)
  assert.equal(view.available, false, 'a branch install is never offered an install')
  assert.deepEqual(fetched, [compare])
  assert.throws(() => rt.updateStart(), /No FlyBot core update/)
  assert.deepEqual(installs, [])

  // Up to date, a branch that moved away from the commit (diverged, or reset to before it), no status, and an
  // unreachable API: never a made-up number.
  for (const [answer, behind] of [[{ status: 'identical', ahead_by: 0 }, 0], [{ status: 'diverged', ahead_by: 3 }, null], [{ status: 'behind', ahead_by: 0, behind_by: 2 }, null], [{ ahead_by: 2 }, null], [new Error('offline'), null], [{}, null]]) {
    const run = start({ source: spec, config: { packagePath: path }, answers: { [compare]: answer } })
    assert.equal((await run.rt.updateCheck()).behind, behind)
  }
})

test('without a commit in the path a branch install still names its branch and compares nothing; other sources have no build', async () => {
  const noCommit = start({ source: 'github:ThinkFlowLab/FlyBot#main&path:/core' })
  const view = await noCommit.rt.updateCheck()
  assert.deepEqual(view.build, { branch: 'main' })
  assert.equal(view.behind, null)
  assert.deepEqual(noCommit.fetched, [])
  for (const source of [`${PKG.name}@^${PKG.version}`, 'link:/work/core']) {
    const run = start({ source, answers: { [`https://registry.npmjs.org/${PKG.name}/latest`]: { version: PKG.version } } })
    assert.equal((await run.rt.updateCheck()).build, null)
  }
})

test('the package names FlyBot\'s own repository, not the upstream DS Bot', () => {
  assert.equal(PKG.repository.url, 'git+https://github.com/ThinkFlowLab/FlyBot.git')
  assert.equal(PKG.repository.directory, 'core')
  assert.equal(PKG.homepage, 'https://github.com/ThinkFlowLab/FlyBot#readme')
  assert.equal(PKG.bugs.url, 'https://github.com/ThinkFlowLab/FlyBot/issues')
})
