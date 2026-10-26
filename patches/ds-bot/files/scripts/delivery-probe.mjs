#!/usr/bin/env node
// The delivery board's diagnostic entry, as a shell (#1211): the same `probeGitHub()` the view's
// 诊断 button calls, print-only. It asks the five reads the board makes and prints one line each,
// so an instance that "does not come up" can be explained by pasting five lines instead of guessing
// which permission is missing. There is no second implementation here on purpose.
//
// Which repositories it reads is the host's own question (#1250, #1265), answered by the same
// `resolveRepos()` the board installs: `--repo` (repeatable), else the `origin` of `--workspace`
// (default the current folder), else the package's own `repository.url`. Every repository the board
// would read is probed under its own name and source, because a status without its repository
// cannot be acted on.
//
//   node core/scripts/delivery-probe.mjs                 # repo from cwd's git remote, token from GITHUB_TOKEN
//   node core/scripts/delivery-probe.mjs --repo o/r --token-env MY_TOKEN
//   node core/scripts/delivery-probe.mjs --repo o/r --repo acme/widget
//   node core/scripts/delivery-probe.mjs --workspace ../my-checkout
import { probeGitHub } from '../src/host/delivery-board.js'
import { NO_REPO_MESSAGE, resolveRepos } from '../src/host/delivery-repo.js'
import { repoSlug } from '../src/host/update.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1] ?? fallback
}
const allOf = (name) => {
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1] !== undefined) values.push(argv[index + 1])
  }
  return values
}

const repos = resolveRepos({
  setting: allOf('--repo'),
  workspace: argOf('--workspace', process.cwd()),
  packageSlug: repoSlug(),
})
if (repos.length === 0) {
  console.error(`delivery-probe: ${NO_REPO_MESSAGE} (pass --repo owner/name, or --workspace <folder> with a GitHub origin)`)
  process.exit(2)
}
const tokenEnv = argOf('--token-env', 'GITHUB_TOKEN')
const token = process.env[tokenEnv] ?? null
let answered = true
for (const found of repos) {
  const report = await probeGitHub({ repo: found.repo, token })
  console.log(`delivery-probe ${found.repo} · ${found.source} · ${report.at}${token === null ? ` · no ${tokenEnv}` : ''}`)
  for (const row of report.rows) {
    const status = row.status === null ? '—' : String(row.status)
    console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${status.padEnd(4)} ${row.endpoint}${row.ok ? '' : `  ${row.kind}${row.message === null ? '' : `: ${row.message}`}`}`)
  }
  console.log(report.ok ? 'all five answer' : 'one or more of the five is refused; the FAIL line names which')
  answered = answered && report.ok
}
process.exit(answered ? 0 : 1)
