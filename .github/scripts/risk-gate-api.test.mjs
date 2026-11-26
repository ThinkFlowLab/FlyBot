import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { prFiles, mergedPrs, request, DEFAULT_REPO } from './risk-gate.mjs'

// --- GitHub REST layer, without a network and without a token ------------------------------
const reply = (body, { status = 200, link = null, remaining = '55' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  headers: {
    get: (k) => {
      const key = k.toLowerCase()
      if (key === 'link') return link
      if (key === 'x-ratelimit-remaining') return remaining
      return null
    },
  },
  json: async () => body,
  text: async () => JSON.stringify(body),
})
const withFetch = async (stub, fn) => {
  const real = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return stub(String(url), calls.length)
  }
  try { await fn(calls) } finally { globalThis.fetch = real }
}

test('prFiles: reads the API anonymously, with no authorization header', async () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN, GITHUB_API_URL: process.env.GITHUB_API_URL }
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_API_URL
  try {
    await withFetch(() => reply([{ filename: 'docs/a.md' }]), async (calls) => {
      assert.deepEqual(await prFiles(DEFAULT_REPO, 3382), [{ filename: 'docs/a.md' }])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, `https://api.github.com/repos/${DEFAULT_REPO}/pulls/3382/files?per_page=100`)
      assert.equal(calls[0].init.headers.authorization, undefined, 'no token, no authorization header')
    })
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})

test('prFiles: sends a token when one is set, and follows the Link header to the next page', async () => {
  const saved = process.env.GITHUB_TOKEN
  process.env.GITHUB_TOKEN = 'test-token'
  try {
    const next = 'https://api.github.com/repos/o/r/pulls/3112/files?per_page=100&page=2'
    await withFetch((url) => (url.includes('page=2')
      ? reply([{ filename: 'docs/b.md' }])
      : reply([{ filename: 'docs/a.md' }], { link: `<${next}>; rel="next", <${next}>; rel="last"` })),
    async (calls) => {
      assert.deepEqual(await prFiles('o/r', 3112), [{ filename: 'docs/a.md' }, { filename: 'docs/b.md' }])
      assert.equal(calls.length, 2)
      assert.equal(calls[0].init.headers.authorization, 'Bearer test-token')
      assert.equal(calls[1].url, next)
    })
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = saved
  }
})

test('request: a spent anonymous quota is named in the error, not just a status code', async () => {
  await withFetch(() => reply({ message: 'API rate limit exceeded' }, { status: 403, remaining: '0' }), async () => {
    await assert.rejects(() => request('/repos/o/r/pulls/1/files'), (e) => {
      assert.match(e.message, /403/)
      assert.match(e.message, /quota spent/)
      assert.match(e.message, /GH_TOKEN/)
      return true
    })
  })
})

test('mergedPrs: keeps merged PRs only (closed-but-unmerged is not a replay sample)', async () => {
  await withFetch(() => reply([
    { number: 7, title: 'merged one', merged_at: '2026-11-26T00:00:00Z' },
    { number: 8, title: 'closed unmerged', merged_at: null },
  ]), async () => {
    assert.deepEqual(await mergedPrs(DEFAULT_REPO, 5), [{ number: 7, title: 'merged one' }])
  })
})

// The script runs with no token and no `gh`: the acceptance command is
// `node .github/scripts/risk-gate.mjs --pr 3382`, so it must not shell out or require one.
test('the script needs no gh binary and no token to run', () => {
  const src = readFileSync(new URL('./risk-gate.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /child_process/, 'no gh/exec dependency')
  assert.doesNotMatch(src, /secrets\.|GITHUB_TOKEN\)?\s*\?\?/, 'no token requirement')
})
