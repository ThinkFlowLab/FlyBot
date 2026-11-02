// The one "what is this directory entry, here" check (#2055). `readdir`, `stat` and a leaf
// `lstat` all follow a directory symlink, so a reader that means the folder beside its own files
// has to look at the entry itself: `lstat` does not follow the final component, and a link reports
// `isSymbolicLink()` rather than `isDirectory()`.
//
// Three states, not a boolean, because the callers mean three different things: a missing entry is
// "nothing to read" for a reader and "create it" for a writer, while a link or a plain file is
// "refuse, never touch what is behind it". A boolean would make the writer lstat a second time,
// which is the rule written twice. Fail closed: only ENOENT is `absent`; any other error is
// `other`, so a check that could not run never reads as a licence.
import { lstat } from 'node:fs/promises'
import { lstatSync } from 'node:fs'

const kindOf = info => info === undefined
  ? 'absent'
  : info.isDirectory() && !info.isSymbolicLink() ? 'real' : 'other'

export async function dirKind(path) {
  try {
    return kindOf(await lstat(path))
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'other'
  }
}

export function dirKindSync(path) {
  try {
    return kindOf(lstatSync(path))
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'other'
  }
}

// The leaf of a path is asked the same way (#2079): `lstat` does not follow the last component, so
// a link there reports `isSymbolicLink()`, never a file. The three states keep their meanings: a
// missing file is a writer's to create, a plain non-link file is written, and a link, a directory
// or a check that could not run is refused rather than written through.
const fileKindOf = info => info === undefined
  ? 'absent'
  : info.isFile() && !info.isSymbolicLink() ? 'real' : 'other'

export async function fileKind(path) {
  try {
    return fileKindOf(await lstat(path))
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'other'
  }
}

// A temp name a write lands through is a leaf like the file it becomes (temp-name sweep): the
// `writeFile` follows a link at the last component, so a link left at `<file>.<pid>.tmp` would take
// the bytes outside the home and the `rename` after them would put the link where the file belongs.
// `absent` is a writer's to create and a plain leftover under this host's own pid is replaceable;
// anything else refuses the write before the first byte. The destination itself needs no such
// check: `rename` replaces the name, link included, instead of writing through it.
export const tempWritable = (path) => fileKindSync(path) !== 'other'

export function fileKindSync(path) {
  try {
    return fileKindOf(lstatSync(path))
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'other'
  }
}
