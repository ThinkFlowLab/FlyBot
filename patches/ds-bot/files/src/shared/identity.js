// The identity key for a visible name (#2691, #2692), in one place so the host, a shared module and
// a name that is also a file name cannot drift apart. Both canonical spellings (NFC and NFD) of one
// visible name are one key, and so are the invisible format characters `trim()` keeps. The NFC pass
// runs again after lowercasing because a lower can compose a new sequence (U+0130).
import { NOT_DRAWN, stripInvisible } from './mentions.js'

export const nameKey = value => stripInvisible(String(value ?? '').normalize('NFC')).trim().toLowerCase().normalize('NFC')

// The drawn form of a name (#2935): what the screen shows, with the characters that draw nothing
// removed. `NOT_DRAWN` is the explicit list of glyph-less code points, so a combining mark stays:
// the letter under it draws it, and two names that differ there read as two names. NFC runs in
// `nameKey` first, so a mark it composes is already part of the letter. Two names with one drawn
// form read as one Bot, while `nameKey` still tells them apart and `findBot` can only reach one of
// them by an `@`; the roster refuses the second.
export const drawnKey = value => nameKey(value).replace(NOT_DRAWN, '')
