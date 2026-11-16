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
// `missingCopy` has a second view over the same file: copy a helper hands back (#P-800), because a
// helper's answer has no draw position of its own — `return cond ? 'the room' : 'friend'` draws
// English in a zh window with every check green. That view is described where it is built, below.
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
      // The names a `${}` hole mentions: the hole's code is not tokenised, but a local interpolated
      // here is read by the reader all the same (`${keepLine}` draws the sentence that local holds).
      const holes = []
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\') {
          const [each, next] = escapeAt(source, index)
          value += each
          index = next
          continue
        }
        if (source[index] === '$' && source[index + 1] === '{') {
          substituted = true
          // One marker per hole, so the report names the copy a reader sees around it and the
          // expressions stay out of the key (they are code, not a placeholder name).
          value += '{}'
          let depth = 1
          index += 2
          while (index < source.length && depth > 0) {
            if (source[index] === '{') depth += 1
            else if (source[index] === '}') depth -= 1
            else if (source[index] === '\n') line += 1
            else if (isIdent(source[index])) {
              let name = ''
              while (index < source.length && isIdent(source[index])) { name += source[index]; index += 1 }
              holes.push(name)
              continue
            }
            index += 1
          }
          continue
        }
        if (source[index] === '\n') line += 1
        value += source[index]
        index += 1
      }
      index += 1
      place(substituted ? { type: 'string', value, substituted: true, holes } : { type: 'string', value })
      previous = 'string'
      lastValue = value
      continue
    }
    if (isIdent(ch)) {
      let name = ''
      while (index < source.length && isIdent(source[index])) { name += source[index]; index += 1 }
      let next = index
      while (next < source.length && /\s/.test(source[next])) next += 1
      const called = source[next] === '('
      if (called && (name === 'tr' || name === 't' || name === 'hostText' || name === 'h')) {
        calls.push({ kind: name, arg: 0, obj: 0, key: null })
      }
      place({ type: 'ident', value: name, called })
      previous = name
      lastValue = name
      continue
    }
    if (ch === '(' || ch === '[') {
      place({ type: 'punct', value: ch })
      if (!(previous === 'tr' || previous === 't' || previous === 'hostText' || previous === 'h')) calls.push({ kind: 'other', arg: 0, obj: 0, key: null })
      previous = '('
      index += 1
      continue
    }
    if (ch === ')') { place({ type: 'punct', value: ')' }); calls.pop(); previous = ')'; index += 1; continue }
    if (ch === ']') { place({ type: 'punct', value: ']' }); if (current()?.kind === 'other') calls.pop(); previous = ']'; index += 1; continue }
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
    if (value.type !== 'string' || value.substituted || value.obj !== equals.obj) continue
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
    // A template literal with a `${}` hole has no dictionary key to compare with: it is reported
    // by `templateDraws`, and both keyed scans stay exactly as wide as they were (#3040).
    if (token.substituted) continue
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
// ones a plugin actually reads copy from — a `*_COPY` / `*_TEXT` table value, `text:` (below), and
// the `h(...)` copy attributes. The attribute set is one definition, not a second hand-copied list:
// every COPY_ATTRS member plus `hint`, the caption a card or field draws under itself (#3007).
// Widening from `label`+`hint` to the full set added 27 pins on main 3caf20dc — title 11,
// aria-label 15, placeholder 3, and 0 for alt, aria-description and aria-placeholder; the
// per-attribute total of 29 overcounts by two, because two sentences are drawn through two
// attributes at once and pin once (#3009).
//
// Two `placeholder` values on main name an example of the expected input rather than a sentence a
// reader translates (`https://social.example`, `github, composio`); those are data, not copy. The
// set is exactly these two literals, so a future example-looking placeholder is still reported
// instead of being swallowed by a pattern. A value that is already translated (`t('…')`,
// `tr('…')`), a comparison operand, an object key and the `', '` join delimiter stay out for the
// same reason.
const MISSING_ATTRS = new Set([...COPY_ATTRS, 'hint'])
const EXAMPLE_PLACEHOLDERS = new Set(['https://social.example', 'github, composio'])

