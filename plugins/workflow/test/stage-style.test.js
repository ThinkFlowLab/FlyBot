// The stage drawer reads like the Bot details drawer (core styles.js .bt-tabs,
// .bt-soft, .bt-bubble): the same tab pills, soft pill buttons, bubble-surfaced
// node cards and theme tokens, no palette of its own (#1654).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const rule = sel => source.match(new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\=]/g, m => `\\${m}`)}\\{[^}]*\\}`))?.[0] ?? ''

test('drawer tabs are the Bot drawer tab pills and say which one is selected', () => {
  assert.match(rule('.wf-tabs button'), /border-radius:9999px/)
  assert.match(rule('.wf-tabs button'), /font-size:13px;line-height:20px/)
  assert.match(source, /\.wf-tabs button\[aria-selected=true\]\{background:var\(--bt-hover/)
  assert.match(source, /role: 'tab', 'aria-selected': tab === key/)
  assert.match(source, /className: 'wf-tabs', role: 'tablist'/)
})

test('buttons, node cards, the run card and the title use the chat surfaces', () => {
  assert.match(rule('.wf-btn'), /border-radius:999px/)
  assert.match(rule('.wf-btn'), /border:0;background:var\(--bt-hover/)
  assert.match(rule('.wf-btn.wf-pri,.wf-btn.wf-pri:hover:not(:disabled)'), /color:var\(--bt-accent-ink/)
  assert.match(rule('.wf-node'), /background:var\(--bt-bubble/)
  assert.match(rule('.wf-node'), /border-radius:18px/)
  assert.match(rule('.wf-term'), /background:var\(--bt-bubble/)
  assert.match(rule('.wf-ico-lg'), /background:var\(--bt-bubble/)
  assert.match(rule('.wf-drawer'), /font-family:-apple-system/)
  assert.match(rule('.wf-dr-title h2'), /font-size:17px;line-height:24px;font-weight:500/)
})

test('the restyled rules paint no colour outside the --bt-* tokens', () => {
  for (const sel of ['.wf-drawer', '.wf-dr-head', '.wf-icon', '.wf-tabs button', '.wf-btn', '.wf-node', '.wf-node.selected', '.wf-term', '.wf-ico-lg', '.wf-box', '.wf-chip', '.wf-chip.running']) {
    const body = rule(sel)
    assert.ok(body, `${sel} rule is missing`)
    const bare = body.replace(/var\(--[a-z0-9-]+,[^()]*(\([^()]*\))?[^()]*\)/gi, '').match(/#[0-9a-f]{3,8}\b/gi) ?? []
    assert.deepEqual(bare, [], `${sel} paints a colour that is not a --bt-* fallback`)
  }
  assert.equal(/rgba\(77,107,254/.test(source), false, 'the accent glow is hard-coded instead of mixed from --bt-accent')
})
