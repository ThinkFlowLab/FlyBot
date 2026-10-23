import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { MIN_DETAILS, panelWidthRange } from '../src/client/pane-width.js'
import { PANE_MIN_WIDTH_CSS } from '../src/client/panes.js'

// Narrow multi-pane windows (#705): the Details panel's width is reserved as a margin on the
// conversation column, so a panel that will not shrink pushes the row past the window edge and
// leaves a dead strip between the panes.
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return PANE_MIN_WIDTH_CSS.match(new RegExp(`(?:^|\\n)${escaped}\\{([^}]*)\\}`))?.[1] ?? ''
}

test('#705: a narrow window shrinks the Details panel before it starves the conversation', () => {
  assert.equal(MIN_DETAILS, 240)
  // Room to spare: the panel keeps its own 320..520 range.
  assert.deepEqual(panelWidthRange('details', 1440), [320, 520])
  assert.deepEqual(panelWidthRange('details', 800), [320, 380])
  // 620px: only 200px would be left for the conversation, so the panel goes down to 240.
  assert.deepEqual(panelWidthRange('details', 620), [240, 240])
  assert.deepEqual(panelWidthRange('details', 500), [240, 240])
  // The browser view is unchanged, including a viewport narrower than the browser minimum.
  assert.deepEqual(panelWidthRange('browser', 1440), [360, 1020])
  assert.deepEqual(panelWidthRange('browser', 500), [360, 360])
})

test('#705: every pane the row flexes can shrink, and a long value wraps instead of widening it', () => {
  assert.match(rule('.bt-panel'), /min-width:0/)
  assert.match(rule('.bt-panel-view'), /min-width:0/)
  const body = rule('.bt-drawer-body')
  assert.match(body, /min-width:0/)
  assert.match(body, /overflow-wrap:anywhere/)
  // The About text and the usage line are the values that cannot wrap on their own.
  assert.match(rule('.bt-drawer-body :is(.bt-muted,.bt-note,.bt-section-title,.bt-drawer-role,.bt-drawer-permission)'), /overflow-wrap:anywhere/)
  // The conversation column is DSH's own, so it is matched by its class fragment.
  assert.match(rule('[class*="_centerCol"]'), /min-width:0/)
})

test('#705: the client installs the pane rules after the shell styles it overrides, and ships them', () => {
  // The rules only work when they are installed after the shell styles they override, and the app
  // runs the built bundle, so both halves are asserted here: a stylesheet that is never installed
  // (or a stale client.js) leaves the bug in place while the text of the constant stays green.
  const index = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  const at = name => index.indexOf(`installCompiledStyles(${name}`)
  assert.ok(at('PANE_MIN_WIDTH_CSS') > 0, 'PANE_MIN_WIDTH_CSS is installed')
  assert.ok(at('SHELL_CSS') >= 0 && at('SHELL_CSS') < at('PANE_MIN_WIDTH_CSS'), 'SHELL_CSS comes first')
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes('.bt-drawer-body{min-width:0;overflow-wrap:anywhere}'), 'client.js carries the drawer rules')
  assert.ok(bundle.includes('[class*="_centerCol"]{min-width:0}'), 'client.js carries the conversation column rule')
})
