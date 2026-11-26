// The text side of the comment guard: markers, fingerprints, similarity. No network, no writes.
import { createHash } from 'node:crypto'

// 0.80, not 0.85: on the replay fixture the weakest real duplicate (B class, the same event said
// twice with one more number) is 0.861, while the highest pair that is genuinely different is 0.233.
// 0.85 left 0.011 of margin - deleting three sentences from a real duplicate dropped it to 0.771 and
// the guard went quiet. 0.80 misses neither and still cannot reach the negative pairs.
export const FUZZY_THRESHOLD = 0.8
const MARKERS = /<!--[^>]*-->/g
const EVENT_MARKER = /<!--\s*flybot:([^>\s]+)\s*-->/g

export const markerFor = (event) => `<!-- flybot:${event} -->`
// Every HTML comment is bookkeeping we wrote, never part of the sentence a human wrote.
export const markersIn = (body) => [...String(body ?? '').matchAll(EVENT_MARKER)].map((m) => m[1])
export const stripMarkers = (body) => String(body ?? '').replace(MARKERS, '').trimEnd()
export const sha256 = (s) => createHash('sha256').update(s).digest('hex')
// Two comments say the same thing when their text agrees once our own markers are removed:
// a marker is 38 bytes of bookkeeping, never part of the sentence.
export const bodyKey = (body) => sha256(stripMarkers(body).trim())

const normalize = (body) => stripMarkers(body).toLowerCase()
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/[^0-9a-z\u4e00-\u9fff]+/g, ' ')
  .trim()
const grams = (body) => {
  const text = normalize(body).replace(/ /g, '')
  const set = new Set()
  for (let i = 0; i + 3 <= text.length; i++) set.add(text.slice(i, i + 3))
  return set
}

// Dice-free Jaccard over 3-grams: cheap, and it does not care about wording order.
export function similarity(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const g of A) if (B.has(g)) shared++
  return shared / (A.size + B.size - shared)
}

// Duplicate detection stays inside one object: the close template is shared by every object, so
// comparing across objects would mark 91 of 94 pairs as duplicates (measured on the replay fixture).
export function auditComments(comments, { threshold = FUZZY_THRESHOLD } = {}) {
  const kept = []
  const duplicates = []
  for (const c of comments ?? []) {
    const id = c.id ?? null
    const body = String(c.body ?? '')
    const key = bodyKey(body)
    const twin = kept.find((k) => k.key === key || similarity(k.body, body) >= threshold)
    if (!twin) kept.push({ id, body, key })
    else duplicates.push({
      id,
      first_comment_id: twin.id,
      why: twin.key === key ? 'same text once the marker is removed' : `text ${similarity(twin.body, body).toFixed(3)} similar`,
    })
  }
  return {
    duplicate: duplicates.length > 0,
    first_comment_id: duplicates[0]?.first_comment_id ?? kept[0]?.id ?? null,
    duplicate_comment_ids: duplicates.map((d) => d.id),
    details: duplicates,
  }
}
