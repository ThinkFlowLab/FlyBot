// A `Verdict:` counts only when the workstation that claims to have written it signed it (#1110).
//
// Every Bot writes through the one shared `Birfy` account, so `Written-by: Reviewer` is a claim and
// nothing more: a Bot, an agent, or a person on that account can write a PASS in a Reviewer's name and
// the gate reads it as a conclusion (`#1094`, `#1095`, `#1108`, `#1115` on main). This closes that door
// without asking the owner for a second GitHub identity per workstation: each reviewing workstation
// holds one Ed25519 private key, its public key sits in `.github/agent/signers.json` in this repository,
// and the gate verifies the signature offline — an attacker with the repository, the account and every
// workflow secret still cannot sign for a workstation it has no private key for.
//
// What a signed conclusion carries, under its `Verdict:` and `Written-by:` lines:
//
//   Signed-by: Reviewer
//   Nonce: 3f8c1a9e5b2d4706
//   Signature: <base64url Ed25519 signature>
//
// The signed string is `canonical()` below:
//
//   FBV1|<owner>/<repo>#<pr>@<VERDICT>@<full 40-char head>@<workstation>@<nonce>
//
// Every field in it closes one replay: the repository and pull request number stop a report moving to
// another pull request, exactly 40 characters of sha stop it moving to another tip (a 7-character sha
// is a prefix of many heads, #1112), the verdict stops an INC being replayed as a PASS, the workstation
// stops one workstation's signature being read as another's, and the nonce stops the same signed text
// being reused as a second conclusion. A short sha in the `Verdict:` line is *not* signed: the gate
// fills in the head it is judging, so a signature can never be lifted onto a tip its author did not see.
//
// Fail closed, one cut (owner decision 2026-10-25, #1110): when `.github/agent/review-policy.json` lists
// signing workstations, a `Verdict:` whose signature does not verify is not a conclusion at all — it
// does not pass, it does not vote in the newest-wins scan, and it does not refuse an older PASS. The
// summary lists it as unverified. There is no unsigned fallback: the honest cost is that an unsigned INC
// no longer holds a merge either, which is why the keys land before the gate does (#1111).
import { readFileSync } from 'node:fs'
import { createPublicKey, sign, verify } from 'node:crypto'

export const PREFIX = 'FBV1'
export const SIGNERS_PATH = '.github/agent/signers.json'
export const POLICY_PATH = '.github/agent/review-policy.json'
// The signature lines sit directly under the conclusion, so they are read from the header only: a body
// that quotes an older signed report further down must not lend that signature to the text above it.
const HEADER_LINES = 8
const FULL_SHA = /^[0-9a-f]{40}$/

// The one string a workstation signs. `sha` must be the full head: a short sha is exactly the value a
// replay can move between tips, so a signature over one is refused rather than silently widened.
export function canonical({ repo, pr, verdict, sha, workstation, nonce }) {
  const full = String(sha ?? '').toLowerCase()
  if (!FULL_SHA.test(full)) throw new Error(`the signed head must be the full 40-character sha, not "${sha}"`)
  const number = String(pr ?? '').trim()
  if (!/^\d+$/.test(number)) throw new Error(`the signed report must name a pull request number, not "${pr}"`)
  const name = String(workstation ?? '').trim()
  if (!name) throw new Error('the signed report must name the workstation that signed it')
  const once = String(nonce ?? '').trim()
  if (!once) throw new Error('the signed report must carry a nonce')
  return `${PREFIX}|${String(repo ?? '').toLowerCase()}#${number}@${String(verdict ?? '').toUpperCase()}@${full}@${name}@${once}`
}