// A decorative literal is a shape, not a sentence: the `×` on a close button, the `▾` on a
// disclosure, a bare `1`, a ` · ` separator. Copy a reader translates always carries a letter, so
// the test is "no letter at all" — one shape rule, not a list of glyphs that a new one escapes and
// not a length pattern that would also swallow `Ok` (#3028). The same rule applies to every draw,
// table, `text:` and attribute alike, and no pin on main is a letterless value.
const decoration = key => !/\p{L}/u.test(key)

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
    // See `bareCopy`: a substituted template is `templateDraws`' business, not this scan's.
    if (token.substituted) continue
    const before = list[at - 1]
    const after = list[at + 1]
    if (before?.type === 'punct' && COMPARISONS.has(before.value)) continue
    if (after?.type === 'punct' && COMPARISONS.has(after.value)) continue
    if (token.obj > 0 && after?.type === 'punct' && after.value === ':') continue
    const inTable = tables.some(body => at > body.start && at < body.end)
    const inProps = token.call === 'h' && token.obj > 0 && MISSING_ATTRS.has(token.prop)
    // An `h()` child node is copy the same way an attribute is: `h('button', { … }, 'Decline')`
    // draws the label a reader sees, and the attribute half of the scan already pins the same
    // sentence when it is spelled `title:`. `renderChild` is the one definition, shared with
    // `bareCopy`, so the two views cannot drift (#3028).
    const inChild = renderChild(token)
    if (!inTable && !inProps && !copyValue(list, at) && !inChild) continue
    // Inside a table only a direct value counts; a nested call or function body is not one.
    if (inTable && !(before?.type === 'punct' && before.value === ':')) continue
    const key = token.type === 'string' ? token.value : bound.get(token.value)
    if (key === undefined || key === '' || key === ', ') continue
    if (token.prop === 'placeholder' && EXAMPLE_PLACEHOLDERS.has(key)) continue
    if (decoration(key)) continue
    if (Object.hasOwn(dictionary, key)) continue
    entries.push({ file, line: token.line, key })
  }
  // One entry point for both views: a copy table is a draw position and so is a helper's answer, and
  // a caller of this scan wants the gap, not the shape it was written in.
  return [...entries, ...helperCopy(source, file, dictionary)]
}

