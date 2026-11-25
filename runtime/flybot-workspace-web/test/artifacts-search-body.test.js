// Works-library search has to reach saved body text, not just titles. The list
// row keeps omitting the body; only the match predicate widens.
import assert from 'node:assert/strict'
import test from 'node:test'
import { boot, key, WS } from './helpers.js'

const base = (rest = '', ws = WS) => `/v1/workspaces/${ws}/artifacts${rest}`

test('works-library search matches saved body text, case-insensitively', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const doc = await call('POST', base(), { title: '周会记录', body: 'The Budget needs approval before Friday.', kind: 'document' }, key())
  assert.equal(doc.status, 201, JSON.stringify(doc.body))
  const site = await call('POST', base(), { title: 'Landing page', body: '<p>budget notes live here</p>', kind: 'website' }, key())
  assert.equal(site.status, 201, JSON.stringify(site.body))
  const other = await call('POST', base(), { title: 'Travel plan', body: 'nothing relevant in here', kind: 'document' }, key())
  assert.equal(other.status, 201, JSON.stringify(other.body))

  // Neither matching title contains the needle, so only body text can find them.
  const hit = await call('GET', base() + '?q=budget')
  assert.equal(hit.status, 200)
  assert.deepEqual(hit.body.items.map((item) => item.title).sort(), ['Landing page', '周会记录'])
  // The list projection still omits the body.
  for (const item of hit.body.items) assert.equal(item.body, undefined)

  const byTitle = await call('GET', base() + '?q=周会')
  assert.deepEqual(byTitle.body.items.map((item) => item.title), ['周会记录'])

  const miss = await call('GET', base() + '?q=approval-after-friday')
  assert.deepEqual(miss.body.items, [])
})

test('structured payloads are matched by their own text, not raw JSON', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const deck = await call('POST', base(), {
    title: 'Board deck', kind: 'slides',
    slides: { schema: 'flybot-workspace.slides.v1', slides: [{ title: 'Secret', bullets: ['alpha-slide-token'] }] },
  }, key())
  assert.equal(deck.status, 201, JSON.stringify(deck.body))
  const board = await call('POST', base(), {
    title: 'Sketch', kind: 'whiteboard',
    board: { schema: 'flybot-workspace.whiteboard.v1', width: 800, height: 600, strokes: [] },
  }, key())
  assert.equal(board.status, 201, JSON.stringify(board.body))

  // Live main indexes the text of slides, boards and other structured kinds,
  // so a slide bullet is a body match rather than an excluded payload.
  const hit = await call('GET', base() + '?q=alpha-slide-token')
  assert.deepEqual(hit.body.items.map((item) => item.title), ['Board deck'])
  assert.equal(hit.body.items[0].match.kind, 'body')
  // A title hit on a structured kind still works.
  assert.deepEqual((await call('GET', base() + '?q=Board deck')).body.items.map((item) => item.title), ['Board deck'])
})

test('search decodes known legacy work bodies and keeps ordinary JSON documents searchable', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const legacy = await call('POST', base(), {
    title: 'Legacy deck', kind: 'document',
    body: JSON.stringify({ schema: 'flybot-workspace.slides.v1',
      slides: [{ title: 'Weekly review', bullets: ['legacy-deck-token'] }] }),
  }, key())
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body))
  const json = await call('POST', base(), {
    title: 'Pasted payload', kind: 'document',
    body: '{"schema":"custom-format","requestId":42,"note":"copied data"}',
  }, key())
  assert.equal(json.status, 201, JSON.stringify(json.body))

  const hit = await call('GET', base() + '?q=legacy-deck-token')
  assert.deepEqual(hit.body.items.map((item) => item.title), ['Legacy deck'])
  assert.equal(hit.body.items[0].match.text, 'Weekly review legacy-deck-token')
  assert.deepEqual((await call('GET', base() + '?q=flybot-workspace.slides.v1')).body.items, [])
  assert.deepEqual((await call('GET', base() + '?q=requestId')).body.items.map((item) => item.title), ['Pasted payload'])
  assert.deepEqual((await call('GET', base() + '?q=42')).body.items.map((item) => item.title), ['Pasted payload'])
})

test('body matches still page and stay inside their workspace', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  for (const n of [1, 2, 3]) {
    const made = await call('POST', base(), { title: `note ${n}`, body: `page-token ${n}`, kind: 'document' }, key())
    assert.equal(made.status, 201, JSON.stringify(made.body))
  }
  const first = await call('GET', base() + '?q=page-token&limit=2')
  assert.equal(first.body.items.length, 2)
  assert.ok(first.body.cursor, JSON.stringify(first.body))
  const second = await call('GET', base() + `?q=page-token&limit=2&cursor=${first.body.cursor}`)
  assert.equal(first.body.items.length + second.body.items.length, 3)
  const ids = new Set([...first.body.items, ...second.body.items].map((item) => item.id))
  assert.equal(ids.size, 3)

  // A list for another workspace is scoped, not global: 200 with no rows, the
  // same shape the route already had, and no body text leaks across.
  const elsewhere = 'd'.repeat(32)
  const foreign = await bot.call('artifacts', 'GET', base('', elsewhere) + '?q=page-token')
  assert.equal(foreign.status, 200)
  assert.deepEqual(foreign.body.items, [])
})
