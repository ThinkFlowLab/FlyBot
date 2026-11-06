# Live E2E (#204)

Real-model, browser-driven end-to-end checks: upload an orders CSV through the web UI,
let the Main Bot write `summary.json` / `summary-east.json` with the real DeepSeek
endpoint, then verify the files, their survival across a reload, and the sidebar
previews — by content, never by a filename echoed in a reply. The scenarios and
assertions are app-independent ([adapter contract](../../docs/interop/live-e2e-adapter.md));
only `adapter.mjs` knows FlyBot. Nothing here ships in a package or runs in
`npm run verify`; the keyless fake-adapter tests do (`npm run test:live-e2e`).

## Layout

| File | Responsibility |
| --- | --- |
| `fixtures/orders.csv` | The fixed 5-row fixture the expected totals derive from. |
| `scenarios.mjs` | The four checks, task texts, pure assertions (parsed JSON, SHA-256 immutability). |
| `smoke.mjs` | The keyless checks (#2565): a message sent through the composer gets a reply, and both survive a reload. Run by `LIVE_E2E_MODE=mock`; no files, no model wording asserted. |
| `adapter.mjs` | The FlyBot web adapter: playwright-core from the harness checkout, UI task steps, read-only observation. |
| `bench.mjs` | A dsh web bench on this checkout. `LIVE_E2E_MODE=live` refuses a missing/mock key, `LIVE_E2E_MODE=mock` needs the loopback mock and reads no key; both keep the home outside the checkout and never touch `~/.dsh`. |
| `run.mjs` | The runner: guards, budgets, classification, report, evidence sanitizer. |
| `report.mjs` | Outcome contract, guard logic, the tamper rule (`integrityOutcome`), usage/classification, report assembly (pure, tested keyless). |
| `integrity.mjs` | The grader's own hash: `treeManifest` / `changedPaths` for the tamper check, and the path test the guards use (#398). |
| `sanitize.mjs` | The evidence gate: `token=` URLs, cookie material, the key value. |
| `test/` | Keyless fake-adapter coverage of every assertion path. |

## What the Bot under test may touch (#398)

The Bot under test holds the workspace the bench gives it, and the runner cannot take that
workspace away once the bench starts. So the split is written down here, and the runner enforces
the part a process can enforce:

| Path | Bot reads | Bot writes | Enforced by |
| --- | --- | --- | --- |
| the bench home (`$LIVE_E2E_HOME`, default `~/.cache/flybot-live-e2e/<name>`, never inside this checkout) | yes | yes | it is the workspace; `bench.mjs` and the runner refuse a home inside the checkout before the bench starts |
| `dev/live-e2e/**` (runner, scenarios, adapter contract, fixtures) | **yes, today** | no | `treeManifest` before and after the run; any change ends it as `tampered` (exit 5) |
| `dev/live-e2e/fixtures/orders.csv` (the answer key) | **yes, today** | no | same hash, and the expected totals are derived from it at assertion time |
| the checkout outside `dev/live-e2e/`, `~/.dsh`, the evidence directory | **yes, today** | no | guard: the home is outside the checkout and never under `~/.dsh`; `--evidence` inside `dev/live-e2e/` is refused (that run would record its own report as tampering); evidence edits show in the report's hash list |

The guards compare **canonical** paths (`realpath` of the deepest existing ancestor), so a relative
`--home`, a `sub/../` detour or a symlinked `$HOME` cannot make a directory read as outside the tree
it actually sits in.

**Reads are not restricted, and this repository cannot restrict them.** DSH's confining sandbox
modes restrict file *effects* — `read-only` permits only required sinks such as `/dev/null`,
`workspace-write` adds the workspace and a temp area — and neither denies a read
(`@deepseek-ai/dsh-sandbox`). Moving the grader out of the Bot's reach therefore needs a
deployment-level decision (a separate user, container or machine) and is tracked as the DSH-side
half of #398. What this runner does instead is make tampering visible and fatal: it hashes the
grader before the first turn and again before the report, and a difference ends the run as
`tampered` — invalid evidence, never a pass, never a warning — with the hash list and the changed
paths in `report.json`.

## Run it locally

Node 22.19+, pnpm, a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
checkout with `pnpm install` run in it (`../deepseek-harness`, or set `DSH_HARNESS`), and
a real `DEEPSEEK_API_KEY` in the environment. Chrome comes from `CHROME_BIN`, else
`google-chrome`/`chromium`(-`browser`) on PATH, else playwright's own download.

```sh
export DEEPSEEK_API_KEY=...            # real key (16+ chars, never the mock's); fails closed
export LIVE_E2E_HOME="$HOME/.cache/flybot-live-e2e/live-e2e"   # outside the checkout
node dev/live-e2e/bench.mjs live-e2e 3196 reset
node dev/live-e2e/run.mjs "$LIVE_E2E_HOME" 3196 --model deepseek-official/deepseek-flash
node dev/live-e2e/bench.mjs live-e2e 3196 stop
```

`bench.mjs` and `run.mjs` take the home from the same variable, and the default is the same on
both sides; `bench.mjs status` prints the directory it uses.

The report lands in `evidence/report.json` (screenshots, transcript beside it). To
record per-call token usage, start `core/dev/llm-tap.mjs <port> https://api.deepseek.com
<tap.jsonl>` first, run the bench with
`DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/anthropic`, and pass `--tap <tap.jsonl>`;
the loopback is accepted only with `LIVE_E2E_TAP_UPSTREAM=https://api.deepseek.com`.
A run costs real tokens (the pilot used ~116K); budgets default to 180 s per check and
250K tokens per run (`LIVE_E2E_CHECK_MS`, `LIVE_E2E_QUIET_MS`, `LIVE_E2E_MAX_TOKENS`),
with zero retries.

## Run the keyless mock suite

No key, no network to a model endpoint: the same bench and adapter, with the scripted mock
from `core/dev/mock-llm.mjs` answering (`LIVE_E2E_MODE=mock` also allows the loopback base
URL the live mode refuses). The checks are the two in `smoke.mjs`, not the four #204 task
checks — a scripted model does not write `summary.json`.

```sh
export LIVE_E2E_MODE=mock
export DEEPSEEK_BASE_URL=http://127.0.0.1:8765
MOCK_PORT=8765 node core/dev/mock-llm.mjs &          # the scripted model
node dev/live-e2e/bench.mjs live-e2e 3197 reset
node dev/live-e2e/run.mjs "$LIVE_E2E_HOME" 3197 --model deepseek-official/deepseek-flash
node dev/live-e2e/bench.mjs live-e2e 3197 stop
```

The runtime can be a published `@deepseek-ai/dsh` install instead of a source checkout: the
bench only needs the `dsh` command (a source tree has no built `lib/client.js`) and the
adapter `playwright-core` from `node_modules/.pnpm/node_modules`.

## In CI

`.github/workflows/live-e2e.yml` runs the same flow nightly at 00:30 Asia/Shanghai (and
on dispatch) on `main` only, with a window gate so a quiet `main` spends no tokens: it
clones the harness at the tag pinned in `core/dev/harness/package.json`, starts the tap,
resets the bench, runs the four checks and uploads the sanitizer-cleared allow-list.
The keyless `mock` job runs the two checks above on every pull request that touches `core/`
or `plugins/` and on the same nightly schedule, with no `secrets.*` in its environment and
the runner's summary appended to the job's step summary ([#2565](https://github.com/ThinkFlowLab/FlyBot/issues/2565)).
The four decisions behind this setup are recorded in
[#204](https://github.com/ThinkFlowLab/issues/204). "Stable" means five consecutive
scheduled runs green at one recorded configuration; until then the suite is evidence,
not a gate.
