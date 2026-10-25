// Group chat on a phone (#647): the surfaces a reader away from the desk actually touches.
//
// The owner's decision is that slice 1 of the mobile work is a PWA, and that the installability half
// (manifest, icons, `viewport-fit=cover`) lives in DSH's `dsh-web-frontend` package, not here. What this
// repository owns is the layout of its own group surfaces, and #362 only ever sized the held-reply
// Approve / Reject pair (#362's rule is still the first one in the block below).
//
// These cases pin the rest of that pass: at 375-640 px every control in a group chat is a 40 px tap
// target, and the invite / join row keeps its input and its button usable. 20-30 px controls fail even
// the loosest floor in the accessibility standards (WCAG 2.5.8 asks 24 px; the phone guides ask 44/48),
// and they were what the group strip, the invite row and the approval rows shipped.
//
// The assertion reads the shipped file, not a copy of the CSS: `client.js` is the artefact the browser
// loads, so a rule that only exists in a source comment would not count.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// One phone block, one line, closed before the newline — the shape `social.test.js` already pins.
const PHONE = SOURCE.match(/@media \(max-width:640px\)\{([^\n]*)\}\n/)?.[1] ?? ''

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return PHONE.match(new RegExp(`(?:^|\\})${escaped}\\{([^}]*)\\}`))?.[1] ?? ''
}

test('the group surfaces have exactly one phone block, at 640px', () => {
  assert.ok(PHONE, 'a max-width:640px block exists')
  assert.equal((SOURCE.match(/@media \(max-width:640px\)/g) ?? []).length, 1, 'one phone block, not two that can drift')
  // Nothing leaks out of it: what follows the block is the next top-level rule.
  assert.equal((PHONE.match(/\{/g) ?? []).length, (PHONE.match(/\}/g) ?? []).length, 'balanced braces inside the media block')
})

test('#362 keeps its contract: the held-reply Approve / Reject pair stays 40px and right-aligned', () => {
  assert.match(rule('.fs-hold .fs-btn'), /height:40px/)
  assert.match(rule('.fs-hold .fs-hold-decide'), /justify-content:flex-end/)
})

test('every group action button is a 40px tap target on a phone, small ones included', () => {
  const button = rule('.fs-btn,.fs-btn-sm')
  assert.match(button, /height:40px/, 'the shared button class and its small variant')
  assert.match(button, /padding:0 14px/)
  // The invite row and the approval card use these: Copy link, Invite by link, Add, Remove.
  assert.match(PHONE, /\.fs-btn-sm\{/, 'the small variant is named, not left at its 26px desktop size')
})

test('text links and the "more" toggle become tappable rows instead of 12px words', () => {
  const link = rule('.fs-link,.fs-hold-more')
  assert.match(link, /min-height:40px/)
  assert.match(link, /display:inline-flex/)
  assert.match(link, /align-items:center/)
})

test('the invite / join inputs are 40px tall, so the button beside them is not standing alone', () => {
  const inputs = rule('.fs-input,.fs-digits,.fs-link-input')
  assert.match(inputs, /height:40px/)
  assert.match(rule('.fs-paste'), /min-height:40px/, 'the multi-line paste box keeps auto height but a full tap area')
})

test('the two controls that were below every floor are sized up', () => {
  assert.match(rule('.fs-icon'), /height:40px/)
  assert.match(rule('.fs-icon'), /min-width:40px/)
  assert.match(rule('.fs-remove'), /width:32px/, 'the 20x20 row remove button')
  assert.match(rule('.fs-remove'), /height:32px/)
})

test('the approval and history rows are tappable, not 4px-padded text', () => {
  assert.match(rule('.fs-pending-item,.fs-past-head'), /min-height:40px/)
})

test('no phone rule escapes the media query, so a desktop layout is unchanged by this pass', () => {
  for (const selector of ['.fs-btn,.fs-btn-sm', '.fs-link,.fs-hold-more', '.fs-icon', '.fs-input,.fs-digits,.fs-link-input', '.fs-remove', '.fs-pending-item,.fs-past-head']) {
    assert.ok(rule(selector), `${selector} lives inside the phone block`)
  }
  // The desktop sizes are still the ones above the block: a 30px button, a 26px small button, a 20px remove.
  assert.match(SOURCE, /\.fs-btn\{[^}]*height:30px/, 'desktop button height is untouched')
  assert.match(SOURCE, /\.fs-btn-sm\{[^}]*height:26px/, 'desktop small button height is untouched')
  assert.match(SOURCE, /\.fs-remove\{[^}]*width:20px/, 'desktop remove button is untouched')
})

test('path 1 (message text) — a long unbroken run wraps inside the card instead of widening the column', () => {
  // The group message *list* is core's; inside this plugin a peer's text reaches the reader as the
  // held-reply card and as row text, so those are the two surfaces pinned here.
  assert.match(rule('.fs-hold .fs-draft'), /overflow-wrap:anywhere/, 'a pasted URL or tool output breaks inside the bubble')
  assert.match(SOURCE, /\.fs-msg\{[^}]*overflow-wrap:anywhere/, 'row text keeps the anywhere wrap it already had')
  assert.match(SOURCE, /\.fs-hold\{[^}]*overflow:hidden/, 'and the card clips, so a break failure cannot push the column sideways')
})

test('path 2 (composer) — the input + button row wraps, and the dock clears the home indicator at inset 0', () => {
  assert.match(SOURCE, /\.fs-invite-actions\{[^}]*flex-wrap:wrap/, 'the input and its button wrap at 375px instead of overflowing')
  // The shipped shell has no `viewport-fit=cover`, so `env(safe-area-inset-bottom)` is 0 on this stack
  // (#647). The dock rule is still correct there — and stays verifiable — only because it carries a
  // 0px fallback: today it reads 6px, and it becomes a real inset the day the shell is fixed.
  const envUses = PHONE.match(/env\([^)]*\)/g) ?? []
  assert.ok(envUses.length > 0, 'the dock clears the inset')
  for (const use of envUses) assert.match(use, /,\s*0px\s*\)$/, use + ' needs a 0px fallback, or it is inert today')
})

