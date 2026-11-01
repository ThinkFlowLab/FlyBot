// policy/gates.json's signature rule (#2054): a pull request that edits an acceptance gate must
// carry `Policy-sign: <comment id or url>` in its body, and that comment must be written by someone
// other than the author and must name the tip it signs. These tests pin the cases the issue names —
// no line, own signature, another person's signature, an unrelated comment — plus the shapes a
// signature can be wrong in: a comment that is not on the pull request, a bot account, and a comment
// written for an older tip (a signature that does not move with the head signs nothing).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judge, loadPolicy, parseSignature } from './policy-sign.mjs'

const policy = loadPolicy()

const GATE_FILE = '.github/scripts/merge-gate.mjs'
const PR = { author: 'HugoXK' }
const HEAD = '9da401de2bdcd80ba851377ad1014d3bc5e5a90e'
const OTHER_TIP = '2b42c2ec9951c1279b0d8634f4672f887f82cb10'

test('#2054: a pull request that touches no gate file needs no signature', () => {
  const verdict = judge({ files: ['core/src/host/project-state.js'], body: 'Fixes #1', ...PR, head: HEAD, comments: [], policy })
  assert.equal(verdict.ok, true)
  assert.match(verdict.reason, /no gate file/)
})

test('#2054: a gate change with no `Policy-sign:` line is refused, and names the line', () => {
  const verdict = judge({ files: ['core/src/x.js', GATE_FILE], body: 'Fixes #1\n\nTightens the gate.', ...PR, head: HEAD, comments: [], policy })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /`Policy-sign:`/)
  assert.match(verdict.reason, /merge-gate\.mjs/, 'the refusal names the file that made the signature required')
})

test('#2054: a signature written by the pull request author is refused', () => {
  const verdict = judge({
    files: [GATE_FILE],
    body: 'Fixes #1\n\nPolicy-sign: 42',
    ...PR,
    head: HEAD,
    comments: [{ id: 42, body: `ok to change the gate at ${HEAD}`, user: { login: 'HugoXK', type: 'User' } }],
    policy,
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /own author/)
})

test('#2054: another person\'s signature is accepted, by id or by url', () => {
  const comments = [{ id: 42, body: `ok to change the gate at ${HEAD}`, user: { login: 'Birfy', type: 'User' } }]
  const byId = judge({ files: [GATE_FILE], body: 'Fixes #1\n\nPolicy-sign: 42', ...PR, head: HEAD, comments, policy })
  assert.deepEqual(byId, { ok: true, reason: 'signed by Birfy in comment 42', signer: 'Birfy' })

  const byUrl = judge({
    files: [GATE_FILE],
    body: 'Fixes #1\n\nPolicy-sign: https://github.com/ThinkFlowLab/FlyBot/pull/2054#issuecomment-42',
    ...PR,
    head: HEAD,
    comments,
    policy,
  })
  assert.equal(byUrl.ok, true, 'a url is read as its trailing comment id')
  assert.equal(byUrl.signer, 'Birfy')
})

test('#2054: a signature naming this tip by its short prefix is accepted', () => {
  const verdict = judge({
    files: [GATE_FILE],
    body: 'Fixes #1\n\nPolicy-sign: 42',
    ...PR,
    head: HEAD,
    comments: [{ id: 42, body: 'ok to change the gate at 9da401de2bdc', user: { login: 'Birfy', type: 'User' } }],
    policy,
  })
  assert.equal(verdict.ok, true, 'a comment quoting the tip abbreviated is still about this tip')
})

test('#2054: a signature written for another tip is refused', () => {
  const verdict = judge({
    files: [GATE_FILE],
    body: 'Fixes #1\n\nPolicy-sign: 42',
    ...PR,
    head: HEAD,
    comments: [{ id: 42, body: `ok to change the gate at ${OTHER_TIP}`, user: { login: 'Birfy', type: 'User' } }],
    policy,
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /does not name this tip/)
  assert.match(verdict.reason, /a new tip needs a new signature/)
})

test('#2054: a signature that names no tip at all is refused', () => {
  const verdict = judge({
    files: [GATE_FILE],
    body: 'Fixes #1\n\nPolicy-sign: 42',
    ...PR,
    head: HEAD,
    comments: [{ id: 42, body: 'ok to change the gate', user: { login: 'Birfy', type: 'User' } }],
    policy,
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /does not name this tip/)
})

test('#2054: a signature naming a comment that is not on the pull request is refused', () => {
  const verdict = judge({ files: [GATE_FILE], body: 'Fixes #1\n\nPolicy-sign: 99', ...PR, head: HEAD, comments: [{ id: 42, user: { login: 'Birfy', type: 'User' } }], policy })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /not on this pull request/)
})

test('#2054: a signature written by a bot account is refused', () => {
  const verdict = judge({
    files: [GATE_FILE],
    body: 'Fixes #1\n\nPolicy-sign: 42',
    ...PR,
    head: HEAD,
    comments: [{ id: 42, body: `ok at ${HEAD}`, user: { login: 'some-helper[bot]', type: 'Bot' } }],
    policy,
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /bot account/)
})

test('#2054: the line is read from the body only, on its own line', () => {
  assert.equal(parseSignature('Fixes #1\n\nPolicy-sign: 42\n'), '42')
  assert.equal(parseSignature('Fixes #1\n\n> Policy-sign: 42'), undefined, 'a quoted line is prose, not the signature')
  assert.equal(parseSignature('Fixes #1\n\nWe need a Policy-sign: 42 here'), undefined, 'the line must start with the field')
})
