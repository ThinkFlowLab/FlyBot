// The identity key for a visible name (#2691, #2692), in one place so the host, a shared module and
// a name that is also a file name cannot drift apart. Both canonical spellings (NFC and NFD) of one
// visible name are one key, and so are the invisible format characters `trim()` keeps. The NFC pass
// runs again after lowercasing because a lower can compose a new sequence (U+0130).
import { stripInvisible } from './mentions.js'

export const nameKey = value => stripInvisible(String(value ?? '').normalize('NFC')).trim().toLowerCase().normalize('NFC')
