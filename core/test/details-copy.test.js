// The details drawer's copy export is a read surface: a person copies the words they see, not the
// stored markers. Two shapes reach the clipboard today — a delegation trace ("Chief → SelfB1") and
// an untrusted fence ("<untrusted-message from=\"User\">…") — and both are routing/format, never
// content. A line with no marker keeps its bytes exactly, line breaks included.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fenceUntrusted } from '../src/host/delivery.js'

const read = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
// The names a trace can start from: the drawer passes the roster's, longest first.
const BOT_NAMES = ['Chief', 'Product', 'Dev Lead', 'SelfB1', '助手']
// The stored shape the host writes: the delivery header, then the fenced body.
const stored = (header, from, body) => `${header}\n${fenceUntrusted(from, body)}`
const outlineOf = (...entries) => ({ projectionsBySession: { s1: { values: { turnOutline: entries } } } })
// Loaded lazily so a red base reports the missing reader per test, not as one import crash.
const copyReader = () => import('../src/client/text.js').then(module => module.transcriptOf)

test('the conversation copy shows the words of a stored line, never its trace or fence', async () => {
  const transcriptOf = await copyReader()
  assert.equal(typeof transcriptOf, 'function', 'the copy reader is exported from the text helpers')
  const body = 'B kick test 4 > hello'
  const withTrace = `Chief → SelfB1\n\n${stored('[Message from User]', 'User', body)}`
  const groupLine = stored('[Group chat "Build" · new message]', 'Chief', 'another stored line')
  const text = transcriptOf(outlineOf(
    { turn: 1, prompt: 'typed by the owner', response: withTrace },
    { turn: 2, response: groupLine },
    { turn: 3, response: 'plain words\nsecond line' },
  ), 's1', 'Chief', [], BOT_NAMES)
  assert.doesNotMatch(text, /<untrusted/, 'the fence marker never reaches the clipboard')
  assert.doesNotMatch(text, /from="/, 'the fence attribute never reaches the clipboard')
  assert.doesNotMatch(text, /^Chief → /m, 'the delegation trace never reaches the clipboard')
  assert.match(text, /\*\*You:\*\* typed by the owner/, "the owner's own line keeps its label")
  assert.equal(text.includes(body), true, 'the stored words are kept')
  assert.equal(text.includes('another stored line'), true, 'a group line keeps its words')
  // A stored line with no marker is copied as it was written: the words in order, its line break kept.
  assert.match(text, /\*\*Chief:\*\* plain words\nsecond line$/)
})

test('the details drawer copies through the shared transcript reader', () => {
  const drawer = read('details-drawer.js')
  // On today's main this line is the leak: the stored response goes to the clipboard with only its
  // delivery header removed, so the trace and the fence travel with it.
  assert.doesNotMatch(drawer, /stripHeader\(entry\.response\)/, 'a stored reply is not copied raw')
  assert.match(drawer, /import \{[^}]*\btranscriptOf\b[^}]*\} from '\.\/text\.js'/, 'the drawer uses the shared reader')
  assert.doesNotMatch(drawer, /function transcriptOf\(/, 'the drawer keeps no second copy of the reader')
  const text = read('text.js')
  assert.match(text, /export function transcriptOf\(/, 'the reader is testable and exported')
  assert.match(text, /visibleText\(/, 'the copy goes through the same fence-free text a row reads')
})

// A stored outline line is flat: the trace and the words share one line, so a reader that only
// looks for a trace line ending in a newline copies `Chief → Product Hi there` verbatim. The copy
// path flattens the line and removes a leading trace only when the first hop is a Bot's name —
// exactly, whole — because `Settings → Models 页面` is prose a person may be quoting.
const copyBody = () => import('../src/client/text.js').then(module => module.copyBodyOf)

test('the copy drops a flat trace whose first hop is a known Bot name', async () => {
  const copyBodyOf = await copyBody()
  assert.equal(typeof copyBodyOf, 'function', 'copyBodyOf is exported')
  assert.equal(copyBodyOf('Chief → Product Hi there', BOT_NAMES), 'Hi there')
})

test('the copy drops a flat trace that sits behind a delivery header', async () => {
  const copyBodyOf = await copyBody()
  assert.equal(copyBodyOf('[Reply from Chief] Chief → Product Hi there', BOT_NAMES), 'Hi there')
})

test('the copy drops a flat trace with more than one hop', async () => {
  const copyBodyOf = await copyBody()
  assert.equal(copyBodyOf('Chief → Dev Lead → Product 收到，开始', BOT_NAMES), '收到，开始')
})

test('the copy keeps a line whose first hop is not a Bot name, and keeps every line without names', async () => {
  const copyBodyOf = await copyBody()
  // A model list is prose, not routing: stripping it to `页面` would delete what the person said.
  assert.equal(copyBodyOf('Settings → Models 页面', BOT_NAMES), 'Settings → Models 页面')
  // A soft line break is kept, not folded into one line: only a recognized trace is removed.
  assert.equal(copyBodyOf('Settings → Models\n页面', BOT_NAMES), 'Settings → Models\n页面')
  // No names means no evidence that the first hop is a Bot, so nothing is stripped at all.
  assert.equal(copyBodyOf('Chief → Product Hi there'), 'Chief → Product Hi there')
  assert.equal(copyBodyOf('Chief → Product Hi there', []), 'Chief → Product Hi there')
})

// A copy is the words on their own lines. Folding a reply's paragraphs into one line is a format
// regression, not a fix: the reader the drawer replaces kept the newlines (`stripHeader(...).trim()`),
// and D2's exchange reader keeps them too.
test('the copy keeps the paragraph breaks a stored reply was written with', async () => {
  const copyBodyOf = await copyBody()
  const body = 'para one\n\npara two\n\npara three'
  assert.equal(copyBodyOf(body, BOT_NAMES), body, 'every paragraph stays its own paragraph')
  assert.equal(copyBodyOf(body, BOT_NAMES).split('\n').length, 5, 'four line breaks, one blank line between paragraphs')
})

test('the copy drops a flat trace on the first line and keeps the paragraphs under it', async () => {
  const copyBodyOf = await copyBody()
  const text = copyBodyOf('Chief → Product Hi there\n\nsecond para', BOT_NAMES)
  assert.equal(text, 'Hi there\n\nsecond para', 'only the first line loses the trace; the break stays')
  // The same line read flat: the words are the ones a single-line read would show.
  assert.equal(text.split('\n').map(line => line.trim()).filter(Boolean).join(' '), 'Hi there second para')
  assert.equal(text.split('\n').length, 3, 'the paragraph break is not folded away')
})
