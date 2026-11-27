import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { labelPlan } from './risk-gate-label.mjs'
import { createGate, loadRules } from './risk-tier.mjs'

const exec = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('./risk-gate-label.mjs', import.meta.url))
const RULES = fileURLToPath(new URL('../agent/risk-rules.json', import.meta.url))
const REPO = 'owner/repo'
const PR = '12'
const TIER = createGate(loadRules(RULES)).judge([]).tier // what an empty diff is worth; the fixtures reuse it

// The command exits 1 when it cannot write; the run helpers keep that exit code instead of throwing.
const runScript = (env, ...args) => exec(process.execPath, [SCRIPT, '--repo', REPO, '--pr', PR, '--rules', RULES, ...args], {
  env: { PATH: process.env.PATH, ...env },
  encoding: 'utf8',
}).then(({ stdout, stderr }) => ({ status: 0, stdout, stderr }), (e) => ({ status: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' }))

// --- the write rule, without a network ---------------------------------------------------------
test('labelPlan: the first judgement adds the only risk label and keeps other labels', () => {
  assert.deepEqual(labelPlan('T2', ['bug', 'agent-pr']), { target: 'risk:T2', add: 'risk:T2', remove: [] })
})

test('labelPlan: a new verdict replaces the old tier, never adds a second one', () => {
  assert.deepEqual(labelPlan('T2', ['bug', 'risk:T1']), { target: 'risk:T2', add: 'risk:T2', remove: ['risk:T1'] })
})

test('labelPlan: the verdict already in place is left untouched, so a re-run writes nothing', () => {
  assert.deepEqual(labelPlan('T2', ['risk:T2', 'bug']), { target: 'risk:T2', add: null, remove: [] })
})

test('labelPlan: duplicates and a stale second verdict collapse into the one target label', () => {
  assert.deepEqual(labelPlan('T2', ['risk:T2', 'risk:T1']), { target: 'risk:T2', add: null, remove: ['risk:T1'] })
})

// --- the command, against a local API (no network, no token) ------------------------------------
// The stub records the exact write calls, so "idempotent" is a measurement, not a reading of the
// code. GITHUB_API_URL points both scripts at it; nothing leaves the machine.
async function withApi(labels, fn) {
  const state = { labels: [...labels], calls: [] }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = []
    req.on('data', (c) => body.push(c))
    req.on('end', () => {
      state.calls.push(`${req.method} ${url.pathname}`)
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(payload === undefined ? '' : JSON.stringify(payload))
      }
      if (req.method === 'GET' && url.pathname === `/repos/${REPO}/pulls/${PR}/files`) return send(200, [])
      if (req.method === 'GET' && url.pathname === `/repos/${REPO}/issues/${PR}/labels`) {
        return send(200, state.labels.map((name) => ({ name })))
      }
      if (req.method === 'DELETE' && url.pathname.startsWith(`/repos/${REPO}/issues/${PR}/labels/`)) {
        const name = decodeURIComponent(url.pathname.split('/').pop())
        state.labels = state.labels.filter((n) => n !== name)
        return send(200, {})
      }
      if (req.method === 'POST' && url.pathname === `/repos/${REPO}/issues/${PR}/labels`) {
        const { labels: added } = JSON.parse(String(body.join('') || '{}'))
        state.labels.push(...added)
        return send(200, added.map((name) => ({ name })))
      }
      send(404, { message: `no stub for ${req.method} ${url.pathname}` })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = { GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` }
  try {
    await fn((...args) => runScript(env, ...args), state)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const writes = (state) => state.calls.filter((c) => !c.startsWith('GET '))

test('command: --apply leaves one risk label and no comment, and a second run writes nothing', async () => {
  await withApi(['bug', 'risk:T1'], async (run, state) => {
    const first = await run('--apply')
    assert.equal(first.status, 0, first.stderr)
    assert.deepEqual(writes(state), [`DELETE /repos/${REPO}/issues/${PR}/labels/risk%3AT1`, `POST /repos/${REPO}/issues/${PR}/labels`])
    assert.deepEqual(state.labels, ['bug', `risk:${TIER}`])
    assert.match(first.stdout, new RegExp(`risk-gate-label: PR #${PR} tier ${TIER}; applied risk:${TIER}, removed risk:T1`))

    const second = await run('--apply')
    assert.equal(second.status, 0, second.stderr)
    assert.equal(writes(state).length, 2, 'a re-run must send no write')
    assert.match(second.stdout, /unchanged, risk:T\d was already the only risk label/)
    assert.deepEqual(state.labels, ['bug', `risk:${TIER}`], 'a re-run must not stack labels')
    assert.ok(!state.calls.some((c) => c.includes('/comments')), 'no comment is ever posted')
  })
})

test('command: without --apply it reports the change and writes nothing', async () => {
  await withApi(['risk:T1'], async (run, state) => {
    const r = await run()
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /dry run: would add risk:T\d, removing risk:T1/)
    assert.equal(writes(state).length, 0)
    assert.deepEqual(state.labels, ['risk:T1'])
  })
})

test('command: a write the token cannot make fails loudly instead of claiming success', async () => {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url.includes('/labels')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify([]))
    }
    if (req.method === 'GET' && req.url.includes('/files')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end('[]')
    }
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Resource not accessible by integration' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const r = await runScript({ GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` }, '--apply')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /POST .* -> 403/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
