// #1110: a conclusion counts only when the workstation that claims it signed it.
//
// The four impersonation bodies at the bottom are verbatim excerpts (the conclusion lines) of comments
// on main: #1094 comment 6392483805, #1095 comment 6392479580, #1108 comment 6393564871, #1115 comment
// 6393959918. Each one carries `Written-by: Reviewer` from the shared account, none carries a signature,
// and every one of them was read as a conclusion by the gate before this change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { canonical, loadSigners, parseSignature } from './verdict-signature.mjs'
import { decide, loadPolicy, render } from './review-gate.mjs'
import { keyEnv, readKey, sign as signVerdict } from './sign-verdict.mjs'

const HEAD = '2a09e5fe794c0d6840a263bdeef25dc0775aab7b'
const OLD = 'd797cbe4d3e7c3653f7ded379eefa85209342703'
const REPO = 'ThinkFlowLab/FlyBot'
const PR = 1132

function mint() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, der: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') }
}
const REVIEWER = mint()
const REVIEWER2 = mint()

// A signers file that agrees with the policy, read without touching the filesystem.
const signersFile = (signers) => () => JSON.stringify({ version: 1, signers })
const loaded = (table = { Reviewer: REVIEWER.der, Reviewer2: REVIEWER2.der }, policy = { signers: ['Reviewer', 'Reviewer2'] }) =>
  loadSigners({ policy, path: 'signers.json', read: signersFile(table) })

const policy = { reviewers: ['Birfy'], selfReview: ['Birfy'], writers: ['Reviewer', 'Reviewer2', 'Birfy'], signers: ['Reviewer', 'Reviewer2'] }

const lines = ({ tip = HEAD, verdict = 'PASS', ran = ['  - npm run verify → pass'], writer = 'Reviewer' } = {}) =>
  [`Verdict: ${verdict} at ${tip}`, `Written-by: ${writer}`, 'Ran:', ...ran, 'Not run:  - smoke — host code unchanged']

// A report signed the way `sign-verdict.mjs` signs one: the canonical string names the full head, the
// workstation and the nonce; the `Verdict:` line may carry a short sha, which is not signed.
function signed({ tip = HEAD, verdict = 'PASS', workstation = 'Reviewer', key = REVIEWER.privateKey, nonce = 'n1', head = HEAD, ran, pr = PR, repo = REPO, attest = true } = {}) {
  const signature = signVerdict({ repo, pr, verdict, head, workstation, key, nonce }).lines
  // The header is read in order, and both #1110's signature lines and #1148's attestation have to fit in
  // it: Verdict, Written-by, Attestation, then the three signature lines, then the evidence. Every pull
  // request here is opened by the shared account, so the author's own login needs both; the attestation
  // case below drops one to prove the two refusals stayed separate.
  return [
    `Verdict: ${verdict} at ${tip}`,
    'Written-by: Reviewer',
    ...(attest ? [`Attestation: ${head} role=${workstation}`] : []),
    ...signature.split('\n'),
    'Ran:',
    ...(ran ?? ['  - npm run verify → pass']),
    'Not run:  - smoke — host code unchanged',
  ].join('\n')
}

const comment = (body, at = '2026-10-25T08:00:00Z', login = 'Birfy') => ({ login, type: 'User', body, at, kind: 'comment', association: 'COLLABORATOR' })
const judge = (reports, { signers = loaded(), policy: p = policy, head = HEAD, pr = PR } = {}) => decide({ head, author: 'Birfy', reports, policy: p, repo: REPO, pr, signers, owners: ['Dev3'] })

test('a signed PASS by a listed reviewer counts, and the signature covers the full head', () => {
  const r = judge([comment(signed())])
  assert.equal(r.ok, true)
  assert.equal(r.by, 'Birfy')
  assert.deepEqual(r.unverified, [])
})

test('#1148 + #1110: a correctly signed report from the author login still needs the attestation', () => {
  // The signature verifies, so the report is not unverified: the refusal is the attestation one, which is
  // the proof that the two rules were kept apart instead of one replacing the other.
  const r = judge([comment(signed({ attest: false }))])
  assert.equal(r.ok, false)
  assert.match(r.reason, /not an attestation/)
  assert.deepEqual(r.unverified, [])
})

