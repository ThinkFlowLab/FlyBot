import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { brandTitle, flybotMarkSvg, installBrandChrome } from '../src/client/brand.js'
import { DICTIONARY } from '../src/client/i18n.js'

const src = name => readFileSync(new URL(`../src/client/${name}`, import.meta.url), 'utf8')

test('sidebar brand is FlyBot with the FlyBot mark, not the whale', () => {
  const sidebar = src('sidebar.js')
  assert.match(sidebar, /function BrandName\(\) \{\n  return h\('span', \{ style: \{ fontWeight: 600, fontSize: 14 \} \}, t\('FlyBot'\)\)\n\}/)
  assert.match(sidebar, /function BrandMark\(\{ size = 24 \}\) \{\n  return h\('span', \{ className: 'bt-brand-mark' \}, h\(FlyBotMark, \{ size \}\)\)\n\}/)
  assert.doesNotMatch(sidebar, /bt-brand-whale/)
  assert.match(src('about.js'), /t\('FlyBot'\)/)
  assert.match(src('about.js'), /t\('FlyBot core'\)/)
  assert.match(src('about.js'), /t\('Star FlyBot on GitHub'\)/)
  assert.match(src('settings.js'), /'About FlyBot'/)
  assert.match(src('settings.js'), /t\('FlyBot settings'\)/)
  assert.doesNotMatch(src('i18n.js'), /'DS Bot'/)
})

test('Chinese copy maps FlyBot chrome, not DS Bot', () => {
  const zh = DICTIONARY.zh
  assert.equal(zh.FlyBot, 'FlyBot')
  assert.equal(zh['FlyBot settings'], 'FlyBot 设置')
  assert.equal(zh['About FlyBot'], '关于 FlyBot')
  assert.equal(zh['Star FlyBot on GitHub'], '在 GitHub 上给 FlyBot 点 Star')
  assert.equal(zh['FlyBot core {version} is available'], 'FlyBot 核心 {version} 可以更新')
  assert.equal(zh['Updating FlyBot core…'], '正在更新 FlyBot 核心…')
  assert.equal(Object.hasOwn(zh, 'DS Bot'), false)
  assert.equal(Object.hasOwn(zh, 'DS Bot settings'), false)
  assert.equal(Object.hasOwn(zh, 'About DS Bot'), false)
  assert.equal(Object.hasOwn(zh, 'Star DS Bot on GitHub'), false)
})

test('FlyBot mark SVG matches the docs logo; tab title and favicon follow', () => {
  const svg = flybotMarkSvg()
  assert.match(svg, /viewBox="0 0 512 512"/)
  assert.match(svg, /#3B5BFD/)
  assert.match(readFileSync(new URL('../../docs/images/logo.svg', import.meta.url), 'utf8'), /#3B5BFD/)
  assert.equal(brandTitle('DS Bot'), 'FlyBot')
  assert.equal(brandTitle('DeepSeek Harness'), 'FlyBot')
  assert.equal(brandTitle('Writer — DeepSeek Harness'), 'Writer — FlyBot')
  assert.equal(brandTitle('Chief — FlyBot'), 'Chief — FlyBot')

  const created = []
  const document = {
    title: 'DS Bot',
    head: { appendChild(node) { created.push(node) } },
    getElementById: () => null,
    querySelector: () => null,
    createElement: () => ({ rel: '', type: '', href: '', id: '', remove() { this.removed = true } }),
  }
  globalThis.document = document
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() { this.stopped = true }
  }
  try {
    const off = installBrandChrome()
    assert.equal(created.length, 1)
    assert.equal(created[0].id, 'flybot-favicon')
    assert.equal(created[0].rel, 'icon')
    assert.match(created[0].href, /^data:image\/svg\+xml,/)
    assert.equal(document.title, 'FlyBot')
    off()
    assert.equal(created[0].removed, true)
  } finally {
    delete globalThis.document
    delete globalThis.MutationObserver
  }
})
