// Theme choice in a real FlyBot: Grove is the unsaved default, existing themes stay selectable,
// and the same record installTheme writes to localStorage can be read back.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DICTIONARY, installLocale, t } from '../src/client/i18n.js'
import {
  DEFAULT_THEME, allThemes, resolveThemeId, themeCss, themePrefsRecord,
} from '../src/client/themes.js'

test('a profile with no saved theme presents Grove, and a saved id is kept', () => {
  assert.equal(DEFAULT_THEME, 'grove')
  assert.equal(resolveThemeId(undefined), 'grove')
  assert.equal(resolveThemeId({}), 'grove')
  assert.equal(resolveThemeId({ theme: 'unknown-theme' }), 'grove')
  assert.equal(resolveThemeId({ theme: 'deepseek' }), 'deepseek')
  assert.equal(resolveThemeId({ theme: 'mono' }), 'mono')
  assert.equal(resolveThemeId({ theme: 'paper' }), 'paper')
  assert.equal(resolveThemeId({ theme: 'moonlight' }), 'moonlight')
  assert.equal(resolveThemeId({ theme: 'grove' }), 'grove')
})

test('every shipped theme stays in the picker, including Grove and DeepSeek', () => {
  const themes = allThemes()
  assert.deepEqual(Object.keys(themes).sort(), ['deepseek', 'grove', 'mono', 'moonlight', 'paper'].sort())
  assert.equal(themes.grove.label, 'Grove')
  assert.equal(themes.deepseek.label, 'DeepSeek')
})

test('Grove tokens are the forest shell; DeepSeek tokens stay the original greys', () => {
  const grove = themeCss(allThemes().grove)
  assert.match(grove, /html body\{[^}]*--bt-main:#f4f7f5/)
  assert.match(grove, /html body\[data-ds-dark-theme\]\{[^}]*--bt-main:#171c19/)
  assert.match(grove, /--bt-card:#272e2b/)
  assert.match(grove, /--bt-accent:#3d9a6e/)
  assert.match(grove, /--bt-selected:#235039/)
  const deepseek = themeCss(allThemes().deepseek)
  assert.match(deepseek, /html body\[data-ds-dark-theme\]\{[^}]*--bt-main:#141414/)
  assert.match(deepseek, /--bt-accent:#5b7bff/)
  assert.doesNotMatch(grove, /Teamily|teamily/)
})

test('the localStorage record installTheme writes can be resolved on the next load', () => {
  const store = new Map()
  const storage = {
    setItem(key, value) { store.set(key, value) },
    getItem(key) { return store.get(key) ?? null },
  }
  const key = 'ds-bot:prefs'
  storage.setItem(key, JSON.stringify(themePrefsRecord({ theme: 'grove', accent: '#1f7a54', motion: 'normal' })))
  const saved = JSON.parse(storage.getItem(key))
  assert.equal(saved.theme, 'grove')
  assert.equal(resolveThemeId(saved), 'grove')

  storage.setItem(key, JSON.stringify(themePrefsRecord({ theme: 'deepseek', motion: 'quiet' })))
  const kept = JSON.parse(storage.getItem(key))
  assert.equal(kept.theme, 'deepseek')
  assert.equal(resolveThemeId(kept), 'deepseek')

  storage.setItem(key, JSON.stringify(themePrefsRecord({})))
  const blank = JSON.parse(storage.getItem(key))
  assert.equal(blank.theme, undefined)
  assert.equal(resolveThemeId(blank), 'grove')
})

test('Grove has a Chinese label, like the other theme names', () => {
  assert.equal(DICTIONARY.zh.Grove, '林间')
  const dicts = new Map()
  const off = installLocale({
    register: (ns, locale, dict) => { dicts.set(`${ns}:${locale}`, dict); return () => dicts.delete(`${ns}:${locale}`) },
    bind: ns => (key) => dicts.get(`${ns}:zh`)?.[key] ?? key,
    getLocale: () => ({ active: 'zh' }),
  })
  try {
    for (const theme of Object.values(allThemes())) {
      assert.equal(typeof t(theme.label), 'string')
      assert.notEqual(t(theme.label), '')
    }
    assert.equal(t('Grove'), '林间')
    assert.equal(t('DeepSeek'), 'DeepSeek')
  } finally {
    off()
  }
})
