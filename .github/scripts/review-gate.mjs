// The reviewed tip of a pull request (Phase 1: report only; see docs/autonomous-dev.md).
//
//   PR=12 GH_REPO=owner/repo GH_TOKEN=... node review-gate.mjs    # what the workflow runs
//   node review-gate.mjs --pr 12 [--repo owner/repo]              # by hand
//   node review-gate.mjs --pr 12 --sha <head>                     # judge another tip
//
// It answers one question: does this pull request's current head carry a Verifier PASS?
// `decide` is the whole rule:
//   - the report is a pull request comment or a review body by a login listed in
//     .github/agent/review-policy.json's `reviewers` (the file the base branch holds);
//   - it is not the pull request author's own report, unless the author is listed in the policy's
//     `selfReview` (owner decision 2026-10-19: the owner's Bot/agent, acting as Birfy, may PASS
//     its own pull requests; any other author still needs someone else);
//   - when that login is the pull request author, `selfReview` is not the review (#644, option B,
//     first slice). The header must also carry `Attestation: <40-character sha> role=<Bot>`: the sha
//     is the whole tip, the role is the `Written-by` name, and that role is not an Owner of the pull
//     request. A comment with no such line is the author's own identity, and it does not count. A
//     conclusion from a different GitHub login is unchanged. The line is parsed, not signed;
//   - the login is tied to this repository (#676, #925): `author_association` is OWNER, MEMBER or
//     COLLABORATOR, the login is this pull request's own author listed in `selfReview`, or
//     `adminsFor` found repo admin. A CONTRIBUTOR who is none of those is not a conclusion;
//   - it carries the Verifier block review-pr already writes, with a `Tip SHA:` that is the
//     head being judged and a `Verdict:`;
//   - it names its writer in the header: `Written-by: <Bot>` (the older prose `Written by: …` reads
//     the same way) with a name from the policy's `writers`, or it refuses — a missing line and an
//     unknown name are separate refusals (#627);
//   - the verdict is PASS and the report lists a command it `Ran:` (a `- ` bullet, or a `$ ` line in a
//     fenced block under a `Ran …:` heading): a report that ran nothing is not evidence.
//   - `Not run:` is recommended but not checked (owner decision 2026-10-22 09:57 Asia/Shanghai, #667):
//     `hasNotRun` is still parsed for the summary, and a PASS without it is not refused.
// The newest qualifying report that names this tip decides, so a later FAIL at the same tip
// vetoes an earlier PASS. A tip that moves past the report is not reviewed: the report names
// the whole 40-character sha (#1112), so an older head stops counting — unless the tip moved
// without changing the change set (#1317): when no report names the head itself, a report whose
// `(path → blob sha)` fingerprint at the pull request's changed paths is identical at both tips
// still describes this head, and `change-set.mjs` answers that. It fails closed, so an unreadable
// tree or a changed blob is the same refusal as before.
//
// #1335: a PASS can be withdrawn, and until this both gates read the withdrawal as ordinary prose. A
// body that opens `Correction from <Bot>: the PASS at <sha> is withdrawn` carries no `Verdict:` line,
// so `parseReport` reported no conclusion, `decide` never put it in the newest-wins scan and an earlier
// PASS stayed the newest word — which is how #1325 read as "passed, ready to enqueue" after its own
// reviewer had withdrawn it. The correction is a conclusion line now, read from the header like a
// `Verdict:` header and carrying the tip it withdraws, so it joins that one scan instead of becoming a
// second reader of the same text. The refusal says `the PASS at <sha> was withdrawn by <Bot>`. It
// counts only from the Bot that wrote the PASS it withdraws, or from a `reviewers` login: otherwise
// anyone with write access could freeze a healthy pull request with one sentence.
//
// The pull request is read only through the GitHub API; no PR code is checked out or run.
import { readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SIGNERS_PATH, loadSigners, verifyReport } from './verdict-signature.mjs'
import { sameChangeSet as sameChangeSetOf } from './change-set.mjs'

const SHORT = 12
// #676: a conclusion is read only from someone GitHub ties to this repository. The fail-closed rule
// above makes any newest conclusion refuse, so without this an outside comment saying `Verdict: INC`
// could hold a merge. A comment from anyone else is not a conclusion: it can neither pass nor block.
const ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
// #1239: the four words a `Verdict:` line may carry. Nothing else is read, and a fifth word is named
// in the refusal rather than added as an alias — an alias would leave "how many words do we read" a guess.
const VERDICT_TOKENS = new Set(['PASS', 'FAIL', 'INC', 'REQUEST_CHANGES'])

