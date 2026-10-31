// Pure text helpers shared by the host modules: message text, names, model refs,
// cutting and estimating text, and the clock format of chat anchors.
import { COLORS, EXTRA_COLORS, LEGACY_COLORS, OWN_CHAT_LINE_MAX } from './constants.js'
import { codePointEnd, codePointStart, cut } from '../shared/text-boundary.js'

export { cut }

// A color id saved under its legacy name reads as the current one.
export const currentColor = color => (typeof color === 'string' && Object.hasOwn(LEGACY_COLORS, color) ? LEGACY_COLORS[color] : color)
export const isColor = color => typeof color === 'string' && (COLORS.includes(color) || EXTRA_COLORS.includes(color) || /^#[0-9a-f]{6}$/i.test(color))

export const splitRef = (ref) => {
  const index = typeof ref === 'string' ? ref.indexOf('/') : -1
  return index > 0 ? { provider: ref.slice(0, index), model: ref.slice(index + 1) } : undefined
}

export const textOf = content => (Array.isArray(content) ? content : [])
  .filter(block => block?.type === 'text' && typeof block.text === 'string')
  .map(block => block.text)
  .join('\n')
  .trim()

export const normalize = value => String(value ?? '').trim().toLowerCase()

export const unquote = text => String(text ?? '').trim().replace(/^["'“”「『《]+|["'“”」』》]+$/g, '').trim()

export const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The host bounds this change counts go through it (#1895): one character costs one
// whatever its UTF-16 width, so an emoji inside a 300-character bound is one character,
// not two.
export const codePoints = (text) => {
  const value = String(text)
  let n = 0
  // A code point is one or two UTF-16 units; step by that width so no array is built.
  for (let i = 0; i < value.length; n += 1) i += value.codePointAt(i) > 0xffff ? 2 : 1
  return n
}

// A cut moves back onto a code point boundary (#1642 client side, #1912 here, #1916 shared): half of
// a surrogate pair reaches a UTF-8 encoder as U+FFFD, so a clipped emoji shows up as a replacement
// character at every exit. The boundary rule itself lives in `shared/text-boundary.js`, because a
// shared label (`shared/remote-label.js`) bounds a peer name too and must not import this module.

// The part of a long message around the first match, so a search hit stays visible.
export const excerpt = (text, wanted, max = OWN_CHAT_LINE_MAX) => {
  if (text.length <= max) return text
  const found = wanted === '' ? 0 : Math.max(0, text.toLowerCase().indexOf(wanted) - 120)
  const at = codePointStart(text, found)
  return `${at > 0 ? '…' : ''}${text.slice(at, codePointEnd(text, at + max))}…`
}

// An upper bound: a CJK character is about one token, other text about a third.
export const estimateTokens = (text) => {
  let tokens = 0
  for (const char of text) tokens += char.codePointAt(0) > 0x2e7f ? 1 : 0.34
  return Math.ceil(tokens)
}
export const clip = (text, max, rest) => (text.length > max ? `${text.slice(0, codePointEnd(text, max))}… (cut; ${rest})` : text)

export const createClock = (timeZone) => {
  const clockFormat = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone ? { timeZone } : {}),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  return time => (Number.isFinite(time) ? clockFormat.format(time).replace(',', '') : '?')
}
