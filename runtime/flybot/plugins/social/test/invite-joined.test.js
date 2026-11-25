// A group link for a room this home already holds (#1176): the link is no knock, so the dialog must say
// the room is in the sidebar and offer nothing to Join from.
//
// The state comes from the host (`room-invite-preview` answers `joined` whether the link seated the room
// or the host added a Bot by add-member, `core/src/host/room-membership.js`), so all this half has to do
// is read `joined` *before* `claimed` — a room that arrived by add-member never carries `claimed`, and
// the old order fell through to the preview card, whose Join sent a claim that changed nothing.
//
// The assertion reads the shipped `client.js`, the artefact the browser loads, the way
// `group-phone.test.js` pins the phone block: a rule that only exists in a source comment would not count.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// One function body, from its opening line to the next top-level `const <name> = async`: what a reader
// of the dialog sees between the preview answer and the Join handler.
const bodyOf = (name) => {
  const start = SOURCE.indexOf(`const ${name} = async (text) => {`)
  assert.notEqual(start, -1, `${name} is in the shipped file`)
  const rest = SOURCE.slice(start + 1)
  const end = rest.search(/\n {6}const \w+ = (async )?\(/)
  return end === -1 ? rest : rest.slice(0, end)
}

test('#1176: the shipped dialog branches on joined before it reads claimed', () => {
  const body = bodyOf('previewLocal')
  const joined = body.indexOf('if (seen?.joined) {')
  const claimed = body.indexOf('if (seen?.claimed) {')
  assert.notEqual(joined, -1, 'the joined branch is drawn from the preview answer')
  assert.notEqual(claimed, -1, 'the claim branch is still there for a claim with no room here')
  assert.ok(joined < claimed, 'joined is read first: an add-member room carries no claim')
})

test('#1176: the joined branch says the room is here and offers nothing to join', () => {
  const body = bodyOf('previewLocal')
  const start = body.indexOf('if (seen?.joined) {')
  const branch = body.slice(start, body.indexOf('\n        }', start) + 1)
  assert.match(branch, /This group is already in your sidebar\./)
  assert.doesNotMatch(branch, /preview:/, 'no card is drawn, so there is no Join button')
  assert.doesNotMatch(branch, /room-invite-ask/, 'and no claim is sent')
  assert.doesNotMatch(SOURCE, /You already joined this group with that link/, 'one sentence for a room that is here, not two')
})

test('#1176: a claim with no room here still waits, so the Join button stays', () => {
  const body = bodyOf('previewLocal')
  const claimed = body.indexOf('if (seen?.claimed) {')
  const branch = body.slice(claimed, body.indexOf('\n        }', claimed) + 1)
  assert.match(branch, /Waiting for \$\{who\} to let you in/)
  assert.match(branch, /preview: \{/, 'the card stays for a knock nobody answered yet')
})
