import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #406: Sharing is a titled card right after Instructions, the group's last card is "More" like
// a Bot's, and the composer's focus border is clearly stronger than its hover border.
const read = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

test('Bot settings draws Sharing as a titled card right after Instructions (#406)', () => {
  const source = read('bot-settings.js')
  const form = source.slice(source.indexOf('export function BotSettingsForm'), source.indexOf('export const BOT_SETTINGS_CSS'))
  const at = needle => { const index = form.indexOf(needle); assert.ok(index > 0, `missing ${needle}`); return index }
  const sharing = at("h(FlyBotDetails, { bot, roster, actions, wrap: children => h(Card, { title: t('Sharing') }, children) })")
  assert.equal(form.split('h(FlyBotDetails').length, 2, 'the plugin details are drawn once')
  assert.ok(at("h(Card, { title: t('Instructions') }") < sharing)
  assert.ok(sharing < at('h(BotCapabilitiesCard'))
  assert.ok(sharing < at("h(Card, { title: t('More') }"))
  assert.match(read('flybot-slots.js'), /return wrap \? wrap\(list\) : h\(Fragment, null, list\)/)
  assert.match(read('i18n.js'), /\n {2}Sharing: '分享',\n/)
})

test('group settings and Bot settings both end with a "More" card (#406)', () => {
  const group = read('group-settings.js')
  assert.doesNotMatch(group, /title: t\('Manage'\)/)
  assert.match(group, /h\(Card, \{ title: t\('More'\) \},\n\s+h\('button', \{ type: 'button', className: 'bt-set-row bt-bs-row bt-bs-danger'/)
})

test('the composer focus border is stronger than its hover border (#406)', () => {
  const css = read('styles.js')
  const mix = selector => Number(css.match(new RegExp(`\\n${selector.replace(/[[\]:]/g, '\\$&')}\\{border-color:color-mix\\(in srgb,var\\(--bt-ink\\) (\\d+)%,transparent\\)!important\\}`))?.[1])
  assert.equal(mix('[data-composer-card]:hover'), 30)
  assert.ok(mix('[data-composer-card]:focus-within') >= 50)
})
