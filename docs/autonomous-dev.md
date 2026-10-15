# Autonomous development (Phase 0: report only)

Status: **Phase 0.** Nothing here blocks, labels, comments on or merges anything. It adds a way to
file agent tasks, a label set, a PR template, and a workflow that *reports* a risk tier (T0 to T3)
for each pull request. The rest of the plan is described so that later phases fit the constraints.

## Adaptation: no GitHub App, no Cursor cloud agent

Decisions by the maintainer, and what follows from them:

1. **No GitHub Apps.** The deterministic controller runs in GitHub Actions on the built-in
   `GITHUB_TOKEN` with the least permissions per job. It has no LLM and no secrets.
2. **No Cursor GitHub App on ThinkFlowLab**, so no Cursor cloud agent on this repo. LLM agents
   (triage, implement, review) run **outside Actions**, as Grok Bot routines or agents on the Grok Bot box.
3. **Agents act only on issues labeled `agent-ready`**, and only maintainers set that label.
   No LLM reads other issues, so there is no triager for outside text.
4. **T3 (high risk) PRs get a human one-click approval** and are never auto-merged.
5. Budget is not set. Every cost cap will live in one config file (open PRs, attempts per PR,
   PRs per day, minutes per attempt) so it can be changed without code.

```
issue (agent-task form) --maintainer adds agent-ready--> agent (outside Actions) --branch + PR-->
   Actions (GITHUB_TOKEN, no LLM): tests-ok, risk tier --T0/T1--> auto-merge --T3--> human approves
```

| Role | Runs where | Credential | Can do |
| --- | --- | --- | --- |
| Controller: tier, labels, enable auto-merge, watchdog | Actions, base-branch code, no PR code run | `GITHUB_TOKEN`, per-job least permissions | label, comment, `gh pr merge --auto --squash` |
| Agents: implement, review | Grok Bot routine or box-side agent | a **dedicated least-privilege credential** (not yet provided) | push a branch or fork, open a PR, comment, review |
| Merge | GitHub auto-merge (merge queue later, if available) | none: GitHub merges when the required checks pass | squash only (repo setting) |
| Humans (`Birfy`, `hsliuustc0106`) | GitHub | own accounts | approve T3, set `agent-ready`, hold, pause |

Agents must never use a maintainer's admin login. On a shared box, set `GH_TOKEN` (and a separate
`GH_CONFIG_DIR`) for the agent process so `gh` cannot fall back to a stored admin login.
Nothing in this repo creates tokens or secrets.

### Limits of `GITHUB_TOKEN`, and the workarounds

| Limit | Consequence | Workaround |
| --- | --- | --- |
| Events it causes do not start workflows (except `workflow_dispatch` and `repository_dispatch`) | a label, comment, push or PR made by an Action does not trigger other workflows; chains of "label, then workflow" do not work | do the whole decision in one job; poll on `schedule`; chain explicitly with `gh workflow run` (dispatch) |
| A merge or tag made with it may not start `push` workflows (the `Test` run on `main`, `release.yml`) | unverified for auto-merge: test it before relying on it | keep `release.yml` waiting for a green run on the tagged commit, and start `Test` by `workflow_dispatch` if needed |
| Read-only and no secrets on `pull_request` from forks | a `pull_request` job cannot label or enable auto-merge for a fork PR | run writers from `schedule` or `pull_request_target` with **base-branch code that never checks out or runs PR code** and reads the PR through the API only |
| Cannot approve PRs (`can_approve_pull_request_reviews` is off here) | the controller can never approve T3 | intended: a human approves |
| Cannot change `.github/workflows/**` | an Action cannot edit workflows | intended |
| About 1,000 API requests per hour per repository | a chatty controller stalls | few calls per tick, filter by label |
| `schedule` can lag by minutes and public repos' schedules stop after 60 days without activity | polling is not instant | acceptable; `workflow_dispatch` to run now |
| Merge queue needs a ruleset and the plan to allow it | unverified for this org | auto-merge works without it; the queue is a later phase |

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
approval is enforced (Phase 2).

### Label flow

1. A maintainer files the **Agent task** form (label `agent-task`). The form cannot add `agent-ready`:
   GitHub applies template labels whatever the author's permissions.
2. A maintainer reads it and adds `agent-ready`. That label is the only permission an agent has.
   Setting it again after someone else edits the issue is a manual rule now; a controller will enforce it later.
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

| Tier | Meaning (later phases) | Examples |
| --- | --- | --- |
| T3 | human one-click approval, never auto-merged | `.github/**`, `AGENTS.md`, `package.json`, `ds-bot/**`, trust-boundary host files (`authz`, `channel`, `reach`, ...), `plugins/social/src/**`; `child_process`, `eval`, new URL hosts, token env vars, `.skip`/`.only`, fence/sanitize/display-name code; over the size cap |
| T2 | may auto-merge behind a smoke gate, much later | other `core/src/host/**`, `plugins/**`, unknown paths |
| T1 | may auto-merge | `core/src/client/**`, tests, generated files |
| T0 | may auto-merge | `docs/**` (except policy docs), READMEs |

The rules are in `.github/agent/risk-rules.json`; changing them is T3. Tests may quote URLs and fence
words without a hit; `.skip`/`.only` still count in tests.

Run it by hand (read-only API calls with your `gh` login):

```sh
node .github/scripts/risk-gate.mjs --pr 96 --repo ThinkFlowLab/FlyBot
node .github/scripts/risk-gate.mjs --replay 30 --repo ThinkFlowLab/FlyBot   # tiers of the last 30 merged PRs
```

**Replay when this was written** (last 30 merged PRs, #41 to #96): T0 1, T1 2, T2 2, **T3 25**.
Of the 25: 14 trust-boundary paths, 7 CI or agent-rule paths, 2 content hits only, 2 size only.
So for FlyBot's current mix most PRs need the human click; the share that does not grows only if the
trust-boundary code is split out. Review the tiers by hand before enforcing anything: the four PRs
decided by content or size alone (#60, #63, #74, #76) are the ones to argue about.

### Security of the report workflow

`pull_request` event, `contents: read` and `pull-requests: read`, no secrets, no `pull_request_target`.
The script and rules are checked out from the **base** commit and the PR is read through the API, so
a PR cannot change the rules that judge it. The one exception is the PR that first adds the script
(base has none), which falls back to its own copy under the same read-only token; the fallback step can be
deleted once the script is on `main`. The workflow must stay out of branch protection and out of the
`needs` of `tests-ok`; a test checks that.

To switch the report off: disable the workflow in the Actions tab, or delete `.github/workflows/risk-tier.yml`.

## Next phases (not built)

1. **Merge plumbing.** `merge_group` in `test.yml` and a merge queue if the plan allows it; test that an auto-merge
   by `GITHUB_TOKEN` starts the `main` workflows. Conflict-proofing for generated files.
2. **Controller, label-only** (`schedule` plus `workflow_dispatch`, `GITHUB_TOKEN`): demote `agent-ready` after a
   non-maintainer edit, set `agent-pr` and `risk:T*`, expire stale claims, a pause variable and a kill-switch drill.
   Enforce the tier with a required check and CODEOWNERS for T3 approval.
3. **Agents on a dedicated credential**, one open PR at a time, with the cost caps in one config file.
4. **Auto-merge T0/T1** after a cooling period; T3 stays human. Then edge releases, a red-`main` watchdog, and T2 behind a smoke gate.
