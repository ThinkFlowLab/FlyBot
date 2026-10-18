// The sidebar + menu (#283). The component and its CSS are checked as source here (the repo's
// tests have no layout engine): an action row's description is its own line under the title,
// and an inline Bot-row hint can never push the name out.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')
const rule = (css, selector) => new RegExp(`(?:^|\\n)${selector.replaceAll('.', '\\.')}\\{([^}]*)\\}`).exec(css)?.[1] ?? ''

test('+ menu: an action row puts its description under the title, always, so hovering never hides the title', () => {
  const source = read('new-chat.js')
  assert.match(source, /className: 'bt-option-copy'/)
  assert.match(source, /className: 'bt-option-sub'/)
  // Only a Bot row keeps the inline hint, and only while active.
  assert.match(source, /option\.bot && option\.hint && index === active \? h\('span', \{ className: 'bt-option-hint' \}/)
  assert.doesNotMatch(source, /(?<!bot && )option\.hint && index === active/)
})

test('+ menu: the inline hint is capped and ellipsized, the copy column and its subline wrap', () => {
  const css = read('styles.js')
  const hint = rule(css, '.bt-option-hint')
  assert.match(hint, /max-width:50%/)
  assert.match(hint, /text-overflow:ellipsis/)
  assert.doesNotMatch(hint, /flex:none/)
  assert.match(rule(css, '.bt-option-copy'), /flex-direction:column/)
  assert.match(rule(css, '.bt-option-copy'), /min-width:0/)
  assert.match(rule(css, '.bt-option-sub'), /white-space:normal/)
  assert.match(rule(css, '.bt-option-label'), /min-width:0/)
})
