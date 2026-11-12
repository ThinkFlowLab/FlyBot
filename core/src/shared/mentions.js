// "@Name" is read by one rule everywhere: the group host picks who answers with it,
// and the client draws the same mentions in the bubbles, so what the user sees called
// is what gets called. Pure, so both sides import it.

export const ALL_WORDS = ['all', 'everyone', '所有人', '全体']
// A letter, digit, "_" or "-" after a name means a longer word ("@Mi" in "@MiniMax"),
// and "/", "\" or a "." that goes on into a word mean a path: DSH writes a file
// reference as "@docs/guide.md", which must not call a Bot named Docs. A letter,
// digit, "_", "." or "/" before "@" means an address ("a@b", "medium.com/@Writer").
const NAME_GOES_ON = /^(?:[a-z0-9_\-/\\]|\.[a-z0-9_-])/i
const ADDRESS_BEFORE = /[a-z0-9_./]/i
// Code and Markdown links, with or without a title, are literal text.
const LITERAL = /```[\s\S]*?(?:```|$)|`[^`\n]*`|\[[^\]\n]*\]\([^)\s]*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/g

const fitsAt = (text, at, word) => text.slice(at, at + word.length).toLowerCase() === word.toLowerCase()
  && !NAME_GOES_ON.test(text.slice(at + word.length))
const overlaps = (spans, start, end) => spans.some(span => start < span.end && span.start < end)

// A name can carry characters that cannot be seen: the Unicode format characters (Cf) —
// zero-width space / non-joiner / joiner, the byte-order mark, soft hyphen, the bidi
// controls — and `trim()` removes no character that is not White_Space. The identity key
// (#2691) drops them, and a stored name drops them too, so what is saved is what is shown.
export const stripInvisible = value => String(value ?? '').replace(/\p{Cf}/gu, '')

// What draws nothing wherever it sits is an explicit list, not a Unicode class (#2935): a
// combining mark is drawn by the letter it sits on — `กิ` and `กี` are two names on screen — so
// only the code points with no glyph of their own belong here: the combining grapheme joiner, the
// Hangul fillers (U+115F, U+1160, U+3164, and the halfwidth U+FFA0), the Khmer inherent vowels, the
// Mongolian free variation selectors (U+180B–U+180D, U+180F), the braille blank, and the variation
// selectors (U+FE00–U+FE0F, U+E0100–U+E01EF). The format characters (Cf) go earlier, in
// `stripInvisible`. These characters are never stripped out of a stored name; the drawn form of a
// name removes them for comparison only (#2935, `drawnKey`). The ranges are numbers rather than a
// character class of their own, so a combining mark in the source cannot merge with a neighbour.
const NOT_DRAWN_RANGES = [
  [0x034f, 0x034f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180d], [0x180f, 0x180f],
  [0x2800, 0x2800], [0x3164, 0x3164], [0xffa0, 0xffa0], [0xfe00, 0xfe0f], [0xe0100, 0xe01ef],
]
// Matched with `replace` alone — never `test` or `exec`, which would carry `lastIndex` between
// callers.
export const NOT_DRAWN = new RegExp(`[${NOT_DRAWN_RANGES.map(([from, to]) =>
  `\\u{${from.toString(16)}}${to === from ? '' : `-\\u{${to.toString(16)}}`}`).join('')}]`, 'gu')

// What a name may not consist of (#2879): `NOT_DRAWN` plus the marks and separators that draw
// nothing on their own, which `stripInvisible` and `trim()` may keep. Wider than `drawnKey` on
// purpose — a mark beside a letter draws, but a name made only of marks draws nothing.
const DRAWS_NOTHING = /[\p{Mn}\p{Me}\p{Zs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/gu

// What a Bot may be named: something "@" can call without a second reading. A name made
// only of characters that draw nothing reads as no name at all (#2879).
export function nameProblem(name) {
  const text = stripInvisible(name).trim()
  if (text === '' || text.replace(DRAWS_NOTHING, '').trim() === '') return 'A Bot needs a name'
  if (/[@`\r\n]/.test(text)) return 'A Bot name cannot contain @, ` or a line break'
  if (ALL_WORDS.includes(text.toLowerCase())) return `"${text}" calls everyone in a group, so it cannot be a Bot name`
  return undefined
}

// DSH writes each referenced conversation into the message once as "@label"; that one
// occurrence per listed label is a reference, not a call. Longest labels go first so
// "@K notes" is never read as the label "K".
export function referenceSpans(text, labels = []) {
  const spans = []
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    const mention = `@${label}`
    for (let at = text.indexOf(mention); at !== -1; at = text.indexOf(mention, at + 1)) {
      const end = at + mention.length
      if ((at > 0 && ADDRESS_BEFORE.test(text[at - 1])) || NAME_GOES_ON.test(text.slice(end)) || overlaps(spans, at, end)) continue
      spans.push({ start: at, end, label })
      break
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

// Every "@Name" and "@all" outside code, links and references, in order. Longest names
// match first, so "@新 Bot 2" is never "@新 Bot"; a name may hold spaces.
export function mentionSpans(text, bots, { references = [] } = {}) {
  const value = String(text ?? '')
  const skip = [
    ...[...value.matchAll(LITERAL)].map(match => ({ start: match.index, end: match.index + match[0].length })),
    ...referenceSpans(value, references),
  ]
  const byLength = bots.filter(bot => bot?.name).sort((a, b) => b.name.length - a.name.length)
  const spans = []
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if ((at > 0 && ADDRESS_BEFORE.test(value[at - 1])) || overlaps(skip, at, at + 1)) continue
    const bot = byLength.find(candidate => fitsAt(value, at + 1, candidate.name))
    const all = bot ? undefined : ALL_WORDS.find(word => fitsAt(value, at + 1, word))
    if (!bot && !all) continue
    const end = at + 1 + (bot ? bot.name.length : all.length)
    spans.push(bot ? { start: at, end, bot } : { start: at, end, all: true })
    at = end - 1
  }
  return spans
}

// The "@" words that name nobody: same scan as mentionSpans, for a hint that an @ went nowhere
// (#287). "@" in code, links, references and addresses is not a mention and is not listed.
export function unmatchedMentions(text, bots, { references = [] } = {}) {
  const value = String(text ?? '')
  const skip = [
    ...[...value.matchAll(LITERAL)].map(match => ({ start: match.index, end: match.index + match[0].length })),
    ...referenceSpans(value, references),
  ]
  const byLength = bots.filter(bot => bot?.name).sort((a, b) => b.name.length - a.name.length)
  const missing = []
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if ((at > 0 && ADDRESS_BEFORE.test(value[at - 1])) || overlaps(skip, at, at + 1)) continue
    const bot = byLength.find(candidate => fitsAt(value, at + 1, candidate.name))
    const all = bot ? undefined : ALL_WORDS.find(word => fitsAt(value, at + 1, word))
    if (bot || all) { at += 1 + (bot ? bot.name.length : all.length) - 1; continue }
    const word = /^[^\s@,，。.!?！？:：;；、()（）"'“”]{1,40}/.exec(value.slice(at + 1))?.[0]
    if (word) missing.push(`@${word}`)
  }
  return missing
}
