// Localized notification template catalog inside this user's DS-Bot (#491):
// versioned subject/body text per kind and locale, a zh-CN → zh → en fallback
// chain, required-variable checks and plain-text interpolation. No delivery, no
// translation: it shapes text a notification panel or worker can show.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { boot, volume } from './helpers.js'
import { openStore } from '../featurekit/store.js'

// The kinds Bot Social emits today (services/bot-social/src/flybot-workspace/*.ts):
// artifact.shared, discover.published|conversation_started, follow.new,
// meeting.shared, messenger.mention|added|call, team.run_shared|join_request|
// member_joined|membership_changed|owner_transferred|removed|join_decided. The built-in catalog
// must cover exactly these and must not invent others.
const S_KINDS = [
  'artifact.shared', 'discover.conversation_started', 'discover.published', 'follow.new',
  'meeting.shared', 'messenger.added', 'messenger.call', 'messenger.mention',
  'team.join_decided', 'team.join_request', 'team.member_joined',
  'team.membership_changed', 'team.owner_transferred', 'team.removed', 'team.run_shared',
]

const call = (bot, op, payload) => bot.endpoint(`notifications/${op}`, payload)
const value = async (bot, op, payload) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}
const refused = async (bot, op, payload, code) => {
  const result = await call(bot, op, payload)
  assert.equal(result.ok, false, `expected ${op} to be refused`)
  assert.equal(result.error.code, code, JSON.stringify(result.error))
  return result.error
}
const featureStore = (bot) => openStore(join(bot.vol.data, 'flybot-workspace', 'features', 'notifications', 'notifications.sqlite3'))

test('the notification catalog loads in this DS-Bot and keeps its own feature directory', async () => {
  const bot = await boot()
  assert.ok(bot.features.loaded.includes('notifications'), JSON.stringify(bot.features.failed))
  assert.ok(existsSync(join(bot.vol.data, 'flybot-workspace', 'features', 'notifications', 'notifications.sqlite3')))
})

test('the built-in catalog covers exactly the kinds Bot Social emits, in en and zh', async () => {
  const bot = await boot()
  const catalog = (await value(bot, 'catalog', {})).items
  assert.deepEqual(catalog.map((item) => item.kind).sort(), S_KINDS)

  const sample = { title: 'T', team_name: 'Team', decision: 'approved', name: 'A', actor_username: 'Ann' }
  for (const kind of S_KINDS) {
    const en = await value(bot, 'render', { kind, locale: 'en', values: sample })
    assert.equal(en.source, 'builtin', kind)
    assert.equal(en.locale, 'en', kind)
    assert.ok(en.subject.length > 0 && en.body.length > 0, kind)
    const zh = await value(bot, 'render', { kind, locale: 'zh', values: sample })
    assert.equal(zh.source, 'builtin', kind)
    assert.equal(zh.locale, 'zh', kind)
    assert.notEqual(zh.body, en.body, `${kind} should be localized`)
    for (const text of [en.subject, en.body, zh.subject, zh.body]) {
      assert.ok(!text.includes('{') && !text.includes('}'), `${kind} left a placeholder: ${text}`)
      assert.ok(!text.includes('undefined'), `${kind} rendered undefined: ${text}`)
    }
  }

  const incomingCall = await value(bot, 'render', {
    kind: 'messenger.call', locale: 'en', values: { title: 'Product team' },
  })
  assert.match(incomingCall.body, /incoming call.*Product team/)
  const newOwner = await value(bot, 'render', {
    kind: 'team.owner_transferred', locale: 'zh-CN', values: { team_name: '产品团队' },
  })
  assert.equal(newOwner.body, '你已成为「产品团队」的所有者。')
})

