// The self-test catalog check (scripts/self-test-catalog.mjs, #782).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BEGIN,
  END,
  check,
  renderTables,
  write,
  importCatalog,
  schemaProblems,
  docRows,
} from '../../scripts/self-test-catalog.mjs'

const family = (prefix, title) => ({
  id: `ST-${prefix}`,
  prefix,
  title,
  command: `node probe-${prefix.toLowerCase()}.mjs`,
  probe: `probe-${prefix.toLowerCase()}.mjs`,
  flow: title,
})
const row = (id, familyId, kind, checks, expected, fingerprint) => ({
  id,
  family: familyId,
  kind,
  probe: `probe-${familyId === 'ST-B' ? 'b' : 'u'}.mjs`,
  flow: familyId === 'ST-B' ? 'baseline' : 'ui',
  fingerprint,
  checks,
  expected,
})

const manifest = () => ({
  version: 1,
  source: 'selftest/catalog/self-test.json',
  generatedAt: '2026-10-22T14:34:09.412Z',
  sourceSha256: 'a'.repeat(64),
  families: [family('B', 'baseline'), family('U', 'web UI')],
  cases: [
    row('ST-B01', 'ST-B', 'case', 'both instances start', 'the ports answer', 'ST-B-60bfaf'),
    row('ST-Bg1', 'ST-B', 'guard', 'round guard', 'the round runs', 'ST-B-111111'),
    row('ST-U01', 'ST-U', 'case', 'after login', 'the chat area renders', 'ST-U-04d9b0'),
    row('ST-U02', 'ST-U', 'case', 'a sent line', 'it appears in the chat', 'ST-U-b576c3'),
  ],
})

function workspace(data = manifest()) {
  const root = mkdtempSync(join(tmpdir(), 'self-test-catalog-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs/self-test.json'), JSON.stringify(data, null, 2) + '\n')
  writeFileSync(
    join(root, 'docs/self-test.md'),
    [
      '# Self-test case catalog',
      '',
      'Hand-written prose above the block.',
      '',
      BEGIN,
      '',
      END,
      '',
      '## Gaps (no case exists today)',
      '',
      '| id | area | why nothing runs today |',
      '| --- | --- | --- |',
      '| ST-G01 | group chat turns | each test home has one Bot |',
      '',
      '## Retired',
      '',
      '| id | was | why it is here |',
      '| --- | --- | --- |',
      '| ST-G02 | timeline export | the test profile does not enable the plugin |',
      '',
    ].join('\n'),
  )
  write({ root })
  return root
}

test('the manifest is trustworthy only when its ids, kinds, fingerprints and text are', () => {
  assert.deepEqual(schemaProblems(manifest()), [])

  const duplicate = manifest()
  duplicate.cases[1].id = 'ST-B01'
  assert.match(schemaProblems(duplicate).join('\n'), /case id "ST-B01" appears twice/)

  const badKind = manifest()
  badKind.cases[0].kind = 'scenario'
  assert.match(schemaProblems(badKind).join('\n'), /unknown kind "scenario"/)

  const noText = manifest()
  noText.cases[2].expected = ''
  assert.match(schemaProblems(noText).join('\n'), /"ST-U01" has an empty or unpaintable expected/)

  const movedFamily = manifest()
  movedFamily.cases[2].family = 'ST-B'
  assert.match(schemaProblems(movedFamily).join('\n'), /"ST-U01" is filed under "ST-B"/)

  const samePrint = manifest()
  samePrint.cases[1].fingerprint = 'ST-B-60bfaf'
  assert.match(schemaProblems(samePrint).join('\n'), /fingerprint "ST-B-60bfaf" appears twice/)

  const badVersion = manifest()
  badVersion.version = 2
  assert.match(schemaProblems(badVersion).join('\n'), /version 2 is not 1/)
})

