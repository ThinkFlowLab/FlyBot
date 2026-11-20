import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DICTIONARY, hostText, installLocale, language, t } from '../src/client/i18n.js'

function fakeLocale(active) {
  const dicts = new Map()
  return {
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key, params) => {
      const text = (active === 'zh' ? dicts.get(`${ns}:zh`)?.[key] : undefined) ?? key
      return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
    },
    getLocale: () => ({ active }),
  }
}

test('every literal the client translates has a Chinese entry', () => {
  const dir = new URL('../src/client/', import.meta.url)
  const missing = []
  for (const name of readdirSync(dir).filter(file => file.endsWith('.js'))) {
    const text = readFileSync(new URL(name, dir), 'utf8')
    for (const match of text.matchAll(/\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
      const key = match[2].replace(/\\'/g, "'")
      if (!Object.hasOwn(DICTIONARY.zh, key)) missing.push(`${name}: ${key}`)
    }
  }
  assert.deepEqual(missing, [])
})

test('copy follows the DSH language and stays English without a locale service', () => {
  assert.equal(t('Message {name}', { name: 'Chief' }), 'Message Chief')
  assert.equal(language(), 'en')
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(language(), 'zh')
    assert.equal(t('Message {name}', { name: 'Chief' }), '给 Chief 发消息')
    assert.equal(t('Model'), '模型')
    assert.equal(hostText('A Bot named Writer already exists'), '已经有叫 Writer 的 Bot 了')
    assert.equal(hostText('The team needs at least one Main Bot'), '团队至少要有一个主 Bot')
    assert.equal(hostText('Something new'), 'Something new')
    // Whole memory messages, not only their first words, become Chinese.
    assert.equal(hostText('An entry holds at most 300 characters; this one has 301. Keep one fact per entry, or save the details as several entries in a topic.'), '一条记忆最多 300 个字符，这条有 301 个')
    assert.equal(hostText("Writer's memory's MEMORY.md would have 4100 of its 4000 characters. Make room first: move details into a topic."), '主记忆会超过 4000 个字符的上限，请先删掉一些')
    assert.equal(hostText('There is no entry 9.'), '没有第 9 条')
  } finally {
    off()
  }
  assert.equal(t('Model'), 'Model')
  assert.equal(hostText('A Bot named Writer already exists'), 'A Bot named Writer already exists')
})

// #1813: the Project board's queue rows print the host's lowercase lease state through `t()`
// (project-board.js), so those ids have to be dictionary keys themselves. #1768's cases never
// bound a dictionary, which is why a missing entry read as raw English in CI.
test('#1813: the Project board queue states read in Chinese', () => {
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(t('running'), '运行中')
    assert.equal(t('stalled'), '已停滞')
  } finally {
    off()
  }
  // The board keeps emitting the lowercase ids; only the Chinese dictionary changes.
  assert.equal(t('running'), 'running')
})

// #3114 cut 33: the Capabilities page's three refusals that carry a name. `(.+)` is the name and
// String.replace copies it through, so a dot or a bracket in a team file's name is data, not syntax.
test('#3114 cut 33: the capability refusals that carry a name read in Chinese, and the name stays as it is', () => {
  const off = installLocale(fakeLocale('zh'))
  try {
    assert.equal(hostText('Packs can include only saved MCP servers and skills. web-search is not one.'),
      '能力包里只能放已保存的 MCP 服务和技能；web-search 不是其中之一。')
    assert.equal(hostText('No capability named web-search.'), '找不到叫 web-search 的能力。')
    assert.equal(hostText('No unapproved stdio MCP named web-search.'), '找不到叫 web-search 的待批准 stdio MCP 服务。')
    // A name is whatever the team file holds, so a dot or a bracket is copied and never parsed.
    assert.equal(hostText('No capability named a.b.'), '找不到叫 a.b 的能力。')
    assert.equal(hostText('No capability named a(b).'), '找不到叫 a(b) 的能力。')
    // The one shape that cannot be told from a name holding ". ": the name is still copied verbatim.
    assert.equal(hostText('No capability named web-search. Try again.'), '找不到叫 web-search. Try again 的能力。')
    // Sentences this cut leaves in English: no closing full stop, text before the sentence, a line
    // break in the name, a pack line without its stop, a stdio line without its stop, and the
    // endpoint fallback no caller reaches.
    for (const message of [
      'No capability named web-search',
      'The host said: No capability named web-search.',
      'No capability named web-\nsearch.',
      'Packs can include only saved MCP servers and skills. web-search is not one',
      'No unapproved stdio MCP named web-search',
      'Unknown capability operation.',
    ]) assert.equal(hostText(message), message)
  } finally {
    off()
  }
})

// A window that is not zh gets the host's sentence, not a translation of it (these three have no key).
test('#3114 cut 33: an English window keeps the capability refusals as the host wrote them', () => {
  for (const message of [
    'Packs can include only saved MCP servers and skills. web-search is not one.',
    'No capability named web-search.',
    'No unapproved stdio MCP named web-search.',
  ]) assert.equal(hostText(message), message)
})
