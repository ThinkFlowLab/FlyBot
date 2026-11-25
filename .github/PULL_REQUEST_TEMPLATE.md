Related #

Part of #1

## Problem

<!-- What was broken or missing, for whom, and what observable symptom proves it? -->

## What now really works

<!-- User-visible outcomes, bounded to this slice. -->

## What changed

<!-- API/routes/storage/UI/tests/docs. State the exact permissions and bounds. -->

## Unchanged by design

<!-- Protocols, tables, surfaces, or behavior deliberately not touched. -->

## Intentionally not in this PR

<!-- Out-of-scope follow-ups and in-flight PRs. One item per line. -->

## Proof

- Exact head:
- Local commands and counts:
- Exact required checks and state:
- CLEAN / conflicts / unresolved discussions:
- Screenshots, or `无 UI 面 / no UI surface`:
- Known blockers (infrastructure flakes are not a green claim):

## Overlap check

<!-- Open PRs read; file/hunk intersection; why this is not a duplicate. -->

## Deployment / rollout

<!-- Only if this changes deployment; otherwise "none". -->

## Not claimed

No vendor/container/browser acceptance, no commercial-product parity, and no
fictional completion. Write “not a parity/acceptance claim”, never “copied”.

---

Hard rules:

- Use `Related #N` or `Refs #N` only. Never write `Fixes`, `Closes`, or
  `Resolves` next to an issue number, including in a sentence that says it does
  not close the issue. GitHub still parses it and auto-closes the issue.
- A green local suite is not exact-head CI. State both, and do not call a
  cancelled, failed, or flaky run green.
- Include the exact head SHA. A new commit voids the old proof.
- Keep the PR to one reviewable slice. Do not mention line numbers from the
  source tree unless the issue body anchors them to an exact commit.
