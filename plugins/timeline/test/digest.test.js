// The report prints the reader's local clock (#582), so this file runs in a fixed zone ahead of
// UTC: a formatter that quietly prints UTC cannot pass here just because the CI runner is on UTC.
process.env.TZ = 'Asia/Shanghai'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDigest, formatCount, formatMs } from '../src/digest.js'
import { createTimeline, DIGEST_ENDPOINT } from '../src/timeline.js'
import { mockAdapter } from './mock-adapter.js'

const make = (extra = {}) => ({
  version: 1, now: 100_000, from: 0, to: 100_000, windowMs: 100_000, live: true,
  lanes: [{ id: 'user', kind: 'user', name: 'You' }, { id: 'a', kind: 'bot', name: 'Chief', main: true }, { id: 'b', kind: 'bot', name: 'Writer' }],
  utilization: [
    { lane: 'a', windowMs: 100_000, busyMs: 62_000, turns: 4, errors: 1, running: false },
    { lane: 'b', windowMs: 100_000, busyMs: 0, turns: 0, errors: 0, running: false },
  ],
  usage: [{ lane: 'a', calls: 4, input: 12_345, output: 1_234, cacheRead: 8_000, cacheWrite: 0 }],
  toolUse: [{ lane: 'a', tools: [{ name: 'web_search', calls: 6, failed: 1 }, { name: 'read', calls: 2, failed: 0 }] }],
  edges: [{ from: 'b', to: 'a', unanswered: 1 }],
  stuck: [{ id: 'x9', from: 'b', to: 'a', role: 'request', waitedMs: 720_000 }],
  exchanges: [{ id: 'x9', from: 'b', to: 'a', waiting: true, t: 100_000 - 720_000 }],
  ...extra,
})

test('formatCount and formatMs read at a glance', () => {
  assert.equal(formatCount(840), '840')
  assert.equal(formatCount(12_345), '12.3k')
  assert.equal(formatCount(1_234_567), '1.2M')
  assert.equal(formatCount(-3), '0')
  assert.equal(formatCount(undefined), '0')
  assert.equal(formatMs(40_000), '40s')
  assert.equal(formatMs(720_000), '12m')
  assert.equal(formatMs(3_900_000), '1h05m')
  assert.equal(formatMs(3_600_000), '1h00m')
  assert.equal(formatMs(undefined), '0s')
})

// The carry must never overflow the unit the text prints (#761): rounding the raw milliseconds
// inside a unit chosen from the raw value printed `60s` for 59.6 s and `1h60m` for 1h59m50s, and a
// person pasting the report read those numbers in a standup.
test('#761: a duration rounds once and carries, instead of printing 60s, 60m or 1h60m', () => {
  assert.equal(formatMs(59_600), '1m')
  assert.equal(formatMs(3_599_999), '1h00m')
  assert.equal(formatMs(7_190_000), '2h00m')
  // The boundaries themselves stay where they were.
  assert.equal(formatMs(59_400), '59s') // 59.4 s still reads in seconds
  assert.equal(formatMs(59_999), '1m') // 59.999 s rounds to a minute, never to '60s'
  assert.equal(formatMs(60_000), '1m')
  assert.equal(formatMs(3_540_000), '59m')
  assert.equal(formatMs(86_400_000), '24h00m')
})

