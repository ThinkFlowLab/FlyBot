---
name: fix-issue
description: Fix one FlyBot issue end to end — establish the facts, worktree, fail-without-change test, gates, PR, independent review loop, merge on green. The Verifier stage is the review-pr skill.
---

# FlyBot fix-issue

One issue per branch, one worktree per issue. The loop: establish the facts → test red → fix → gates → PR → independent review → merge on green. Magpie-*style* habits for FlyBot; do not copy another product's docs. This skill grants **no merge authority by itself**: the maintainer merges, or explicitly delegates for one instance.

## 0. Establish the work

1. `git fetch origin`, then read the **current** rules from `origin/main`: [AGENTS.md](../../../AGENTS.md), [docs/code-standards.md](../../../docs/code-standards.md), [LESSONS.md](../../../LESSONS.md), [CONTRIBUTING.md](../../../CONTRIBUTING.md) — not stale local copies.
2. Turn the report into observable facts before touching code. For a screenshot: crop the regions and read the exact strings. If no issue exists yet, file it first (see *Filing* below) and reference the umbrella it belongs to (#9 fences/display names, #5 social).
3. Confirm scope: one issue, or one tightly coupled pair (code-standards, Tiny loops). Reproduce or locate the defect in code; cite `file:line` in the PR.

## 1. Worktree and environment

- `git worktree add /tmp/flybot-<issue> -b fix-<issue>-<slug> origin/main`.
- `npm ci` in `core/` (build tool only). Unit tests load `@deepseek-ai/*` from `DSH_HARNESS` or `core/dev/harness/node_modules`; a fresh worktree has neither, and the resolver's git fallback can land on a repo-root harness checkout that misses packages — `at-menu`/`time-context` failures mean this, not your diff. Symlink an installed `dev/harness/node_modules` or set `DSH_HARNESS`.
- `git push` over HTTPS may time out while `gh api` works; push via the SSH URL (`git push git@github.com:ThinkFlowLab/FlyBot.git <branch>`).

## 2. Implement (fail without change)

1. Write the regression test **first** and run it red on the unbroken tip. Keep both halves of the evidence — red at base, green at the tip — a reviewer re-verifies this mechanically.
2. Fix the class, not the sample (code-standards). Respect the trust boundaries (#9): peer-controlled strings never become trusted or model-visible text; display names come from local records, never from message text.
3. Keep the host untouched when the defect is display-only — a client-only change skips the smoke gate.
4. Tests are flat `node:test` blocks like the neighbors; assertion helpers are local to each test file. User-facing strings are English with a `ZH` entry in `core/src/client/i18n.js` (the i18n test scans for missing keys).

## 3. Gates (every one, at the tip you will link)

```sh
npm run build                          # core/client.js from src/client
npm test                               # unit tests; fails if client.js is stale
node scripts/build-client.mjs --check
npm run lint                           # oxlint, then arch-docs
node scripts/ds-bot-patches.mjs generate && node scripts/ds-bot-patches.mjs check
```

- An owned file ([docs/subsystems/](../../../docs/subsystems/README.md)) changed → update that subsystem doc in the same PR; `Docs-not-needed:` only when the doc truly says nothing about the change.
- An upstream file (one that `ds-bot/` has) edited in `core/` for the first time must join a topic in `patches/ds-bot/topics.json` before `generate`. A new file needs no entry; `generate` stores it whole in `patches/ds-bot/files/`.
- Compare lint warnings against base: new warnings are findings.
- `index.js`/`src/host/` changes → run the smoke test as well.

## 4. PR

- Subject: imperative; the reason in the body; `Fixes #N` on its own line.
- A Verification section per Verifier honesty: tip SHA, each gate with **real numbers**, Not run with reasons.
- A reviewer note for environment traps (e.g. the worktree harness symlink above).

## 5. Independent review loop

1. The owner's reviewer agent, **in a separate session with fresh context** (it may share the `Birfy` account: self-PASS counts, owner decision 2026-10-19), reviews the PR tip following [review-pr](../review-pr/SKILL.md): it re-runs the gates itself and re-verifies red-at-base mechanically (worktree at base + only the test files copied in). The implementer's claims are narrative, not evidence.
2. Findings → fix the class, add the test, push. **A tip advance voids the previous PASS** — the reviewer re-reviews the delta and re-runs the gates at the new tip.
3. A non-blocking note whose root cause lies outside the diff becomes a follow-up issue immediately (security ones into the #9 queue), not a comment lost in the PR.

## 6. Merge and cleanup

- Merge only when all hold **on the same tip**, by tier (owner decisions 2026-10-19): **T0/T1:** required checks green, mergeable, design-conformant; no PASS and no human approval needed. **T2/T3:** required checks green, a PASS at the tip (self-PASS counts: the owner's reviewer agent may PASS a PR opened as `Birfy`), **and** the maintainer's approval through GitHub (a human). Tip moved (any new commit) → the PASS is void, start over from the review.
- **T0/T1 merge.** An agent may enqueue the PR itself when `node .github/scripts/risk-gate.mjs --pr <n>` reports **T0 or T1** and `tests-ok` is green: `gh pr merge --auto --squash --match-head-commit <sha>`. T2 and T3 wait for the maintainer. Never admin-merge, never bypass a gate.
- **Merge queue.** `main` requires one. The command above enqueues the PR; gh may print `The merge strategy for main is set by the merge queue` or `already queued`, which is success, not a refusal. The queue runs `Test` on a `gh-readonly-queue/main/pr-<n>-<sha>` entry and squash-merges it; a plain `gh pr merge --squash` is refused. Do not retry; check `isInMergeQueue` (GraphQL) or wait for the PR to read MERGED.
- Then: fetch and fast-forward main, delete the branch locally and remotely, remove the worktree, and carry follow-up issues (not TODOs).

## Filing (before the fix)

- `gh` cannot attach images to issues and gists reject binaries: push the screenshot to the `issue-assets` branch and embed the `raw.githubusercontent.com/ThinkFlowLab/FlyBot/<commit-sha>/<file>` URL in the issue body.
- Issue shape (matches recent issues): Environment / Steps to reproduce / Actual / Expected / Where it sits (`file:line` pointers) / Suggested direction (for discussion, not prescriptive).
