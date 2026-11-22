// The few assertions of this suite that are POSIX-shaped, in one place so every Windows case names
// what the platform can and cannot express instead of dropping the assertion (#3298, the way
// core/test/platform.js does it for the core suite).
//
// Windows has no POSIX mode bits: `chmod` only toggles the read-only attribute, so a folder cannot
// be made unwritable and a file cannot be made unreadable to its owner. A case that needs a refusal
// asks for it through the mechanism the platform does have, and the comment there says which.
// `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, so a case that sets only HOME
// leaves the runner's own home in place there, and the test then reads a resolution it did not set.
export const posix = process.platform !== 'win32'
export const win32 = !posix

// The separator the product splits a path on (`fileProblem` in src/social.js uses `path.sep`), so an
// expected segment is read the way that code reads it rather than with a hard-coded `/`.
export const sep = win32 ? '\\' : '/'

// A string for a regular expression, so an expected separator or segment is matched literally.
export const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Every name `os.homedir()` may answer from, so one env object sets the home on either platform.
export const homeEnv = home => ({ HOME: home, USERPROFILE: home })
