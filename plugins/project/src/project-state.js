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
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defineTool, dirKind, output, workDirFor } from './host.js'

// The files this reader answers for, and nothing else: a named file outside this list is
// refused rather than read, so the tool never becomes a way to walk the working folder.
export const PROJECT_STATE_PATHS = ['PROJECT.md', 'ROADMAP.md', 'docs/governance.md', 'LESSONS.md']
export const DECISIONS_DIR = 'decisions'
// One file handed over whole, bounded: a reader that copies a megabyte into a turn spends
// the context it was meant to save. Over the bound the answer is the size, not the text.
export const MAX_BYTES = 200_000

// The one name shape a decision has: exactly one segment under `decisions/`, ending in `.md`.
// The lister, the reader and the board all take a name only when it matches this.
export const isDecisionPath = path => /^decisions\/[^/]+\.md$/.test(path)
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
  // #2055: `decisions` itself must be a real directory here. `readdir` follows a link, so a
  // Project whose `decisions` points at another folder listed that folder's files as its own; a
  // link, a plain file or a missing entry is "no decisions", the answer an absent folder gives.
  if (await dirKind(join(dir, DECISIONS_DIR)) !== 'real') return []
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

// One file sitting directly in the folder, never through a link. `readdir` already reports a
// symlink as "not a plain file", and reading a name — here, in the reader, and on the board —
// answers the same way: a symlink is an absent file, not its target. The `lstat` is what makes
// that one rule hold for a name that was never listed, a name from a record, or `PROJECT.md`.
//
// #2055: a leaf `lstat` does not follow a link, but it does not see that the *folder* above the
// name is one either — `decisions/secret.md` under a symlinked `decisions` stats as a plain file
// and reads the outside text. So a decision path is read only when its folder is a real directory
// here, the same entry `decisionFiles` checks; anything else is treated as an absent file, which
// is what `project_state` and the board's opened row already answer for a missing one.
async function fileAt(dir, path) {
  if (isDecisionPath(path) && await dirKind(dirname(join(dir, path))) !== 'real') {
    throw notPlainFile(path, true)
  }
  const info = await lstat(join(dir, path))
  if (!info.isFile()) throw notPlainFile(path, info.isSymbolicLink())
  return info
}

// A name that is there but is not a plain file. `absent` marks the shapes this reader already
// answers as a missing file — a symlink (#2055) and a decision whose `decisions/` is not a real
// folder here — so the listing drops them exactly like an absent name. Anything else (a folder, a
// fifo, a device) is a name the reader cannot read, which the listing answers instead of dropping
// (#2461): a folder whose `PROJECT.md` is a directory is not a folder with no Project State file.
const notPlainFile = (path, absent) => Object.assign(new Error(`not a plain file: ${path}`), { absent })

// One Project State file with its byte size, content hash and last-modified time. Exported
// because the board reads the file a decided meeting archived, and it must refuse exactly what
// this reader refuses — one rule, one place.
export async function describeFile(dir, path) {
  const info = await fileAt(dir, path)
  const bytes = await readFile(join(dir, path))
  return { path, bytes: bytes.length, sha256: sha256(bytes), mtime: new Date(info.mtimeMs).toISOString() }
}

// Every Project State file in `dir` with its byte size, content hash and last-modified time.
// A file that is absent from the folder is left out rather than reported as empty; the
// decisions folder is read one level deep and only for `*.md`.
//
// The repository gate belongs to the tool, not to every reader (#1809): a decision file is the
// board's own artifact and shows up in a folder that is not a repository, while `project_state`
// keeps refusing such a folder by default. Only the board passes `{ repository: false }`.
// The reason a listed name has no row, short enough to sit inside one: the system's own errno when
// it gave one, else the rule the name broke (a folder where a plain file belongs). The name itself
// stays in the row, so the reason never repeats it and never carries a parenthesis of its own.
const unreadableReason = (error) => {
  if (typeof error?.code === 'string' && error.code !== '') return error.code
  const message = String(error?.message ?? error ?? '').split('\n')[0]
  return message.startsWith('not a plain file') ? 'not a plain file' : (message.replace(/[()]/g, '') || 'unknown')
}

// One listed name: a row with its byte size, hash and mtime, or the reason it has none. A name that
// is absent — or is a link, which this reader reads as absent (#2055) — adds nothing; a name that is
// there and could not be read is `unreadable: <path> (<reason>)`, never a silent omission (#2461).
async function listedRow(dir, path) {
  try {
    return { file: await describeFile(dir, path) }
  } catch (error) {
    if (error?.absent === true || error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null
    return { unreadable: { path, reason: unreadableReason(error) } }
  }
}

export async function listProjectState(dir, { repository = true } = {}) {
  if (repository && !await repositoryAt(dir)) return { ok: false, reason: `not a repository: ${dir}` }
  const found = []
  const unreadable = []
  const add = async (path) => {
    const row = await listedRow(dir, path)
    if (row === null) return
    if (row.file !== undefined) found.push(row.file)
    else unreadable.push(row.unreadable)
  }
  for (const path of PROJECT_STATE_PATHS) await add(path)
  for (const path of await decisionFiles(dir)) await add(path)
  return { ok: true, dir, files: found, unreadable }
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
  return readListedFile(dir, path)
}

// The bytes of one file whose name the caller already accepted as listed, bounded at `MAX_BYTES`.
// `project_state` and the board's opened decision share this read (#2041), so the bound and the
// symlink rule cannot drift between the two: a file that vanished since the listing, or one
// replaced by a symlink, answers `absent` rather than the text it points at.
export async function readListedFile(dir, path) {
  let info
  try {
    info = await fileAt(dir, path)
  } catch {
    return { ok: false, reason: `absent: ${path}` }
  }
  if (info.size > MAX_BYTES) return { ok: false, reason: `too large: ${path} is ${info.size} bytes (bound ${MAX_BYTES})` }
  const bytes = await readFile(join(dir, path))
  return { ok: true, path, bytes: bytes.length, sha256: sha256(bytes), mtime: new Date(info.mtimeMs).toISOString(), text: bytes.toString('utf8') }
}

// The Session's working folder moved to `core/src/host/work-dir.js` (#2684): the meetings module
// needs it too, and the plugin takes it back through the host seam. Re-exported so a caller of
// this reader (`project_state`, the board) keeps importing it from the same module.
export { workDirFor }

// The answer the tool prints: the rows a caller compares hashes with, and — after them — the names
// that are there but could not be read. `none` is the answer for a folder with nothing to read,
// which is exactly what an unreadable name is not (#2461).
const listed = ({ files, unreadable }) => files.length === 0 && unreadable.length === 0
  ? 'project state: no Project State files in this folder'
  : [
      'project state:',
      ...files.map(file => `${file.path}\t${file.bytes} bytes\tsha256:${file.sha256}\t${file.mtime}`),
      ...unreadable.map(({ path, reason }) => `unreadable: ${path} (${reason})`),
    ].join('\n')

export function install(rt) {
  rt.ctx.tools.register(defineTool({
    name: 'project_state',
    description: 'Read the Project State files of your working folder: PROJECT.md, ROADMAP.md, docs/governance.md, decisions/*.md, LESSONS.md. Without `file` it lists each with its byte size, sha256 content hash and last-modified time, so you can compare the hash with the copy you already have. With `file` it returns that one file, bounded. Answers `absent`, `too large` or `not a repository` with the reason instead of an empty document, and a listed name that is there but cannot be read as `unreadable: <path> (<reason>)` rather than leaving it out.',
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
