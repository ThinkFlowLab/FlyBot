# Label-only controller

Status: **built, dry run by default.** Part of [autonomous-dev.md](autonomous-dev.md) (Phase 1, PR C).
`.github/workflows/controller.yml` runs `.github/scripts/controller.mjs` every 30 minutes and on demand. It uses
only the built-in `GITHUB_TOKEN`: no LLM, no secrets, no GitHub App, no stored token.

## What it does

It manages **labels and nothing else.** It never merges, approves, comments on, edits or closes anything, and it
never checks out or runs a PR or an issue. Issue and PR text is read as data (a regex for `Fixes #N`); the changed
files of a PR are read through the API and judged by the same rules as the risk gate (`.github/agent/risk-rules.json`).

| Rule | Effect |
| --- | --- |
| Every open PR (50 most recently updated, not `hold`) | `risk:T0`..`risk:T3` from the risk gate, replacing a stale `risk:T*`. If the files cannot be read, it changes nothing. **Advisory only:** a label exists once a run has seen the PR, and no merge decision reads it (see [Limits](#limits)) |
| An agent's PR | adds `agent-pr`. A PR is an agent's when its author is in `agentAuthors`, or its branch in this repository starts with an `agentBranchPrefixes` entry (`agent/`), or a branch in this repository says `Fixes #N` for an issue that is `agent-ready` or `agent-working`. A fork PR counts by author only. The label is never removed |
| An issue labeled `agent-ready` or `agent-working` | removes `agent-ready` **and** `agent-working` when the last `agent-ready` was set by someone who is not a maintainer, or when someone who is not a maintainer edited the text or title after it. Re-labeling by a maintainer re-approves it |
| A claim (`agent-working`) | removes `agent-working` when it is older than `claimTtlHours` (6) and no open PR that says `Fixes #N` has a commit or was opened within that time |
| `hold` on the issue or PR | everything is left alone |
| A label that does not exist in the repository | the add is skipped and reported, never created (the API would create it with a default color). Removals still happen |

Maintainers are the list in `.github/agent/controller.json` (`Birfy`, `hsliuustc0106`); editing it is T3. An editor GitHub
cannot name (a deleted account) is not a maintainer. The controller can never add `agent-ready` or `agent-working`:
`validatePlan` refuses it, and so does anything else outside the table above.

## Modes and switches

| Switch | Where | Effect |
| --- | --- | --- |
| *(default)* | nothing set | **dry run**: the `plan` job reads (read-only token) and writes the proposed changes to the job summary; nothing is changed, and the `apply` job does not run |
| `CONTROLLER_LIVE` = `true` | repository variable (Settings, Secrets and variables, Actions, Variables) | live: the `apply` job adds and removes the labels. Any other value, including `TRUE` or `1`, stays dry run |
| `AGENT_PAUSE` = `true` | repository variable | stops it completely: nothing is read, proposed or changed. The same variable is meant for the agents' scheduler |
| disable or delete the workflow | Actions tab, or delete `controller.yml` | off |

**This PR sets no variable.** To go live: a maintainer runs `node .github/scripts/sync-labels.mjs --repo ThinkFlowLab/FlyBot --apply`
(creates `risk:T0..T3`), reads a few dry-run summaries (Actions, Controller, run, summary; or `workflow_dispatch` one), and
then sets `CONTROLLER_LIVE=true`.

## Permissions (least per job)

| Job | `GITHUB_TOKEN` permissions | When |
| --- | --- | --- |
| `plan` | `contents: read`, `issues: read`, `pull-requests: read` | always |
| `apply` | `contents: read`, `issues: write`, `pull-requests: write` | only when `CONTROLLER_LIVE` is `true` and the plan has operations |

Workflow-level permissions are `{}`. `pull-requests: write` is there because labeling a PR goes through the issues API
and GitHub accepts either permission for it; the script calls only these writes: `POST .../issues/N/labels` and
`DELETE .../issues/N/labels/NAME` (the tests check that the source has no other write, no merge, review, comment or close endpoint,
no `eval`, no network access besides `gh`). Whether `issues: write` alone is enough for a PR was not testable without
going live; if the first live run answers 403 on a PR, that is the line to look at.

The `plan` job passes the plan to `apply` as a job output (numbers, fixed label names and fixed reason codes only). The
`apply` job validates it again, re-reads each target, and skips it if it is closed, has `hold`, or is already as planned.
Nothing from an issue or PR reaches a shell: the workflow has no `${{ }}` in a `run:` line and passes everything by `env`.
The script and `controller.json` come from the default branch (`checkout` of `default_branch`, no credentials kept).

## Limits

- It cannot see an edit older than the last 50 body revisions or the last 100 label/rename events of an issue; if it cannot
  find when `agent-ready` was set it leaves the issue alone and says so in the summary.
- Labels only: it leaves no comment, so the reason for a removal is in the job summary (the timeline shows `github-actions` removed the label).
- Events caused by `GITHUB_TOKEN` start no workflows, so nothing chains from its labels; it runs on the schedule.
- GitHub stops scheduled workflows of a public repository after 60 days without repository activity.
- **A missing `risk:T*` is not a tier.** GitHub runs scheduled workflows late under load: the 30-minute cron produced runs 2.5–6 hours apart on this repository (48 runs, all `success`, none skipped — #629), so a label may arrive hours after the PR is opened, and a PR opened and merged between two runs gets none at all. A fork PR cannot be labelled by its own `pull_request` run either (read-only `GITHUB_TOKEN`), which is why the external ones (#611, #619) lack it by construction. Nothing depends on the label: `merge-gate` recomputes the tier from the diff with the base copy of `risk-gate.mjs`, and `risk-tier.yml` reports the same tier on every PR, forks included. Read an absent label as "the poll has not seen this PR yet" — never as T0/T1 and never as a reason to block.
- 50 PRs and 50 issues per label per run (`controller.json`); about 3 API calls per PR per run.

## Try it by hand (read-only)

```sh
GH_REPO=ThinkFlowLab/FlyBot node .github/scripts/controller.mjs plan   # prints the plan; changes nothing
node --test .github/scripts/controller.test.mjs
```
