#!/usr/bin/env node
// The delivery board's diagnostic entry, as a shell (#1211): the same `probeGitHub()` the view's
// 诊断 button calls, print-only. It asks the five reads the board makes and prints one line each,
// so an instance that "does not come up" can be explained by pasting five lines instead of guessing
// which permission is missing. There is no second implementation here on purpose.
//
// Which repository it reads is the host's own question (#1250), answered by the same
// `resolveRepo()` the board installs: `--repo`, else the `origin` of `--workspace` (default the
// current folder), else the package's own `repository.url`.
//
//   node core/scripts/delivery-probe.mjs                 # repo from cwd's git remote, token from GITHUB_TOKEN
//   node core/scripts/delivery-probe.mjs --repo o/r --token-env MY_TOKEN
//   node core/scripts/delivery-probe.mjs --workspace ../my-checkout
import { probeGitHub } from '../src/host/delivery-board.js'
import { NO_REPO_MESSAGE, resolveRepo } from '../src/host/delivery-repo.js'
import { repoSlug } from '../src/host/update.js'

const argv = process.argv.slice(2)
const argOf = (name, fallback = null) => {
  const index = argv.indexOf(name)
  return index === -1 ? fallback : argv[index + 1] ?? fallback
}

const found = resolveRepo({
  setting: argOf('--repo'),
  workspace: argOf('--workspace', process.cwd()),
  packageSlug: repoSlug(),
})
if (found.repo === null) {
  console.error(`delivery-probe: ${NO_REPO_MESSAGE} (pass --repo owner/name, or --workspace <folder> with a GitHub origin)`)
  process.exit(2)
}
const repo = found.repo
const tokenEnv = argOf('--token-env', 'GITHUB_TOKEN')
const token = process.env[tokenEnv] ?? null
const report = await probeGitHub({ repo, token })

console.log(`delivery-probe ${repo} · ${found.source} · ${report.at}${token === null ? ` · no ${tokenEnv}` : ''}`)
for (const row of report.rows) {
  const status = row.status === null ? '—' : String(row.status)
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${status.padEnd(4)} ${row.endpoint}${row.ok ? '' : `  ${row.kind}${row.message === null ? '' : `: ${row.message}`}`}`)
}
console.log(report.ok ? 'all five answer' : 'one or more of the five is refused; the FAIL line names which')
process.exit(report.ok ? 0 : 1)
