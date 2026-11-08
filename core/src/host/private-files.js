// The host's own files carry what the user told it: a Bot's memory, the saved team, the index of
// every conversation part, the decision log, the OCR cache, the notes of a running turn. They are
// written by a process that inherits its umask from whoever started it, so a write that names no
// mode lands `0644` on a stock `022` and another local account reads all of it. These helpers name
// the mode instead — a file `0600`, the folder holding it `0700` — so the file's mode is a
// decision in the code and not a property of the shell it was started from (#2697).
//
// A rewrite must not widen what is already there. The writers put a temp file next to the old one
// and rename it over, and that new name would be created with the ambient mode; so the mode of the
// file being replaced is read first and given to the temp file before the rename. A `chmod 0400` a
// person made by hand survives the next `remember`; a name that does not exist yet is created
// private.
import { chmodSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, rename, writeFile } from 'node:fs/promises'

export const PRIVATE_FILE_MODE = 0o600
export const PRIVATE_DIR_MODE = 0o700

// `mkdir`'s mode is filtered by the umask and it leaves a folder that already exists alone, so the
// `chmod` is what makes an existing folder private too. A folder this process may not chmod — a
// read-only mount, a volume owned by another account — is not a reason to refuse to write: the
// file modes below are what the writers promise, and a login that cannot chmod cannot read the
// folder through a narrower mode either way.
export async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  await chmod(dir, PRIVATE_DIR_MODE).catch(() => { /* the file modes still hold */ })
}

export function ensurePrivateDirSync(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  try {
    chmodSync(dir, PRIVATE_DIR_MODE)
  } catch {
    /* the file modes still hold */
  }
}

// The mode a rewrite lands with. `lstat` and not `stat`: a link is not this file, and its target's
// mode is not ours to copy. A missing or unreadable name is the creation case.
const modeOf = info => (info.isFile() && !info.isSymbolicLink() ? info.mode & 0o777 : PRIVATE_FILE_MODE)

export async function keptFileMode(path) {
  try {
    return modeOf(await lstat(path))
  } catch {
    return PRIVATE_FILE_MODE
  }
}

export function keptFileModeSync(path) {
  try {
    return modeOf(lstatSync(path))
  } catch {
    return PRIVATE_FILE_MODE
  }
}

// Writes the temp name a caller will `rename` over the target, at the mode the target has now.
// The caller keeps its own temp-name check and its own ordering around the rename: the lock it
// asks for, and whether the target was a link, are read between these two steps.
export async function stagePrivateFile(temp, target, text) {
  // `writeFile`'s `mode` is used only when it creates the name: a leftover temp file keeps its own
  // mode, so the chmod is what the rename lands with.
  const mode = await keptFileMode(target)
  await writeFile(temp, text, { encoding: 'utf8', mode })
  await chmod(temp, mode)
  return mode
}

export function stagePrivateFileSync(temp, target, text) {
  const mode = keptFileModeSync(target)
  writeFileSync(temp, text, { encoding: 'utf8', mode })
  chmodSync(temp, mode)
  return mode
}

export async function replacePrivateFile(temp, target, text) {
  await stagePrivateFile(temp, target, text)
  await rename(temp, target)
}

export function replacePrivateFileSync(temp, target, text) {
  stagePrivateFileSync(temp, target, text)
  renameSync(temp, target)
}

// A file written in place, not replaced: `writeFile` keeps the mode of a name that already exists,
// which is what a narrowed file keeps, and creates a missing one private.
export async function writePrivateFile(file, text) {
  await writeFile(file, text, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
}

// SQLite creates its own files, so their mode is not ours to pass. Tighten what exists now; the
// folder is checked as well, because the `-wal`/`-shm` pair appears on SQLite's own time.
export async function tightenFile(file, mode = PRIVATE_FILE_MODE) {
  await chmod(file, mode).catch(() => { /* not created yet, or no modes on this file system */ })
}
