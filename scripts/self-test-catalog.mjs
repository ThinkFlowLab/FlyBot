// The self-test catalog and its check (#782).
//
//   node scripts/self-test-catalog.mjs --check              # exit 1 and name what drifted
//   node scripts/self-test-catalog.mjs --write              # regenerate the tables in docs/self-test.md
//   node scripts/self-test-catalog.mjs --import <catalog>   # take a fresh catalog from SelfTest's workspace
//
// `docs/self-test.json` is the machine-readable catalog: every self-test case and guard with its
// stable id, the probe it lives in, and the English `checks`/`expected` pair the page shows. The
// case tables inside `docs/self-test.md` are generated from it, so the page cannot become a stale
// hand copy of a suite that grew twice in one day. Only the generated block is touched: the Gaps,
// Planned and Retired sections are hand-written and the check validates their ids instead of
// rendering them.
//
// The probes themselves live in SelfTest's workspace, not here, and label their checks in Chinese
// while this repository is English-only. So the catalog's `name` is not copied; `fingerprint` is a
// hash of that label and keeps the link back, and `sourceSha256` pins the file a copy came from.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const MANIFEST = 'docs/self-test.json'
export const DOC = 'docs/self-test.md'
export const VERSION = 1
export const BEGIN = '<!-- generated:self-test:begin -->'
export const END = '<!-- generated:self-test:end -->'
export const ID = /^ST-[A-Z](?:[0-9]{2}|g[0-9]+)$/
export const FINGERPRINT = /^ST-[A-Z]-[0-9a-f]{6}$/
export const KINDS = ['case', 'guard']

const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const cellOk = (value) => typeof value === 'string' && value.trim() !== '' && !/[|\n]/.test(value)

export function countsOf(manifest) {
  const cases = manifest.cases.filter((c) => c.kind === 'case').length
  return { cases, guards: manifest.cases.length - cases, families: manifest.families.length }
}

// What makes the manifest itself untrustworthy, independent of the page it renders.
export function schemaProblems(manifest) {
  const problems = []
  if (manifest.version !== VERSION) problems.push(`manifest: version ${JSON.stringify(manifest.version)} is not ${VERSION}`)
  for (const field of ['source', 'generatedAt', 'sourceSha256']) {
    if (!manifest[field]) problems.push(`manifest: ${field} is missing`)
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.sourceSha256 ?? '')) problems.push('manifest: sourceSha256 is not a sha256')

  const families = new Map()
  for (const family of manifest.families ?? []) {
    if (!family.id) problems.push('manifest: a family row has no id')
    else if (families.has(family.id)) problems.push(`manifest: family id "${family.id}" appears twice`)
    families.set(family.id, family)
    if (!family.prefix || family.id !== `ST-${family.prefix}`) problems.push(`manifest: family "${family.id}" and its prefix disagree`)
    for (const field of ['title', 'command', 'probe', 'flow']) {
      if (!family[field]) problems.push(`manifest: family "${family.id}" has no ${field}`)
    }
  }

  const ids = new Set()
  const fingerprints = new Set()
  for (const c of manifest.cases ?? []) {
    if (!c.id) problems.push('manifest: a case row has no id')
    else if (!ID.test(c.id)) problems.push(`manifest: case id "${c.id}" is not ST-<family><nn> or ST-<family>g<n>`)
    else if (ids.has(c.id)) problems.push(`manifest: case id "${c.id}" appears twice`)
    ids.add(c.id)
    const family = families.get(c.family)
    if (!family) problems.push(`manifest: case "${c.id}" names family "${c.family}" which is not in families`)
    else if (!c.id.startsWith(c.family)) problems.push(`manifest: case "${c.id}" is filed under "${c.family}"`)
    if (!KINDS.includes(c.kind)) problems.push(`manifest: case "${c.id}" has unknown kind "${c.kind}"`)
    if (!FINGERPRINT.test(c.fingerprint ?? '')) problems.push(`manifest: case "${c.id}" has no ST-<family>-<hex6> fingerprint`)
    else if (fingerprints.has(c.fingerprint)) problems.push(`manifest: fingerprint "${c.fingerprint}" appears twice`)
    fingerprints.add(c.fingerprint)
    for (const field of ['checks', 'expected']) {
      if (!cellOk(c[field])) problems.push(`manifest: case "${c.id}" has an empty or unpaintable ${field}`)
    }
    for (const field of ['probe', 'flow']) {
      if (!c[field]) problems.push(`manifest: case "${c.id}" has no ${field}`)
    }
  }
  for (const [id, family] of families) {
    if (!manifest.cases.some((c) => c.family === id)) problems.push(`manifest: family "${id}" has no rows`)
  }
  return problems
}

