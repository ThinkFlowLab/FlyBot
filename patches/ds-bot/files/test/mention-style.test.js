import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mentionCss } from '../src/client/mention-style.js'
import { applyPublishedLook } from '../src/host/remote-chat.js'
import { cssImageUrl, safeLookImage } from '../src/shared/look-image.js'

// The payload from #2646: a friend's Bot publishes a look whose image closes url("…"),
// closes the rule, and adds a page-wide `body{…}` rule to the mention stylesheet.
const PAYLOAD = `data:image/png;base64,AA");}body{background:url(https://evil.example/beacon)}.z{'`
const evil = {
  id: 'remote:evil.home',
  name: 'Evil',
  remote: { handle: 'evil.home' },
  avatar: { image: PAYLOAD },
}

const urlQuotes = css => (css.match(/url\("/g) ?? []).length
const urlCloses = css => (css.match(/"\)/g) ?? []).length

test('a payload image cannot leave url("…") in the page-wide mention stylesheet (#2646)', () => {
  const css = mentionCss([evil])
  assert.equal(css.includes('body{'), false)
  assert.equal(css.includes('evil.example'), false)
  assert.equal(urlQuotes(css), urlCloses(css))
  // The sink drops the photo and draws the colour/mask look instead.
  assert.match(css, /-webkit-mask-image:/)
  assert.equal(css.includes(PAYLOAD), false)
})

test('a valid image still draws the photo in the mention stylesheet (#2646)', () => {
  // A display name with a space owns no @Name chip, so the DEFAULT_MASK url() stays out of the line.
  const friend = { id: 'remote:ok', name: 'Ok Friend', remote: { handle: 'ok.home' }, avatar: { image: 'https://ok.example/a.png' } }
  const css = mentionCss([friend])
  assert.match(css, /background:center\/cover url\("https:\/\/ok\.example\/a\.png"\)/)
  assert.equal(urlQuotes(css), 1)
  assert.equal(urlCloses(css), 1)
  // A local Bot's gif avatar is a stored form and keeps drawing (roster.js accepts it).
  const local = { id: 'local', name: 'Local Bot', avatar: { image: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } }
  assert.match(mentionCss([local]), /url\("data:image\/gif;base64,R0lGODlhAQABAAAAACw="\)/)
})

test('a published look drops an unsafe image and keeps a plain one (#2646)', () => {
  const dropped = {}
  applyPublishedLook(dropped, { avatar: { shape: 'moon', image: PAYLOAD }, avatarUpdatedAt: 't1' })
  assert.deepEqual(dropped.avatar, { shape: 'moon' })

  const kept = {}
  applyPublishedLook(kept, { avatar: { image: 'https://ok.example/a.png' }, avatarUpdatedAt: 't2' })
  assert.deepEqual(kept.avatar, { image: 'https://ok.example/a.png' })
})

test('cssImageUrl refuses every value that could close the url or the rule (#2646)', () => {
  for (const bad of [
    'https://ok.example/a".png',
    "https://ok.example/a'.png",
    'https://ok.example/a(.png',
    'https://ok.example/a).png',
    'https://ok.example/a\\.png',
    'https://ok.example/a\n.png',
    'https://ok.example/a\u0007.png',
    'javascript:alert(1)',
    'data:image/png;base64,AA");}body{background:red}',
    '',
  ]) assert.equal(cssImageUrl(bad), null, bad)

  assert.equal(cssImageUrl('https://ok.example/a.png'), 'url("https://ok.example/a.png")')
  assert.equal(safeLookImage('data:image/webp;base64,AAAA'), 'data:image/webp;base64,AAAA')
  assert.equal(safeLookImage('https://ok.example/a.png'), 'https://ok.example/a.png')
})