// `Signed-by:`, `Nonce:` and `Signature:` as the report wrote them. Nothing here decides anything: a
// missing field is reported as missing, and `verifyReport` refuses it with the reason that names it.
export function parseSignature(body) {
  const out = { signedBy: null, nonce: null, signature: null }
  let seen = 0
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.replace(/[*`]/g, '').trim()
    if (!line) continue
    if (++seen > HEADER_LINES) break
    let match
    if (!out.signedBy && (match = /^Signed-by\s*:\s*(.+)$/i.exec(line))) {
      // The first clause is the name, the way `Written-by:` reads: `Reviewer. Key B.` names Reviewer.
      out.signedBy = match[1].split(/[.,(;]/)[0].trim() || null
    }
    if (!out.nonce && (match = /^Nonce\s*:\s*(\S+)\s*$/i.exec(line))) out.nonce = match[1]
    if (!out.signature && (match = /^Signature\s*:\s*(\S+)\s*$/i.exec(line))) out.signature = match[1]
  }
  return out
}

// The signers file, loaded against the policy's roster. `required` is every workstation the policy says
// may sign; `keys` maps a workstation name to its parsed public key. A roster without a usable key for
// one of them is a configuration error, not a reason to skip that workstation: the file is the gate's
// trust anchor, and a gate that cannot load it refuses every pull request.
export function loadSigners({ policy, path = SIGNERS_PATH, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const required = Array.isArray(policy?.signers) ? policy.signers.map((name) => String(name).trim()).filter(Boolean) : []
  if (!required.length) return { required: [], keys: new Map(), error: null }
  let table
  try {
    table = JSON.parse(read(path))
  } catch (error) {
    const why = error?.code === 'ENOENT' ? 'is missing' : `cannot be read (${error.message})`
    return {
      required,
      keys: new Map(),
      error: `${path} ${why} while ${POLICY_PATH} lists ${required.length} signing workstation(s) (${required.join(', ')}): a verdict gate that cannot load its keys refuses every pull request`,
    }
  }
  const keys = new Map()
  const problems = []
  for (const name of required) {
    const value = table?.signers?.[name]
    if (!value) {
      problems.push(`${name} has no public key`)
      continue
    }
    try {
      keys.set(name, createPublicKey({ key: Buffer.from(String(value), 'base64url'), format: 'der', type: 'spki' }))
    } catch (error) {
      problems.push(`${name}'s public key is not a base64url DER SPKI (${error.message})`)
    }
  }
  if (problems.length) {
    return { required, keys, error: `${path} is not a usable signers file: ${problems.join('; ')}. Mint one Ed25519 key per workstation (#1111) and store the base64url of "openssl pkey -pubout -outform DER" there` }
  }
  return { required, keys, error: null }
}

// One report's signature, checked against the head being judged. `head` — never the short sha in the
// report's own text — is what the signature has to name, so a signed report verifies at exactly one tip.
export function verifyReport({ repo, pr, head, verdict, writer, body, signers } = {}) {
  const signature = parseSignature(body)
  if (!signature.signedBy) return { ok: false, reason: 'no Signed-by line naming the workstation that signed it' }
  if (!signature.signature) return { ok: false, reason: `Signed-by names ${signature.signedBy}, but the report carries no Signature line` }
  if (!signature.nonce) return { ok: false, reason: `Signed-by names ${signature.signedBy}, but the report carries no Nonce line, so the same signature could stand in for a second conclusion` }
  if (writer && signature.signedBy.toLowerCase() !== String(writer).trim().toLowerCase()) {
    return { ok: false, reason: `Signed-by names ${signature.signedBy}, but Written-by names ${writer}` }
  }
  const key = signers?.keys?.get(signature.signedBy)
  if (!key) {
    const listed = signers?.required?.length ? `; the signing workstations are ${signers.required.join(', ')}` : ''
    return { ok: false, reason: `Signed-by names "${signature.signedBy}", which has no public key in ${SIGNERS_PATH}${listed}` }
  }
  const data = canonical({ repo, pr, verdict, sha: head, workstation: signature.signedBy, nonce: signature.nonce })
  let ok = false
  try {
    ok = verify(null, Buffer.from(data, 'utf8'), key, Buffer.from(signature.signature, 'base64url'))
  } catch {
    ok = false
  }
  if (!ok) return { ok: false, reason: `the Signature does not verify for ${signature.signedBy} over \`${data}\`` }
  return { ok: true, workstation: signature.signedBy, signed: data }
}

// The three lines a workstation adds to its report. Kept here (one implementation) so the signer script,
// the tests and any other writer cannot disagree about the string or the line names.
export function signatureLines({ repo, pr, verdict, head, workstation, nonce, privateKey }) {
  const data = canonical({ repo, pr, verdict, sha: head, workstation, nonce })
  const signature = sign(null, Buffer.from(data, 'utf8'), privateKey).toString('base64url')
  return [`Signed-by: ${workstation}`, `Nonce: ${nonce}`, `Signature: ${signature}`].join('\n')
}
