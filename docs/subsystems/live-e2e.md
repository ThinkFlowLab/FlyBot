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

## Owns

- `dev/live-e2e/`: the fixture and scenario/assertion modules, the FlyBot web adapter,
  the real-model bench launcher, the runner (guards, budgets, report, evidence
  sanitizer) and the keyless fake-adapter tests.
- `scripts/lint-live-e2e.mjs`: lint using core's installed harness tooling.

## Invariants

- Scenario, fixture and assertion code never imports the adapter, a browser or DSH;
  it is covered keyless (`npm run test:live-e2e`, part of `verify`) through a fake
  adapter. The live command itself is never part of `verify`.
- The live run uses a real key from the environment and a fresh isolated bench home
  (`.dsh-test-*`, never under `~/.dsh`). It fails closed on a missing/mock key, a
  loopback endpoint (except the usage tap with a real upstream), or the user's own
  DSH home. No retries hide regressions.
- The mock suites stay separate: this bench never starts the mock model, and the mock
  benches never gain a real key.
- Evidence is an explicit allow-list that passed the sanitizer (no `token=` URLs, no
  key material, no cookies); a sanitizer finding is an infra failure, never a pass.
