// Message folding thresholds, previews, document-card detection, and prefs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FOLD_THRESHOLDS, documentHeadings, documentTitle, exceedsThreshold,
  foldingOf, isLongDocument, previewOf, shouldFold, showsDocumentCard,
} from '../src/shared/message-fold.js'
import { readFolding } from '../src/shared/message-fold-prefs.js'

const line = 'A short line of ordinary prose.'
const compactOverChars = 'word '.repeat(60).trim() // 299 chars
const standardOverChars = 'word '.repeat(170).trim() // 849 chars
const manyLines = (n, width = 'This is a line of a longer reply.') => Array.from({ length: n }, () => width).join('\n')
const article = [
  '# Weekly note',
  '',
  'An introduction long enough that this document clears the standard threshold, with several short paragraphs so the character count is honest.',
  '',
  '## Progress',
  '',
  'The team shipped the chat shell, the appearance modes, and the send-key preference. The next pass is message folding in the bubble itself, not a setting that does nothing.',
  '',
  '## Risks',
  '',
  'A fake entry would look like a completed feature. The bubble has to fold first, then the setting has to write through set-prefs and change what the bubble shows.',
  '',
  '## Next',
  '',
  'After the setting is stored on the host, opening the same conversation again still folds at the same caps, and a long document still opens as a card beside the thread.',
].join('\n')

test('fresh prefs are standard with document cards on', () => {
  assert.deepEqual(foldingOf(undefined), { mode: 'standard', documentCards: true })
  assert.deepEqual(foldingOf({}), { mode: 'standard', documentCards: true })
  assert.equal(foldingOf({ folding: { mode: 'compact', documentCards: false } }).mode, 'compact')
  assert.equal(foldingOf({ folding: { mode: 'compact', documentCards: false } }).documentCards, false)
  assert.equal(foldingOf({ folding: { mode: 'wild' } }).mode, 'standard')
})

test('a message at the cap stays open; one character or line over folds', () => {
  const { compact, standard } = FOLD_THRESHOLDS
  assert.equal(compact.lines, 4)
  assert.equal(compact.chars, 240)
  assert.equal(standard.lines, 12)
  assert.equal(standard.chars, 800)
  assert.equal(shouldFold('x'.repeat(compact.chars), 'compact'), false)
  assert.equal(shouldFold('x'.repeat(compact.chars + 1), 'compact'), true)
  assert.equal(shouldFold(manyLines(compact.lines), 'compact'), false)
  assert.equal(shouldFold(manyLines(compact.lines + 1), 'compact'), true)
  assert.equal(shouldFold('x'.repeat(standard.chars), 'standard'), false)
  assert.equal(shouldFold('x'.repeat(standard.chars + 1), 'standard'), true)
  assert.equal(shouldFold(manyLines(standard.lines), 'standard'), false)
  assert.equal(shouldFold(manyLines(standard.lines + 1), 'standard'), true)
  assert.equal(shouldFold(standardOverChars, 'none'), false)
  assert.equal(shouldFold(article, 'none'), false)
})

test('the preview is capped by lines or characters and does not equal the full text', () => {
  const preview = previewOf(manyLines(8), 'compact')
  assert.equal(preview.split('\n').length, 4)
  assert.notEqual(preview, manyLines(8))
  const clipped = previewOf(compactOverChars, 'compact')
  assert.ok(clipped.length <= 240, `compact char preview is ${clipped.length}`)
  assert.notEqual(clipped, compactOverChars)
  const mid = previewOf(standardOverChars, 'standard')
  assert.ok(mid.length <= 800, `standard char preview is ${mid.length}`)
  const short = previewOf(line, 'standard')
  assert.equal(short, line)
  assert.equal(exceedsThreshold(line, FOLD_THRESHOLDS.standard), false)
})

test('a preview does not leave a markdown fence open', () => {
  const body = 'Intro\n\n```js\n' + 'const n = 1;\n'.repeat(40) + '```\n'
  assert.equal(shouldFold(body, 'compact'), true)
  const preview = previewOf(body, 'compact')
  const ticks = preview.match(/```/g) ?? []
  assert.equal(ticks.length % 2, 0, 'fences come in pairs')
})

test('a long document is a multi-heading message that already exceeds standard', () => {
  assert.equal(isLongDocument(article), true)
  assert.ok(documentHeadings(article).length >= 2)
  assert.equal(documentTitle(article), 'Weekly note')
  assert.equal(showsDocumentCard(article, { mode: 'standard', documentCards: true }), true)
  assert.equal(showsDocumentCard(article, { mode: 'none', documentCards: true }), false)
  assert.equal(showsDocumentCard(article, { mode: 'standard', documentCards: false }), false)
  assert.equal(showsDocumentCard(article, { mode: 'standard', documentCards: true }, { streaming: true }), false)
  const shortDoc = '# One\n\nHello\n\n## Two\n\nWorld'
  assert.equal(isLongDocument(shortDoc), false)
  const broken = ['Part one is long enough on its own: ' + 'word '.repeat(80), '---', 'Part two keeps going: ' + 'word '.repeat(80), '---', 'Part three finishes: ' + 'word '.repeat(80)].join('\n')
  assert.equal(isLongDocument(broken), true)
})

test('host set-prefs accepts a folding record and refuses a bad one', () => {
  assert.deepEqual(readFolding(null), undefined)
  assert.deepEqual(readFolding({ mode: 'compact' }), { mode: 'compact', documentCards: true })
  assert.deepEqual(readFolding({ documentCards: false }, { mode: 'standard', documentCards: true }), { mode: 'standard', documentCards: false })
  assert.equal(readFolding({ mode: 'loose' }), false)
  assert.equal(readFolding({ mode: 'standard', documentCards: 'yes' }), false)
  assert.equal(readFolding('standard'), false)
})


test('fenced examples are not document headings or section breaks; tilde and longer fences close safely', () => {
  for (const fence of ['~~~', '````']) {
    const code = `${fence}md\n# Example\n## Not a heading\n---\n---\n${'x'.repeat(900)}\n${fence}`
    assert.equal(isLongDocument(code), false)
    assert.equal(previewOf(code, 'compact').endsWith(fence), true)
  }
})
