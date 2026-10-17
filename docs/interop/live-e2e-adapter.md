# Live E2E adapter contract (#204)

**Status: implemented for FlyBot; one adapter exists.** The scenarios, fixtures and
assertions in [dev/live-e2e/](../../dev/live-e2e/) are app-independent: they talk to
any implementation of the interface below and to nothing else — no browser, no DSH, no
FlyBot import. The FlyBot web adapter (`dev/live-e2e/adapter.mjs`) is the first
implementation; running the same scenarios on Orbit needs its own adapter
([#209](https://github.com/ThinkFlowLab/FlyBot/issues/209), *not exercised*).

## Relation to the OpenCode pilot contract

[opencode-pilot.md](opencode-pilot.md) specifies the offline, envelope-level contract
between two agent runtimes (typed JSON envelopes, approvals, journals), simulated by
`dev/interop/` without a model or network. This document specifies the other axis: the
UI-level contract for driving a real app through a real user path — upload, task,
delivery, preview, reload. Both are development-only contracts that ship in no package;
one verifies interop semantics offline, the other verifies the app end to end online.

## The interface

An adapter is one conversation with one app instance on a fresh, isolated home. Task
steps must go through the app's real entry surface (the UI); observation may use the
app's own read-only APIs and storage. Setting up the environment before the first task
(for FlyBot: picking the Main Bot's model) is not a task step and may use the app's API.

| Operation | Meaning |
| --- | --- |
| `uploadFile(name, bytes)` | Attach a file to the conversation the way a user does. |
| `sendTask(text)` | Send a task message and return; settling is explicit. |
| `settle(budgetMs)` | Bounded wait until the app is idle after a task; throws on timeout. |
| `deliveredFileNames()` | Names the UI itself lists as delivered (cards/chips), for presence checks only. |
| `readFile(name)` | The file's bytes from the run's storage, or `undefined`. Evidence of delivery. |
| `openPreview(name)` | Open the artifact's preview in the UI and return the displayed text. |
| `reload()` | Reload the app view (survival check). |
| `conversationLines()` | Visible lines as `{ who: 'user' \| 'app', text }`. |
| `screenshot(name)` | Evidence capture; adapters that cannot, no-op. |

Rules an adapter must hold:

- Fresh run id, home and workspace per run; the fixture data is fixed by the suite.
- Nothing a task needs may be done through the observation side — a filename echoed in
  a reply is never evidence of delivery (`readFile`/`openPreview` are).
- Every wait is bounded by the caller's budget; no internal retries.

## Assertions (owned by the suite, not the adapter)

- Delivered JSON is compared **parsed**; `count` and `total` must be numbers. Only the
  input CSV is compared byte-for-byte (SHA-256, before and after each later task;
  `summary.json` is pinned by SHA-256 once delivered).
- Expected values are derived from the fixture CSV (paid = A001/A002/A004/A005 → 4/400;
  paid ∧ 华东 = A001/A004 → 2/140), so a fixture change that breaks the stated totals
  fails the keyless tests, not the nightly.

## Outcome contract

`pass | assertion_failed | provider_failed | infra_failed | budget_exceeded`, exit codes
0–4, one structured report per run (`flybot-live-e2e/1`): run id, revision, runtime and
model config, resolved endpoint (non-loopback, key not the mock's — fail closed
otherwise), absolute ISO-8601 timestamps with offset plus human times in the run's zone
(Asia/Shanghai), monotonic per-check durations, token/cache usage, and the sanitizer
verdict over the uploaded evidence. Budgets default to 180 s per check, 250K tokens per
run; a budget stop is reported as `budget_exceeded`, never retried.