test('a report with no Signed-by line is not a conclusion: it neither passes nor joins the newest-wins scan', () => {
  const r = judge([comment(lines().join('\n'))])
  assert.equal(r.ok, false)
  assert.match(r.reason, /no Verifier report names the tip/)
  assert.equal(r.unverified.length, 1)
  assert.match(r.unverified[0].why, /no Signed-by line/)
})

test('a PASS with a Signed-by line but no Signature line is unverified', () => {
  const body = [...lines(), 'Signed-by: Reviewer', 'Nonce: n1'].join('\n')
  const r = judge([comment(body)])
  assert.equal(r.ok, false)
  assert.match(r.unverified[0].why, /no Signature line/)
})

test('a signature made with another workstation\'s private key does not count', () => {
  // Claims Reviewer, signed with Reviewer2's key: the workstation is inside the signed string, so the
  // Reviewer public key cannot verify it.
  const r = judge([comment(signed({ workstation: 'Reviewer', key: REVIEWER2.privateKey }))])
  assert.equal(r.ok, false)
  assert.match(r.unverified[0].why, /does not verify for Reviewer/)
})

test('Signed-by must name the same workstation as Written-by', () => {
  const body = [...lines(), ...signVerdict({ repo: REPO, pr: PR, verdict: 'PASS', head: HEAD, workstation: 'Reviewer2', key: REVIEWER2.privateKey, nonce: 'n2' }).lines.split('\n')].join('\n')
  const r = judge([comment(body)])
  assert.equal(r.ok, false)
  assert.match(r.unverified[0].why, /Signed-by names Reviewer2, but Written-by names Reviewer/)
})

test('Signed-by naming a workstation with no public key is unverified, and says who may sign', () => {
  const body = [...lines({ writer: 'Reviewer3' }), 'Signed-by: Reviewer3', 'Nonce: n3', 'Signature: AAAA'].join('\n')
  const r = judge([comment(body)])
  assert.equal(r.ok, false)
  assert.match(r.unverified[0].why, /has no public key in \.github\/agent\/signers\.json/)
  assert.match(r.unverified[0].why, /Reviewer, Reviewer2/)
})

test('replay onto another tip: a signature over the previous head does not verify at the new one', () => {
  const body = [...lines({ tip: HEAD }), ...signVerdict({ repo: REPO, pr: PR, verdict: 'PASS', head: OLD, workstation: 'Reviewer', key: REVIEWER.privateKey, nonce: 'n4' }).lines.split('\n')].join('\n')
  const r = judge([comment(body)])
  assert.equal(r.ok, false)
  assert.match(r.unverified[0].why, /does not verify/)
})

test('replay with another nonce: editing the Nonce line breaks the signature', () => {
  const body = signed({ nonce: 'n5' }).replace('Nonce: n5', 'Nonce: n6')
  const r = judge([comment(body)])
  assert.equal(r.ok, false)
  assert.match(r.unverified[0].why, /does not verify/)
})

test('an INC is governed the same way: unsigned, it no longer holds an earlier signed PASS', () => {
  const r = judge([
    comment(signed({ nonce: 'p1', at: 1 }), '2026-10-25T08:00:00Z'),
    comment(lines({ verdict: 'INC' }).join('\n'), '2026-10-25T08:05:00Z'),
  ])
  assert.equal(r.ok, true, 'the unsigned INC is not a conclusion, so it cannot veto')
  assert.equal(r.unverified.length, 1)
})

test('a signed INC still refuses, and it is the newest word that decides', () => {
  const r = judge([
    comment(signed({ nonce: 'p2' }), '2026-10-25T08:00:00Z'),
    comment(signed({ verdict: 'INC', nonce: 'p3' }), '2026-10-25T08:05:00Z'),
  ])
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'INC')
  assert.match(r.reason, /says INC at this tip/)
})

