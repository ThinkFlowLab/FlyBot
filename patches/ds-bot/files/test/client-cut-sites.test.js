import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { issueUrl } from '../src/client/diagnostics.js'
import { READ_LIMITS, readPageScript } from '../src/client/read-page.js'

// #2978: two more places cut text a person wrote at 80 UTF-16 units, though #2972 fixed the two
// chat lines. A character outside the BMP that straddles the bound was split: the issue title
// `issueUrl()` builds carried a lone surrogate (URLSearchParams then wrote U+FFFD, so the created
// issue read as an ellipsis and a replacement square), and the element name `readPage()` reports carried the raw lone surrogate in the
// tool result. Both now cut on code points and mark a dropped tail with `…`, so the character at
// the bound stays whole and text that fits is untouched.

// jsdom comes from the deepseek-harness checkout next to ds-bot, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const harness = process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness')
const { JSDOM } = createRequire(join(harness, 'package.json'))('jsdom')

// A lone surrogate is a code point in Cs and renders as U+FFFD.
const loneSurrogate = value => /\p{Cs}/u.test(value)
const issueBase = 'https://github.com/ThinkFlowLab/FlyBot/issues/new'
const titleOf = what => new URL(issueUrl(issueBase, { what, diagnostics: 'diag' }).url).searchParams.get('title')

// The page reader runs inside the Bot's webview: run the same serialized source over a fake DOM.
function nameOfButton(attributes) {
  const dom = new JSDOM(`<!doctype html><html><body><button ${attributes}>Go</button></body></html>`, {
    url: 'https://example.com/sample', runScripts: 'outside-only', pretendToBeVisual: true,
  })
  const { window } = dom
  // jsdom has no layout: every box is 100×20, so the button counts as visible.
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 100, height: 20, top: 0, left: 0, right: 0, bottom: 0 }
  }
  const page = JSON.parse(JSON.stringify(window.eval(readPageScript(READ_LIMITS))))
  return page.items[0].name
}

test('the diagnostics issue title keeps the character at the bound whole and marks the cut (#2978)', () => {
  // Unit 79 is the first half of the emoji: a UTF-16 slice cut it in two.
  const what = 'x'.repeat(79) + '📌 先看客户那封'
  const title = titleOf(what)
  assert.equal(loneSurrogate(title), false, 'the emoji is not cut in half: no lone surrogate reaches the title')
  assert.ok(title.includes('📌'), 'the whole emoji is kept at the bound')
  assert.ok(title.endsWith('…'), 'the dropped tail is marked')
  assert.equal(new URL(issueUrl(issueBase, { what, diagnostics: 'diag' }).url).href.includes('%EF%BF%BD'), false, 'the link carries no replacement square')
  // The bound applies to the title line only; the whole `what` still travels in its own field.
  assert.equal(new URL(issueUrl(issueBase, { what, diagnostics: 'diag' }).url).searchParams.get('what'), what)
})

test('a diagnostics issue title that fits is untouched, whatever its line endings (#2978)', () => {
  assert.equal(titleOf('y'.repeat(80)), 'y'.repeat(80), 'exactly 80 units are untouched — no `…`')
  assert.equal(titleOf('short title\nsecond line'), 'short title', 'the title is still the first line')
  assert.equal(titleOf(''), null, 'no title parameter when there is nothing to say')
})

test('the read-page element name keeps the character at the bound whole and marks the cut (#2978)', () => {
  // The same `nameOf` path serves aria-label, alt, placeholder, title and name.
  const name = nameOfButton(`aria-label="${'x'.repeat(79)}📌 tail"`)
  assert.equal(loneSurrogate(name), false, 'no lone surrogate reaches the tool result')
  assert.ok(name.includes('📌'), 'the whole emoji is kept at the bound')
  assert.ok(name.endsWith('…'), 'the dropped tail is marked')
})

test('a read-page element name that fits is untouched (#2978)', () => {
  assert.equal(nameOfButton(`aria-label="${'y'.repeat(80)}"`), 'y'.repeat(80), 'exactly 80 units are untouched — no `…`')
  assert.equal(nameOfButton('aria-label="Send the report"'), 'Send the report', 'a short name is untouched')
})
