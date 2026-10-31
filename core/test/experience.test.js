import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkExperience, DEFAULT_EXPERIENCE_ROOT, lookupExperience, prepareExperienceEntry } from '../src/host/experience.js'
import { defaultHarness, harnessExperience, harnessPro, install, resolveHarness } from '../src/host/harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '../dev/experience/check.mjs')

function entry(fields) {
  return {
    techStacks: [],
    seen: 1,
    refs: ['#1'],
    ...fields,
  }
}

function writeTree(root, files) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  writeFileSync(join(root, 'check.mjs'), '// fixture\n')
  for (const [rel, body] of Object.entries(files)) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`)
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flybot-experience-'))
  writeTree(root, {
    'repos/Alpha/One/keep.json': entry({
      id: 'keep',
      repo: 'Alpha/One',
      techStacks: ['node-host'],
      date: '2026-10-02',
      trigger: 'keep the local lesson',
      wrong: 'copy it into every repo',
      right: 'leave it on Alpha/One',
    }),
    'repos/Alpha/One/plain.json': entry({
      id: 'plain',
      repo: 'Alpha/One',
      date: '2026-10-01',
      trigger: 'plain repo lesson',
      wrong: 'tag it as shared',
      right: 'keep the stack list empty',
    }),
    'repos/Beta/Two/leak.json': entry({
      id: 'leak',
      repo: 'Beta/Two',
      techStacks: ['node-host'],
      date: '2026-10-03',
      trigger: 'leak across repos',
      wrong: 'return it for Alpha',
      right: 'read only the asked repo',
    }),
    'stacks/node-host/shared.json': entry({
      id: 'shared',
      repo: null,
      techStacks: ['node-host'],
      date: '2026-10-04',
      trigger: 'shared stack lesson',
      wrong: 'attach it to one repo',
      right: 'store it under stacks with repo null',
    }),
    'stacks/github-actions/actions.json': entry({
      id: 'actions',
      repo: null,
      techStacks: ['github-actions'],
      date: '2026-10-05',
      trigger: 'actions only',
      wrong: 'show it for node-host',
      right: 'read only the asked stack',
    }),
  })
  return root
}

test('lookup reads only the asked repo and never another repo directory', () => {
  const root = fixture()
  try {
    const repoOnly = lookupExperience({ repo: 'Alpha/One', root })
    assert.deepEqual(repoOnly.entries.map(item => item.id), ['keep', 'plain'])
    assert.equal(repoOnly.entries.some(item => item.repo === 'Beta/Two'), false)
    assert.equal(repoOnly.entries.some(item => item.id === 'shared'), false)

    const stackOnly = lookupExperience({ techStack: 'node-host', root })
    assert.deepEqual(stackOnly.entries.map(item => item.id), ['shared'])
    assert.equal(stackOnly.entries[0].repo, null)

    const both = lookupExperience({ repo: 'Alpha/One', techStack: 'node-host', root })
    assert.deepEqual(both.entries.map(item => item.id), ['shared', 'keep'])

    const other = lookupExperience({ repo: 'Beta/Two', techStack: 'node-host', root })
    assert.deepEqual(other.entries.map(item => item.id), ['shared', 'leak'])
    assert.equal(other.entries.some(item => item.repo === 'Alpha/One'), false)

    assert.deepEqual(lookupExperience({ root }).entries, [])
    assert.deepEqual(lookupExperience({ repo: 'Alpha/One', query: 'leak', root }).entries, [])
    assert.deepEqual(lookupExperience({ techStack: 'node-host', query: 'leak', root }).entries, [])
    assert.deepEqual(lookupExperience({ repo: 'Beta/Two', query: 'LEAK', root }).entries.map(item => item.id), ['leak'])
    assert.deepEqual(lookupExperience({ techStack: 'github-actions', root }).entries.map(item => item.id), ['actions'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a corrupt entry outside the asked scope is not read', () => {
  const root = fixture()
  try {
    writeFileSync(join(root, 'repos/Beta/Two/leak.json'), '{ not json\n')
    writeFileSync(join(root, 'stacks/github-actions/actions.json'), '{ not json\n')
    const found = lookupExperience({ repo: 'Alpha/One', techStack: 'node-host', root })
    assert.deepEqual(found.entries.map(item => item.id), ['shared', 'keep'])
    assert.throws(() => lookupExperience({ repo: 'Beta/Two', root }), /leak\.json/)
    assert.throws(() => lookupExperience({ techStack: 'github-actions', root }), /actions\.json/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lookup rejects a scope that would leave the root', () => {
  const root = fixture()
  try {
    assert.throws(() => lookupExperience({ repo: '../Beta/Two', root }), /bad repo/)
    assert.throws(() => lookupExperience({ techStack: '../repos', root }), /bad techStack/)
    assert.throws(() => lookupExperience({ repo: 'Alpha/One', root: join(root, 'missing') }), /root missing/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check fails closed when a file disagrees with its directory', () => {
  const root = fixture()
  try {
    assert.equal(checkExperience(root).ok, true)
    const leak = join(root, 'repos/Beta/Two/leak.json')
    const body = JSON.parse(readFileSync(leak, 'utf8'))
    body.repo = 'Alpha/One'
    writeFileSync(leak, `${JSON.stringify(body, null, 2)}\n`)
    const mismatched = checkExperience(root)
    assert.equal(mismatched.ok, false)
    assert.ok(mismatched.failures.some(line => line.includes('leak.json')))
    assert.throws(() => lookupExperience({ repo: 'Beta/Two', root }), /repo/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a shared stack file that names a repo fails the check', () => {
  const root = fixture()
  try {
    const shared = join(root, 'stacks/node-host/shared.json')
    const body = JSON.parse(readFileSync(shared, 'utf8'))
    body.repo = 'Beta/Two'
    writeFileSync(shared, `${JSON.stringify(body, null, 2)}\n`)
    const report = checkExperience(root)
    assert.equal(report.ok, false)
    assert.ok(report.failures.some(line => line.includes('shared.json')))
    assert.throws(() => lookupExperience({ techStack: 'node-host', root }), /repo/)
    assert.deepEqual(lookupExperience({ repo: 'Alpha/One', root }).entries.map(item => item.id), ['keep', 'plain'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the committed library isolates ThinkFlowLab/FlyBot from the shared node-host stack', () => {
  const report = checkExperience(DEFAULT_EXPERIENCE_ROOT)
  assert.equal(report.ok, true, report.failures.join('; '))
  const flybot = lookupExperience({ repo: 'ThinkFlowLab/FlyBot' })
  assert.deepEqual(flybot.entries.map(item => item.id), ['one-conclusion', 'stale-base'])
  assert.equal(flybot.entries.every(item => item.repo === 'ThinkFlowLab/FlyBot'), true)
  const stack = lookupExperience({ techStack: 'node-host' })
  assert.deepEqual(stack.entries.map(item => item.id), ['generated-gates'])
  assert.equal(stack.entries[0].repo, null)
  const other = lookupExperience({ repo: 'Acme/Other', techStack: 'node-host' })
  assert.deepEqual(other.entries.map(item => item.id), ['generated-gates'])
  assert.deepEqual(lookupExperience({}).entries, [])
  assert.deepEqual(lookupExperience({ repo: 'ThinkFlowLab/FlyBot', query: 'verdict' }).entries.map(item => item.id), ['one-conclusion'])
})

test('harnessExperience is a read hook and leaves tiers unchanged', () => {
  const harness = defaultHarness()
  assert.deepEqual(Object.keys(harness), ['id', 'prompt', 'tools', 'model', 'stepRetry', 'verifiers', 'exceptions'])
  for (const id of ['lite', 'medium', 'heavy']) {
    const tier = resolveHarness(id)
    assert.equal(tier.applied, false, id)
    assert.equal(harnessPro(tier).ok, true, id)
  }
  const rt = {}
  install(rt)
  assert.equal(rt.harness.id, 'default')
  assert.equal(rt.harnessExperience, harnessExperience)
  assert.deepEqual(rt.harnessExperience({}).entries, [])
  assert.deepEqual(rt.harnessExperience({ repo: 'ThinkFlowLab/FlyBot' }).entries.map(item => item.id), ['one-conclusion', 'stale-base'])
})

test('the CLI writes one new entry file and refuses to overwrite it', () => {
  const root = mkdtempSync(join(tmpdir(), 'flybot-experience-cli-'))
  try {
    writeFileSync(join(root, 'README.md'), '# fixture\n')
    writeFileSync(join(root, 'check.mjs'), '// fixture\n')
    const planned = prepareExperienceEntry({
      id: 'from-cli',
      repo: 'Alpha/One',
      techStacks: [],
      date: '2026-10-24',
      trigger: 'a file change',
      wrong: 'edit the harness while the task runs',
      right: 'commit the json file',
    })
    assert.equal(planned.relativePath, join('repos', 'Alpha', 'One', 'from-cli.json'))
    const added = spawnSync(process.execPath, [
      cli, '--root', root, 'add',
      '--repo', 'Alpha/One',
      '--id', 'from-cli',
      '--date', '2026-10-24',
      '--trigger', 'a file change',
      '--wrong', 'edit the harness while the task runs',
      '--right', 'commit the json file',
    ], { encoding: 'utf8' })
    assert.equal(added.status, 0, added.stderr)
    assert.deepEqual(lookupExperience({ repo: 'Alpha/One', root }).entries.map(item => item.id), ['from-cli'])
    assert.equal(checkExperience(root).ok, true)
    const shared = spawnSync(process.execPath, [
      cli, '--root', root, 'add',
      '--tech-stack', 'node-host',
      '--id', 'from-stack',
      '--date', '2026-10-24',
      '--trigger', 'a shared file',
      '--wrong', 'copy it into every repo',
      '--right', 'store it under stacks with repo null',
    ], { encoding: 'utf8' })
    assert.equal(shared.status, 0, shared.stderr)
    assert.deepEqual(lookupExperience({ techStack: 'node-host', root }).entries.map(item => item.id), ['from-stack'])
    assert.equal(lookupExperience({ repo: 'Alpha/One', root }).entries.some(item => item.id === 'from-stack'), false)
    const again = spawnSync(process.execPath, [
      cli, '--root', root, 'add',
      '--repo', 'Alpha/One',
      '--id', 'from-cli',
      '--date', '2026-10-24',
      '--trigger', 'a file change',
      '--wrong', 'edit the harness while the task runs',
      '--right', 'commit the json file',
    ], { encoding: 'utf8' })
    assert.equal(again.status, 1)
    const checked = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' })
    assert.equal(checked.status, 0, checked.stderr)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the experience text bound counts code points, not UTF-16 units', () => {
  const emoji = '\u{1F600}'
  const base = { id: 'bound', repo: 'Alpha/One', techStacks: [], date: '2026-10-31', trigger: 'a', wrong: 'b', right: 'c' }
  for (const key of ['trigger', 'wrong', 'right']) {
    for (const text of ['x'.repeat(599), 'x'.repeat(600), emoji.repeat(599), emoji.repeat(600), `${emoji.repeat(599)}x`]) {
      assert.doesNotThrow(() => prepareExperienceEntry({ ...base, [key]: text }), `${key}: ${text.length} units is within 600 characters`)
    }
    for (const text of ['x'.repeat(601), emoji.repeat(601), `${emoji.repeat(600)}x`]) {
      assert.throws(() => prepareExperienceEntry({ ...base, [key]: text }), new RegExp(`^Error: ${key}$`), `${key}: over 600 characters is refused`)
    }
  }
})
