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