export function renderTables(manifest) {
  const rows = []
  const { cases, guards, families } = countsOf(manifest)
  rows.push(
    `_${cases} cases + ${guards} guards in ${families} families, rendered from \`${MANIFEST}\` ` +
      `(\`generatedAt\` ${manifest.generatedAt}). Do not edit: run \`node scripts/self-test-catalog.mjs --write\`._`,
    '',
  )
  for (const family of manifest.families) {
    const own = manifest.cases.filter((c) => c.family === family.id)
    const ownCases = own.filter((c) => c.kind === 'case').length
    const ownGuards = own.length - ownCases
    rows.push(
      `## ${family.id} — ${family.title} — ${ownCases} case${ownCases === 1 ? '' : 's'}, ` +
        `${ownGuards} guard${ownGuards === 1 ? '' : 's'} (\`${family.command}\`)`,
      '',
      '| id | kind | checks | expected |',
      '| --- | --- | --- | --- |',
    )
    for (const c of own) rows.push(`| ${c.id} | ${c.kind} | ${c.checks} | ${c.expected} |`)
    rows.push('')
  }
  return rows.join('\n').trimEnd()
}

// The doc's own id rows: three columns for a hand-written row, and a generous cap so a row with a
// broken pipe does not silently lose a cell.
export function docRows(text) {
  const rows = []
  let offset = 0
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*(ST-[A-Za-z0-9]+)\s*\|(.*)\|\s*$/)
    if (m) rows.push({ id: m[1], cells: m[2].split('|').map((cell) => cell.trim()), start: offset })
    offset += line.length + 1
  }
  return rows
}

export function blockOf(text) {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin < 0 || end < begin) return null
  return { body: text.slice(begin + BEGIN.length, end).trim() }
}

export function check({ root }) {
  const problems = []
  let manifest
  try {
    manifest = readJson(root, MANIFEST)
  } catch (error) {
    return { problems: [`${MANIFEST} is missing or unreadable: ${error.message}`] }
  }
  problems.push(...schemaProblems(manifest))

  const docPath = join(root, DOC)
  if (!existsSync(docPath)) return { problems: [...problems, `${DOC} is missing`], manifest }
  const text = readFileSync(docPath, 'utf8')
  const block = blockOf(text)
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  // Rows inside the generated block are judged by the byte comparison above; only the hand-written
  // rows below it are validated one by one.
  const hand = docRows(text).filter((row) => !(begin >= 0 && end > begin && row.start > begin && row.start < end))
  // Without a block every row is hand-written by definition; the missing markers are the finding,
  // so the per-row validation waits for them instead of repeating itself 90 times.
  const rows = block ? hand : []
  const caseIds = new Set(manifest.cases.map((c) => c.id))

  if (!block) {
    // A page without markers still gets the row comparison: the point of the check is that the page
    // names the catalog, and an old hand-copied page is exactly what it must refuse.
    problems.push(`${DOC} has no ${BEGIN} … ${END} block — add the markers, then run: node scripts/self-test-catalog.mjs --write`)
    const pageIds = new Set(rows.map((row) => row.id))
    for (const id of caseIds) if (!pageIds.has(id)) problems.push(`missing row: ${id} is in ${MANIFEST} but not in ${DOC}`)
    for (const id of pageIds) if (!caseIds.has(id) && !/^ST-[GN]/.test(id)) problems.push(`row ${id} is in ${DOC} but not in ${MANIFEST}`)
  } else if (block.body !== renderTables(manifest)) {
    // Name each row and cell that differs, so the message points at the id instead of a wall of text.
    const rendered = new Map(docRows(block.body).map((row) => [row.id, row]))
    const wanted = docRows(renderTables(manifest))
    for (const row of wanted) {
      const actual = rendered.get(row.id)
      if (!actual) {
        problems.push(`missing row: ${row.id} is in ${MANIFEST} but not in the block of ${DOC}`)
        continue
      }
      if (row.cells.length !== 3) {
        problems.push(`${row.id} has ${row.cells.length} cell(s), expected 3 (kind, checks, expected)`)
        continue
      }
      for (const [index, column] of ['kind', 'checks', 'expected'].entries()) {
        if (actual.cells[index] !== row.cells[index]) {
          problems.push(`${row.id} ${column}: ${DOC} has "${actual.cells[index]}", ${MANIFEST} has "${row.cells[index]}"`)
        }
      }
    }
    for (const row of rendered.keys()) {
      if (!wanted.some((w) => w.id === row)) problems.push(`row ${row} is in the block of ${DOC} but not in ${MANIFEST}`)
    }
    if (!problems.length) problems.push(`${DOC} is out of date with ${MANIFEST} — run: node scripts/self-test-catalog.mjs --write`)
  }

  // Ids outside the block are hand-written (Gaps, Planned, Retired). They are never renumbered and
  // never reused, so they must be well formed, unique across the page, and not collide with a case.
  const seen = new Set()
  for (const row of rows) {
    if (!ID.test(row.id)) problems.push(`${DOC}: "${row.id}" is not a self-test id (ST-<family><nn>, ST-<family>g<n>)`)
    if (caseIds.has(row.id)) problems.push(`${DOC}: "${row.id}" is both a case and a hand-written row`)
    if (seen.has(row.id)) problems.push(`${DOC}: "${row.id}" appears twice`)
    seen.add(row.id)
    if (row.cells.length !== 2 || !row.cells[1]) problems.push(`${DOC}: "${row.id}" needs three columns (id, subject, reason) with the last one filled`)
  }
  return { manifest, problems, counts: manifest.cases ? countsOf(manifest) : null }
}