test('locales fall back zh-CN → zh → en and an unknown kind falls back to the caller text', async () => {
  const bot = await boot()
  const values = { title: '团队', team_name: 'Team' }
  const zhCn = await value(bot, 'render', { kind: 'messenger.added', locale: 'zh-CN', values })
  assert.equal(zhCn.locale, 'zh')
  assert.equal(zhCn.source, 'builtin')

  const zhHant = await value(bot, 'render', { kind: 'messenger.added', locale: 'zh-Hant-TW', values })
  assert.equal(zhHant.locale, 'zh')

  const unknown = await value(bot, 'render', { kind: 'messenger.added', locale: 'fr-FR', values })
  assert.equal(unknown.locale, 'en')
  assert.equal(unknown.source, 'builtin')

  const fallback = await value(bot, 'render', {
    kind: 'team.some_future_kind', locale: 'fr-FR', values: {}, fallback: { subject: 'Fallback subject', body: 'Fallback body' },
  })
  assert.equal(fallback.source, 'fallback')
  assert.equal(fallback.subject, 'Fallback subject')
  assert.equal(fallback.body, 'Fallback body')
  assert.equal(fallback.locale, 'fr-FR')

  await refused(bot, 'render', { kind: 'team.some_future_kind', locale: 'en', values: {} }, 'notifications/not-found')
  await refused(bot, 'render', { kind: 'messenger.added', locale: 'x', values }, 'notifications/invalid')
  await refused(bot, 'render', { kind: 'not a kind', locale: 'en', values }, 'notifications/invalid')
})

test('required values are enforced, extra values ignored and markup in values never becomes markup', async () => {
  const bot = await boot()
  const missing = await refused(bot, 'render', { kind: 'messenger.added', locale: 'en', values: {} }, 'notifications/invalid')
  assert.match(missing.message, /title/)
  await refused(bot, 'render', { kind: 'team.join_decided', locale: 'en', values: { team_name: 'T' } }, 'notifications/invalid')

  const html = await value(bot, 'render', {
    kind: 'messenger.added', locale: 'en', values: { title: '<b>Bold</b>', unused: 'ignored' },
  })
  assert.ok(!html.body.includes('<b>'), html.body)
  assert.match(html.body, /&lt;b&gt;Bold&lt;\/b&gt;/)
  assert.ok(!html.subject.includes('ignored') && !html.body.includes('ignored'))

  const numbers = await value(bot, 'render', { kind: 'team.join_decided', locale: 'en', values: { team_name: 7, decision: true } })
  assert.match(numbers.body, /7/)
  assert.match(numbers.body, /true/)
  assert.ok(!numbers.body.includes('undefined'))

  await refused(bot, 'render', { kind: 'messenger.added', locale: 'en', values: { title: { nested: 'x' } } }, 'notifications/invalid')
})

test('a registered version overrides the built-in text and an immutable version is refused', async () => {
  const bot = await boot()
  const registered = (await value(bot, 'register', {
    kind: 'messenger.mention', locale: 'en', version: 5,
    subject: 'Custom {name}', body: 'Hi {name}, you were mentioned.', variables: ['name'],
  })).template
  assert.equal(registered.version, 5)
  assert.deepEqual(registered.variables, ['name'])

  const rendered = await value(bot, 'render', { kind: 'messenger.mention', locale: 'en', values: { name: 'Alice' } })
  assert.equal(rendered.source, 'db')
  assert.equal(rendered.subject, 'Custom Alice')
  assert.equal(rendered.body, 'Hi Alice, you were mentioned.')

  const replay = await value(bot, 'register', {
    kind: 'messenger.mention', locale: 'en', version: 5,
    subject: 'Custom {name}', body: 'Hi {name}, you were mentioned.', variables: ['name'],
  })
  assert.equal(replay.template.id, registered.id)
  await refused(bot, 'register', {
    kind: 'messenger.mention', locale: 'en', version: 5, subject: 'Changed', body: 'Changed', variables: [],
  }, 'notifications/invalid')

  const zh = (await value(bot, 'register', {
    kind: 'messenger.mention', locale: 'zh-CN', version: 2, subject: '提醒', body: '有人提到了你。',
  })).template
  assert.deepEqual(zh.variables, [])
  const zhRendered = await value(bot, 'render', { kind: 'messenger.mention', locale: 'zh-CN', values: {} })
  assert.equal(zhRendered.locale, 'zh-CN')
  assert.equal(zhRendered.source, 'db')
  assert.equal(zhRendered.body, '有人提到了你。')

  assert.equal((await value(bot, 'disable', { kind: 'messenger.mention', locale: 'en', version: 5 })).disabled, true)
  assert.equal((await value(bot, 'disable', { kind: 'messenger.mention', locale: 'en', version: 5 })).disabled, false)
  const afterDisable = await value(bot, 'render', { kind: 'messenger.mention', locale: 'en', values: {} })
  assert.equal(afterDisable.source, 'builtin')
  assert.notEqual(afterDisable.subject, 'Custom {name}')
})

