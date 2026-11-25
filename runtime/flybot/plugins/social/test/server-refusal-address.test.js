// #2975: a refusal names the server it is about. The page learned in #2967 that a host alone does not
// name a server: `client.js` `serverLabel` keeps the protocol (except https) and the path, so
// `https://social.example/team-b` and `…/team-c` read differently. The four Check refusals in
// `src/server-config.js` kept a bare host and appended it, so two servers on one host drew
// byte-identical sentences and the owner could not tell which one was refused.
import assert from 'node:assert/strict'
import test from 'node:test'
import { probeServer } from '../src/server-config.js'

// Same rule as `client.js` `serverLabel` (#2963/#2967): https is the default and stays out of the
// name, any other scheme is kept, the trailing slash goes, the path stays.
const LABELS = {
  'https://social.example/team-b': 'social.example/team-b',
  'https://social.example/team-c': 'social.example/team-c',
  'https://social.example': 'social.example',
  'http://localhost:8787/team-b': 'http://localhost:8787/team-b',
  'https://social.example/team-b/': 'social.example/team-b',
}

const answer = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

// The four refusals of `probeServer`, one fake fetch each: unreachable, redirect, HTTP error, and a
// 200 that is not a Bot Social platform document.
const FAILURES = {
  unreachable: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { cause: { code: 'ENOTFOUND' } }) },
  redirect: answer(302, ''),
  'http 404': answer(404, '{}'),
  'html 200': answer(200, '<html>hello</html>'),
}

const sentence = async (address, failure) => {
  try {
    await probeServer(address, { fetch: FAILURES[failure] })
  } catch (error) {
    assert.equal(error.code, 'bot/refused', `${address} ${failure}: expected a refusal, got ${error}`)
    return error.message
  }
  assert.fail(`${address} ${failure}: expected a refusal`)
}

test('#2975: two servers on one host draw different refusals, each naming its own path', async () => {
  for (const failure of Object.keys(FAILURES)) {
    const b = await sentence('https://social.example/team-b', failure)
    const c = await sentence('https://social.example/team-c', failure)
    assert.notEqual(b, c, `${failure}: two servers on one host draw one sentence: ${b}`)
    assert.ok(b.includes('social.example/team-b'), `${failure}: team-b is not named: ${b}`)
    assert.ok(c.includes('social.example/team-c'), `${failure}: team-c is not named: ${c}`)
    assert.ok(!b.includes('team-c'), `${failure}: the team-b refusal names team-c: ${b}`)
    assert.ok(!c.includes('team-b'), `${failure}: the team-c refusal names team-b: ${c}`)
  }
})

test('#2975: the refusal name follows the page rule — https out, other schemes kept, no trailing slash', async () => {
  for (const [address, label] of Object.entries(LABELS)) {
    const text = await sentence(address, 'html 200')
    assert.ok(text.startsWith(`${label} did not answer like a Bot Social server.`), `${address} → ${text}`)
  }
  // The whole sentence, once: the host-side name is the only server text in it.
  const unreachable = await sentence('https://social.example/team-b', 'unreachable')
  assert.equal(unreachable, 'Could not reach social.example/team-b: ENOTFOUND.')
  const redirect = await sentence('https://social.example/team-c', 'redirect')
  assert.equal(redirect, 'social.example/team-c redirects somewhere else. Enter the address it redirects to.')
  const http = await sentence('https://social.example/team-c', 'http 404')
  assert.equal(http, 'social.example/team-c answered HTTP 404. Is this a Bot Social server?')
})
