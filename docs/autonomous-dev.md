# Autonomous development (Phase 0: report only)

Status: **Phase 0, plus a Phase 1 report.** Nothing here blocks, labels, comments on or merges anything. It adds a way to
file agent tasks, a label set, a PR template, a workflow that *reports* a risk tier (T0 to T3)
for each pull request, and a workflow that *reports* whether that PR's tip is reviewed. The rest of the plan is described so that later phases fit the constraints.

## Adaptation: no GitHub App, no Cursor cloud agent

Decisions by the maintainer, and what follows from them:

1. **No GitHub Apps.** The deterministic controller runs in GitHub Actions on the built-in
   `GITHUB_TOKEN` with the least permissions per job. It has no LLM and no secrets.
2. **No Cursor GitHub App on ThinkFlowLab**, so no Cursor cloud agent on this repo. LLM agents
   (triage, implement, review) run **outside Actions**, as the Chief's workstations — Triage, Dev and Reviewer — on
   the team's own box. The review is done by the Reviewer Bot (acting as `Birfy`, self-review); OpenCode and Codex are
   gone (owner decision 2026-10-22), and no workflow, routine or gate requests or waits for them.
3. **Agents act only on issues labeled `agent-ready`**. That label is set by a maintainer, or by the owner's
   maintenance routine after triage (the routine runs as the maintainer account `Birfy`, so the controller sees a
   maintainer's label). No LLM develops other issues, and nothing outside text sets the label.
4. **Merge by tier** (owner decisions 2026-10-19, revised 2026-10-22): **T0 and T1** merge through the merge queue once CI is green, the PR is
   mergeable and it conforms to the design rules, with no PASS. **T2 and T3** need a PASS at the tip from the Reviewer Bot and green CI, and then the agent that gated the PR enqueues it itself — **T2 and T3 need no maintainer approve** (user decision 2026-10-22; [`AGENTS.md` → Merge gates](../AGENTS.md#merge-gates)). A self-PASS counts only across Bots: the account is shared, and the implementer never reviews its own pull request. The gate is the review: green `tests-ok` at the tip, a PASS at that same tip, and a test that fails when the change is reverted. Work that meets neither the defect nor the routine-need bar gets no PR at all (AGENTS.md). An issue that already has a
   pull request keeps it: update that branch (re-base, `update-branch`, or a commit on its head) rather than opening a
   second PR; a branch that cannot be pushed is the only exception, and the reason goes on the issue.
5. Budget is not set. Every cost cap will live in one config file (open PRs, attempts per PR,
   PRs per day, minutes per attempt) so it can be changed without code.

```
issue (agent-task form) --maintainer or maintenance routine adds agent-ready--> agent (outside Actions) --branch + PR-->
   Actions (GITHUB_TOKEN, no LLM): tests-ok, risk tier --T0/T1--> merge queue --T2/T3--> PASS at the tip
```

| Role | Runs where | Credential | Can do |
| --- | --- | --- | --- |
| Controller: tier, labels, enable auto-merge, watchdog | Actions, base-branch code, no PR code run | `GITHUB_TOKEN`, per-job least permissions | label, comment, `gh pr merge --auto --squash` |
| Agents: implement, review | the Chief's workstations on the box — Triage, Dev, Reviewer (the maintenance routine runs as `Birfy`) | the maintainer account's own `gh` login; a narrower credential remains the goal | triage and set `agent-ready`, push a branch or fork, open a PR, comment, review, enqueue a PR that may merge |
| Merge | the required GitHub merge queue on `main` (ruleset `main merge queue`) | none: the queue merges when the required checks pass on its entry | squash only (set by the queue) |
| Maintainers (`Birfy`, `hsliuustc0106`) | GitHub | own accounts | `hold` (human-only), set `agent-ready`, pause; no T2/T3 approve |

The owner's routines run as the maintainer account `Birfy`; that is how things work today, and it is allowed for the
actions in this document. Agents must **never admin-merge, bypass a gate or branch protection, or change rulesets**
with that login (a merge goes only through the merge queue). A narrower credential (`GH_TOKEN` plus a separate
`GH_CONFIG_DIR` for the agent process) stays a goal, not a requirement. Nothing in this repo creates tokens or secrets.

### Limits of `GITHUB_TOKEN`, and the workarounds

| Limit | Consequence | Workaround |
| --- | --- | --- |
| Events it causes do not start workflows (except `workflow_dispatch` and `repository_dispatch`) | a label, comment, push or PR made by an Action does not trigger other workflows; chains of "label, then workflow" do not work | do the whole decision in one job; poll on `schedule`; chain explicitly with `gh workflow run` (dispatch) |
| A merge or tag made with it may not start `push` workflows (the `Test` run on `main`, `release.yml`) | documented rule, not tested here (see [Merge plumbing](#merge-plumbing-merge_group-merge-queue-auto-merge)): an auto-merge **enabled** with `GITHUB_TOKEN` is reported to merge silently | enable auto-merge with the agent's own credential, never with `GITHUB_TOKEN`; keep `release.yml` waiting for a green run on the tagged commit, and start `Test` by `workflow_dispatch` on `main` if the push run is missing |
| Read-only and no secrets on `pull_request` from forks | a `pull_request` job cannot label or enable auto-merge for a fork PR | run writers from `schedule` or `pull_request_target` with **base-branch code that never checks out or runs PR code** and reads the PR through the API only |
| Cannot approve PRs (`can_approve_pull_request_reviews` is off here) | the controller can never approve T3 | harmless: T2/T3 need no approve (user decision 2026-10-22) |
| Cannot change `.github/workflows/**` | an Action cannot edit workflows | intended |
| About 1,000 API requests per hour per repository | a chatty controller stalls | few calls per tick, filter by label |
| `schedule` can lag by minutes and public repos' schedules stop after 60 days without activity | polling is not instant | acceptable; `workflow_dispatch` to run now |
| A queue merge is made by GitHub, not by the token that enqueued it | a merge by the queue **does** start the `push` run on `main` (observed on #217, #235); the `GITHUB_TOKEN`-enabled auto-merge case is still untested | enqueue with the agent's own credential (`gh pr merge --auto --squash`) |

## What Phase 0 adds

| File | Purpose |
| --- | --- |
| `.github/ISSUE_TEMPLATE/agent-task.yml` | form for a small, specified change; applies `agent-task`, **never** `agent-ready` |
| `.github/labels.json`, `.github/scripts/sync-labels.mjs` | label definitions and an idempotent script (dry run by default) |
| `.github/pull_request_template.md` | `Fixes #`, what changed, tip SHA / ran / not run (kept short: the body becomes the squash message) |
| `.github/agent/risk-rules.json`, `.github/scripts/risk-gate.mjs`, `.github/scripts/*.test.mjs` | the tier rules, the script, and its tests (run by `npm run verify` and the CI `package` job) |
| `.github/workflows/risk-tier.yml` | reports the tier in the job summary; `continue-on-error`, never required |

**CODEOWNERS is not added.** GitHub requests a review from every owner on every PR that touches an
owned path. Seven in ten of the last 30 merged PRs touch a T3 path, so it would notify both maintainers on most
PRs while enforcing nothing. Add it together with the "require review from code owners" rule when
the tier is enforced (Phase 2).

### Label flow

1. A maintainer files the **Agent task** form (label `agent-task`). The form cannot add `agent-ready`:
   GitHub applies template labels whatever the author's permissions.
2. A maintainer, or the owner's maintenance routine after triage (it runs as `Birfy`), adds `agent-ready`. That label is the only permission an agent has.
   Setting it again after someone else edits the issue is a manual rule now; the [label-only controller](controller.md)
   enforces it (dry run until `CONTROLLER_LIVE` is set).
3. The agent claims it (`agent-working`), opens a PR with `Fixes #N` (`agent-pr`), and stops at
   `needs-human` when stuck. `hold` freezes an issue or PR for agents and automation.

Create the labels once, as a maintainer, with your own `gh` login (nothing runs this automatically):

```sh
node .github/scripts/sync-labels.mjs --repo ThinkFlowLab/FlyBot          # dry run: prints the plan
node .github/scripts/sync-labels.mjs --repo ThinkFlowLab/FlyBot --apply  # create or update; never deletes
```

### Risk tiers

The tier is the highest of: the path of every changed file (and a renamed file's old path), content
hits in the added lines of code files, and a size cap. It comes from the diff, never from the PR text.
An unnamed path is T2, never T0 or T1. A diff GitHub cannot show, or a list of 3000 files, is T3.
Generated files (`core/client.js`, `patches/**`) are not read or counted; `patches check` verifies them.

| Tier | Rule (owner decisions 2026-10-19) | Examples |
| --- | --- | --- |
| T3 | a PASS at the tip (a self-PASS counts across Bots) and green CI; the gating agent merges it itself through the queue; **no maintainer approve** (user decision 2026-10-22; [`AGENTS.md` → Merge gates](../AGENTS.md#merge-gates)) | `.github/**`, `AGENTS.md`, `package.json`, `ds-bot/**`, trust-boundary host files (`authz`, `channel`, `reach`, ...), `plugins/social/src/**`; `child_process`, `eval`, new URL hosts, token env vars, `.skip`/`.only`, fence/sanitize/display-name code; over the size cap |
| T2 | a PASS at the tip (a self-PASS counts across Bots) and green CI; the gating agent merges it itself; **no maintainer approve** ([`AGENTS.md` → Merge gates](../AGENTS.md#merge-gates)) | other `core/src/host/**`, `plugins/**`, unknown paths |
| T1 | merge queue on green CI; no PASS | `core/src/client/**`, tests, generated files |
| T0 | merge queue on green CI; no PASS | `docs/**` (except policy docs), READMEs |

The rules are in `.github/agent/risk-rules.json`; changing them is T3. Tests may quote URLs and fence
words without a hit; `.skip`/`.only` still count in tests.

Run it by hand (read-only API calls with your `gh` login):

```sh
node .github/scripts/risk-gate.mjs --pr 96 --repo ThinkFlowLab/FlyBot
node .github/scripts/risk-gate.mjs --replay 30 --repo ThinkFlowLab/FlyBot   # tiers of the last 30 merged PRs
```

**Replay when this was written** (last 30 merged PRs, #41 to #96): T0 1, T1 2, T2 2, **T3 25**.
Of the 25: 14 trust-boundary paths, 7 CI or agent-rule paths, 2 content hits only, 2 size only.
So for FlyBot's current mix most PRs are T3 and carry a PASS; no tier needs a human click (user decision 2026-10-22). Review the tiers by hand before enforcing anything: the four PRs
decided by content or size alone (#60, #63, #74, #76) are the ones to argue about.

### Security of the report workflow

`pull_request` event, `contents: read` and `pull-requests: read`, no secrets, no `pull_request_target`.
The script and rules are checked out from the **base** commit and the PR is read through the API, so
a PR cannot change the rules that judge it. The one exception is the PR that first adds the script
(base has none), which falls back to its own copy under the same read-only token; the fallback step can be
deleted once the script is on `main`. The workflow must stay out of branch protection and out of the
`needs` of `tests-ok`; a test checks that.

To switch the report off: disable the workflow in the Actions tab, or delete `.github/workflows/risk-tier.yml`.

## The reviewed tip (Phase 1: report only)

A merge decision needs a check it can read, not a report in a chat. `.github/scripts/review-gate.mjs`
answers one question for a pull request: **does the current head carry a Verifier PASS?**
AGENTS.md step 6 is the rule it serves. A PASS is required for **T2 and T3** (at the tip, with green CI);
**T0 and T1 need no PASS** and merge on green CI; the merge gate computes that tier itself from the
changed files with the base copy of `risk-gate.mjs` and `risk-rules.json`, never from the `risk:T*`
labels (#640: a shared account makes a label a claim, not a fact). The agent that gated the PR then
enqueues it itself (owner decision 2026-10-21). This report is the evidence of a PASS; it never merges anything.

What counts as a reviewed tip, all of it:

1. A pull request **comment or review body** by a login listed in `.github/agent/review-policy.json`.
2. Not the pull request's **own author**, **unless** that author is listed in the policy's `selfReview` (today: `Birfy`).
   Owner decision 2026-10-19: a PR opened by the owner's Bot/agent may be PASSed by the owner's own reviewer
   Bot/agent, so no independent reviewer is required. That is an exception about the shared *account*, not about the
   Bot: an implementer never reviews its own pull request ([`AGENTS.md` → Merge gates](../AGENTS.md#merge-gates)). Any
   other author still needs someone else. A PASS does not replace green CI, and a new commit voids it.
   **When the login is that author, the comment also carries an attestation (#644, option B, first slice).**
   The header — the lines before the first blank, within the first eight non-empty lines — includes
   `Attestation: <40-character sha> role=<Bot>`. The sha is the whole tip. `role` is the `Written-by` name and is
   not an `Owner:` of the pull request. A `Verdict:` with no such line, a line after the blank, a short sha, or a
   role that is the Owner is the author's own GitHub identity and does not count. A conclusion from a different
   GitHub login does not carry the line. `decide` parses it; a signature was the later slice of #644 and is shipped but not enabled (#1110, #1111). The
   reviewed-tip job, `enqueue-guard` and `merge-gate` call that one function.
3. The conclusion format is fixed (#637): the **first line** is `Verdict: PASS at <sha>` (or `INC` / `REQUEST_CHANGES`), the second is the attribution (`Written-by: Reviewer`; a relay adds `Posted-by: Chief (proxy…)` on the third line, and the older prose `Written by: …` reads the same way), then the evidence — `Ran:` (or a `Ran …:` heading over a fenced block of `$ ` commands, #660–#663) with at least one command; `Not run:` naming any gap is recommended but not checked (owner decision 2026-10-22 09:57 Asia/Shanghai). A body whose first line is not the verdict is no conclusion. The comment's `author_association` must be `OWNER`, `MEMBER` or `COLLABORATOR`, or the report must be that pull request's own author listed in `selfReview` (#928), or the login must be shown as a repo admin by the permission API. Org repositories do not report `OWNER`. A `CONTRIBUTOR` who is none of those counts for nothing, so they can neither pass a tip nor hold one. An association the API did not send is not assumed, and a failed permission lookup is not admin. The permission API is for an admin GitHub did not tie to the repository: a `CONTRIBUTOR` stamp on someone else's pull request, asked only for a Tip+Verdict conclusion by a login in `reviewers`. A `selfReview` login is skipped only on that author's own report, which is the #928 carve-out and needs no lookup — skipping every `selfReview` login would never call, because the shipped policy lists every reviewer there. That lookup does not recover the own-pull-request PASS; #926 and #928 already do. The two qualifications do not replace each other: `selfReview` answers only whether an author may review their own pull request and gives that login no right on anyone else’s, while admin is read only through the permission API and only for a login already in `reviewers`. Every other check is unchanged.
4. The sha on that first line **is the head being judged**. A later commit moves the tip and the old PASS stops
   counting; that report is then listed as "not counted", with the sha it named.
5. The **newest** report that names this tip decides, so a later FAIL at the same tip vetoes an
   earlier PASS, and a later PASS at the same tip replaces a FAIL.
6. **A GitHub bot account writes no conclusion** (#943): `user.type` is `Bot`, or the login ends `[bot]`, and the
   report joins `judged` with `counts: false` and a reason naming the account, whatever its body says — the real
   Reviewer voids it at that tip with `Correction from Reviewer:`. The rule is the account type and not a login
   list: every Bot writes as the shared `Birfy` account, so a list containing it would void the whole pipeline.
   `cursor[bot]`'s report at #940's tip is the case (`Correction from Reviewer`, [comment `6381646389`](https://github.com/ThinkFlowLab/FlyBot/pull/940#issuecomment-6381646389)).

7. **The report can be signed by the workstation it names, and today it is not** (#1110, #1111):
   `Signed-by:` + `Nonce:` + `Signature:` against `.github/agent/signers.json` for the full head being judged
   is built and switched **off** — the policy has no `signers` roster and the signers file does not exist, so no
   conclusion is asked for those lines and none is dropped as `unverified:`. See [Signed conclusions](#signed-conclusions-1110)
   below: it documents dormant code, not what the gates do today.

#### Signed conclusions (#1110)

One shared GitHub identity makes `Written-by:` a claim, and #1110 built the check that would prove it: a
conclusion **signed by the workstation it names**. That check is in `main` and **not enabled** — no
conclusion is signed today. Everything below describes the mechanism as written, so that the day the switch
is turned on the behaviour is already documented; it is not what the gates do now.

The switch is a pair: the roster of workstations that must sign is the `signers` list in
[`review-policy.json`](../.github/agent/review-policy.json), and the public keys live in
[`.github/agent/signers.json`](../.github/agent/signers.json). Today `review-policy.json` has no `signers`
key at all — the code reads a missing or non-array value as an empty roster — and the signers file does not
exist, so the verifier is never asked for a key and an unsigned `Verdict:` is judged exactly as it
was before #1110. The owner decided on 2026-10-25 not to introduce per-workstation keys
([#1111](https://github.com/ThinkFlowLab/FlyBot/issues/1111), closed `not planned`) — a decision, not a
pending step. Three cheap gates stand in its place (a conclusion must name the **current** tip, one
conclusion per tip, and `Attestation:` as a self-report), with one accepted residual risk: one shared
`Birfy` identity still allows a forged `Verdict: PASS` from inside, and those gates catch stale-sha and
replay accidents, not deliberate forgery.

When it is switched on, each reviewing workstation holds one Ed25519 private key in its own secret
(`DSH_SECRET_VERDICT_KEY_<WORKSTATION>`) and a report adds three lines under its attribution:

```text
Signed-by: Reviewer
Nonce: 3f8c1a9e5b2d4706
Signature: <base64url Ed25519 over the canonical string>
```

The signed string is `FBV1|<owner>/<repo>#<pr>@<VERDICT>@<full 40-character head>@<workstation>@<nonce>`
([`verdict-signature.mjs`](../.github/scripts/verdict-signature.mjs) `canonical`). Every field closes one
replay: the repository and pull request number stop a report moving to another pull request, exactly 40
characters of sha stop it moving to another tip (a 7-character sha is a prefix of many heads, #1112), the
verdict stops an INC being replayed as a PASS, the workstation stops one workstation's signature reading as
another's, and the nonce stops the same signed text standing as a second conclusion. A short sha on the
`Verdict:` line is **not** signed: the gate fills in the head it is judging, so a signature can never be
lifted onto a tip its author did not see.

It is fail-closed and one cut. When the policy lists signing workstations, a `Verdict:` whose signature
does not verify **is not a conclusion at all**: it does not pass, it does not join the newest-wins scan, and
it does not refuse an older PASS — the summary lists it as `unverified:`. There is no unsigned fallback in
that mode, so the honest cost is that an unsigned INC no longer holds a merge either — which is exactly why
the roster is still absent and was declined on 2026-10-25 ([#1111](https://github.com/ThinkFlowLab/FlyBot/issues/1111),
`not planned`), and why the gate is inert rather than half-on. A roster with a missing or unreadable
signers file, or a workstation whose key is missing or does not parse, is a **configuration error** and
refuses every pull request: half of that pair is never read as "unsigned is fine". The signature is not a
permission — the association, `writers`, `reviewers` and bot-account checks run exactly as before, and the
conclusion never reached the reviewed-tip job at all: the signed lines sit in the header, where the author
attestation (#644) also lives, so a body can carry both and the two refusals stay separate.

When it is enabled, a workstation signs with its own key, which never leaves its secret card:

```sh
node .github/scripts/sign-verdict.mjs --repo ThinkFlowLab/FlyBot --pr 1132 --verdict PASS \
  --workstation Reviewer --head <full 40-character head>
```

**Attribution (#627).** Every state-changing write says who wrote it: `Written-by: <Bot>` is its first
line, and a conclusion puts it on the second, under the fixed verdict line. `decide` refuses a report
with no such line and, separately, one whose name is not in the policy's `writers`; Triage reports a
write without one instead of editing it. The rule itself lives in AGENTS.md — one shared GitHub identity
makes the line a self-report, so the gate guarantees presence, not truth (#633). The signature above would
close that gap — the line still claims, the key would prove — and it is not enabled (#1111 `not planned`).

| File | Purpose |
| --- | --- |
| `.github/agent/review-policy.json` | the logins whose PASS counts, `selfReview`, the authors who may PASS their own PR, and `writers`, the Bot names a `Written-by:` line may carry (#627) — a roster, not a permission: `reviewers`/`selfReview` are the permission lists (#962); editing it is T3. `signers` lists the workstations that must have a public key (#1110); there is no such key in the file, which is what keeps signing off (#1111) |
| `.github/agent/signers.json` | one Ed25519 public key per signing workstation, base64url DER SPKI from `openssl pkey -pubout -outform DER` (#1110); private keys never enter the repository. The file does not exist today: creating it together with a non-empty `signers` roster is what turns signing on (#1111) |
| `.github/scripts/review-gate.mjs` | the rule above, for one pull request at a time |
| `.github/scripts/verdict-signature.mjs` | the canonical string, the signature lines, `loadSigners` and `verifyReport` — one implementation for the gates, the signer and the tests (#1110) |
| `.github/scripts/sign-verdict.mjs` | what a workstation runs to sign its own conclusion; reads its own secret, never prints a key (#1110) |
| `.github/scripts/review-gate.test.mjs` | stale tip, self-review (allowed only for a `selfReview` author, and only with an `Attestation:` line when that login is the author, #644), unlisted login, FAIL after PASS, missing `Ran:` (a missing `Not run:` no longer refuses), a missing `Written-by:` line and one naming an unlisted writer (#627), a `selfReview` login counting only on its own pull request (#928), a `selfReview` admin on someone else's pull request (permission API, `CONTRIBUTOR` stamp), a `CONTRIBUTOR` who is neither still refused, and the workflow's shape |
| `.github/scripts/verdict-signature.test.mjs` | a real signature counting, a missing `Signed-by:`/`Signature:`/`Nonce:`, another workstation's private key, a replay onto another tip and one with another nonce, a signed and an unsigned INC, the configuration errors, a bot account with a valid signature (#943 survives), the author attestation and the signature staying separate refusals (#1148 + #1110), and the four impersonated PASSes from #1094/#1095/#1108/#1115 read as unverified (#1110) |
| `.github/workflows/review-gate.yml` | reports it in the job summary; `continue-on-error`, never required |

Run it by hand (read-only API calls with your `gh` login):

```sh
node .github/scripts/review-gate.mjs --pr 215 --repo ThinkFlowLab/FlyBot
node .github/scripts/review-gate.mjs --pr 215 --sha <other head>   # judge a tip that is not the head
```

The workflow is safe the same way `risk-tier.yml` is: `pull_request` (never `pull_request_target`),
a read-only token, no secrets, and the script and policy checked out from the **base** commit, so a
pull request cannot change the rules that judge it. The one exception is the pull request that adds
the script: the base has none, so that run falls back to the PR's copy under the same read-only
token. It is **not** a required check and must stay out of branch protection and out of `tests-ok`'s
`needs` (a test checks the `needs` half; branch protection is a live setting), so a pull request
without a PASS still needs its own review before the gating agent merges it.

**Why report-only.** The owner's reviewer Bot/agent acts as `Birfy`, which is in the policy (and in `selfReview`), so
its report can satisfy the gate on a pull request the same account opened — the review comes from a different Bot than
the implementer ([`AGENTS.md` → Merge gates](../AGENTS.md#merge-gates)). Nothing here blocks or merges: it is evidence an
agent reads, and the record a later enforcement step is checked against.

**Silent revert (#914).** A pull request built on an old copy of `main` re-uploads whole files, and work `main`
merged after the branch was cut disappears — with `mergeable: true` and `tests-ok` green, because the deletion *is*
the pull request (`#887` deleted `#869`'s 84 test lines the same hour; `#907` deleted `#909`'s whole fix 40 minutes
after it merged). [`.github/scripts/silent-revert.mjs`](.github/scripts/silent-revert.mjs) reads the rule off git:
`base = merge-base(origin/main, HEAD)`, `A` = the lines `origin/main` added after `base`, `D` = the lines the pull
request deletes from `origin/main`, and `A ∩ D ≠ ∅` is a silent revert — reported per file with the count and the
commit that added the line to `main`. It runs as a step of `merge-gate.yml` on `pull_request` only, from the
**base** copy of the script, with a full-history checkout of the head (`fetch-depth: 0` plus an explicit
`origin/main` fetch), and writes one `::warning` per file and a total line `silent-revert: N finding(s) on M
file(s)` to the job summary — including `silent-revert: 0 finding(s) on M file(s)` when it is clean, so a run that
read nothing is not confused with a run that found nothing. Report only: `continue-on-error`, never a comment, a
label or a required check, so a legitimate revert carries the report and a Reviewer decides. A pull request already
rebased onto `main` has `A` empty and reports zero by construction — which is also this rule's boundary: a **rebase
that resolves a conflict by keeping the older side** deletes the same lines but has `main` as its base, and stays
invisible to it (`#907`'s `d6e143a8` is that case). The check catches the stale copy, not the bad merge.

## Merge plumbing: `merge_group`, merge queue, auto-merge

`main` requires a **merge queue** (repository ruleset `main merge queue`, active since 2026-10-17). `test.yml` has a
`merge_group:` trigger, so every queue entry runs `Test`.

**The gates themselves** — `hold`, the newest-conclusion rule, and the `merge-gate` job that enforces both on a queue
entry — are in [`AGENTS.md` → Merge gates](../AGENTS.md#merge-gates). This section is only the plumbing.

**How to merge.** A direct `gh pr merge <n> --squash` is refused with `! The merge strategy for main is set by the merge
queue`; that is not a failure. Run `node .github/scripts/enqueue-guard.mjs --pr <n>` first — it re-reads the live head and
exits 1 on a `hold`, on a newest conclusion that is not a PASS, and on a report marked "record only — do not merge", so a
PASS is never a queue permit on its own (#602); on a live, non-draft pull request of ours it also refuses a body with no
`Owner:`/`Reviewer:` line in its first 20 lines (or a `Reviewer:` that is neither a `reviewers` login nor a `writers`
Bot name, or a Bot name whose shared `Birfy` identity is not in `reviewers`, #947, or a `Reviewer:` naming the same Bot as
the `Owner:`, compared per name after commas, `@` and case, #951; both lines need a value the policy knows — an `Owner:`
outside `writers` is refused and a line with no value is the missing line, so an empty `Owner:` cannot clear the
comparison, #951; and neither line may name the shared `Birfy` identity, the one value both vocabularies list and so the
one value that names no workstation, #1228), naming the missing line or the word
that missed both lists (#943) — a merged pull request is not re-judged, because this check also runs on every comment; the
same call refuses a body whose `## Checkpoint` block is missing or wrong, one field at a time ([AGENTS.md → The checkpoint
block](../AGENTS.md#the-checkpoint-block-a-hand-off-the-next-bot-can-read-1202), skeleton in
[`.github/pull_request_template.md`](../.github/pull_request_template.md), #1202); on success it prints the command and never runs it. Enqueue with
`gh pr merge <n> --auto --squash --match-head-commit <sha>` (gh has no `--merge-queue` flag). gh may still print the
strategy line, or `! Pull request #<n> is already queued to merge`; the PR is
then in the queue (`gh api graphql` → `pullRequest.isInMergeQueue`). The queue, not the agent, performs the squash merge
once `Test` passes on the `gh-readonly-queue/main/pr-<n>-<sha>` entry; do not retry. The queue waits up to 5 minutes
to fill a group and builds one entry at a time.

**The patrol that notices a bypass.** `.github/workflows/audit-merges.yml` runs `audit-merges.mjs` against `main` daily
and on `workflow_dispatch`, read-only. `--since` is the `head_sha` of its own previous successful run, so a merge that
skipped the queue prints as `bypassed queue:` and fails the run while an older one prints as `earlier bypass:` and does
not — the watermark lives in the Actions API and nothing is committed. Its first run passes `--baseline`, so the first
green run is the baseline and only a newer bypass turns it red ([#697](https://github.com/ThinkFlowLab/FlyBot/issues/697)).

### The gate on the code fork: a ruleset and a written check (#812)

The fork `Birfy/FlyBot` is where this team's pull requests are actually merged, and it had neither a ruleset nor branch
protection: `merge-gate.yml` reports on `pull_request` and never fails there, `pass-label` records a PASS and is not a
gate, and `enqueue-guard.mjs` only refused in a script somebody remembered to run. So a PASS was advisory, and #30
merged without `agent-pr`.

`.github/workflows/enqueue-guard.yml` writes the guard's own decision onto the pull request head as a check run named
`enqueue-guard`, and `.github/agent/merge-gate-ruleset.json` is the ruleset that requires it next to `tests-ok` on
`refs/heads/main`, with `bypass_actors: []`. Two properties make it a gate rather than a badge:

- **One definition.** The script calls `decidePull` in [`enqueue-guard.mjs`](../.github/scripts/enqueue-guard.mjs) — the
  same function behind the command the guard prints — so a rule added to the merge gate is enforced by the check without
  being restated. Green means exactly "the printed command would say ALLOW".
- **The queue entry reads the body too, best effort.** The merge queue does not require `enqueue-guard` today, so the
  required `merge-gate` check calls the same `guard()` for the pull request behind the entry: a body with no
  `Fixes #<n>`, no `Owner:`/`Reviewer:`, or no `agent-pr` refuses the entry, and `fork` comes from
  `pull.head.repo.full_name` so an external pull request keeps its exemption (#960). When the entry names no pull
  request, or the API no longer returns it, the run logs one line and lets it through: a wedged queue is worse than a
  missed judgement. `enqueue-guard.yml` runs on `merge_group` too and writes its check on the entry commit, which is
  what makes the context available to a queue rule; the ruleset itself is unchanged until that is proven.
- **It flips without a commit.** A verdict is a comment and a label is a label: neither starts a `pull_request` run for
  the head being judged, which is why the check is written through the API instead of being a job's own result.
  `external_id` is the head, so a re-judgement PATCHes that one run; a new commit is a new head and therefore a new run,
  and a green check never carries over.

`pull_request_target` is the trigger, not `pull_request`: a `pull_request` job from a fork is read-only and could not write
the check, while a required context that is never produced leaves that pull request on "Expected" forever (#639). The code
that judges is checked out from `main` (`ref: main`), no pull request code is fetched or run, and the only thing read from
the event is the number.

**Turning it on is sequenced, and it is the owner's call.** `node .github/scripts/gate-ruleset.mjs --check` reads the live
state and writes nothing; `--apply` creates or converges the ruleset and `--rollback` deletes it and proves it is gone —
both change repository protection, which no Bot does on its own (AGENTS.md → Hard rules). The order is: merge the
workflow, prove the check goes red on a pull request that is missing `agent-pr` and green on one that is complete, and
only then apply the ruleset. Applied first, every open pull request reads "Expected — waiting for status" and none can
merge. `--apply` runs `--check`'s assertions on what GitHub read back (`bypass_actors`, `current_user_can_bypass: never`,
both contexts, `strict_required_status_checks_policy: false` so one merge on `main` does not force every open pull
request to rebase).

**The patrol that keeps the labels honest.** A status label says what is happening to an item *now*, so it must not
outlive the item: on 2026-10-22 the board counted 11 closed issues and 43 closed pull requests as in flight, because
nothing removed `agent-working`/`agent-pr` when they closed. `.github/workflows/label-hygiene.yml` runs
`label-hygiene.mjs` daily and on `workflow_dispatch`, and it removes exactly the status labels in its `STALE_LABELS`
list — `bug`, `area:*`, `risk:*`, `hold`, `needs-*` and `status:done` are records and it never touches them, because
`hold` stays human-only in both directions. It asks once per status label (GitHub's `labels=` filter is an AND, so one
query for five labels would only find an item carrying all five), prints the `before:` count, applies, then reads the
repository back and prints `after:` — a non-zero `after:` fails the run, so the cleanup is verified rather than
trusted ([#738](https://github.com/ThinkFlowLab/FlyBot/issues/738)).

**What the trigger does.** A merge queue builds each entry on a `gh-readonly-queue/main/pr-N-<sha>` branch (a merge of
the PR onto the current `main`, plus the entries ahead of it) and merges only when the required checks pass on that
commit. Required checks are matched by name on that commit, so `Test` must run on `merge_group`; otherwise `tests-ok`
and the `test` job never report there and the entry waits until the queue's timeout. With the trigger:

- `test`, `plugins (tree)`, `plugins (social)`, `package` and `tests-ok` run unchanged. Nothing in `test.yml` reads the
  `pull_request` event, no job has an `if:` that would skip it, and `tests-ok` keeps `if: always()` and needs all three,
  so a skipped or failed job still makes it red (`.github/scripts/test-workflow.test.mjs` checks all of this).
- `merge_group` takes no path filters, so a docs-only entry runs in full. That is also why `paths-ignore` stays on `push` only.
- `push` stays limited to `main`, so a queue branch does not run twice. The concurrency group is per ref, so entries do
  not cancel each other, and every non-`main` ref (queue branches included) cancels its own earlier run.
- Queue entries run `Test` only. `pull_request`-only workflows (`risk-tier.yml`, the review gate) do not run on `merge_group`;
  that is intended, and they must stay out of the required checks, or every entry waits until the queue's timeout.
- The `arch-docs` step fetches `origin/main` and deepens until `git merge-base origin/main HEAD` works. Emulated on a
  one-commit shallow checkout of a merge-queue-shaped commit (local bare remote): it falls back to deepening and
  `arch-docs: OK`. With a group size above 1, `arch-docs` sees the union of the grouped PRs; keep the group size at 1. The trailer it looks for has to be in the pull request body as well as in the branch commit: on a queue entry the range it logs is the squashed body, and the refusal says so (#1076).
- Observed since the queue was enabled: `merge_group` runs on `gh-readonly-queue/main/pr-<n>-<sha>` pass and the PR merges (e.g. #217 → `38c00b4`, #235 → `7a3ccb3`).

**Read-only checks of the live repository (2026-10-15, rulesets re-read 2026-10-18; `gh api` GET with a maintainer login):**

| Fact | Value |
| --- | --- |
| Repo | public, owned by an Organization |
| Merge methods | squash only; `delete_branch_on_merge: true`; `allow_auto_merge: true`; `allow_update_branch: true` |
| Branch protection on `main` | required checks: the `test` job and `tests-ok`; `strict: false`; no required reviews; `enforce_admins: false`; no force pushes |
| Required check on the queue | `merge-gate` is a required check of the `main merge queue` ruleset (user decision 2026-10-22, #639), so it is the mechanical stop for anything that tries to skip the queue: `merge-gate.mjs` re-judges the pull request head on every entry |
| Rulesets | `main merge queue` on `refs/heads/main`, active, no bypass actors: merge queue (squash, build and merge 1 entry at a time, 5 min wait to fill a group, 60 min check timeout, `ALLGREEN`) and required checks `ubuntu-latest · Node 24 · DSH 0.2.0-rc.2` (the `test` job), `tests-ok` and `merge-gate` (job name, added 2026-10-22). The organization-level list needs the `admin:org` scope (not read) |
| Org plan | not readable: `plan` is `null` without `admin:org` |
| Workflow token | default `read`; Actions cannot approve PRs |

**Merge queue settings.** Keep the group size at 1 (see `arch-docs` above) and `tests-ok` the single aggregate check.
Changing the queue or the ruleset is a maintainer decision.

**Does an auto-merge by `GITHUB_TOKEN` start the `push` workflows? Unverified here; assume no.** GitHub documents that
events caused by `GITHUB_TOKEN` (except `workflow_dispatch` and `repository_dispatch`) create no workflow runs. Several
independent public reports say the same for `gh pr merge --auto` run with `GITHUB_TOKEN`: the merge is attributed to
`github-actions[bot]` and the `push` run on `main` never starts. A real test needs a PR that actually merges into
`main` (or a scratch base branch with its own protection), which was out of scope. Consequences and the safe design:

- The controller must **not** enable auto-merge (it is label-only anyway). Agents enable it with their own credential.
- If a merge ever lands without a `Test` run on `main`, start one with `gh workflow run Test --ref main`
  (`workflow_dispatch` is exempt from the rule; needs `actions: write`), so `release.yml` has a green run to wait for.
- Merges made by the merge queue itself **do** start the `push` run on `main`: #217 (enqueued with `gh pr merge --auto --squash`
  by an agent's own credential) merged as `38c00b4` and a `push` run of `Test` on `38c00b4` started and passed (#222).
- To check it once, with the maintainers' consent: merge one trivial PR with auto-merge enabled by the intended
  credential, then `gh run list --workflow Test --branch main --limit 3` should show a `push` run on the merge commit.

## Release beat watchdog (#1209)

The daily release is a timer on a workstation, and DSH runs only the latest missed occurrence after downtime: one offline minute at 02:00 Asia/Shanghai and that day's version is never published — no run, no log, no alert. `.github/workflows/release-beat.yml` (cron `30 18 * * *` = 02:30 Asia/Shanghai) is the outside observer for exactly that case.

1. **The metric is the newest `v*` tag.** `release.yml` triggers on `push: tags: ['v*']` and has no cron, so "a release run happened" is never a signal: a missed beat produces no run at all. The job takes the newest tag in semver order, resolves it (`git/tags` → `tagger.date` for an annotated tag, `git/commits` → `committer.date` for a lightweight one) and converts that instant to the Asia/Shanghai date. A tag dated the judged day is `ok`. A newest tag dated **after** the judged day is an `alert`, not an `ok`: `--date 2026-10-25` asks whether 10-25 got a tag, and a tag pushed on 10-26 is not one — only a dispatch onto an earlier day or a clock ahead of Asia/Shanghai lands there, and both are better seen than swallowed.
2. **One issue per day.** When no tag carries today's date the job files `Release beat missing: <YYYY-MM-DD>` with `bug` + `area:release`, naming the newest tag, how many hours ago it was, the newest `release.yml` run's link when one can be read, and where to look first — the routine's own catch-up. Before filing it searches that day's exact title, open **and** closed, so a rerun adds nothing.
3. **A release in flight is not a miss.** An open pull request titled `Release v…` writes a summary line and files nothing: CI being slow looks exactly like a missed beat otherwise.
4. **Failure is red, not a false alert.** An API error exits non-zero and files nothing, so one GitHub hiccup cannot leave an issue nobody retracts.
5. **`workflow_dispatch` takes `date` and `dry_run`** (default `true`), so the alert path can be proven the day it is built instead of the next morning.

The decision is a pure function (`decide({ today, latestTag, latestTagDate, openReleasePr })` in `.github/scripts/release-beat.mjs`); the search, the issue and the summary line live at the CLI entry, which is why `.github/scripts/release-beat.test.mjs` drives every branch without a network.

## Next phases (not built)

1. **Merge plumbing.** The queue is on and its merges start the `push` run (above). Still to do: test the push behavior of an
   auto-merge enabled with `GITHUB_TOKEN` (needs a scratch base branch). Conflict-proofing for generated files is a separate PR (patch format, changelog fragments, split core pages).
2. **Controller, label-only** (`schedule` plus `workflow_dispatch`, `GITHUB_TOKEN`): demote `agent-ready` after a
   non-maintainer edit, set `agent-pr` and `risk:T*`, expire stale claims, a pause variable and a kill-switch drill.
   Enforce the tier with a required check and CODEOWNERS for the T3 reviewer-tip check.
3. **Agents on a dedicated credential**, one open PR at a time, with the cost caps in one config file.
   Add any new reviewer's login to `.github/agent/review-policy.json` in the same change: until it is
   listed, its report cannot satisfy the reviewed-tip gate.
4. **Auto-merge T0/T1** on green CI (no PASS needed, owner decision 2026-10-19); T2/T3 stay behind a PASS at the tip, which the gating agent then merges itself (owner decision 2026-10-21). Then edge releases, a red-`main` watchdog, and T2 behind a smoke gate.
