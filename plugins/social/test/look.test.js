import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lookFromServer, lookImage, lookToServer } from '../src/look.js'
import { safeLookImage } from '../../../core/src/shared/look-image.js'

// #2646: a friend's published look is pasted into the page-wide mention stylesheet as
// url("…"), so a value carrying a quote, a paren, a backslash, whitespace or a control
// character is dropped here too; the core sink is not the only guard.
const PAYLOAD = `data:image/png;base64,AA");}body{background:url(https://evil.example/beacon)}.z{'`

test('the object look form drops an image that could leave url("…") (#2646)', () => {
  assert.equal(lookFromServer({ avatar: { image: PAYLOAD } }).avatar, undefined)
  assert.equal(lookFromServer({ avatar: { image: `https://ok.example/a".png` } }).avatar, undefined)
  assert.equal(lookFromServer({ avatar: { image: `https://ok.example/a).png` } }).avatar, undefined)
  assert.equal(lookFromServer({ avatar: { image: 'data:image/svg+xml;base64,AAAA' } }).avatar, undefined)
  assert.equal(lookFromServer({ avatar: { image: 'javascript:alert(1)' } }).avatar, undefined)
  // A shape beside the refused image survives.
  assert.deepEqual(lookFromServer({ avatar: { shape: 'moon', image: PAYLOAD } }).avatar, { shape: 'moon' })
})

test('the object look form keeps a plain https or base64 image (#2646)', () => {
  assert.deepEqual(lookFromServer({ avatar: { image: 'https://ok.example/a.png' } }).avatar, { image: 'https://ok.example/a.png' })
  assert.deepEqual(lookFromServer({ avatar: { image: 'data:image/png;base64,AAAA' } }).avatar, { image: 'data:image/png;base64,AAAA' })
})

test('the string look form still drops the same payload (#2646)', () => {
  assert.equal(lookFromServer({ avatar: PAYLOAD, avatar_kind: 'image' }).avatar, undefined)
  assert.equal(lookFromServer({ avatar: PAYLOAD }).avatar, undefined)
})

// #2649: the host stores a gif (roster.js accepts png|jpeg|webp|gif), so the publisher must
// carry it as the image instead of falling through to the shape branch and dropping it.
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

test('a stored gif look is published as its image, never as a shape (#2649)', () => {
  // lookToServer is the publish path syncBotLook runs; the shape beside the image is only the fallback.
  assert.deepEqual(lookToServer({ color: 'blue', avatar: { image: GIF, shape: 'moon' } }), { color: '#2a92fe', avatar: GIF })
  assert.deepEqual(lookToServer({ avatar: { image: GIF } }), { avatar: GIF })
  // The other direction reads the same format back from a friend's server.
  assert.deepEqual(lookFromServer({ avatar: GIF, avatar_kind: 'image' }).avatar, { image: GIF })
  assert.deepEqual(lookFromServer({ avatar: { image: GIF } }).avatar, { image: GIF })
})

test('the plugin predicate and core/src/shared/look-image.js agree (#2646)', () => {
  // Both copies accept the same set, gif included: a gif stored by roster.js is a look here too (#2649).
  const cases = [
    'https://ok.example/a.png',
    'http://ok.example/a.png',
    'https://ok.example/a;b.png',
    'data:image/png;base64,AAAA',
    'data:image/jpeg;base64,AA==',
    'data:image/webp;base64,AAAA',
    'data:image/gif;base64,AAAA',
    GIF,
    PAYLOAD,
    `https://ok.example/a".png`,
    `https://ok.example/a'.png`,
    `https://ok.example/a(.png`,
    `https://ok.example/a).png`,
    `https://ok.example/a\\.png`,
    'https://ok.example/a b.png',
    'https://ok.example/a<b.png',
    'data:image/svg+xml;base64,AAAA',
    'javascript:alert(1)',
    'not a url',
    '',
  ]
  for (const value of cases) {
    assert.equal(lookImage(value), safeLookImage(value, 64 * 1024), value)
  }
})
