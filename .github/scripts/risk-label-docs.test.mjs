// #629: the `risk:T*` label is written by a poll, so a PR a person reads can carry none. These checks
// keep the written promise in step with what a poll can deliver — otherwise an absent label reads as a
// low tier (fail open) or as a reason to block (stall), and readers conclude the controller is broken.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const section = (text, heading) => {
  const start = text.indexOf(heading)
  assert.ok(start >= 0, `no section ${heading}`)
  const end = text.indexOf('\n### ', start + heading.length)
  return text.slice(start, end < 0 ? undefined : end)
}

const labels = JSON.parse(read('../labels.json'))
const agents = read('../../AGENTS.md')
const controller = read('../../docs/controller.md')

test('labels.json: each risk tier says it is advisory and names the recomputing gate', () => {
  const risk = labels.filter((l) => /^risk:T\d$/.test(l.name))
  assert.deepEqual(risk.map((l) => l.name), ['risk:T0', 'risk:T1', 'risk:T2', 'risk:T3'])
  for (const l of risk) {
    assert.match(l.description, /advisory/i, `${l.name}: a person reading the label must see it is advisory`)
    assert.match(l.description, /merge gate recomputes/i, `${l.name}: name the authority, not the poll`)
  }
})

test('AGENTS.md: an absent risk label is not a tier and not a reason to block', () => {
  const s = section(agents, '### Issue labels')
  assert.match(s, /`risk:T\*` label is advisory, and never the tier a decision uses/, 'the labels section must say the label is advisory')
  assert.match(s, /never as T0\/T1 and never as a reason to block/, 'say what a missing label does not mean')
  assert.match(s, /merge-gate` recomputes from the diff/, 'name the tier that actually decides')
})

test('docs/controller.md: the label is a poll artifact, so it can be absent', () => {
  const s = section(controller, '## Limits')
  assert.match(s, /A missing `risk:T\*` is not a tier/, 'the Limits section must say a missing label is not a tier')
  assert.match(s, /recomputes the tier from the diff/, 'point at the gate, not the label')
  assert.match(s, /2\.5–6 hours apart/, 'keep the observed run spacing that makes the poll unreliable (#629)')
})
