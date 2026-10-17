# Autonomous development (Phase 0: report only)

Status: **Phase 0, plus a Phase 1 report.** Nothing here blocks, labels, comments on or merges anything. It adds a way to
file agent tasks, a label set, a PR template, a workflow that *reports* a risk tier (T0 to T3)
for each pull request, and a workflow that *reports* whether that PR's tip is reviewed. The rest of the plan is described so that later phases fit the constraints.

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
| A merge or tag made with it may not start `push` workflows (the `Test` run on `main`, `release.yml`) | documented rule, not tested here (see [Merge plumbing](#merge-plumbing-merge_group-merge-queue-auto-merge)): an auto-merge **enabled** with `GITHUB_TOKEN` is reported to merge silently | enable auto-merge with the agent's own credential, never with `GITHUB_TOKEN`; keep `release.yml` waiting for a green run on the tagged commit, and start `Test` by `workflow_dispatch` on `main` if the push run is missing |
| Read-only and no secrets on `pull_request` from forks | a `pull_request` job cannot label or enable auto-merge for a fork PR | run writers from `schedule` or `pull_request_target` with **base-branch code that never checks out or runs PR code** and reads the PR through the API only |
| Cannot approve PRs (`can_approve_pull_request_reviews` is off here) | the controller can never approve T3 | intended: a human approves |
| Cannot change `.github/workflows/**` | an Action cannot edit workflows | intended |
| About 1,000 API requests per hour per repository | a chatty controller stalls | few calls per tick, filter by label |
| `schedule` can lag by minutes and public repos' schedules stop after 60 days without activity | polling is not instant | acceptable; `workflow_dispatch` to run now |
| Merge queue needs a ruleset and the plan to allow it | docs say available (public, org-owned repo); not enabled or tested | `test.yml` already has `merge_group`; auto-merge works without the queue |

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

## The reviewed tip (Phase 1: report only)

A merge decision needs a check it can read, not a report in a chat. `.github/scripts/review-gate.mjs`
answers one question for a pull request: **does the current head carry an independent Verifier PASS?**
AGENTS.md step 6 is the rule it serves: under the standing delegation an agent may enable auto-merge
only for a T0/T1 pull request whose tip is reviewed, and this report is how it shows that.

What counts as a reviewed tip, all of it:

1. A pull request **comment or review body** by a login listed in `.github/agent/review-policy.json`.
2. Not the pull request's **own author**: no self-review, even when that login is listed.
3. The Verifier block `review-pr` already writes: `Tip SHA:`, `Ran:` with at least one command,
   `Not run:` (a gap named, not hidden), and `Verdict: PASS`.
4. The `Tip SHA:` **is the head being judged**. A later commit moves the tip and the old PASS stops
   counting; that report is then listed as "not counted", with the sha it named.
5. The **newest** report that names this tip decides, so a later FAIL at the same tip vetoes an
   earlier PASS, and a later PASS at the same tip replaces a FAIL.

| File | Purpose |
| --- | --- |
| `.github/agent/review-policy.json` | the logins whose PASS counts; editing it is T3 |
| `.github/scripts/review-gate.mjs` | the rule above, for one pull request at a time |
| `.github/scripts/review-gate.test.mjs` | stale tip, self-review, unlisted login, FAIL after PASS, missing `Ran:` / `Not run:`, and the workflow's shape |
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
without a PASS can still merge on the maintainer's approval.

**Why report-only.** No agent login is in the policy yet, so today only a maintainer's comment can
satisfy the gate. The delegation slice changes that: it adds the reviewer's login to the policy and
gives the implementer and the reviewer separate credentials. Until then this is evidence a human can
read, and the record every later auto-merge is checked against.

## Merge plumbing: `merge_group`, merge queue, auto-merge

`test.yml` has a `merge_group:` trigger. Nothing is enabled: with no merge queue it never fires.

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
- `risk-tier.yml` is `pull_request` only and report only: it does not run on queue entries and must stay out of the required checks.
- The `arch-docs` step fetches `origin/main` and deepens until `git merge-base origin/main HEAD` works. Emulated on a
  one-commit shallow checkout of a merge-queue-shaped commit (local bare remote): it falls back to deepening and
  `arch-docs: OK`. With a group size above 1, `arch-docs` sees the union of the grouped PRs; keep the group size at 1.
- A GitHub `merge_group` run itself could not be produced without enabling a queue (a ruleset change), so that part is untested.

**Read-only checks of the live repository (2026-10-15, `gh api` GET with a maintainer login):**

| Fact | Value |
| --- | --- |
| Repo | public, owned by an Organization |
| Merge methods | squash only; `delete_branch_on_merge: true`; `allow_auto_merge: true`; `allow_update_branch: true` |
| Branch protection on `main` | required checks: the `test` job and `tests-ok`; `strict: false`; no required reviews; `enforce_admins: false`; no force pushes |
| Rulesets | none at repo level (`[]`); the organization-level list needs the `admin:org` scope (not available, so unknown) |
| Org plan | not readable: `plan` is `null` without `admin:org` |
| Workflow token | default `read`; Actions cannot approve PRs |

**Merge queue availability.** GitHub's docs: "Pull request merge queues are available in any public repository owned by
an organization, or in private repositories owned by organizations using GitHub Enterprise Cloud". This repository is
public and org-owned, so it should qualify on any plan. Not verified here: the plan itself, and whether the setting
shows up for this repository (that needs an admin to open Settings, Rules; creating a ruleset was out of scope).
Enabling it later means a ruleset (or branch protection) with "Require merge queue" on `main`, squash, group size 1,
and the required checks `tests-ok` (and `test`). Keep `tests-ok` the single aggregate.

**Does an auto-merge by `GITHUB_TOKEN` start the `push` workflows? Unverified here; assume no.** GitHub documents that
events caused by `GITHUB_TOKEN` (except `workflow_dispatch` and `repository_dispatch`) create no workflow runs. Several
independent public reports say the same for `gh pr merge --auto` run with `GITHUB_TOKEN`: the merge is attributed to
`github-actions[bot]` and the `push` run on `main` never starts. A real test needs a PR that actually merges into
`main` (or a scratch base branch with its own protection), which was out of scope. Consequences and the safe design:

- The controller must **not** enable auto-merge (it is label-only anyway). Agents enable it with their own credential.
- If a merge ever lands without a `Test` run on `main`, start one with `gh workflow run Test --ref main`
  (`workflow_dispatch` is exempt from the rule; needs `actions: write`), so `release.yml` has a green run to wait for.
- Whether merges made by the merge queue itself start `push` workflows is also unverified.
- To check it once, with the maintainers' consent: merge one trivial PR with auto-merge enabled by the intended
  credential, then `gh run list --workflow Test --branch main --limit 3` should show a `push` run on the merge commit.

## Next phases (not built)

1. **Merge plumbing.** The `merge_group` trigger is in `test.yml` (above). Still to do: enable the queue if wanted, and test the
   auto-merge push behavior. Conflict-proofing for generated files is a separate PR (patch format, changelog fragments, split core pages).
2. **Controller, label-only** (`schedule` plus `workflow_dispatch`, `GITHUB_TOKEN`): demote `agent-ready` after a
   non-maintainer edit, set `agent-pr` and `risk:T*`, expire stale claims, a pause variable and a kill-switch drill.
   Enforce the tier with a required check and CODEOWNERS for T3 approval.
3. **Agents on a dedicated credential**, one open PR at a time, with the cost caps in one config file.
   Add the reviewer's login to `.github/agent/review-policy.json` in the same change: until it is
   listed, no agent report can satisfy the reviewed-tip gate.
4. **Auto-merge T0/T1** after a cooling period, on the gate above as its evidence; T3 stays human. Then edge releases, a red-`main` watchdog, and T2 behind a smoke gate.
