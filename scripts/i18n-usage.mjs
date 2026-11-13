// Two lexical scans over the plugin clients, from the two sides of core's zh dictionary.
//
// `bareCopy` finds a string whose text already has a zh entry but that the plugin draws as a bare
// literal instead of passing it through `tr()` (#2998): `core/test/i18n.test.js` checks the other
// direction inside core, and this is what was missing when four friend-card labels stayed English
// in a zh window (#2994).
//
// `missingCopy` finds the opposite gap (#3002): copy a plugin draws that the dictionary has no
// entry for at all, so nothing can translate it. Its positions are the copy a plugin actually
// reads — a value in a `*_COPY` / `*_TEXT` table, and a `text:` property (a status line handed to
// the renderer, or an `h(...)` prop). A value already translated, a comparison operand, an object
// key, a state id, a selector and a URL are data, not copy, and never count in either scan.
//
// `bareCopy` only counts **render positions** (#2998 ruling):
//
//   1. a string child of `h(...)` (argument 3 and later), or a pure template literal there;
//   2. the value of a copy attribute in an `h(...)` props object: title, aria-label,
//      aria-description, aria-placeholder, placeholder, alt, label;
//   3. an identifier bound once to such a literal (`const NAME = '…'`) and used bare in 1 or 2.
//
// Both scans are lexical on purpose: a plugin client is one plain ESM file, and a token walk is
// enough to find the places that draw copy.
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

// A backslash escape is one character to the reader, whatever the source spelling was: a table
// entry written `FlyBot\u2019s` is the same sentence as `FlyBot’s`, and the dictionary is keyed by
// what a reader sees.
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }
function escapeAt(source, index) {
  const ch = source[index + 1]
  if (ch === undefined) return ['', index + 1]
  if (ch === 'x') return [String.fromCharCode(parseInt(source.slice(index + 2, index + 4), 16)), index + 4]
  if (ch === 'u') {
    if (source[index + 2] === '{') {
      const close = source.indexOf('}', index + 3)
      const point = parseInt(source.slice(index + 3, close), 16)
      return [Number.isFinite(point) ? String.fromCodePoint(point) : '', close + 1]
    }
    const point = parseInt(source.slice(index + 2, index + 6), 16)
    return [Number.isFinite(point) ? String.fromCharCode(point) : '', index + 6]
  }
  return [ESCAPES[ch] ?? ch, index + 2]
}

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
        if (source[index] === '\\') {
          const [each, next] = escapeAt(source, index)
          value += each
          index = next
          continue
        }
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
        if (source[index] === '\\') {
          const [each, next] = escapeAt(source, index)
          value += each
          index = next
          continue
        }
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
    // Braces are emitted too, so a copy table can be delimited by its own body rather than by
    // guessing from the props depth.
    if (ch === '{') {
      const call = current()
      place({ type: 'punct', value: '{' })
      if (call) call.obj += 1
      previous = '{'
      lastValue = '{'
      index += 1
      continue
    }
    if (ch === '}') {
      const call = current()
      place({ type: 'punct', value: '}' })
      if (call && call.obj > 0) { call.obj -= 1; call.key = null }
      previous = '}'
      lastValue = '}'
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
    // Same props depth as the `=`: `const LOCAL_REFUSAL_COPY = { … }` must not read as a binding
    // to its first key.
    if (value.type !== 'string' || value.obj !== equals.obj) continue
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

// Copy a plugin keeps in a table: `const LOCAL_REFUSAL_COPY = { … }`, `const FACE_SCAN_COPY = { … }`,
// `const …_TEXT = { … }`. A table value may be a function (`STATE_TEXT.connected: t => t(…)`), which
// is already translated, so only a value sitting directly after its key is read.
const COPY_TABLE = /_(COPY|TEXT)$/

function copyTables(list) {
  const bodies = []
  for (let at = 0; at + 3 < list.length; at += 1) {
    const keyword = list[at]
    const name = list[at + 1]
    const equals = list[at + 2]
    const open = list[at + 3]
    if (keyword.type !== 'ident' || !['const', 'let', 'var'].includes(keyword.value)) continue
    if (name.type !== 'ident' || !COPY_TABLE.test(name.value)) continue
    if (equals.type !== 'punct' || equals.value !== '=') continue
    if (open.type !== 'punct' || open.value !== '{') continue
    let depth = 0
    let end = -1
    for (let each = at + 3; each < list.length; each += 1) {
      if (list[each].type !== 'punct') continue
      if (list[each].value === '{') depth += 1
      else if (list[each].value === '}') {
        depth -= 1
        if (depth === 0) { end = each; break }
      }
    }
    if (end > 0) bodies.push({ start: at + 3, end })
  }
  return bodies
}

// A value drawn as copy but with no zh entry at all: the bug #3002 found. The positions are the
// ones a plugin actually reads copy from — a `*_COPY` / `*_TEXT` table value, and a `text:` property
// (a status line handed to the renderer, or an `h(...)` prop). A value that is already translated
// (`t('…')`, `tr('…')`), a comparison operand, an object key and the `', '` join delimiter are data,
// not copy, and stay out.
const copyValue = (list, at) => {
  const previous = list[at - 1]
  const key = list[at - 2]
  if (previous?.type === 'punct' && previous.value === ':' && key && (key.type === 'ident' || key.type === 'string') && key.value === 'text') return true
  return false
}

export function missingCopy(source, file, dictionary = DICTIONARY.zh) {
  const list = tokens(source)
  const bound = constants(list)
  const tables = copyTables(list)
  const entries = []
  for (let at = 0; at < list.length; at += 1) {
    const token = list[at]
    if (token.type !== 'string' && token.type !== 'ident') continue
    if (translated(token)) continue
    const before = list[at - 1]
    const after = list[at + 1]
    if (before?.type === 'punct' && COMPARISONS.has(before.value)) continue
    if (after?.type === 'punct' && COMPARISONS.has(after.value)) continue
    if (token.obj > 0 && after?.type === 'punct' && after.value === ':') continue
    const inTable = tables.some(body => at > body.start && at < body.end)
    if (!inTable && !copyValue(list, at)) continue
    // Inside a table only a direct value counts; a nested call or function body is not one.
    if (inTable && !(before?.type === 'punct' && before.value === ':')) continue
    const key = token.type === 'string' ? token.value : bound.get(token.value)
    if (key === undefined || key === '' || key === ', ') continue
    if (Object.hasOwn(dictionary, key)) continue
    entries.push({ file, line: token.line, key })
  }
  return entries
}

function pluginClients(pluginsRoot) {
  const clients = []
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(fileURLToPath(pluginsRoot), entry.name, 'client.js')
    let source
    try { source = readFileSync(file, 'utf8') } catch { continue }
    clients.push({ file: `plugins/${entry.name}/client.js`, source })
  }
  return clients.sort((a, b) => (a.file < b.file ? -1 : 1))
}

