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
//   node scripts/ds-bot-patches.mjs canonical  CI gate (#1890): fail when generate would change
//                                              patches/ds-bot/, i.e. when the committed split drifted.
//                                              `check` cannot answer this — a re-split series still
//                                              reproduces core/ — and that gap landed #1883..#1889 green.
//                                              Changes nothing on disk: generate writes to a scratch copy.
//   node scripts/ds-bot-patches.mjs review <sha> [test-file]
//                                              Review a tip without checking it out: download that
//                                              commit's tarball from GitHub, commit it into a scratch
//                                              repository so the pin check can compute a tree, and
//                                              compare that tree with the one the API reports for the
//                                              commit (a mismatch: the download is not that commit).
//                                              Then run this tip's own check and canonical, and, when a
//                                              test file is named, that file under core/ (the path the
//                                              way core/ has it; a leading `core/` is accepted). Every
//                                              step that fails exits non-zero and says why on stdout.
//
//                                              The repository is FLYBOT_REVIEW_REPO=owner/name, else
//                                              GITHUB_REPOSITORY, else the `upstream` remote, else
//                                              `origin`; a fork pull request's tip lives in the fork, so
//                                              an unknown sha falls through to the next one. A public
//                                              repository downloads without a token; DSH_SECRET_GITHUB_TOKEN
//                                              authenticates the download when set, which is what the
//                                              rate limit asks for. Installed dependencies
//                                              (core/node_modules, core/dev/harness/node_modules) are
//                                              shared into the scratch tree, so a test file runs without
//                                              a second `npm install`; without them the test fails with
//                                              the module it could not load, which is the reason printed.
//                                              Needs git (to commit the tarball) and tar (to unpack it).
//
// The format is chosen so that two branches editing the same core file merge without conflicts in
// the generated output (see patches/ds-bot/README.md): no `index <hash>` lines, hunk headers that
// do not depend on other hunks, no file counts, and whole new files stored verbatim in files/
// instead of as one `@@ -0,0 +1,N @@` hunk whose N changes with every edit.
//
// Upgrading the pin: replace ds-bot/ with upstream's ds-bot/ at the new commit, update
// ds-bot.pin.json (commit, tree = `git rev-parse <commit>:ds-bot` upstream, version), run
// `apply`; fix each patch that fails (edit core/ by hand), then `generate`, `check`, test.
//
// Without git (#978): `check` and `apply` still run, through a strict applier of our own that holds
// the same rules git apply does — a hunk body must carry the counts its header declares, must match
// the file AT the old-side line the header names (no "find this context nearby"), may not run past the
// end of the file, and honours `\ No newline at end of file`. Tracked files come from a walk with the
// root .gitignore rules, and the pin is skipped out loud instead of passing silently. A machine with
// git keeps the git path: CI is the reference, and the test compares both appliers on every patch.
// `generate` needs git either way, because it asks git for the diff.
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()
// `git ls-files` and `git write-tree` answer only when this directory is the root of its own
// repository. A copy of the tree inside another checkout answers with the outer repository's index
// and says nothing about these files (it produced a phantom drift on a copied tree while #1890 was
// built), so the root has to be the repository's top level; anything else uses the walk below.
const inRepo = hasGit && (() => {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return realpathSync(top) === realpathSync(ROOT)
  } catch { return false }
})()
const series = () => readdirSync(PATCHES).filter(f => /^\d{4}-.*\.patch$/.test(f)).sort()
const fail = (message) => { console.error(`ds-bot-patches: ${message}`); process.exit(1) }

// The tracked files of a directory. git answers on a machine that has it; without git the walk below
// answers, and the root .gitignore decides what is not in the repository. The walk is a list of what
// is on disk, which is what `ls-files` reports too before a commit, apart from ignored files.
const tracked = dir => (inRepo ? git(['ls-files', '-z', '--', dir]).split('\0').filter(Boolean).map(f => relative(dir, f)) : walkTracked(dir))

