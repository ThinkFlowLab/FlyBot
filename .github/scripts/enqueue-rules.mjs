// The rules a pull request's body and labels satisfy before it may enter the queue (#602, #718, #943,
// #947, #951). They live here, not in `enqueue-guard.mjs`, because there are two readers and both must
// read the same text: the guard that prints the command, and `merge-gate.mjs`, whose required check is
// the only gate on a `merge_group` entry today (#960). A second copy of these rules would be two
// answers to one question, which is #812's kill condition.
import { parseReport } from './review-gate.mjs'

const SHORT = 12
// AGENTS.md → Merge gates rule 2: the `hold` label is paired with a comment saying
// "Record only — do not merge / 仅记录、禁止入队". The label can be removed or forgotten; the record
// must still keep the pull request out of the queue.
//
// The marker is a whole line, not a phrase somewhere in the text: a PASS that explains the rule — the
// first real one wrote `- \`RECORD_ONLY\` matches … a record written only in Chinese would not keep the
// pull request out` — must not freeze itself (#687). A bullet or a quote line is allowed, but nothing
// may follow the marker on it except its other language half.
// #2091: a comment written on one line of the diff (`pulls/{pr}/comments`, `kind: 'review-comment'`) is a
// request and never a conclusion. `stopRequestAt` reads all three faces, because a person's "do not
// merge" is the same request in whichever box it is typed; the conclusion readers take the two faces a
// Verifier block is written in, so adding the third input cannot add a way to record a PASS. One
// predicate, used by every reader that parses a body for a conclusion.
export const isConclusionSource = (r) => r?.kind !== 'review-comment'

