# FlyBot code standards (agent acceptance)

Short acceptance rules for agents and maintainers. Hard DSH rules stay in [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md). Living bite-sized lessons live in [LESSONS.md](../LESSONS.md); promote from there after ≥3 days.

These are Magpie-*style* process habits adapted for FlyBot. Do not treat them as a license to copy another product’s docs or code.

## Verifier honesty

When you report status on a change:

1. **Tip SHA** — name the exact commit under review (`git rev-parse HEAD`).
2. **Ran** — list each command you personally ran at that tip, and pass/fail.
3. **Not run** — recommended: list material checks you did **not** run (smoke, Desktop, real-model steward, etc.). Missing evidence is a gap, not PASS. The gates do not check for a `Not run:` line (owner decision 2026-10-22 09:57 Asia/Shanghai); a PASS still needs at least one `Ran` command.
4. **No borrowed credit** — author claims and stale CI on another SHA are not your Verifier result.
5. **PASS wording** — say only what the Verifier supports (e.g. “unit + lint green at `abc1234`; smoke not run”).

## Fail without change

- A new regression test (or assertion) must **fail on the unbroken tip** before the fix lands, then pass with the fix.
- Prefer a minimal fixture that shows the class of bug (fence reconstitution, forged header), not a one-off sample that only matches one string.
- **Red evidence is one of two kinds, and the report says which.** A test that is red on `base` (the unbroken tip) and green with the fix is a **defect test**: it reproduces the reported bug. A test that is green on `base` as well is a **guardrail**: it pins behaviour a later change must not break. Both belong in a pull request, but a claimed fix needs a defect test — a guardrail is never counted as the fail-without-change evidence, and the two read identically in a diff, so state which one the red run showed (`base` ref, command, before/after counts).

## Fix the class, not the sample

- If review or a test finds one escape path, fix the shared helper and cover sibling markers (`untrusted-message`, `untrusted-file`, trusted headers).
- Same-class reds tighten LESSONS / this file; do not paper over with a special case.

## List sync: leave softly, replay idempotently

A change that keeps a membership, roster or presence list in sync has the same four traps every time; a pull request that reworks one states how it handles each.

- **Leaving marks, it does not remove.** A departure keeps its record and sets the leaving sequence (`leftSeq`/`leftAt` in `core/src/host/room-membership.js`; `currentParticipants()` filters them out for the live view), so history still names who was there. Never `filter()` the entry out of the array: the next sync cannot tell it apart from someone who was never in the list, and a rejoin has nothing to land on.
- **A rejoin clears the mark instead of adding a record.** Match the returning member to its old record, drop the stray `left` line, clear `leftSeq`/`leftAt`, and refresh `joinedSeq`. Two records for one Bot is the bug, not the fix.
- **The same delivery lands once.** A repeated message or event must not add a second line or a second membership change: the room log keys remote events by id (`seenEvents`, monotone `eventCursor`) and returns before writing again. Idempotency is checked by replaying the fixture twice, not by reasoning about it.
- **A missing field is not a cleared field.** An update diffs only the lists and fields the message explicitly carries: a roster it does not include leaves the current one alone, and an absent `notice` is not an empty notice. Clearing is always an explicit value in the payload.

## Silent catches

