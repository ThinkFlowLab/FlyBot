// Which repositories the delivery board reads, and where each name came from (#1250, #1265).
//
// The board used to read the shipped package's `repository.url` and present it as a fact, so an
// instance set up on another fork showed this project's numbers and said nothing about whose they
// were. Since #1265 step 4 an instance may work in more than one repository, and each one is
// resolved on its own so no two of them share a source line. The same three steps, first answer
// wins, for every name:
//
//   1. the instance setting, `delivery.repos` (a list) or `delivery.repo` (one name, the older
//      spelling, read as a list of one) on the plugin entry — the host hands the entry through
//      verbatim, so all the spellings people write are read (`instanceRepoSettings`);
//   2. the workspace's own git remote — `<teamFolder>/.git/config`, `[remote "origin"] url`;
//   3. the package's `repository.url`, which is a default and is labelled as one.
//
// Nothing is spawned: the host may run where `git` is not on PATH. A `.git` that is a file is
// followed through its `gitdir:` pointer: a submodule keeps `config` there, and a linked worktree
// keeps only a `commondir` pointer to the shared directory that does (#1258). A name is normalised
// to `owner/name`; a GitHub URL or the scp form `git@github.com:owner/name.git` is accepted where a
// name is, because that is what people paste.
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The wording acceptance criterion 4 asks for, in one place so the view, the host and the CLI agree.
export const NO_REPO_MESSAGE = 'no repository — set delivery.repo'

// A segment is a plain repository name part: word characters, dots and dashes, but never a leading
// dot. `.` and `..` are path steps, not names, and a board that accepted them would build
// `/repos/../../issues` and normalise it to the API root (#1258).
const OWNER_NAME = /^(?!\.)[\w.-]+\/(?!\.)[\w.-]+$/
const SCP_GITHUB = /^(?:[\w.-]+@)?github\.com:([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i

const cleanName = text => {
  const trimmed = String(text ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  return OWNER_NAME.test(trimmed) ? trimmed : null
}

// `owner/name` out of whatever form the value arrived in; null when it is not a GitHub repository
// name. A URL on another host is refused rather than mined for its last two segments.
export function parseRepoName(value) {
  const text = String(value ?? '').trim()
  if (text === '') return null
  const scp = SCP_GITHUB.exec(text)
  if (scp) return cleanName(scp[1])
  if (/^[a-z][\w+.-]*:\/\//i.test(text)) {
    let url
    try { url = new URL(text) } catch { return null }
    if (url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    return parts.length === 2 ? cleanName(parts.join('/')) : null
  }
  return cleanName(text)
}

// The `[remote "origin"] url` out of git's own config text; null when that remote or its url is
// absent. Other remotes are ignored on purpose: one host shows one repository, and a union of
// disagreeing remotes would be a guess dressed as a fact.
export function originUrlIn(text) {
  let section = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const header = /^\[(.+)\]$/.exec(trimmed)
    if (header) { section = header[1].trim(); continue }
    if (section === null || !/^remote\s+"origin"$/i.test(section)) continue
    const value = /^url\s*=\s*(.+)$/i.exec(trimmed)
    if (value) return value[1].trim()
  }
  return null
}

// Where git keeps the config for this folder: `.git/config`, or whatever a `.git` file's `gitdir:`
// pointer leads to. A submodule keeps `config` in that directory; a linked worktree keeps only a
// `commondir` file naming the shared directory that has it (#1258). Null when the folder is not a
// git checkout at all.
export function gitConfigPath(folder) {
  if (typeof folder !== 'string' || folder === '') return null
  const dot = join(folder, '.git')
  try {
    if (statSync(dot).isDirectory()) return join(dot, 'config')
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, 'utf8'))
    if (!pointer) return null
    const gitdir = resolve(folder, pointer[1].trim())
    const own = join(gitdir, 'config')
    if (isFile(own)) return own
    const common = commonDirOf(gitdir)
    return common === null ? null : join(common, 'config')
  } catch { return null }
}

const isFile = path => {
  try { return statSync(path).isFile() } catch { return false }
}

// A linked worktree's gitdir holds no config: `commondir` names the common directory, relative to
// the gitdir, where the shared `config` lives.
const commonDirOf = gitdir => {
  try {
    const pointer = readFileSync(join(gitdir, 'commondir'), 'utf8').trim()
    return pointer === '' ? null : resolve(gitdir, pointer)
  } catch { return null }
}

// The instance setting as the profile actually wrote it. The host passes the plugin entry through
// verbatim and expands no dotted key, so one setting reaches us as a flat `deliveryRepo`, a literal
// `'delivery.repo'`, or a nested `delivery.repo` — the hint, the page and the docs all say the last
// spelling, and reading only the first would ignore what a user just wrote (#1258). First defined
// answer wins; validation stays in `parseRepoName`.
export function instanceRepoSetting(config) {
  if (config === null || typeof config !== 'object') return null
  for (const value of [config.delivery?.repo, config['delivery.repo'], config.deliveryRepo]) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

// The same setting as a list (#1265 step 4). `delivery.repos` is the new shape and is read first;
// the three older spellings each describe one repository, so a profile written before this change
// keeps working as a list of one. An empty list is "nothing written", not "show nothing": the
// next level still answers, which is what a person who cleared the field expects.
export function instanceRepoSettings(config) {
  if (config === null || typeof config !== 'object') return []
  for (const value of [config.delivery?.repos, config['delivery.repos'], config.deliveryRepos]) {
    if (value === undefined || value === null || value === '') continue
    const list = Array.isArray(value) ? value : [value]
    const kept = list.map(entry => String(entry ?? '').trim()).filter(entry => entry !== '')
    if (kept.length > 0) return kept
  }
  const single = instanceRepoSetting(config)
  return single === null ? [] : [single]
}

// The `owner/name` the folder's `origin` names, read from disk without running git.
export function gitOriginRepo(folder) {
  const path = gitConfigPath(folder)
  if (path === null) return null
  try { return parseRepoName(originUrlIn(readFileSync(path, 'utf8'))) } catch { return null }
}

// Every repository the board reads, each with its own source (#1265 step 4). The levels answer
// once: the first level that yields a name yields the whole list, because a list from `config`
// replaces the inferred one rather than adding to it — a workspace remote and a setting are two
// answers to one question, not two repositories. Duplicates are one repository, so a name written
// twice (as a URL and as `owner/name`) cannot draw two blocks of the same board.
export function resolveRepos({ setting = null, workspace = null, packageSlug = null } = {}) {
  const raw = Array.isArray(setting) ? setting : (setting === null || setting === undefined || setting === '' ? [] : [setting])
  const configured = []
  for (const value of raw) {
    const name = parseRepoName(value)
    if (name !== null && !configured.some(entry => entry.repo === name)) configured.push({ repo: name, source: 'config' })
  }
  if (configured.length > 0) return configured
  const remote = gitOriginRepo(workspace)
  if (remote !== null) return [{ repo: remote, source: 'remote' }]
  const packaged = parseRepoName(packageSlug)
  if (packaged !== null) return [{ repo: packaged, source: 'package' }]
  return []
}

// The first answer, for a caller that asks about one repository (`core/scripts/delivery-probe.mjs`
// used to; it now asks for the list). An empty answer is the same shape it always had.
export function resolveRepo(options = {}) {
  return resolveRepos(options)[0] ?? { repo: null, source: null }
}
