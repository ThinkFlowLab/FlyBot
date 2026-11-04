import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBrowserChannel, install, pageText, partEnd } from '../src/host/browser.js'

const ids = items => items.map(item => item.id)

test('a read with no window that shows the Bot answers at once', async () => {
  const channel = createBrowserChannel()
  assert.deepEqual(await channel.read('bot-a'), { absent: true })
  const other = channel.wait('window-1', { 'bot-b': {} })
  assert.deepEqual(await channel.read('bot-a'), { absent: true })
  channel.dispose()
  assert.deepEqual(await other, [])
})

test('a read wakes the waiting window and resolves with its result', async () => {
  const channel = createBrowserChannel({ waitMs: 5000 })
  const polled = channel.wait('window-1', { 'bot-a': { url: 'https://example.com/' } })
  const read = channel.read('bot-a', { from: 40 })
  const [request] = await polled
  assert.deepEqual({ botId: request.botId, from: request.from }, { botId: 'bot-a', from: 40 })
  assert.equal(channel.result({ id: request.id, ok: true, page: { title: 'Example' } }), true)
  assert.deepEqual(await read, { page: { title: 'Example' } })
  // A repeated answer is ignored.
  assert.equal(channel.result({ id: request.id, ok: true, page: {} }), false)
  channel.dispose()
})

test('a newer poll ends the older one empty', async () => {
  const channel = createBrowserChannel({ waitMs: 5000 })
  const older = channel.wait('window-1', { 'bot-a': {} })
  const newer = channel.wait('window-1', { 'bot-a': {}, 'bot-b': {} })
  assert.deepEqual(await older, [])
  const read = channel.read('bot-b')
  const [request] = await newer
  channel.result({ id: request.id, ok: false, error: 'boom' })
  assert.deepEqual(await read, { error: 'boom' })
  channel.dispose()
})

test('a request handed to a lost poll is handed out again after the resend time', async () => {
  let clock = 0
  const channel = createBrowserChannel({ now: () => clock, waitMs: 5000, resendMs: 50 })
  const lost = channel.wait('window-1', { 'bot-a': {} })
  const read = channel.read('bot-a')
  const [request] = await lost
  // Within the resend time the next poll waits; a request it already got is not repeated.
  clock = 20
  const next = channel.wait('window-1', { 'bot-a': {} })
  clock = 60
  assert.deepEqual(ids(await next), [request.id])
  channel.result({ id: request.id, ok: true, page: { url: 'u' } })
  assert.deepEqual(await read, { page: { url: 'u' } })
  channel.dispose()
})

test('a window that stopped polling is gone after the stale time', async () => {
  let clock = 0
  const channel = createBrowserChannel({ now: () => clock, waitMs: 1, staleMs: 30_000 })
  await channel.wait('window-1', { 'bot-a': {} })
  clock = 29_000
  assert.deepEqual(Object.keys(channel.openPages()), ['bot-a'])
  clock = 31_000
  assert.deepEqual(await channel.read('bot-a'), { absent: true })
  assert.deepEqual(channel.openPages(), {})
  channel.dispose()
})

test('an unanswered read times out and leaves the queue', async () => {
  const channel = createBrowserChannel({ waitMs: 1, readTimeoutMs: 20, resendMs: 0 })
  await channel.wait('window-1', { 'bot-a': {} })
  const result = await channel.read('bot-a')
  assert.match(result.error, /did not answer in time/)
  assert.deepEqual(await channel.wait('window-1', { 'bot-a': {} }), [])
  channel.dispose()
})

test('dispose ends polls and pending reads', async () => {
  const channel = createBrowserChannel({ waitMs: 60_000, readTimeoutMs: 60_000 })
  const polled = channel.wait('window-1', { 'bot-a': {} })
  const read = channel.read('bot-a')
  await polled
  const idle = channel.wait('window-1', { 'bot-a': {} })
  channel.dispose()
  assert.deepEqual(await idle, [])
  assert.match((await read).error, /stopped/)
})

