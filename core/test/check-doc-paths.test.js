// A repo path written as inline code rots silently: `README.md:118` said `dev/harness` while the DSH
// pin is `core/dev/harness/package.json`, and nothing read it (#1403, #1397). The two root READMEs are
// the scanned surface on purpose — `docs/**`, `core/README.md` and the plugin READMEs write their
// inline paths relative to their own package or to the runtime home, so judging them against the repo
// root reports paths that are not broken. #1403 allows narrowing the file list; it forbids an allowlist.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DOCUMENTS = ['README.md', 'README.zh.md']

// A token claims to be a repo path when it holds a slash, no space, and its first segment names an
// entry at the repo root: that is what makes `dev/harness` a claim about this tree, while `src/host/`
// (package-relative), `origin/main` (a ref) and `ThinkFlowLab/FlyBot` (a remote) are not repo paths.
export function isRepoPath(token, root = ROOT) {
  if (!token.includes('/') || /\s/.test(token)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false // URL
  if (/[*<>{}]/.test(token)) return false // glob or placeholder
  if (/^[\w.-]+\/[\w.-]+#\d+$/.test(token)) return false // owner/repo#123
  if (/^@/.test(token)) return false // npm scope
  if (/^[/~$]/.test(token)) return false // absolute, home or env path
  if (/[%:]/.test(token)) return false // env path or a namespaced id
  if (/[=()|&;]/.test(token)) return false // a command line
  const first = token.replace(/\/+$/, '').split('/')[0]
  if (first === '.' || first === '..') return false
  return existsSync(join(root, first))
}

// Every backticked token outside a fenced block, as `file:line: token` for the ones that miss on disk.
export function docPathMisses(root = ROOT, documents = DOCUMENTS) {
  const misses = []
  for (const file of documents) {
    let fenced = false
    readFileSync(join(root, file), 'utf8').split('\n').forEach((line, index) => {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return }
      if (fenced) return
      for (const [, token] of line.matchAll(/`([^`]+)`/g)) {
        const path = token.trim().replace(/\/+$/, '')
        if (!isRepoPath(path, root) || existsSync(join(root, path))) continue
        misses.push(`${file}:${index + 1}: ${token.trim()}`)
      }
    })
  }
  return misses
}

test('every repo path named in inline code on the root READMEs exists on disk', () => {
  assert.deepEqual(docPathMisses(), [])
})

test('the tokenizer skips refs, URLs, globs, placeholders, npm scopes and absolute paths, and names a miss', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'doc-paths-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'dev', 'harness'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'install.md'), '# install\n')
  writeFileSync(join(root, 'README.md'), [
    'A fenced block is prose, not a claim:',
    '```',
    'dev/not-real',
    '```',
    'Real: `dev/harness`, `dev/harness/`, `docs/install.md`.',
    'Not repo paths: `https://example.com/dev/x`, `docs/*.md`, `<name>/dev`, `{id}/x`, `origin/main`,',
    '`ThinkFlowLab/FlyBot#1403`, `@flybot/workflow`, `/etc/harness`, `../core/dev`, `container:x/y`,',
    '`npm run verify`.',
    'One miss: `dev/nope`.',
  ].join('\n'))
  assert.deepEqual(docPathMisses(root, ['README.md']), ['README.md:9: dev/nope'])
})