test('the dock half of the phone pass lands here too, so #1149 closes with it (#1150)', () => {
  assert.match(rule('.bt-flybot-session-dock'), /padding-bottom:calc\(6px \+ env\(safe-area-inset-bottom,0px\)\)/)
  assert.match(rule('.fs-group-strip'), /margin:6px 8px/)
  // One number for the link rows everywhere: the dock must not carry its own 32px override.
  assert.doesNotMatch(PHONE, /\.bt-flybot-session-dock \.fs-link\{/)
})

test('path 3 (approval cards) — the action row wraps and each action keeps a 40px target', () => {
  assert.match(SOURCE, /\.fs-hold \.fs-actions\{[^}]*flex-wrap:wrap/, 'four buttons wrap rather than overflow the card')
  assert.match(rule('.fs-pending-item,.fs-past-head'), /min-height:40px/, 'the approval and history rows are tappable')
})

test('the phone block is the last rule in the sheet, so no later rule of equal specificity overrides it', () => {
  // `:261` and `:300` used to redeclare `.fs-remove` (20px) and `.fs-link-input` (28px) *after* the
  // media block, with the same specificity — the browser took the later one, so the block was not
  // doing what it said. Order is the fix, and this is the case that fails if someone appends a rule
  // after it again.
  const at = SOURCE.indexOf('@media (max-width:640px)')
  const blockEnd = SOURCE.indexOf('}\n', at)
  const cssEnd = SOURCE.indexOf('`\n    function useStyles')
  assert.ok(at > 0 && blockEnd > at && cssEnd > blockEnd, 'the block sits inside the stylesheet')
  assert.equal(SOURCE.slice(blockEnd + 2, cssEnd).trim(), '', 'nothing may follow the phone block')
})

test('the two footer buttons that out-specify `.fs-btn` are raised in the same block', () => {
  // `.fs-preview-foot .fs-btn` (28px) and `.fs-wait-foot .fs-btn` (36px) are (0,2,0) against the
  // block's (0,1,0), so `.fs-btn{height:40px}` cannot reach them however late it sits.
  assert.match(rule('.fs-preview-foot .fs-btn,.fs-wait-foot .fs-btn'), /height:40px/)
})
