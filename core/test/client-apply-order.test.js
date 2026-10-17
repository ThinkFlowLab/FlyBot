import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// `ctx.effect` runs its body immediately, so an effect that reads `roster` before
// `const roster` is declared throws a TDZ error and the whole client plugin fails to
// load (blank "Failed to load plugins" page, #176 regression).
test('client apply declares roster before effects that read it', () => {
  const src = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')
  const declared = src.indexOf('const roster = createSource(')
  assert.ok(declared > 0, 'roster declaration found')
  for (const label of ['ds-bot: tab title']) {
    const effect = src.indexOf(`'${label}'`)
    assert.ok(effect > 0, `${label} effect found`)
    assert.ok(declared < effect, `${label} must come after const roster`)
  }
})
