import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { MOBILE_CSS, MOBILE_MAX_WIDTH } from '../src/client/mobile.js'

// Phone-width layout, step 1 (#362): chat, the held-reply Approve / Reject and the Agent
// inbox fit a ~400px phone browser. Only a max-width media query, so wider screens are as before.
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return MOBILE_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\{([^}]*)\\}`))?.[1] ?? ''
}

test('every phone rule sits inside one max-width media query at 640px', () => {
  assert.equal(MOBILE_MAX_WIDTH, 640)
  const body = MOBILE_CSS.trim()
  assert.ok(body.startsWith('@media (max-width:640px){'), 'opens with the phone media query')
  assert.ok(body.endsWith('}'), 'closes it')
  assert.equal((body.match(/@media/g) ?? []).length, 1)
  // Balanced braces: nothing leaks out of the media block.
  const open = body.indexOf('{')
  let depth = 0
  for (const [i, ch] of [...body].entries()) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (i >= open && depth === 0 && i < body.length - 1) assert.fail(`rule outside the media query at ${i}`)
  }
  assert.equal(depth, 0)
})

test('held-reply and floating approval buttons are touch-sized, Approve filled', () => {
  const button = rule(':is(.bt-held-card,.bt-flybot-approval) .bt-flybot-approval-actions>button')
  assert.match(button, /height:40px/)
  assert.match(button, /flex:1 1 0/)
  assert.match(rule(':is(.bt-held-card,.bt-flybot-approval) .bt-flybot-approval-actions>button.bt-flybot-approve'), /background:var\(--bt-accent\)/)
  assert.match(rule('.bt-held-actions'), /max-width:100%/)
})

test('floating cards span the screen beside the icon rail, not over the top + or the account', () => {
  const stack = rule('.bt-flybot-approvals')
  assert.match(stack, /left:64px/)
  assert.match(stack, /right:8px/)
  assert.match(stack, /max-width:none/)
  assert.match(rule('.bt-flybot-pointers'), /max-width:calc\(100vw - 72px\)/)
})

test('inbox cards wrap their actions under the text so the title stays readable', () => {
  assert.match(rule('.bt-inbox-card'), /flex-wrap:wrap/)
  assert.match(rule('.bt-inbox-actions'), /flex:1 1 100%/)
  assert.match(rule('.bt-inbox-actions :is(.bt-soft,.bt-send)'), /height:36px/)
  assert.match(rule('.bt-inbox-title,.bt-inbox-reason'), /white-space:normal/)
})

test('the client installs the phone styles after the shell styles they override', () => {
  const index = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  const at = name => index.indexOf(`installCompiledStyles(${name}`)
  assert.ok(at('MOBILE_CSS') > 0, 'MOBILE_CSS is installed')
  for (const earlier of ['SHELL_CSS', 'INBOX_CSS', 'FLYBOT_CSS']) assert.ok(at(earlier) >= 0 && at(earlier) < at('MOBILE_CSS'), `${earlier} comes first`)
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes('.bt-inbox-actions :is(.bt-soft,.bt-send){height:36px'), 'client.js carries the phone styles')
})
