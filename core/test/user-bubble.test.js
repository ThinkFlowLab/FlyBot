import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { luminance } from '../src/client/inks.js'
import { allThemes, shellTokens, themeCss } from '../src/client/themes.js'

// The browser bundle holds every style sheet ds-bot installs; the bundle test
// keeps it in step with src/client.
const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// CSS declaration blocks hold no braces, so a declaration's rule runs from the
// nearest `{` before it to the nearest `}` after it.
function rulesWith(pattern) {
  const rules = []
  for (const match of bundle.matchAll(pattern)) {
    const open = bundle.lastIndexOf('{', match.index)
    const close = bundle.indexOf('}', match.index)
    const start = Math.max(bundle.lastIndexOf('}', open), bundle.lastIndexOf('\n', open), bundle.lastIndexOf('`', open)) + 1
    rules.push({ selector: bundle.slice(start, open).trim(), body: bundle.slice(open + 1, close) })
  }
  return rules
}
const declared = (body, property) => body.split(';').map(item => item.trim()).find(item => item.startsWith(`${property}:`))?.slice(property.length + 1)
const surface = body => declared(body, 'background') ?? declared(body, 'background-color')
const ruleFor = selector => {
  const rule = rulesWith(/color:var\(--bt-user-ink\)/g).find(item => item.selector.startsWith(selector))
  assert.ok(rule, `no rule for ${selector}`)
  return rule
}

test('every rule that writes in the user ink paints the user surface under it', () => {
  const rules = rulesWith(/(?<=[{;])color:var\(--bt-user-ink\)/g)
  assert.ok(rules.length >= 3)
  for (const { selector, body } of rules) {
    assert.match(surface(body) ?? '', /^var\(--bt-user\)(!important)?$/, selector)
  }
})

test('no ds-bot text color sits on a surface that a skin owns', () => {
  for (const { selector, body } of rulesWith(/(?<=[{;])color:var\(--bt-/g)) {
    assert.doesNotMatch(surface(body) ?? '', /--dsw-/, selector)
  }
})

test('ds-bot leaves the host bubble variables to the host and its skins', () => {
  assert.doesNotMatch(bundle, /--dsw-specific-bubble/)
  assert.doesNotMatch(bundle, /conversationTokens|installBubbleTokens/)
  for (const [id, theme] of Object.entries(allThemes())) {
    assert.deepEqual(Object.keys(shellTokens(theme)).filter(name => name.includes('bubble')), [], id)
  }
})

const themeVars = (theme, dark) => {
  const block = themeCss(theme).split('\n').find(line => line.startsWith(dark ? 'html body[data-ds-dark-theme]{' : 'html body{'))
  return Object.fromEntries(block.slice(block.indexOf('{') + 1, -1).split(';').map(item => item.split(':')))
}
const parse = color => {
  if (/^#[0-9a-f]{6}$/i.test(color)) return { hex: color.toLowerCase(), alpha: 1 }
  const parts = color.match(/^rgba?\(([^)]+)\)$/)[1].split(',').map(Number)
  return { hex: `#${parts.slice(0, 3).map(part => part.toString(16).padStart(2, '0')).join('')}`, alpha: parts[3] ?? 1 }
}
const over = (top, under) => {
  const { hex, alpha } = parse(top)
  if (alpha === 1) return hex
  const channel = (color, index) => parseInt(color.slice(index, index + 2), 16)
  return `#${[1, 3, 5].map(index => Math.round(channel(hex, index) * alpha + channel(under, index) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}
const contrast = (ink, paper) => {
  const [a, b] = [luminance(ink), luminance(paper)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

test('the user ink reads on the user surface in every built-in theme and mode', () => {
  for (const id of ['deepseek', 'mono', 'paper', 'moonlight']) {
    for (const dark of [false, true]) {
      const vars = themeVars(allThemes()[id], dark)
      const ratio = contrast(over(vars['--bt-user-ink'], vars['--bt-user']), over(vars['--bt-user'], vars['--bt-main']))
      assert.ok(ratio >= 4.5, `${id} ${dark ? 'dark' : 'light'}: ${ratio.toFixed(2)}:1`)
    }
  }
})

// A dark skin repaints the host bubble surface (dsh-dream-skin's underwater theme
// sets this value) and leaves ds-bot's colors alone.
const DARK_SKIN = { '--dsw-specific-bubble': 'rgba(31,33,38,.92)', '--dsw-alias-label-primary': '#ffffff' }
const resolve = (value, vars) => {
  const plain = value.replace(/!important$/, '')
  const match = plain.match(/^var\((--[\w-]+)(?:,(.+))?\)$/)
  if (!match) return plain
  if (vars[match[1]] !== undefined) return resolve(vars[match[1]], vars)
  assert.ok(match[2] !== undefined, `${match[1]} is unset`)
  return resolve(match[2], vars)
}

test('a user message stays readable when a dark skin repaints the host bubble', () => {
  for (const id of ['deepseek', 'mono', 'paper', 'moonlight']) {
    const vars = { ...themeVars(allThemes()[id], true), ...DARK_SKIN }
    const page = vars['--bt-main']
    for (const selector of ['.bt-ubody', '[class*="_userRow"] [class*="_bubble"]']) {
      const { body } = ruleFor(selector)
      const paper = over(resolve(surface(body), vars), page)
      const ink = over(resolve(declared(body, 'color'), vars), paper)
      assert.ok(contrast(ink, paper) >= 4.5, `${id} ${selector}: ${contrast(ink, paper).toFixed(2)}:1`)
    }
  }
})

test('the surface wins over the host bubble rule that reads the skin variable', () => {
  const { body } = ruleFor('[class*="_userRow"] [class*="_bubble"]')
  assert.equal(surface(body), 'var(--bt-user)!important')
  assert.equal(declared(body, 'color'), 'var(--bt-user-ink)!important')
})

test('a held face-room outgoing line uses pending styles, not the sent user ink', () => {
  const src = readFileSync(new URL('../src/client/user-message.js', import.meta.url), 'utf8')
  assert.match(src, /'data-held': held/)
  assert.match(src, /\.bt-umsg\[data-held\] \.bt-ubody\{[^}]*color:var\(--bt-ink\)/)
  assert.doesNotMatch(src, /\.bt-umsg\[data-held\] \.bt-ubody\{[^}]*color:var\(--bt-user-ink\)/)
})
