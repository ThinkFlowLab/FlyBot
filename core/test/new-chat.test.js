import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { copiedToClipboard, listedChatBots, pickerBotLabel, isHomeLevelRemote, isListedRemoteChat, splitRoomPicks, ungrantedLocalFix } from '../src/shared/remote-label.js'
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
  assert.equal(pickerBotLabel(listed[1]), 'Chief (hsliu)')
  assert.equal(pickerBotLabel(listed[2]), '助手 (Friend)')
})

test('new-chat splits a friend\'s Bot out of local members into remote participants', () => {
  const roster = {
    byId: {
      chief: { id: 'chief', name: 'Chief' },
      r2: { id: 'r2', name: '助手', remote: { handle: '@assistant.friend.home' } },
    },
  }
  const { members, remotes } = splitRoomPicks(roster, ['chief', 'r2'])
  assert.deepEqual(members, ['chief'])
  assert.deepEqual(remotes, [{ kind: 'bot', remote: true, handle: '@assistant.friend.home' }])
})

test('the sidebar + menu wires plugin actions in after New group chat', () => {
  const src = readFileSync(new URL('../src/client/new-chat.js', import.meta.url), 'utf8')
  const menu = src.indexOf('menuOnly')
  const group = src.indexOf("t('New group chat')")
  const actions = src.indexOf('for (const action of newChatActionRows')
  const agent = src.indexOf("t('Add coding agent')")
  assert.ok(menu > 0, 'sidebar + starts as a short action menu')
  assert.ok(group > 0 && actions > group && agent > actions, `order group=${group} actions=${actions} agent=${agent}`)
  assert.match(src, /listedChatBots/)
  assert.match(src, /pickerBotLabel/)
  assert.match(src, /splitRoomPicks/)
  assert.match(src, /choosingAdmin \? bots.filter\(bot => !bot.remote\)/)
  assert.match(src, /t\(action\.label\)/)
  assert.match(src, /data-menu/)
  const slots = readFileSync(new URL('../src/client/flybot-slots.js', import.meta.url), 'utf8')
  assert.match(slots, /isListedRemoteChat/)
  const sidebar = readFileSync(new URL('../src/client/sidebar.js', import.meta.url), 'utf8')
  assert.match(sidebar, /isListedRemoteChat\(bot\)/)
  assert.match(sidebar, /!isPastFaceRoom\(room\)/)
  assert.match(sidebar, /Number\(foreign\(a\)\) - Number\(foreign\(b\)\)/)
  // With @flybot/tree on, a friend's Bot is not a tree node under Main; it stays in the flat list.
  assert.match(sidebar, /const inTree = entry => entry\.kind === 'bot' && !entry\.item\.remote/)
  assert.match(sidebar, /structure\?\.include\?\.\(entry\.item\.id\) !== false/)
  assert.match(sidebar, /botTree\(\[main, \.\.\.order\.filter\(listed\)/)
  assert.match(sidebar, /order\.filter\(entry => !\(tree && inTree\(entry\)\) && !\(inTree\(entry\) && structure\?\.include/)
  assert.equal(DICTIONARY.zh['Copy my handle'], '复制我的 handle')
  assert.equal(DICTIONARY.zh['Face-to-face'], '面对面')
  assert.equal(DICTIONARY.zh['Face-to-face room'], '面对面房间')
  assert.equal(DICTIONARY.zh['New group chat'], '新建群聊')
  assert.match(DICTIONARY.zh['Meet people nearby with a 6-digit number'], /身边/)
  assert.equal(DICTIONARY.zh['Add friend'], '添加好友')
  assert.equal(DICTIONARY.zh['Friend requests'], '好友请求')
  assert.equal(DICTIONARY.zh['Accept invite'], '接受邀请')
  assert.equal(DICTIONARY.zh['Copy invite link'], '复制邀请链接')
  assert.equal(DICTIONARY.zh['Add coding agent'], '添加编码 Agent')
  assert.match(DICTIONARY.zh['Paste an invite link or code'], /邀请/)
  assert.match(src, /if \(!menuOnly\)/)
  assert.match(src, /actions\.notify/)
})

test('the sidebar + menu is a compact popover next to +, closed by a press outside (#173)', () => {
  const src = readFileSync(new URL('../src/client/new-chat.js', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../src/client/styles.js', import.meta.url), 'utf8')
  // The pane itself carries data-menu while only the menu shows, and a press on the
  // pane outside the menu closes it.
  assert.match(src, /className: 'bt-pane', style: \{ left: paneLeft \}, 'data-menu': menuOnly \|\| undefined/)
  assert.match(src, /onMouseDown: menuOnly \? \(event\) => \{ if \(event\.target === event\.currentTarget\) close\(\) \} : undefined/)
  // No title row with its own × in the popover.
  assert.match(src, /menuOnly \? null : h\('div', \{ className: 'bt-to' \}/)
  assert.doesNotMatch(src, /t\('New…'\)\),\s*h\('button'/)
  // See-through pane, a small card anchored at the top left, next to the sidebar +.
  assert.match(styles, /\.bt-pane\[data-menu\]\{background:transparent\}/)
  assert.match(styles, /\.bt-pane\[data-menu\] \.bt-newchat\{flex:none;align-self:flex-start;width:min\(280px,/)
})

test('ungrantedLocalFix reads the host refusal defensively', () => {
  assert.equal(ungrantedLocalFix(undefined), undefined)
  assert.equal(ungrantedLocalFix({}), undefined)
  assert.equal(ungrantedLocalFix({ reason: 'other', bots: [{ id: 'a' }] }), undefined)
  assert.equal(ungrantedLocalFix({ reason: 'ungranted-local', bots: [{ name: 'no id' }, null] }), undefined)
  assert.deepEqual(ungrantedLocalFix({
    reason: 'ungranted-local',
    bots: [{ id: 'dev', name: '程序员' }, { id: 'x', name: '<b>Evil`</b>' }],
    remotes: [{ handle: '@yi.home', name: "Yi's Bot", owner: 'Yi' }, { owner: 'Yi' }],
  }), { bots: [{ id: 'dev', name: '程序员' }, { id: 'x', name: 'bEvil/b' }], friends: ['Yi'] })
})

test('new-chat turns a refused group into a card with the invite and leave-out actions, never a dead end', () => {
  const src = readFileSync(new URL('../src/client/new-chat.js', import.meta.url), 'utf8')
  assert.match(src, /ungrantedLocalFix\(failure\?\.details\)/)
  assert.match(src, /'data-fix-action': 'invite'/)
  assert.match(src, /'data-fix-action': 'leave-out'/)
  // The invite is the Bot's own invite: nothing is granted by this click (the friend accepts it).
  assert.match(src, /social\.createInvite\(bot\.id\)/)
  assert.doesNotMatch(src, /setGrants|grants\.set/)
  const api = readFileSync(new URL('../src/client/api.js', import.meta.url), 'utf8')
  assert.match(api, /details: result\.error\?\.details/)
  for (const key of ['Copy invite link for {name}', 'Leave {name} out', 'that friend']) {
    assert.ok(DICTIONARY.zh[key], `ZH entry for ${key}`)
  }
})

test('copiedToClipboard is true only when the clipboard really took the text', async () => {
  const written = []
  const working = { clipboard: { writeText: async function (text) { assert.equal(this, working.clipboard); written.push(text) } } }
  assert.equal(await copiedToClipboard('https://invite.test/x', working), true)
  assert.deepEqual(written, ['https://invite.test/x'])
  // No clipboard at all (insecure context, locked-down WebView): the old `clipboard?.writeText` call was a quiet success.
  assert.equal(await copiedToClipboard('link', {}), false)
  assert.equal(await copiedToClipboard('link', { clipboard: {} }), false)
  assert.equal(await copiedToClipboard('link', { clipboard: { writeText: 'no' } }), false)
  assert.equal(await copiedToClipboard('link', undefined), false)
  assert.equal(await copiedToClipboard('link', null), false)
  // A refused write (permission, focus) is a failure too, and does not throw.
  assert.equal(await copiedToClipboard('link', { clipboard: { writeText: async () => { throw new Error('NotAllowedError') } } }), false)
  assert.equal(await copiedToClipboard('link', { clipboard: { writeText: () => { throw new Error('sync') } } }), false)
})

test('Copy invite link says copied only after a real copy, else shows the link to copy by hand', () => {
  const src = readFileSync(new URL('../src/client/new-chat.js', import.meta.url), 'utf8')
  const copyInvite = src.slice(src.indexOf('const copyInvite'), src.indexOf('const pick = '))
  assert.match(copyInvite, /await copiedToClipboard\(link\)/)
  // The success note sits only in the branch the real copy took; the other branch keeps the link.
  const [taken, notTaken] = copyInvite.split('} else {')
  assert.match(taken, /if \(await copiedToClipboard\(link\)\)/)
  assert.match(taken, /copied\. Send it to your friend/)
  assert.doesNotMatch(notTaken, /copied\. Send it to your friend/)
  assert.match(notTaken, /setInviteLink\(link\)/)
  assert.match(notTaken, /Could not copy the invite link/)
  assert.doesNotMatch(copyInvite, /navigator\.clipboard/)
  // The fallback is a read-only, selectable field in the card; leaving a Bot out or trying again clears it.
  assert.match(src, /readOnly: true, value: inviteLink/)
  assert.match(src, /onFocus: event => event\.target\.select\(\)/)
  assert.equal((src.match(/setInviteLink\(''\)/g) ?? []).length >= 4, true)
  for (const key of ['Invite link', 'Could not copy the invite link for {name}. Copy the link below and send it to your friend; once they accept, create the group again.']) {
    assert.ok(DICTIONARY.zh[key], `ZH entry for ${key}`)
  }
})

test('#385: the + menu rows have their own marks, one verb style and short hints; a Bot menu has one way to edit it', () => {
  const src = readFileSync(new URL('../src/client/new-chat.js', import.meta.url), 'utf8')
  const rows = [
    ["key: 'chat'", 'ChatIcon', 'New chat', 'Message one of your Bots'],
    ["key: 'new'", 'BotIcon', 'New Bot', 'Set up a Bot with its own role'],
    ["key: 'group'", 'PeopleIcon', 'New group chat', 'Chat with several of your Bots'],
    ["key: 'agent'", 'TerminalIcon', 'Add coding agent', 'A coding session without a Bot'],
  ]
  for (const [key, icon, label, hint] of rows) {
    const line = src.split('\n').find(text => text.includes(key))
    assert.ok(line, key)
    assert.match(line, new RegExp(`icon: h\\(${icon}`), `${label} mark`)
    assert.ok(line.includes(`t('${label}')`), label)
    assert.ok(line.includes(`t('${hint}')`), hint)
    assert.ok(DICTIONARY.zh[label] && DICTIONARY.zh[hint], `${label} zh`)
  }
  assert.doesNotMatch(src, /Create new Bot|DSH session/)
  // A plugin's mark renders behind its own boundary and falls back to the people mark (Codex P2).
  assert.match(src, /icon: action\.icon \? h\(SlotIcon, \{ id: action\.key, icon: action\.icon, fallback: h\(PeopleIcon\) \}\) : h\(PeopleIcon\)/)
  const slotsSrc = readFileSync(new URL('../src/client/flybot-slots.js', import.meta.url), 'utf8')
  assert.match(slotsSrc, /this\.state\.failed \? \(this\.props\.fallback \?\? null\)/)
  const menu = readFileSync(new URL('../src/client/context-menu.js', import.meta.url), 'utf8')
  assert.doesNotMatch(menu, /t\('Rename Bot'\)/)
  assert.match(menu, /t\('Edit Bot'\)/)
})
