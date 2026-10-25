---
subsystem: live-e2e
owned_paths:
  - dev/live-e2e/
  - scripts/lint-live-e2e.mjs
---

# live-e2e (real-model browser suite)

The [#204](https://github.com/ThinkFlowLab/FlyBot/issues/204) live end-to-end suite:
app-independent scenarios with one adapter for the FlyBot web UI, run against the real
DeepSeek endpoint. Commands, budgets and the evidence rules are in
[the suite README](../../dev/live-e2e/README.md); the adapter contract is in
[docs/interop/live-e2e-adapter.md](../interop/live-e2e-adapter.md).

Which user journeys this suite is meant to cover, and what covers each one today, is the
[user-scenario matrix](../testing/user-scenarios.md) (#358). The matrix is the map; this
suite is one of its columns, not the map's owner.

## Owns

- `dev/live-e2e/`: the fixture and scenario/assertion modules, the FlyBot web adapter,
  the real-model bench launcher, the runner (guards, budgets, report, evidence
  sanitizer, grader hash) and the keyless fake-adapter tests.
- `scripts/lint-live-e2e.mjs`: lint using core's installed harness tooling.

## Invariants

- Scenario, fixture and assertion code never imports the adapter, a browser or DSH;
  it is covered keyless (`npm run test:live-e2e`, part of `verify`) through a fake
  adapter. The live command itself is never part of `verify`.
- The live run uses a real key from the environment and a fresh isolated bench home
  **outside this checkout** (`$LIVE_E2E_HOME`, default `~/.cache/flybot-live-e2e/<name>`,
  never under `~/.dsh`). The runner fails closed on a mock key, a loopback endpoint
  (except the usage tap with a real upstream), the user's own DSH home, a bench home
  inside this checkout, or an `--evidence` directory under `dev/live-e2e/` — those path
  guards compare canonical real paths, so a relative value or a symlink cannot slip
  through. No retries hide regressions.
- When the key is absent altogether, `live-e2e.yml` skips the six steps that need it and
  warns instead of failing every night (#794). A skipped run proves nothing about the
  suite, and the run summary says exactly that; a failure inside the suite still fails.
- The mock suites stay separate: this bench never starts the mock model, and the mock
  benches never gain a real key.
- Evidence is an explicit allow-list that passed the sanitizer (no `token=` URLs, no
  key material, no cookies); a sanitizer finding is an infra failure, never a pass.
- The grader is hashed before the first turn and again before the report (#398): a change
  under `dev/live-e2e/` ends the run as `tampered` (exit 5), with no sanitized stamp and the
  changed paths in `report.json`. A bench home inside this checkout is refused before the
  bench starts, because that workspace would hold the grader, and so is an `--evidence`
  directory under `dev/live-e2e/` (that run would hash its own report writes as tampering).
  Reads are **not** restricted by anything here — DSH's sandbox modes confine file effects,
  not reads — so read isolation is the deployment's job; `dev/live-e2e/README.md` carries the
  path-by-path table.
