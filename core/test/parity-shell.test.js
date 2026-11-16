// First-batch chat-shell layout: icon rail, denser list, pill composer, Grove theme.
// Brand must stay FlyBot. Existing sidebar entries must remain. Phone rules stay in MOBILE_CSS.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { allThemes, themeCss } from '../src/client/themes.js'
import { ICON_RAIL_WIDTH, CHAT_LIST_WIDTH, SHELL_LEFT_WIDTH, COMPOSER_HEIGHT, HEADER_HEIGHT, PARITY_SHELL_CSS } from '../src/client/parity-shell.js'

const src = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
const index = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')

test('Grove is a selectable theme and is not named after another product', () => {
  const grove = allThemes().grove
  assert.equal(grove.label, 'Grove')
  assert.equal(grove.dark.bg, '#171c19')
  assert.equal(grove.dark.card, '#272e2b')
  assert.equal(grove.dark.bubble, '#2a332d')
  assert.equal(grove.dark.accent, '#3d9a6e')
  assert.equal(grove.light.text, '#171c19')
  const css = themeCss(grove)
  assert.match(css, /--bt-main:#171c19/)
  assert.doesNotMatch(src('themes.js'), /Teamily|teamily/i)
  assert.doesNotMatch(src('parity-shell.js'), /Teamily|teamily/i)
})

test('the default themes and DeepSeek option remain available', () => {
  const themes = allThemes()
  assert.ok(themes.deepseek)
  assert.ok(themes.mono)
  assert.ok(themes.paper)
  assert.ok(themes.moonlight)
  assert.equal(themes.deepseek.dark.bg, '#141414')
})

test('wide sidebar keeps the FlyBot name and mark, and adds a 72px icon rail', () => {
  const sidebar = src('sidebar.js')
  assert.match(sidebar, /function BrandName\(\) \{\n  return h\('span', \{ style: \{ fontWeight: 600, fontSize: 14 \} \}, t\('FlyBot'\)\)\n\}/)
  assert.match(sidebar, /function BrandMark\(\{ size = 24 \}\) \{\n  return h\('span', \{ className: 'bt-brand-mark' \}, h\(FlyBotMark, \{ size \}\)\)\n\}/)
  assert.match(sidebar, /className: 'bt-icon-rail', 'aria-label': t\('FlyBot'\)/)
  assert.match(sidebar, /className: wide \? 'bt-side bt-side-split' : 'bt-side bt-rail'/)
  assert.equal(ICON_RAIL_WIDTH, 72)
  assert.match(PARITY_SHELL_CSS, /\.bt-icon-rail\{[^}]*width:72px/)
})

test('Search, New, Inbox, Kanban and Projects stay in the sidebar', () => {
  const sidebar = src('sidebar.js')
  assert.match(sidebar, /'aria-label': t\('Search'\)/)
  assert.match(sidebar, /'aria-label': t\('New…'\)/)
  assert.equal(sidebar.match(/h\(InboxRow,/g)?.length, 1)
  assert.ok(sidebar.indexOf('h(InboxRow,') < sidebar.indexOf("className: 'bt-list'"))
  assert.equal(sidebar.match(/h\(KanbanRow,/g)?.length, 1)
  assert.equal(sidebar.match(/h\(ProjectsNav,/g)?.length, 1)
  assert.ok(sidebar.includes("h(FlyBotSections,"))
})

test('desktop composer is a taller rounded pill; phone rules are not moved here', () => {
  assert.match(PARITY_SHELL_CSS, /@media \(min-width:641px\)/)
  const desktop = PARITY_SHELL_CSS.split('@media (min-width:641px)')[1]
  assert.match(desktop, /\[data-composer-card\]\{[^}]*min-height:86px/)
  assert.match(desktop, /\[data-composer-card\]\{[^}]*border-radius:20px/)
  assert.match(desktop, /\[data-composer-card\] \[class\*=\"_tools\"\]\{order:1/)
  assert.match(desktop, /\[data-composer-card\]>\[data-input-scroll\]\{order:2/)
  assert.match(desktop, /\[data-composer-card\] \[class\*=\"_trailing\"\]\{order:3/)
  assert.match(desktop, /:focus-visible\{outline:2px solid var\(--bt-accent\)/)
  assert.doesNotMatch(PARITY_SHELL_CSS, /@media \(max-width:640px\)/)
  assert.doesNotMatch(PARITY_SHELL_CSS, /\.bt-flybot-approvals\{left:/)
})

test('parity shell styles install after conversation and flybot styles, before phone styles', () => {
  const at = name => index.indexOf(`installCompiledStyles(${name}`)
  assert.ok(at('PARITY_SHELL_CSS') > 0, 'PARITY_SHELL_CSS is installed in the shell group')
  assert.ok(at('FLYBOT_CSS') < at('PARITY_SHELL_CSS'))
  assert.ok(at('PARITY_SHELL_CSS') < at('MOBILE_CSS'))
  const conv = index.indexOf("installCompiledStyles(CONVERSATION_CSS, 'conversation')")
  const again = index.indexOf("installCompiledStyles(PARITY_SHELL_CSS, 'parity-shell-conversation')")
  assert.ok(conv >= 0 && again > conv, 'composer overrides follow CONVERSATION_CSS')
})


test('shell metrics follow the 1920×1072 screenshot measurements', () => {
  assert.equal(ICON_RAIL_WIDTH, 72)
  assert.equal(CHAT_LIST_WIDTH, 360)
  assert.equal(SHELL_LEFT_WIDTH, 432)
  assert.equal(COMPOSER_HEIGHT, 86)
  assert.equal(HEADER_HEIGHT, 56)
  assert.match(PARITY_SHELL_CSS, /\.bt-icon-rail\{[^}]*width:72px/)
  assert.match(PARITY_SHELL_CSS, /\.bt-icon-rail\{[^}]*gap:6px/)
  assert.match(PARITY_SHELL_CSS, /\.bt-rail-btn\{[^}]*width:40px;height:40px/)
  assert.match(PARITY_SHELL_CSS, /\.bt-rail-btn\{[^}]*border-radius:12px/)
  assert.match(PARITY_SHELL_CSS, /\.bt-rail-btn svg\{width:20px;height:20px\}/)
  assert.match(PARITY_SHELL_CSS, /\.bt-side\.bt-side-split \.bt-row-name\{font-size:14px;line-height:20px;font-weight:500/)
  assert.match(PARITY_SHELL_CSS, /\.bt-side\.bt-side-split \.bt-row-preview\{font-size:12px;line-height:16px;font-weight:400/)
  assert.match(PARITY_SHELL_CSS, /\.bt-side\.bt-side-split \.bt-row-title\{[^}]*text-overflow:ellipsis;white-space:nowrap/)
  assert.match(PARITY_SHELL_CSS, /\.bt-side\.bt-side-split \.bt-list\{[^}]*overflow-y:auto/)
  assert.match(PARITY_SHELL_CSS, /\.bt-side\.bt-side-split \.bt-hint\{[^}]*text-align:center/)
  assert.match(PARITY_SHELL_CSS, /\.bt-rail-btn:disabled\{opacity:\.4;cursor:not-allowed\}/)
  assert.match(PARITY_SHELL_CSS, /\.bt-rail-btn:hover\{background:var\(--bt-hover\)/)
  assert.match(PARITY_SHELL_CSS, /\.bt-rail-btn\[aria-current=page\][^}]*--bt-selected/)
  const desktop = PARITY_SHELL_CSS.split('@media (min-width:641px)')[1]
  assert.match(desktop, /min-height:56px/)
  assert.match(desktop, /min-height:86px/)
  assert.match(desktop, /border-radius:20px/)
  assert.match(desktop, /border:1px solid/)
  assert.match(PARITY_SHELL_CSS, /@media \(min-width:1025px\)/)
  assert.match(PARITY_SHELL_CSS, /width:432px;min-width:432px/)
})
