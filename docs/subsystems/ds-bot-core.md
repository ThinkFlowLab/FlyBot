---
subsystem: ds-bot-core
owned_paths:
  - core/dev/
  - core/types/
  - ds-bot/
  - ds-bot.pin.json
  - patches/ds-bot/README.md
  - scripts/ds-bot-patches.mjs
---

# ds-bot-core

Patched upstream `ds-bot` that ships as `core/`. Never edit `ds-bot/` by hand; change `core/` and regenerate patches.

This page covers the pin, the patch format and the core's dev tooling. The generated output (`patches/ds-bot/*.patch`, `files/`, `topics.json`) is not owned: it follows from `core/`, so a core change need not edit this page for it; `patches/ds-bot/README.md` (the format) and `scripts/ds-bot-patches.mjs` are owned. The code itself is described by two pages: [core-host](core-host.md) (server: `core/index.js`, `core/src/host/`, `core/src/shared/`, `core/web-search.js`) and [core-client](core-client.md) (browser: `core/src/client/`, `core/client.js`).

## Owns

The mock smoke (`core/dev/smoke.mjs`) includes two API-only task clarification
steps: persist an input wait, then answer its current question (#207). Both must
make zero mock-model calls. They exercise the real DSH channel while the focused
task suite covers authorization, restart, stale answers and independent approval
holds. Task bookkeeping does not imply runtime execution or tool permission.

- `core/dev/` — harness packages, mock model, test bench, smoke test.
- Pin (`ds-bot.pin.json`), ordered patches and whole added files (`patches/ds-bot/`).

## Does not own

- Server and browser code of the core → [core-host](core-host.md), [core-client](core-client.md).
- FlyBot plugin API surface → [plugin-runtime](plugin-runtime.md) (except `core/types/` which this page claims for now).
- `plugins/tree/`, `plugins/social/` → their own pages.
- `core/scripts/`, arch-doc checks → [install](install.md).

## Key files

| File | Role |
| --- | --- |
| `ds-bot.pin.json` | Upstream pin. |
| `patches/ds-bot/` | Ordered patch topics. |
| `scripts/ds-bot-patches.mjs` | generate / check patches. |
| `core/dev/eval/` | User-scenario runner (#358): pure rubrics (`rubric.mjs`), canonical journey specs (`specs.mjs`), optional model judge (`judge.mjs`), grader hashing (#398, `guard.mjs`) and a CLI (`run.mjs`). Dev only, not part of `npm test`. |
| `core/dev/token-report.mjs` | Reads the usage ledger into per-Bot, per-Session and per-day token numbers and each Session's prompt growth, keeping fresh input, cache read and cache write apart (#799). Read-only; `--db`, `--from`, `--to`, `--tz`, `--bot`, `--top`, `--growth`, `--json`. |
| `core/dev/turn-split.mjs` | Reads Session logs into the split of one turn's prompt: the fixed block (system prompt plus tool schemas) measured as each Session's fit intercept, then history, tool results and task by character share (#796). Read-only; `--sessions`, `--session`, `--turn`, `--tz`, `--days`, `--top`, `--stats`, `--room`, `--json`. |
| `core/dev/experience/` | Offline experience library (#874 Step 2): JSON lessons under `repos/<owner>/<name>/` and `stacks/<techStack>/`. The read API is `core/src/host/experience.js` (see [core-host](core-host.md)). `check.mjs` validates the tree and can add one entry file. Not part of the npm `files` list, and not injected into a harness tier. |
| `core/src/host/hooks.js` (approvals) | Held sends bound to their owner — provenance, owner-bound decisions, stale revalidation. Chief replacement invalidates sender-side holds eagerly on `setMain` (not via `staleReason`). The authority contract lives in [team](team.md) (#52). |

## Entry points

- `core/index.js` — plugin server.
- `core/client.js` — built browser bundle (generated; never hand-edit).
- `dev/bench.sh`, `dev/smoke.mjs` — test bench. The mock reads who leads a group from the system prompt (`Members: … and you (admin).`), which is where the standing section puts that line (#894). A turn's own text no longer carries it, so "admin calls everyone" in the smoke is decided from the section (#917).

## Reviewing a tip without checking it out

`node scripts/ds-bot-patches.mjs review <sha> [test-file]` answers a review from one command. It downloads that commit's tarball from GitHub, commits it into a scratch repository so the pin can compute a tree, and compares that tree with the API's `commit.tree.sha` — a mismatch means the download is not that commit. Then it runs that tip's own `check` and `canonical`, and, when a test file is named, that file under `core/`. A tree mismatch, a red gate or a failing test prints the reason on stdout and exits non-zero, and nothing in the checkout changes. It needs `git` and `tar`; a public repository downloads without a token, and `DSH_SECRET_GITHUB_TOKEN` authenticates the download when set. The repository is `FLYBOT_REVIEW_REPO=owner/name`, else `GITHUB_REPOSITORY`, else the `upstream` and then the `origin` remote, because a fork pull request's tip lives in the fork. This checkout's `core/node_modules` and `core/dev/harness/node_modules` are lent to the scratch tree, so a named test runs without a second `npm install`.

## Invariants

1. `ds-bot/` stays pristine; CI fails if it differs from the pin.
2. `core/` == `ds-bot/` + `patches/ds-bot/files/` + `patches/ds-bot/*.patch`; regenerate after every `core/` change. A new file under `core/` (for example `test/new-chat.test.js`) is stored whole in `patches/ds-bot/files/` by `generate` and needs no `topics.json` entry; an upstream file edited for the first time must be listed in `patches/ds-bot/topics.json`. Otherwise `scripts/ds-bot-patches.mjs check` fails with “committed but not produced by the patches”. The format has no `index` lines or cross-hunk line numbers so parallel PRs merge cleanly (see `patches/ds-bot/README.md`).
   `check` does not mean the split is the one `generate` writes: a series re-split between topics still applies and still reproduces `core/`. `scripts/ds-bot-patches.mjs canonical` is the other half — it regenerates into a scratch copy and fails when the committed `patches/ds-bot/` would change — and both `.github/workflows/test.yml` and `npm run verify` run it (#1890).
   `check` also runs on a machine without `git` (#978), through the script's own applier at `git apply`'s strictness: a hunk body must carry the counts its header declares, must match at the old-side line that header names (no search for nearby context — the loose applier that did let `#934`'s extra blank line and `#966`'s 662nd line through was only caught by CI), may not run past the end of the file, and honours `\ No newline at end of file`. There the pin prints `skipped pin (no git): the tree hash cannot be computed here` instead of passing, and `generate` still needs git because it asks git for the diff. CI keeps the git path as the reference, and a test builds the series with both appliers and compares the trees.
3. `client.js` matches `core/src/client/`; `npm run build` + `--check`.

### FlyBot branding topic

- Topic `0014-flybot-branding` holds edits to upstream About / settings / diagnostics / update / parts / browser / secrets files. New files (`src/client/brand.js`, `test/branding.test.js`) are stored whole in `files/`. The npm package, plugin id, localStorage keys, `console.warn('[ds-bot]')`, and `update.js` repository URLs stay upstream.
4. Never touch the user's `~/.dsh`.

## Tests

`npm test` in `core/`; smoke test for `index.js` / `src/host/` changes.

The [same-room collaboration fixture](../interop/room-fixture.md) (#219) runs
through the real room relay with scripted DSH events. It exercises delegation,
required clarification, background work, actual synthetic code/tests, independent
artifact verification and simulated requester acceptance/rejection. Its reusable
inputs/checks live in `core/dev/room-collaboration/`; the two test directories and
Node process restrictions are not a full sandbox or a real-model trial.
The fixture's `--permission --allow-fs-read` flag is given the canonical path (`realpathSync`) of each
check directory: Node matches that flag literally while the ESM loader realpaths the modules it reads, so
a symlinked temp root (macOS `/var` → `/private/var`) would otherwise deny every read (#314).

`core/dev/room-smoke.mjs` (#198) drives the same acceptance shape one tier up, on a
real `dev/bench.sh` bench: actual DSH sessions, the scripted mock model, real shell
tool writes and test runs, and the task API lifecycle to `accepted`. It is a manual,
CI-optional smoke, still deterministic and token-free, not a real-model trial.

## Token report

The usage ledger (`src/host/usage.js`) is read outside the Usage page by
`core/dev/token-report.mjs` (#799): per Bot, per Session and per day it prints calls, fresh
input, cache read, cache write, output and their sum as a separate `prompt` column, the
per-call prompt percentiles (nearest rank), the top Sessions by prompt, and each Session's
prompt growth between consecutive calls. A prompt that shrinks inside a Session is a
compaction, a checkpoint or a new part, so it starts a new run instead of counting as a
negative delta. Fresh input and cache read are never summed into one figure. It opens the
ledger read-only, defaults `--db` to `$DSH_HOME/usage.sqlite`, and exits non-zero naming the
path when it is missing. The report it produced and its sample are in
[docs/reports/2026-10-23-token-spend.md](../../docs/reports/2026-10-23-token-spend.md);
`core/test/token-report.test.js` asserts hand-computed sums on a fixture ledger, the
missing-`--db` exit, and that every row of that report still carries its provenance.

The composition the ledger cannot show is read from the Session logs instead.
`core/dev/turn-split.mjs` (#796) folds one Session's events into the surface each call
sent — the surviving system prompt, the `request/header` tool list, every message and every
`tool/result` — and splits that call's provider-reported prompt into the fixed block,
history, tool results and task. The fixed block is measured, not assumed: it is the
intercept of `prompt = fixed + k × messageChars` fitted over the same Session's own calls,
so a per-part token figure stays a share of a measured total. The report it backs is
[docs/reports/2026-10-26-turn-input-split.md](../../docs/reports/2026-10-26-turn-input-split.md)
and `core/test/turn-split.test.js` pins the four rules behind the split. `--stats` re-derives
the tool-result, fan-out and retry numbers the report quotes in §5, §7 and §8 from one
command — `--room` names the room Session the fan-out is measured around — so a number on
that page has a command behind it.

## Common mistakes

- Hand-editing `ds-bot/` or `client.js`.
- Forgetting `node scripts/ds-bot-patches.mjs generate && check`.
- Running the bench against `~/.dsh`.
