// A file rewritten from a lossy decode carries U+FFFD where every character that could not
// be read used to be, and on disk that is the three bytes `EF BF BD` (#1188). Decoding the
// tree as UTF-8 to look for them does not work: on a clean `main` that reports 22 binary
// files and ~2,065,422 replacement characters (a GIF is not damaged text), so a gate built
// on `toString('utf8')` is red on `main` and no pull request can pass it. This gate reads
// bytes and calls a file binary when its first 8 KiB hold a NUL byte, which is what keeps
// `docs/images/*` and both `usage-sample.sqlite` copies out of the scan.
//
// The failure names the file, the occurrences and the lines, because the fix is "regenerate
// from the source", not "retype the Chinese".
//
// Usage: node .github/scripts/check-mojibake.mjs [--check] [root]
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

export const REPLACEMENT = Buffer.from([0xef, 0xbf, 0xbd])
export const SNIFF_BYTES = 8 * 1024
// Installs, the git store, build output, and a test bench with its own homes.
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'coverage', 'dist', 'build'])
const SKIPPED_PREFIXES = ['.dsh-test-']

const toPosix = (path) => path.split(sep).join('/')

// A NUL byte in the first 8 KiB is the one rule: text files in this repository are UTF-8
// without NULs, and every binary asset (GIF, MP4, PNG, SQLite) has one early.
export function isBinary(buffer) {
  const end = Math.min(buffer.length, SNIFF_BYTES)
  for (let at = 0; at < end; at += 1) if (buffer[at] === 0) return true
  return false
}

// `occurrences` counts the triples, `lines` the distinct lines they sit on (a line can hold
// several). A binary file answers `undefined`: it is not text, so it is not damage.
export function scanBuffer(buffer) {
  if (isBinary(buffer)) return undefined
  let occurrences = 0
  let line = 1
  const lines = new Set()
  for (let at = 0; at < buffer.length; at += 1) {
    if (buffer[at] === 0x0a) { line += 1; continue }
    if (buffer[at] === 0xef && buffer[at + 1] === 0xbf && buffer[at + 2] === 0xbd) {
      occurrences += 1
      lines.add(line)
      at += 2
    }
  }
  return { occurrences, lines: lines.size }
}

// Every regular file under `root`, minus the skipped directories. Symlinks are not followed:
// a checkout carries no tracked one, and following one would leave the tree.
export function scanTree(root) {
  const hits = []
  const skipped = []
  let text = 0
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIPPED_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue
        walk(rel)
        continue
      }
      if (!entry.isFile()) continue
      const result = scanBuffer(readFileSync(join(root, rel)))
      if (result === undefined) { skipped.push(rel); continue }
      text += 1
      if (result.occurrences > 0) hits.push({ path: rel, ...result })
    }
  }
  walk('')
  return { hits, skipped: skipped.sort(), text }
}

export function render(result) {
  if (result.hits.length === 0) {
    const names = result.skipped
    const shown = names.length <= 6 ? names.join(', ') : `${names.slice(0, 3).join(', ')}, +${names.length - 3} more`
    return `mojibake: ok — 0 occurrences of U+FFFD in ${result.text} text file(s) (${names.length} skipped as binary${names.length ? `: ${shown}` : ''})`
  }
  const total = result.hits.reduce((sum, hit) => sum + hit.occurrences, 0)
  const lines = result.hits.reduce((sum, hit) => sum + hit.lines, 0)
  return [
    `mojibake: FAIL — ${total} occurrence(s) of U+FFFD (EF BF BD) on ${lines} line(s) in ${result.hits.length} file(s):`,
    ...result.hits.map((hit) => `  ${hit.path} — ${hit.occurrences} occurrence(s) on ${hit.lines} line(s)`),
    'Regenerate each file from its source (and its generator) instead of retyping the damaged text.',
  ].join('\n')
}

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2)
  const root = args.find((arg) => !arg.startsWith('--')) ?? join(import.meta.dirname, '..', '..')
  const result = scanTree(root)
  console.log(render(result))
  if (result.hits.length > 0) process.exit(1)
}
