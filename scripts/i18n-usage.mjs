// Finds the plugin side of the interface dictionary: a string in a plugin's client bundle whose
// text already has a Chinese entry in core's dictionary, but that the plugin draws as a bare
// literal instead of passing it through `tr()`. `core/test/i18n.test.js` checks the other
// direction inside core; this is the check that was missing when four friend-card labels stayed
// English in a zh window (#2994, #2998).
//
// The scan is lexical on purpose: a plugin client is one plain ESM file, and a token walk is
// enough to find the places that draw copy. Only **render positions** count (#2998 ruling):
//
//   1. a string child of `h(...)` (argument 3 and later), or a pure template literal there;
//   2. the value of a copy attribute in an `h(...)` props object: title, aria-label,
//      aria-description, aria-placeholder, placeholder, alt, label;
//   3. an identifier bound once to such a literal (`const NAME = '…'`) and used bare in 1 or 2.
//
// Everything else is data, not copy: comparisons (`=== 'done'`, `case 'idle'`), object keys,
// status ids, selectors and URLs are never counted, and `tr()`/`t()`/`hostText()` arguments are
// already translated. `', '` is the join delimiter, not copy, and is skipped.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DICTIONARY } from '../core/src/client/i18n.js'

// `h(...)` props that carry copy a reader sees or hears.
const COPY_ATTRS = new Set(['title', 'aria-label', 'aria-description', 'aria-placeholder', 'placeholder', 'alt', 'label'])
// A `/` after one of these starts a regular expression, not a division.
const REGEX_AFTER = new Set([
  '(', '[', '{', ',', ';', '=', ':', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '~', '^',
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else',
  'yield', 'await', '=>',
])
const isIdent = ch => /[A-Za-z0-9_$]/.test(ch)

// Every string / identifier the client could draw, with the call frame it sits in. Strings carry
// the props key they are the value of, when that can be read lexically.
export function tokens(source) {
  const output = []
  const calls = []
  let index = 0
  let line = 1
  let previous = null
  let lastValue = null
  const current = () => calls[calls.length - 1]
  const place = token => {
    const call = current()
    output.push({
      line,
      call: call?.kind ?? null,
      arg: call?.arg ?? 0,
      obj: call?.obj ?? 0,
      prop: call?.key ?? null,
      ...token,
    })
  }

  while (index < source.length) {
    const ch = source[index]
    if (ch === '\n') { line += 1; index += 1; continue }
    if (ch === ' ' || ch === '\t' || ch === '\r') { index += 1; continue }
    if (ch === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (ch === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') line += 1
        index += 1
      }
      index += 2
      continue
    }
    if (ch === '/' && (previous === null || REGEX_AFTER.has(previous))) {
      index += 1
      let inClass = false
      while (index < source.length) {
        const each = source[index]
        if (each === '\\') { index += 2; continue }
        if (each === '[') inClass = true
        else if (each === ']') inClass = false
        else if (each === '/' && !inClass) { index += 1; break }
        if (each === '\n') line += 1
        index += 1
      }
      while (index < source.length && /[a-z]/.test(source[index])) index += 1
      previous = 'regex'
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      index += 1
      let value = ''
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') { value += source[index + 1]; index += 2; continue }
        if (source[index] === '\n') line += 1
        value += source[index]
        index += 1
      }
      index += 1
      place({ type: 'string', value })
      previous = 'string'
      lastValue = value
      continue
    }
    if (ch === '`') {
      index += 1
      let value = ''
      let substituted = false
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\') { index += 2; continue }
        if (source[index] === '$' && source[index + 1] === '{') {
          substituted = true
          let depth = 1
          index += 2
          while (index < source.length && depth > 0) {
            if (source[index] === '{') depth += 1
            else if (source[index] === '}') depth -= 1
            else if (source[index] === '\n') line += 1
            index += 1
          }
          continue
        }
        if (source[index] === '\n') line += 1
        value += source[index]
        index += 1
      }
      index += 1
      if (!substituted) place({ type: 'string', value })
      previous = 'string'
      lastValue = value
      continue
    }
    if (isIdent(ch)) {
      let name = ''
      while (index < source.length && isIdent(source[index])) { name += source[index]; index += 1 }
      if (name === 'tr' || name === 't' || name === 'hostText' || name === 'h') {
        let next = index
        while (next < source.length && /\s/.test(source[next])) next += 1
        if (source[next] === '(') calls.push({ kind: name, arg: 0, obj: 0, key: null })
      }
      place({ type: 'ident', value: name })
      previous = name
      lastValue = name
      continue
    }
    if (ch === '(' || ch === '[') {
      if (!(previous === 'tr' || previous === 't' || previous === 'hostText' || previous === 'h')) calls.push({ kind: 'other', arg: 0, obj: 0, key: null })
      previous = '('
      index += 1
      continue
    }
    if (ch === ')') { calls.pop(); previous = ')'; index += 1; continue }
    if (ch === ']') { if (current()?.kind === 'other') calls.pop(); previous = ']'; index += 1; continue }
    if (ch === '{') {
      const call = current()
      if (call) call.obj += 1
      previous = '{'
      index += 1
      continue
    }
    if (ch === '}') {
      const call = current()
      if (call && call.obj > 0) { call.obj -= 1; call.key = null }
      previous = '}'
      index += 1
      continue
    }
    if (ch === ':') {
      const call = current()
      // A props pair `title: …`; a ternary's `:` overwrites the key, which only makes the scan
      // miss that branch, never invent a render position.
      if (call && call.kind === 'h' && call.obj > 0 && lastValue !== null) call.key = lastValue
      place({ type: 'punct', value: ':' })
      previous = ':'
      lastValue = ':'
      index += 1
      continue
    }
    if (ch === ',') {
      const call = current()
      if (call && call.obj === 0) call.arg += 1
      previous = ','
      index += 1
      continue
    }
    if (ch === '=' || ch === '!' || ch === '<' || ch === '>' || ch === '=') {
      let operator = ch
      while (index + 1 < source.length && (source[index + 1] === '=' || (operator === '=' && source[index + 1] === '>'))) {
        operator += source[index + 1]
        index += 1
      }
      place({ type: 'punct', value: operator })
      previous = operator
      lastValue = operator
      index += 1
      continue
    }
    place({ type: 'punct', value: ch })
    previous = ch
    lastValue = ch
    index += 1
  }
  return output
}

