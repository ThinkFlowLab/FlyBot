// Silent revert: a branch built on an old copy of `main` deletes work `main` merged after the
// branch was cut, and CI stays green because the deletion is part of the pull request (#914).
//
//   PR=12 node .github/scripts/silent-revert.mjs --repo-dir head   # what the workflow runs
//   node .github/scripts/silent-revert.mjs --repo-dir . --pr 12 --main origin/main
//
// Four times in one day (#864, #876, #887, #907) a pull request re-uploaded whole files from a
// stale copy: `#887` deleted `#869`'s 84 test lines merged the same hour, `#907` deleted `#909`'s
// whole fix merged 40 minutes earlier. Every one of those pull requests was `mergeable: true`
// with `tests-ok` green — the deletion *was* the pull request, so no check could see it.
//
// The rule, stated so that it can be wrong:
//   base = merge-base(origin/main, HEAD)
//   A    = the lines `origin/main` added after `base`, per file    (git diff <base> origin/main)
//   D    = the lines this pull request deletes from `origin/main`, per file (git diff origin/main HEAD)
//   A ∩ D non-empty -> a silent revert. Report the file, the count, and the commit that added the
//   line to `main`.
// Set intersection on line text, no blame walk for the hit itself: `A` *is* the work the branch
// never saw. `#910` replaced 18 lines of the inbound trust path with its own and its `A` was empty
// at its base, so it reports nothing — that is the negative control, and it must stay zero.
//
// Report only. Read-only token, `continue-on-error`, `$GITHUB_STEP_SUMMARY` and one `::warning` per
// file: never a comment, a label, a review or a merge, and nothing reads it to block. A legitimate
// revert simply carries the report and a Reviewer decides. The script and this file are taken from
// the base commit by the workflow, so a pull request cannot weaken the check that judges it.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Marked `test` or `source` per finding, because a noisy test file must not hide a source file.
const TEST_PATH = /(^|\/)(test|tests|__tests__)\/|\.test\.[mc]?[jt]sx?$|\.spec\.[mc]?[jt]sx?$|(^|\/)fixtures\//

export function isTestPath(path) {
  return TEST_PATH.test(path)
}

// Blank lines are not evidence: every file shares them, so an intersection of blank lines would
// report a revert in any pull request that re-indents a block.
export function significant(lines) {
  return [...new Set((lines ?? []).map((line) => line.trimEnd()).filter((line) => line.trim() !== ''))]
}

// The added (`+`) or removed (`-`) side of one unified diff, without the `+++`/`---` headers.
export function diffLines(text, sign) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith(sign + sign + sign)) continue
    if (!line.startsWith(sign)) continue
    out.push(line.slice(1))
  }
  return significant(out)
}

// One file: the lines `main` added after the merge base that this pull request no longer has.
export function intersect({ path, status, addedByMain, deletedByHead }) {
  const kind = isTestPath(path) ? 'test' : 'source'
  const added = significant(addedByMain)
  if (status === 'D') {
    // A whole-file deletion is one finding with the count, not N line reports.
    return added.length ? { path, kind, whole: true, count: added.length, lines: added.slice(0, 3) } : null
  }
  if (!added.length) return null
  const wanted = new Set(added)
  const hits = significant(deletedByHead).filter((line) => wanted.has(line))
  return hits.length ? { path, kind, whole: false, count: hits.length, lines: hits.slice(0, 3) } : null
}

export function findSilentReverts({ pr, head, base, files }) {
  const findings = []
  for (const file of files ?? []) {
    const hit = intersect(file)
    if (hit) findings.push({ ...hit, from: file.from ?? null })
  }
  return { pr, head, base, scanned: (files ?? []).length, findings }
}

