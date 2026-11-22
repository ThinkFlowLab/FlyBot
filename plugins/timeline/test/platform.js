// The few assertions of this suite that are POSIX-shaped, in one place so every Windows case names
// what the platform can and cannot express instead of dropping the assertion (#3298, the way
// core/test/platform.js does it for the core suite).
//
// Windows has no POSIX mode bits: `chmod` only toggles the read-only attribute, so a folder cannot be
// made unlistable for its owner, and there is no POSIX `fsync` of a directory. `os.homedir()` reads
// HOME on POSIX and USERPROFILE on Windows, so a case that sets only HOME leaves the runner's own
// home in place there, and the trace then lands in a root the test did not choose.
export const posix = process.platform !== 'win32'
export const win32 = !posix

// Every name `os.homedir()` may answer from, so one env object sets the home on either platform.
export const homeEnv = home => ({ HOME: home, USERPROFILE: home })