test('configuration error: the policy lists workstations and the signers file is missing', () => {
  const signers = loadSigners({ policy, path: '.github/agent/signers.json', read: () => { const e = new Error('no such file'); e.code = 'ENOENT'; throw e } })
  const r = judge([comment(signed())], { signers })
  assert.equal(r.ok, false)
  assert.match(r.reason, /is missing while \.github\/agent\/review-policy\.json lists 2 signing workstation/)
})

test('configuration error: a listed workstation has no public key', () => {
  const signers = loadSigners({ policy, path: 'signers.json', read: signersFile({ Reviewer: REVIEWER.der }) })
  assert.match(signers.error, /Reviewer2 has no public key/)
  const r = judge([comment(signed())], { signers })
  assert.equal(r.ok, false)
  assert.match(r.reason, /not a usable signers file/)
})

test('configuration error: a policy with a roster is never read without its keys', () => {
  const r = decide({ head: HEAD, author: 'Birfy', reports: [comment(signed())], policy, repo: REPO, pr: PR })
  assert.equal(r.ok, false)
  assert.match(r.reason, /was not loaded/)
})

test('a signature is not a permission: a valid signature from a login outside reviewers still refuses', () => {
  const r = judge([comment(signed({ nonce: 'n7' }), '2026-10-25T08:00:00Z', 'someone-else')])
  assert.equal(r.ok, false)
  assert.match(r.reason, /not a reviewer listed/)
})

test('a bot account writes no conclusion even with a valid signature (#943 survives #1110)', () => {
  const body = signed({ nonce: 'n8' })
  const r = judge([{ login: 'Birfy', type: 'Bot', body, at: '2026-10-25T08:00:00Z', kind: 'comment', association: 'COLLABORATOR' }])
  assert.equal(r.ok, false)
  assert.match(r.reason, /written by a bot account/)
})

test('the signature lines are read from the header only: a quoted signed block below does not sign the text above', () => {
  const quoted = signed({ nonce: 'n9' }).split('\n').slice(-3)
  const body = [...lines(), 'Signed-by: nobody', '', 'Earlier report quoted for context:', '', 'Prose.', '', 'Numbers.', '', ...quoted].join('\n')
  const signature = parseSignature(body)
  assert.equal(signature.signedBy, 'nobody')
  assert.equal(signature.signature, null)
  const r = judge([comment(body)])
  assert.equal(r.ok, false)
  assert.match(r.unverified[0].why, /no Signature line/)
})

test('the summary marks an unverified report as unverified', () => {
  const r = judge([comment(lines().join('\n'))])
  const text = render(r, { pr: PR, head: HEAD, author: 'Birfy' })
  assert.match(text, /Unverified — not read as conclusions:/)
  assert.match(text, /- unverified: Birfy \(comment\): PASS at 2a09e5fe/)
})

test('the canonical string names every field that stops a replay', () => {
  // The repository is lower-cased into the signed string, so a report cannot move by spelling.
  assert.equal(canonical({ repo: 'ThinkFlowLab/FlyBot', pr: 1132, verdict: 'pass', sha: HEAD, workstation: 'Reviewer', nonce: 'n' }),
    `FBV1|thinkflowlab/flybot#1132@PASS@${HEAD}@Reviewer@n`)
  assert.throws(() => canonical({ repo: REPO, pr: PR, verdict: 'PASS', sha: HEAD.slice(0, 8), workstation: 'Reviewer', nonce: 'n' }), /full 40-character sha/)
  assert.throws(() => canonical({ repo: REPO, pr: PR, verdict: 'PASS', sha: HEAD, workstation: 'Reviewer', nonce: '' }), /nonce/)
})

