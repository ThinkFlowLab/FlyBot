---
name: review-pr
description: Review a FlyBot change or PR with Magpie-style Verifier honesty. Report PASS, FAIL, or INC at a tip SHA; check OpenCode↔Codex agreement and security fence / display-name rules.
---

# FlyBot review-pr

Use for local or PR tip reviews on `ThinkFlowLab/FlyBot`. Produce a Verifier report only. This skill does **not** authorize push, approve, merge, or posting a GitHub review unless a human explicitly asked for that action.

## Establish the tip

1. Confirm repo identity (`ThinkFlowLab/FlyBot` or the agreed fork) and the commit under review.
2. Record **tip SHA** (`git rev-parse HEAD` or the PR head SHA). If the tip moves, re-run from scratch.
3. Read [LESSONS.md](../../../LESSONS.md), [docs/code-standards.md](../../../docs/code-standards.md), [AGENTS.md](../../../AGENTS.md), and the hard rules in [CONTRIBUTING.md](../../../CONTRIBUTING.md).
4. Inventory changed files vs the merge base. Do not treat author narrative as evidence.

## Verdicts

| Verdict | Meaning |
|---|---|
| **PASS** | No actionable findings for the scoped risk; required checks you claim were **run at this tip** and green; OpenCode and Codex **agree** on this tip when both participated. |
| **FAIL** | Actionable defect (correctness, security, DSH hard-rule break, missing fail-without-change test for a claimed fix, dishonest claim). |
| **INC** | Incomplete evidence: material checks **not run**, tip moved, only one side of OpenCode↔Codex finished, or scope unclear. INC is not PASS. |

## Magpie-style Verifier lines (required in the report)

Always include:

```text
Tip SHA: <full or 12+ hex>
Ran:
  - <command> → pass|fail
  - …
Not run:
  - <check> — reason
OpenCode↔Codex: agree PASS | disagree | only OpenCode | only Codex | n/a
Verdict: PASS | FAIL | INC
```

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

## OpenCode ↔ Codex agreement

When the iteration loop is in use:

- **PASS** only if both sides report PASS on the **same tip SHA**, or a human waived one side in writing.
- If OpenCode says fixed and Codex finds a defect (or the reverse) → **FAIL** or continue the loop; do not average into PASS.
- Tip advanced after a PASS → previous PASS is void; mark **INC** until re-review.

## DSH and repo hard rules (instant FAIL)

- Patching DeepSeek Harness or depending on private install files.
- Secrets, tokens, or user `DSH_HOME` / `~/.dsh` in the diff.
- Hand-edited `ds-bot/client.js` without regenerating from `src/client/`.
- Tests pointed at the user’s real DSH data.

## Suggested local commands (code PRs)

From `ds-bot/` when the diff warrants it:

```sh
npm test
node scripts/build-client.mjs --check
npm run lint
```

Host / delivery changes: note smoke as **Ran** or **Not run**. Record skipped suites under **Not run**.

## Report shape

1. Verdict line (PASS / FAIL / INC) + tip SHA  
2. Verifier block (Ran / Not run / OpenCode↔Codex)  
3. Findings (severity, path, trigger, consequence) or “no actionable findings”  
4. Security fence / display-name subsection when in scope  
5. Explicit statement that this is not merge authority  

Do not fill contributor checkboxes or flip draft status unless asked.