// A conclusion GitHub did not already tie to the repo (OWNER/MEMBER/COLLABORATOR), from a login
// in `reviewers`, asked once via the collaborator permission API. Anyone else can never pass the
// reviewers check, so they are not looked up. A `selfReview` login is already qualified on its own
// pull request (#928), so only that shape is skipped; on anyone else's pull request the permission
// API is the one thing that can qualify it. Skipping every `selfReview` login left this rule dead —
// today every reviewer is also in `selfReview`. A comment with no Tip SHA and Verdict is not a
// conclusion. Metadata read on the token
// the job already has. Fail closed: no repo, no `gh`, a 403/404, or a body that is not
// the permission object is not admin. `permission: admin` or `permissions.admin` counts.
export function adminsFor({ gh, repo, reports, policy, author } = {}) {
  if (!repo || typeof gh !== 'function') return []
  const selfReview = new Set((policy?.selfReview ?? []).map((l) => String(l).toLowerCase()))
  const reviewers = new Set((policy?.reviewers ?? []).map((l) => String(l).toLowerCase()))
  const authorLogin = String(author ?? '').toLowerCase()
  const admins = []
  const seen = new Set()
  for (const r of reports ?? []) {
    if (ASSOCIATIONS.has(String(r.association ?? '').toUpperCase())) continue
    const name = String(r.login ?? '').trim()
    const key = name.toLowerCase()
    if (!name || !reviewers.has(key)) continue
    if (selfReview.has(key) && key === authorLogin) continue
    const parsed = parseReport(r.body)
    if (!parsed.tip || !parsed.verdict) continue
    if (seen.has(key)) continue
    seen.add(key)
    let text
    try {
      text = gh('api', `repos/${repo}/collaborators/${encodeURIComponent(name)}/permission`)
    } catch {
      // Fail closed. A 403 or 404 is not admin.
      continue
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      // A body that is not the permission object is not admin.
      continue
    }
    if (String(data?.permission ?? '').toLowerCase() === 'admin' || data?.permissions?.admin === true) admins.push(name)
  }
  return admins
}

// #1335: `Correction from <Bot>: the PASS at <sha> is withdrawn` — the one other conclusion header.
// The name and the tip are read here, and nothing is decided: whether that name may withdraw that PASS
// is `decide`'s identity rule, because only it sees every report at the tip. Markdown emphasis is
// already stripped from the line by the caller, so the real body (`the PASS at `<sha>` is **withdrawn**`)
// reads the same as a plain one. A `Correction from …:` line that names no tip, or never says
// `withdrawn`, is ordinary prose — a correction that agrees with something is not a conclusion.
const CORRECTION_HEADER = /^Correction\s+from\s+([^:]{1,64}?)\s*:\s*(.+)$/i
const CORRECTION_TIP = /the PASS at\s+([0-9a-f]{7,40})\b/i
const CORRECTION_WORD = /\bwithdrawn\b/i
function parseCorrection(line) {
  const header = CORRECTION_HEADER.exec(String(line ?? '').trim())
  if (!header) return null
  const by = header[1].trim()
  const tip = CORRECTION_TIP.exec(header[2])
  if (!by || !tip || !CORRECTION_WORD.test(header[2])) return null
  return { by, tip: tip[1].toLowerCase() }
}

