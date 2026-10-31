// Experience library (#874 Step 2). Offline lessons keyed by repository and tech
// stack. Agents and HarnessPro read them. A lesson changes only when a file in
// core/dev/experience/ is committed. This module does not call a model and does
// not edit Lite, Medium, or Heavy.
//
// The published npm package does not ship core/dev/. When that directory is
// absent, a read with the default root returns no entries so loading the host
// does not depend on dev data. An explicit root that is missing throws.

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codePoints } from './text.js'

export const DEFAULT_EXPERIENCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../dev/experience')

const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const STACK_ID = /^[a-z0-9][a-z0-9-]*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const REF = /^#[1-9]\d{0,6}$/
const TEXT_MAX = 600
const ENTRY_KEYS = new Set(['id', 'repo', 'techStacks', 'date', 'seen', 'trigger', 'wrong', 'right', 'refs'])
const TOP_FILES = new Set(['README.md', 'check.mjs'])

function isRepoSegment(value) {
  return typeof value === 'string' && REPO_SEGMENT.test(value)
}

function parseRepo(repo) {
  if (typeof repo !== 'string') throw new Error(`bad repo: ${repo}`)
  const parts = repo.split('/')
  if (parts.length !== 2 || !isRepoSegment(parts[0]) || !isRepoSegment(parts[1])) throw new Error(`bad repo: ${repo}`)
  return parts
}

function parseStack(techStack) {
  if (typeof techStack !== 'string' || !STACK_ID.test(techStack)) throw new Error(`bad techStack: ${techStack}`)
  return techStack
}

function scoped(root, ...parts) {
  const base = resolve(root)
  const full = resolve(base, ...parts)
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`experience path escapes root: ${full}`)
  return full
}

function validDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function secretAt(value, path) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = secretAt(value[index], `${path}[${index}]`)
      if (found) return found
    }
    return ''
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const here = path === '' ? key : `${path}.${key}`
      if (/api[_-]?key/i.test(key) || /^(token|secret|password|authorization)$/i.test(key)) return here
      const found = secretAt(child, here)
      if (found) return found
    }
    return ''
  }
  if (typeof value === 'string' && (/\bsk-[A-Za-z0-9]{8,}\b/.test(value) || value.includes('DEEPSEEK_API_KEY') || value.includes('GITHUB_TOKEN'))) {
    return path === '' ? 'value' : path
  }
  return ''
}

function validateEntry(entry, expected) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('entry')
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) throw new Error(`unknown field ${key}`)
  }
  if (typeof entry.id !== 'string' || !STACK_ID.test(entry.id) || entry.id !== expected.id) throw new Error('id')
  if (expected.kind === 'repo') {
    if (entry.repo !== expected.repo) throw new Error('repo')
  } else if (entry.repo !== null) throw new Error('repo')
  if (!Array.isArray(entry.techStacks)) throw new Error('techStacks')
  for (const name of entry.techStacks) {
    if (typeof name !== 'string' || !STACK_ID.test(name)) throw new Error('techStacks')
  }
  if (new Set(entry.techStacks).size !== entry.techStacks.length) throw new Error('techStacks')
  if (expected.kind === 'stack' && (entry.techStacks.length !== 1 || entry.techStacks[0] !== expected.techStack)) {
    throw new Error('techStacks')
  }
  if (!validDate(entry.date)) throw new Error('date')
  if (entry.seen !== undefined && (!Number.isInteger(entry.seen) || entry.seen < 1)) throw new Error('seen')
  for (const key of ['trigger', 'wrong', 'right']) {
    const text = entry[key]
    // #1899: a code point costs one whatever its UTF-16 width, so 600 emoji fill 600.
    if (typeof text !== 'string' || text.trim() === '' || codePoints(text) > TEXT_MAX) throw new Error(key)
  }
  if (entry.refs !== undefined) {
    if (!Array.isArray(entry.refs) || entry.refs.length > 20 || entry.refs.some(ref => typeof ref !== 'string' || !REF.test(ref))) {
      throw new Error('refs')
    }
  }
  const secret = secretAt(entry, '')
  if (secret) throw new Error(`secret at ${secret}`)
  const clean = {
    id: entry.id,
    repo: entry.repo,
    techStacks: [...entry.techStacks],
    date: entry.date,
  }
  if (entry.seen !== undefined) clean.seen = entry.seen
  clean.trigger = entry.trigger
  clean.wrong = entry.wrong
  clean.right = entry.right
  if (entry.refs !== undefined) clean.refs = [...entry.refs]
  return clean
}

