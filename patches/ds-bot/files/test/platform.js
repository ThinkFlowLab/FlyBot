// The few assertions that are POSIX-shaped, in one place so every Windows case names what the
// platform can and cannot express instead of dropping the assertion.
//
// Windows has no POSIX mode bits. `chmod` only toggles the read-only attribute, a writable file
// always stats `0o666`, and a folder cannot be made unreadable or unlistable by its mode. The
// denial code for a refused write is `EPERM` there rather than `EACCES`. `modeOf` therefore
// answers the mode on POSIX and the one distinction Windows does have — `writable` or `readonly`
// — on win32; a case that needs 0600 to be observable says so through `assertMode`'s message.
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'

export const posix = process.platform !== 'win32'
export const win32 = !posix

// The separator the product prints with `path.join`/`path.relative`, so an expected line is
// built here rather than hard-coded with `/`.
export const sep = win32 ? '\\' : '/'

// `~` as the report writes this host's own path: `~/state.json` on POSIX, `~\state.json` on
// Windows. Callers pass path parts, never a whole string with separators in it.
export const homePath = (...parts) => ['~', ...parts].join(sep)

// A string for a regular expression, so an expected home path can be matched literally.
export const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The observable mode: the four octal digits on POSIX; on Windows, whether the owner-write bit
// is set (the read-only attribute), because that is the only mode `chmod` exposes there.
export const modeOf = path => {
  const bits = statSync(path).mode & 0o777
  return posix ? bits.toString(8).padStart(4, '0') : (bits & 0o200 ? 'writable' : 'readonly')
}

// What `modeOf` must answer for a POSIX mode a test asks for.
export const expectedMode = wanted => posix ? wanted : ((parseInt(wanted, 8) & 0o200) ? 'writable' : 'readonly')

// `0600` is not observable on Windows; the assertion still runs, on the bit Windows has, and
// the failure message says why the expected value is the shrunken one.
export function assertMode(path, wanted, message = 'the file mode') {
  const expected = expectedMode(wanted)
  const note = posix ? '' : ` (Windows cannot express POSIX mode 0${wanted}; only the read-only bit is observable)`
  assert.equal(modeOf(path), expected, `${message}${note}`)
}

// A refused write is EACCES on POSIX and EPERM on Windows; the product's wording keeps whichever
// code the platform answered, so the test asks for the one it will see.
export const deniedCode = () => win32 ? 'EPERM' : 'EACCES'
