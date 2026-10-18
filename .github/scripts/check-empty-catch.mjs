// A catch clause whose block holds neither a statement nor a comment swallows the
// error with nothing on record saying why that is safe (#205). The comment is the
// reason; a block with statements handles the error and needs none. Only the
// statement form of `catch` is checked there; the promise form is the next rule.
// Promise form (#213): a `.catch` whose handler does nothing (`() => {}`, `() => undefined`,
// `() => null`) and whose result is dropped (a statement or an `await` statement) needs a
// `void` prefix or a one-line reason comment (in the handler, after the call on the same
// line, or on the line above the statement). A handler that returns a fallback VALUE that is
// used (`const x = await p.catch(() => undefined)`, an argument, a `return`) stays allowed.
// The text `catch {}` inside a comment, a string, a template or a regex literal is
// not code, so it is never reported (#213).
// Usage: node .github/scripts/check-empty-catch.mjs   (exit 1 lists every violation)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CATCH = /(?<![\w$.])catch\s*(?:\([^)]*\))?\s*\{/g

// After one of these (or at the start), a `/` opens a regex literal, not a division.
const REGEX_AFTER = new Set([...'(,=:[!&|?{};+-*%~^<>'])
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

// Two copies of the source with the same length and line breaks: `bare` blanks every
// comment and the inside of every string, template and regex literal (the quotes stay,
// so a string statement is still code); `commented` blanks the literals only, so the
// comments are left to read. A quote or `/` that does not close on its own line is not
// a literal and is left as code: a misread costs at most that line, never the file.
export function maskSource(source) {
  const bare = source.split('')
  const commented = source.split('')
  const blank = (from, to, { comment = false } = {}) => {
    for (let at = from; at < to; at += 1) {
      if (source[at] === '\n') continue
      bare[at] = ' '
      if (!comment) commented[at] = ' '
    }
  }
  // Each entry is the `{` depth of an open `${`; the template resumes when it closes.
  const templates = []
  let depth = 0
  let last = '' // the last code character that is not whitespace
  let at = 0
  // Scans a template body from `at` (after the backtick or a `}`): blanks it up to the
  // closing backtick or the next `${`, and returns where code resumes.
  const templateBody = (start) => {
    let end = start
    while (end < source.length) {
      if (source[end] === '\\') { end += 2; continue }
      if (source[end] === '`') { blank(start, end); return { next: end + 1, open: false } }
      if (source[end] === '$' && source[end + 1] === '{') { blank(start, end); return { next: end + 2, open: true } }
      end += 1
    }
    blank(start, source.length)
    return { next: source.length, open: false }
  }
  // A literal closed by `quote` on the same line, from `start` (after the opening
  // quote); returns its closing index or -1. A regex skips over its `[...]` classes.
  const closeOnLine = (start, quote) => {
    let inClass = false
    for (let end = start; end < source.length; end += 1) {
      const char = source[end]
      if (char === '\n') return -1
      if (char === '\\') { end += 1; continue }
      if (quote === '/') {
        if (char === '[') inClass = true
        else if (char === ']') inClass = false
        else if (char === '/' && !inClass) return end
        continue
      }
      if (char === quote) return end
    }
    return -1
  }
  while (at < source.length) {
    const char = source[at]
    const next = source[at + 1]
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', at)
      const stop = end === -1 ? source.length : end
      blank(at, stop, { comment: true })
      at = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', at + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(at, stop, { comment: true })
      at = stop
      continue
    }
    if (char === '"' || char === "'") {
      const end = closeOnLine(at + 1, char)
      if (end !== -1) { blank(at + 1, end); last = char; at = end + 1; continue }
    }
    if (char === '/' && (last === '' || REGEX_AFTER.has(last) || REGEX_KEYWORDS.test(source.slice(Math.max(0, at - 12), at).trimEnd()))) {
      const end = closeOnLine(at + 1, '/')
      if (end !== -1) { blank(at + 1, end); last = '/'; at = end + 1; continue }
    }
    if (char === '`') {
      const { next: resume, open } = templateBody(at + 1)
      if (open) templates.push(depth)
      last = open ? '{' : '`'
      at = resume
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      if (templates.length > 0 && templates.at(-1) === depth) {
        templates.pop()
        const { next: resume, open } = templateBody(at + 1)
        if (open) templates.push(depth)
        last = open ? '{' : '`'
        at = resume
        continue
      }
      depth -= 1
    }
    if (!/\s/.test(char)) last = char
    at += 1
  }
  return { bare: bare.join(''), commented: commented.join('') }
}

// The index of the brace that closes the block opened at `open`, in masked source
// (no braces of strings or comments left to miscount), or the end of the source.
const closeOf = (code, open) => {
  let depth = 0
  for (let at = open; at < code.length; at += 1) {
    if (code[at] === '{') depth += 1
    if (code[at] === '}') {
      depth -= 1
      if (depth === 0) return at
    }
  }
  return code.length
}

