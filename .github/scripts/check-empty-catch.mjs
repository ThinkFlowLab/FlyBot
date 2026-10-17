// A catch clause whose block holds neither a statement nor a comment swallows the
// error with nothing on record saying why that is safe (#205). The comment is the
// reason; a block with statements handles the error and needs none. Only the
// statement form is checked: the `void p.catch(() => {})` promise form is a separate
// fire-and-forget idiom, and test helpers may retry through a bare catch.
// Usage: node .github/scripts/check-empty-catch.mjs   (exit 1 lists every violation)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CATCH = /(?<![\w$.])catch\s*(?:\([^)]*\))?\s*\{/g

// The block after `{`, ending at the brace that closes it. Braces inside strings can
// only end the walk early, and a truncated block still shows its leading statements,
// so the walk never invents a violation that is not there.
const blockOf = (source, open) => {
  let depth = 0
  for (let at = open; at < source.length; at += 1) {
    if (source[at] === '{') depth += 1
    if (source[at] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, at)
    }
  }
  return source.slice(open + 1)
}

// What remains of the block once comments are gone; `comment` says whether any was.
const stripComments = (block) => {
  let comment = false
  const code = block.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (found) => {
    comment = true
    return ''
  })
  return { code, comment }
}

export function scanSource(name, source) {
  const found = []
  for (const match of source.matchAll(CATCH)) {
    const open = match.index + match[0].length - 1
    const { code, comment } = stripComments(blockOf(source, open))
    if (code.trim() === '' && !comment) {
      const line = source.slice(0, match.index).split('\n').length
      found.push(`${name}:${line}`)
    }
  }
  return found
}

const under = (dir, names) => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dev' || entry.name === 'test') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...under(path, names))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(path)
  }
  return out
}

export function collectTargets(root) {
  const files = [join(root, 'core/index.js'), join(root, 'core/web-search.js'), ...under(join(root, 'core/src'))]
  for (const plugin of readdirSync(join(root, 'plugins'), { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue
    const dir = join(root, 'plugins', plugin.name)
    for (const name of ['index.js', 'client.js']) files.push(join(dir, name))
    files.push(...under(join(dir, 'src')))
  }
  return files
}

export function scanTree(root) {
  return collectTargets(root).flatMap((path) => scanSource(path, readFileSync(path, 'utf8')))
}

if (process.argv[1] === import.meta.filename) {
  const root = join(import.meta.dirname, '..', '..')
  const violations = scanTree(root)
  for (const where of violations) console.log(`${where}: empty catch: the error is swallowed with no reason on record`)
  if (violations.length > 0) process.exit(1)
}
