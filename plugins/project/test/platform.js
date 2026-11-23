// The few assertions of this suite that are POSIX-shaped, in one place so every Windows case names
// what the platform can and cannot express instead of dropping the assertion (#3298, the way
// core/test/platform.js does it for the core suite).
//
// Windows has no POSIX mode bits: `chmod` only toggles the read-only attribute, so a state file
// cannot be made unreadable for its owner, and a case that writes `chmod 000` and expects `EACCES`
// reads the file there instead and asserts the wrong answer (#3348). Only that one case is skipped
// on Windows; the rest of the suite is platform-neutral and runs everywhere.
export const posix = process.platform !== 'win32'
export const win32 = !posix