export function scanSource(name, source) {
  const found = []
  const { bare, commented } = maskSource(source)
  for (const match of bare.matchAll(CATCH)) {
    const open = match.index + match[0].length - 1
    const close = closeOf(bare, open)
    // No code left once comments and literals are blanked, and no comment either.
    if (bare.slice(open + 1, close).trim() === '' && commented.slice(open + 1, close).trim() === '') {
      const line = source.slice(0, match.index).split('\n').length
      found.push(`${name}:${line}`)
    }
  }
  return found
}

// A `.catch` handler that does nothing: an arrow whose body is empty, or just undefined / null.
const IDLE_CATCH = /\.catch\(\s*(?:\([^()]*\)|[\w$]+)\s*=>\s*(\{\s*\}|undefined\b|null\b|void\s+0\b)\s*\)/g

// Where the statement holding the call at `at` begins, walking back over balanced brackets.
// Returns { start, argument }: `argument` when an unmatched `(` / `[` / `,` shows the call sits
// inside another expression (an argument, an element), so its result is used.
function statementStart(code, at) {
  let depth = 0
  for (let i = at - 1; i >= 0; i -= 1) {
    const char = code[i]
    if (char === ')' || char === ']') depth += 1
    else if (char === '(' || char === '[') {
      if (depth === 0) return { start: i + 1, argument: true }
      depth -= 1
    } else if (depth === 0) {
      if (char === ';' || char === '{' || char === '}') return { start: i + 1, argument: false }
      if (char === ',') return { start: i + 1, argument: true }
      if (char === '\n') {
        // A new statement begins here unless this line, or the one before it, continues an expression.
        const lineStart = i + 1
        const lineEnd = code.indexOf('\n', lineStart)
        const line = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd).trim()
        const before = code.slice(0, i).trimEnd().slice(-2)
        const continues = /^[.?:+\-*/%&|=<>,]/.test(line) && !/^(?:\+\+|--)/.test(line)
        const open = /[.?:+\-*/%&|=<>,(\[{]$/.test(before) && !/(?:\+\+|--|\)|\})$/.test(before)
        if (!continues && !open && line !== '') return { start: lineStart, argument: false }
      }
    }
  }
  return { start: 0, argument: false }
}

// `text` with the inside of every (...), [...] and {...} removed.
function outside(text) {
  let depth = 0
  let out = ''
  for (const char of text) {
    if ('([{'.includes(char)) { depth += 1; out += depth === 1 ? char : ''; continue }
    if (')]}'.includes(char)) { depth -= 1; out += depth === 0 ? char : ''; continue }
    if (depth === 0) out += char
  }
  return out
}

export function scanPromiseSource(name, source) {
  const found = []
  const { bare, commented } = maskSource(source)
  for (const match of bare.matchAll(IDLE_CATCH)) {
    const { start, argument } = statementStart(bare, match.index)
    if (argument) continue
    const head = bare.slice(start, match.index).trim()
    // The statement's own text, without what sits inside brackets (callbacks, arguments, objects).
    const top = outside(head)
    // A used value: returned, thrown, declared, assigned, an arrow's expression body, a ternary, negated.
    if (/^(?:return|throw|yield|const|let|var|export)\b|=>|(?<![=!<>])=(?![=>])|\?(?!\.)\s|^!/.test(top)) continue
    if (/\bvoid\b/.test(top)) continue
    // A reason: a comment in the handler, after the call on its line, or on the line above the statement.
    const handler = commented.slice(match.index, match.index + match[0].length)
    const eol = commented.indexOf('\n', match.index + match[0].length)
    const rest = commented.slice(match.index + match[0].length, eol === -1 ? commented.length : eol)
    const startLine = commented.lastIndexOf('\n', commented.indexOf(bare.slice(start).trimStart().slice(0, 1) || ' ', start))
    const above = commented.slice(commented.lastIndexOf('\n', Math.max(0, startLine - 1)) + 1, startLine === -1 ? 0 : startLine)
    if (/\/\*|\/\//.test(handler) || /\/\*|\/\//.test(rest) || /^\s*(?:\/\/|\/\*|\*)/.test(above)) continue
    found.push(`${name}:${source.slice(0, match.index).split('\n').length}`)
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

export function scanPromiseTree(root) {
  return collectTargets(root).flatMap((path) => scanPromiseSource(path, readFileSync(path, 'utf8')))
}

if (process.argv[1] === import.meta.filename) {
  const root = join(import.meta.dirname, '..', '..')
  const violations = scanTree(root)
  const dropped = scanPromiseTree(root)
  for (const where of violations) console.log(`${where}: empty catch: the error is swallowed with no reason on record`)
  for (const where of dropped) console.log(`${where}: .catch handler does nothing and its result is dropped: add \`void\` or a one-line reason comment`)
  if (violations.length + dropped.length > 0) process.exit(1)
}
