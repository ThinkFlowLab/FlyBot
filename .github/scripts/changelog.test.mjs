import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assemble, linkProblems, release, readFragments } from './changelog.mjs'

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

### Changed

- Old hand-written entry.

## [0.1.0] - 2026-10-14

### Added

- First.

[Unreleased]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ThinkFlowLab/FlyBot/releases/tag/v0.1.0
`

// The shape CHANGELOG.md has after a repair: [Unreleased] first, then the newest release, and the two
// are the only definitions this fixture needs for release() to keep them in step.
const LINKED = `# Changelog

Intro.

## [Unreleased]

## [0.2.22] - 2026-11-04

### Added

- Last release.

[Unreleased]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.2.0...HEAD
[0.2.22]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.2.21...v0.2.22
`

const tmp = () => mkdtempSync(join(tmpdir(), 'changelog-'))
const fragments = dir => { mkdirSync(dir, { recursive: true }); return (name, text) => writeFileSync(join(dir, name), text) }

test('readFragments: sorted, kind from the name, README ignored', () => {
  const dir = tmp()
  const put = fragments(dir)
  put('b-second.fixed.md', 'Second.\n')
  put('a-first.added.md', 'First.\n')
  put('README.md', 'ignored')
  assert.deepEqual(readFragments(dir).map(f => [f.file, f.kind, f.text]), [['a-first.added.md', 'added', 'First.'], ['b-second.fixed.md', 'fixed', 'Second.']])
  assert.deepEqual(readFragments(join(dir, 'missing')), [])
  rmSync(dir, { recursive: true })
})

test('readFragments: every malformed file is reported', () => {
  const dir = tmp()
  const put = fragments(dir)
  put('no-kind.md', 'x')
  put('Upper.added.md', 'x')
  put('empty.added.md', '\n')
  put('bullet.added.md', '- already a bullet')
  put('two.added.md', 'one\n\ntwo')
  put('unknown.misc.md', 'x')
  assert.throws(() => readFragments(dir), (error) => ['no-kind.md', 'Upper.added.md', 'empty.added.md', 'bullet.added.md', 'two.added.md', 'unknown.misc.md'].every(n => error.message.includes(n)))
  rmSync(dir, { recursive: true })
})

test('assemble: Keep a Changelog order, one bullet per fragment, continuation lines indented', () => {
  const text = assemble([
    { file: 'a.fixed.md', kind: 'fixed', text: 'Fix A.' },
    { file: 'b.added.md', kind: 'added', text: 'Add B\nsecond line.' },
    { file: 'c.fixed.md', kind: 'fixed', text: 'Fix C.' },
  ])
  assert.equal(text, '### Added\n\n- Add B\n  second line.\n\n### Fixed\n\n- Fix A.\n- Fix C.')
})

test('release: Unreleased is emptied; old entries come first, fragments merge per kind', () => {
  const out = release(CHANGELOG, [{ kind: 'changed', text: 'New change.' }, { kind: 'fixed', text: 'New fix.' }], '0.1.1', '2026-10-20')
  assert.match(out, /## \[Unreleased\]\n\n## \[0\.1\.1\] - 2026-10-20\n\n### Changed\n\n- Old hand-written entry\.\n- New change\.\n\n### Fixed\n\n- New fix\.\n\n## \[0\.1\.0\]/)
  assert.ok(out.startsWith('# Changelog\n\nIntro.\n\n## [Unreleased]\n'))
  assert.match(out, /\[Unreleased\]: [^\n]*compare\/v0\.1\.1\.\.\.HEAD\n\[0\.1\.1\]: [^\n]*compare\/v0\.1\.0\.\.\.v0\.1\.1\n\[0\.1\.0\]: [^\n]*releases\/tag\/v0\.1\.0\n$/)
})

test('release: writes the version link definition and moves [Unreleased] off the stale tag', () => {
  const out = release(LINKED, [{ kind: 'added', text: 'Next.' }], '0.3.0', '2026-11-05')
  assert.match(out, /## \[Unreleased\]\n\n## \[0\.3\.0\] - 2026-11-05\n\n### Added\n\n- Next\.\n\n## \[0\.2\.22\]/)
  assert.match(out, /^\[0\.3\.0\]: https:\/\/github\.com\/ThinkFlowLab\/FlyBot\/compare\/v0\.2\.22\.\.\.v0\.3\.0$/m)
  assert.match(out, /^\[Unreleased\]: https:\/\/github\.com\/ThinkFlowLab\/FlyBot\/compare\/v0\.3\.0\.\.\.HEAD$/m)
  assert.match(out, /^\[Unreleased\]: [^\n]*\n\[0\.3\.0\]: [^\n]*\n\[0\.2\.22\]: /m)
})

test('CLI: check refuses a missing definition and a stale [Unreleased]', () => {
  const root = tmp()
  const file = join(root, 'CHANGELOG.md')
  const run = (...args) => execFileSync(process.execPath, [new URL('./changelog.mjs', import.meta.url).pathname, ...args], { env: { ...process.env, CHANGELOG_ROOT: root }, encoding: 'utf8' })
  writeFileSync(file, `# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-04\n\n- First.\n\n[Unreleased]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.0...HEAD\n`)
  assert.throws(() => run('check'), (error) => error.status === 1 && /\[0\.2\.0\]/.test(error.stderr) && /v0\.1\.0/.test(error.stderr) && /\[Unreleased\]/.test(error.stderr))
  writeFileSync(file, '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-04\n\n- First.\n\n[Unreleased]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.2.0...HEAD\n[0.2.0]: https://github.com/ThinkFlowLab/FlyBot/releases/tag/v0.2.0\n')
  assert.match(run('check'), /fragment/)
  rmSync(root, { recursive: true })
})