test('#582: per-Bot sections, the team rollup and the longest wait', () => {
  const digest = buildDigest(make(), { now: 100_000 })
  assert.equal(digest.bots[0].name, 'Chief')
  assert.equal(digest.bots[0].main, true)
  assert.equal(digest.bots[0].turns, 4)
  assert.equal(digest.bots[0].waiting, 0)
  assert.equal(digest.bots[1].waiting, 1)
  assert.deepEqual(digest.bots[0].tools.map(tool => tool.name), ['web_search', 'read'])
  assert.equal(digest.team.turns, 4)
  assert.equal(digest.team.errors, 1)
  assert.equal(digest.team.tokens.input, 12_345)
  assert.deepEqual(digest.team.longestWait, { id: 'x9', from: 'b', to: 'a', waitedMs: 720_000 })
  assert.match(digest.markdown, /^# Team report\nWindow: 08:00–08:01 · live/)
  assert.match(digest.markdown, /## Chief \(main\)\n- 4 turns, 1 failed \(25%\)/)
  assert.match(digest.markdown, /- busy 62% of the window/)
  assert.match(digest.markdown, /- tokens: 12.3k in \/ 1.2k out \/ 8.0k cached/)
  assert.match(digest.markdown, /- 1 request\(s\) unanswered/)
  assert.match(digest.markdown, /- tools: web_search ×6 \(1 failed\), read ×2/)
  assert.match(digest.markdown, /## Writer\n- no turns in the window/)
  assert.match(digest.markdown, /## Team\n- 4 turns, 1 failed/)
  assert.match(digest.markdown, /- longest wait: b → a, 12m/)
  assert.match(digest.line, /4 turns, 1 failed, 12.3k tokens in over 08:00–08:01\./)
})

// The endpoint must work before the richer fields land (#582): a window from an older host carries
// no `stuck` and no `toolUse`, and the report is shorter rather than broken.
test('#582: a window without the newer fields still builds, and says less', () => {
  const digest = buildDigest(make({ toolUse: undefined, stuck: undefined, exchanges: [] }), { now: 100_000 })
  assert.doesNotMatch(digest.markdown, /tools:/)
  assert.doesNotMatch(digest.markdown, /longest wait/)
  assert.equal(digest.team.longestWait, null)
  // Without `stuck` the waiting exchange is measured against `now` instead of being dropped.
  const old = buildDigest(make({ stuck: undefined }), { now: 820_000 })
  assert.equal(old.team.longestWait.waitedMs, 1_440_000)
})

test('#582: an empty window is a short honest report', () => {
  const digest = buildDigest({})
  assert.equal(digest.bots.length, 0)
  assert.match(digest.markdown, /No activity in the window\./)
  assert.match(digest.line, /No Bot activity/)
  assert.equal(digest.markdown.includes('undefined'), false)
})

test('#582: a Bot that fails most turns is named as needing a look', () => {
  const digest = buildDigest(make({ utilization: [{ lane: 'a', windowMs: 100_000, busyMs: 1000, turns: 4, errors: 3, running: false }] }), { now: 100_000 })
  assert.deepEqual(digest.team.unhealthy, ['a'])
  assert.match(digest.markdown, /- needs a look: a/)
  assert.match(digest.markdown, /- look: 3 of 4 turns failed/)
})

// The rollup is the sum of the per-Bot numbers, never a separate count: a report a person reads
// must not disagree with the lines above it.
test('#582: the team rollup equals the Bot sections', () => {
  const digest = buildDigest(make({
    utilization: [
      { lane: 'a', windowMs: 100_000, busyMs: 10_000, turns: 2, errors: 0 },
      { lane: 'b', windowMs: 100_000, busyMs: 5_000, turns: 3, errors: 2 },
    ],
    usage: [{ lane: 'a', calls: 2, input: 10, output: 4, cacheRead: 1 }, { lane: 'b', calls: 3, input: 20, output: 5, cacheRead: 2 }],
  }), { now: 100_000 })
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) {
    assert.equal(digest.team.tokens[key], digest.bots.reduce((sum, bot) => sum + bot.tokens[key], 0), key)
  }
  assert.equal(digest.team.turns, digest.bots.reduce((sum, bot) => sum + bot.turns, 0))
  assert.equal(digest.team.errors, digest.bots.reduce((sum, bot) => sum + bot.errors, 0))
})

// A report copied at 17:05 says 17:05 — the hour the panel header above the button shows, not the
// UTC hour, and with no zone the reader has to guess (#582).
test('#582: the report names local hours, like the panel header', () => {
  const from = Date.UTC(2026, 9, 22, 9, 5)
  const to = Date.UTC(2026, 9, 22, 9, 20)
  const digest = buildDigest(make({ from, to, live: false }), { now: to })
  assert.equal(digest.range, '17:05–17:20')
  assert.match(digest.markdown, /^# Team report\nWindow: 17:05–17:20\n/)
})

// The endpoint is the feature, not the pure builder: the suite stayed green with
// `adapter.handle(DIGEST_ENDPOINT, digest)` and its `offDigest()` deleted (#582), so this goes
// through the real host, the way test/host.test.js does for `timeline/window`.
test('#582: the endpoint is registered read-only and removed on dispose', () => {
  const adapter = mockAdapter()
  const timeline = createTimeline(adapter, { persist: false, now: () => 100_000 })
  try {
    assert.equal(DIGEST_ENDPOINT, 'timeline/digest')
    assert.ok(adapter.endpoints.has(DIGEST_ENDPOINT), 'createTimeline registers timeline/digest')
    const report = adapter.endpoints.get(DIGEST_ENDPOINT)({ windowMs: 300_000, title: ' Standup ' })
    assert.equal(report.title, 'Standup')
    assert.match(report.markdown, /^# Standup\nWindow: \d\d:\d\d–\d\d:\d\d · live\n/)
    // The host hangs the endpoint on the real window: every Bot it knows, with no turns yet.
    assert.match(report.markdown, /## Chief \(main\)\n- no turns in the window/)
    assert.match(report.markdown, /## Team\n- 0 turns, 0 failed/)
    // Read-only: answering again changes nothing and keeps the default title.
    assert.equal(adapter.endpoints.get(DIGEST_ENDPOINT)({}).title, 'Team report')
  } finally {
    timeline.dispose()
  }
  assert.equal(adapter.endpoints.has(DIGEST_ENDPOINT), false, 'dispose removes the endpoint')
})
