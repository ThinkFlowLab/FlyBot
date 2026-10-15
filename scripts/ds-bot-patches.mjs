#!/usr/bin/env node
// FlyBot's core = pristine upstream ds-bot (ds-bot/, pinned in ds-bot.pin.json) + the ordered
// patch series in patches/ds-bot/. This script keeps the three in step (see #34).
//
//   node scripts/ds-bot-patches.mjs apply      rebuild core/ from ds-bot/ + files/ + patches (overwrites core/)
//   node scripts/ds-bot-patches.mjs check      CI: ds-bot/ matches the pin, every patch applies cleanly
//                                              in order, and the result equals the committed core/
//   node scripts/ds-bot-patches.mjs generate   rewrite patches/ds-bot/ from core/ vs ds-bot/ (after editing
//                                              core/): *.patch for edits to upstream files, split by
//                                              topics.json; files/ for files upstream does not have
//
// The format is chosen so that two branches editing the same core file merge without conflicts in
// the generated output (see patches/ds-bot/README.md): no `index <hash>` lines, hunk headers that
// do not depend on other hunks, no file counts, and whole new files stored verbatim in files/
// instead of as one `@@ -0,0 +1,N @@` hunk whose N changes with every edit.
//
// Upgrading the pin: replace ds-bot/ with upstream's ds-bot/ at the new commit, update
// ds-bot.pin.json (commit, tree = `git rev-parse <commit>:ds-bot` upstream, version), run
// `apply`; fix each patch that fails (edit core/ by hand), then `generate`, `check`, test.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PIN = JSON.parse(readFileSync(join(ROOT, 'ds-bot.pin.json'), 'utf8'))
const UPSTREAM = PIN.path ?? 'ds-bot'
const CORE = 'core'
const PATCHES = join(ROOT, 'patches', 'ds-bot')
const FILES = join(PATCHES, 'files') // whole files FlyBot adds (or replaces, when binary): copied over ds-bot/ before the patches apply
const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
const tracked = dir => git(['ls-files', '-z', '--', dir]).split('\0').filter(Boolean).map(f => relative(dir, f))
const series = () => readdirSync(PATCHES).filter(f => /^\d{4}-.*\.patch$/.test(f)).sort()
const fail = (message) => { console.error(`ds-bot-patches: ${message}`); process.exit(1) }

