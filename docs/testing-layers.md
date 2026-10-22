# Testing layers: commit, merge, self-test

Which suite runs at which gate, and what each gate promises. The two tables at the end are generated
from [`testing-layers.json`](testing-layers.json) — that file is the data, this page is the prose plus
the generated rows, and `node .github/scripts/testing-layers.mjs --check` fails when the two drift or
when a test file or a workflow nobody classified appears in the repository.

Why three layers and not one: a suite that needs a real model, a network socket or the wall clock can
never be part of the check that runs on every push, and a suite that is cheap and deterministic should
not be discovered by hand at release time. A case may only enter a layer that can actually run it, and
the layer is a promise about what it can catch, not about how much it runs.

## L1 — commit / push

- **What it must be able to catch:** a defect in behaviour the code decides on its own — a wrong
  branch, a broken invariant, a regression in a parser, a store, a client render.
- **What it must not depend on:** the network, a model, the wall clock or calendar, another test's
  order, or anything in a machine's home directory. `dev/interop/no-network.mjs` makes the network
  part mechanical for the interop suite.
- **Budget:** the whole layer under 10 minutes on a cold runner, because it runs on every push and on
  every queue entry. A suite that cannot fit is split or moved up, not added as it is.
- **What runs it:** `.github/workflows/test.yml` on `push`, `pull_request` and `merge_group`.
- **Command:** `node .github/scripts/testing-layers.mjs --check && npm --prefix core test && npm --prefix
  plugins/social test && npm --prefix plugins/tree test && npm --prefix plugins/timeline test && node
  --test ".github/scripts/*.test.mjs" && npm run test:interop`

## L2 — merge / queue

- **What it must be able to catch:** everything a merge must not break, at the exact commit being
  merged — an L1 regression plus a broken ds-bot pin or patch set, a plugin that no longer packs, a
  type error in the plugin API, a malformed changelog fragment, a workflow that no longer parses, a
  conclusion at a stale tip, or a `hold` that a queue entry would otherwise walk past.
- **What it must not depend on:** being bypassed. `main` requires these checks and the merge queue is
  the only route in; a ref push that never built a queue entry cannot land.
- **Budget:** the checkout-to-green time of `test.yml` plus `merge-gate` on one queue entry, inside the
  queue's own limit.
- **What runs it:** `.github/workflows/test.yml` (as the queue entry) and `.github/workflows/merge-gate.yml`,
  which re-judges `hold` and the newest conclusion at the entry's head.
- **Command:** `gh pr merge <n> --auto --squash --match-head-commit <sha>` — never a direct push.

## L3 — self-test

- **What it must be able to catch:** what a user meets and no unit test can see — two real homes, a
  real Bot Social, a real model, a person watching. It is not deterministic, so it produces issues
  with reproduction steps rather than failing a merge.
- **What it must not depend on:** gating a merge, or being the only copy of a case that can be
  reproduced offline. When an L3 case turns out deterministic it moves down to L1 and the self-test
  entry keeps a pointer to the automated test instead of the steps.
- **Budget:** minutes of wall-clock time with a real model; `live-e2e.yml` runs the automated half
  against `main` daily.
- **What runs it:** the product self-test routine, driven by the team at 09:00 and 21:00
  Asia/Shanghai, and `.github/workflows/live-e2e.yml` on `main`.