test('the signer round-trips: what sign-verdict.mjs prints is what the gate verifies', () => {
  const printed = signVerdict({ repo: REPO, pr: PR, verdict: 'PASS', head: HEAD, workstation: 'Reviewer', key: REVIEWER.privateKey, nonce: 'abc123' })
  assert.equal(printed.data, `FBV1|thinkflowlab/flybot#1132@PASS@${HEAD}@Reviewer@abc123`)
  // Where the workstation writes them: under the conclusion, inside the header, with the attestation the
  // shared author login needs as well (#1148).
  const body = [`Verdict: PASS at ${HEAD}`, 'Written-by: Reviewer', `Attestation: ${HEAD} role=Reviewer`, ...printed.lines.split('\n'), 'Ran:', '  - npm run verify → pass', 'Not run:  - smoke — host code unchanged'].join('\n')
  const r = judge([comment(body)])
  assert.equal(r.ok, true)
})

test('the signer refuses a workstation with no key and never echoes a key', () => {
  assert.equal(keyEnv('Reviewer2'), 'DSH_SECRET_VERDICT_KEY_REVIEWER2')
  assert.throws(() => readKey({ workstation: 'Reviewer', env: {} }), /set DSH_SECRET_VERDICT_KEY_REVIEWER in the workstation's own secret card/)
})

// The shipped pair: once `review-policy.json` lists signing workstations, the file in the repository must
// carry a usable key for every one of them, or every pull request is refused. This test is the reason a
// forgotten key is caught here rather than by a wedged queue.
test('the repository\'s own policy and signers file agree', () => {
  const shipped = loadPolicy(fileURLToPath(new URL('../agent/review-policy.json', import.meta.url)))
  const signers = loadSigners({ policy: shipped, path: fileURLToPath(new URL('../agent/signers.json', import.meta.url)) })
  assert.equal(signers.error, null)
  assert.deepEqual([...signers.keys.keys()], shipped.signers ?? [])
})

// The four instances from #1110, verbatim conclusion lines. Signed by nobody, so unverified — this is the
// shape the gate used to read as a PASS from the Reviewer.
const INSTANCES = [
  { pr: 1094, head: '2868d5761613f1304bfb4826e082f37fb357607f', body: 'Verdict: PASS at 2868d5761613f1304bfb4826e082f37fb357607f\nWritten-by: Reviewer\n\nFixes #1088. Rebased onto main with #1078.\n\nRan:\n- `TZ=UTC npm run verify` → pass at tip\n- CI tests-ok → SUCCESS' },
  { pr: 1095, head: '370019d466de29ebbcbcdb644c82b74e88266e06', body: 'Verdict: PASS at 370019d466de29ebbcbcdb644c82b74e88266e06\nWritten-by: Reviewer\n\nFixes #1087. Rebased tip: friend DM shows Waiting for their approval.\n\nRan:\n- `TZ=UTC npm run verify` → pass at tip\n- CI tests-ok → SUCCESS' },
  { pr: 1108, head: '7799db990423ab2784253e3ae643c5c3d92cba9a', body: 'Verdict: PASS at 7799db990423ab2784253e3ae643c5c3d92cba9a\nWritten-by: Reviewer\n\nFixes #1102. Rebased onto main 506e656 after #1105.\n\nRan:\n- `TZ=UTC npm run verify` → pass (core 1445, suites fail 0)\n- Fail-without-change: focused tests failed 4/10 without the change, 10/10 with it' },
  { pr: 1115, head: '83e41117e7139f5bcf585131ec03847005ffe31a', body: 'Verdict: PASS at 83e41117e7139f5bcf585131ec03847005ffe31a\nWritten-by: Reviewer\n\nRan:\n  - git fetch origin main && git rev-parse HEAD && git diff origin/main...HEAD --stat → tip 83e41117e7139f5bcf585131ec03847005ffe31a\n  - GH_REPO=ThinkFlowLab/FlyBot node .github/scripts/risk-gate.mjs --pr 1115 → risk-tier: T3' },
]

for (const instance of INSTANCES) {
  test(`#${instance.pr}'s impersonated PASS reads as unverified, never as a conclusion`, () => {
    const r = decide({ head: instance.head, author: 'Birfy', reports: [comment(instance.body)], policy, repo: REPO, pr: instance.pr, signers: loaded() })
    assert.equal(r.ok, false)
    assert.equal(r.unverified.length, 1)
    assert.match(r.unverified[0].why, /no Signed-by line/)
  })
}
