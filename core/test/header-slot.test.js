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
const header = readFileSync(new URL('../src/client/header.js', import.meta.url), 'utf8')

/** Non-comment source lines only, so a comment that mentions the call cannot satisfy or break a check. */
const code = src
  .split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')
const headerCode = header
  .split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')
/** The body of one exported component, so an effect cannot count from a neighbour. */
const bodyOf = name => {
  const at = headerCode.indexOf(`export function ${name}(`)
  assert.ok(at !== -1, `${name} is exported`)
  const next = headerCode.indexOf('\nexport function ', at + 1)
  return headerCode.slice(at, next === -1 ? undefined : next)
}

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

// The shell renders .utilities only while its chrome shows (a blank Session hides it, hideChrome =
// blank), so the pill's page effects cannot live in the pill. They must not be given a seat of their
// own either: `.corner` is the one header seat the shell draws in every state, and it is a `single`
// slot that ui-sidebar-right's ExpandButton already owns at priority 0. A second registration in the
// same cell throws (`single slot "…" already has a registration at priority 0`) out of `apply`, so
// FlyBot's whole client plugin fails to load. The effects are installed once from `apply` instead.
test('#803: the page effects are installed from apply, not parked in a slot', () => {
  assert.doesNotMatch(
    code,
    /shadow\(\s*'conversation\.session\.header\.corner'\s*,/,
    'ds-bot must not register into conversation.session.header.corner: it is a single slot whose '
    + 'occupant is ui-sidebar-right\'s ExpandButton, and a same-priority registration throws',
  )
  assert.match(code, /installHeaderEffects\(/, 'the client plugin installs the header effects from apply')
  const pill = bodyOf('HeaderPill')
  for (const effect of ['btRemoteChat', 'btFriendChat', 'btRoom', 'beginVisit', 'holdComposerLabel']) {
    assert.ok(!pill.includes(effect), `${effect} does not run in the pill`)
  }
})
