// A reader over the Project State files a Bot already works from (#1702): `PROJECT.md`,
// `ROADMAP.md`, `docs/governance.md`, `decisions/*.md` and `LESSONS.md` in the Session's
// working folder. Listing each one with a sha256 content hash is what lets a caller say
// "I read decisions/x.md at hash abc1234" and notice a stale copy, instead of reading the
// files with `cat` and assuming the copy it has is the one on `main`.
//
// The reader is a tool a Bot calls. Nothing here runs at install time, reads a prompt or
// writes a context: the answer is the whole effect. A folder with no repository, a missing
// file and a file too large to hand over each answer with the reason, never with an empty
// string that would read as an empty document.
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from './tool-schema.js'
import { output } from './tools.js'

// The files this reader answers for, and nothing else: a named file outside this list is
// refused rather than read, so the tool never becomes a way to walk the working folder.
export const PROJECT_STATE_PATHS = ['PROJECT.md', 'ROADMAP.md', 'docs/governance.md', 'LESSONS.md']
export const DECISIONS_DIR = 'decisions'
// One file handed over whole, bounded: a reader that copies a megabyte into a turn spends
// the context it was meant to save. Over the bound the answer is the size, not the text.
export const MAX_BYTES = 200_000

const isDecisionPath = path => /^decisions\/[^/]+\.md$/.test(path)
const allowed = path => PROJECT_STATE_PATHS.includes(path) || isDecisionPath(path)
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function repositoryAt(dir) {
  try {
    const info = await stat(join(dir, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

async function decisionFiles(dir) {
  let entries
  try {
    entries = await readdir(join(dir, DECISIONS_DIR), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => `${DECISIONS_DIR}/${entry.name}`)
    .sort()
}

async function describe(dir, path) {
  const bytes = await readFile(join(dir, path))
  const info = await stat(join(dir, path))
  return { path, bytes: bytes.length, sha256: sha256(bytes), mtime: new Date(info.mtimeMs).toISOString() }
}

// Every Project State file in `dir` with its byte size, content hash and last-modified time.
// A file that is absent from the folder is left out rather than reported as empty; the
// decisions folder is read one level deep and only for `*.md`.
//
// The repository gate belongs to the tool, not to every reader (#1809): a decision file is the
// board's own artifact and shows up in a folder that is not a repository, while `project_state`
// keeps refusing such a folder by default. Only the board passes `{ repository: false }`.
export async function listProjectState(dir, { repository = true } = {}) {
  if (repository && !await repositoryAt(dir)) return { ok: false, reason: `not a repository: ${dir}` }
  const found = []
  for (const path of PROJECT_STATE_PATHS) {
    try {
      found.push(await describe(dir, path))
    } catch { /* an absent Project State file is simply not listed */ }
  }
  for (const path of await decisionFiles(dir)) {
    try {
      found.push(await describe(dir, path))
    } catch { /* a file that vanished between readdir and read is not listed */ }
  }
  return { ok: true, dir, files: found }
}

// The bytes of one named Project State file, bounded at `MAX_BYTES`. The path is checked
// against the list first, so `..`, an absolute path or any other file answers `not listed`.
export async function readProjectState(dir, file) {
  const path = String(file ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '')
  if (path === '') return { ok: false, reason: 'absent: no file named' }
  if (path.startsWith('/') || path.split('/').includes('..') || !allowed(path)) {
    return { ok: false, reason: `not listed: ${path} is not a Project State file` }
  }
  if (!await repositoryAt(dir)) return { ok: false, reason: `not a repository: ${dir}` }
  let info
  try {
    info = await stat(join(dir, path))
  } catch {
    return { ok: false, reason: `absent: ${path}` }
  }
  if (!info.isFile()) return { ok: false, reason: `absent: ${path}` }
  if (info.size > MAX_BYTES) return { ok: false, reason: `too large: ${path} is ${info.size} bytes (bound ${MAX_BYTES})` }
  const bytes = await readFile(join(dir, path))
  return { ok: true, path, bytes: bytes.length, sha256: sha256(bytes), mtime: new Date(info.mtimeMs).toISOString(), text: bytes.toString('utf8') }
}

// The Session's working folder: the cwd its Agent runs in, else the folder the Bot or room
// is set to work in, else the team workspace. Undefined only when none of them is known.
export function workDirFor(rt, exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') return cwd
  const botId = rt.selfOf?.(exec?.agent?.id) ?? exec?.agent?.id
  const dir = rt.workDirOf?.({ botId, roomId: exec?.agent?.session?.header?.roomId })
  if (typeof dir === 'string' && dir !== '') return dir
  return rt.teamFolder?.()
}

const listed = ({ files }) => files.length === 0
  ? 'project state: no Project State files in this folder'
  : ['project state:', ...files.map(file => `${file.path}\t${file.bytes} bytes\tsha256:${file.sha256}\t${file.mtime}`)].join('\n')

export function install(rt) {
  rt.ctx.tools.register(defineTool({
    name: 'project_state',
    description: 'Read the Project State files of your working folder: PROJECT.md, ROADMAP.md, docs/governance.md, decisions/*.md, LESSONS.md. Without `file` it lists each with its byte size, sha256 content hash and last-modified time, so you can compare the hash with the copy you already have. With `file` it returns that one file, bounded. Answers `absent`, `too large` or `not a repository` with the reason instead of an empty document.',
    parameters: {
      file: { type: 'string', description: 'Optional Project State path to read, e.g. decisions/x.md; omit to list them all' },
    },
    output,
    async execute(args, exec) {
      const dir = workDirFor(rt, exec)
      if (dir === undefined) return 'not a repository: the Session has no working folder'
      if (args?.file === undefined || args.file === '') {
        const listedFiles = await listProjectState(dir)
        return listedFiles.ok ? listed(listedFiles) : listedFiles.reason
      }
      const read = await readProjectState(dir, args.file)
      return read.ok ? read.text : read.reason
    },
  }))
}