test('linkProblems: names a heading without a definition and a stale [Unreleased]', () => {
  const broken = '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-04\n\n[Unreleased]: https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.0...HEAD\n'
  assert.deepEqual(linkProblems(broken), [
    '"## [0.2.0]" has no "[0.2.0]:" link definition',
    '"[Unreleased]:" compares from https://github.com/ThinkFlowLab/FlyBot/compare/v0.1.0...HEAD, not from the newest release (v0.2.0)',
  ])
  assert.deepEqual(linkProblems(release(LINKED, [{ kind: 'fixed', text: 'Next.' }], '0.3.0', '2026-11-05')), [])
})

test('release: refuses bad input and a duplicate version', () => {
  assert.throws(() => release('# x\n', [], '0.1.1', '2026-10-20'), /Unreleased/)
  assert.throws(() => release(CHANGELOG, [], 'v0.1.1', '2026-10-20'), /not a version/)
  assert.throws(() => release(CHANGELOG, [], '0.1.1', 'today'), /not a date/)
  assert.throws(() => release(CHANGELOG, [], '0.1.0', '2026-10-20'), /already has/)
  assert.throws(() => release('## [Unreleased]\n\n## [0.1.0] - x\n', [], '0.1.1', '2026-10-20'), /nothing to release/)
})

test('CLI: check, preview, then release writes the file and removes the fragments', () => {
  const root = tmp()
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG)
  fragments(join(root, 'changelog.d'))('7-thing.added.md', 'Thing (#7).\n')
  const run = (...args) => execFileSync(process.execPath, [new URL('./changelog.mjs', import.meta.url).pathname, ...args], { env: { ...process.env, CHANGELOG_ROOT: root }, encoding: 'utf8' })
  assert.match(run('check'), /1 fragment/)
  assert.match(run('preview'), /### Added\n\n- Thing \(#7\)\./)
  run('release', '0.2.0', '--date', '2026-11-01', '--dry-run')
  assert.ok(existsSync(join(root, 'changelog.d', '7-thing.added.md')))
  run('release', '0.2.0', '--date', '2026-11-01')
  assert.ok(!existsSync(join(root, 'changelog.d', '7-thing.added.md')))
  assert.match(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), /## \[0\.2\.0\] - 2026-11-01\n\n### Added\n\n- Thing \(#7\)\.\n\n### Changed\n\n- Old hand-written entry\./)
  rmSync(root, { recursive: true })
})

test('the repo: changelog.d/ is valid and every CHANGELOG.md heading has its definition', () => {
  readFragments(new URL('../../changelog.d', import.meta.url).pathname)
  const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(text, /^## \[Unreleased\]$/m)
  assert.deepEqual(linkProblems(text), [])
})
