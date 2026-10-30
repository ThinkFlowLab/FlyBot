// #1347: a real mouse click-through of a running FlyBot found UI defects that no test covered.
// Each one is a shape of the shipped page, so each test reads the CSS or the source that draws it and
// asserts the property that was wrong — not the fix by name. Nothing here imports a client module:
// those need React from a DSH install, and the neighbours (`ui-polish-406.test.js`) read the text.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { visibleText } from '../src/shared/preview.js'
import { failureSentence } from '../src/shared/failure-copy.js'
import { failureLines } from '../src/shared/turn-failures.js'

const read = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
// One rule body out of a CSS template literal, matched on its selector.
const rule = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`(?:^|\\n)${escaped}\\{([^}]*)\\}`))?.[1] ?? ''
}
// The whole declaration line. `[^}]*` above stops at the `}` inside an interpolated
// `${SPRING_SHAPE.easing}`, so a rule that carries one has to be read as a line.
const ruleLine = (css, selector) => css.split('\n').find(line => line.startsWith(`${selector}{`)) ?? ''
const block = (css, opener) => css.match(new RegExp(`${opener.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''

test('#1347: a settings row never breaks its own label or its control words', () => {
  const css = read('bot-settings.js')
  const label = rule(css, '.bt-bs-row>.bt-set-copy>.bt-bs-label')
  assert.match(label, /white-space:nowrap/, 'the label is one line, so "Name" cannot become "Nam" + "e"')
  assert.match(label, /text-overflow:ellipsis/, 'and a label too long to fit ends in an ellipsis, never mid-word')
  // A hint is a sentence, not a label: it wraps and is never cut, or the settings become unreadable.
  assert.doesNotMatch(css, /\.bt-set-hint\{[^}]*text-overflow:ellipsis/)
  const control = rule(css, '.bt-bs-row .bt-soft,.bt-bs-row .bt-mini')
  assert.match(control, /white-space:nowrap/, '"Test connection" and "Change" stay whole')
  assert.match(control, /flex:none/, 'a control is not squeezed below its own words')
  // The copy is what gives way, but never below a few characters of its own.
  assert.match(rule(css, '.bt-bs-row>.bt-set-copy'), /flex:1 1 8ch/)
})

test('#1347: the panel is a container, and below 300px the row stacks instead of clipping', () => {
  // A container query only fires where one is declared; without the declaration the rule is dead CSS
  // that reads green and fixes nothing.
  assert.match(ruleLine(read('styles.js'), '.bt-panel'), /container:bt-panel\/inline-size/)
  const stacked = block(read('bot-settings.js'), '@container bt-panel (max-width:300px)')
  assert.match(stacked, /\.bt-bs-row\{flex-wrap:wrap/, 'the row stacks at the panel floor')
  assert.match(stacked, /\.bt-bs-row>\.bt-set-copy\{flex:1 1 100%/, 'the copy keeps the whole width')
  assert.match(stacked, /\.bt-bs-input\{[^}]*text-align:left/, 'a stacked field is left-aligned, like any form field')
  // The connection test's own button is covered too.
  assert.match(rule(read('model-test.js'), '.bt-model-test>.bt-soft'), /white-space:nowrap/)
})

test('#1347: a preview shows the words of a line, never its fence', () => {
  assert.equal(visibleText('<untrusted-message from="Coder (Bob)">\nhello there\n</untrusted-message>'), 'hello there')
  // The shape a real instance showed in its sidebar: the opener arrived cut, so only its tail survived.
  assert.equal(visibleText('kick from="User"> B test 4 >'), 'kick B test 4 >')
  // A nested fragment cannot rebuild a marker the strip already removed.
  assert.equal(visibleText('</untrusted-</untrusted-message>message> after'), 'after')
  assert.equal(visibleText('untrusted-message> x'), 'x')
  // Plain words stay exactly as said, folded to the one line a row is.
  assert.equal(visibleText('a\nb   c'), 'a b c')
  assert.equal(visibleText(''), '')
  assert.equal(visibleText(undefined), '')
})

test('#1347: both sidebar row kinds read their preview through that helper', () => {
  const text = read('text.js')
  const preview = text.slice(text.indexOf('export function previewOf'), text.indexOf('const formatTokens'))
  assert.match(preview, /return visibleText\(/, 'a Bot row preview is sanitized where it is built')
  const sidebar = read('sidebar.js')
  assert.match(sidebar, /nameMentions\(visibleText\(room\.preview\), roster\)/, "a group row sanitizes the host's preview")
  const channel = readFileSync(new URL('../src/host/channel.js', import.meta.url), 'utf8')
  assert.match(channel, /const previewText = last \? visibleText\(last\.text\) : ''/, 'the host sends words, not a fence')
})

test('#1347: the details drawer copies, says so, and names the button for what it does', () => {
  const source = read('details-drawer.js')
  // The accessible name matches the behaviour: no "Share" on a button that only copies.
  assert.match(source, /'aria-label': copied \? t\('Copied conversation'\) : t\('Copy conversation'\)/)
  assert.doesNotMatch(source, /t\('Share conversation'\)/)
  // A copy that succeeds is announced; a refused one is reported, never swallowed as success. The write
  // goes through the helper that answers what really happened: `navigator.clipboard?.writeText(text)` with
  // no clipboard resolves `undefined`, which the old shape read as a successful copy (#1347).
  assert.match(source, /void copiedToClipboard\(text\)\.then\(written =>/)
  assert.match(source, /if \(!written\) \{ actions\.reportError\?\.\(new Error\(t\('Could not copy the conversation'\)\), 'share'\); return \}/)
  assert.match(source, /actions\.notify\?\.\(t\('Conversation copied as Markdown'\)\)/)
  assert.match(source, /setCopied\(true\)/)
  // Every string it now says has a Chinese entry.
  const i18n = read('i18n.js')
  for (const key of ['Copy conversation', 'Nothing to copy yet', 'Conversation copied as Markdown', 'Could not copy the conversation']) {
    assert.match(i18n, new RegExp(`\\n {2}'${key}': '`), `missing zh entry for ${key}`)
  }
})

