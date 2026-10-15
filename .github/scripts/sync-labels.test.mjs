import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { plan } from './sync-labels.mjs'

const wanted = JSON.parse(readFileSync(new URL('../labels.json', import.meta.url), 'utf8'))

test('plan: create missing, keep equal, update changed, ignore others', () => {
  const a = { name: 'a', color: '0E8A16', description: 'x' }
  const b = { name: 'b', color: '000000', description: 'y' }
  const c = { name: 'c', color: '000000', description: 'z' }
  const out = plan([a, b, c], [{ name: 'A', color: '0e8a16', description: 'x' }, { name: 'b', color: 'FFFFFF', description: 'y' }, { name: 'other', color: '000000', description: null }])
  assert.deepEqual(out.map((p) => p.action), ['keep', 'update', 'create'])
})

test('labels.json: valid, unique, agent-ready is the approval label', () => {
  const names = wanted.map((l) => l.name.toLowerCase())
  assert.equal(new Set(names).size, names.length)
  for (const l of wanted) {
    assert.match(l.color, /^[0-9A-F]{6}$/i)
    assert.ok(l.description.length > 0 && l.description.length <= 100, l.name)
  }
  for (const n of ['agent-task', 'agent-ready', 'agent-working', 'needs-human', 'hold']) assert.ok(names.includes(n), n)
})

test('the agent-task form never applies agent-ready', () => {
  const form = readFileSync(new URL('../ISSUE_TEMPLATE/agent-task.yml', import.meta.url), 'utf8')
  const labels = form.split('\n').find((l) => l.startsWith('labels:'))
  assert.ok(labels && !/agent-ready/.test(labels), labels)
})
