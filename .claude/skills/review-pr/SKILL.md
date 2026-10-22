---
name: review-pr
description: Review a FlyBot change or PR with Magpie-style Verifier honesty. Report PASS, FAIL, or INC at a tip SHA; check implementer↔reviewer agreement and security fence / display-name rules.
---

# FlyBot review-pr

Use for local or PR tip reviews on `ThinkFlowLab/FlyBot`. Produce a Verifier report only. This skill does **not** authorize push, approve, merge, or posting a GitHub review unless a human explicitly asked for that action.

## Establish the tip

1. Confirm repo identity (`ThinkFlowLab/FlyBot` or the agreed fork) and the commit under review.
2. Record **tip SHA** (`git rev-parse HEAD` or the PR head SHA). If the tip moves, re-run from scratch.
3. Load the **latest rules from `origin/main`** before each review: `git fetch origin && git show origin/main:.claude/skills/review-pr/SKILL.md` (and the same for `docs/code-standards.md` / `AGENTS.md` if the local tree is behind). Prefer the fetched rules over a stale local copy.
4. Read [LESSONS.md](../../../LESSONS.md), [docs/code-standards.md](../../../docs/code-standards.md), [AGENTS.md](../../../AGENTS.md), and the hard rules in [CONTRIBUTING.md](../../../CONTRIBUTING.md).
5. Inventory changed files vs the merge base. Do not treat author narrative as evidence.

## Architecture docs / owned paths (FAIL gate)

- Subsystem pages under `docs/subsystems/` declare `owned_paths` (longest match wins).
- **FAIL** if any file matching an `owned_paths` entry changed without a corresponding subsystem doc update in the same PR, unless the commit message carries a `Docs-not-needed:` trailer (or the arch-doc check is otherwise green).
- Do not invent a `Docs-not-needed:` excuse for security, fence, or API-contract changes that change behavior documented in a subsystem page.

## Verdicts

| Verdict | Meaning |
|---|---|
| **PASS** | No actionable findings for the scoped risk; required checks you claim were **run at this tip** and green; the reviewer's own re-run evidence agrees with the implementer's claims on this tip. |
| **FAIL** | Actionable defect (correctness, security, DSH hard-rule break, missing fail-without-change test for a claimed fix, dishonest claim). |
| **INC** | Incomplete evidence: material checks **not run**, tip moved, the review did not finish, or scope unclear. INC is not PASS. |

## Magpie-style Verifier lines (required in the report)

Always include:

```text
Verdict: PASS | FAIL | INC at <full or 12+ hex>
Written by: Reviewer. Posted by: <who actually posted it>.

Ran:
  - <command> → pass|fail
  - …
Not run:
  - <check> — reason
```

The first line is the whole conclusion (#637): nothing may come before it, because the gates read the
first line and treat any other shape as no conclusion.

What the gates read as evidence (`review-gate.mjs` `parseReport`; #660–#663 refused at the queue for
the first point):

- **Ran** — a line starting with `Ran` and ending its heading with a colon (`Ran:`, or
  `Ran at this tip (tarball of the tip):`), followed by either `- <command>` bullets or a fenced block
  whose commands start with `$ ` (output lines below them are not commands). At least one command; an
  empty `Ran:`, `Ran: -`, or a block with only output refuses the PASS.
- **Not run** — recommended, not checked (owner decision 2026-10-22 09:57 Asia/Shanghai): name the material checks you skipped
  so the gap is visible ([docs/code-standards.md](../../../docs/code-standards.md#verifier-honesty) 3),
  but a PASS without a `Not run:` line is no longer refused by the gates.

Honesty rules:

- List what **you** ran at this tip. Stale CI on another SHA is not “Ran”.
- Explicit **Not run** for smoke, Desktop, real-model steward, etc., when relevant.
- No “secure / fixed / ready” without the matching tests or an INC/FAIL.

## Security fence / display-name checks

For any change that touches delivery, social, fencing, or model-visible remote text (especially issues #9 / #10 / related):

1. **Fence escape:** closing markers must not reconstitute after stripping (nested `</untrusted-…>` patterns). Cover message and file fences.
2. **Shared helper:** prefer one neutralization path shared with the client parser; reject one-shot `replaceAll` as sufficient.
3. **Display names / handles / file names:** sanitized (no raw newlines/controls; length-capped) before trusted headers; fenced when they remain model-visible.
4. **Tests:** fail-without-change negative tests for reconstitution and forged headers. Absence of tests for a claimed security fix → **FAIL** or **INC**, never PASS.
5. Cross-check open LESSONS entries dated for fences / claim honesty.

## Who reviews

The reviewer is the **owner's own reviewer Bot/agent** (it may act as `Birfy`; self-review counts per `selfReview` in
`.github/agent/review-policy.json`), run in a separate session with fresh context. Codex is **not** used for review
(owner decision 2026-10-19 15:31): do not comment `@codex review`, and do not wait for or require a Codex review. A
comment that an outside bot posts on its own is input to read, not a PASS and not a gate.

- **PASS** only from the reviewer's own evidence on the **same tip SHA**; the implementer's "fixed" is narrative.
- If the implementer says fixed and the reviewer finds a defect → **FAIL** or continue the loop; do not average into PASS.
- Tip advanced after a PASS → previous PASS is void; mark **INC** until re-review.

## DSH and repo hard rules (instant FAIL)

- Patching DeepSeek Harness or depending on private install files.
- Secrets, tokens, or user `DSH_HOME` / `~/.dsh` in the diff.
- Hand-edited `core/client.js` without regenerating from `src/client/`.
- Tests pointed at the user’s real DSH data.

## Suggested local commands (code PRs)

From `core/` when the diff warrants it:

```sh
npm test
node scripts/build-client.mjs --check
npm run lint
```

Host / delivery changes: note smoke as **Ran** or **Not run**. Record skipped suites under **Not run**.

## Report shape

1. Verdict line (PASS / FAIL / INC) + tip SHA  
2. Verifier block (Ran / Not run)  
3. Findings (severity, path, trigger, consequence) or “no actionable findings”  
4. Security fence / display-name subsection when in scope  
5. Explicit statement that this is not merge authority  

Do not fill contributor checkboxes or flip draft status unless asked.

## Recording the PASS

Post the report as a **pull request comment** (or the review body) only when a human asks for it, and
only from the reviewer's own login: `.github/scripts/review-gate.mjs` reads the newest Verifier block
that names the head, from a login in `.github/agent/review-policy.json`. The pull request's own
author counts only when listed in the policy's `selfReview` (the owner's Bot/agent, `Birfy`, may PASS its own PR). Keep the block intact — the `Verdict: … at <sha>` first line, the attribution line, `Ran:`, and `Not run:` when you skipped something — because a
missing `Ran:` command is reported as incomplete evidence (`Not run:` is not checked, owner decision 2026-10-22 09:57 Asia/Shanghai), and a PASS at an older
sha stops counting the moment the tip moves. Posting it is not merge authority: see AGENTS.md step 6.
T0/T1 need no PASS; T2/T3 need a PASS at the tip, and the agent that gated the PR then enqueues it itself (owner decision 2026-10-21).
