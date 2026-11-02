// One reading of DEEPSEEK_API_KEY for the three places that judge it: the CI preflight that decides
// whether any step runs (#794), the bench starter, and the run guard. They disagreed — the preflight
// took any non-empty string, the other two refused a key under 16 characters or the mock's — so a
// short or mock key published `key=true`, started the bench and failed the night for exactly the
// reason the skip exists to avoid. A key present but unusable is skipped like a missing one, with
// its own warning, so the skip never reads as a pass and nobody has to read a red log to find it.
export const MIN_LENGTH = 16
export const MOCK_KEY = 'mock-key'

export function keyReading(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (key === '') return { usable: false, reason: 'missing' }
  if (key === MOCK_KEY) return { usable: false, reason: 'mock' }
  if (key.length < MIN_LENGTH) return { usable: false, reason: 'short' }
  return { usable: true, reason: null }
}

// The verdict in words, shared so the three readers cannot drift apart in what they say.
export function keyProblem(reason) {
  if (reason === 'missing') return 'is missing'
  if (reason === 'mock') return "is the mock's key"
  return `is shorter than ${MIN_LENGTH} characters`
}
