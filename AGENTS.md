# AGENTS.md

Instructions for AI coding agents that work on this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md), which has the same rules with more detail.

## Before you code

1. Read [LESSONS.md](LESSONS.md) (open lessons are constraints).
2. Read [docs/code-standards.md](docs/code-standards.md) (Verifier honesty, fences, merge gate).
3. Keep the **Hard rules** below; never patch DSH or commit secrets.

## Pipeline contract

One issue → one branch → one PR → CI `tests-ok` → auto-merge (squash).

Grok Bot is the single entry point for humans; it schedules OpenCode (implements) and the owner's own reviewer Bot (reviews, acting as `Birfy`; owner decision 2026-10-19 15:31). Codex is not used for review: do not request `@codex review` and do not wait for a Codex review.

1. **Issue.** Work one issue per session and per git worktree. Skim LESSONS and code-standards first. Security debt first: [#9](https://github.com/ThinkFlowLab/FlyBot/issues/9) → [#10](https://github.com/ThinkFlowLab/FlyBot/issues/10) → [#8](https://github.com/ThinkFlowLab/FlyBot/issues/8).
2. **Branch** from latest `origin/main`. Write a test that fails without the change, then fix the class of bug.
3. **Verify locally:** `npm run verify` at the repo root (Node 22+, see Commands).
4. **PR** to `main`. Imperative English title, `Fixes #N` in the body, and what you ran and did **not** run at the tip SHA. A user-visible change adds one fragment `changelog.d/<issue-or-slug>.<kind>.md` ([changelog.d/README.md](changelog.d/README.md)); never edit `CHANGELOG.md` in a feature PR. Squash is the only merge method; the PR title and body become the commit message, so keep the body short.
5. **CI.** The required check is `tests-ok`. It is green only when `test`, `plugins (tree)`, `plugins (social)` and `package` all pass. Never merge around a red check.
6. **Review and merge.** Merge by tier ([`risk-gate.mjs`](.github/scripts/risk-gate.mjs): `node .github/scripts/risk-gate.mjs --pr <n>`). **T0 and T1** (owner decision 2026-10-19 11:45): an agent may enqueue the PR once `tests-ok` is green at its tip, it is mergeable, and it conforms to the design rules. No PASS is needed. **T2 and T3** need a PASS at the tip SHA from [`review-pr`](.claude/skills/review-pr/SKILL.md) (PASS / FAIL / INC) with green checks, and then **the agent that gated the PR enqueues it itself**: since 2026-10-21 the owner's authorisation is the [self-gate](#owner-decision-the-bot-gates-and-merges-its-own-prs-2026-10-21-owner-authorized), not a click in the UI. **Self-review counts** (owner decision 2026-10-19 11:43): a PR opened by the owner's Bot/agent (the `Birfy` account) may be PASSed by the owner's own reviewer Bot/agent; no independent reviewer is required. A tip move (any new commit) voids the PASS. Neither the PASS nor the self-PASS replaces green CI. Enqueue with `gh pr merge --auto --squash --match-head-commit <sha>`. `main` requires a merge queue: that command enqueues the PR (gh may answer `The merge strategy for main is set by the merge queue` or `already queued`), the queue performs the squash merge, and a plain `--squash` merge is refused; do not retry ([merge plumbing](docs/autonomous-dev.md#merge-plumbing-merge_group-merge-queue-auto-merge)). Never admin-merge and never bypass a gate. Exception: a mechanical release PR under the [standing approval](#standing-approval-mechanical-release-prs) below. [`fix-issue`](.claude/skills/fix-issue/SKILL.md) walks all of this, with the environment gotchas.
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

Decided by the owner (Danyang, GitHub `Birfy`) on 2026-10-18/19. Four scheduled routines run on the Grok Bot box, each with one job. A routine does only its own job.

### Routines

| Routine | Schedule | Job |
| --- | --- | --- |
| Product self-test | every 12 h | Uses FlyBot and Bot Social as a user and **only files issues**: no PRs, no pushed branches, no code changes. Each issue states the expected behavior and the change scope. Search for duplicates first. |
| Repo maintenance | every 2 h, FlyBot and Bot Social separately | The **only** routine that opens fix PRs. Each run: review open PRs against the design rules; triage every open issue (fixed, duplicate or obsolete: close with a comment; still valid: readiness check below); label every open issue and PR; develop only `agent-ready` issues; merge ready PRs through the merge queue within the gates below. Never deploys. Never edits `CHANGELOG.md` or a version number. |
| Daily release | about 02:00 Asia/Shanghai | Publishes a real semver GitHub release (tag = `core/package.json` version, patch bump per day, skipped when there are no changelog fragments) through a mechanical release PR. It owns `CHANGELOG.md` and the version. The files and the approval are in [Standing approval](#standing-approval-mechanical-release-prs). |

### Issue labels

- **Type** (exactly one): `bug`, `enhancement`, `documentation`, `accessibility`.
- **Area** (one or more): `area:social`, `area:ui`, `area:automation`, `area:release`, `area:security`, `area:docs`.
- **Source:** `self-test`.
- **State:** `needs-info` (spec unclear), `needs-human` (needs a design decision from the owner; the comment says what), `awaiting-approval` (legacy: a PR a person must decide on; routine T2/T3 PRs no longer wait for a click), `agent-ready`, `agent-working`, `agent-pr`, `hold`.
- **Controller-managed, never set by hand:** `risk:T0` to `risk:T3`, `agent-task`, `status:done`.
- `hold` means automation leaves the item alone.

### Triage: when an issue is `agent-ready`

Label `agent-ready`, with a triage comment, only when all three hold:

1. Every design conflict is resolved (owner design rules, recorded owner decisions, RFC/decision issues, other open issues and PRs), with no open question for the owner.
2. The expected behavior and the change scope are clear.
3. It is not `hold`, not a tracking/umbrella issue, and not team-via-groups work (that waits for the owner's go-ahead).

Otherwise label `needs-human` or `needs-info` and name the blocking conflict or question in a comment. Agents develop **only** `agent-ready` issues.

### Claim, PR, release of a claim

- Before work: skip the issue if someone else is assigned. Otherwise assign it to `Birfy`, add `agent-working`, and post a claim comment that names the branch.
- Stopping without a PR: unassign, remove `agent-working`, and comment why.
- The PR says `Fixes #N`, is assigned to `Birfy` and labeled `agent-pr`.

### Gates

- **T0 / T1:** merge through the merge queue once `tests-ok` is green at the tip, the PR is mergeable and design-conformant. No PASS is required.
- **T2 / T3:** a PASS at the head commit from a reviewer in [`.github/agent/review-policy.json`](.github/agent/review-policy.json), with green CI, and the agent that gated it then enqueues it itself ([self-gate](#owner-decision-the-bot-gates-and-merges-its-own-prs-2026-10-21-owner-authorized)). **Self-PASS counts:** a PR opened by the owner's Bot/agent (`Birfy`) may be PASSed by the owner's own reviewer Bot/agent (the policy's `selfReview` list); an independent reviewer is no longer required. Neither the PASS nor the self-PASS replaces green CI.
- Any new commit voids a PASS. CI green, the merge queue and the no-bypass rule apply to every tier.
- Agents never bypass a gate and never admin-merge (the routines run as the maintainer account `Birfy`, but use it only for the actions above, never for admin merge, bypass or changing protection rules). The merge queue squashes the PR title and body, so a `Docs-not-needed:` line goes in the PR **body** and also in a branch commit message (`npm run arch-docs` reads only the branch's commits). Run `verify` with `TZ=UTC`.

### Hard rules for agents

1. The self-test routine files issues only; the maintenance routine opens PRs; the release routine owns `CHANGELOG.md` and the version.
2. No deploy of production Bot Social, and no change to the owner's local instances, without the owner's explicit yes.
3. A routine PR is merged by the Bot that gated it (owner decision 2026-10-21, [self-gate](#owner-decision-the-bot-gates-and-merges-its-own-prs-2026-10-21-owner-authorized)). A typed chat reply is still not an approval for anything else, and an owner-only decision (scope, security surface, policy) still waits for the owner's word through the normal path (#349).
4. Connector tools are on by default for the owner's Bots and off by default for other people's, until the owner opts in (#359).
5. Bot Social has no keyword commitment scan.

## What this project is

FlyBot is a team of long-lived Bots, built on DeepSeek Harness (DSH). It has two parts:

- `ds-bot/`: pristine upstream ds-bot (Fei2411/DeepSeek-Bot), pinned in `ds-bot.pin.json`. **Never edit it.**
- `patches/ds-bot/`: FlyBot's ordered patches on it; see `patches/ds-bot/README.md`.
- `core/`: `ds-bot/` + the patches (committed, what ships and what tests run on): the Bot features, written as a DSH plugin. The plugin runs in DSH Desktop, in DSH Web and in the desktop app.
- `plugins/social/`, `plugins/tree/`, `plugins/timeline/`: peer plugins `@flybot/social`, `@flybot/tree` and `@flybot/timeline`.

The Bot team:

- Every Bot is a DSH Session and runs through the normal DSH agent loop, tools and model routes.
- The team works together: Bots message each other, share group chats and can see what the other Bots are doing. Each Bot still runs on its own and does not disturb the others.
- Bots have clear, different roles. A Main Bot has the highest rights: it changes and removes other Bots, and can create them. Other Bots do not get those management rights. There can be more than one Main Bot.
- **Tree child creation (#16, Option B).** A tree Bot (not only the Main/root) may call `create_child_bot` to create a child directly under itself. The tool takes no parent argument; `maxChildren` and depth limits stay in force. The new child is usable only by its creator's owner; sharing it with another person still requires an independent per-Bot grant (default deny). There is no publish mechanism. See [docs/subsystems/tree.md](docs/subsystems/tree.md).
- The multi-human authority contract (human owner ↔ designated Chief ↔ specialists) is documented in [docs/subsystems/team.md](docs/subsystems/team.md) as **planned, not shipped**: team mode stays disabled until its authorization gates pass. Issue #16 is resolved (Option B); do not re-open Main-only child creation.
- Users customize each Bot (name, role label, instructions, model, character).
- Behavior must be reliable: a Bot acts on evidence, stays inside its goal, and its results can be checked.

## Hard rules

1. **Build on DSH; never patch it.** Bot features use the documented plugin APIs. The desktop app starts DSH only through its documented entry points (`@deepseek-ai/dsh/profile-boot`, the `dsh` CLI). Never patch DeepSeek Harness or depend on files inside a DSH install. If something is missing in DSH, stop and say so; do not work around it with a patch.
2. **No secrets.** Never write, print or commit API keys, tokens, cookies or `DSH_HOME` contents. Use the mock model (`core/dev/mock-llm.mjs`) for tests; it needs no key.
3. **Only original material.** Do not copy code, text, icons, logos or graphics from other products or websites.
4. **The core is ds-bot + patches.** Change `core/`, then run `node scripts/ds-bot-patches.mjs generate` and `check`, and commit `core/` and `patches/` together. CI fails if `ds-bot/` differs from the pin or `core/` differs from `ds-bot/` + patches.
5. **`client.js` is generated.** Change `core/src/client/`, then run `npm run build` in `core/` and commit both files. Never edit `client.js` by hand.
6. **Do not touch the user's own DSH data.** The test bench keeps its data in `.dsh-test-<name>/`. Never point a test at `~/.dsh` or at a DSH that the user runs.

## Commands

**Node 22 or newer is required.** On Node 20 the tests fail with "Could not find test/*.test.js". CI uses Node 24; on the shared box use `PATH=/workspace/tools/node24/bin:$PATH`.

**One command, from the repo root:** `npm run verify` runs what CI runs, in CI's order: core lint (oxlint + `arch-docs`), plugin lint, `build-client.mjs --check`, `ds-bot-patches.mjs check`, the core suite and both plugin suites. It needs the one-time setup below (`npm ci` and `npm run harness` in `core/`). It does not run the pack check, typecheck or actionlint of the CI `package` job, and not the smoke test.

**Sandbox preflight (#607).** A session that starts on `workspace-write` on a host without a usable sandbox backend refuses every `bash` call with `SANDBOX_UNAVAILABLE` and looks merely stuck. Run `node .github/scripts/sandbox-preflight.mjs` once at the start (exit 0 usable, 3 blocked): if it is blocked, report one line (`blocked: no usable sandbox backend` plus the unlock it prints) and do not retry shell calls. File tools and the GitHub API still work, so code and PR work can continue; the policy tiers and their failure modes are in [docs/sandbox.md](docs/sandbox.md).

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
