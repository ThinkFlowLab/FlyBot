# AGENTS.md

Instructions for AI coding agents that work on this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md), which has the same rules with more detail.

## Before you code

1. Read [LESSONS.md](LESSONS.md) (open lessons are constraints).
2. Read [docs/code-standards.md](docs/code-standards.md) (Verifier honesty, fences, merge gate).
3. Keep the **Hard rules** below; never patch DSH or commit secrets.

## Pipeline contract

One issue → one branch → one PR → CI `tests-ok` → auto-merge (squash).

Grok Bot is the single entry point for humans; it schedules OpenCode (implements) and Codex (reviews).

1. **Issue.** Work one issue per session and per git worktree. Skim LESSONS and code-standards first. Security debt first: [#9](https://github.com/ThinkFlowLab/FlyBot/issues/9) → [#10](https://github.com/ThinkFlowLab/FlyBot/issues/10) → [#8](https://github.com/ThinkFlowLab/FlyBot/issues/8).
2. **Branch** from latest `origin/main`. Write a test that fails without the change, then fix the class of bug.
3. **Verify locally:** `npm run verify` at the repo root (Node 22+, see Commands).
4. **PR** to `main`. Imperative English title, `Fixes #N` in the body, and what you ran and did **not** run at the tip SHA. A user-visible change adds one fragment `changelog.d/<issue-or-slug>.<kind>.md` ([changelog.d/README.md](changelog.d/README.md)); never edit `CHANGELOG.md` in a feature PR. Squash is the only merge method; the PR title and body become the commit message, so keep the body short.
5. **CI.** The required check is `tests-ok`. It is green only when `test`, `plugins (tree)`, `plugins (social)` and `package` all pass. Never merge around a red check.
6. **Review and merge.** Review the **tip SHA** with [`review-pr`](.claude/skills/review-pr/SKILL.md) (PASS / FAIL / INC); a tip move voids the PASS. **Standing delegation, T0/T1 only:** an agent may enable auto-merge when the PR's tier is T0 or T1 (`node .github/scripts/risk-gate.mjs --pr <n>`), its tip carries an independent PASS from a login in [`.github/agent/review-policy.json`](.github/agent/review-policy.json) — the `reviewed tip` report, never the PR's own author — and the required checks are green: `gh pr merge --auto --squash --match-head-commit <sha>`. `main` requires a merge queue: that command enqueues the PR (gh may answer `The merge strategy for main is set by the merge queue` or `already queued`), the queue performs the squash merge, and a plain `--squash` merge is refused; do not retry ([merge plumbing](docs/autonomous-dev.md#merge-plumbing-merge_group-merge-queue-auto-merge)). T2 and T3 always wait for the maintainer's one-click approval, and so does any PR without a PASS at its tip, except a mechanical release PR under the [standing approval](#standing-approval-mechanical-release-prs) below. [`fix-issue`](.claude/skills/fix-issue/SKILL.md) walks all of this, with the environment gotchas.
7. **Stop** and hand over to the maintainer on a security-sensitive change, an unresolved maintainer decision, or when you cannot get a green tip.

When a class of bug repeats, date a lesson in LESSONS.md (`Seen N×`); after **≥3 days** promote the durable rule into `docs/code-standards.md` / CONTRIBUTING.

### Standing approval: mechanical release PRs

On 2026-10-19 07:02 (Asia/Shanghai) the maintainer, Danyang (GitHub `Birfy`), decided that FlyBot ships a real semver GitHub release daily (patch bump of the latest release, starting at `v0.2.0`, skipping a day with no changelog fragments), and grants a **standing approval** for the mechanical release PR, so the daily PR needs no fresh one-click approval. The approval is limited to a PR that changes only these files, and nothing else:

- `CHANGELOG.md` and `changelog.d/*`
- `core/package.json` and `core/package-lock.json`
- `patches/ds-bot/0007-version-and-tooling.patch`

It does not waive the checks: the PR still needs green required checks (`tests-ok`) at its tip SHA and the daily preflight (no release for that version yet, the latest `Test` on `main` green, at least one changelog fragment). Anything beyond those files needs the maintainer's fresh approval.

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