const RECORD_ONLY = /^[\s>*+-]*(?:record only\s*[—–-]+\s*do not (?:merge|queue)(?:\s*[/／]\s*仅记录[、,，]?\s*禁止入队)?|仅记录[、,，]?\s*禁止入队)\s*[.。]?\s*$/im
// AGENTS.md → Claim: a pull request says `Fixes #N` in its body, and one issue carries one pull request.
// #718: a pull request with no issue behind it, or with no `agent-pr` label, is not the routine's work at
// all — #711/#712/#713 arrived with neither and nothing refused them, because the guard only looked at
// `hold`, the conclusions and the diff. The reference is a line of its own, so prose about "fixes" does
// not pass; the spellings accepted are exactly `Fixes #<n>` and `Closes #<n>`, behind any `#`, `>` or `-`.
// The issue is not always in this repository: a pull request opened in the code fork names the upstream
// one in full (`Fixes ThinkFlowLab/FlyBot#801`), and a bare `#801` there points at a number the fork does
// not have. Both spellings are accepted, and the repository part is not compared with anything — the guard
// asks "does this pull request name an issue at all"; one issue carrying one pull request is the gate's
// report, not this regex's job.
// The rules only hold where the branch is ours: a fork is exempt, because we cannot push to its head
// and the owner keeps their own workflow there (#711/#713).
const ISSUE_REF = /^[\s>#-]*(?:fixes|closes)\s*(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+/im
// #943: the body says who owns the pull request and who reviews it. `Owner:`/`Reviewer:` were a
// sentence in AGENTS.md that nothing read: #940 went from opened to merged in about seven minutes with
// the largest diff of the day, and its body carried neither line.
//
// The first 20 lines, not the first two: an agent's body opens with its own HTML comment (the open #941
// carries `Owner:` on line 4), and a check that only read the top would refuse every one of them.
const HEADER_LINES = 20
const OWNER_LINE = /^\s*Owner:/i
const REVIEWER_LINE = /^\s*Reviewer:/i
export const short = (s) => String(s ?? '').slice(0, SHORT)
const labelNames = (labels) => (labels ?? []).map((l) => String(typeof l === 'string' ? l : l?.name ?? '').toLowerCase())

// The refusal names the line, not just the defect, so the fix is "add this line" rather than "something
// about the body". A `Reviewer:` line with no value names nobody, which is the same defect as a missing
// line: the queue is meant to know who reviews, not to see the word.
//
// #947: `Reviewer:` names a workstation, so it speaks the vocabulary of `Written-by:` — the policy's
// `writers` Bot names, which is the only thing our pull requests ever wrote there — and the `reviewers`
// logins stay accepted, because the shared account is a login too. Checking the login list alone refused
// every pull request we open, #941 among them: `Reviewer: Reviewer2` came back "not in reviewers" while
// `reviewers` holds accounts, not workstations. A value is one name from either list, with or without a
// leading `@`, compared case-insensitively.
//
// Being listed is not the same as being able to review, and the line has to name at least one of the
// second kind, or "a Bot name" becomes a way around the list. A login in `reviewers` can record a PASS.
// A Bot name can only through the one identity every Bot writes as, `Birfy`, so it names a reviewer only
// while that account is in `reviewers`; with it gone the name is vocabulary and the line is refused.
const SHARED_WRITE_LOGIN = 'Birfy'
// #1228: that same account is the one value both vocabularies contain, so both lines accepted it: a body
// could name `Birfy` on `Owner:` (a `writers` name) or on `Reviewer:` (a `reviewers` login) and the queue
// entry read it as a workstation. #1214 merged with `Reviewer: Birfy` for exactly that reason. Neither line
// is about the account; each asks which Bot claims, and which Bot reviews, so the shared identity is refused
// before either vocabulary is consulted — otherwise "listed" would keep standing in for "named a Bot".
const SHARED_WRITE_NAME = SHARED_WRITE_LOGIN.toLowerCase()
// One line's names: split on commas, strip a leading `@`, compare case-insensitively. Both header lines
// read their values this way so `@Dev`, `dev` and `DEV` are one name wherever they appear (#951).
const headerNames = (line, pattern) => line.replace(pattern, '').split(',').map((value) => value.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
function headerReasons(body, policy) {
  const lines = String(body ?? '').split(/\r?\n/).slice(0, HEADER_LINES)
  const reasons = []
  const logins = new Set((policy?.reviewers ?? []).map((l) => String(l).toLowerCase()))
  const bots = new Set((policy?.writers ?? []).map((w) => String(w).toLowerCase()))
  const sharedLogin = logins.has(SHARED_WRITE_LOGIN.toLowerCase())
  // A line with no value names nobody, which is the same defect as a missing line — for either header.
  // The owner speaks the same `writers` vocabulary: a name the policy does not know makes the line a
  // claim with no name behind it, and an unknown name is also how "Owner: Somebody" cleared the
  // duplicate check (#951 INC).
  const owner = lines.find((line) => OWNER_LINE.test(line))
  const ownerNames = owner ? [...new Set(headerNames(owner, OWNER_LINE))] : []
  if (!ownerNames.length) reasons.push('missing line: Owner:')
  for (const name of ownerNames) {
    if (name === SHARED_WRITE_NAME) reasons.push(`Owner names "${name}", who is the shared write identity every Bot writes as — name the Bot that claims this pull request`)
    else if (!bots.has(name)) reasons.push(`Owner names "${name}", who is not a writers Bot name`)
  }
  const owners = new Set(ownerNames)
  const reviewer = lines.find((line) => REVIEWER_LINE.test(line))
  if (!reviewer) reasons.push('missing line: Reviewer:')
  else {
    // One name twice is one name: `Reviewer: Dev, Dev` must not print the same refusal twice.
    const names = [...new Set(headerNames(reviewer, REVIEWER_LINE))]
    if (!names.length) reasons.push('missing line: Reviewer:')
    let passable = false
    for (const name of names) {
      // #1228: refused before the vocabularies, because this value is the one both of them list.
      if (name === SHARED_WRITE_NAME) {
        reasons.push(`Reviewer names "${name}", who is the shared write identity every Bot writes as — name the Bot that reviews`)
        continue
      }
      if (logins.has(name)) {
        passable = true
        continue
      }
      if (bots.has(name)) {
        if (sharedLogin) passable = true
        continue
      }
      // Neither list: say both, so the reader knows which two vocabularies were tried rather than
      // being sent to fix a spelling that was never the problem.
      reasons.push(`Reviewer names "${name}", who is not a reviewers login`)
      reasons.push(`Reviewer names "${name}", who is not a writers Bot name`)
    }
    // #951: the two lines are two roles. Reading them separately let one Bot own and review the same pull
    // request — `Reviewer: Dev` passed on `Dev` being a `writers` name — which is the shape #940 had with
    // no lines at all. The comparison is per name, so a list that overlaps in either direction refuses.
    for (const name of names) {
      if (owners.has(name)) reasons.push(`Reviewer names "${name}", who is also the Owner of this pull request`)
    }
    // Every name is a known Bot name and none of them can pass: refused, because the line would
    // otherwise read as reviewed.
    if (names.length && !passable && !reasons.length) {
      const named = names.map((name) => `"${name}"`).join(', ')
      reasons.push(`Reviewer names ${named}, who ${names.length === 1 ? 'is a writers Bot name but cannot record a Verdict here' : 'are writers Bot names but cannot record a Verdict here'}: every Bot writes as "${SHARED_WRITE_LOGIN}", which is not in reviewers`)
    }
  }
  return reasons
}

// #602, 2026-11-01 recurrence: the hold that is a comment. `hold` is human-only (AGENTS.md → Merge gates)
// and a pull request opened by a Bot account cannot set it, so the only brake its author has is a comment
// asking not to merge this tip. #2067 took that brake and merged anyway — PASS at 17:35:30, "please do not
// merge this tip" at 17:38:11, merged at 17:39:54 — because the guard read the labels, the diff and the
// conclusions, and never the comments.
//
// What counts: a comment or a review body (#2073) by a person (`type: "User"`) or by the pull request's
// own author, written after the conclusion this decision used — in #2067 the author was the only one
// objecting, so a "only a non-author can stop" rule would have merged it too. A request older than the
// PASS at this tip is about the state that PASS has since read. With no conclusion to anchor on (a T0/T1
// change) the whole list is read.
//
// The phrases are the ones people write, not a marker: #2067's request is a bold sentence, and its addendum
// only says "the hold request above". Quoted text and code blocks are mentions, not requests — the first
// PASS written for the record-only marker froze itself by explaining the marker (#687), and a comment that
// quotes "record only — do not merge" must not do the same to a pull request.
//
// A stop is answered on the record. The newest comment in that window decides, so a later one that says the
// tip may merge clears it; a corrected tip with its own PASS moves the window past the request as well.
// Without that the rule would wedge a pull request forever on one mistaken sentence, and a T0/T1 change has
// no PASS to move the window with.
const STOP_REQUEST = new RegExp(
  [
    String.raw`\b(?:do not|don't|don’t|never)\s+(?:merge|queue|enqueue|land)\b`,
    String.raw`\bplease do not\s+(?:merge|queue|enqueue|land|ship)\b`,
    String.raw`\bnot ready\b`,
    String.raw`\b(?:on hold|hold off|hold on|hold request|hold this|hold it|hold (?:the )?(?:tip|merge|pr|pull request)|please hold)\b`,
    String.raw`(?:不要|请勿|暂不|先别|先不要|禁止|暂缓)(?:合并|入队|合入)`,
  ].join('|'),
  'i',
)
// `hold` as its own opening line — "Hold." / "Hold — the second reader is still unguarded" — is how the
// request is usually shortened. Anywhere else the word is the label this repository already has, and
// reading the label's name as a request would freeze every pull request that discusses one.
const HOLD_LINE = /^[\s>*+-]*(?:hold|hold on|hold off)\b/im
// The answer: read only after a stop in the same window, so this vocabulary cannot unblock anything alone.
const LIFT_REQUEST = new RegExp(
  [
    String.raw`\b(?:merge it|merge this|you may merge|go ahead|ok(?:ay)? to merge|release the hold|lift the hold|clear the hold|no longer hold|hold (?:is )?(?:lifted|cleared)|not held)\b`,
    String.raw`(?:可以合并|同意合并|解除|取消 hold|已解决|放行)`,
  ].join('|'),
  'i',
)
const withoutQuotes = (text) => String(text ?? '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/~~~[\s\S]*?~~~/g, ' ')
  .replace(/`[^`\n]*`/g, ' ')
  .replace(/"[^"\n]*"/g, ' ')
  .replace(/“[^”\n]*”/g, ' ')

// The stop request still standing, or null. `since` is the timestamp of the conclusion the decision used, in
// ms; null reads the whole list (no anchor, or one that cannot be read — a guard that cannot find the PASS it
// judged must not narrow what it refuses).
export function stopRequestAt(reports, { author, since } = {}) {
  const login = String(author ?? '').toLowerCase()
  const after = Number.isFinite(since) ? since : null
  const rows = (reports ?? [])
    .map((r, i) => ({ r, i, t: Date.parse(r?.at ?? '') || 0 }))
    .filter(({ r }) => String(r?.type ?? '') === 'User' || (login !== '' && String(r?.login ?? '').toLowerCase() === login))
    // A comment and a review body are read alike (#2073): the request a person writes is the same one
    // whichever box it was typed in, and the callers already pass both (`enqueue-guard.mjs:69-71`,
    // `merge-gate.mjs:219-221`). A body carrying a conclusion is the conclusion, not a request:
    // "record only — do not merge" in a PASS is the marker `recordOnlyAt` already reads, and reading it
    // here too would make every parked PASS its own stop.
    .filter(({ r }) => !parseReport(r?.body).verdict)
    .filter(({ t }) => after == null || t > after)
    .sort((a, b) => a.t - b.t || a.i - b.i)
  let stop = null
  for (const { r } of rows) {
    const text = withoutQuotes(r.body)
    const phrase = STOP_REQUEST.exec(text)?.[0] ?? HOLD_LINE.exec(text)?.[0]
    if (phrase) {
      stop = { id: r.id, login: r.login, at: r.at ?? null, phrase: phrase.trim() }
      continue
    }
    if (stop && LIFT_REQUEST.test(text)) stop = null
  }
  return stop
}

// Where the window opens: the timestamp of the conclusion this decision used (#1112 gives it an id, the
// handle both readers already print). A conclusion the caller did not pass reads as "no anchor".
function conclusionAt(reports, verdict) {
  if (verdict?.id == null) return null
  const found = (reports ?? []).find((r) => r?.id === verdict.id)
  const t = Date.parse(found?.at ?? '')
  return Number.isFinite(t) ? t : null
}

// The newest conclusion that names this head, if it carries the record-only marker. Only a body that
// parses as a conclusion counts, so ordinary prose quoting the phrase is no marker; only the newest
// one counts, so a fresh PASS at the same head supersedes an older parked report.
export function recordOnlyAt(reports, head) {
  const target = String(head ?? '').toLowerCase()
  if (!target) return null
  const at = (reports ?? [])
    .filter(isConclusionSource)
    .map((r, i) => ({ r, i, parsed: parseReport(r.body) }))
    .filter(({ parsed }) => parsed.verdict && parsed.tip && target === parsed.tip)
    .map((x) => ({ ...x, t: Date.parse(x.r.at ?? 0) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
  const last = at.at(-1)
  return last && RECORD_ONLY.test(String(last.r.body ?? '')) ? last.r : null
}

// #1202: the short checkpoint. A pull request hands itself over by name — who claims it, which issue it
// answers, what changed in three to five sentences, which files, whether the checks ran, and what is next
// — in one block in the body, so the next Bot reads the handoff where it already reads `Owner:` and
// `Fixes #`. The body is the only store: it is the squash commit message, so a checkpoint cannot fall out
// of step with the pull request the way a comment or a label can (#1201, #1199, #951 were all that shape:
// two copies of one fact, one of them stale).
//
// It is read at one point, the queue entry. There is no "ready" event to hang a check on, so the guard
// enforces it where it enforces the other body rules, and nothing here claims a rule it does not run.
const CHECKPOINT_OPEN = '<!-- flybot:checkpoint -->'
const CHECKPOINT_CLOSE = '<!-- /flybot:checkpoint -->'
// A marker counts only on a line of its own. A body that *describes* the block — the pull request that
// introduced it does — mentions the markers in prose, and a substring search starts reading the JSON at
// the first backtick after that sentence (#1210).
const markerAt = (lines, marker) => lines.findIndex((line) => line.trim() === marker)
// The block is the whole budget: 1500 characters is what makes "short" checkable rather than aspirational.
const CHECKPOINT_MAX = 1500
const CHECKPOINT_SUMMARY_MAX = 600
const CHECKPOINT_NEXT_MAX = 300
const CHECKPOINT_FILES_MAX = 12
const CHECK_RESULTS = ['green', 'red', 'none']
const SHA40 = /^[0-9a-f]{40}$/i
// A path, not a sentence: no whitespace, not absolute, and not so long that it is prose. `Makefile` and
// `Dockerfile` have no extension, so a dot is not required.
const FILE_PATH = /^[^\s/][^\s]{0,199}$/
// One sentence ends at `.`, `!`, `?` or their full-width forms. The ASCII ones count only where whitespace
// (or the text's end) follows: without that `v0.2.3` would be three sentences and every summary naming a
// version would be refused. The full-width ones take no such condition, because Chinese writes `。` with no
// space after it — requiring one counted a three-sentence Chinese handoff as a single sentence (#1210).
const SENTENCE_END = /[.!?]+(?:\s+|$)|[。！？]+/
const FENCE_LINE = /^\s*```[a-z]*\s*$/i

// The block as written, or why it cannot be read. `present: false` is "no `## Checkpoint` section at
// all"; a block that opens and never closes is its own defect, because a reader cannot tell where the
// handoff ends.
export function parseCheckpoint(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const open = markerAt(lines, CHECKPOINT_OPEN)
  if (open < 0) return { present: false, fields: null, chars: 0, error: null, block: null }
  const close = markerAt(lines.slice(open + 1), CHECKPOINT_CLOSE)
  if (close < 0) {
    return { present: true, fields: null, chars: 0, error: `the block has no closing ${CHECKPOINT_CLOSE} on a line of its own`, block: null }
  }
  const blockLines = lines.slice(open, open + close + 2)
  const block = blockLines.join('\n')
  // The JSON is fenced in the template so it reads as code in the body; the fence is not part of it.
  const json = blockLines.slice(1, -1).filter((line) => !FENCE_LINE.test(line)).join('\n').trim()
  try {
    const fields = JSON.parse(json)
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return { present: true, fields: null, chars: block.length, error: 'the block is not one JSON object', block }
    }
    return { present: true, fields, chars: block.length, error: null, block }
  } catch (e) {
    return { present: true, fields: null, chars: block.length, error: `the block is not valid JSON (${e.message})`, block }
  }
}

const issueNumbersIn = (body) => [...String(body ?? '').matchAll(/^[\s>#-]*(?:fixes|closes)\s*(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)/gim)].map((m) => Number(m[1]))
const sentencesIn = (text) => String(text ?? '').split(SENTENCE_END).map((s) => s.trim()).filter(Boolean)

// Every refusal names the field and what to write, in the voice of `missing line: Owner:` — a Bot that has
// to guess why it was refused starts writing the block to please the regex, which is the one failure this
// convention cannot afford. The friction is real (seven fields on every pull request) and it only pays
// back if the first refusal is precise.
export function checkpointReasons(body, { pr, files } = {}) {
  const { present, fields, chars, error } = parseCheckpoint(body)
  if (!present) {
    return ['no checkpoint: add the "## Checkpoint" section of .github/pull_request_template.md (claim, issue, a 3-5 sentence summary, files, checks, next)']
  }
  if (error) return [`checkpoint: ${error}`]
  const reasons = []
  if (chars > CHECKPOINT_MAX) reasons.push(`checkpoint is ${chars} characters: it must stay under ${CHECKPOINT_MAX}, so move detail into the body above it`)

  const text = String(body ?? '')
  const ownerLine = text.split(/\r?\n/).slice(0, HEADER_LINES).find((line) => OWNER_LINE.test(line))
  const owners = new Set(ownerLine ? headerNames(ownerLine, OWNER_LINE) : [])

  if (!Number.isInteger(fields.pr)) reasons.push('checkpoint field "pr": write the pull request number as an integer')
  else if (pr != null && fields.pr !== Number(pr)) reasons.push(`checkpoint field "pr": says ${fields.pr}, but this is pull request #${pr} — a copied body is not a checkpoint`)

  const claim = typeof fields.claim === 'string' ? fields.claim.trim().replace(/^@/, '').toLowerCase() : ''
  if (!claim) reasons.push('checkpoint field "claim": name the Bot that wrote this checkpoint')
  else if (!owners.has(claim)) {
    reasons.push(owners.size
      ? `checkpoint field "claim": says "${fields.claim}", but the Owner: line says ${[...owners].map((n) => `"${n}"`).join(', ')} — one claimant per pull request`
      : `checkpoint field "claim": says "${fields.claim}", but the body has no Owner: line to agree with`)
  }

  const closed = issueNumbersIn(text)
  if (!Number.isInteger(fields.issue)) reasons.push('checkpoint field "issue": write the issue number as an integer')
  else if (!closed.includes(fields.issue)) {
    reasons.push(`checkpoint field "issue": says #${fields.issue}, but the body closes ${closed.length ? closed.map((n) => `#${n}`).join(', ') : 'no issue'} — add "Fixes #${fields.issue}" or name the issue this fixes`)
  }

  const summary = typeof fields.summary === 'string' ? fields.summary.trim() : ''
  if (!summary) reasons.push('checkpoint field "summary": write what changed, in 3-5 sentences')
  else if (summary.length > CHECKPOINT_SUMMARY_MAX) reasons.push(`checkpoint field "summary": ${summary.length} characters, over the ${CHECKPOINT_SUMMARY_MAX} a handoff may carry`)
  else {
    const count = sentencesIn(summary).length
    if (count < 3 || count > 5) reasons.push(`checkpoint field "summary": ${count} sentence${count === 1 ? '' : 's'} — write 3 to 5, what changed rather than how`)
  }

  const listed = Array.isArray(fields.files) ? fields.files : null
  if (!listed || !listed.length) reasons.push('checkpoint field "files": list the 1-12 files a reviewer should open first')
  else if (listed.length > CHECKPOINT_FILES_MAX) reasons.push(`checkpoint field "files": ${listed.length} paths, at most ${CHECKPOINT_FILES_MAX}`)
  else if (listed.some((f) => typeof f !== 'string' || !FILE_PATH.test(f.trim()))) reasons.push('checkpoint field "files": every entry must be a path (no spaces, not absolute)')
  else if (Array.isArray(files) && files.length) {
    const changed = new Set(files)
    if (!listed.some((f) => changed.has(f.trim()))) reasons.push(`checkpoint field "files": none of ${listed.map((f) => `"${f}"`).join(', ')} is in this pull request's diff — list a file it changes`)
  }

  const checks = fields.checks
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) reasons.push('checkpoint field "checks": write { "ran": …, "result": green|red|none, "at": <40-character tip sha> }')
  else {
    if (typeof checks.ran !== 'string' || !checks.ran.trim()) reasons.push('checkpoint field "checks.ran": name the command(s) you ran, or "none"')
    if (!CHECK_RESULTS.includes(checks.result)) reasons.push(`checkpoint field "checks.result": write one of ${CHECK_RESULTS.join('/')}`)
    else if (checks.result === 'none' && !(typeof checks.why === 'string' && checks.why.trim())) reasons.push('checkpoint field "checks.why": result "none" needs the reason nothing ran')
    if (typeof checks.at !== 'string' || !SHA40.test(checks.at.trim())) reasons.push('checkpoint field "checks.at": write the full 40-character tip sha the checks ran at')
  }

  const next = typeof fields.next === 'string' ? fields.next.trim() : ''
  if (!next) reasons.push('checkpoint field "next": say what the next hand is (or "none — ready for review")')
  else if (next.length > CHECKPOINT_NEXT_MAX) reasons.push(`checkpoint field "next": ${next.length} characters, over ${CHECKPOINT_NEXT_MAX}`)

  return reasons
}

// The decision, without the network: `result` is merge-gate's `judge` output for this head, and `author` is
// the pull request's opener — the one commenter a stop request is read from whatever account type it carries.
export function guard({ pr, head, labels, body, files, mechanicalRelease, fork, draft, merged, result, reports, policy, author }) {
  const quiet = recordOnlyAt(reports, result.head ?? head)
  const reasons = [...result.reasons]
  if (quiet) reasons.push('the newest conclusion at this head says "record only — do not merge"')
  // #602 (2026-11-01): the stop request in the comments, read after the conclusion this decision used. A
  // merged pull request is history, not a request — this check runs again on every comment (#926, #943).
  const stop = merged ? null : stopRequestAt(reports, { author, since: conclusionAt(reports, result.verdict) })
  if (stop) reasons.push(`a comment asks not to merge this pull request: comment ${stop.id ?? 'without an id'} by ${stop.login} at ${stop.at ?? 'no time'} says "${stop.phrase}" — clear it on the record with a newer comment that lets this tip merge, or push a corrected tip that earns its own PASS`)
  // Two exemptions, both about what the pull request is rather than how risky it is. A mechanical release
  // PR carries neither an issue nor the label by design — it is the routine's own daily output under the
  // standing approval (AGENTS.md 6). A fork is not ours: its head cannot be pushed by us, and the owner runs
  // their own workflow there (#711/#713). `result.exempt` cannot stand in for either: it is true for T0/T1
  // as well, and routine work still names its issue.
  if (!mechanicalRelease && !fork) {
    if (!ISSUE_REF.test(String(body ?? ''))) reasons.push('no issue reference in the pull request body: add "Fixes #<n>" or "Fixes owner/repo#<n>"')
    if (!labelNames(labels).includes('agent-pr')) reasons.push('missing label: agent-pr')
    // #943: only a request to enter the queue. A draft is not entering it, and a merged pull request is
    // never re-judged: this check runs again on every comment (enqueue-guard.yml), so without the second
    // half a sentence on an old merged pull request would turn its check red over a body nobody can edit
    // any more (#926, #925, #908 and others merged without these lines).
    if (!draft && !merged) {
      reasons.push(...headerReasons(body, policy))
      // #1202: the same exemption list, for the same reason. A release PR is generated and has no Bot to
      // claim it; a fork's author keeps their own workflow. Read at the queue entry rather than on the
      // `ready_for_review` event — the workflow does listen for that one — because `edited` is not among its
      // types: a body fixed after a green check starts no run, so the queue entry is the first read of the
      // body as it will merge.
      reasons.push(...checkpointReasons(body, { pr, files }))
    }
  }
  const ok = result.ok && !quiet && reasons.length === 0
  return {
    ...result,
    ok,
    reasons,
    recordOnly: Boolean(quiet),
    // Named for the same reason the record-only marker is: a reader has to be able to go and read the text
    // that stopped the merge, and answer it there.
    stopRequest: stop,
    mechanicalRelease: Boolean(mechanicalRelease),
    fork: Boolean(fork),
    draft: Boolean(draft),
    merged: Boolean(merged),
    labels: labels ?? [],
    // One loud sentence: a refusal says what to do ("do not enqueue") and why, so it cannot be read
    // as a warning that some other step may override. #1317: when the PASS was written at an older tip
    // whose change set is this head's, the allow line says so and names both shas — the reader has to
    // be able to tell "the tree I reviewed" from "a tip that merely moved".
    message: ok
      ? result.verdict?.carried
        ? `enqueue #${pr}: no \`hold\` and the gate passes — ${result.verdict.by}'s PASS at ${result.verdict.tip} still describes this head ${result.head}: the change set is identical (the tip moved without changing a changed file)`
        : `enqueue #${pr}: no \`hold\` and the gate passes`
      : `do not enqueue #${pr}: ${reasons.join('; ')}`,
    command: `gh pr merge ${pr} --auto --squash --match-head-commit ${result.head ?? head}`,
  }
}