// The third place copy hides: what a helper hands back (main 9b45c95e, measured by Product). The
// two scans above read a draw position and a table value, `templateDraws` reads a `${}` hole, and
// none of them can read `return cond ? 'the room' : 'friend'` — five such sites in
// `plugins/social/client.js` draw English in a zh window while every check is green. The rule here
// is the one `templateBindings` already applies to a `const`, carried to what a helper yields: a
// literal, or an expression built from literals by `? :`, `||` and parentheses, is copy. A call's
// arguments are not a yield — `readableParty(to, 'friend')` hands `'friend'` to another helper, and
// what that helper does with it is a different question — and nothing nested inside a call is
// reached, so an `h(...)` full of attributes stays the draw scan's business.
//
// A helper counts only when it is **drawn**: its call sits where a reader sees the result (an `h()`
// child, a copy attribute, a `text:` prop), a local it is assigned to is drawn, or it is rendered as
// `h(Component, …)`. Without that test the machine ids would pin as untranslated sentences —
// `faceChip`'s `'closed'` / `'left'`, the SVG path data in workflow's chart builder, timeline's
// duration units — values a reader never sees as copy. The discriminator is the one `missingCopy`
// already applies to a table: where the value ends up, not what it looks like.
//
// A value of one token — no space, and carrying `- _ . / : #` — is a CSS class, a selector, a URL or
// an id, not a sentence: `fs-hint`, `remote:{}`, `https://…`. Same reason as `decoration`: a string
// alone cannot say what it is, its shape can.
const DECLARES = new Set(['const', 'let', 'var'])
const CONTINUE_LINE = new Set(['?', ':', '.', '+', '-', '*', '/', '&&', '||', '='])
const HELPER_TOKEN_SHAPE = /[-_.:/#]/
const singleToken = key => !/\s/.test(key) && HELPER_TOKEN_SHAPE.test(key)

const matchingBrace = (list, open) => {
  let depth = 0
  for (let at = open; at < list.length; at += 1) {
    if (list[at].type !== 'punct') continue
    if (list[at].value === '{') depth += 1
    else if (list[at].value === '}') { depth -= 1; if (depth === 0) return at }
  }
  return -1
}

// The `{` that opens a `function name(…)` body: parens around the parameters are skipped, so a
// default value's own object literal cannot be mistaken for the body.
const bodyBrace = (list, from) => {
  let depth = 0
  for (let at = from; at < list.length; at += 1) {
    const token = list[at]
    if (token.type !== 'punct') continue
    if (token.value === '(') depth += 1
    else if (token.value === ')') depth -= 1
    else if (token.value === '{' && depth === 0) return at
  }
  return -1
}

// The token after `=>` in `const name = … => …`, or -1 when the initializer is not an arrow.
const arrowAt = (list, from) => {
  let depth = 0
  for (let at = from; at < list.length; at += 1) {
    const token = list[at]
    if (token.type === 'ident' && depth === 0 && STATEMENT.has(token.value) && at > from) return -1
    if (token.type !== 'punct') continue
    if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1
    else if (token.value === ')' || token.value === ']' || token.value === '}') { depth -= 1; if (depth < 0) return -1 }
    else if (depth === 0 && (token.value === ';' || token.value === ',')) return -1
    // `=>` is one token: the walker combines it before it reaches the list.
    else if (depth === 0 && token.value === '=>') return at + 1
  }
  return -1
}

// A helper a reader can name: `function name(…) { … }` and `const name = (…) => …`. An anonymous
// callback is not one — nothing else can hand its value to a draw.
function helperBodies(list) {
  const bodies = []
  for (let at = 0; at < list.length; at += 1) {
    const token = list[at]
    if (token.type !== 'ident') continue
    if (token.value === 'function') {
      let nameAt = at + 1
      if (list[nameAt]?.value === '*') nameAt += 1
      const name = list[nameAt]
      if (name?.type !== 'ident') continue
      const open = bodyBrace(list, nameAt + 1)
      if (open < 0) continue
      const close = matchingBrace(list, open)
      if (close > 0) bodies.push({ name: name.value, start: open, end: close, expression: false })
      continue
    }
    if (!DECLARES.has(token.value)) continue
    const name = list[at + 1]
    if (name?.type !== 'ident' || list[at + 2]?.value !== '=') continue
    const arrow = arrowAt(list, at + 3)
    if (arrow < 0) continue
    if (list[arrow]?.value === '{') {
      const close = matchingBrace(list, arrow)
      if (close > 0) bodies.push({ name: name.value, start: arrow, end: close, expression: false })
    } else {
      // An expression body ends at its own line, `,` or `;`; `expressionRun` finds that.
      bodies.push({ name: name.value, start: arrow, end: list.length, expression: true })
    }
  }
  return bodies
}

// The helpers whose value a reader sees: a call at a draw position, a drawn local it is assigned
// to, or a component handed to `h(...)`. One level of assignment, because `const usage = roomHint(…)`
// followed by `usage.text` is how the caller reads it.
function drawnHelpers(list) {
  const drawn = new Set()
  const handed = new Map()
  for (let at = 0; at + 3 < list.length; at += 1) {
    if (!DECLARES.has(list[at].value)) continue
    const name = list[at + 1]
    if (name?.type !== 'ident' || list[at + 2]?.value !== '=') continue
    for (let each = at + 3; each < list.length; each += 1) {
      const token = list[each]
      if (each > at + 3 && token.line !== list[each - 1].line) break
      if (token.type === 'ident' && token.called) { handed.set(name.value, token.value); break }
      if (token.type !== 'ident') break
    }
  }
  for (let at = 0; at < list.length; at += 1) {
    const token = list[at]
    if (token.type !== 'ident') continue
    const inCopyProp = token.call === 'h' && token.obj > 0 && MISSING_ATTRS.has(token.prop)
    const component = token.call === 'h' && token.obj === 0 && token.arg === 0 && !token.called
    if (renderChild(token) || inCopyProp || copyValue(list, at) || component) drawn.add(token.value)
  }
  for (const [local, helper] of handed) if (drawn.has(local)) drawn.add(helper)
  return drawn
}

// The expression a statement or an arrow body hands back, up to the end of that statement.
function expressionRun(list, from, limit) {
  const run = []
  let depth = 0
  for (let at = from; at < limit; at += 1) {
    const token = list[at]
    const previous = list[at - 1]
    if (at > from && depth === 0 && token.line !== previous.line
      && !CONTINUE_LINE.has(token.value) && !CONTINUE_LINE.has(previous.value)) break
    if (token.type === 'ident' && depth === 0 && STATEMENT.has(token.value) && at > from) break
    if (token.type === 'punct') {
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1
      else if (token.value === ')' || token.value === ']' || token.value === '}') { if (depth === 0) break; depth -= 1 }
      else if (depth === 0 && (token.value === ';' || token.value === ',')) break
    }
    run.push(token)
  }
  return run
}

// Every literal an expression is built from at its own level: `cond ? 'a' : 'b'`, `name || 'b'`,
// `('You')`. A part that is a call or a member read is not a literal and is skipped rather than
// opened — that is what keeps a helper's arguments out of this scan.
function literalsOf(run) {
  const literals = []
  const parts = [[]]
  let depth = 0
  // `||` and `&&` are two single-character tokens, not one: the walker emits the operator it sees.
  const split = new Set(['?', ':', '|', '&', '+'])
  for (let at = 0; at < run.length; at += 1) {
    const token = run[at]
    if (token.type === 'punct') {
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth -= 1
      // `?.` is optional chaining, not the start of a ternary.
      else if (depth === 0 && split.has(token.value) && run[at + 1]?.value !== '.') { parts.push([]); continue }
    }
    parts[parts.length - 1].push(token)
  }
  for (const part of parts) {
    const bare = part.filter(token => !(token.type === 'punct' && (token.value === '(' || token.value === ')')))
    if (bare.length === 1 && bare[0].type === 'string') { literals.push(bare[0]); continue }
    // A parenthesised group is the same expression one level in: `… || (cond ? 'You' : 'Someone')`.
    if (part.length >= 2 && part[0].value === '(' && part[part.length - 1].value === ')') {
      literals.push(...literalsOf(part.slice(1, -1)))
    }
  }
  return literals
}

// Every literal a helper hands back: a `return`, the arrow's expression body, and a `const` the
// helper reads again afterwards (that is how it builds the sentence: `head + pick.join(', ')`).
function yieldedLiterals(list, body) {
  // An expression body is a value, the same way a local is: `friend => friend?.id || 'share'` hands
  // back a key, so only a sentence counts there. A `return` in a block keeps its bare words — that is
  // where a helper answers `'Closed'` or `'Joining'`.
  if (body.expression) {
    return literalsOf(expressionRun(list, body.start, Math.min(body.start + 400, list.length)))
      .filter(each => each.substituted || /\s/.test(each.value))
  }
  const literals = []
  for (let at = body.start; at < body.end; at += 1) {
    const token = list[at]
    if (token.type === 'ident' && token.value === 'return') {
      literals.push(...literalsOf(expressionRun(list, at + 1, body.end)))
      continue
    }
    if (!DECLARES.has(token.value)) continue
    const name = list[at + 1]
    if (name?.type !== 'ident' || list[at + 2]?.value !== '=') continue
    const values = literalsOf(expressionRun(list, at + 3, body.end))
    if (!values.length) continue
    const rest = list.slice(at + 3, body.end)
    // The name must be read again — that is how the helper builds its sentence — and must not be
    // compared: `side === 'below'` says the local holds a machine id, not the words on the label.
    const readPlain = rest.some(each => each.type === 'ident' && each.value === name.value)
    // A name interpolated into a template is read just as plainly as one passed as an argument:
    // `${keepLine}` puts the sentence that local holds on the screen. A hole has no room for a bare
    // word, though — the sentence around it says what the value means — so only a sentence (a
    // substituted template) counts when the hole is the only place the name is read.
    const readInHole = rest.some(each => each.type === 'string' && Array.isArray(each.holes) && each.holes.includes(name.value))
    const used = readPlain || readInHole
    const comparedName = rest.some((each, index) => each.type === 'ident' && each.value === name.value
      && rest[index - 1]?.value !== '.'
      && ((rest[index - 1]?.type === 'punct' && COMPARISONS.has(rest[index - 1].value))
        || (rest[index + 1]?.type === 'punct' && COMPARISONS.has(rest[index + 1].value))))
    // A local is only half a sentence: `|| 'share'` is the last resort key of a lookup, not words on
    // the screen, so a bare word from a local has to be spelled as a sentence (`'the room'`, a
    // template with a hole) to count. A helper's own `return 'Closed'` is not filtered this way.
    const sentence = values.filter(each => readPlain ? each.substituted || /\s/.test(each.value) : each.substituted)
    if (used && !comparedName) literals.push(...sentence)
  }
  return literals
}

// A value the file compares against is a machine value, not copy: timeline's `'below'`, `'right'`
// and `'left'` decide where a label is printed, and workflow's `'failed'` is a class name, but both
// are written as a literal a helper hands back. The comparison is the file's own statement that the
// string is data, so the scan reads it rather than guessing from the spelling.
function comparedValues(list) {
  const values = new Set()
  for (let at = 0; at < list.length; at += 1) {
    const token = list[at]
    if (token.type !== 'string') continue
    const before = list[at - 1]
    const after = list[at + 1]
    const compared = (before?.type === 'punct' && COMPARISONS.has(before.value))
      || (after?.type === 'punct' && COMPARISONS.has(after.value))
      || (before?.type === 'ident' && before.value === 'case')
    if (compared) values.add(token.value)
  }
  return values
}

// Copy a helper hands to a reader with no zh entry. Its own view of the same walk, so
// `missingCopy` keeps reading draw positions only and neither view can rewrite the other.
function helperCopy(source, file, dictionary = DICTIONARY.zh) {
  const list = tokens(source)
  const drawn = drawnHelpers(list)
  const compared = comparedValues(list)
  const entries = []
  for (const body of helperBodies(list)) {
    if (!drawn.has(body.name)) continue
    for (const token of yieldedLiterals(list, body)) {
      const key = token.value
      if (key === '' || key === ', ') continue
      if (decoration(key)) continue
      if (singleToken(key)) continue
      if (compared.has(key)) continue
      if (Object.hasOwn(dictionary, key)) continue
      entries.push({ file, line: token.line, key })
    }
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
// nothing can translate it at all (#3002). Two views over one file — a draw position, and what a
// helper hands back — because a helper's copy has no draw position of its own.
export function scanMissing(pluginsRoot = new URL('../plugins/', import.meta.url)) {
  return pluginClients(pluginsRoot).flatMap(({ file, source }) => missingCopy(source, file)).sort(byPlace)
}

// The third view of the same walk: copy drawn as a template literal with a `${}` hole, which no
// dictionary key can name (#3040).
export function scanTemplateDraws(pluginsRoot = new URL('../plugins/', import.meta.url)) {
  return pluginClients(pluginsRoot).flatMap(({ file, source }) => templateDraws(source, file)).sort(byPlace)
}

// Copy a plugin draws through a template literal with a `${}` hole (#3040). `h('span', {}, `superseded
// by ${id}`)` has no dictionary key the two scans above could match and no `tr()` call to find, so the
// English stays in a zh window while both checks are green — #3040 shipped that way and only a reader
// noticed. The draw is reported where copy is read (a child node, a copy attribute, a `text:` prop, a
// copy table value), with one `{}` per hole, so the fix has one shape: `tr('superseded by {id}', { id })`.
// A substituted template can reach the reader through a name: `const approveAllTitle = cond ?
// `…${n} 条 · to ${who}` : `…${n} 条`` is drawn by `h('button', { title: approveAllTitle })`. The
// literal sits in an assignment, where none of the positions below can place it, and the name is
// what a reader is told. Only an assignment whose value is a template, or a ternary between
// templates, binds: `const bars = g.bars.map(bar => h(…))` also carries templates inside it, and
// none of them is what `bars` draws (#3049).
const STATEMENT = new Set(['const', 'let', 'var', 'return', 'if', 'for', 'while', 'switch', 'function', 'class', 'case', 'else', 'do', 'try', 'throw'])
// A line that starts with one of these continues the assignment above it, so the statement walk
// below must not stop at the line break.
const CONTINUATION = new Set(['?', ':', '.', '+', '-', '*', '/', '&&', '||', '='])

function templateBindings(list) {
  const bound = new Map()
  for (let at = 0; at + 3 < list.length; at += 1) {
    const keyword = list[at]
    const name = list[at + 1]
    const equals = list[at + 2]
    if (keyword.type !== 'ident' || !['const', 'let', 'var'].includes(keyword.value)) continue
    if (name.type !== 'ident' || equals.type !== 'punct' || equals.value !== '=') continue
    const segment = []
    let depth = 0
    for (let each = at + 3; each < list.length; each += 1) {
      const token = list[each]
      const previous = list[each - 1]
      if (depth === 0 && each > at + 3 && token.line !== previous.line
        && !CONTINUATION.has(token.value) && !CONTINUATION.has(previous.value)) break
      if (token.type === 'punct') {
        if (token.value === '(' || token.value === '[' || token.value === '{') { segment.push({ token, depth }); depth += 1; continue }
        if (token.value === ')' || token.value === ']' || token.value === '}') {
          if (depth === 0) break
          depth -= 1
          segment.push({ token, depth })
          continue
        }
        if (depth === 0 && token.value === ',') break
      }
      if (depth === 0 && token.type === 'ident' && STATEMENT.has(token.value)) break
      segment.push({ token, depth })
    }
    const question = segment.findIndex(entry => entry.depth === 0 && entry.token.type === 'punct' && entry.token.value === '?')
    const whole = text => text.type === 'string' && text.substituted
    if (question < 0) {
      if (segment.length === 1 && whole(segment[0].token)) bound.set(name.value, [{ line: segment[0].token.line, key: segment[0].token.value }])
      continue
    }
    const branches = segment.slice(question + 1).map(entry => entry.token)
    const literal = branches.every(token => whole(token) || (token.type === 'punct' && ['?', ':', '(', ')'].includes(token.value)))
    const values = branches.filter(whole).map(token => ({ line: token.line, key: token.value }))
    if (literal && values.length) bound.set(name.value, values)
  }
  return bound
}

export function templateDraws(source, file) {
  const list = tokens(source)
  const tables = copyTables(list)
  const bound = templateBindings(list)
  // The lines a drawn name carries: the literal is copy because the name is drawn, wherever the
  // assignment happens to sit.
  const drawnLines = new Set()
  for (let at = 0; at < list.length && bound.size; at += 1) {
    const token = list[at]
    if (token.type !== 'ident' || !bound.has(token.value)) continue
    const before = list[at - 1]
    const inTable = tables.some(body => at > body.start && at < body.end)
    const inProps = token.call === 'h' && token.obj > 0 && MISSING_ATTRS.has(token.prop)
    const inValue = inTable && before?.type === 'punct' && before.value === ':'
    if (!inProps && !inValue && !renderChild(token)) continue
    for (const value of bound.get(token.value)) drawnLines.add(value.line)
  }
  const entries = []
  for (let at = 0; at < list.length; at += 1) {
    const token = list[at]
    if (token.type !== 'string' || !token.substituted) continue
    if (translated(token)) continue
    const before = list[at - 1]
    const after = list[at + 1]
    if (before?.type === 'punct' && COMPARISONS.has(before.value)) continue
    if (after?.type === 'punct' && COMPARISONS.has(after.value)) continue
    const inTable = tables.some(body => at > body.start && at < body.end)
    const inProps = token.call === 'h' && token.obj > 0 && MISSING_ATTRS.has(token.prop)
    if (!inTable && !inProps && !copyValue(list, at) && !renderChild(token) && !drawnLines.has(token.line)) continue
    // Inside a table only a direct value counts, the same rule the missing-entry scan holds.
    if (inTable && !(before?.type === 'punct' && before.value === ':')) continue
    // The same shape rule as the scan above: with the holes spelled `{}`, a draw whose literal text
    // carries no letter is a separator or a figure, not a sentence (`\`${a} · ${b}\``).
    if (decoration(token.value)) continue
    entries.push({ file, line: token.line, key: token.value })
  }
  return entries
}

// The missing-entry baseline is keyed by where the copy lives, not by the line it happens to sit on:
// `file:key`, plus `#n` when one file draws the same key at more than one position, so a second
// position stays a second pin. An edit above a draw moves its line and nothing else, and a rebase
// that only moved lines must leave the pins alone — a line number in the key turned every such
// rebase into a whole-file rewrite (#3018, #3020). Two draws at one position (title: and
// aria-label: on one line) still pin once; the line stays in the walk's output as a hint.
export function missingPins(entries) {
  const positions = new Map()
  for (const entry of entries) {
    const at = `${entry.file}:${entry.line}:${entry.key}`
    if (!positions.has(at)) positions.set(at, entry)
  }
  const ordered = [...positions.values()].sort(byPlace)
  const totals = new Map()
  for (const entry of ordered) {
    const pair = `${entry.file}\u0000${entry.key}`
    totals.set(pair, (totals.get(pair) ?? 0) + 1)
  }
  const seen = new Map()
  return ordered.map(entry => {
    const pair = `${entry.file}\u0000${entry.key}`
    const nth = (seen.get(pair) ?? 0) + 1
    seen.set(pair, nth)
    return totals.get(pair) > 1 ? `${entry.file}:${entry.key}#${nth}` : `${entry.file}:${entry.key}`
  })
}

export function baselineOf(entries) {
  return missingPins(entries).sort()
}

// The bare-draw baseline is keyed by where the copy lives, not by the line it happens to sit on
// (#3003): `file:key`, and `#n` when one file draws the same key more than once, so the two
// "Waiting for approval" draws stay two entries. A comment inserted above a draw moves no entry;
// the line stays in the failure text as a hint and is never stored.
export function drawEntries(entries) {
  const ordered = [...entries].sort(byPlace)
  const totals = new Map()
  for (const entry of ordered) {
    const pair = `${entry.file}\u0000${entry.key}`
    totals.set(pair, (totals.get(pair) ?? 0) + 1)
  }
  const seen = new Map()
  return ordered.map(entry => {
    const pair = `${entry.file}\u0000${entry.key}`
    const nth = (seen.get(pair) ?? 0) + 1
    seen.set(pair, nth)
    const id = totals.get(pair) > 1 ? `${entry.file}:${entry.key}#${nth}` : `${entry.file}:${entry.key}`
    return { ...entry, id }
  })
}

export function drawBaselineOf(entries) {
  return [...new Set(drawEntries(entries).map(entry => entry.id))].sort()
}

// `--write` may shrink the pinned set or replace it with the same size, but never grow it: a
// larger baseline is exactly what laundering a new bare draw looks like (#3003). `--force` is the
// explicit way to accept the larger set; a missing baseline file is created, not refused.
export function writeBaseline(target, entries, { force = false, identity = drawBaselineOf } = {}) {
  const next = identity(entries)
  let previous = null
  try {
    previous = JSON.parse(readFileSync(target, 'utf8')).entries
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const before = new Set(previous ?? [])
  const after = new Set(next)
  const added = next.filter(entry => !before.has(entry))
  const removed = (previous ?? []).filter(entry => !after.has(entry))
  // Growing the set is the laundering shape; replacing one entry with another at the same size is
  // how a duplicate's survivor renumbers after one of its twins is fixed, and a shrink is a fix,
  // so only a strictly larger set is refused without `--force`.
  if (previous !== null && added.length > 0 && next.length > previous.length && !force) return { written: false, added, removed, entries: next }
  writeFileSync(target, `${JSON.stringify({ version: 1, entries: next }, null, 2)}\n`)
  return { written: true, added, removed, entries: next }
}

const flagValue = name => {
  const at = process.argv.indexOf(name)
  return at < 0 ? null : process.argv[at + 1]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = process.argv.includes('--missing')
  const templates = process.argv.includes('--template-draws')
  const entries = templates ? scanTemplateDraws() : missing ? scanMissing() : scanPlugins()
  const identity = templates || missing ? baselineOf : drawBaselineOf
  // One identity for every reader of this run: `--json` prints it, `--write` pins it and the tail
  // line counts it, so the count can never disagree with the file a reader compares it with. The
  // walk still lists each draw (two attributes on one line are two draws); the count is pins, a
  // pin is `file:key` with `#n` for a second position, and two draws at one position pin once
  // (#3017).
  const counted = identity(entries)
  const write = flagValue('--write')
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ version: 1, entries: counted }, null, 2))
  } else if (write) {
    const result = writeBaseline(write, entries, { force: process.argv.includes('--force'), identity })
    if (!result.written) {
      for (const entry of result.added) console.log(`  + ${entry}`)
      for (const entry of result.removed) console.log(`  - ${entry}`)
      console.log(`refusing to grow the baseline: +${result.added.length}/-${result.removed.length}; pass --force to accept it`)
      process.exitCode = 1
    } else {
      console.log(`wrote ${result.entries.length} entries to ${write} (+${result.added.length}/-${result.removed.length})`)
    }
  } else {
    for (const entry of entries) console.log(`${entry.file}:${entry.line}: ${JSON.stringify(entry.key)}`)
    const what = templates ? 'template draws a `${}` hole keeps out of every key' : missing ? 'drawn copy strings with no zh entry' : 'bare draws'
    console.log(`${counted.length} ${what} in ${new Set(entries.map(entry => entry.file)).size} files`)
    // The two keyed scans stay exactly as wide as they were: what they cannot judge is counted here
    // rather than silently dropped, so a reader of either report knows the size of the blind spot
    // (#3049). `--json` and `--write` keep their shape: this line is for a person.
    if (!templates) console.log(`${baselineOf(scanTemplateDraws()).length} interpolated template draws are out of scope (--template-draws)`)
  }
}