const byPlace = (a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1)

// Every plugin client, in a stable order, so two runs (and two machines) compare the same list.
export function scanPlugins(pluginsRoot = new URL('../plugins/', import.meta.url)) {
  return pluginClients(pluginsRoot).flatMap(({ file, source }) => bareCopy(source, file)).sort(byPlace)
}

// The other half of the same walk: copy a plugin draws that the dictionary has no entry for, so
// nothing can translate it at all (#3002).
export function scanMissing(pluginsRoot = new URL('../plugins/', import.meta.url)) {
  return pluginClients(pluginsRoot).flatMap(({ file, source }) => missingCopy(source, file)).sort(byPlace)
}

// The baseline is one `file:line:key` string per bare draw, sorted; a fix deletes its entry and
// the set may only shrink.
export function baselineOf(entries) {
  return [...new Set(entries.map(entry => `${entry.file}:${entry.line}:${entry.key}`))].sort()
}

const flagValue = name => {
  const at = process.argv.indexOf(name)
  return at < 0 ? null : process.argv[at + 1]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = process.argv.includes('--missing')
  const entries = missing ? scanMissing() : scanPlugins()
  const write = flagValue('--write')
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ version: 1, entries: baselineOf(entries) }, null, 2))
  } else if (write) {
    writeFileSync(write, `${JSON.stringify({ version: 1, entries: baselineOf(entries) }, null, 2)}\n`)
    console.log(`wrote ${entries.length} entries to ${write}`)
  } else {
    for (const entry of entries) console.log(`${entry.file}:${entry.line}: ${JSON.stringify(entry.key)}`)
    const what = missing ? 'drawn copy strings with no zh entry' : 'bare draws'
    console.log(`${entries.length} ${what} in ${new Set(entries.map(entry => entry.file)).size} files`)
  }
}
