// The three lines a reviewing workstation adds to its conclusion (#1110).
//
//   DSH_SECRET_VERDICT_KEY_REVIEWER="$(cat reviewer-key.pem)" \
//     node .github/scripts/sign-verdict.mjs --repo ThinkFlowLab/FlyBot --pr 1132 --verdict PASS \
//       --workstation Reviewer --head <full 40-character head>
//
// It prints the canonical string it signed and the three lines to paste under the conclusion:
//
//   Signed-by: Reviewer
//   Nonce: <16 hex characters, one per report>
//   Signature: <base64url>
//
// The key comes from the workstation's own secret — `DSH_SECRET_VERDICT_KEY_<WORKSTATION>` by default,
// or `--key-file <path>` for a hand run — and is never printed, echoed or written. The head must be the
// full 40 characters: a short sha is a prefix of many heads, and the signature has to name exactly one
// tip (#1112). `--repo` and `--pr` default to the workflow's `GH_REPO`/`PR`, so a Bot signs the pull
// request it is judging unless it says otherwise.
import { createPrivateKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { canonical, signatureLines } from './verdict-signature.mjs'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

export function keyEnv(workstation) {
  return `DSH_SECRET_VERDICT_KEY_${String(workstation ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

// The PEM (or the DER PKCS8, base64url) of one workstation's private key, from its own secret or a file.
export function readKey({ workstation, keyFile, env = process.env } = {}) {
  const text = keyFile ? readFileSync(keyFile, 'utf8') : env[keyEnv(workstation)]
  if (!text?.trim()) {
    throw new Error(`no private key for ${workstation}: set ${keyEnv(workstation)} in the workstation's own secret card, or pass --key-file`)
  }
  const value = text.trim()
  try {
    return createPrivateKey({ key: /-----BEGIN/.test(value) ? value : Buffer.from(value, 'base64url'), format: /-----BEGIN/.test(value) ? undefined : 'der', type: /-----BEGIN/.test(value) ? undefined : 'pkcs8' })
  } catch (error) {
    throw new Error(`that is not an Ed25519 private key (${error.message}); the key stays where it is, this script never prints it`)
  }
}

export function sign({ repo, pr, verdict, head, workstation, key, nonce = randomBytes(8).toString('hex') } = {}) {
  const data = canonical({ repo, pr, verdict, sha: head, workstation, nonce })
  return { data, lines: signatureLines({ repo, pr, verdict, head, workstation, nonce, privateKey: key }) }
}

function main() {
  const workstation = arg('--workstation') || arg('--signed-by')
  if (!workstation) throw new Error('pass --workstation <Reviewer|Reviewer2|…>')
  const repo = arg('--repo') || process.env.GH_REPO
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const pr = arg('--pr') || process.env.PR
  if (!pr) throw new Error('set PR or pass --pr N')
  const verdict = arg('--verdict')
  if (!verdict) throw new Error('pass --verdict PASS|INC')
  const head = arg('--head') || arg('--sha')
  if (!head) throw new Error('pass --head <full 40-character head>')
  const key = readKey({ workstation, keyFile: arg('--key-file') })
  const signed = sign({ repo, pr, verdict, head, workstation, key })
  console.log(`sign-verdict: ${workstation} signs ${signed.data}`)
  console.log('')
  console.log(signed.lines)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`sign-verdict: ${error.message}`)
    process.exit(1)
  }
}
