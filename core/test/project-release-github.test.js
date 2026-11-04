import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appFixture } from './fixtures/github-app.mjs'
import { githubReleaseProvider } from '../src/host/project-release-github.js'
const sha = 'a'.repeat(40), spec = { repository: 'org/repo', tag: 'v1', sha, name: 'One', notes: 'Public notes', marker: '<!-- flybot-release:one -->' }
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value })
const identity = async () => ({ token: 'fixture-token', login: 'fixture-user' })
test('GitHub release proof resolves an annotated tag to its exact commit and retains only typed evidence', async () => {
  const calls = []
  const provider = githubReleaseProvider({}, { identity, request: async (url, options) => {
    calls.push({ url, options })
    if (url.includes('/releases/tags/')) return response({ id: 4, tag_name: 'v1', draft: false, published_at: '2026-11-03T00:00:00Z', body: spec.marker })
    if (url.includes('/git/ref/tags/')) return response({ object: { type: 'tag', sha: 'b'.repeat(40) } })
    return response({ object: { type: 'commit', sha } })
  } })
  const proof = await provider.inspect(spec, async () => true)
  assert.equal(proof.sha, sha); assert.equal(proof.marker, true); assert.equal(proof.executorLogin, 'fixture-user')
  assert.equal(JSON.stringify(proof).includes('fixture-token'), false)
  assert.equal(calls.length, 3); assert.ok(calls.every(row => row.options.method === 'GET'))
})
test('publication pins its requested SHA, checks an existing tag, and rechecks authority after identity resolution', async () => {
  let posted
  const provider = githubReleaseProvider({}, { identity, request: async (_url, options) => {
    if (options.method === 'GET') return response({}, 404)
    posted = JSON.parse(options.body); return response({ id: 4 }, 201)
  } })
  await provider.publish(spec, async () => true)
  assert.equal(posted.target_commitish, sha); assert.equal(posted.draft, false); assert.ok(posted.body.includes(spec.marker))
  const wrongTag = githubReleaseProvider({}, { identity, request: async () => response({ object: { type: 'commit', sha: 'c'.repeat(40) } }) })
  await assert.rejects(wrongTag.publish(spec, async () => true), /not the authorized commit/)
  let calls = 0
  const revoked = githubReleaseProvider({}, { identity, request: async () => { calls++; return response({}) } })
  await assert.rejects(revoked.publish(spec, async () => { throw new Error('Current authority revoked') }), /revoked/)
  assert.equal(calls, 0)
})
test('missing artifacts, rejected POSTs, lost responses and malformed published proofs stay distinct', async () => {
  const absent = githubReleaseProvider({}, { identity, request: async () => response({}, 404) })
  assert.equal(await absent.inspect(spec), null)
  const rejected = githubReleaseProvider({}, { identity, request: async (_url, options) => options.method === 'GET' ? response({}, 404) : response({}, 403) })
  await assert.rejects(rejected.publish(spec), error => error.code === 'release/rejected')
  const lost = githubReleaseProvider({}, { identity, request: async () => { throw new Error('Raw provider secret must not leak') } })
  await assert.rejects(lost.inspect(spec), /outcome is unavailable/)
  const draft = githubReleaseProvider({}, { identity, request: async url => url.includes('/releases/') ? response({ id: 2, tag_name: 'v1', draft: true }) : response({ object: { type: 'commit', sha } }) })
  await assert.rejects(draft.inspect(spec), /not a verifiable published commit/)
})

test('App Release publication and observation share exact SHA and typed external-identity proofs', async t => {
  let release, creates = 0
  const f = appFixture(t, (url, options, permissions) => {
    assert.deepEqual(permissions, { contents: options.method === 'POST' ? 'write' : 'read' })
    if (options.method === 'POST') { const body = JSON.parse(options.body); assert.equal(body.target_commitish, sha); creates++; release = { id: 8, tag_name: 'v1', draft: false, published_at: new Date().toISOString(), body: body.body }; return Response.json(release) }
    if (url.includes('/releases/tags/')) return release ? Response.json(release) : Response.json({}, { status: 404 })
    return Response.json({ object: { type: 'commit', sha } })
  })
  const provider = githubReleaseProvider(f.settings, { request: f.request })
  assert.equal(await provider.inspect(spec), null)
  await provider.publish(spec)
  const proof = await provider.inspect(spec)
  assert.equal(proof.sha, sha); assert.equal(proof.identity.provider, 'github-app'); assert.equal(proof.identity.installationId, 12); assert.equal(proof.executorLogin, 'contract-app[bot]'); assert.equal(creates, 1)
  assert(!JSON.stringify(proof).includes('ghs_')); f.suspend()
  await assert.rejects(provider.publish(spec), /installation/); assert.equal(creates, 1)
})
