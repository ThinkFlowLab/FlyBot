// A workflow node takes in and hands out typed artifacts (#1272). An artifact is a fact with a
// revision, so "is it there" and "is it current" are two questions instead of one: a verdict carries
// the SHA it judged, a check the SHA it ran on, a branch its head commit. The engine compares
// revisions and refuses a stale input; it never invents a revision, and the provider named for a
// kind is what reads the current one. Pure: no I/O, no clock, no GitHub.

export const ARTIFACT_KINDS = [
  'issue',
  'issue.ready',
  'branch',
  'pr',
  'verdict',
  'check',
  'risk',
  'mergeable',
  'merge-commit',
  'release',
  'doc',
  'file',
  'link',
  'text',
]

// A kind that carries a name (`check:tests-ok`, `text:topic`): two of them on one card are two
// different facts, so an unnamed one is not a spec.
const NAMED_KINDS = new Set(['check', 'risk', 'doc', 'file', 'link', 'text'])

// What the revision of each kind is. The engine compares revisions for equality; this table is
// what a provider reads, and what a node's refusal names when it says the input moved.
export const REVISION_RULES = {
  issue: 'the issue number, as read',
  'issue.ready': 'the labels and body the triage node saw',
  branch: 'the branch head commit SHA',
  pr: 'the pull request number and its headRefOid',
  verdict: 'the SHA the verdict names',
  check: 'the SHA the check ran on',
  risk: 'the SHA the tier was computed on',
  mergeable: 'the tip SHA it was computed against',
  'merge-commit': 'the SHA the queue wrote to main',
  release: 'the tag it published',
  doc: 'the content hash of the document',
  file: 'the content hash of the file',
  link: 'the target the node recorded',
  text: 'the text the node recorded',
}

// `check:tests-ok` -> `{ kind: 'check', name: 'tests-ok' }`, `issue.ready` -> `{ kind: 'issue.ready',
// name: '' }`. Anything outside the vocabulary, a named kind without a name, or an unnamed part of
// a named kind is not a spec: a definition that spells an artifact this way is invalid, not empty.
export function parseArtifactSpec(spec) {
  const raw = typeof spec === 'string' ? spec.trim() : ''
  if (raw === '') return null
  const cut = raw.indexOf(':')
  const kind = cut === -1 ? raw : raw.slice(0, cut).trim()
  const name = cut === -1 ? '' : raw.slice(cut + 1).trim()
  if (!ARTIFACT_KINDS.includes(kind)) return null
  if (NAMED_KINDS.has(kind)) return name === '' ? null : { kind, name }
  return name === '' ? { kind, name: '' } : null
}

export function formatArtifactSpec(parsed) {
  if (!parsed || !ARTIFACT_KINDS.includes(parsed.kind)) return null
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
  return name === '' ? parsed.kind : `${parsed.kind}:${name}`
}

export function isArtifactSpec(spec) {
  return parseArtifactSpec(spec) !== null
}

// Revisions compare as text, with a SHA case-folded so `ABC1234` and `abc1234` are one revision.
// Everything else (`1274@1519968b`, a tag, a content hash) is compared exactly.
export function normaliseRevision(revision) {
  if (revision === null || revision === undefined) return null
  const text = String(revision).trim()
  if (text === '') return null
  return /^[0-9a-f]{6,40}$/i.test(text) ? text.toLowerCase() : text
}

export function sameRevision(a, b) {
  const left = normaliseRevision(a)
  return left !== null && left === normaliseRevision(b)
}

export function revisionRule(kind) {
  return REVISION_RULES[kind] ?? null
}

// One instance of an artifact: what it is, which revision of it a node saw, and the value that
// revision carried (a verdict's PASS / INC, a text's body). No revision, no artifact.
export function artifact(spec, revision, extra = {}) {
  const parsed = typeof spec === 'string' ? parseArtifactSpec(spec) : parseArtifactSpec(formatArtifactSpec(spec))
  if (!parsed) return null
  const at = normaliseRevision(revision)
  if (at === null) return null
  return {
    spec: formatArtifactSpec(parsed),
    kind: parsed.kind,
    name: parsed.name,
    revision: at,
    value: extra.value === undefined ? null : extra.value,
    by: extra.by === undefined ? null : extra.by,
    at: extra.at === undefined ? null : extra.at,
  }
}

// `check:tests-ok@abc1234` — the spelling a refusal and a card use, so a reader sees which
// revision was present without opening the record.
export function formatArtifact(input) {
  if (!input || !input.spec) return null
  return input.revision ? `${input.spec}@${input.revision}` : input.spec
}

export function sameArtifact(a, b) {
  return Boolean(a && b && a.spec === b.spec) && sameRevision(a.revision, b.revision)
}

// Present is not current (#1272). The caller re-reads what produces the artifact and hands in the
// revision that source holds now; a fact nobody could read is not a match either, so it refuses
// with `unreadable` rather than pass on a guess (#1211).
export function freshness(input, currentRevision) {
  const now = normaliseRevision(currentRevision)
  if (!input) return { fresh: false, reason: 'missing', have: null, now }
  if (now === null) return { fresh: false, reason: 'unreadable', have: input.revision ?? null, now: null }
  const fresh = sameRevision(input.revision, now)
  return { fresh, reason: fresh ? 'current' : 'stale', have: input.revision ?? null, now }
}

export function artifactsBySpec(list) {
  const map = {}
  for (const item of Array.isArray(list) ? list : []) {
    if (item && item.spec) map[item.spec] = item
  }
  return map
}