// The last Verifier block in one body: a comment may hold an earlier review that a later
// one replaced, and only the last block is the verdict the reviewer stands behind.
export function parseReport(body) {
  // `raw` keeps the backticks so a fenced block can be found; `lines` is the same text without the
  // markdown emphasis, line for line, for everything else.
  const raw = String(body ?? '').split('\n')
  const lines = raw.map((line) => line.replace(/[*`]/g, ''))
  const out = { tip: null, verdict: null, unknownVerdict: null, withdraw: null, ran: [], hasNotRun: false, writer: null, attestation: null }
  // The fixed format (#637): the first non-empty line is the whole conclusion,
  // `Verdict: PASS at <sha>` (or INC / REQUEST_CHANGES). The attribution line and the evidence go
  // below it, so a verdict Chief posts for a Reviewer with no write channel parses the same way.
  const firstLine = lines.find((line) => line.trim() !== '') ?? ''
  const first = /^Verdict\s*:\s*(PASS|INC|REQUEST_CHANGES|FAIL)\s+(?:at\s+)?([0-9a-f]{7,40})\s*$/i.exec(firstLine.trim())
  // #1239: the same header with a word the gate does not read. The `\b` above cannot match `Incorrect`
  // (`INC` is followed by a letter, not a word boundary), so before this the whole line was not a
  // conclusion at all: the PASS it meant to withdraw stayed the newest word and the merge went ahead.
  // The tip is read here too, which is what makes it a conclusion at that tip rather than a stray
  // sentence — a word with no tip below is still an ordinary comment.
  const firstUnknown = first ? null : /^Verdict\s*:\s*(\S+?)\s+(?:at\s+)?([0-9a-f]{7,40})\s*$/i.exec(firstLine.trim())
  // #1335: `Correction from <Bot>: the PASS at <sha> is withdrawn` is the other conclusion header.
  const firstCorrection = first || firstUnknown ? null : parseCorrection(firstLine)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^Tip SHA\s*:/i.test(lines[i].trim())) start = i
  }
  if (first) {
    out.verdict = first[1].toUpperCase()
    out.tip = first[2].toLowerCase()
  } else if (firstUnknown) {
    out.unknownVerdict = firstUnknown[1]
    out.tip = firstUnknown[2].toLowerCase()
  } else if (firstCorrection) {
    out.withdraw = firstCorrection
    out.tip = firstCorrection.tip
  }
  // #643, #640: once the first line is the conclusion, the loop below must write neither field again.
  // A body quotes older reports (a `Tip SHA: <sha>` block with an older `Verdict: PASS`), and letting
  // either field through turned an INC at this tip into a PASS, or into a conclusion about some other
  // tip that `decide` then dropped while the PASS it refused came back to life. Both fail open.
  let ranSeen = false
  // An unreadable first-line conclusion is still the header: the quote rules below keep a later block
  // from overwriting the first one (#643, #640), and they protect this one the same way. A correction
  // header is protected the same way — the `Correction` body quotes the `Verdict: PASS` it withdraws.
  const firstIsVerdict = first !== null || firstUnknown !== null || firstCorrection !== null
  // With the first line as the conclusion the evidence is below it, so scan from the top; a
  // legacy body is judged by its last block.
  const from = firstIsVerdict || start < 0 ? 0 : start
  for (let i = from; i < lines.length; i++) {
    const line = lines[i].trim()
    const tipLine = /^Tip SHA\s*:\s*(.+)$/i.exec(line)
    if (tipLine && !firstIsVerdict) {
      const hex = /[0-9a-f]{7,40}/i.exec(tipLine[1])
      out.tip = hex ? hex[0].toLowerCase() : null
    }
    const verdictLine = /^Verdict\s*:\s*(PASS|FAIL|INC|REQUEST_CHANGES)\b/i.exec(line)
    if (verdictLine && !firstIsVerdict) out.verdict = verdictLine[1].toUpperCase()
    // #1239: the loop needs its own read. A `Tip SHA:` block whose `Verdict:` line says anything else is
    // the same defect as the first-line form; without this the block reads as "no verdict" and an older
    // PASS survives. A line that already gave a readable verdict is not read again for an unknown word.
    const unknownLine = verdictLine || firstIsVerdict ? null : /^Verdict\s*:\s*(\S+)/i.exec(line)
    if (unknownLine && !VERDICT_TOKENS.has(unknownLine[1].toUpperCase())) out.unknownVerdict = unknownLine[1]
    // `Ran: <command>`, or a heading such as `Ran at this tip (tarball of the tip):` — the shape the
    // reviewer actually writes (#660-#663: every one of those PASSes refused as "lists no command"
    // because only a bare `Ran:` was read). A longer heading is only a heading: words after its colon
    // are not a command, so prose like "Ran into a problem: …" proves nothing.
    const ranLine = /^Ran\b([^:\n]*):\s*(.*)$/i.exec(line)
    // With the first line as the conclusion, its own `Ran:` is the evidence; a quoted block's
    // `Ran:` below it must not replace it. Without one, the last block wins as it always has.
    if (ranLine && !(firstIsVerdict && ranSeen)) {
      ranSeen = true
      out.ran = ranCommands(raw, lines, i, ranLine[1].trim() === '' ? ranLine[2].trim() : '')
    }
    if (/^Not run\b[^:\n]*:/i.test(line)) out.hasNotRun = true
  }
  // #1239: a readable verdict is this report's word; an unreadable `Verdict:` line below it is quoted
  // text (the rule #643 and #640 keep a quote from overwriting the header), so it decides nothing here.
  if (out.verdict) out.unknownVerdict = null
  out.writer = parseWriter(lines)
  // #644: the attestation is part of the conclusion header, the lines before the first blank. A copy
  // quoted under `Ran:` sits after that blank and must not lend this report a marker it did not open with.
  out.attestation = attestationInHeader(lines)
  return out
}

// The header is the non-empty lines before the first blank, and never more than this many: a body with
// no blank line must not pick up an `Attestation:` buried in a quote. #1112: the sha is the whole tip,
// so 7–40 hex is parsed and a short one is refused later as "not the full tip", the same way a short
// `Verdict:` is.
const ATTEST_CAP = 8
const ATTEST_LINE = /^Attestation:\s*([0-9a-f]{7,40})\s+role=([A-Za-z][A-Za-z0-9-]*)\s*$/i
function attestationInHeader(lines) {
  let seen = 0
  for (const line of lines) {
    const text = line.trim()
    if (!text) {
      if (seen > 0) return null
      continue
    }
    if (++seen > ATTEST_CAP) return null
    if (!/^Attestation\s*:/i.test(text)) continue
    const m = ATTEST_LINE.exec(text)
    if (!m) return { malformed: true }
    return { sha: m[1].toLowerCase(), role: m[2] }
  }
  return null
}

// The same Owner line `enqueue-rules.mjs` reads, copied here because that module imports this one.
// First 20 lines, comma-separated, a leading `@` stripped. An absent line is an empty list, which is
// not the same as a caller that passed no body at all.
const OWNER_HEADER = 20
function ownerNames(body) {
  const lines = String(body ?? '').split(/\r?\n/).slice(0, OWNER_HEADER)
  const owner = lines.find((line) => /^\s*Owner:/i.test(line))
  if (!owner) return []
  return [...new Set(owner.replace(/^\s*Owner:/i, '').split(',').map((value) => value.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))]
}

// #644: why an author-login conclusion does not count, or null when the attestation is the one this
// tip can trust. `ownersKnown` is false when the caller passed neither a body nor an owner list —
// fail closed, because "no owners" would otherwise let the author name their own role.
function attestationRefusal({ parsed, headSha, owners, ownersKnown }) {
  const att = parsed.attestation
  if (!att) return 'the pull request author\'s own GitHub identity is not an attestation (no Attestation line binding this tip and a reviewer role)'
  if (att.malformed) return 'Attestation line is not `Attestation: <sha> role=<Bot>`'
  if (att.sha !== headSha) {
    return att.sha.length < 40
      ? `Attestation names ${att.sha.slice(0, SHORT)} (${att.sha.length} characters), not the full tip ${headSha} — an attestation names the whole 40-character sha`
      : `Attestation names ${att.sha.slice(0, SHORT)}, not the tip ${headSha.slice(0, SHORT)}`
  }
  if (att.role.toLowerCase() !== String(parsed.writer ?? '').toLowerCase()) {
    return `Attestation role "${att.role}" is not the Written-by name "${parsed.writer}"`
  }
  if (!ownersKnown) return 'no Owner list was supplied, so an author-login conclusion cannot be attested'
  if (owners.has(att.role.toLowerCase())) return `Attestation role "${att.role}" is the Owner of this pull request`
  return null
}

// #627: the attribution line, `Written-by: <Bot>` (the older prose `Written by: Reviewer. Posted by:
// …` reads the same way). Only the header is read — the first few non-empty lines — so a report that
// arrives without one does not borrow a writer from a block it quotes further down.
const HEADER_LINES = 3
function parseWriter(lines) {
  let seen = 0
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    if (++seen > HEADER_LINES) break
    const written = /^Written[- ]by\s*:\s*(.+)$/i.exec(text)
    // The first clause is the name: `Reviewer. Posted by: Chief (proxy…)` names Reviewer.
    if (written) return written[1].split(/[.,(;]/)[0].trim() || null
  }
  return null
}

// The commands under a `Ran` heading at line `at`: the inline text of a bare `Ran: <command>` (never
// an empty one or `-`), then either the `- ` bullets that follow, or the `$ ` lines of the fenced
// block that follows. Output lines in the block are not commands, so a block with no `$ ` line, or
// `$` alone, lists nothing and the PASS refuses as before.
function ranCommands(raw, lines, at, inline) {
  const ran = inline && inline !== '-' ? [inline] : []
  let j = at + 1
  // Blank in the raw text: a bare ``` fence line is empty once the backticks are stripped.
  while (j < raw.length && raw[j].trim() === '') j++
  if (j < raw.length && /^\s*(```|~~~)/.test(raw[j])) {
    const fence = /^\s*(```|~~~)/.exec(raw[j])[1]
    for (j += 1; j < raw.length && !raw[j].trim().startsWith(fence); j++) {
      const cmd = /^\$\s+(\S.*)$/.exec(raw[j].trim())
      if (cmd) ran.push(cmd[1].trim())
    }
    return ran
  }
  for (; j < lines.length; j++) {
    const next = lines[j].trim()
    if (/^[-•]\s*\S/.test(next) && next !== '-') ran.push(next)
    else break
  }
  return ran
}

const login = (r) => String(r.login ?? '').toLowerCase()
const where = (r) => `${r.kind === 'review' ? 'review' : 'comment'} by ${r.login}`
// #943: a GitHub bot account writes no conclusion, whatever its body says. `reviewers` cannot express
// this — every Bot writes as the shared `Birfy` account, which is a `User`, so a login list that refused
// bot accounts would void the whole pipeline — so the test is the account type, plus the login shape the
// API has always used for them (`cursor[bot]`). At #940's tip such a `Verdict:` sat beside the
// Reviewer's; what voids it is the real Reviewer's `Correction from Reviewer:`, not a second read here.
const isBotAccount = (r) => String(r.type ?? '').toLowerCase() === 'bot' || /\[bot\]$/i.test(login(r))
const botKind = (r) => (String(r.type ?? '').toLowerCase() === 'bot' ? 'account type Bot' : 'login ends with [bot]')

// #1110: what the policy asks of a signature, and the one refusal a broken configuration produces. The
// roster lives in the policy, the public keys live in `signers.json`, and both must be present together:
// half of that pair is not a reason to read unsigned reports, it is a reason to refuse every pull request
// until it is repaired.
function signingState({ policy, signers, pr }) {
  const roster = Array.isArray(policy?.signers) ? policy.signers.map((name) => String(name).trim()).filter(Boolean) : []
  if (!roster.length) return { enforced: false, error: null }
  if (!signers || signers.error === undefined) {
    return { enforced: false, error: `.github/agent/review-policy.json lists ${roster.length} signing workstation(s) (${roster.join(', ')}), but ${SIGNERS_PATH} was not loaded: the gate refuses rather than reading unsigned reports` }
  }
  if (signers.error) return { enforced: false, error: signers.error }
  if (!String(pr ?? '').trim()) {
    return { enforced: false, error: 'a signed verdict names the pull request number it belongs to, and this run asked about no pull request' }
  }
  return { enforced: true, required: roster, keys: signers.keys, error: null }
}

// reports: [{ login, body, at, kind, id }] from the comments and review bodies of one PR.
// `body` is the pull request body (live entry points pass it). `owners` is that list already parsed;
// either one makes the Owner check possible. Neither one refuses an author-login conclusion.
// `signers`: the loaded `.github/agent/signers.json` (`loadSigners`). When the policy's `signers` roster
// is non-empty every conclusion must verify against it (#1110); an unverified one is not a conclusion and
// never joins the newest-wins scan, so it can neither pass nor veto. `repo` and `pr` are signed into the
// report, so a signature cannot move to another pull request or another tip.
// #1317: `changedPaths` is the pull request's changed-file list, read by the caller (the guard and this
// script's own `main` both read it); `sameChangeSet` is the injected comparison, so a test drives it with
// a stub and no network. Both are optional: without the list there is nothing to compare, and the tip
// rule refuses exactly as it did before — the conservative answer.
export function decide({ head, author, reports, policy, admins, body, owners, repo, pr, signers, changedPaths, sameChangeSet = sameChangeSetOf, gh } = {}) {
  const headSha = String(head ?? '').toLowerCase()
  const authorLogin = String(author ?? '').toLowerCase()
  const ownersKnown = owners !== undefined || body !== undefined
  const ownerSet = new Set((owners !== undefined ? owners : ownersKnown ? ownerNames(body) : []).map((name) => String(name).toLowerCase()))
  const reviewers = new Set((policy?.reviewers ?? []).map((l) => String(l).toLowerCase()))
  const selfReview = new Set((policy?.selfReview ?? []).map((l) => String(l).toLowerCase()))
  const writers = new Set((policy?.writers ?? []).map((w) => String(w).toLowerCase()))
  const adminSet = new Set((admins ?? []).map((l) => String(l).toLowerCase()))
  const reasons = [] // reports that do not name this tip at all
  const judged = []
  const atTip = [] // conclusions that name this tip, valid or not, in the order the API returned them
  const unverified = [] // conclusions this tip carries whose signature does not verify: not read at all
  // #1110: the roster in `review-policy.json` is the switch. A roster with no loaded signers file, or a
  // file that cannot be read or is missing a workstation's key, is a configuration error — the gate
  // refuses rather than falling back to unsigned reports, which is the hole this closes.
  const signing = signingState({ policy, signers, pr })
  if (signing.error) return { ok: false, verdict: null, by: null, tip: null, reason: signing.error, judged, unverified }

  for (const r of reports ?? []) {
    const parsed = parseReport(r.body)
    if (!parsed.tip && !parsed.verdict && !parsed.unknownVerdict) continue // not a Verifier report
    const entry = { id: r.id, login: r.login, verdict: parsed.verdict, unknownVerdict: parsed.unknownVerdict, withdraw: parsed.withdraw, tip: parsed.tip, at: r.at, kind: r.kind, writer: parsed.writer, parsed, counts: false, why: null }
    judged.push(entry)
    if (!parsed.tip) { reasons.push(`${where(r)}: no Tip SHA`); continue }
    // #1112: the comparison is the whole sha, not a prefix. A conclusion written `at abaf938` is a
    // mention of one head among every head that starts that way, and one of them is the newest tip — the
    // guard went green at 05:09 on a PASS naming the tip that was PASSed at 05:12 because a short tip
    // matched it. A tip that is not 40 characters names no head here; the refusal says how long it was.
    if (parsed.tip !== headSha) {
      if (parsed.tip.length < 40) {
        reasons.push(`${where(r)}: names ${parsed.tip.slice(0, SHORT)} (${parsed.tip.length} characters), not the full tip ${headSha} — a conclusion names the whole 40-character sha`)
        continue
      }
      // #1317: a tip that moved without changing the reviewed change set keeps its conclusion. The
      // comparison is the caller's changed-path list against the trees at both tips, and it fails
      // closed: no list, an unreadable tree or one changed blob is the refusal this gate always gave,
      // with the reason named so a reader can tell "the code changed" from "I could not look".
      const moved = changedPaths && changedPaths.length
        ? sameChangeSet({ gh, repo, pr, reviewed: parsed.tip, head: headSha, paths: changedPaths })
        : { ok: false, read: 'the changed files of this pull request were not read' }
      if (!moved.ok) {
        const why = moved.path
          ? ` — the change set differs at ${moved.path}, so that conclusion does not describe this head`
          : ` — the change set could not be read (${moved.read})`
        reasons.push(`${where(r)}: names ${parsed.tip.slice(0, SHORT)}, not the tip ${headSha.slice(0, SHORT)}${why}`)
        continue
      }
      entry.carriedFrom = parsed.tip
    }
    // #1239: an unreadable word is not "no verdict" — it is a conclusion at this tip that nobody can
    // read, and the newest one has to be able to veto an older PASS. #1335: a correction is the same
    // shape — it carries no `Verdict:` word, but it names this tip's PASS and must reach the scan.
    if (!parsed.verdict && !parsed.unknownVerdict && !entry.withdraw) continue // a `Tip SHA` block with no verdict is not a conclusion
    // #943: refused before the association test, with its own reason: a bot account is not a
    // conclusion for a reason unlisted logins cannot explain, and the log has to say which defect fired.
    if (isBotAccount(r)) {
      entry.why = `${where(r)}: written by a bot account (${botKind(r)}), so it is not a conclusion`
      reasons.push(entry.why)
      continue
    }
    // #1110, before anything below can read it: a conclusion whose signature does not verify is not a
    // conclusion. It stays out of `atTip`, so it neither passes nor refuses an older PASS, and the summary
    // lists it as unverified. Reading it here — before the association, writer and reviewers checks — is
    // what makes the rule one cut rather than one more refusal stacked on the old path.
    // #1335: a correction signs no verdict — there is no `Verdict:` line to put in `canonical()` — and it
    // can only ever refuse, never pass, so the identity rule below is what keeps it honest.
    if (signing.enforced && !entry.withdraw) {
      const signed = verifyReport({ repo, pr, head: headSha, verdict: parsed.verdict, writer: parsed.writer, body: r.body, signers: signing })
      if (!signed.ok) {
        entry.why = `${where(r)}: unverified — ${signed.reason}`
        unverified.push(entry)
        continue
      }
      entry.workstation = signed.workstation
    }
    const association = String(r.association ?? '').toUpperCase()
    // #928 (owner decision 2026-10-24): a login the policy lists in `selfReview` may be a CONTRIBUTOR
    // and still count, but only on its own pull request. That is one exception for one person, not a
    // second reviewers list: the same login judging someone else's pull request keeps every rule
    // below, and #676 still refuses a login nobody listed.
    // #936 (#925): this gate also accepts a repository admin, the one fact the association stamp gets
    // wrong for this account. `admins` is what `adminsFor` resolved; it skips no check below.
    const selfOnly = selfReview.has(login(r)) && login(r) === authorLogin
    const isAdmin = adminSet.has(login(r))
    if (!ASSOCIATIONS.has(association) && !selfOnly && !isAdmin) {
      reasons.push(`${where(r)}: author association ${association || 'missing'} is not OWNER, MEMBER or COLLABORATOR, so it is not a conclusion`)
      continue
    }
    // #676: a conclusion at this tip belongs to the newest-word question even when it fails a check
    // below, so it joins `atTip` carrying its reason instead of being dropped. Dropping it made a
    // newer refusal invisible: an INC with no `Written-by:` line left an older PASS in force, and a
    // human REQUEST_CHANGES from an unlisted login did the same.
    atTip.push(entry)
    // #1335: a correction joins the scan the same way, and its identity rule is settled after the loop,
    // because only then is it known which PASSes this tip carries and who wrote them.
    if (entry.withdraw) continue
    // #1239: a word outside the four the gate reads counts for nothing, but it still takes its place in
    // the newest-word scan, carrying a reason that names it. Dropping the line is the defect: an INC the
    // reviewer meant became invisible and the older PASS it withdrew stayed in force on #1221.
    if (parsed.unknownVerdict) {
      entry.why = `${where(r)}: reads "${parsed.unknownVerdict}" as its verdict, which is not one of PASS, FAIL, INC or REQUEST_CHANGES, so this conclusion cannot be read`
      continue
    }
    // #627: a *conclusion* has to say who wrote it, refused on two separate grounds — a report with no
    // attribution line and one that names a writer the policy does not list are different defects, and
    // the log has to say which one fired. Both fail closed. An ordinary comment is not a conclusion, so
    // a missing line is not held against it. With one shared GitHub identity the line is a self-report,
    // so this buys presence and a name from a closed list, not proof (#633).
    if (!parsed.writer) { entry.why = `${where(r)}: no Written-by line naming its writer`; continue }
    if (!writers.has(parsed.writer.toLowerCase())) { entry.why = `${where(r)}: Written-by names "${parsed.writer}", who is not in the writers list of .github/agent/review-policy.json`; continue }
    if (login(r) === authorLogin && !selfReview.has(authorLogin)) { entry.why = `${where(r)}: the pull request's own author is not a reviewer (not in selfReview)`; continue }
    if (!reviewers.has(login(r))) { entry.why = `${where(r)}: not a reviewer listed in .github/agent/review-policy.json`; continue }
    // #644: `selfReview` lets the shared account PASS its own pull request. That comment is still the
    // author's GitHub identity. It counts only with an attestation the header binds to this tip and to
    // a reviewer role that is not the Owner. A different login never reaches this check.
    if (login(r) === authorLogin) {
      const why = attestationRefusal({ parsed, headSha, owners: ownerSet, ownersKnown })
      if (why) { entry.why = `${where(r)}: ${why}`; continue }
    }
    entry.counts = true
  }

  if (!reviewers.size) return { ok: false, verdict: null, by: null, tip: null, reason: 'no reviewer is listed in .github/agent/review-policy.json', judged, unverified }
  // #1335: a correction is a conclusion only from the Bot that wrote the PASS it withdraws, or from a
  // `reviewers` login. Without that, anyone with write access could freeze a healthy pull request with
  // one sentence — the withdrawal would be a veto with no signature behind it. Read here rather than in
  // the loop because the PASS it withdraws may be listed after it.
  // Only a PASS the gate actually counted can be withdrawn by its writer: an invalid PASS is already
  // refused on its own ground, so its `Written-by:` name must not become a licence to withdraw.
  const passWriters = new Set(
    atTip.filter((e) => e.verdict === 'PASS' && e.counts && e.writer).map((e) => String(e.writer).toLowerCase()),
  )
  const effective = []
  for (const e of atTip) {
    if (!e.withdraw) { effective.push(e); continue }
    const by = String(e.withdraw.by).toLowerCase()
    if (!passWriters.has(by) && !reviewers.has(by)) {
      e.why = `${where({ kind: e.kind, login: e.login })}: Correction from ${e.withdraw.by} withdraws a PASS it did not write, and that name is not a reviewer listed in .github/agent/review-policy.json, so it is not a conclusion`
      continue
    }
    e.why = `${where({ kind: e.kind, login: e.login })}: the PASS at ${e.withdraw.tip} was withdrawn by ${e.withdraw.by}`
    e.counts = false
    effective.push(e)
  }
  if (!effective.length) {
    const reason = reasons.length ? reasons.join('; ') : `no Verifier report names the tip ${headSha.slice(0, SHORT)}`
    return { ok: false, verdict: null, by: null, tip: null, reason, judged, unverified }
  }

  // #1317: a conclusion that names the head itself always decides, and the carried ones are read only
  // when the head carries none. That is what keeps an INC at the head a veto: a carried PASS can never
  // outrank a conclusion written at this tip, whatever the two timestamps say.
  const exact = effective.filter((e) => !e.carriedFrom)
  const candidates = exact.length ? exact : effective
  // The newest word at this tip decides, and that includes a conclusion the checks refused: an invalid
  // PASS is not evidence, and an invalid INC is still someone saying not to merge (#676). Equal
  // timestamps fall back to the order the API returned them in (oldest first), so the later one wins.
  const last = candidates
    .map((e, i) => ({ e, i, t: Date.parse(e.at ?? 0) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .at(-1).e
  if (!last.counts) return { ok: false, verdict: last.verdict, by: null, tip: last.tip, id: last.id, kind: last.kind, reason: last.why, judged, unverified }
  const { parsed } = last
  if (last.verdict !== 'PASS') {
    return { ok: false, verdict: last.verdict, by: last.login, tip: last.tip, id: last.id, kind: last.kind, carried: Boolean(last.carriedFrom), reason: `${last.login} says ${last.verdict ?? 'nothing'} at ${last.carriedFrom ? `the change set of this tip (written at ${last.tip.slice(0, SHORT)})` : 'this tip'}`, judged, unverified }
  }
  if (!parsed.ran.length) {
    return { ok: false, verdict: 'PASS', by: last.login, tip: last.tip, id: last.id, kind: last.kind, reason: `${last.login}'s PASS lists no command it ran`, judged, unverified }
  }
  // #1317: the allow sentence names both full shas and the fact that the comparison was made, so a reader
  // never has to guess whether the guard looked at the trees or simply found a PASS.
  return {
    ok: true,
    verdict: 'PASS',
    by: last.login,
    tip: last.tip,
    id: last.id,
    kind: last.kind,
    carried: Boolean(last.carriedFrom),
    reason: last.carriedFrom
      ? `${last.login}'s PASS at ${last.tip} still describes this head ${headSha}: the change set is identical (every changed path carries the same blob at both tips)`
      : `${last.login}'s PASS names this tip`,
    judged,
    unverified,
  }
}

export function render(result, { pr, head, author } = {}) {
  const out = [
    `### Reviewed tip: ${result.ok ? `PASS at ${head.slice(0, SHORT)}` : 'not reviewed'}`,
    '',
    result.ok
      ? `${result.by} passed this tip.`
      : `No PASS names this tip: ${result.reason}.`,
    '',
    `Pull request #${pr}, author ${author}, head \`${String(head).slice(0, SHORT)}\`.`,
  ]
  // #1110: a conclusion this tip carries and the gate could not verify is named here, so a reader never
  // wonders why a PASS that is visibly on the pull request is not the one being reported.
  const unverifiedReports = result.unverified ?? []
  if (unverifiedReports.length) {
    out.push('', 'Unverified — not read as conclusions:')
    for (const e of unverifiedReports.slice(0, 10)) out.push(`- unverified: ${e.login} (${e.kind}): ${e.verdict ?? 'no verdict'} at ${(e.tip ?? 'no tip').slice(0, SHORT)} — ${String(e.why ?? '').replace(/^[^:]+: unverified — /, '')}`)
  }
  const seen = result.judged.filter((e) => e.counts || e.verdict || e.unknownVerdict || e.withdraw)
  if (seen.length) {
    out.push('', 'Verifier reports read:')
    for (const e of seen.slice(0, 10)) {
      // #1239: an unreadable word is named with its reason, so the next reader does not have to rediscover
      // that `Incorrect` was never read as `INC`. #1335: a withdrawal is named the same way, with the tip
      // it withdraws and the Bot that wrote it, so a reader can see why the PASS beside it does not count.
      const word = e.withdraw
        ? `withdrawal of the PASS at ${(e.withdraw.tip ?? 'no tip').slice(0, SHORT)} by ${e.withdraw.by}`
        : e.unknownVerdict ? `"${e.unknownVerdict}", which is not a verdict word` : (e.verdict ?? 'no verdict')
      const why = e.unknownVerdict ? ` — ${String(e.why ?? '').replace(/^[^:]+:\s*/, '')}` : ''
      out.push(`- ${e.login} (${e.kind}): ${word} at ${(e.tip ?? 'no tip').slice(0, SHORT)}, written-by ${e.writer ?? 'nothing'}${e.counts ? '' : ' (not counted)'}${why}`)
    }
    if (seen.some((e) => e.unknownVerdict)) out.push('- the four verdict words the gate reads: PASS, FAIL, INC, REQUEST_CHANGES — any other word is unreadable and refuses this tip (#1239)')
  }
  out.push('', '_Report only (Phase 1): this does not block, label, approve or merge anything. Rules: `.github/agent/review-policy.json`; see [`docs/autonomous-dev.md`](../../docs/autonomous-dev.md)._')
  return out.join('\n')
}

export function loadPolicy(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 256 << 20 })
const list = (path) => gh('api', '--paginate', '--jq', '.[]', path).split('\n').filter(Boolean).map((l) => JSON.parse(l))

function arg(name) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

function main() {
  const policyPath = arg('--policy') || process.env.REVIEW_POLICY || fileURLToPath(new URL('../agent/review-policy.json', import.meta.url))
  const repo = arg('--repo') || process.env.GH_REPO
  if (!repo) throw new Error('set GH_REPO or pass --repo owner/name')
  const pr = arg('--pr') || process.env.PR
  if (!pr) throw new Error('set PR or pass --pr N')

  const pull = JSON.parse(gh('api', `repos/${repo}/pulls/${pr}`))
  const head = arg('--sha') || pull.head?.sha
  const author = pull.user?.login
  if (!head) throw new Error(`pull request ${pr} has no head sha`)

  const reports = [
    ...list(`repos/${repo}/issues/${pr}/comments?per_page=100`).map((c) => ({ kind: 'comment', login: c.user?.login, type: c.user?.type, body: c.body, at: c.created_at, association: c.author_association, url: c.html_url })),
    ...list(`repos/${repo}/pulls/${pr}/reviews?per_page=100`)
      .filter((v) => (v.body ?? '').trim())
      .map((v) => ({ kind: 'review', login: v.user?.login, type: v.user?.type, body: v.body, at: v.submitted_at, association: v.author_association, url: v.html_url })),
  ]

  const policy = loadPolicy(policyPath)
  // #1317: the changed-file list, read here so a tip that moved only because `main` moved can be told
  // apart from one whose code changed. `decide` compares `(path → blob sha)` at both tips and refuses
  // when the list or a tree cannot be read, so this read failing is a refusal, not a shortcut.
  const changedPaths = list(`repos/${repo}/pulls/${pr}/files?per_page=100`).map((f) => f.filename).filter(Boolean)
  // #1110: the keys come from the same checkout the policy does, so a pull request that edits either file
  // changes only what its own run reads. `loadSigners` is fail-closed on its own; `decide` refuses when the
  // policy lists a roster and this is missing.
  const signers = loadSigners({ policy, path: arg('--signers') || process.env.VERDICT_SIGNERS || fileURLToPath(new URL('../agent/signers.json', import.meta.url)) })
  const result = decide({ head, author, reports, policy, body: pull.body, admins: adminsFor({ gh, repo, reports, policy, author }), repo, pr, signers, gh, changedPaths })
  console.log(`review-gate (report only): PR #${pr} tip ${String(head).slice(0, SHORT)} — ${result.ok ? `PASS by ${result.by}` : result.reason}`)
  const text = render(result, { pr, head, author })
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
  else console.log('\n' + text)
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main() } catch (e) { console.error(`review-gate: ${e.message}`); process.exit(1) }
}