- **Where the cases live:** `docs/self-test.md`, which carries the self-test case catalog and their
  stable ids (#742). This page does not duplicate that catalog: it only says which layer a case
  belongs to and that an L3 case keeps a pointer once it moves down.

## The manifest

`docs/testing-layers.json` has two kinds of row, and both are enforced by the check:

- a **suite row** — an id, the layer that runs it (`L1`, `L2`, `L3`, or `none` with a reason), the test
  paths it owns, and the command. Every test file in the repository must match exactly one suite row,
  so a new `*.test.mjs` or `*.test.js` that nobody classified fails `package` and the message names the
  file.
- a **workflow row** — every file in `.github/workflows/`, with a `kind`, its layer (or `none` and a
  reason), and whether it gates a merge. The kind says what the row is: `gate` runs the suites or judges
  a queue entry (`test.yml`, `merge-gate.yml`), `workflow-only` is a layer that carries no test file of
  its own (`docker.yml`, `nightly.yml`, `live-e2e.yml`, `label-hygiene.yml`), and `not-a-layer` is a
  workflow that runs no tests and gates nothing, with the reason written out. A workflow row is checked
  against the workflow file that exists, so a new workflow cannot slip in unclassified and removing a
  workflow-only row fails even though that layer owns no test path at all.

The tables below are generated: edit `docs/testing-layers.json`, then run
`node .github/scripts/testing-layers.mjs --write`.

<!-- generated:testing-layers:begin -->

| Suite | Layer | Test files | Command |
| --- | --- | --- | --- |
| `core` | L1 | `core/test/**/*.test.js` | `npm --prefix core test` |
| `plugins/social` | L1 | `plugins/social/test/**/*.test.js` | `npm --prefix plugins/social test` |
| `plugins/tree` | L1 | `plugins/tree/test/**/*.test.js` | `npm --prefix plugins/tree test` |
| `plugins/timeline` | L1 | `plugins/timeline/test/**/*.test.js` | `npm --prefix plugins/timeline test` |
| `scripts` | L1 | `.github/scripts/*.test.mjs` | `node --test ".github/scripts/*.test.mjs"` |
| `interop` | L1 | `dev/interop/**/*.test.mjs` | `npm run test:interop` |
| `patch-payload` | none (see reason) | `patches/ds-bot/files/**` | — Generated copies of the files the patches carry. They are compared against `core/` by `node scripts/ds-bot-patches.mjs check` (L2) and never run on their own; the code under test is the copy in `core/`. |
| `upstream` | none (see reason) | `ds-bot/test/**` | — The pristine upstream checkout at the pinned version. FlyBot never edits or runs it directly — `core/` is `ds-bot/` plus the patches, and the `core` suite runs the patched copies. |
| `live-e2e-unit` | none (see reason) | `dev/live-e2e/test/**` | — Offline unit tests for the live end-to-end harness (a fake adapter, no model). They run in the root `npm run verify` only; no CI gate runs them today. Moving them into L1 is a separate change, and the layer that does drive a real model is `live-e2e.yml`, whose row is below. |

| Workflow | Kind | Layer | Gate | Runs on | What it guarantees, or why it is not a layer |
| --- | --- | --- | --- | --- | --- |
| `test.yml` | gate | L2 | yes | push to main, pull_request, merge_group | Runs every L1 suite, the packaging and patch-pin checks, the strict typecheck, the changelog check and the workflow lint on `push`, `pull_request` and `merge_group`, and aggregates them as `tests-ok`, which `main` requires. |
| `merge-gate.yml` | gate | L2 | yes | merge_group (reports on pull_request) | Re-reads `hold` and the newest conclusion at the entry's head, and fails the queue entry when either refuses it. |
| `docker.yml` | workflow-only | L2 | yes | pull_request that touches the image | Builds the container image and starts it, so a packaging change cannot merge without the image proving it starts. |
| `live-e2e.yml` | workflow-only | L3 | no | daily on main | Drives the real end-to-end suite with a real model against `main`; it is the automation behind the self-test layer, and it never gates a merge. |
| `review-gate.yml` | not-a-layer | none | no | — | Validates and posts the conclusion on a pull request. It gates nothing by itself: `merge-gate` re-judges the entry at merge time. |
| `risk-tier.yml` | not-a-layer | none | no | — | Reports the computed risk tier on every pull request. Nothing reads it to block or merge; the tier that decides is recomputed by `merge-gate`. |
| `controller.yml` | not-a-layer | none | no | — | The label poll: sets `agent-pr` and `risk:T*`, demotes a stale claim. It runs no tests and gates nothing. |
| `audit-merges.yml` | not-a-layer | none | no | — | A daily read-only audit that fails on a merge newer than its last green run. Advisory: it is not a required check of `main`. |
| `label-hygiene.yml` | workflow-only | none | no | daily 03:30 Asia/Shanghai, and workflow_dispatch | Scheduled cleanup of status labels on closed issues and pull requests (#738). A workflow-only layer with no test file of its own, and it gates nothing. |
| `nightly.yml` | workflow-only | none | no | daily 00:00 Asia/Shanghai, Sunday 01:00 compat matrix, and workflow_dispatch | The compatibility matrix (other OS, Node and DSH versions) on a schedule. It widens coverage but is not a gate, and its cases are not part of L1 or L2. |
| `release.yml` | not-a-layer | none | no | — | The mechanical release: preflight, release PR, tag. It runs no tests of its own. |

<!-- generated:testing-layers:end -->