// ds-bot/'s tracked files, copied as they are on disk, then files/ over them, then each patch applied in order.
function build(out) {
  rmSync(join(ROOT, out), { recursive: true, force: true })
  for (const file of tracked(UPSTREAM)) {
    mkdirSync(dirname(join(ROOT, out, file)), { recursive: true })
    cpSync(join(ROOT, UPSTREAM, file), join(ROOT, out, file))
  }
  for (const file of readdirTree(FILES)) {
    mkdirSync(dirname(join(ROOT, out, file)), { recursive: true })
    cpSync(join(FILES, file), join(ROOT, out, file))
  }
  for (const patch of series()) {
    try {
      git(['apply', '--whitespace=nowarn', `--directory=${out}`, '-p1', join(PATCHES, patch)], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { fail(`${patch} does not apply cleanly:\n${error.stderr || error.message}`) }
  }
}

function checkPin() {
  // The tree of ds-bot/ as staged (equals HEAD in CI), so the check also works before a commit.
  const tree = git(['ls-tree', git(['write-tree']).trim(), UPSTREAM]).split(/\s+/)[2]
  if (tree !== PIN.tree) fail(`${UPSTREAM}/ is tree ${tree}, the pin says ${PIN.tree} (${PIN.repo}@${PIN.commit.slice(0, 7)}). Do not edit ${UPSTREAM}/; change patches/ds-bot/.`)
  const dirty = [git(['diff', '--name-only', '--', UPSTREAM]), git(['ls-files', '--others', '--exclude-standard', '--', UPSTREAM])].join('').trim()
  if (dirty) fail(`${UPSTREAM}/ has unstaged or untracked changes:\n${dirty}`)
  console.log(`ok   ${UPSTREAM}/ = ${PIN.repo}@${PIN.commit.slice(0, 7)} (tree ${PIN.tree.slice(0, 7)}, v${PIN.version})`)
}

function check() {
  checkPin()
  const out = '.ds-bot-check'
  try {
    build(out)
    console.log(`ok   ${series().length} patches apply cleanly in order`)
    const want = new Set(tracked(CORE))
    const have = new Set(readdirTree(join(ROOT, out)))
    const problems = []
    for (const f of want) if (!have.has(f)) problems.push(`core/${f}: committed but not produced by the patches`)
    for (const f of have) {
      if (!want.has(f)) problems.push(`core/${f}: produced by the patches but not committed`)
      else if (!readFileSync(join(ROOT, out, f)).equals(readFileSync(join(ROOT, CORE, f)))) problems.push(`core/${f}: differs from ds-bot/ + patches`)
      else if (isExec(join(ROOT, out, f)) !== isExec(join(ROOT, CORE, f))) problems.push(`core/${f}: executable bit differs from ds-bot/ + patches`)
    }
    if (problems.length) fail(`core/ is not ds-bot/ + patches/ds-bot/ (edit core/, then run generate; or run apply):\n  ${problems.join('\n  ')}`)
    console.log('ok   core/ equals ds-bot/ + patches/ds-bot/')
  } finally { rmSync(join(ROOT, out), { recursive: true, force: true }) }
}

const isExec = path => (statSync(path).mode & 0o100) !== 0

function readdirTree(dir, base = dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? readdirTree(join(dir, e.name), base) : [relative(base, join(dir, e.name))]))
}

// One file's `git diff --no-index` output -> the stored form. Only header lines are touched.
//  - `index <old>..<new>` lines go: git apply does not need them for text diffs, and they change with every edit.
//  - `a/ds-bot/x` and `b/core/x` become `a/x` and `b/x`, in header lines only, never in file content.
//  - A hunk's new-side start is only the position hint git apply searches from, but its true value depends
//    on every hunk above it, so an edit above would change (and conflict on) this line. The old-side start is
//    fixed by the pristine upstream file; use it as the hint instead. `exact` keeps the true numbers.
export function normalizeDiff(diff, { exact = false } = {}) {
  const out = []
  let oldLeft = 0
  let newLeft = 0
  for (const line of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) { // inside a hunk body: count lines until the header's counts are used up
      if (line.startsWith('+')) newLeft--
      else if (line.startsWith('-')) oldLeft--
      else if (!line.startsWith('\\')) { oldLeft--; newLeft-- }
      out.push(line)
      continue
    }
    if (line.startsWith('index ')) continue
    if (/^(diff --git |--- |\+\+\+ )/.test(line)) { out.push(line.replace(new RegExp(`([ab])/(?:${UPSTREAM}|${CORE})/`, 'g'), '$1/')); continue }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
    if (!hunk) { out.push(line); continue }
    const [, oldStart, oldCount, newStart, newCount, rest] = hunk
    oldLeft = Number(oldCount ?? 1)
    newLeft = Number(newCount ?? 1)
    // A hunk with no old or no new lines (a whole-file delete, a pure insert) keeps its true numbers.
    const hint = exact || oldLeft === 0 || newLeft === 0 ? newStart : oldStart
    out.push(`@@ -${oldStart}${oldCount === undefined ? '' : `,${oldCount}`} +${hint}${newCount === undefined ? '' : `,${newCount}`} @@${rest}`)
  }
  return out.join('\n')
}

const looksBinary = buffer => buffer.subarray(0, 8000).includes(0)