const globToRegExp = glob => new RegExp(`^${glob.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)

// The root .gitignore, read the way a walk needs it: no `/` in a rule matches a path segment (so
// `node_modules/` prunes it at any depth), a `/` anchors the rule to the root, a trailing `/` means
// directories only, and `!` re-includes. The repository has no nested ignore files.
function ignoreRules() {
  const file = join(ROOT, '.gitignore')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => {
      const negate = line.startsWith('!')
      let pattern = negate ? line.slice(1) : line
      const dirOnly = pattern.endsWith('/')
      if (dirOnly) pattern = pattern.slice(0, -1)
      const anchored = pattern.includes('/')
      if (anchored) pattern = pattern.replace(/^\/+/, '')
      return { negate, dirOnly, anchored, re: globToRegExp(pattern) }
    })
}

function isIgnored(rules, rel, isDir) {
  const segments = rel.split('/')
  const ancestors = []
  let prefix = ''
  for (const segment of segments.slice(0, -1)) { prefix = prefix ? `${prefix}/${segment}` : segment; ancestors.push(prefix) }
  let ignored = false
  for (const rule of rules) {
    const hit = rule.anchored
      ? rule.re.test(rel) || (rule.dirOnly && ancestors.some(p => rule.re.test(p)))
      : (rule.dirOnly ? (isDir ? segments : segments.slice(0, -1)) : segments).some(segment => rule.re.test(segment))
    if (hit) ignored = !rule.negate
  }
  return ignored
}

function walkTracked(dir) {
  const rules = ignoreRules()
  const out = []
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const child = `${rel}/${entry.name}`
      // A symlink to a directory is a file to git, but a directory to an ignore rule (`node_modules/`).
      const directory = entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(abs, entry.name), { throwIfNoEntry: false })?.isDirectory() === true)
      if (isIgnored(rules, child, directory)) continue
      if (entry.isDirectory()) walk(join(abs, entry.name), child)
      else out.push(child.slice(dir.length + 1))
    }
  }
  walk(join(ROOT, dir), dir)
  return out
}

// A file's text as lines that remember whether the last one ends with a newline, so `\ No newline at
// end of file` has somewhere to land.
const toLines = text => {
  if (text === '') return []
  const ends = text.endsWith('\n')
  const lines = (ends ? text.slice(0, -1) : text).split('\n').map(lineText => ({ text: lineText, noEol: false }))
  if (!ends) lines[lines.length - 1].noEol = true
  return lines
}

// git-free applier for the stored series (#978), at `git apply`'s strictness: `-p1` strip, whole-file
// create/delete, and one rule per hunk that is checked rather than searched for. Used only when git is
// absent; the test compares it against git apply on every patch so the two cannot drift.
export function applyPatchText(text, dest) {
  const rows = text.split('\n')
  const sections = []
  let section = null
  for (const row of rows) {
    if (row.startsWith('diff --git ')) { section = [row]; sections.push(section); continue }
    if (section) section.push(row)
  }
  if (!sections.length) throw new Error('the patch has no `diff --git` section')
  const strip = line => {
    const raw = line.slice(4).split('\t')[0].trim()
    if (raw === '/dev/null') return null
    const parts = raw.split('/')
    if (parts.length < 2 || (parts[0] !== 'a' && parts[0] !== 'b')) throw new Error(`cannot strip -p1 from ${line}`)
    return parts.slice(1).join('/')
  }
  for (const sectionRows of sections) {
    const oldHeader = sectionRows.find(row => row.startsWith('--- '))
    const newHeader = sectionRows.find(row => row.startsWith('+++ '))
    if (!oldHeader || !newHeader) throw new Error(`a file header is missing in ${sectionRows[0]}`)
    const oldPath = strip(oldHeader)
    const newPath = strip(newHeader)
    const file = newPath ?? oldPath
    const target = join(dest, file)
    const modeLine = sectionRows.find(row => /^new file mode \d+$/.test(row))
    const before = oldPath && existsSync(target) ? toLines(readFileSync(target, 'utf8')) : []
    const after = []
    let cursor = 0
    let hunkNumber = 0
    for (let h = 0; h < sectionRows.length; h++) {
      const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(sectionRows[h])
      if (!head) continue
      hunkNumber++
      const oldStart = Number(head[1])
      const oldCount = head[2] === undefined ? 1 : Number(head[2])
      const newCount = head[4] === undefined ? 1 : Number(head[4])
      const name = `${file} hunk ${hunkNumber} (@@ -${oldStart},${oldCount} +${head[3]},${newCount} @@)`
      const body = []
      let j = h + 1
      for (; j < sectionRows.length; j++) {
        const row = sectionRows[j]
        if (row.startsWith('@@ ') || row.startsWith('diff --git ')) break
        if (row === '' && j === sectionRows.length - 1) break // the patch's own final newline
        if (row[0] !== ' ' && row[0] !== '+' && row[0] !== '-' && row[0] !== '\\') throw new Error(`${name}: not a hunk line: ${JSON.stringify(row.slice(0, 60))}`)
        body.push(row)
      }
      h = j - 1
      // 1. The body must carry exactly the counts the header declares (#934's shape: one blank line too many).
      let oldSeen = 0
      let newSeen = 0
      for (const row of body) {
        if (row[0] === ' ') { oldSeen++; newSeen++ }
        else if (row[0] === '-') oldSeen++
        else if (row[0] === '+') newSeen++
      }
      if (oldSeen !== oldCount || newSeen !== newCount) throw new Error(`${name}: the body has ${oldSeen} old and ${newSeen} new line(s), the header declares ${oldCount} and ${newCount}`)
      // 2. The hunk must land where its header says, and 3. it may not run past the end of the file (#966's shape).
      const at = oldCount === 0 ? oldStart : oldStart - 1
      if (at < cursor) throw new Error(`${name}: starts before the end of the previous hunk`)
      if (at + oldCount > before.length) throw new Error(`${name}: runs past the end of the file (${before.length} lines)`)
      for (let k = cursor; k < at; k++) after.push({ ...before[k] })
      cursor = at
      for (let b = 0; b < body.length; b++) {
        const row = body[b]
        if (row[0] === '\\') {
          if (row !== '\\ No newline at end of file') throw new Error(`${name}: unknown marker ${JSON.stringify(row)}`)
          const previous = body[b - 1]
          if (!previous) throw new Error(`${name}: a marker with nothing before it`)
          if (previous[0] === '+') {
            if (!after.length) throw new Error(`${name}: a marker with nothing before it`)
            after[after.length - 1].noEol = true
            continue
          }
          const last = before[cursor - 1]
          if (!last || !last.noEol) throw new Error(`${name}: says "No newline at end of file" after a line that has one`)
          last.marked = true
          if (previous[0] === ' ') after[after.length - 1].noEol = true
          continue
        }
        const lineText = row.slice(1)
        if (row[0] === '+') { after.push({ text: lineText, noEol: false }); continue }
        const old = before[cursor]
        if (!old) throw new Error(`${name}: line ${cursor + 1} does not exist in ${file}`)
        if (old.text !== lineText) throw new Error(`${name}: ${row[0] === ' ' ? 'context' : 'removed line'} at ${cursor + 1} is ${JSON.stringify(old.text)}, the hunk has ${JSON.stringify(lineText)}`)
        if (row[0] === ' ') after.push({ ...old })
        cursor++
      }
    }
    for (let k = cursor; k < before.length; k++) after.push({ ...before[k] })
    // What the patch says about the old file's last newline must be what that file is.
    if (before.length) {
      const last = before[before.length - 1]
      if (last.noEol && !last.marked && cursor >= before.length) throw new Error(`${file}: the last line has no newline; the hunk must mark it`)
    }
    for (let k = 0; k < after.length - 1; k++) if (after[k].noEol) throw new Error(`${file}: only the last line may lack a newline`)
    if (!newPath) { rmSync(target, { force: true }); continue }
    const content = after.map((line, k) => (k === after.length - 1 ? line.text + (line.noEol ? '' : '\n') : `${line.text}\n`)).join('')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    if (modeLine) chmodSync(target, parseInt(modeLine.split(' ').pop(), 8))
  }
}

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
    if (!inRepo) {
      try { applyPatchText(readFileSync(join(PATCHES, patch), 'utf8'), join(ROOT, out)) } catch (error) { fail(`${patch} does not apply cleanly:\n${error.message}`) }
      continue
    }
    try {
      git(['apply', '--whitespace=nowarn', `--directory=${out}`, '-p1', join(PATCHES, patch)], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) { fail(`${patch} does not apply cleanly:\n${error.stderr || error.message}`) }
  }
}