test('pageText pages long text and lists controls on the first page only', () => {
  const page = {
    url: 'https://example.com/a',
    title: '  Example\n Page ',
    selection: 'picked words',
    text: 'x'.repeat(25),
    items: [
      { role: 'link', name: 'Docs', href: 'https://example.com/docs' },
      { role: 'textbox', name: 'Search', value: 'dsh' },
      { role: 'button', name: 'Go', disabled: true },
    ],
  }
  const first = pageText(page, { size: 10, itemsMax: 2 })
  assert.match(first, /^Your browser page, read just now\./)
  assert.match(first, /Title: Example Page/)
  assert.match(first, /Selected by the user: "picked words"/)
  assert.match(first, /Text \(characters 0–10 of 25; call read_browser with from: 10 for more\):\nxxxxxxxxxx\n/)
  assert.match(first, /\[1\] link "Docs" → https:\/\/example\.com\/docs/)
  assert.match(first, /\[2\] textbox "Search" \(value "dsh"\)/)
  assert.match(first, /… and 1 more/)
  const last = pageText(page, { from: 20, size: 10 })
  assert.match(last, /Text \(characters 20–25 of 25\):\nxxxxx$/)
  assert.doesNotMatch(last, /Links and controls/)
  assert.match(pageText({ url: 'about:blank', text: '' }), /Text: \(the page shows no text\)/)
})

