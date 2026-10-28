import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The DSH version is pinned in several places that cannot read each other: the harness install the
// tests and the linter use, the CI workflows, the install help and the README commands. A bump that
// moves one and leaves another shows up as a stale `npx` command or a workflow installing a version
// nobody tested (#1384), so every copy is compared with the harness pin here.
const root = new URL('../../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')

// The version this repository pins. Bumping the DSH pin means editing this line together with the
// files below; the job name in test.yml is a merge-queue required check and does not move with it.
const DSH = '0.2.1-rc.2'
const PREVIOUS = '0.2.0-rc.2'

test('the harness pin is the version every other copy must equal', () => {
  const harness = JSON.parse(read('core/dev/harness/package.json'))
  assert.equal(harness.dependencies['@deepseek-ai/dsh'], DSH)
})

test('the CI workflows install the pinned DSH, and the PR gate keeps its required job name', () => {
  const test_yml = read('.github/workflows/test.yml')
  assert.match(test_yml, new RegExp(`\\bdsh: ${DSH.replaceAll('.', '\\.')}$`, 'm'), 'test.yml dsh: input')
  assert.match(test_yml, new RegExp(`\\bDSH: ${DSH.replaceAll('.', '\\.')}$`, 'm'), 'test.yml DSH: env')
  // The job name is a required check on the main merge queue (#31): it keeps the old version until
  // the owner changes the ruleset, so a pin bump must not rename it.
  assert.match(test_yml, new RegExp(`^    name: ubuntu-latest · Node 24 · DSH ${PREVIOUS.replaceAll('.', '\\.')}$`, 'm'))
  assert.ok(!test_yml.includes(`DSH ${DSH}`), 'the job name moved with the pin; the merge queue would wait forever')

  const nightly = read('.github/workflows/nightly.yml')
  assert.ok(!nightly.includes(PREVIOUS), 'nightly.yml still names the previous DSH')
  assert.equal(nightly.match(new RegExp(`dsh: ${DSH.replaceAll('.', '\\.')}`, 'g'))?.length, 2, 'nightly matrix entries')
})

test('the install help and the local CI install the pinned DSH', () => {
  const doctor = read('core/scripts/install-doctor.mjs')
  assert.ok(doctor.includes(`@deepseek-ai/dsh@${DSH}`), 'install-doctor.mjs default package')
  assert.ok(!doctor.includes(PREVIOUS), 'install-doctor.mjs still names the previous DSH')

  const localCi = read('core/scripts/local-ci.sh')
  assert.ok(localCi.includes(`npm run harness -- --no-save @deepseek-ai/dsh@${DSH}`), 'local-ci.sh harness install')
  assert.ok(localCi.includes(`step="Install DSH ${DSH}"`), 'local-ci.sh step label')
  assert.ok(!localCi.includes(PREVIOUS), 'local-ci.sh still names the previous DSH')
})

test('every npx command in the READMEs runs the pinned DSH', () => {
  for (const file of ['README.md', 'README.zh.md']) {
    const text = read(file)
    const pins = [...text.matchAll(/@deepseek-ai\/dsh@([0-9][^\s"]*)/g)].map(match => match[1])
    assert.ok(pins.length >= 4, `${file}: expected the four npx commands`)
    assert.deepEqual([...new Set(pins)], [DSH], `${file}: npx commands and the tested-with line`)
    assert.ok(text.includes(DSH), `${file}: names the tested DSH version`)
  }
})

test('the docs that tell people which DSH to run name the pinned version', () => {
  for (const file of ['docs/deepseek-api-key.md', 'docs/known-issues.md', 'docs/known-issues.zh.md', 'docs/docker.md', 'docs/docker.zh.md']) {
    const text = read(file)
    assert.ok(text.includes(DSH), `${file}: names the pinned DSH`)
    assert.ok(!text.includes(PREVIOUS), `${file}: still names the previous DSH`)
  }
})
