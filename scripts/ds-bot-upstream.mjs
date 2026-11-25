#!/usr/bin/env node
// FlyBot tracks upstream DS Bot (github.com/Fei2411/DS-Bot, Apache-2.0) as a pinned,
// byte-identical vendor tree under runtime/ds-bot-upstream/. This script keeps the tree and
// its pin (runtime/ds-bot-upstream.pin.json) in step. No dependencies; needs git and Node 22+.
//
//   node scripts/ds-bot-upstream.mjs check
//       Fails unless every pinned path under runtime/ds-bot-upstream/ has exactly the git
//       object id the pin records (trees for directories, blobs for files), and nothing else
//       sits in that directory except the files FlyBot owns (OWNED below). Reads the git
//       index, so it checks what would be committed.
//   node scripts/ds-bot-upstream.mjs latest [--json]
//       Prints the newest upstream release tag (vX.Y.Z, no pre-releases) and its commit, from
//       `git ls-remote --tags`. Exit code 0; with --json also says whether it differs from the pin.
//   node scripts/ds-bot-upstream.mjs sync <tag|commit>
//       Fetches that upstream commit's objects (depth 1, no upstream history enters ours), replaces
//       every pinned path with the upstream tree/blob exactly (`git read-tree --prefix`), stages
//       it, and rewrites the pin. Does not commit.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PIN_PATH = join(ROOT, 'runtime', 'ds-bot-upstream.pin.json')
const VENDOR = 'runtime/ds-bot-upstream'
const UPSTREAM_URL = 'https://github.com/Fei2411/DS-Bot.git'
// What FlyBot takes from upstream, as upstream paths. Directories are taken whole so the
// tree id proves the copy; files one by one.
//   ds-bot/  the DSH plugin package itself (runtime, its tests, test harness pin, mock LLM)
//   link/    the shared phone-link code: ds-bot's tests import it and ds-bot/link.js is built
//            from it (the phone feature itself is not an FlyBot target, see UPSTREAM.md)
//   app/ui/src and app/package.json  desktop source and its module scope read by the Bot frontend tests
//   mobile/src/team/gated.ts and start.ps1  inputs read by the phone and Windows launcher tests
//   docker/  the image build, entrypoint, DSH web patch, and the startup smoke test
//   LICENSE, NOTICE  Apache-2.0 text and upstream NOTICE; both must travel with the code
const PATHS = [
  'ds-bot', 'link', 'app/package.json', 'app/ui/src', 'mobile/src/team/gated.ts', 'start.ps1',
  'docker/Dockerfile', 'docker/entrypoint.sh', 'docker/docker.patch.yml', 'docker/test.mjs',
  'LICENSE', 'NOTICE',
]
// Files in runtime/ds-bot-upstream/ that are FlyBot's own, not upstream's.
const OWNED = new Set(['UPSTREAM.md'])

const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, ...opts }).trim()
const repositoryPrefix = () => git(['rev-parse', '--show-prefix'])
const fail = (message) => { console.error(`ds-bot-upstream: ${message}`); process.exit(1) }
const readPin = () => JSON.parse(readFileSync(PIN_PATH, 'utf8'))

// The id git would give each pinned path as staged: a directory's tree via write-tree --prefix,
// a file's blob from the index.
function stagedIds() {
  const ids = {}
  const prefix = repositoryPrefix()
  for (const path of PATHS) {
    const full = `${VENDOR}/${path}`
    const entry = git(['ls-files', '-s', '--', full]).split('\n').filter(Boolean)
    if (entry.length === 0) { ids[path] = null; continue }
    const exact = entry.find(line => line.split('\t')[1] === full)
    if (exact !== undefined) {
      const [mode, id] = exact.split(/\s+/)
      ids[path] = { type: 'blob', id, mode }
    } else {
      ids[path] = { type: 'tree', id: git(['write-tree', `--prefix=${prefix}${full}/`]), mode: '040000' }
    }
  }
  return ids
}

function check() {
  const pin = readPin()
  const problems = []
  for (const key of ['repo', 'commit', 'version', 'paths']) if (pin[key] === undefined) problems.push(`pin has no ${key}`)
  const staged = stagedIds()
  for (const path of PATHS) {
    const want = pin.paths?.[path]
    const have = staged[path]
    if (want === undefined) problems.push(`pin does not list ${path}`)
    else if (have === null) problems.push(`${VENDOR}/${path} is missing`)
    else if (have.id !== want.id || have.type !== want.type || have.mode !== want.mode) problems.push(`${VENDOR}/${path} is ${have.type} ${have.id} (${have.mode}), the pin says ${want.type} ${want.id} (${want.mode}) from ${pin.repo}@${pin.commit.slice(0, 7)}. Do not edit the vendor tree; change the overlay, or run sync.`)
  }
  for (const path of Object.keys(pin.paths ?? {})) if (!PATHS.includes(path)) problems.push(`pin lists ${path}, which this script does not vendor`)
  // Nothing else may sit in the vendor directory: an extra file would ship without a pin.
  const tracked = git(['ls-files', '--', VENDOR]).split('\n').filter(Boolean)
  for (const file of tracked) {
    const rel = file.slice(VENDOR.length + 1)
    if (OWNED.has(rel)) continue
    if (!PATHS.some(path => rel === path || rel.startsWith(`${path}/`))) problems.push(`${file} is not an upstream path in the pin`)
  }
  for (const own of OWNED) if (!tracked.includes(`${VENDOR}/${own}`)) problems.push(`${VENDOR}/${own} is missing`)
  if (problems.length > 0) fail(`${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`)
  console.log(`ds-bot-upstream: ok (${pin.repo}@${pin.commit.slice(0, 12)}, ds-bot ${pin.version}${pin.tag ? `, ${pin.tag}` : ''}; ${PATHS.length} paths)`)
}