function readValidated(file, expected) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file}: json: ${error.message}`)
  }
  try {
    return validateEntry(raw, expected)
  } catch (error) {
    throw new Error(`${file}: ${error.message}`)
  }
}

function loadDir(dir, expectedFor) {
  if (!existsSync(dir)) return []
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir}: not a directory`)
  const entries = []
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, dirent.name)
    if (dirent.isSymbolicLink() || !dirent.isFile() || !dirent.name.endsWith('.json')) {
      throw new Error(`${file}: unexpected file`)
    }
    const id = dirent.name.slice(0, -'.json'.length)
    if (!STACK_ID.test(id)) throw new Error(`${file}: id`)
    entries.push(readValidated(file, expectedFor(id)))
  }
  return entries
}

function matches(entry, needle) {
  return [entry.id, entry.trigger, entry.wrong, entry.right].some(text => text.toLowerCase().includes(needle))
}

function byDateThenId(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

export function lookupExperience({ repo, techStack, query, root } = {}) {
  const explicitRoot = root !== undefined
  const base = explicitRoot ? root : DEFAULT_EXPERIENCE_ROOT
  if (typeof base !== 'string' || base.trim() === '') throw new Error('bad root')
  const askedRepo = repo !== undefined && repo !== null
  const askedStack = techStack !== undefined && techStack !== null
  if (!existsSync(base)) {
    if (!explicitRoot) return { entries: [] }
    throw new Error(`experience root missing: ${base}`)
  }
  if (!askedRepo && !askedStack) return { entries: [] }
  let owner
  let name
  let stack
  if (askedRepo) [owner, name] = parseRepo(repo)
  if (askedStack) stack = parseStack(techStack)
  const entries = []
  if (askedRepo) {
    const loaded = loadDir(scoped(base, 'repos', owner, name), id => ({ kind: 'repo', id, repo }))
    entries.push(...(askedStack ? loaded.filter(item => item.techStacks.includes(stack)) : loaded))
  }
  if (askedStack) {
    entries.push(...loadDir(scoped(base, 'stacks', stack), id => ({ kind: 'stack', id, techStack: stack })))
  }
  if (query !== undefined && query !== null && typeof query !== 'string') throw new Error('bad query')
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const filtered = needle === '' ? entries : entries.filter(item => matches(item, needle))
  filtered.sort(byDateThenId)
  return { entries: filtered }
}

function rejectDirent(dirent, label, { directory }) {
  if (dirent.isSymbolicLink()) return `symlink ${label}`
  if (directory && !dirent.isDirectory()) return `unexpected ${label}`
  if (!directory && !dirent.isFile()) return `unexpected ${label}`
  return ''
}

function checkJsonDir(dir, expectedFor) {
  const failures = []
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const label = join(dir, dirent.name)
    const problem = rejectDirent(dirent, label, { directory: false })
    if (problem || !dirent.name.endsWith('.json')) {
      failures.push(problem || `unexpected ${label}`)
      continue
    }
    const id = dirent.name.slice(0, -'.json'.length)
    if (!STACK_ID.test(id)) {
      failures.push(`${label}: id`)
      continue
    }
    try {
      readValidated(label, expectedFor(id))
    } catch (error) {
      failures.push(error.message)
    }
  }
  return failures
}

