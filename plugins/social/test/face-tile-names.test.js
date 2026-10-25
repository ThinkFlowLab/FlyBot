import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// #1102: lobby labels under the avatars were one nowrap line, so "SelfA1025 (you)"
// and "SelfB1025" drew as "SelfA1025 …" / "SelfB1025 …". They wrap, and the full
// label stays on the tile's title.
test('#1102: face-lobby names under avatars wrap instead of ellipsizing', () => {
  const css = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const rule = (selector) => {
    const found = css.match(new RegExp(`${selector.replace('.', '\\.')}\\{[^}]*\\}`))
    assert.ok(found, selector)
    return found[0]
  }
  const name = rule('.fs-tile-name')
  const sub = rule('.fs-tile-sub')
  assert.match(name, /white-space:normal/)
  assert.match(name, /overflow-wrap:anywhere/)
  assert.doesNotMatch(name, /white-space:nowrap/)
  assert.doesNotMatch(name, /text-overflow:ellipsis/)
  assert.match(sub, /white-space:normal/)
  assert.doesNotMatch(sub, /text-overflow:ellipsis/)
  assert.match(css, /\.fs-tiles\{[^}]*minmax\(96px,1fr\)/)
  assert.match(css, /className: 'fs-tile-name', 'data-flybot': 'face-owner', title: label \}, label\)/)
})