const semver = tag => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number)
function latestRelease() {
  const lines = execFileSync('git', ['ls-remote', '--tags', UPSTREAM_URL], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n')
  const tags = new Map()
  for (const line of lines) {
    const [sha, ref] = line.split('\t')
    const match = /^refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(ref ?? '')
    if (!match) continue
    // An annotated tag lists its peeled commit with ^{}; prefer that.
    if (match[2] || !tags.has(match[1])) tags.set(match[1], sha)
  }
  const sorted = [...tags.keys()].sort((a, b) => {
    const x = semver(a); const y = semver(b)
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  })
  if (sorted.length === 0) fail('no vX.Y.Z tag upstream')
  const tag = sorted.at(-1)
  return { tag, commit: tags.get(tag) }
}

function latest(json) {
  const found = latestRelease()
  const pin = readPin()
  const out = { ...found, pinned: pin.commit, pinnedTag: pin.tag ?? null, newer: found.commit !== pin.commit }
  if (json) console.log(JSON.stringify(out))
  else console.log(`${found.tag} ${found.commit}${out.newer ? ` (pin is ${pin.tag ?? pin.commit.slice(0, 12)})` : ' (pinned)'}`)
}

function sync(ref) {
  if (!ref) fail('sync needs a tag or commit')
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) fail(`not a tag or commit: ${ref}`)
  if (git(['status', '--porcelain', '--', VENDOR, 'runtime/ds-bot-upstream.pin.json']) !== '') fail(`${VENDOR} has uncommitted changes; commit or discard them first`)
  const isSha = /^[0-9a-f]{40}$/.test(ref)
  git(['fetch', '--depth=1', '--no-tags', UPSTREAM_URL, isSha ? ref : `refs/tags/${ref}`], { stdio: ['ignore', 'pipe', 'inherit'] })
  const commit = git(['rev-parse', 'FETCH_HEAD^{commit}'])
  const paths = {}
  for (const path of PATHS) {
    const line = git(['ls-tree', commit, '--', path])
    if (line === '') fail(`upstream ${commit.slice(0, 12)} has no ${path}`)
    const [mode, type, id] = line.split(/\s+/)
    paths[path] = { type, id, mode }
  }
  const prefix = repositoryPrefix()
  for (const path of PATHS) {
    const full = `${VENDOR}/${path}`
    git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', full])
    rmSync(join(ROOT, full), { recursive: true, force: true })
    const { type, id, mode } = paths[path]
    if (type === 'tree') git(['read-tree', `--prefix=${prefix}${full}/`, '-u', id])
    else {
      mkdirSync(dirname(join(ROOT, full)), { recursive: true })
      writeFileSync(join(ROOT, full), execFileSync('git', ['cat-file', 'blob', id], { cwd: ROOT, maxBuffer: 1 << 28 }), { mode: mode === '100755' ? 0o755 : 0o644 })
      git(['update-index', '--add', '--cacheinfo', `${mode},${id},${prefix}${full}`])
    }
  }
  const version = JSON.parse(execFileSync('git', ['cat-file', 'blob', `${commit}:ds-bot/package.json`], { cwd: ROOT, encoding: 'utf8' })).version
  const harness = JSON.parse(execFileSync('git', ['cat-file', 'blob', `${commit}:ds-bot/dev/harness/package.json`], { cwd: ROOT, encoding: 'utf8' })).dependencies ?? {}
  const date = git(['log', '-1', '--format=%cI', commit])
  const tag = isSha ? (readPin().commit === commit ? readPin().tag : undefined) : ref
  const pin = {
    repo: 'Fei2411/DS-Bot',
    url: 'https://github.com/Fei2411/DS-Bot',
    license: 'Apache-2.0',
    ...(tag ? { tag } : {}),
    commit,
    committed: date,
    version,
    dsh: harness['@deepseek-ai/dsh'] ?? null,
    note: `${VENDOR}/<path> is byte-identical to upstream <commit>:<path> (git object ids below). Never edit it; FlyBot changes live outside it (see ${VENDOR}/UPSTREAM.md). Update with: node scripts/ds-bot-upstream.mjs sync <tag>`,
    paths,
  }
  writeFileSync(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`)
  git(['add', '--', relative(ROOT, PIN_PATH)])
  console.log(`ds-bot-upstream: synced to ${pin.repo}@${commit.slice(0, 12)} (ds-bot ${version}${tag ? `, ${tag}` : ''}, DSH ${pin.dsh}); staged, not committed`)
}

const [command, arg] = process.argv.slice(2)
if (command === 'check') check()
else if (command === 'latest') latest(arg === '--json')
else if (command === 'sync') sync(arg)
else fail('usage: ds-bot-upstream.mjs check | latest [--json] | sync <tag|commit>')
