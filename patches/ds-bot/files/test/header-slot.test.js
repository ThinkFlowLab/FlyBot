import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// `conversation.session.header` is a `single` slot, and the shell's own occupant
// (ui-conversation's ConversationSessionHeader) is the only component that draws
// its child seats: `.lineage`, `.actions`, `.utilities` and `.corner`. Claiming the
// slot with a lower priority ("shadowing") swaps that component out, so none of
// those four seats render at all — the subagent catalog button (ui-subagent
// registers `SubagentCatalogAction` into `.actions`) silently disappears.
// FlyBot's own pill therefore belongs in the `.utilities` list beside the shell's
// seats, never on the slot that owns them.
const src = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')

/** Non-comment source lines only, so a comment that mentions the call cannot satisfy or break a check. */
const code = src
  .split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

test('the shell keeps its own conversation.session.header occupant', () => {
  assert.doesNotMatch(
    code,
    /shadow\(\s*'conversation\.session\.header'\s*,/,
    'ds-bot must not register into the single slot conversation.session.header: '
    + 'the shell\'s occupant is what renders .lineage/.actions/.utilities/.corner, '
    + 'and the subagent catalog button lives in .actions',
  )
})

test('the Bot pill is appended to conversation.session.header.utilities', () => {
  const utilities = /shadow\(\s*'conversation\.session\.header\.utilities'\s*,\s*\{([^}]*)\}\s*,\s*HeaderPill\s*\)/.exec(code)
  assert.ok(utilities, 'HeaderPill must register into conversation.session.header.utilities')
  assert.match(utilities[1], /\bid:\s*'bot-pill'/, 'the utilities entry carries a stable id')
})
