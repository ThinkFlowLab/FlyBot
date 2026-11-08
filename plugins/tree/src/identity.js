// The identity key for a Bot name, the same rule as core/src/shared/identity.js (#2692). This
// plugin ships as its own package, so it cannot import the core module; test/identity.test.js holds
// the two copies to the same answers. Both canonical spellings (NFC and NFD) of one visible name
// are one key, and so are the invisible format characters `trim()` keeps. The NFC pass runs again
// after lowercasing because a lower can compose a new sequence (U+0130).
export const nameKey = value => String(value ?? '').normalize('NFC').replace(/\p{Cf}/gu, '').trim().toLowerCase().normalize('NFC')