test('pageText reads Markdown in parts cut at line breaks, and each part lists the controls it marks', () => {
  const rows = Array.from({ length: 6 }, (_, index) => `| r${index} | link[#${index + 2}] |`).join('\n')
  const text = `# Title[#1]\n\nIntro paragraph.\n\n| a | b |\n| --- | --- |\n${rows}`
  const items = [{ role: 'link', name: 'Title', href: 'https://example.com/#t' }, ...Array.from({ length: 6 }, (_, index) => ({ role: 'link', name: `r${index}`, href: `https://example.com/${index}` }))]
  const page = { url: 'https://example.com/', title: 'Example', format: 'markdown', text, items, truncated: 'reading took longer than 1500 ms' }
  const first = pageText(page, { size: 80 })
  assert.match(first, /Note: the page was too large to read whole \(reading took longer than 1500 ms\); the text stops there\./)
  const cut = partEnd(text, 0, 80)
  // The first part ends at a line break, after a whole table row.
  assert.equal(text[cut - 1], '\n')
  assert.ok(cut <= 80 && cut >= 48)
  assert.ok(first.includes(`Text as Markdown; [#n] marks a link or control, listed below (characters 0–${cut} of ${text.length}; call read_browser with from: ${cut} for more):\n${text.slice(0, cut)}\n`))
  assert.match(first, /Links and controls in this part:\n\[#1\] link "Title" → https:\/\/example\.com\/#t\n\[#2\] link "r0"/)
  assert.doesNotMatch(first, /\[#7\] link/)
  const rest = pageText(page, { from: cut, size: 10_000 })
  assert.match(rest, new RegExp(`characters ${cut}–${text.length} of ${text.length}\\):`))
  assert.match(rest, /\[#7\] link "r5" → https:\/\/example\.com\/5$/)
  assert.doesNotMatch(rest, /\[#1\] link/)
  // A mark the list does not have, and a part with too many marks.
  assert.doesNotMatch(pageText({ ...page, text: 'see [#99]' }), /Links and controls/)
  assert.match(pageText(page, { itemsMax: 2 }), /Links and controls in this part \(the first 2 of 7\):\n\[#1\][^\n]*\n\[#2\][^\n]*$/)
})

test('partEnd prefers a blank line, then a line break, and cuts hard only without either', () => {
  assert.equal(partEnd('aaaaaaaa\n\nbb\ncc', 0, 14), 10)
  assert.equal(partEnd('aaaaaa\nbbbbbbbbbb', 0, 10), 7)
  assert.equal(partEnd('a\n' + 'b'.repeat(20), 0, 10), 10)
  assert.equal(partEnd('short', 0, 10), 5)
})

// P-519: a part boundary is a code-point one. A cut that lands between the halves of a surrogate
// pair reaches the model, and the UTF-8 encoder, as U+FFFD in both parts, and the `from` the tool
// prints lands in the middle of the character as well.
test('a part cut lands on a character, so an emoji is never split across two reads', () => {
  const text = 'x'.repeat(11_999) + '\u{1F600}' + 'y'.repeat(10_000)
  assert.equal(text.length, 22_001)
  // The hard fallback steps back off the pair instead of ending between its halves.
  assert.equal(partEnd(text, 0, 12_000), 11_999)
  // An ASCII page keeps its exact boundary.
  const ascii = 'x'.repeat(22_001)
  assert.equal(partEnd(ascii, 0, 12_000), 12_000)
  for (const format of ['markdown', 'text']) {
    const url = 'https://example.com/'
    const first = pageText({ url, text, format }, { size: 12_000 })
    const rest = pageText({ url, text, format }, { from: 12_000, size: 12_000 })
    assert.equal(first.isWellFormed(), true, `${format}: the first part is a valid string`)
    assert.equal(rest.isWellFormed(), true, `${format}: the rest is a valid string`)
    assert.doesNotMatch(first, /\uFFFD/, format)
    assert.doesNotMatch(rest, /\uFFFD/, format)
    // Part one ends before the emoji, and its own continuation point is that same boundary.
    assert.ok(first.endsWith('\n' + 'x'.repeat(11_999)), format)
    assert.match(first, /characters 0–11999 of 22001; call read_browser with from: 11999 for more/)
    // A `from` inside the pair is moved back to the character's first half, so the whole emoji opens
    // the second part and nothing is lost between the two reads.
    assert.ok(rest.endsWith('\n\u{1F600}' + 'y'.repeat(10_000)), format)
    const asciiFirst = pageText({ url, text: ascii, format }, { size: 12_000 })
    const asciiRest = pageText({ url, text: ascii, format }, { from: 12_000, size: 12_000 })
    assert.equal(asciiFirst.isWellFormed(), true)
    assert.equal(asciiRest.isWellFormed(), true)
    assert.match(asciiFirst, /characters 0–12000 of 22001; call read_browser with from: 12000 for more/)
    assert.match(asciiRest, /characters 12000–22001 of 22001\):/)
  }
})

// #1916: the open-page snapshot is what a Bot reads back from outside the team, and both bounds
// are code-unit ones: 2000 for an address and 300 for a title must not land inside an emoji.
test('the open-page snapshot never cuts a title or an address in half (#1916)', () => {
  const registered = []
  const rt = {
    ctx: { get: () => ({ name: 'desktop' }), effect: () => {}, tools: { register: (tool) => registered.push(tool) } },
    config: {},
    botOf: () => ({ id: 'a' }),
  }
  install(rt)
  const open = rt.browserOpen({
    a: { url: `${'a'.repeat(1999)}\u{1F600}tail`, title: `${'b'.repeat(299)}\u{1F600}tail` },
  })
  assert.equal(open.a.url.isWellFormed(), true)
  assert.equal(open.a.title.isWellFormed(), true)
  assert.equal(open.a.url, 'a'.repeat(1999))
  assert.equal(open.a.title, 'b'.repeat(299))
  // A cut that lands on a whole character keeps it.
  const roomy = rt.browserOpen({ a: { url: `${'a'.repeat(1998)}\u{1F600}`, title: `${'b'.repeat(298)}\u{1F600}` } })
  assert.equal(roomy.a.url, `${'a'.repeat(1998)}\u{1F600}`)
  assert.equal(roomy.a.title, `${'b'.repeat(298)}\u{1F600}`)
  assert.equal(registered.length > 0, true)
})