function checkPin() {
  if (!inRepo) {
    // Not a pass: the tree hash cannot be computed here, so say what was skipped (#978).
    console.log(hasGit ? 'skipped pin (not a git checkout at the root): the tree hash cannot be computed here' : 'skipped pin (no git): the tree hash cannot be computed here')
    return
  }
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
    if (hasGit) execFileSync('git', ['apply', '--whitespace=nowarn', '-p1', 'one.patch'], { cwd: dir, stdio: 'ignore' })
    else applyPatchText(diff, dir)
    return existsSync(join(ROOT, CORE, file)) ? existsSync(join(dir, file)) && readFileSync(join(dir, file)).equals(readFileSync(join(ROOT, CORE, file))) : !existsSync(join(dir, file))
  } catch { return false } finally { rmSync(dir, { recursive: true, force: true }) }
}

// `dest` is patches/ds-bot/ itself, or a scratch copy of it for `canonical` (#1890); `quiet` keeps
// that gate's output down to its one pass line.
function generate(dest = PATCHES, { quiet = false } = {}) {
  // The diff itself comes from git. Without git there is nothing to ask for it: the git-free applier
  // (#978) is a validator, not a diff writer.
  if (!hasGit) fail('generate needs git: it asks git for the diff of ds-bot/ against core/. Without git, edit core/ and patches/ds-bot/ together and run check.')
  const say = quiet ? () => {} : console.log
  const topics = JSON.parse(readFileSync(join(dest, 'topics.json'), 'utf8'))
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
  const filesOut = join(dest, 'files')
  rmSync(filesOut, { recursive: true, force: true })
  for (const old of readdirSync(dest)) if (/^\d{4}-.*\.patch$/.test(old)) rmSync(join(dest, old))
  for (const f of whole) {
    mkdirSync(dirname(join(filesOut, f)), { recursive: true })
    cpSync(join(ROOT, CORE, f), join(filesOut, f))
  }
  if (whole.length) say(`wrote patches/ds-bot/files/ (${whole.length} files)`)
  for (const topic of Object.keys(topics)) {
    const files = edited.filter(f => topicOf(f) === topic)
    if (!files.length) continue
    let text = `FlyBot patch ${topic} on ${PIN.repo}@${PIN.commit.slice(0, 7)} (${UPSTREAM}/). Generated by scripts/ds-bot-patches.mjs; edits to upstream files only (files FlyBot adds are in files/).\n\n`
    for (const f of files) text += texts.get(f)
    writeFileSync(join(dest, `${topic}.patch`), text)
    say(`wrote patches/ds-bot/${topic}.patch (${files.length} files)`)
  }
}