function checkRepos(root) {
  const failures = []
  const repos = scoped(root, 'repos')
  for (const owner of readdirSync(repos, { withFileTypes: true })) {
    const ownerLabel = `repos/${owner.name}`
    const ownerProblem = rejectDirent(owner, ownerLabel, { directory: true })
    if (ownerProblem || !isRepoSegment(owner.name)) {
      failures.push(ownerProblem || `unexpected ${ownerLabel}`)
      continue
    }
    for (const name of readdirSync(join(repos, owner.name), { withFileTypes: true })) {
      const nameLabel = `${ownerLabel}/${name.name}`
      const nameProblem = rejectDirent(name, nameLabel, { directory: true })
      if (nameProblem || !isRepoSegment(name.name)) {
        failures.push(nameProblem || `unexpected ${nameLabel}`)
        continue
      }
      const repo = `${owner.name}/${name.name}`
      failures.push(...checkJsonDir(join(repos, owner.name, name.name), id => ({ kind: 'repo', id, repo })))
    }
  }
  return failures
}

function checkStacks(root) {
  const failures = []
  const stacks = scoped(root, 'stacks')
  for (const stack of readdirSync(stacks, { withFileTypes: true })) {
    const label = `stacks/${stack.name}`
    const problem = rejectDirent(stack, label, { directory: true })
    if (problem || !STACK_ID.test(stack.name)) {
      failures.push(problem || `unexpected ${label}`)
      continue
    }
    failures.push(...checkJsonDir(join(stacks, stack.name), id => ({ kind: 'stack', id, techStack: stack.name })))
  }
  return failures
}

export function checkExperience(root) {
  if (typeof root !== 'string' || root.trim() === '') return { ok: false, failures: ['bad root'] }
  if (!existsSync(root)) return { ok: false, failures: [`missing root ${root}`] }
  let top
  try {
    top = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    return { ok: false, failures: [error.message] }
  }
  const failures = []
  for (const dirent of top) {
    if (dirent.isSymbolicLink()) {
      failures.push(`symlink ${dirent.name}`)
      continue
    }
    if (TOP_FILES.has(dirent.name)) {
      if (!dirent.isFile()) failures.push(`unexpected ${dirent.name}`)
      continue
    }
    if (dirent.name === 'repos' || dirent.name === 'stacks') {
      if (!dirent.isDirectory()) failures.push(`unexpected ${dirent.name}`)
      continue
    }
    failures.push(`unexpected ${dirent.name}`)
  }
  if (top.some(dirent => dirent.name === 'repos' && dirent.isDirectory() && !dirent.isSymbolicLink())) {
    failures.push(...checkRepos(root))
  }
  if (top.some(dirent => dirent.name === 'stacks' && dirent.isDirectory() && !dirent.isSymbolicLink())) {
    failures.push(...checkStacks(root))
  }
  return { ok: failures.length === 0, failures }
}

export function prepareExperienceEntry(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('bad entry')
  for (const key of Object.keys(fields)) {
    if (!ENTRY_KEYS.has(key)) throw new Error(`unknown field ${key}`)
  }
  const repo = fields.repo === undefined ? null : fields.repo
  const techStacks = fields.techStacks === undefined ? [] : fields.techStacks
  const draft = {
    id: fields.id,
    repo,
    techStacks,
    date: fields.date,
  }
  if (fields.seen !== undefined) draft.seen = fields.seen
  draft.trigger = fields.trigger
  draft.wrong = fields.wrong
  draft.right = fields.right
  if (fields.refs !== undefined) draft.refs = fields.refs
  if (typeof repo === 'string') parseRepo(repo)
  const expected = repo === null
    ? { kind: 'stack', id: fields.id, techStack: Array.isArray(techStacks) ? techStacks[0] : undefined }
    : { kind: 'repo', id: fields.id, repo }
  const entry = validateEntry(draft, expected)
  const relativePath = entry.repo === null
    ? join('stacks', entry.techStacks[0], `${entry.id}.json`)
    : join('repos', ...parseRepo(entry.repo), `${entry.id}.json`)
  return { relativePath, entry, body: `${JSON.stringify(entry, null, 2)}\n` }
}
