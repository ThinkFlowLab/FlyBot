# AGENTS.md

Instructions for AI coding agents that work on this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md), which has the same rules with more detail.

## Before you code

1. Read [LESSONS.md](LESSONS.md) (open lessons are constraints).
2. Read [docs/code-standards.md](docs/code-standards.md) (Verifier honesty, fences, merge gate).
3. Keep the **Hard rules** below; never patch DSH or commit secrets.

## Pipeline contract

One issue → one branch → one PR → CI `tests-ok` → auto-merge (squash).

A person talks to the **Chief** (the Main Bot). The Chief hands the work to the stationary roles — **Triage**, **Dev**, **Reviewer** — each a Bot in the same tree, and each step below names the role that does it. OpenCode and Codex are gone (owner decision 2026-10-22): nothing requests `@codex review`, nothing waits for a Codex review, and no model route is prescribed here.

**An `@`-mention must produce one reply.** The member takes the work, points to who has it in a line, or says it cannot; silence is a defect, not "nothing to add" — the round record already keeps `passed` and `missed` apart, and #913 tracks the summary that merges them.

1. **Issue.** Work one issue per session and per git worktree. Skim LESSONS and code-standards first. Security debt first: [#9](https://github.com/ThinkFlowLab/FlyBot/issues/9) → [#10](https://github.com/ThinkFlowLab/FlyBot/issues/10) → [#8](https://github.com/ThinkFlowLab/FlyBot/issues/8).
2. **Branch from the live base, and prove it.** `git fetch origin && git switch -c <branch> origin/main` — never from a local `main` you did not just fetch. Prove the base before you write anything:

   ```sh
   git diff origin/main...HEAD --stat
   ```

   That output must list only files you changed. **Any file you did not touch means the branch sits on an older `main`: delete the branch and start again from the fetched tip.** Never stack the change on a stale base and never resolve the ghost files by hand. A stale base merges green and silently reverts what landed meanwhile: on #887 the branch restored an old `main` and removed the 84 test lines #869 had just merged, while the pull request page showed every check green (#864, #876, #887).
   `Dev` then writes a test that fails without the change, and fixes the class of bug.
3. **Verify locally:** `npm run verify` at the repo root (Node 22+, see Commands).
4. **PR** to `main`. Imperative English title, `Fixes #N` in the body, and what you ran and did **not** run at the tip SHA. A user-visible change adds one fragment `changelog.d/<issue-or-slug>.<kind>.md` ([changelog.d/README.md](changelog.d/README.md)); never edit `CHANGELOG.md` in a feature PR. Squash is the only merge method; the PR title and body become the commit message, so keep the body short.
5. **CI.** The required check is `tests-ok`. It is green only when `test`, `plugins (tree)`, `plugins (social)` and `package` all pass. Never merge around a red check.
6. **Gate, then queue.** Five checks, in this order. Each one can refuse.

   1. **Tier.** `node .github/scripts/risk-gate.mjs --pr <n>`, or quote the `risk-tier:` line of the job summary. **T0/T1** need green `tests-ok` at the tip, a mergeable pull request and design-conformance — no PASS. **T2/T3** need a **PASS at the tip SHA** written by the Reviewer ([`review-pr`](.claude/skills/review-pr/SKILL.md): PASS / FAIL / INC), never by the implementer ([Merge gates](#merge-gates)). Neither a PASS nor green CI replaces the other.
   2. **One conclusion per tip.** A tip carries at most one `Verdict:` block. A second conclusion at the same tip is an incident, not a better answer; a new commit voids the PASS **unless it changes no file of the reviewed change set** — a tip that moved only because `main` was merged in keeps it, and the guard names the sha it accepted and why (#1317); a correction reads `Correction from <Bot>: …` and is not a verdict.
   3. **Enqueue.** `node .github/scripts/enqueue-guard.mjs --pr <n>`, then `gh pr merge --auto --squash --match-head-commit <sha>`. The guard re-reads the live head and refuses (exit 1) on a `hold`, on a newest conclusion that is not a PASS, and on a report marked "record only — do not merge", so a PASS is never a queue permit on its own (#602). `main` requires a merge queue: the command enqueues the pull request (gh may answer `The merge strategy for main is set by the merge queue` or `already queued`), the queue performs the squash merge, and a plain `--squash` merge is refused — do not retry ([merge plumbing](docs/autonomous-dev.md#merge-plumbing-merge_group-merge-queue-auto-merge)).
   4. **Judge on the merge tree.** Whether the pull request can merge is decided on the queue entry — the pull request merged onto the current `main`, built and tested again — never on the pull request page. The page's green is the head alone: #759 was 9/9 green, was kicked out of the queue twice, and went red on `main` at `core/test/follow-through.test.js:264`.
   5. **Never bypass.** No admin-merge, no bypass, no ruleset change. A `Docs-not-needed:` line goes in the PR body as well as in the branch commit, and you check both at the tip ([why, and how](#docs-not-needed-why-both-places)). Run `verify` with `TZ=UTC`.

   Exception: a mechanical release PR under the [standing approval](#standing-approval-mechanical-release-prs) below. [`fix-issue`](.claude/skills/fix-issue/SKILL.md) walks all of this, with the environment gotchas.
7. **Stop** and hand over to the maintainer on a security-sensitive change, an unresolved maintainer decision, or when you cannot get a green tip.

When a class of bug repeats, date a lesson in LESSONS.md (`Seen N×`); after **≥3 days** promote the durable rule into `docs/code-standards.md` / CONTRIBUTING.

### Standing approval: mechanical release PRs

On 2026-10-19 07:02 (Asia/Shanghai) the maintainer, Danyang (GitHub `Birfy`), decided that FlyBot ships a real semver GitHub release daily (patch bump of the latest release, starting at `v0.2.0`, skipping a day with no changelog fragments), and grants a **standing approval** for the mechanical release PR, so the daily PR needs no fresh one-click approval. The approval is limited to a PR that changes only these files, and nothing else:

- `CHANGELOG.md` and `changelog.d/*`
- `core/package.json` and `core/package-lock.json`
- `patches/ds-bot/0007-version-and-tooling.patch`

It does not waive the checks: the PR still needs green required checks (`tests-ok`) at its tip SHA and the daily preflight (no release for that version yet, the latest `Test` on `main` green, at least one changelog fragment). Anything beyond those files needs a fresh review (a PASS at the tip) like any other PR.

### Owner decision: the Bot gates and merges its own PRs (2026-10-21, owner-authorized)

On 2026-10-21 the owner replaced the earlier "only a merge click in the UI is the approval" rule: a Bot that gates a PR itself may merge it into `main` itself, **including T2 and T3**. The gate is the review, not a person's click — `tests-ok` green at the tip, a PASS at that same tip, mergeable and design-conformant, through the merge queue, as the `Birfy` account. It never admin-merges, never force-pushes `main`, never bypasses a check, and never removes a PR the owner put in the merge queue.

**Admission line — only two kinds of work get a PR at all:**

1. a fix for a reproducible real defect (with a minimal reproduction or an equivalent test), or
2. something the routine work itself needs.

Such a PR needs `tests-ok` green at the tip **and** a test that fails when the source change is reverted. A new commit at the tip voids the PASS and the review is repeated.

**One PR per issue.** When an issue already has a pull request, keep working in that one: re-base its branch, use `update-branch`, or push a new commit to its head, and add the tests there too. Never open a second PR and close the first — that is what produced a trail of superseded PRs. A contributor's fork is treated the same way while it allows maintainer edits. The only exception is a branch that cannot be pushed (maintainer edits off, or the author is gone and the branch is unusable): then a new PR is allowed **and the reason goes on the issue** — never a silent swap.

Anything else is not opened, not queued and not reviewed: pure UX polish, new configuration keys, design proposals. Leave them in `needs-human`, or close them with the reason written down, and report them in one batch instead of one at a time.

**Still report to the Chief first** (who asks the owner): a vague scope, a change on the security surface (secrets, permissions, sharing), or a policy change the owner can feel. The routines keep their own bottom lines: no production deploy without consent, no touching the owner's own machine, never print a secret, never open an issue on someone else's upstream, never remove a PR the owner put in the merge queue.

### Conflict recipe (generated files)

`core/` is the source of truth; `patches/ds-bot/` (`*.patch` and `files/`) and `core/client.js` are generated from it. Never hand-merge them. The patch format is merge-friendly (no `index` lines, no counts that depend on other edits, new files stored whole in `files/`), so two PRs that touch different parts of one core file usually merge without a conflict in `patches/`; the steps below are for when they do not.

```sh
git fetch origin && git merge origin/main        # or rebase
# 1. Resolve conflicts in real sources by hand (core/src/**, core/index.js, tests, docs).
# 2. Take main's version of the generated patch files (generate rewrites patches/ds-bot/ entirely):
git checkout origin/main -- patches/ds-bot
# 3. Regenerate from the merged core/, then check:
(cd core && npm run build)                       # client.js, carried by patch 0008
node scripts/ds-bot-patches.mjs generate
node scripts/ds-bot-patches.mjs check
npm run verify
```

If `topics.json` conflicts, keep both sides' entries (one patch per edited upstream file; a new file needs none).

## Agent operating model

Decided by the owner (Danyang, GitHub `Birfy`) on 2026-10-18/19; what runs today is two routines on a timer and the rest in rounds. A routine has one job and does only that job. Every write a routine makes carries the `Written-by:` line ([rule](#every-state-changing-write-says-who-wrote-it-627)).

### Routines

| Routine | Runs | Job |
| --- | --- | --- |
| Product self-test | timer, 09:00 and 21:00 Asia/Shanghai | Uses FlyBot and Bot Social as a user and **only files issues**: no PRs, no pushed branches, no code changes. Each issue states the expected behavior and the change scope. Search for duplicates first. |
| Repo maintenance | a round in the delivery group, no timer | The **only** routine that opens fix PRs. Each run: review open PRs against the design rules; triage every open issue (fixed, duplicate or obsolete: close with a comment; still valid: readiness check below); label every open issue and PR; develop only `agent-ready` issues; merge ready PRs through the merge queue within the gates below. Never deploys. Never edits `CHANGELOG.md` or a version number. |
| Daily release | timer, about 02:00 Asia/Shanghai | Publishes a real semver GitHub release (tag = `core/package.json` version, patch bump per day, skipped when there are no changelog fragments) through a mechanical release PR. It owns `CHANGELOG.md` and the version. The files and the approval are in [Standing approval](#standing-approval-mechanical-release-prs). The release pull request is opened upstream, merges through the queue, and the tag goes on its merge commit; the fork is an archive: [docs/release-runbook.md](docs/release-runbook.md). |
| Release beat watchdog | timer, 02:30 Asia/Shanghai | Outside check for the row above: reads the newest `v*` **tag** (never a workflow run — `release.yml` has no cron, so a missed beat produces no run at all) and files one `Release beat missing: <date>` issue when no tag carries today’s Asia/Shanghai date. A `Release v…` pull request still open only writes the summary; the day is searched first, open or closed, so a second run adds nothing; an API failure goes red without filing. Nothing here touches `release.yml`. [`.github/workflows/release-beat.yml`](.github/workflows/release-beat.yml), [#1209](https://github.com/ThinkFlowLab/FlyBot/issues/1209). |

**Only the three rows marked *timer* self-trigger.** Maintenance, triage and review run as rounds in the delivery group — Triage lists what is open, Dev claims one item and pushes a tip, Reviewer judges that tip, the Bot that gated it enqueues — and hold no cron entry. So a quiet period means no round ran, not that a routine is broken. A timer belongs to a Session, not to a Bot (#628): read `bot_schedules` before saying anything about which timers a Bot has.

### Read the board once per round (#796)

One read of the open state per round — issues, pull requests, checks — is the budget, not a step to repeat. Whoever reads it writes the facts down where the next Bot will look: the pull request body or a comment, as text. Nobody else re-pulls the same list, restates it in a group chat, or pastes more than five lines of a log; they read the comment. A second opinion needs a second question, not a second fetch. #796 measures what a round actually costs.

#### One round-trip per new fact (#796)

**Spend a round-trip on what is new.** A round-trip exists to bring back something the room did not have — spend it on all of it at once, and never on what it already has. Independent reads go in one call: one `bash` that runs the greps and the API calls the question needs, one call that reads the files, not three round-trips of one read each. A fact already read is quoted from the last answer with its anchor, and the line above about a list holds for every read.

**A round-trip carries its facts out in the same message:** the tip sha it saw, the CI state at that tip (green, or the failing check and its reason), and which files it read. That is what the next Bot acts on; a round that brings back less leaves it to open one to ask.

**An empty round-trip looks like this:** "let me take a look and get back to you" followed by a turn that reads only what the previous one read; a second `gh pr view` to confirm what the verdict already said; three rounds of one `grep` each. Every one of those re-sends the whole context — ~150k tokens on this machine — and the count multiplies: #796 measures 7.4 model calls per member-turn, 6.8 members woken by one group message, 13,136 calls and 1.96B prompt tokens a day, so a round the room did not need is paid once per member that repeats it.

#### A schedule is per session, not per Bot (#628)

`schedule_list` answers for **the session the call runs in**, not for the Bot. A schedule the owner created in another session of the same Bot is simply absent from the answer, and nothing in the response says which session it answered for — so `[]` is indistinguishable from "nothing is scheduled". This cost two wrong conclusions on 2026-10-21: a Bot reported "0 timers" and the team concluded a live schedule had never existed, and another run came close to deleting and recreating a schedule that was running.

**An empty `schedule_list` is not evidence that a schedule does not exist; never delete or recreate a schedule from it, and never report "no timers" as a finding.** The owner's UI shows the real list; ask the owner instead of the tool when the run depends on it. `schedule_delete` and `schedule_update` share the same scope, so a Bot can otherwise "clean up" a schedule it cannot see. The DSH-side fix is tracked in #628.

**`bot_schedules` (no arguments) is the Bot-wide list.** It reads DSH's host-wide catalog and keeps every Session that speaks for the calling Bot — its own chat, the earlier parts of it, the group chats it speaks in, and a group chat's own Session for the tasks the owner set for that group (to its members only) — plus its paused tasks, with each task's id, title, next run, state and owning Session. Read that tool before saying anything about this Bot's timers; DSH's `schedule_list` stays per Session, and the DSH-side scoping fix is still tracked in #628.

### Issue labels

- **Type** (exactly one): `bug`, `enhancement`, `documentation`, `accessibility`.
- **Area** (one or more): `area:social`, `area:ui`, `area:automation`, `area:release`, `area:security`, `area:docs`.
- **Source:** `self-test`.
- **State:** `needs-info` (spec unclear), `needs-human` (needs a design decision from the owner; the comment says what), `agent-ready`, `agent-working`, `agent-pr`, `hold`.
- **Controller-managed, never set by hand:** `risk:T0` to `risk:T3`, `agent-task`, `status:done`.
- **A `risk:T*` label is advisory, and never the tier a decision uses.** The controller is a poll: GitHub delays scheduled runs by hours (2.5–6 h spacing observed on this repository, [#629](https://github.com/ThinkFlowLab/FlyBot/issues/629)), and a fork PR's `pull_request` run has a read-only token, so it cannot label one at all. An open PR can therefore carry no tier until the next run, and a PR opened and merged between two runs never gets one. Read a missing label as "not polled yet" — never as T0/T1 and never as a reason to block. The tier that decides is the one `merge-gate` recomputes from the diff at merge time, and `risk-tier.yml` reports the same tier on every PR.
- **The computed tier is readable from the job summary.** `risk-tier.yml` ends its summary with one machine-readable line — `risk-tier: T3; basis: AGENTS.md=T3, …` — built by the same `judge()` call that prints the report, so the line and the prose cannot disagree. Quote that line instead of guessing a tier. The workflow itself never writes a label, and no review transcribes a tier onto a PR: the controller copies it on its next poll (#609).
- `hold` means automation leaves the item alone.

### Triage: when an issue is `agent-ready`

Label `agent-ready`, with a triage comment, only when all three hold:

1. Every design conflict is resolved (owner design rules, recorded owner decisions, RFC/decision issues, other open issues and PRs), with no open question for the owner.
2. The expected behavior and the change scope are clear.
3. It is not `hold`, not a tracking/umbrella issue, and not team-via-groups work (that waits for the owner's go-ahead).

Otherwise label `needs-human` or `needs-info` and name the blocking conflict or question in a comment. Agents develop **only** `agent-ready` issues.

While checking labels and state, a write that carries no `Written-by:` line gets one comment naming it; the audit never repairs someone else's text by editing it ([rule](#every-state-changing-write-says-who-wrote-it-627)).

### Claim, PR, release of a claim

- Before work: skip the issue if someone else is assigned. Otherwise assign it to `Birfy`, add `agent-working`, and post a claim comment that names the branch.
- Stopping without a PR: unassign, remove `agent-working`, and comment why.
- The PR says `Fixes #N`, is assigned to `Birfy` and labeled `agent-pr`.

#### Claim one line (#1213)

**Claim one line.** When you claim a card, post one line in the room naming the card and the first step — `Claimed #1234 — first step: the pure path builder`. That is the only status line required. Progress stays on the board (`track_tasks`); per-step updates, "running the tests", CI state, queue state and verdicts never come back as chat text, and a verdict is posted once as a verdict.

The rule is here because the norm we wrote made silence the default: the group notice said progress lives on the board, members did exactly that, and on 2026-10-26 two of them worked most of an hour with live cards while the room showed nothing — the owner read the silence as idle. The claim line is the one moment a reader needs, and a presence line cannot supply it: presence shows a turn in flight, not a card claimed with the pull request still to come.

### Every state-changing write says who wrote it (#627)

The owner kept one shared GitHub identity for every Bot (2026-10-21), so attribution is text and only text. Every state-changing write — an issue comment, a PR body, an issue body, a merge-queue note — carries **`Written-by: <Bot name>`** as its first line, e.g. `Written-by: Reviewer`. A **conclusion** is the one exception, because [`parseReport`](.github/scripts/review-gate.mjs) reads the first non-empty line as the verdict (#637): its first line is `Verdict: … at <sha>`, `Written-by: <Bot>` is the second line, and a relay adds `Posted-by: <Bot>` third without changing anything else. A scheduled routine quotes this rule and does not restate it.

The gate refuses what it can check, and fails closed. [`review-gate.mjs`](.github/scripts/review-gate.mjs) — and [`merge-gate.mjs`](.github/scripts/merge-gate.mjs), which imports its `decide`, so a queue entry is judged by the same rule — refuses a report that carries **no** `Written-by:` line, and refuses one whose name is **not** in the policy's `writers` list. Two separate refusals, so the log says which defect fired. The list is a roster, not a permission: it registers the names a write may carry, while `reviewers` and `selfReview` are the permission lists (#962). Triage names a write that carries no such line in one comment and never repairs it by editing someone else's text.

The gate reads a conclusion only from someone tied to this repository (#676): `author_association` `OWNER`, `MEMBER` or `COLLABORATOR` (org repositories do not report `OWNER`), the pull request's own author when that login is in `selfReview` (#928), or a login the permission API reports as admin. The permission API is for an admin GitHub did not tie to the repository — a `CONTRIBUTOR` stamp on someone else's pull request — not for the own-author carve-out. That own-pull-request PASS is already `selfOnly` (#926, #928); the lookup does not recover it. A `CONTRIBUTOR` who is none of those is not a conclusion, so a passer-by's `Verdict:` can neither pass nor hold a merge. A missing association is not assumed, and a failed permission lookup is not admin. The lookup uses the token the job already has, and only for a Tip+Verdict conclusion by a login in `reviewers` that is not already `OWNER`, `MEMBER` or `COLLABORATOR`. A `selfReview` login is skipped only on that author's own report, because the shipped policy lists every reviewer in `selfReview` and skipping the whole list would never call. Admin does not skip the reviewers list or the own-author rule. The two qualifications do not replace each other: `selfReview` answers only whether an author may review their own pull request and gives that login no right on anyone else’s, while admin is read only through the permission API and only for a login already in `reviewers`.

What this buys is presence and a name from a closed list, not truth: with one shared identity the line is a self-report that can be left out (refused) and can name the wrong Bot. **The signature that would close that gap is shipped and not enabled (#1110, #1111).** The verifier, the `Signed-by:` / `Nonce:` / `Signature:` lines and [`sign-verdict.mjs`](.github/scripts/sign-verdict.mjs) are in `main`, but its switch is the `signers` list in [`.github/agent/review-policy.json`](.github/agent/review-policy.json), which holds no workstation at all, and [`.github/agent/signers.json`](.github/agent/signers.json) does not exist — so no conclusion is asked to carry those lines today and an unsigned `Verdict:` is judged exactly as it was before #1110. The owner decided on 2026-10-25 not to introduce per-workstation keys ([#1111](https://github.com/ThinkFlowLab/FlyBot/issues/1111), closed `not planned`): a decision, not a step still to come. Three cheap gates stand in its place — a conclusion must name the **current** tip (a moved tip voids it), one conclusion per tip, and `Attestation:` as a self-report. The residual risk is stated, not solved: one shared `Birfy` identity still allows a forged `Verdict: PASS` from inside, and those three gates catch stale-sha and replay accidents, not deliberate forgery. Turning the signature on later takes two configuration lines and one key per workstation; the rules for that day are in [docs/autonomous-dev.md → Signed conclusions](docs/autonomous-dev.md#signed-conclusions-1110). The write layer knowing the writer is the DSH-side half, #633.

### Gates

- **T0 / T1:** merge through the merge queue once `tests-ok` is green at the tip, the PR is mergeable and design-conformant. No PASS is required.
- **T2 / T3:** a PASS at the head commit from a reviewer in [`.github/agent/review-policy.json`](.github/agent/review-policy.json), with green CI, and the agent that gated it then enqueues it itself ([self-gate](#owner-decision-the-bot-gates-and-merges-its-own-prs-2026-10-21-owner-authorized)). **T2 and T3 need no maintainer approve** (user decision 2026-10-22): no human `APPROVED` review is read or required, and `merge-gate` re-judges the head on the queue entry. **Self-PASS across Bots counts:** a PR opened by the owner's Bot/agent (`Birfy`) may be PASSed by the owner's own reviewer Bot/agent (the policy's `selfReview` list) — the shared account is why that list exists, not a licence for an implementer to review its own pull request. Neither the PASS nor green CI replaces the other. When that PASS is posted by the pull request author's own GitHub login, it also carries the attestation in [Merge gates](#merge-gates) (#644).
- **A PASS must list what it ran.** The `Ran:` line (or a `Ran …:` heading over `$ ` commands) carrying at least one real command is part of the gate, not a nicety: `merge-gate` refuses a PASS that lists none (#681, #574). When a PASS at a tip cannot be read for that reason, the reviewer may post **one replacement PASS at the same tip**: its body keeps the original conclusion, adds the `Ran:` lines of what was actually run, and carries `Replaces: the PASS at <sha> merge-gate rejected for having no Ran: line`. That is a replacement, not a second conclusion — apart from it, one tip still carries one.
- Any new commit voids a PASS, unless it changes no file of the reviewed change set: a tip that moved only by merging `main` keeps the conclusion, and the gate names both shas and the comparison it made (#1317). CI green, the merge queue and the no-bypass rule apply to every tier.
- Agents never bypass a gate and never admin-merge (the routines run as the maintainer account `Birfy`, but use it only for the actions above, never for admin merge, bypass or changing protection rules). Run `verify` with `TZ=UTC`.

### Merge gates

**T2 and T3** take one path into `main`: a PASS at the tip that lists the commands it ran, every required check green at that tip, and `merge-gate` re-judging the pull request head when the entry reaches the queue. **T0 and T1** take the same path without the PASS. The queue is the only route in — `merge-gate` is a required check of the `main merge queue` ruleset, so a ref push that never built a queue entry cannot land.

- **T2 and T3 need no maintainer approve** (user decision 2026-10-22 07:15Z). A human `APPROVED` review is not one of the gates and nothing reads one; the tier decides how closely a change is reviewed, not who signs it off.
- **No implementer writes the Verdict.** On the API side self-review cannot be told apart mechanically — every pull request is opened by the shared `Birfy` account, and `selfReview: ["Birfy"]` in [`review-policy.json`](.github/agent/review-policy.json) makes a PASS always look like Birfy judging Birfy — so what the team holds is the role split: the implementer Bot does not write the Verdict, the Bot that writes the Verdict neither changes the tip nor re-judges its own verdict, and `selfReview` stays as it is because clearing it would leave every pull request without a conclusion.
- **An author-login comment is not a review (#644, option B, first slice).** When the conclusion's GitHub login is the pull request author, `selfReview` is not enough. The header — the lines before the first blank, and within the first eight non-empty lines — carries `Attestation: <40-character sha> role=<Bot>`. The sha is the whole tip (#1112). `role` is the `Written-by` name. That role is not an `Owner:` of the pull request. A free-form comment, a `Verdict:` with no attestation line, a line after the blank, a short sha, a role that is not the `Written-by` name, or a role that is the Owner refuses. A conclusion from a different GitHub login is unchanged. `decide` in [`review-gate.mjs`](.github/scripts/review-gate.mjs) is the check, and the reviewed-tip job, `enqueue-guard` and `merge-gate` all call it. The line is parsed, not signed. A signature was carved out later (#644) and is shipped but not enabled (#1110, #1111): the `signers` roster is empty, so no conclusion is signed today. T0/T1 still need no PASS.
- **`hold` is human-only.** Only a person sets the label and only a person lifts it; automation refuses a held pull request and never removes the label itself. That is the one human input left on the merge path.
- **The label awaiting-approval is retired.** A PASS at the tip goes straight to the queue through the enqueue guard (#687); no pull request waits for an approval click and the label is not set again.
- **A pull request enters the queue with its issue and its `agent-pr` label.** On a branch this repository owns, the enqueue guard also refuses one whose body names no issue (`Fixes #<n>` / `Closes #<n>`) and one without the `agent-pr` label (#718), so "one issue, one pull request" is checked rather than remembered. It refuses a **live, non-draft** request whose body carries no `Owner:` line or no `Reviewer:` line in its first 20 lines, or a `Reviewer:` that is neither a `reviewers` login nor a `writers` Bot name, or that names nobody who can record a PASS — a Bot name counts only through the one identity every Bot writes as, `Birfy`, so it names nobody while that account is outside `reviewers` (#947); a `Reviewer:` that names the same Bot as the `Owner:` is refused too, compared name by name after commas, a leading `@` and case are normalised, because one Bot owning and reviewing the same pull request is the shape #940 had with no lines at all (#951); both lines also need a value the policy knows — a `Reviewer:` outside both vocabularies and an `Owner:` outside `writers` are refused, and a line with no value is the missing line, so an empty `Owner:` cannot clear the comparison (#951); neither line may name `Birfy`, the one identity every Bot writes as, because it is the single value both vocabularies list and so names no workstation at all (#1228); the refusal names the missing line, or the word and the list it missed (#943, #947, #951; #940 merged in about seven minutes with the largest diff of the day and neither line). A **merged** pull request is never re-judged: this check also runs on every comment, and history is not a request. Two exemptions: a mechanical release PR, which carries neither by design, and a **fork** (`pull.head.repo.full_name` is not this repository), whose head we cannot push to and where the contributor keeps their own workflow.

**`enqueue-guard` writes a check on the head, and the queue's ruleset does not require it** (#812, re-read 2026-10-24). Team pull requests merge upstream in `ThinkFlowLab/FlyBot` through the `main merge queue`, whose ruleset requires three contexts — `Node 24 · DSH 0.2.0-rc.2`, `tests-ok` and `merge-gate`; the paragraph below (#960) is how `merge-gate` reads the body the queue does not read. `enqueue-guard` still runs on that head, and on the queue entry: [`enqueue-guard.yml`](.github/workflows/enqueue-guard.yml) takes its code from `main` and never from the pull request, on every event that can change the answer for a fixed head — a push, a label added or removed, a comment, a review body, or a manual run — and calls [`enqueue-guard.mjs`](.github/scripts/enqueue-guard.mjs)'s own decision, the same function that prints the command, so the check and the command cannot disagree. It refuses a head that carries a `hold`, a pull request with no `agent-pr`, or a body that names no issue, and — **for T2 and T3 only** — a head that has no PASS naming that exact tip or a PASS that lists no `Ran:`; a T0/T1 change and the mechanical release pull request need no PASS at all, because the tier is computed from the diff and never read from a `risk:T*` label (#640). A new commit is a new head and a new check run, and a green check never carries over.

**Historical: the fork's own ruleset (#812, used until 2026-10-23).** While the team's pull requests merged on the code fork `Birfy/FlyBot`, that repository's `main` required two contexts — `tests-ok` and `enqueue-guard` — with `bypass_actors: []`, so `PUT /pulls/<n>/merge` was refused (405/422); [`merge-gate-ruleset.json`](.github/agent/merge-gate-ruleset.json) is that protection, and `node .github/scripts/gate-ruleset.mjs --check` still reads a repository's live state and writes nothing. The fork is an archive now — nothing merges into it — so those two contexts are not this repository's gate, and `--apply` / `--rollback` are not part of any routine — no Bot runs them — and the ordering instruction that came with them (the check had to report on every open pull request before the ruleset went on) described that fork alone.

**The queue does not read the `enqueue-guard` context here, so the required `merge-gate` reads the body too** (#960). On `merge_group` the queue entry is judged by `merge-gate.mjs`, which now also calls the guard's own `guard()` for the pull request behind the entry: the `Fixes #<n>` line, the `Owner:`/`Reviewer:` lines and the `agent-pr` label are refused there with the guard's own reasons, and `fork` is read from `pull.head.repo.full_name` so an external pull request keeps the exemption #711/#713 gives it. It is **best effort by design**: when the queue branch names no pull request, or the API no longer returns it, the run logs one line and lets the entry through — a wedged queue is worse than a missed judgement. `enqueue-guard.yml` also runs on `merge_group` and writes its check on the entry commit the queue merges, so the context exists where a queue rule would look for it; the `main merge queue` ruleset is **not** changed by this — it still requires three contexts (`Node 24 · DSH 0.2.0-rc.2`, `tests-ok`, `merge-gate`), and adding `enqueue-guard` stays the separate decision #960 describes.

Four rules decide what a queue entry must pass. The mechanical judge runs where the merge actually happens: [`merge-gate.yml`](.github/workflows/merge-gate.yml) fails the `merge-gate` job on a `merge_group` entry, and [`merge-gate.mjs`](.github/scripts/merge-gate.mjs) does the judging.

1. **`hold` blocks mechanically.** A pull request labelled `hold` fails `merge-gate` on its queue entry. The label is only a marker; the job is the gate, and it is a required check of the `main merge queue` ruleset (#639, set 2026-10-22), so the refusal holds the entry.
2. **Labelling a pull request `hold` means adding a record.** Add the label **and** post a new comment saying **Record only — do not merge / 仅记录、禁止入队**. The pair is what holds it. Add that comment; never edit or delete an earlier PASS report to change what it said — the history is the record, and rewriting it is the thing that reads as an incident afterwards.
3. **An authorisation is not a queue permit.** The owner or the Chief saying "let it through", "claim it" or "handle it along with the rest" licenses no specific pull request for the queue. Entering the queue is an explicit action on that one pull request, after its own gate passed, while it carries no `hold`. #566 is the case this exists for: "handle it along with the rest" was read as a permit, the tip was PASSed at 09:48:18Z, enqueued at 09:48:28Z and merged at 09:50:40Z as `abaf938b`.
4. **The newest conclusion at the head being merged decides.** Read the pull request's comments and review bodies, live, for the exact head SHA being merged — the pull request's own head, on a queue entry too (the `<sha>` in `gh-readonly-queue/main/pr-<N>-<sha>` is the entry's base, not its head; #654) — and take the newest text that carries `Verdict:` or a `## Review —` heading: INC or REQUEST_CHANGES refuses, PASS allows, no conclusion refuses too, and so does a report with no `Written-by:` line or one that names a writer the policy does not list (#627). Signing is shipped but not enabled (#1110, #1111): while the `signers` roster is empty nothing asks a conclusion for a signature, and an unsigned INC holds a merge exactly as before. Were the roster filled, a `Verdict:` whose signature does not verify would not be a conclusion at all — skipped before that scan rather than counted as a refusal — so an unsigned INC would no longer hold a merge; that cost is why the roster is empty and why the owner declined keys on 2026-10-25. Since #637 the format is fixed: the **first line** of the conclusion is exactly `Verdict: PASS at <sha>` / `Verdict: INC at <sha>` / `Verdict: REQUEST_CHANGES at <sha>`, with the attribution on the second line (`Written-by: Reviewer`, and a relay adds `Posted-by: Chief (proxy…)`; the older prose `Written by: …` reads the same way) and the evidence below it — a body that carries a verdict anywhere else is no conclusion, and no conclusion refuses. A result from `pull_request` time never stands in — on #610 the tip report ran at 10:31:08Z and the INC landed at 11:24:37Z, 54 minutes later. The gating agent checks this before enqueueing; `merge-gate.yml` checks it again at `merge_group`, and the stricter answer wins. That job runs on two events: at `merge_group` it judges and a refusal fails it, and at `pull_request` it only reports what the queue entry would refuse — a required check that never reports on the pull request head leaves every pull request waiting for a status that never comes and unable to enter the queue at all (#639). The required status check is the job name `merge-gate`; the workflow name `Merge gate` is not a context any run produces.

A review's `state` is not read at all: approvals are not a gate any more (user decision 2026-10-22), and the account cannot approve its own pull requests, so its reviews stay `COMMENTED` even for an INC — the INC on #610 was a comment rather than a review.

**One conclusion per tip.** A tip carries at most one conclusion: one `Verdict:` block naming one SHA — the whole 40 characters, because a prefix names every head that starts that way and the newest of them is the tip being judged (#1112). **A tip that moved without changing the reviewed change set keeps its conclusion** (#1317): when no conclusion names the head itself, the gate compares `(path → blob sha)` at the reviewed tip and at the head over the pull request's changed paths, and accepts the PASS only when every one matches — naming both shas and the comparison it made — while a changed blob, a path missing on either side, a truncated tree or an unreadable one refuses exactly as before. A conclusion that names the head always decides, so an INC written at the head still vetoes a carried PASS. Two conclusions at the same tip is an incident, not a tie to be broken — nobody re-verdicts to win, the Reviewer that wrote the later one retracts it in a comment, and the pull request waits. A correction reads `Correction from <Bot>: …` and carries no `Verdict:` line, so it never competes with the standing conclusion; the replacement PASS for a missing `Ran:` ([above](#gates)) is the only other body allowed at one tip. **A GitHub bot account's `Verdict:` is never a conclusion** — `user.type` is `Bot`, or the login ends `[bot]` — whatever its body says (#943, `cursor[bot]` at #940's tip); the rule is the account type and not a login list, because every Bot writes as the shared `Birfy` account and a list containing it would void the whole pipeline, so the real Reviewer voids such a report at that tip with `Correction from Reviewer:`.

**Judged on the merge tree, never on the pull request page.** The page answers "does this commit pass alone"; the queue answers "does this commit pass merged onto the current `main`", and the second one is the merge decision. #759 was green on every check, was kicked out of the queue twice, and went red on `main` at `core/test/follow-through.test.js:264`. A red queue entry that names files you did not touch is the stale base of [step 2](#pipeline-contract), not bad luck: fix the base, do not re-enqueue blindly.

**A merged pull request's body is not a control.** GitHub evaluates `Fixes #N` once, when the merge lands. Editing the body of a merged pull request afterwards closes nothing and triggers no guard; it only makes the record disagree with what merged. If the issue is still open, close it with a comment naming the pull request — and if the merge itself was wrong, say so on the issue.

#### The checkpoint block: a hand-off the next Bot can read (#1202)

A pull request hands itself over in one block in the body, under `## Checkpoint`. The body is the only store: it becomes the squash commit message, so the block cannot fall out of step with the pull request the way a comment or a label can.

```json
{
  "pr": 1206, "claim": "Dev", "issue": 1201,
  "summary": "Three to five sentences of what changed, not how.",
  "files": ["core/src/shared/quiet-hours.js"],
  "checks": { "ran": "node scripts/ds-bot-patches check", "result": "green", "at": "<40-character tip sha>" },
  "next": "none — ready for review"
}
```

| field | rule |
| --- | --- |
| `pr` | this pull request's number — catches a body copied from another |
| `claim` | the Bot on the `Owner:` line; one claimant per pull request |
| `issue` | a number the body closes with `Fixes`/`Closes` |
| `summary` | 3–5 sentences, ≤ 600 characters; English or Chinese — `.`, `!`, `?` and `。`, `！`, `？` all end one |
| `files` | 1–12 paths, at least one in this diff |
| `checks` | `ran`, `result` ∈ `green\|red\|none` (`none` needs `why`), `at` the full sha the checks ran at — read, not compared with the head, so a sha from an earlier tip is accepted |
| `next` | ≤ 300 characters; `none — ready for review` is allowed |

The whole block stays under 1500 characters, between `<!-- flybot:checkpoint -->` and `<!-- /flybot:checkpoint -->`; the template in [`.github/pull_request_template.md`](.github/pull_request_template.md) carries the skeleton. `enqueue-guard` reads it at **queue entry** and refuses a missing or wrong field by name, the way it refuses `missing line: Owner:`. That read is the live one because of the events, not for want of a ready event: [`enqueue-guard.yml`](.github/workflows/enqueue-guard.yml) already lists `ready_for_review` among its `pull_request_target` types, and none of those types is `edited` — so a body fixed after the check went green starts no run at all, and the old green would stand until the queue entry reads the body it is about to merge. Writing the block at claim time and refreshing it on every push is a convention, not a check: only the queue entry is enforced. The same two exemptions apply (a mechanical release PR, a fork).

#### Docs-not-needed: why both places

This is not a new rule, and it does not fail because it is unclear — it fails when nobody reads it at the tip. What the two places are for:

- [`check-arch-docs.mjs`](core/scripts/check-arch-docs.mjs) reads `git log <base>..HEAD --pretty=%B` — the branch commit messages, plus the pull request title and body on the queue entry.
- The merge queue squashes the pull request title and body into the one commit that lands on `main`, so that commit carries the body and none of the branch messages. `arch-docs` runs again on the push to `main`.
- A trailer written only into a branch commit is therefore gone exactly when `main` is judged.

**Self-check before you push, and again after any new commit:** the same line appears in both places.

```sh
git log -1 --format=%B                    # the branch commit message
gh pr view <n> --json body --jq .body      # the pull request body
```

If either lacks it, add it there and push. No trailer and no subsystem-doc update fails `arch-docs` on the branch; a trailer in the wrong place fails only after the squash, when the branch is gone.

**The T0/T1 exemption is computed, never labelled.** `merge-gate.mjs` runs the base copy of [`risk-gate.mjs`](.github/scripts/risk-gate.mjs) over the changed files and `.github/agent/risk-rules.json` to get the tier; a `risk:T0`/`risk:T1` label does nothing. Every Bot shares one account and a label carries no signature (#627), so a label-based exemption would let whoever can label turn a T3 into "no review needed" — the gate itself. A mechanical release PR is recognised by its files as before, and `hold` still refuses whatever the tier.

The standing "file no new issues" rule covers design proposals only: a reproducible code defect is still filed as an issue, with its reproduction.

### Reference-first

Architecture truth lives in [docs/subsystems/](docs/subsystems/README.md) (each page's `owned_paths`, enforced by `arch-docs`), and in this file and [docs/code-standards.md](docs/code-standards.md) where those already state a rule. [`.claude/skills/review-pr/SKILL.md`](.claude/skills/review-pr/SKILL.md) stays thin: the Verifier procedure (tip SHA, PASS / FAIL / INC, `Ran:` / `Not run:`, security and cleanliness checks) plus pointers. On each tip review, re-read the subsystem pages, this file, and code-standards from `origin/main`. Do not restate subsystem architecture details in the skill. Owner decision 2026-10-24.

- **Architecture changes** update the matching subsystem doc, or a valid `Docs-not-needed:` trailer in both the branch commit and the pull request body ([why both](#docs-not-needed-why-both-places)). Do not edit `review-pr` for ordinary architecture.
- **Only** when the Verifier protocol itself changes — the PASS / FAIL / INC fields, the `Ran:` / `Not run:` shape, the posting format, or the [`review-gate.mjs`](.github/scripts/review-gate.mjs) parse contract — the same pull request updates `.claude/skills/review-pr`, and this file when the gate wording here has to move with it.

### Hard rules for agents

1. The self-test routine files issues only; the maintenance routine opens PRs; the release routine owns `CHANGELOG.md` and the version.
2. No deploy of production Bot Social, and no change to the owner's local instances, without the owner's explicit yes.
3. A routine PR is merged by the Bot that gated it (owner decision 2026-10-21, [self-gate](#owner-decision-the-bot-gates-and-merges-its-own-prs-2026-10-21-owner-authorized)). A typed chat reply is still not an approval for anything else, and an owner-only decision (scope, security surface, policy) still waits for the owner's word through the normal path (#349).
4. Connector tools are on for every turn of the owner's own Bots, whoever started it, unless the owner turns a connector off for one Bot; a friend's Bot never gets them (#359, owner decision 2026-10-22 on #601). For GitHub work a Bot uses the GitHub connector tools first and `$DSH_SECRET_GITHUB_TOKEN` with `gh`/`git` only as the fallback (for example `git push`).
5. Bot Social has no keyword commitment scan.
6. A schedule is per session, not per Bot: an empty `schedule_list` is not evidence that a schedule does not exist; never delete or recreate a schedule from it, and never report "no timers" as a finding; `bot_schedules` is the Bot-wide list for this (see [A schedule is per session](#a-schedule-is-per-session-not-per-bot-628)).

## What this project is

FlyBot is a team of long-lived Bots, built on DeepSeek Harness (DSH). It has two parts:

- `ds-bot/`: pristine upstream ds-bot (Fei2411/DeepSeek-Bot), pinned in `ds-bot.pin.json`. **Never edit it.**
- `patches/ds-bot/`: FlyBot's ordered patches on it; see `patches/ds-bot/README.md`.
- `core/`: `ds-bot/` + the patches (committed, what ships and what tests run on): the Bot features, written as a DSH plugin. The plugin runs in DSH Desktop, in DSH Web and in the desktop app.
- `plugins/social/`, `plugins/tree/`, `plugins/timeline/`: peer plugins `@flybot/social`, `@flybot/tree` and `@flybot/timeline`.

The Bot team:

- Every Bot is a DSH Session and runs through the normal DSH agent loop, tools and model routes.
- The team works together: Bots message each other, share group chats and can see what the other Bots are doing. Each Bot still runs on its own and does not disturb the others.
- Bots have clear, different roles. A Main Bot has the highest rights: it creates and changes other Bots, and can stop a running turn. `stop_bot` ends that turn; it does not remove the Bot. Deleting a Bot is the person's action in the UI (`delete-bot`), and #638 tracks whether a Bot may retire one instead. Other Bots do not get those management rights. There can be more than one Main Bot.
- **Tree child creation (#16, Option B).** A tree Bot (not only the Main/root) may call `create_child_bot` to create a child directly under itself. The tool takes no parent argument; `maxChildren` and depth limits stay in force. The new child is usable only by its creator's owner; sharing it with another person still requires an independent per-Bot grant (default deny). There is no publish mechanism. See [docs/subsystems/tree.md](docs/subsystems/tree.md).
- The multi-human authority contract (human owner ↔ designated Chief ↔ specialists) is documented in [docs/subsystems/team.md](docs/subsystems/team.md) as **planned, not shipped**: team mode stays disabled until its authorization gates pass. Issue #16 is resolved (Option B); do not re-open Main-only child creation.
- Users customize each Bot (name, role label, instructions, model, character).
- Behavior must be reliable: a Bot acts on evidence, stays inside its goal, and its results can be checked.

## Hard rules

1. **Build on DSH; never patch it.** Bot features use the documented plugin APIs. The desktop app starts DSH only through its documented entry points (`@deepseek-ai/dsh/profile-boot`, the `dsh` CLI). Never patch DeepSeek Harness or depend on files inside a DSH install. If something is missing in DSH, stop and say so; do not work around it with a patch.
2. **No secrets.** Never write, print or commit API keys, tokens, cookies or `DSH_HOME` contents. Use the mock model (`core/dev/mock-llm.mjs`) for tests; it needs no key. Every one of the owner's own Bots gets the owner's saved keys on every turn (owner decision 2026-10-22, #601); a key a shell cannot use is named in `DSH_SECRETS_WITHHELD` (`NAME:reason`, never a value: `remote-bot`, `not-in-scope`, `unknown-bot`): read the reason instead of assuming the owner did not configure it.
3. **Only original material.** Do not copy code, text, icons, logos or graphics from other products or websites.
4. **The core is ds-bot + patches.** Change `core/`, then run `node scripts/ds-bot-patches.mjs generate` and `check`, and commit `core/` and `patches/` together. CI fails if `ds-bot/` differs from the pin or `core/` differs from `ds-bot/` + patches.
5. **`client.js` is generated.** Change `core/src/client/`, then run `npm run build` in `core/` and commit both files. Never edit `client.js` by hand.
6. **Do not touch the user's own DSH data.** The test bench keeps its data in `.dsh-test-<name>/`. Never point a test at `~/.dsh` or at a DSH that the user runs.
7. **Reference-first.** An architecture change updates the matching subsystem doc (or a valid `Docs-not-needed:` trailer). Edit `.claude/skills/review-pr` only when the Verifier protocol itself changes. See [Reference-first](#reference-first).
8. **Read bytes, never re-decode.** A file rewritten from an outside source, or regenerated (`core/client.js`, `patches/ds-bot/*`, the `files/` mirrors), is read back as bytes and re-encoded by its generator — never decoded as UTF-8 from a fetch that may have split a multi-byte character, because `errors: 'replace'` turns the rest of that character into U+FFFD and the damage survives the build and the patch generation. The byte-level scan `node .github/scripts/check-mojibake.mjs --check` is the gate (a decode-first scan cannot be: it reports 22 binary files and ~2,065,422 replacement characters on a clean `main`, #1188); a red scan means "regenerate", not "retype the text".

## Commands

**Node 22 or newer is required.** On Node 20 the tests fail with "Could not find test/*.test.js". CI uses Node 24; on the shared box use `PATH=/workspace/tools/node24/bin:$PATH`.

**One command, from the repo root:** `npm run verify` runs what CI runs, in CI's order: core lint (oxlint + `arch-docs`), plugin lint, `build-client.mjs --check`, `ds-bot-patches.mjs check`, the core suite and both plugin suites. It needs the one-time setup below (`npm ci` and `npm run harness` in `core/`). It does not run the pack check, typecheck or actionlint of the CI `package` job, and not the smoke test.

**Sandbox preflight (#607, #615).** A session on `workspace-write` (or `read-only`) on a host without a usable sandbox backend refuses every `bash` call with `SANDBOX_UNAVAILABLE` and looks merely stuck. Run `node .github/scripts/sandbox-preflight.mjs --mode <your file policy>` once at the start: exit 0 usable, **3 proven blocked**, **4 cannot tell**, 2 usage. Pass `--mode` (or set `FLYBOT_SANDBOX_MODE`) - the preflight cannot see the session policy and must not guess it; `danger-full-access` needs no backend at all and is never reported blocked. On **3**, report one line (`blocked: no usable sandbox backend` plus the unlock it prints) and do not retry shell calls. On **4**, do not stop: a `bash` call refused with `SANDBOX_UNAVAILABLE` is the only proof. File tools and the GitHub API still work either way; the tiers are in [docs/sandbox.md](docs/sandbox.md).

The rest of this section runs in `core/`. The unit tests and the linter load the `@deepseek-ai/*` packages from `dev/harness/`, which `npm run harness` installs from npm at the DSH version in `dev/harness/package.json`. `DSH_HARNESS` points them at another install or at a DeepSeek Harness checkout instead. The test bench needs a checkout at `../deepseek-harness` (or `DSH_HARNESS`), at the DSH version in the README.

```sh
npm ci                                 # build tool only (esbuild)
npm run harness                        # once: the DSH packages for the tests and the linter
npm run build                          # src/client → client.js
npm test                               # unit tests; also fail if client.js is stale
node scripts/build-client.mjs --check  # client.js matches src/client
npm run lint                           # oxlint
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096   # smoke test
dev/bench.sh smoke 3096 8796 stop
```

A change is done when `npm run verify` passes (or `npm test`, the `--check` and `npm run lint` in `core/`); CI runs them on every pull request. Run the smoke test as well for changes to `index.js` or `src/host/`. Use a free port for each bench, and stop every bench and process that you started.

After oxlint, `npm run lint` also runs `npm run arch-docs`: if an owned file (see [docs/subsystems/](docs/subsystems/README.md)) changes without its subsystem doc in the same PR, the check fails—update the doc or add a `Docs-not-needed:` trailer.

## Layout

- `core/index.js` and `core/src/host/`: the server side (roster and store, tools, turns and delivery, groups, conversation parts and the search index, images, the browser bridge, the `api/bot` channel).
- `core/src/client/`: the browser side (sidebar, chat, panels, themes, characters, the Bot browser panel).
- `core/web-search.js`: the `auto` web-search provider, independent of the Bot team code.
- `core/test/`: unit tests and fixtures. `core/dev/`: the DSH packages for the tests (`harness/`), mock model, test bench, smoke test, character generator, Desktop scripts for Linux.
- `plugins/social/`, `plugins/tree/` and `plugins/timeline/`: peer plugins `@flybot/social`, `@flybot/tree` and `@flybot/timeline`, not under `core/`.
- Architecture and ownership: [docs/architecture.md](docs/architecture.md) and [docs/subsystems/](docs/subsystems/README.md).

## Style

- Follow the code around your change. Keep functions small and names plain.
- Write a comment only when the reason is not clear from the code: a hidden constraint, an invariant, a workaround. Do not describe what the code does.
- Commit messages in English, imperative subject, the reason in the body. Keep commits small.
- User-facing text in the plugin is English. Keep the README and README.zh.md in step when you change one of them.
