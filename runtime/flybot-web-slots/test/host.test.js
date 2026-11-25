import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canRetry, installFlybotHost, uninstallFlybotHost, defaultNames } from '../src/host.js'
import { createSlotRegistry } from '../src/slots.js'

test('installs an idempotent __flybot__ host with a slot registry', () => {
  uninstallFlybotHost(globalThis.__flybot__)
  const first = installFlybotHost()
  const second = installFlybotHost()
  assert.equal(first, second)
  assert.equal(globalThis.__flybot__, first)
  assert.equal(typeof first.call, 'function')
  assert.equal(typeof first.slots.register, 'function')
  const off = first.slots.register('flybot.settings.page', { id: 'social', order: 100, component: () => null })
  assert.equal(first.slots.entries('flybot.settings.page').length, 1)
  off()
  assert.equal(first.slots.entries('flybot.settings.page').length, 0)
  uninstallFlybotHost(first)
  assert.equal(globalThis.__flybot__, undefined)
})

test('canRetry treats explicit retry:false as terminal', () => {
  assert.equal(canRetry({ retry: false }), false)
  assert.equal(canRetry({ retry: true }), true)
  assert.equal(canRetry({}), true)
  assert.equal(canRetry(undefined), true)
})

test('names helpers format a friend Bot with its owner', () => {
  const names = defaultNames()
  assert.equal(names.friendBotOwner({ remote: { owner: 'Bob' } }), 'Bob')
  assert.equal(names.remoteMentionLabel({ name: 'Chief', owner: 'Bob' }), 'Chief (Bob)')
  assert.equal(names.remoteMentionLabel({ name: 'Chief', owner: 'Chief' }), 'Chief')
})

test('register rejects invalid entries and notifies subscribers', () => {
  const slots = createSlotRegistry()
  assert.throws(() => slots.register('', { id: 'x' }))
  assert.throws(() => slots.register('flybot.x', null))
  const seen = []
  const stop = slots.subscribe('flybot.session.dock', () => seen.push(slots.entries('flybot.session.dock').length))
  slots.register('flybot.session.dock', { id: 'b', order: 20, component: () => 'b' })
  slots.register('flybot.session.dock', { id: 'a', order: 10, component: () => 'a' })
  assert.deepEqual(slots.entries('flybot.session.dock').map((e) => e.id), ['a', 'b'])
  assert.deepEqual(seen, [1, 2])
  stop()
})
