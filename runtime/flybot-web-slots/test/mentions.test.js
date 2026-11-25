import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachMentionTriggers, mentionSource, SOCIAL_MENTION_SOURCE, watchMentionTriggers } from '../src/mentions.js'
import { installFlybotHost, uninstallFlybotHost } from '../src/host.js'

const fakeTriggers = () => {
  const sources = []
  return {
    sources,
    registerSource(source) {
      sources.push(source)
      return () => {
        const at = sources.indexOf(source)
        if (at !== -1) sources.splice(at, 1)
      }
    },
  }
}

test('mention source lists FlyBot composer.mention candidates and picks their value', async () => {
  const host = installFlybotHost({ replace: true, call: async () => ({}) })
  host.slots.register('flybot.composer.mention', {
    id: 'social',
    order: 100,
    candidates: async (query) => {
      const rows = [
        { name: 'Chief (Bob)', description: '@chief.bob', section: 'Bots', value: '@Chief (Bob) ' },
        { name: 'Ada', description: '@ada.home', section: 'Bots', value: '@Ada ' },
      ]
      const needle = String(query ?? '').toLowerCase()
      return needle ? rows.filter(row => row.name.toLowerCase().includes(needle)) : rows
    },
  })
  const source = mentionSource(host.slots)
  assert.equal(source.trigger, '@')
  assert.equal(source.name, SOCIAL_MENTION_SOURCE)
  const all = await source.candidates({ sessionId: 's1' }, { query: '' })
  assert.equal(all.length, 2)
  assert.deepEqual(all[0], { name: 'Chief (Bob)', description: '@chief.bob', section: 'Bots', value: '@Chief (Bob) ' })
  const filtered = await source.candidates({ sessionId: 's1' }, { query: 'ada' })
  assert.equal(filtered.length, 1)
  assert.equal(filtered[0].name, 'Ada')
  assert.deepEqual(source.onPick({ candidate: filtered[0] }), { text: '@Ada ' })
  uninstallFlybotHost(host)
})

test('attachMentionTriggers registers on the official registerSource seam and updates with the slot', async () => {
  const host = installFlybotHost({ replace: true, call: async () => ({}) })
  const triggers = fakeTriggers()
  const detach = attachMentionTriggers(triggers, host.slots)
  assert.equal(triggers.sources.length, 1)
  host.slots.register('flybot.composer.mention', {
    id: 'social',
    candidates: async () => [{ name: 'Chief', value: '@Chief ' }],
  })
  assert.equal(triggers.sources.length, 1)
  const rows = await triggers.sources[0].candidates({}, { query: '' })
  assert.equal(rows[0].value, '@Chief ')
  detach()
  assert.equal(triggers.sources.length, 0)
  uninstallFlybotHost(host)
})

test('watchMentionTriggers is a no-op without inputTriggers, and injects when the service exists', () => {
  const host = installFlybotHost({ replace: true, call: async () => ({}) })
  assert.equal(typeof watchMentionTriggers({}, host.slots), 'function')
  const triggers = fakeTriggers()
  const detach = watchMentionTriggers({ inputTriggers: triggers }, host.slots)
  assert.equal(triggers.sources.length, 1)
  detach()
  assert.equal(triggers.sources.length, 0)
  uninstallFlybotHost(host)
})