// `const NAME = 'text'` / `let NAME = "text"`: the one level of indirection the ruling allows.
function constants(list) {
  const bound = new Map()
  for (let at = 0; at + 3 < list.length; at += 1) {
    const keyword = list[at]
    const name = list[at + 1]
    const equals = list[at + 2]
    const value = list[at + 3]
    if (keyword.type !== 'ident' || !['const', 'let', 'var'].includes(keyword.value)) continue
    if (name.type !== 'ident' || equals.type !== 'punct' || equals.value !== '=') continue
    if (value.type !== 'string') continue
    bound.set(name.value, value.value)
  }
  return bound
}

const translated = token => (token.call === 'tr' || token.call === 't' || token.call === 'hostText') && token.arg === 0 && token.obj === 0
const renderChild = token => token.call === 'h' && token.obj === 0 && token.arg >= 2
const renderAttr = token => token.call === 'h' && token.obj > 0 && COPY_ATTRS.has(token.prop)
const drawn = token => renderChild(token) || renderAttr(token)

// One entry per bare draw that already has a zh entry: where the draw is, and the dictionary key.
const COMPARISONS = new Set(['===', '!==', '==', '!=', '<=', '>=', '<', '>'])

export function bareCopy(source, file, dictionary = DICTIONARY.zh) {
  const list = tokens(source)
  const bound = constants(list)
  const entries = []
  for (let at = 0; at < list.length; at += 1) {
    const token = list[at]
    if (translated(token)) continue
    const before = list[at - 1]
    const after = list[at + 1]
    // A comparison operand (`run.status === 'done'`, `case 'idle'`) or an object key is data,
    // not copy; never count it even when it sits inside a render expression.
    if (before?.type === 'punct' && COMPARISONS.has(before.value)) continue
    if (after?.type === 'punct' && COMPARISONS.has(after.value)) continue
    if (before?.type === 'ident' && before.value === 'case') continue
    if (token.obj > 0 && after?.type === 'punct' && after.value === ':') continue
    let key = null
    if (token.type === 'string') key = token.value
    else if (token.type === 'ident' && bound.has(token.value)) key = bound.get(token.value)
    if (key === null || key === ', ' || !drawn(token)) continue
    if (!Object.hasOwn(dictionary, key)) continue
    entries.push({ file, line: token.line, key })
  }
  return entries
}

// Every plugin client, in a stable order, so two runs (and two machines) compare the same list.
export function scanPlugins(pluginsRoot = new URL('../plugins/', import.meta.url)) {
  const found = []
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(fileURLToPath(pluginsRoot), entry.name, 'client.js')
    let source
    try { source = readFileSync(file, 'utf8') } catch { continue }
    found.push(...bareCopy(source, `plugins/${entry.name}/client.js`))
  }
  return found.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}

// The baseline is one `file:line:key` string per bare draw, sorted; a fix deletes its entry and
// the set may only shrink.
export function baselineOf(entries) {
  return [...new Set(entries.map(entry => `${entry.file}:${entry.line}:${entry.key}`))].sort()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entries = scanPlugins()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ version: 1, entries: baselineOf(entries) }, null, 2))
  } else if (process.argv.includes('--write')) {
    const target = process.argv[process.argv.indexOf('--write') + 1]
    writeFileSync(target, `${JSON.stringify({ version: 1, entries: baselineOf(entries) }, null, 2)}\n`)
    console.log(`wrote ${entries.length} entries to ${target}`)
  } else {
    for (const entry of entries) console.log(`${entry.file}:${entry.line}: ${JSON.stringify(entry.key)}`)
    console.log(`${entries.length} bare draws in ${new Set(entries.map(entry => entry.file)).size} files`)
  }
}
