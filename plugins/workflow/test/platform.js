// The few assertions of this suite that are POSIX-shaped, in one place so every Windows case names
// what the platform can and cannot express instead of dropping the assertion (#3298, the way
// core/test/platform.js does it for the core suite).
//
// `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows, so a case that sets only HOME leaves
// the runner's own home in place there, and the store then lands in a root the test did not choose.
// A module a child imports is named by URL, never by a path: an absolute Windows path is `C:\…`,
// which the ESM loader refuses as an unsupported scheme (`d:`) instead of loading the file.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const posix = process.platform !== 'win32'
export const win32 = !posix

// Every name `os.homedir()` may answer from, so one env object sets the home on either platform.
export const homeEnv = home => ({ HOME: home, USERPROFILE: home })

// The `import … from` specifier for a file of this checkout, the same on both platforms.
export const moduleUrl = (...parts) => pathToFileURL(join(...parts)).href