export function reportLines({ pr, head, base, scanned, findings }) {
  const lines = []
  for (const finding of findings) {
    const from = finding.from ? ` (from ${String(finding.from).slice(0, 7)})` : ''
    const what = finding.whole
      ? `deleted whole, ${finding.count} line(s) main added after ${base.slice(0, 7)} are gone`
      : `${finding.count} line(s) main added after ${base.slice(0, 7)} are deleted here`
    lines.push(`#${pr} @${head.slice(0, 7)}: ${finding.path}: ${what}${from}`)
  }
  const source = findings.filter((f) => f.kind === 'source').length
  const test = findings.filter((f) => f.kind === 'test').length
  lines.push(
    findings.length
      ? `silent-revert: ${findings.length} finding(s) on ${scanned} file(s) — source ${source}, test ${test}`
      // A run that prints nothing is indistinguishable from a run that never happened; #912's first
      // live run was a green tick that had read nothing.
      : `silent-revert: 0 finding(s) on ${scanned} file(s)`,
  )
  return lines
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

// `origin/main` is not a given: a `pull_request` checkout may hold the head only. Fetch the branch
// rather than trusting whatever the runner happens to have.
function haveRef(run, dir, ref) {
  const branch = ref.replace(/^origin\//, '')
  try {
    run(dir, ['rev-parse', '--verify', `${ref}^{commit}`])
  } catch {
    run(dir, ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/${ref}`])
  }
}

function parseNameStatus(text) {
  const out = []
  for (const row of String(text ?? '').split('\n')) {
    if (!row.trim()) continue
    const [status, path] = row.split('\t')
    if (!path) continue
    out.push({ status: status[0], path })
  }
  return out
}

function diffSide(run, dir, from, to, path, sign) {
  return diffLines(run(dir, ['diff', '--no-color', '--no-ext-diff', '-U0', from, to, '--', path]), sign)
}

// The commit on `main` that added the line. Only used for the message, up to three lines a file.
function introducedBy(run, dir, base, main, path, lines) {
  for (const line of lines) {
    try {
      const sha = run(dir, ['log', '--format=%H', '--reverse', `-S${line}`, `${base}..${main}`, '--', path])
        .split('\n')
        .find(Boolean)
      if (sha) return sha.trim()
    } catch {
      // A line with a leading `-` reads as an option to `git log`; the hit still stands.
      continue
    }
  }
  return null
}

export function collect({ dir = '.', main = 'origin/main', pr = null, run = git }) {
  haveRef(run, dir, main)
  const head = run(dir, ['rev-parse', 'HEAD']).trim()
  const mainSha = run(dir, ['rev-parse', `${main}^{commit}`]).trim()
  const base = run(dir, ['merge-base', main, 'HEAD']).trim()
  const files = []
  // The file list is what THIS pull request changed (base..HEAD), not what main touched since the
  // merge base. With `main..HEAD` a branch one commit behind lists files it never edited; their D
  // equals the A of main's commit, so every such branch would report a revert it did not make.
  for (const { status, path } of parseNameStatus(run(dir, ['diff', '--name-status', base, 'HEAD']))) {
    // A file this pull request adds can revert nothing, but it still counts as read: a run that
    // scans nothing must not print the same clean line as a run that read the whole pull request.
    if (status === 'A') {
      files.push({ path, status })
      continue
    }
    const addedByMain = diffSide(run, dir, base, mainSha, path, '+')
    if (!addedByMain.length) {
      files.push({ path, status })
      continue
    }
    const deletedByHead = status === 'D' ? [] : diffSide(run, dir, mainSha, head, path, '-')
    files.push({ path, status, addedByMain, deletedByHead })
  }
  const report = findSilentReverts({ pr, head, base, files })
  return {
    ...report,
    findings: report.findings.map((finding) => ({
      ...finding,
      from: introducedBy(run, dir, base, mainSha, finding.path, finding.lines),
    })),
  }
}

// `--name value` anywhere on the command line, first position included: `--repo-dir head` is the
// workflow's own call, and reading it only from position > 0 ran the check against the wrong tree.
export function parseArgs(argv = process.argv.slice(2)) {
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  return { dir: arg('--repo-dir'), pr: arg('--pr'), main: arg('--main') }
}

export function main({ env = process.env, argv = process.argv.slice(2), cwd = process.cwd() } = {}) {
  const args = parseArgs(argv)
  const dir = args.dir ?? cwd
  const pr = args.pr ?? env.PR ?? ''
  try {
    const report = collect({ dir, main: args.main ?? env.MAIN ?? 'origin/main', pr })
    const lines = reportLines(report)
    for (const finding of report.findings) {
      const [message] = lines.filter((line) => line.includes(`: ${finding.path}:`))
      process.stdout.write(`::warning file=${finding.path}::${message ?? finding.path}\n`)
    }
    process.stdout.write(lines.join('\n') + '\n')
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
    return report
  } catch (error) {
    // Shallow history, a missing ref, or no git at all: say so instead of printing a clean line.
    const text = `silent-revert: could not run (${String(error.message ?? error).split('\n')[0]})`
    process.stdout.write(text + '\n')
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text + '\n')
    process.exitCode = 1
    return null
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