test('a rendered page passes, and the block is the only generated region', () => {
  const root = workspace()
  try {
    const result = check({ root })
    assert.deepEqual(result.problems, [])
    assert.deepEqual(result.counts, { cases: 3, guards: 1, families: 2 })
    const doc = readFileSync(join(root, 'docs/self-test.md'), 'utf8')
    assert.match(doc, /^# Self-test case catalog/)
    assert.match(doc, /Hand-written prose above the block\./)
    assert.match(doc, /## Retired/)
    assert.match(doc, /_3 cases \+ 1 guards in 2 families, rendered from `docs\/self-test.json`/)
    assert.match(doc, /## ST-B — baseline — 1 case, 1 guard \(`node probe-b.mjs`\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('one edited cell in the page is a drift, and the check names the id', () => {
  const root = workspace()
  try {
    const path = join(root, 'docs/self-test.md')
    writeFileSync(path, readFileSync(path, 'utf8').replace('| it appears in the chat |', '| it appears in the chat area |'))
    const { problems } = check({ root })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /ST-U02 expected: docs\/self-test\.md has "it appears in the chat area"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a case deleted from the page is named, not counted', () => {
  const root = workspace()
  try {
    const path = join(root, 'docs/self-test.md')
    const doc = readFileSync(path, 'utf8')
    writeFileSync(path, doc.replace('## ST-U — web UI — 2 cases, 0 guards (`node probe-u.mjs`)\n\n| id | kind | checks | expected |\n| --- | --- | --- | --- |\n', '').replace('| ST-U01 | case | after login | the chat area renders |\n', ''))
    const { problems } = check({ root })
    assert.match(problems.join('\n'), /missing row: ST-U01 is in docs\/self-test\.json but not in the block of docs\/self-test\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a case added to the manifest without a regenerate is named', () => {
  const root = workspace()
  const data = manifest()
  data.cases.push(row('ST-U03', 'ST-U', 'case', 'the peer UI', 'it renders the line', 'ST-U-aaaaaa'))
  writeFileSync(join(root, 'docs/self-test.json'), JSON.stringify(data, null, 2) + '\n')
  try {
    const { problems } = check({ root })
    assert.match(problems.join('\n'), /missing row: ST-U03 is in docs\/self-test\.json but not in the block of docs\/self-test\.md/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a page without the marker block is refused and the missing ids are named', () => {
  const root = workspace()
  try {
    const path = join(root, 'docs/self-test.md')
    const doc = readFileSync(path, 'utf8')
    writeFileSync(path, doc.slice(0, doc.indexOf(BEGIN)) + doc.slice(doc.indexOf(END) + END.length))
    const { problems } = check({ root })
    assert.match(problems.join('\n'), /has no <!-- generated:self-test:begin -->/)
    assert.match(problems.join('\n'), /missing row: ST-U02/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ids outside the block must be well formed, unique, and carry a reason', () => {
  const root = workspace()
  try {
    const path = join(root, 'docs/self-test.md')
    const doc = readFileSync(path, 'utf8')
    writeFileSync(path, doc.replace('| ST-G02 | timeline export | the test profile does not enable the plugin |', '| ST-G02 | timeline export | |'))
    assert.match(check({ root }).problems.join('\n'), /"ST-G02" needs three columns/)
    writeFileSync(path, doc + '\n| ST-B01 | rendered UI | duplicate of a case id |\n')
    assert.match(check({ root }).problems.join('\n'), /"ST-B01" is both a case and a hand-written row/)
    assert.equal(docRows('| ST-G01 | group chat | one Bot per home |').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an import refuses a case it has no sentence for, and keeps the ones it has', () => {
  const root = workspace()
  try {
    const source = join(root, 'incoming.json')
    const incoming = {
      generatedAt: '2026-10-22T18:00:00.000Z',
      cases: manifest().cases.map(({ id, kind, probe, flow, fingerprint }) => ({ id, kind, probe, flow, fingerprint })),
    }
    incoming.cases.push({ id: 'ST-U03', kind: 'case', probe: 'probe-u.mjs', flow: 'ui', fingerprint: 'ST-U-aaaaaa' })
    writeFileSync(source, JSON.stringify(incoming))
    const refused = importCatalog({ root, source })
    assert.match(refused.problems.join('\n'), /ST-U03 has no checks\/expected yet/)

    incoming.cases.pop()
    writeFileSync(source, JSON.stringify(incoming))
    const ok = importCatalog({ root, source })
    assert.deepEqual(ok.problems ?? [], [])
    assert.equal(ok.manifest.cases.find((c) => c.id === 'ST-U01').expected, 'the chat area renders')
    assert.equal(ok.manifest.generatedAt, '2026-10-22T18:00:00.000Z')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an import refuses a vanished id and an id that moved to another label', () => {
  const root = workspace()
  try {
    const source = join(root, 'incoming.json')
    const dropped = { generatedAt: '2026-10-22T18:00:00.000Z', cases: manifest().cases.filter((c) => c.id !== 'ST-U02').map(({ id, kind, probe, flow, fingerprint }) => ({ id, kind, probe, flow, fingerprint })) }
    writeFileSync(source, JSON.stringify(dropped))
    assert.match(importCatalog({ root, source }).problems.join('\n'), /ST-U02 is gone from the catalog — if it was retired/)

    const moved = { generatedAt: '2026-10-22T18:00:00.000Z', cases: manifest().cases.map(({ id, kind, probe, flow, fingerprint }) => ({ id, kind, probe, flow, fingerprint })) }
    moved.cases.find((c) => c.id === 'ST-U01').fingerprint = 'ST-U-123456'
    writeFileSync(source, JSON.stringify(moved))
    assert.match(importCatalog({ root, source }).problems.join('\n'), /ST-U01 now points at a different probe label/)

    const newFamily = { generatedAt: '2026-10-22T18:00:00.000Z', cases: [...moved.cases.slice(1), { id: 'ST-V01', kind: 'case', probe: 'probe-v.mjs', flow: 'v', fingerprint: 'ST-V-aaaaaa' }] }
    writeFileSync(source, JSON.stringify(newFamily))
    assert.match(importCatalog({ root, source }).problems.join('\n'), /new family ST-V/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the rendered tables cover every family, and the counts in the header are the tables', () => {
  const table = renderTables(manifest())
  assert.match(table, /_3 cases \+ 1 guards in 2 families/)
  assert.match(table, /\| ST-B01 \| case \| both instances start \| the ports answer \|/)
  assert.match(table, /\| ST-Bg1 \| guard \| round guard \| the round runs \|/)
  for (const family of manifest().families) assert.match(table, new RegExp(`## ${family.id} — ${family.title}`))
})
