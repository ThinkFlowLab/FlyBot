import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt }
}

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Group chat …]", "[Message from …]", or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

// Part B of #645: the default is idle. The prompt used to describe only an active team (a
// coordinator that dispatches, children that report and claim), so a team with no work still
// produced status traffic. Both directions are asserted here: the idle default is present as a
// quotable rule, and the unprompted work instruction is gone.
test('a Bot stays idle until it is addressed or given a task (part B of #645)', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const idle =
    '- By default you stay idle: you do nothing until the user addresses you, you are @-mentioned in a group, or your parent Bot gives you a task. Do not start work, send messages, or report on your own initiative. Being addressed still gets an answer as usual — this rule is about the default when nobody has addressed you.'
  for (const id of ['main', 'worker']) {
    const text = prompt(id)
    assert.ok(text.split('\n').includes(idle), `${id} carries the idle default as its own rule`)
    assert.equal(text.split(idle).length - 1, 1, `${id} carries the idle rule once`)
    assert.doesNotMatch(text, /report back/, `${id} no longer tells a Bot to report back unprompted`)
    assert.doesNotMatch(text, /\bdispatch\b/, `${id} carries no dispatch instruction`)
  }
  assert.match(prompt('main'), /A coordinator acts on a user task, not on its own initiative\./)
  assert.doesNotMatch(prompt('worker'), /coordinator/, 'the coordinator wording belongs to the Main Bot')
  // A Bot that is addressed answers exactly as before: the reply rule is still there, unchanged.
  const replyRule = '- When a "[Reply from …]" arrives, tell the user the outcome if it matters to them.'
  for (const id of ['main', 'worker']) assert.ok(prompt(id).split('\n').includes(replyRule), `${id} still answers a reply`)
})
