// The identity key for a visible name (#2691, #2692), in one place so the host, a shared module and
// a name that is also a file name cannot drift apart. Both canonical spellings (NFC and NFD) of one
// visible name are one key, and so are the invisible format characters `trim()` keeps. The NFC pass
// runs again after lowercasing because a lower can compose a new sequence (U+0130).
import { NOT_DRAWN, stripInvisible } from './mentions.js'

export const nameKey = value => stripInvisible(String(value ?? '').normalize('NFC')).trim().toLowerCase().normalize('NFC')

// The drawn form of a name (#2935): what the screen shows, with the characters that draw nothing
// removed. NFC runs in `nameKey` first, so a combining mark it composes is gone before this class
// could take it — the marks left here are the ones `trim()` and `\p{Cf}` keep, and they render as
// no character at all. Two names with one drawn form read as one Bot, while `nameKey` still tells
// them apart and `findBot` can only reach one of them by an `@`; the roster refuses the second.
export const drawnKey = value => nameKey(value).replace(NOT_DRAWN, '')
