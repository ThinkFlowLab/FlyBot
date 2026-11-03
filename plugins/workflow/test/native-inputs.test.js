import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../index.js'

test('native dispatch preserves structured handoff identity instead of collapsing different inputs into the same text', async t => {
  let lifecycle; const messages = []
  const fb = { bot: { create() {}, list: () => [{ id: 'chief' }], async send(message) { messages.push(message); return { ok: true } } },
    api: { handle: () => () => {} }, tasks: { onWrite: () => () => {} },
    projects: { context: () => ({ projectId: 'p' }), read: () => ({ chief: { botId: 'chief' } }), execution: { connectPools(value) { lifecycle = value; return () => {} } } } }
  const plugin = apply({ flybot: { scope: () => fb }, effect() {} }, { persist: false })
  t.after(() => plugin.dispose())
  const base = { taskId: 'task', botId: 'current-carrier', brief: 'Same Task and acceptance', outputs: [{ name: 'handoff' }] }
  const inputs = { handoff: { id: 'first', from: 'p:chief', evidence: [{ sha: 'candidate' }] }, note: 'Exact text', count: 0, required: false }
  await lifecycle.dispatch({ ...base, inputs })
  await lifecycle.dispatch({ ...base, inputs: { ...inputs, handoff: { ...inputs.handoff, id: 'returned', from: 'p:tester' } } })
  assert.notEqual(messages[0].text, messages[1].text, 'A return to the same physical Session must not be deduplicated as its previous dispatch')
  assert.deepEqual(JSON.parse(messages[0].text.split('\n').find(line => line.startsWith('Input handoff: ')).slice('Input handoff: '.length)), inputs.handoff)
  assert.ok(messages[0].text.includes('Input count: 0')); assert.ok(messages[0].text.includes('Input required: false'))
  assert.ok(messages[0].text.includes('Input note: Exact text'))
  await lifecycle.dispatch({ ...base, inputs })
  assert.equal(messages[2].text, messages[0].text, 'The same dispatch still has stable content for ordinary duplicate protection')
})