export function write({ root }) {
  const manifest = readJson(root, MANIFEST)
  const docPath = join(root, DOC)
  const text = readFileSync(docPath, 'utf8')
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin < 0 || end < begin) throw new Error(`${DOC} has no ${BEGIN} … ${END} block`)
  const next = text.slice(0, begin + BEGIN.length) + '\n\n' + renderTables(manifest) + '\n\n' + text.slice(end)
  writeFileSync(docPath, next)
  return next
}

// Take a fresh catalog from SelfTest's workspace. Verbatim fields come from that file; the English
// text and the families' titles and commands stay here, keyed by id, so a re-import never rewrites
// a sentence. Anything that would change the inventory without a sentence fails instead.
export function importCatalog({ root, source }) {
  const incoming = JSON.parse(readFileSync(source, 'utf8'))
  const previous = readJson(root, MANIFEST)
  const problems = []
  if (!Array.isArray(incoming.cases) || !incoming.cases.length) return { problems: [`${source}: no cases`] }
  if (!incoming.generatedAt) return { problems: [`${source}: no generatedAt`] }

  const before = new Map(previous.cases.map((c) => [c.id, c]))
  const families = new Map(previous.families.map((f) => [f.id, f]))
  const seenIds = new Set()
  const seenFingerprints = new Map()
  const cases = []

  for (const c of incoming.cases) {
    if (!ID.test(c.id ?? '')) {
      problems.push(`${c.id ?? '(no id)'} in ${source} is not a self-test id`)
      continue
    }
    if (seenIds.has(c.id)) problems.push(`${c.id} appears twice in ${source}`)
    seenIds.add(c.id)
    if (seenFingerprints.has(c.fingerprint)) problems.push(`${c.id} and ${seenFingerprints.get(c.fingerprint)} share fingerprint ${c.fingerprint}`)
    seenFingerprints.set(c.fingerprint, c.id)

    const prefix = c.id.match(/^ST-([A-Z])/)?.[1]
    const family = families.get(`ST-${prefix}`)
    if (!family) {
      problems.push(`new family ST-${prefix} (${c.id}) — add its id, prefix, title, command, probe and flow to ${MANIFEST} first`)
      continue
    }
    const old = before.get(c.id)
    if (!old) {
      problems.push(`${c.id} has no checks/expected yet — write them in ${MANIFEST}, then import again`)
      continue
    }
    if (old.fingerprint !== c.fingerprint) {
      problems.push(`${c.id} now points at a different probe label (${old.fingerprint} → ${c.fingerprint}) — an id must not move to another case; retire it and give the new label a new id`)
    }
    if (old.kind !== c.kind) problems.push(`${c.id} changed kind ${old.kind} → ${c.kind}`)
    cases.push({ ...old, kind: c.kind, probe: c.probe, flow: c.flow, fingerprint: c.fingerprint })
  }
  for (const c of previous.cases) {
    if (!seenIds.has(c.id)) {
      problems.push(`${c.id} is gone from the catalog — if it was retired, record it under "## Retired" in ${DOC} with its reason, then delete its row from ${MANIFEST}`)
    }
  }
  if (problems.length) return { problems }

  const next = {
    ...previous,
    generatedAt: incoming.generatedAt,
    sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    families: previous.families.map((f) => ({
      ...f,
      probe: cases.find((c) => c.family === f.id)?.probe ?? f.probe,
      flow: cases.find((c) => c.family === f.id)?.flow ?? f.flow,
    })),
    cases,
  }
  const drift = JSON.stringify(next.cases) !== JSON.stringify(previous.cases) || next.generatedAt !== previous.generatedAt
  return { manifest: next, changed: drift }
}

export function main({ root, argv = process.argv.slice(2) } = {}) {
  const base = root ?? process.cwd()
  const importAt = argv.indexOf('--import')
  if (importAt >= 0) {
    const source = argv[importAt + 1]
    if (!source) {
      console.log('self-test-catalog: --import needs a path to the catalog SelfTest generated')
      return { ok: false }
    }
    const { problems = [], manifest, changed } = importCatalog({ root: base, source })
    if (problems.length) {
      for (const problem of problems) console.log(`self-test-catalog: ${problem}`)
      return { ok: false, problems }
    }
    writeFileSync(join(base, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
    console.log(`self-test-catalog: imported ${manifest.cases.length} case(s)${changed ? '' : ' (no change)'}`)
    return { ok: true }
  }
  if (argv.includes('--write')) {
    write({ root: base })
    console.log(`self-test-catalog: regenerated the tables in ${DOC}`)
    return { ok: true }
  }
  const { problems, counts } = check({ root: base })
  console.log(
    counts
      ? `self-test-catalog: ${counts.cases} case(s) + ${counts.guards} guard(s) in ${counts.families} families`
      : 'self-test-catalog: no manifest to count',
  )
  if (problems.length) {
    for (const problem of problems) console.log(`self-test-catalog: ${problem}`)
    return { ok: false, problems }
  }
  console.log('self-test-catalog: the page and the catalog agree')
  return { ok: true, problems }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main().ok ? 0 : 1)
}