- A `catch` that swallows the error says why in a comment inside the block (or handles it); `check-empty-catch` in `.github/scripts/` fails the build on a bare one (#205). Text inside comments, strings, templates and regex literals is not code, so a `catch {}` written there is never reported (#213).
- The promise form follows the same rule (#213): a `.catch` whose handler does nothing (`() => {}`, `() => undefined`, `() => null`) and whose result is dropped (a statement, or an `await` statement) needs a `void` prefix or a one-line reason comment (in the handler, after the call, or on the line above). A handler that returns a fallback value that is *used* (`const x = await p.catch(() => undefined)`, an argument, a `return`, an assignment) stays allowed. `void` suits fire-and-forget; an `await` that waits for the work to settle takes the reason comment.
- Test helpers (`test/`, `dev/`) stay out of the gate's scope.

## Security: fences and remote strings

- Untrusted bodies stay inside fences; closing markers must not reconstitute after a single strip.
- Peer-controlled display names, handles, and file names are sanitized before they appear in model-visible trusted text; prefer fencing them.
- See LESSONS (2026-10-14 fence / display names) and issue #9 until promoted fully.

## Merge only a reviewed tip

- By tier: **T0/T1** merge on green required checks; **T2/T3** need a **PASS at the same tip SHA** from the Reviewer ([`review-pr`](../.claude/skills/review-pr/SKILL.md)), and neither the PASS nor green CI replaces the other. The authoritative wording, the enqueue guard and the queue are in [AGENTS.md → Merge gates](../AGENTS.md#merge-gates); this page keeps only what a change must satisfy.
- **One conclusion per tip.** A second `Verdict:` at the same SHA is an incident; a new commit voids the PASS; a correction reads `Correction from <Bot>: …` and is not a verdict.
- **Judge the merge tree.** Green on the pull request page is the head alone; the queue rebuilds the merge with the current `main`, and that run decides (#759).
- Required checks ([CONTRIBUTING → Test a change](../CONTRIBUTING.md#test-a-change)) are green, or honestly listed as not run with a maintainer waiver: `npm test`, the client `--check`, `npm run lint`, plus the smoke bench when `index.js` or `src/host/` changes.
- **One pull request per issue.** An issue that already has a PR keeps it: re-base the branch, use `update-branch`, or push to its head, and put new tests there. Never open a second PR and close the first — including on a contributor's fork while maintainer edits are allowed. A branch that cannot be pushed is the only exception, and the issue must say why.
- **A merged pull request's body is not a control.** `Fixes #N` is evaluated once, at merge; editing the body afterwards closes nothing. Close the issue with a comment instead.

## Architecture docs and owned paths

- Each subsystem under [docs/subsystems/](subsystems/README.md) declares `owned_paths` in YAML front-matter.
- Changing an owned file without updating that subsystem doc fails `npm run arch-docs` (also run at the end of `npm run lint`). Excuse it with a `Docs-not-needed:` trailer only when the change truly needs no doc update — and write it in the pull request body **and** in the branch commit, then check both at the tip: the queue squashes the body into the commit on `main`, where the check runs again ([why](../AGENTS.md#docs-not-needed-why-both-places)).
- Reviewers: FAIL if an owned-path change ships without a subsystem doc update **and** without a `Docs-not-needed:` trailer. Load the latest `origin/main` rules before each review (`git fetch` + `git show origin/main:.claude/skills/review-pr/SKILL.md` or the equivalent), not a stale local copy.
- Reference-first ([AGENTS.md](../AGENTS.md#reference-first)): an ordinary architecture change updates the subsystem doc and does not edit [`.claude/skills/review-pr`](../.claude/skills/review-pr/SKILL.md). Update that skill in the same PR only when the Verifier protocol itself changes (PASS / FAIL / INC fields, `Ran:` / `Not run:` shape, posting format, or the `review-gate.mjs` parse contract).

## Team authority contract (planned)

- The human ↔ Chief ↔ specialist ownership contract lives in [docs/subsystems/team.md](subsystems/team.md). It is a **planned** contract: multi-human is not shipped, and **team mode stays disabled** until that page's authorization gates pass.
- Issue #16 is **resolved (Option B)**: a tree Bot (not only Main/root) may call `create_child_bot` under itself, within `maxChildren` and depth limits. A newly created child is not auto-granted; sharing still needs an independent per-Bot grant. See [AGENTS.md](../AGENTS.md) and [docs/subsystems/tree.md](subsystems/tree.md). Do not re-open Main-only child creation.

## Tiny loops

- One issue (or one tightly coupled pair) per worktree / session.
- Prefer serial security bugs (#9 → #10 → #8) before large feature umbrellas.
- After PASS+agree, stop or take the next issue; do not pile unrelated diffs.
