import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { listedChatBots, pickerBotLabel, isHomeLevelRemote, isListedRemoteChat } from '../src/shared/remote-label.js'
import { DICTIONARY } from '../src/client/i18n.js'

test('picker hides gone, hidden, and home-level remotes; labels include the owner', () => {
  const roster = {
    bots: [
      { id: 'chief', name: 'Chief' },
      { id: 'r1', name: 'Chief', remote: { handle: '@chief.hsliu.home', home: '@hsliu.home', homeName: 'hsliu', owner: 'hsliu' } },
      { id: 'r2', name: '助手', remote: { handle: '@assistant.friend.home', home: '@friend.home', homeName: 'Friend', owner: 'Friend' } },
      { id: 'r3', name: 'Chief', remote: { handle: '@chief.friend.home', home: '@friend.home', homeName: 'Friend', gone: true } },
      { id: 'r4', name: 'Friend', remote: { handle: '@friend.home', home: '@friend.home', homeName: 'Friend' } },
      { id: 'r5', name: 'Coder', hidden: true, remote: { handle: '@coder.bob.home', home: '@bob.home', homeName: 'Bob' } },
    ],
  }
  assert.equal(isHomeLevelRemote({ handle: '@friend.home', home: '@friend.home' }), true)
  assert.equal(isHomeLevelRemote({ handle: '@coder.bob.home', home: '@bob.home' }), false)
  assert.equal(isHomeLevelRemote({ handle: '@bob.bot', home: '@bob.bot' }), false)
  assert.equal(isListedRemoteChat(roster.bots[3]), false)
  assert.equal(isListedRemoteChat(roster.bots[4]), false)
  const listed = listedChatBots(roster)
  assert.deepEqual(listed.map(bot => bot.id), ['chief', 'r1', 'r2'])
  assert.equal(pickerBotLabel(listed[0]), 'Chief')
  assert.equal(pickerBotLabel(listed[1]), "hsliu's Chief")
  assert.equal(pickerBotLabel(listed[2]), "助手 · Friend's Bot")
})

test('the sidebar + menu wires plugin actions in after Create group chat', () => {
  const src = readFileSync(new URL('../src/client/new-chat.js', import.meta.url), 'utf8')
  const group = src.indexOf("t('Create group chat')")
  const actions = src.indexOf('for (const action of newChatActionRows')
  const agent = src.indexOf("t('Add DSH Agent')")
  assert.ok(group > 0 && actions > group && agent > actions, `order group=${group} actions=${actions} agent=${agent}`)
  assert.match(src, /listedChatBots/)
  assert.match(src, /pickerBotLabel/)
  assert.match(src, /t\(action\.label\)/)
  const slots = readFileSync(new URL('../src/client/flybot-slots.js', import.meta.url), 'utf8')
  assert.match(slots, /isListedRemoteChat/)
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  assert.match(sidebar, /isListedRemoteChat/)
  assert.equal(DICTIONARY.zh['Face-to-face group'], '面对面建群')
  assert.equal(DICTIONARY.zh['Create group chat'], '新建群聊')
  assert.match(DICTIONARY.zh['Meet the people next to you. Pick your Bots and type the same 6-digit number.'], /身边/)
})
