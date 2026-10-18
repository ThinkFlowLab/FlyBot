import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { brandTitle, flybotMarkSvg, installBrandChrome, installTabTitle } from '../src/client/brand.js'
import { createSource } from '../src/client/sources.js'
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

test('#250: an ended face-to-face room says closed in the tab instead of listing its members', () => {
  const face = (status, extra = {}) => ({ name: 'Face-to-face · Ann, Bob · Oct 18 10:00', displayName: 'Face-to-face · Ann, Bob · Oct 18 10:00', origin: 'face-to-face', face: { status }, ...extra })
  const sessions = createSource({ byId: { room1: { id: 'room1', retainedBy: { mainView: 1 } } } })
  const roster = createSource({ byId: {}, roomsById: { room1: face('open') } })
  const doc = { title: 'FlyBot' }
  const off = installTabTitle(sessions, roster, doc)
  assert.equal(doc.title, 'Face-to-face · Ann, Bob · Oct 18 10:00 — FlyBot')
  // The peer leaves: the room is closed, and the tab follows without a session change.
  roster.set(current => ({ ...current, roomsById: { room1: face('closed') } }))
  assert.equal(doc.title, 'Face-to-face · closed — FlyBot')
  roster.set(current => ({ ...current, roomsById: { room1: face('left') } }))
  assert.equal(doc.title, 'Face-to-face · closed — FlyBot')
  // A name the user chose is kept; so is a room that is not face-to-face, and a generic title closes too.
  roster.set(current => ({ ...current, roomsById: { room1: face('closed', { name: 'Trip plan', displayName: 'Trip plan' }) } }))
  assert.equal(doc.title, 'Trip plan — FlyBot')
  roster.set(current => ({ ...current, roomsById: { room1: { name: 'Face-to-face · Ann · x', origin: 'group', face: { status: 'closed' } } } }))
  assert.equal(doc.title, 'Face-to-face · Ann · x — FlyBot')
  roster.set(current => ({ ...current, roomsById: { room1: face('closed', { name: 'Face-to-face room', displayName: 'Face-to-face room' }) } }))
  assert.equal(doc.title, 'Face-to-face · closed — FlyBot')
  off()
})

test('#173: the tab title follows a room the roster learns after it opened', () => {
  const sessions = createSource({ byId: { chief: { id: 'chief', retainedBy: { mainView: 1 } } } })
  const roster = createSource({ byId: { chief: { name: 'Chief' } }, roomsById: {} })
  const doc = { title: 'FlyBot' }
  const off = installTabTitle(sessions, roster, doc)
  assert.equal(doc.title, 'Chief — FlyBot')
  // The joiner opens the face room before the roster has it: the title waits, it does not blank.
  sessions.set({ byId: { chief: { id: 'chief' }, room1: { id: 'room1', retainedBy: { mainView: 1 } } } })
  assert.equal(doc.title, 'Chief — FlyBot')
  // The roster learns the room: the tab follows without another session change.
  roster.set(current => ({ ...current, roomsById: { room1: { name: 'Face-to-face · Ann, Bob · Oct 18 10:00' } } }))
  assert.equal(doc.title, 'Face-to-face · Ann, Bob · Oct 18 10:00 — FlyBot')
  // A later rename follows too.
  roster.set(current => ({ ...current, roomsById: { room1: { name: 'Face-to-face · Ann, Bob, Cy · Oct 18 10:00' } } }))
  assert.equal(doc.title, 'Face-to-face · Ann, Bob, Cy · Oct 18 10:00 — FlyBot')
  off()
  roster.set(current => ({ ...current, roomsById: { room1: { name: 'after off' } } }))
  assert.equal(doc.title, 'Face-to-face · Ann, Bob, Cy · Oct 18 10:00 — FlyBot', 'unsubscribed')
})