test('#1347: the mode word beside the title does not look like a control', () => {
  const chip = rule(read('styles.js'), '[data-slot="conversation.session.header.actions"] [class*="_label"]')
  assert.match(chip, /background:none/, 'no fill, so it reads as a status')
  assert.match(chip, /border-radius:0/)
  // The description stays reachable on hover, which is the only thing behind the chip.
  assert.match(chip, /cursor:help/)
})

test('#1347: a Bot chat with nothing said yet draws its own header', () => {
  const source = read('flybot-slots.js')
  // The same `blank` fact #998 uses for a group, and only then: never beside a header the shell drew.
  assert.match(source, /const botRoom = blank && bot !== undefined && !bot\.remote \? bot : null/)
  assert.match(source, /botRoom \? h\(BotChatStrip,/)
  // The strip names the chat and offers the one thing a blank column cannot: its details.
  assert.match(source, /'data-flybot': 'bot-chat-strip'/)
  assert.match(source, /'bt-chat-strip-name'/)
  assert.match(source, /actions\.toggleDetails\(sessionId\)/)
  assert.match(rule(source, '.bt-chat-strip'), /display:flex/)
})

test('#1347: a blank column says why it is blank, and only while it is blank', () => {
  const source = read('flybot-slots.js')
  // The sentence lives in the strip that already stands in for the missing header, so it is drawn and
  // withdrawn by the same `blank` condition — never beside the shell's own header.
  assert.match(source, /'bt-chat-strip-empty'/)
  assert.match(source, /t\('No messages yet\. Say something to \{name\}\.', \{ name: bot\.name \}\)/)
  assert.match(rule(source, '.bt-chat-strip-empty'), /overflow-wrap:anywhere/)
  assert.match(read('i18n.js'), /'No messages yet\. Say something to \{name\}\.'/)
})

test('#1347: a provider refusal reads as a sentence that says what to change', () => {
  // The exact text a real Inbox showed, cut off where the host stops storing it.
  const raw = '404: {"code":"UnsupportedModel","message":"The requested model does not support the coding plan feature. Please use a model that supports it'
  const said = failureSentence(raw, key => key)
  assert.doesNotMatch(said, /[{}"]/, 'no JSON body reaches the reader')
  assert.doesNotMatch(said, /^404/, 'and no bare status code either')
  assert.match(said, /does not support the coding plan feature/, 'the feature is still named')
  assert.match(said, /Pick another model in the Bot's settings/, 'and the sentence says where to fix it')
  // The same fact without the feature named still gets a sentence.
  assert.equal(failureSentence('{"code":"UnsupportedModel","message":"nope"}', key => key), 'This model does not support that request. Pick another model in the Bot\'s settings.')
  // Another mapped provider code, and one nobody mapped: unchanged is better than a guess.
  assert.match(failureSentence('400: {"code":"ContextLengthExceeded"}', key => key), /longer than this model can read/)
  assert.equal(failureSentence('boom: something new', key => key), 'boom: something new')
  assert.equal(failureSentence('', key => key), '')
  // The chat's own failure lines read through the same helper, so the two surfaces cannot drift.
  const lines = failureLines({ ended: [{ id: 'x', sessionId: 's', silent: true, failed: raw }] }, 's', (key, params) => (params ? key.replace(/\{(\w+)\}/g, (m, n) => params[n]) : key))
  assert.equal(lines.length, 1)
  assert.match(lines[0].text, /Pick another model/)
  // Every sentence above has a Chinese entry.
  const i18n = read('i18n.js')
  for (const key of ['This model does not support that request. Pick another model in the Bot\\\'s settings.', 'The provider does not know this model. Check the model name in the Bot\\\'s settings.', 'The account is out of quota.', 'Too many requests right now. Try again in a moment.']) {
    assert.ok(i18n.includes(`'${key}':`), `missing zh entry for ${key}`)
  }
})

test('#1347: the thread cannot paint above a dialog, a sheet or a scrim', () => {
  const css = read('styles.js')
  // The load-bearing half. The chat column had no stacking context of its own, so any descendant the
  // browser promoted (an entrance animation's transform, a filter, will-change) was ordered against the
  // ROOT stacking context instead of the column, and could sort above a dialog's z-index box. This rule
  // is what carries the fix: raising the tiers alone cannot, because a promoted descendant never reads
  // the column's z-index at all unless the column is a context.
  const column = ruleLine(css, '[class*="_centerCol"]')
  assert.match(column, /isolation:isolate/, 'the chat column is its own stacking context')
  assert.match(column, /z-index:0/, 'and that whole context sits below the panel (40) and dialogs (120)')
  assert.match(column, /position:relative/, 'a z-index needs a positioned box to apply to')
  // Not contain:paint — it would clip the reaction strip and message menu the thread portals out.
  assert.doesNotMatch(column, /contain:paint/)

  // The second half: an explicit tier, so nothing ties with a dialog and wins on DOM order. Before
  // #1347 the context menu and the reaction strip shared z-index 60 with the Settings dialog, so a
  // popover opened after it tied and painted over the dialog.
  assert.equal(rule(css, '.bt-settings-layer').match(/z-index:(\d+)/)?.[1], '120')
  assert.equal(rule(css, '.bt-mem-layer').match(/z-index:(\d+)/)?.[1], '121')
  for (const [file, selector] of [['styles.js', '.bt-menu'], ['styles.js', '.bt-react-strip'], ['sidebar.js', '.bt-update-pop'], ['remote-bot-settings.js', '.bt-remote-sheet-layer']]) {
    const z = Number(ruleLine(read(file), selector).match(/z-index:(\d+)/)?.[1])
    assert.ok(z >= 120, `${selector} floats above the chat and the panel (was ${z})`)
  }
  // The palette stays the topmost sheet; the toast stays above everything.
  assert.equal(rule(css, '.bt-palette-layer').match(/z-index:(\d+)/)?.[1], '140')
  // No dialog or popover may sit in the old ambiguous band any more.
  assert.doesNotMatch(css, /z-index:6[01][;}]/)

  // Each overlay layer is its own stacking context too, so the layer as a whole — scrim and dialog
  // together — is what sits in the tier, whatever a dialog's own contents do.
  for (const [file, selector] of [['styles.js', '.bt-settings-layer'], ['styles.js', '.bt-mem-layer'], ['styles.js', '.bt-palette-layer'], ['remote-bot-settings.js', '.bt-remote-sheet-layer']]) {
    assert.match(ruleLine(read(file), selector), /isolation:isolate/, `${selector} is its own stacking context`)
  }

  // And the scrim actually separates the two surfaces. A 0.32 scrim left the thread legible behind a
  // modal, which read as the chat painting through it; the light theme is now clearly more opaque.
  const alpha = sel => {
    // The selector can appear more than once (the base rule and #1347's override), so take the
    // strongest — that is the one the browser applies last.
    const all = [...css.matchAll(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{background:rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([\\d.]+)\\s*\\)`, 'g'))]
      .map(m => Number(m[1]))
    return all.length ? Math.max(...all) : null
  }
  assert.ok(alpha('body:not([data-ds-dark-theme]) .bt-scrim') >= 0.5, 'the light scrim dims the thread to a backdrop')
  assert.ok(alpha('body[data-ds-dark-theme] .bt-scrim') >= 0.6, 'and so does the dark one')
})

test('#1347: the built bundle carries these rules, so a page reload shows them', () => {
  // The app runs client.js, not src/. A constant that never reached the bundle leaves every fix above
  // in the source only.
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(bundle.includes('container:bt-panel/inline-size'), 'client.js carries the panel container')
  assert.ok(bundle.includes('@container bt-panel (max-width:300px)'), 'client.js carries the stacked row')
  assert.ok(bundle.includes('bt-chat-strip-name'), 'client.js carries the blank-chat strip')
  assert.ok(bundle.includes('Conversation copied as Markdown'), 'client.js carries the copy confirmation')
})

test('#1750: the Project board overlay covers the shell behind its scrim', () => {
  const css = read('project-board.js')
  // The overlay carried `bt-overlay`, a class no stylesheet defines: the board rendered as a short
  // dialog in the page flow, with the bot tree and workflows legible under its rows and nothing
  // dimming them. A modal covers the whole viewport, so the shell cannot be read as more board rows.
  const overlay = rule(css, '.bt-project-overlay')
  assert.match(overlay, /position:fixed/, 'the layer is taken out of the page flow')
  assert.match(overlay, /inset:0/, 'and covers the viewport, not just its own content height')
  assert.match(overlay, /align-items:center/, 'the dialog sits centred in that layer')
  assert.match(overlay, /justify-content:center/)
  // Every other modal in the client pairs a `bt-scrim` sibling with its dialog and dismisses on a
  // click; the Project board was the one overlay with no scrim at all.
  assert.match(css, /className: 'bt-scrim', onClick: close/, 'the scrim renders beside the dialog and closes the overlay')
  // Reuse, not a second visual language: the dialog is kanban's own `bt-mem` surface at kanban's size.
  const dialog = rule(css, '.bt-mem.bt-project-dialog')
  assert.match(dialog, /width:min\(1080px,calc\(100vw - 32px\)\)/, 'the same dialog width as the Board')
  assert.match(dialog, /height:min\(760px,calc\(100vh - 48px\)\)/, 'and the same height, so board rows are not mixed with the shell')

  // The app runs client.js, so the rule only reaches the page once it is in the bundle.
  const bundle = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(rule(bundle, '.bt-project-overlay'), /position:fixed;inset:0/, 'client.js carries the covering layer')
  assert.ok(bundle.includes('bt-mem bt-project-dialog'), 'and the dialog it centres')
})