// The gate #1890 asked for: is the committed series what `generate` writes? It regenerates into a
// scratch copy of patches/ds-bot/ — never into the working tree — and compares the two file for file,
// so a drift that still reproduces core/ (a re-split topic, a patch folded away) fails here and not
// in the merge queue. Only the files generate owns are compared; topics.json is hand-written.
function canonical() {
  if (!hasGit) fail('canonical needs git: it compares the committed series with what generate writes, and generate asks git for the diff')
  const scratch = mkdtempSync(join(tmpdir(), 'ds-bot-canonical-'))
  try {
    const staged = join(scratch, 'patches')
    cpSync(PATCHES, staged, { recursive: true })
    generate(staged, { quiet: true })
    const owned = dir => readdirTree(dir).filter(f => /^\d{4}-.*\.patch$/.test(f) || f.split(/[\\/]/)[0] === 'files')
    const committed = new Set(owned(PATCHES))
    const produced = new Set(owned(staged))
    const drift = []
    for (const file of [...committed].sort()) {
      if (!produced.has(file)) drift.push(`D patches/ds-bot/${file}`)
      else if (!readFileSync(join(PATCHES, file)).equals(readFileSync(join(staged, file)))) drift.push(`M patches/ds-bot/${file}`)
    }
    for (const file of [...produced].sort()) if (!committed.has(file)) drift.push(`A patches/ds-bot/${file}`)
    if (drift.length) fail(`patches/ds-bot/ is not what generate writes — the committed series drifted:\n  ${drift.join('\n  ')}\nrun \`node scripts/ds-bot-patches.mjs generate\` and commit its output`)
    console.log('ok   patches/ds-bot/ is what generate writes (generate is a no-op)')
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

// `review` (see the header): its failures are a review result, not a broken checkout, so they print
// on stdout with the rest of the report and exit non-zero instead of going to `fail`'s stderr.
class ReviewError extends Error {}

const reviewFail = message => { throw new ReviewError(message) }

// The repository a sha is asked about: the explicit name first, then the remotes, since a fork pull
// request's tip is not in the upstream and an upstream sha is not in the fork.
function reviewRepos() {
  const repos = []
  const named = process.env.FLYBOT_REVIEW_REPO || process.env.GITHUB_REPOSITORY
  if (named) repos.push(named)
  for (const name of ['upstream', 'origin']) {
    let url
    try { url = execFileSync('git', ['remote', 'get-url', name], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { continue }
    // A proxy prefix (a mirror URL) is fine: the `github.com/owner/name` tail is what the API needs.
    const hit = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
    if (hit) repos.push(`${hit[1]}/${hit[2]}`)
  }
  return [...new Set(repos)]
}

async function reviewResponse(url, timeout) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'ds-bot-patches-review', 'x-github-api-version': '2022-11-28' }
  if (process.env.DSH_SECRET_GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.DSH_SECRET_GITHUB_TOKEN}`
  try {
    return await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout) })
  } catch (error) {
    const why = error?.name === 'TimeoutError' ? `no answer in ${Math.round(timeout / 1000)}s` : (error?.cause?.code ?? error?.message ?? String(error))
    reviewFail(`GET ${url} failed: ${why}`)
  }
}

const apiMessage = async response => {
  try { const body = await response.json(); return body?.message ? ` (${body.message})` : '' } catch { return '' }
}

// Dependencies the reviewed tip does not carry (they are ignored files, so a tarball has none): lend it
// this checkout's, so a test file can run. Never overwrite what the tarball brought.
function shareDependencies(coreDir) {
  const linked = []
  for (const rel of ['node_modules', join('dev', 'harness', 'node_modules')]) {
    const source = join(ROOT, CORE, rel)
    const target = join(coreDir, rel)
    if (!existsSync(source) || existsSync(target)) continue
    try { mkdirSync(dirname(target), { recursive: true }); symlinkSync(source, target, 'dir'); linked.push(rel) } catch { /* a failed link shows up as the module the test cannot load */ }
  }
  return linked
}

async function reviewWork(sha, testFile) {
  if (!hasGit) reviewFail('review needs git: it commits the downloaded tarball to compute its tree')
  if (!/^[0-9a-f]{7,40}$/i.test(sha ?? '')) reviewFail(`"${sha ?? ''}" is not a commit sha (7 to 40 hex characters)`)
  const repos = reviewRepos()
  if (!repos.length) reviewFail('no GitHub repository to ask: set FLYBOT_REVIEW_REPO=owner/name or add an `upstream` or `origin` remote')
  let repo
  let apiTree
  const answers = []
  for (const candidate of repos) {
    const response = await reviewResponse(`https://api.github.com/repos/${candidate}/commits/${sha}`, 60_000)
    // GitHub answers 422 "No commit found for SHA" for a sha that repository does not have, not 404.
    if (response.status === 404 || response.status === 422) { answers.push(`${candidate}: no such commit`); continue }
    if (!response.ok) reviewFail(`commits/${sha} on ${candidate} -> HTTP ${response.status}${await apiMessage(response)}`)
    const body = await response.json()
    apiTree = body?.commit?.tree?.sha
    if (!apiTree) reviewFail(`commits/${sha} on ${candidate} carries no commit.tree.sha`)
    repo = candidate
    break
  }
  if (!repo) reviewFail(`no commit ${sha} in ${answers.join(', ')} — set FLYBOT_REVIEW_REPO=owner/name when the branch lives in another fork`)
  const tarball = await reviewResponse(`https://api.github.com/repos/${repo}/tarball/${sha}`, 300_000)
  if (!tarball.ok) reviewFail(`the tarball of ${sha} on ${repo} -> HTTP ${tarball.status}${await apiMessage(tarball)}`)
  const bytes = Buffer.from(await tarball.arrayBuffer())
  const scratch = mkdtempSync(join(tmpdir(), 'ds-bot-review-'))
  try {
    writeFileSync(join(scratch, 'tip.tar.gz'), bytes)
    const tip = join(scratch, 'tip')
    mkdirSync(tip)
    try { execFileSync('tar', ['-xzf', join(scratch, 'tip.tar.gz'), '-C', tip, '--strip-components=1'], { stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) {
      reviewFail(`the tarball does not extract (is tar installed?): ${String(error.stderr ?? '').trim() || error.message}`)
    }
    const inTip = args => execFileSync('git', args, { cwd: tip, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
    try {
      inTip(['init', '-q'])
      inTip(['add', '-A'])
      inTip(['-c', 'user.name=review', '-c', 'user.email=review@invalid', 'commit', '-q', '--no-gpg-sign', '-m', `review ${sha}`])
    } catch (error) { reviewFail(`the extracted tree cannot be committed: ${String(error.stderr ?? '').trim() || error.message}`) }
    const tree = inTip(['rev-parse', 'HEAD^{tree}']).trim()
    if (tree !== apiTree) reviewFail(`the tarball of ${sha} commits as tree ${tree}, the API says ${apiTree} — the download is not that commit`)
    console.log(`ok   ${repo}@${sha} is tree ${tree}`)
    // The tip's own gates, not this checkout's: a reviewer wants the answer that sha's CI would give.
    const script = join(tip, 'scripts', 'ds-bot-patches.mjs')
    if (!existsSync(script)) reviewFail('this tip carries no scripts/ds-bot-patches.mjs')
    for (const step of ['check', 'canonical']) {
      try { process.stdout.write(execFileSync(process.execPath, [script, step], { cwd: tip, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 })) } catch (error) {
        reviewFail(`${step} failed on ${sha}:\n${`${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message}`)
      }
    }
    const rel = testFile?.replace(/^\.\//, '')
    const underCore = rel?.startsWith(`${CORE}/`) ? rel.slice(CORE.length + 1) : rel
    if (rel) {
      if (!existsSync(join(tip, CORE, underCore))) reviewFail(`this tip carries no ${CORE}/${underCore}`)
      const linked = shareDependencies(join(tip, CORE))
      if (linked.length) console.log(`ok   lent this tip ${linked.map(f => `${CORE}/${f}`).join(' and ')} from this checkout`)
      try {
        process.stdout.write(execFileSync(process.execPath, ['--import', './test/harness-resolve.mjs', '--test', underCore], { cwd: join(tip, CORE), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }))
      } catch (error) {
        reviewFail(`${CORE}/${underCore} failed on ${sha}:\n${`${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message}`)
      }
    }
    console.log(`ok   review ${repo}@${sha}${rel ? ` (${CORE}/${underCore})` : ''}`)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

async function review(sha, testFile) {
  try { await reviewWork(sha, testFile) } catch (error) {
    console.log(`review: ${error instanceof ReviewError ? error.message : (error?.message ?? String(error))}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2]
  if (!existsSync(PATCHES)) fail('patches/ds-bot/ is missing')
  if (command === 'apply') { build(CORE); console.log(`core/ rebuilt from ${UPSTREAM}/ + files/ + ${series().length} patches`) }
  else if (command === 'check') check()
  else if (command === 'generate') generate()
  else if (command === 'canonical') canonical()
  else if (command === 'pin') checkPin()
  else if (command === 'review') review(process.argv[3], process.argv[4])
  else fail('usage: node scripts/ds-bot-patches.mjs apply|check|generate|canonical|pin|review <sha> [test-file]')
}