test('invalid templates are refused before any row is written and listing shows stored versions', async () => {
  const bot = await boot()
  await refused(bot, 'register', { kind: 'Bad Kind', locale: 'en', version: 1, subject: 'S', body: 'B' }, 'notifications/invalid')
  await refused(bot, 'register', { kind: 'team.removed', locale: 'x', version: 1, subject: 'S', body: 'B' }, 'notifications/invalid')
  await refused(bot, 'register', { kind: 'team.removed', locale: 'en', version: 0, subject: 'S', body: 'B' }, 'notifications/invalid')
  await refused(bot, 'register', { kind: 'team.removed', locale: 'en', version: 1, subject: 'S'.repeat(501), body: 'B' }, 'notifications/invalid')
  await refused(bot, 'register', { kind: 'team.removed', locale: 'en', version: 1, subject: 'Hi {name}', body: 'B', variables: [] }, 'notifications/invalid')
  await refused(bot, 'register', { kind: 'team.removed', locale: 'en', version: 1, subject: 'Hi {name}', body: 'B', variables: ['other'] }, 'notifications/invalid')
  await refused(bot, 'register', { kind: 'team.removed', locale: 'en', version: 1, subject: 'Hi', body: 'B', variables: 'name' }, 'notifications/invalid')
  await refused(bot, 'register', {
    kind: 'team.removed', locale: 'en', version: 1, subject: 'S',
    body: Array.from({length: 33}, (_, index) => '{value' + index + '}').join(' '),
  }, 'notifications/invalid')

  const store = featureStore(bot)
  try {
    assert.equal(store.get('SELECT COUNT(*) AS n FROM notification_templates').n, 0)
  } finally {
    store.close()
  }

  const inferred = (await value(bot, 'register', { kind: 'team.removed', locale: 'en', version: 1, subject: 'One {team_name}', body: 'One body' })).template
  assert.deepEqual(inferred.variables, ['team_name'])
  await value(bot, 'register', { kind: 'team.removed', locale: 'en', version: 2, subject: 'Two', body: 'Two body' })
  await value(bot, 'register', { kind: 'team.removed', locale: 'de', version: 1, subject: 'Drei', body: 'Drei body' })
  const all = (await value(bot, 'templates', {})).items
  assert.equal(all.length, 3)
  const english = (await value(bot, 'templates', { kind: 'team.removed', locale: 'en' })).items
  assert.deepEqual(english.map((item) => item.version), [2, 1])
  assert.equal(english[0].subject, 'Two')

  // Disabling without a version retires only the newest enabled one; the older
  // version stays live until it is disabled too, then the built-in text returns.
  assert.equal((await value(bot, 'disable', { kind: 'team.removed', locale: 'en' })).disabled, true)
  assert.equal((await value(bot, 'render', { kind: 'team.removed', locale: 'en', values: { team_name: 'T' } })).source, 'db')
  assert.equal((await value(bot, 'disable', { kind: 'team.removed', locale: 'en', version: 1 })).disabled, true)
  const disabled = (await value(bot, 'templates', { kind: 'team.removed', locale: 'en' })).items
  assert.deepEqual(disabled.map((item) => item.enabled), [false, false])
  assert.equal((await value(bot, 'render', { kind: 'team.removed', locale: 'en', values: {} })).source, 'builtin')
})

test('a second account is a second volume and sees no registered templates', async () => {
  const bot = await boot()
  const spoofedScope = { owner_id: 'other-owner', workspace_id: 'other-workspace' }
  const {template} = await value(bot, 'register', {
    ...spoofedScope, kind: 'follow.new', locale: 'en', version: 9, subject: 'Mine', body: 'Mine body',
  })
  assert.notEqual(template.owner_id, spoofedScope.owner_id)
  assert.deepEqual((await value(bot, 'templates', spoofedScope)).items, [template])

  const other = await boot(volume())
  const originalScope = { owner_id: template.owner_id, workspace_id: spoofedScope.workspace_id }
  assert.deepEqual((await value(other, 'templates', originalScope)).items, [])
  const rendered = await value(other, 'render', { ...originalScope, kind: 'follow.new', locale: 'en', values: {} })
  assert.equal(rendered.source, 'builtin')
  assert.notEqual(rendered.subject, 'Mine')
})