// Apply one stored file diff to a copy of the upstream file, alone, and say whether it gives core's file.
// A wrong hint could in principle land a hunk on a repeated context, so generate proves each file.
function diffReproduces(file, diff, hadUpstream) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-patch-'))
  try {
    if (hadUpstream) {
      mkdirSync(dirname(join(dir, file)), { recursive: true })
      cpSync(join(ROOT, UPSTREAM, file), join(dir, file))
    }
    writeFileSync(join(dir, 'one.patch'), diff)
    execFileSync('git', ['apply', '--whitespace=nowarn', '-p1', 'one.patch'], { cwd: dir, stdio: 'ignore' })
    return existsSync(join(ROOT, CORE, file)) ? existsSync(join(dir, file)) && readFileSync(join(dir, file)).equals(readFileSync(join(ROOT, CORE, file))) : !existsSync(join(dir, file))
  } catch { return false } finally { rmSync(dir, { recursive: true, force: true }) }
}

function generate() {
  const topics = JSON.parse(readFileSync(join(PATCHES, 'topics.json'), 'utf8'))
  const upstream = new Set(tracked(UPSTREAM))
  const core = new Set(tracked(CORE))
  const changed = [...new Set([...upstream, ...core])].sort().filter(f => !upstream.has(f) || !core.has(f) ||
    !readFileSync(join(ROOT, UPSTREAM, f)).equals(readFileSync(join(ROOT, CORE, f))))
  // Whole files, stored verbatim: new in FlyBot, or changed binaries (a binary has no mergeable diff).
  const whole = changed.filter(f => core.has(f) && (!upstream.has(f) || looksBinary(readFileSync(join(ROOT, CORE, f))) || looksBinary(readFileSync(join(ROOT, UPSTREAM, f)))))
  const edited = changed.filter(f => !whole.includes(f))
  const topicOf = f => Object.keys(topics).find(t => topics[t].some(p => (p.endsWith('/') ? f.startsWith(p) : f === p)))
  const missing = edited.filter(f => !topicOf(f))
  if (missing.length) fail(`edited upstream files with no topic in patches/ds-bot/topics.json:\n  ${missing.join('\n  ')}`)
  const textOf = f => {
    const a = upstream.has(f) ? `${UPSTREAM}/${f}` : '/dev/null'
    const b = core.has(f) ? `${CORE}/${f}` : '/dev/null'
    let diff
    try { diff = git(['diff', '--no-index', '--no-color', '--', a, b]) } catch (error) { diff = error.stdout }
    for (const exact of [false, true]) {
      const text = normalizeDiff(diff, { exact })
      if (diffReproduces(f, text, upstream.has(f))) return text
    }
    return fail(`the diff of ${f} does not reproduce core/${f} when applied to ds-bot/${f}`)
  }
  const texts = new Map(edited.map(f => [f, textOf(f)]))
  rmSync(FILES, { recursive: true, force: true })
  for (const old of series()) rmSync(join(PATCHES, old))
  for (const f of whole) {
    mkdirSync(dirname(join(FILES, f)), { recursive: true })
    cpSync(join(ROOT, CORE, f), join(FILES, f))
  }
  if (whole.length) console.log(`wrote patches/ds-bot/files/ (${whole.length} files)`)
  for (const topic of Object.keys(topics)) {
    const files = edited.filter(f => topicOf(f) === topic)
    if (!files.length) continue
    let text = `FlyBot patch ${topic} on ${PIN.repo}@${PIN.commit.slice(0, 7)} (${UPSTREAM}/). Generated by scripts/ds-bot-patches.mjs; edits to upstream files only (files FlyBot adds are in files/).\n\n`
    for (const f of files) text += texts.get(f)
    writeFileSync(join(PATCHES, `${topic}.patch`), text)
    console.log(`wrote patches/ds-bot/${topic}.patch (${files.length} files)`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2]
  if (!existsSync(PATCHES)) fail('patches/ds-bot/ is missing')
  if (command === 'apply') { build(CORE); console.log(`core/ rebuilt from ${UPSTREAM}/ + files/ + ${series().length} patches`) }
  else if (command === 'check') check()
  else if (command === 'generate') generate()
  else if (command === 'pin') checkPin()
  else fail('usage: node scripts/ds-bot-patches.mjs apply|check|generate|pin')
}
