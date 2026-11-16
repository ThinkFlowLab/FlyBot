// Appearance modes, sunset/custom windows, and the Shift+Enter send-key flip.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  afterSunset, appearanceOf, applyAppearanceAttribute, handleComposerSendKey,
  inNightWindow, isDarkAppearance, latitudeForZone, normalizeSendKey, parseClock,
  sendKeyOf, shouldBreakOnKey, shouldSendOnKey, sunMinutes,
} from '../src/client/appearance.js'
import { readAppearance, readSendKey } from '../src/shared/appearance-prefs.js'

test('fresh prefs match the system; a saved mode is kept', () => {
  assert.deepEqual(appearanceOf(undefined), { mode: 'system', auto: 'sun', from: '19:00', to: '07:00' })
  assert.equal(appearanceOf({ appearance: { mode: 'dark' } }).mode, 'dark')
  assert.equal(appearanceOf({ appearance: { mode: 'auto', auto: 'custom', from: '18:30', to: '06:45' } }).from, '18:30')
  assert.equal(sendKeyOf({}), 'enter')
  assert.equal(sendKeyOf({ sendKey: 'shift-enter' }), 'shift-enter')
  assert.equal(normalizeSendKey('tab'), 'enter')
})

test('light and dark modes ignore the clock and the system', () => {
  const noon = new Date('2026-06-21T12:00:00+08:00')
  const midnight = new Date('2026-06-21T00:30:00+08:00')
  assert.equal(isDarkAppearance({ appearance: { mode: 'light' } }, midnight, true), false)
  assert.equal(isDarkAppearance({ appearance: { mode: 'dark' } }, noon, false), true)
  assert.equal(isDarkAppearance({ appearance: { mode: 'system' } }, noon, true), true)
  assert.equal(isDarkAppearance({ appearance: { mode: 'system' } }, noon, false), false)
})

test('automatic sunset-to-sunrise is dark after sunset in Asia/Shanghai', () => {
  const zone = 'Asia/Shanghai'
  const midsummer = new Date('2026-06-21T12:00:00+08:00')
  const sun = sunMinutes(midsummer, { timeZone: zone, latitude: latitudeForZone(zone) })
  assert.ok(sun.sunrise < 6 * 60, `midsummer sunrise should be before 06:00, got ${sun.sunrise}`)
  assert.ok(sun.sunset > 18 * 60, `midsummer sunset should be after 18:00, got ${sun.sunset}`)
  const midwinter = new Date('2026-12-21T12:00:00+08:00')
  const winter = sunMinutes(midwinter, { timeZone: zone, latitude: latitudeForZone(zone) })
  assert.ok(winter.sunrise > sun.sunrise, 'winter sunrise is later than summer')
  assert.ok(winter.sunset < sun.sunset, 'winter sunset is earlier than summer')
  const afterDark = new Date('2026-12-21T22:00:00+08:00')
  const morning = new Date('2026-12-21T08:00:00+08:00')
  assert.equal(afterSunset(afterDark, { timeZone: zone, latitude: 31.23 }), true)
  assert.equal(afterSunset(morning, { timeZone: zone, latitude: 31.23 }), false)
  assert.equal(isDarkAppearance({ appearance: { mode: 'auto', auto: 'sun' } }, afterDark, false, { timeZone: zone, latitude: 31.23 }), true)
  assert.equal(isDarkAppearance({ appearance: { mode: 'auto', auto: 'sun' } }, morning, true, { timeZone: zone, latitude: 31.23 }), false)
})

test('a custom night window wraps midnight', () => {
  const evening = new Date('2026-11-16T20:15:00+08:00')
  const afternoon = new Date('2026-11-16T15:00:00+08:00')
  const dawn = new Date('2026-11-16T06:00:00+08:00')
  assert.equal(inNightWindow(evening, '19:00', '07:00', 'Asia/Shanghai'), true)
  assert.equal(inNightWindow(dawn, '19:00', '07:00', 'Asia/Shanghai'), true)
  assert.equal(inNightWindow(afternoon, '19:00', '07:00', 'Asia/Shanghai'), false)
  assert.equal(isDarkAppearance({ appearance: { mode: 'auto', auto: 'custom', from: '19:00', to: '07:00' } }, afternoon, true, { timeZone: 'Asia/Shanghai' }), false)
  assert.equal(parseClock('7:00'), null)
  assert.equal(parseClock('19:00'), 19 * 60)
})

test('the host refuses a broken appearance or send-key record', () => {
  assert.equal(readAppearance(null), undefined)
  assert.equal(readAppearance({ mode: 'neon' }), false)
  assert.equal(readAppearance({ mode: 'auto', auto: 'custom', from: '19:00', to: '19:00' }), false)
  assert.deepEqual(readAppearance({ mode: 'dark' }), { mode: 'dark', auto: 'sun', from: '19:00', to: '07:00' })
  assert.equal(readSendKey('enter'), undefined)
  assert.equal(readSendKey('shift-enter'), 'shift-enter')
  assert.equal(readSendKey('tab'), false)
})

test('Shift+Enter to send intercepts only when that pref is on', () => {
  const enter = { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false }
  const shift = { ...enter, shiftKey: true }
  assert.equal(shouldSendOnKey(enter, 'enter'), true)
  assert.equal(shouldBreakOnKey(shift, 'enter'), true)
  assert.equal(shouldSendOnKey(shift, 'shift-enter'), true)
  assert.equal(shouldBreakOnKey(enter, 'shift-enter'), true)
  let sent = 0
  let broke = 0
  const event = { ...enter, preventDefault() {}, stopPropagation() {} }
  assert.equal(handleComposerSendKey(event, 'enter', { send: () => sent++, insertNewline: () => broke++ }), false)
  assert.equal(sent + broke, 0)
  assert.equal(handleComposerSendKey(event, 'shift-enter', { send: () => sent++, insertNewline: () => broke++ }), 'break')
  assert.equal(broke, 1)
  const shiftEvent = { ...shift, preventDefault() {}, stopPropagation() {} }
  assert.equal(handleComposerSendKey(shiftEvent, 'shift-enter', { send: () => sent++, insertNewline: () => broke++ }), 'send')
  assert.equal(sent, 1)
})

test('applyAppearanceAttribute toggles data-ds-dark-theme on a body', () => {
  const attrs = new Map()
  const body = {
    setAttribute(name, value) { attrs.set(name, value) },
    removeAttribute(name) { attrs.delete(name) },
    hasAttribute(name) { return attrs.has(name) },
  }
  const doc = { documentElement: {}, body }
  assert.equal(applyAppearanceAttribute(true, doc), 'dark')
  assert.equal(attrs.has('data-ds-dark-theme'), true)
  assert.equal(applyAppearanceAttribute(false, doc), 'light')
  assert.equal(attrs.has('data-ds-dark-theme'), false)
})


test('legacy IME keycode 229 never sends or inserts a newline', () => {
  for (const shiftKey of [false, true]) {
    let invoked = 0
    const result = handleComposerSendKey({ key: 'Enter', keyCode: 229, shiftKey,
      preventDefault() { invoked++ }, stopPropagation() { invoked++ } }, 'shift-enter', {
      send() { invoked++ }, insertNewline() { invoked++ },
    })
    assert.equal(result, false)
    assert.equal(invoked, 0)
  }
})
