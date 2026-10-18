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
| `adapter.mjs` | The FlyBot web adapter: playwright-core from the harness checkout, UI task steps, read-only observation. |
| `bench.mjs` | A dsh web bench on this checkout with the real endpoint; refuses missing/mock keys, never touches `~/.dsh`. |
| `run.mjs` | The runner: guards, budgets, classification, report, evidence sanitizer. |
| `report.mjs` | Outcome contract, guard logic, usage/classification, report assembly (pure, tested keyless). |
| `sanitize.mjs` | The evidence gate: `token=` URLs, cookie material, the key value. |
| `test/` | Keyless fake-adapter coverage of every assertion path. |

## Run it locally

Node 22.19+, pnpm, a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
checkout with `pnpm install` run in it (`../deepseek-harness`, or set `DSH_HARNESS`), and
a real `DEEPSEEK_API_KEY` in the environment. Chrome comes from `CHROME_BIN`, else
`google-chrome`/`chromium`(-`browser`) on PATH, else playwright's own download.

```sh
export DEEPSEEK_API_KEY=...            # real key; the runner fails closed without it
node dev/live-e2e/bench.mjs live-e2e 3196 reset
node dev/live-e2e/run.mjs .dsh-test-live-e2e 3196 --model deepseek-official/deepseek-flash
node dev/live-e2e/bench.mjs live-e2e 3196 stop
```

The report lands in `evidence/report.json` (screenshots, transcript beside it). To
record per-call token usage, start `core/dev/llm-tap.mjs <port> https://api.deepseek.com
<tap.jsonl>` first, run the bench with
`DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/anthropic`, and pass `--tap <tap.jsonl>`;
the loopback is accepted only with `LIVE_E2E_TAP_UPSTREAM=https://api.deepseek.com`.
A run costs real tokens (the pilot used ~116K); budgets default to 180 s per check and
250K tokens per run (`LIVE_E2E_CHECK_MS`, `LIVE_E2E_QUIET_MS`, `LIVE_E2E_MAX_TOKENS`),
with zero retries.

## In CI

`.github/workflows/live-e2e.yml` runs the same flow nightly at 00:30 Asia/Shanghai (and
on dispatch) on `main` only, with a window gate so a quiet `main` spends no tokens: it
clones the harness at the tag pinned in `core/dev/harness/package.json`, starts the tap,
resets the bench, runs the four checks and uploads the sanitizer-cleared allow-list.
The four decisions behind this setup are recorded in
[#204](https://github.com/ThinkFlowLab/issues/204). "Stable" means five consecutive
scheduled runs green at one recorded configuration; until then the suite is evidence,
not a gate.
