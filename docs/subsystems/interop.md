---
subsystem: interop
owned_paths:
  - dev/interop/
  - scripts/lint-interop.mjs
---

# interop (offline development harness)

An offline contract simulator for [#198](https://github.com/ThinkFlowLab/FlyBot/issues/198)
and [#200](https://github.com/ThinkFlowLab/FlyBot/issues/200), not a shipped adapter.
Commands, semantics and limitations are in [the harness README](../../dev/interop/README.md).

## Owns

- `dev/interop/`: bounded versioned codec, durable synthetic task coordinator,
  two-owner grant policy, fake runtime/clock, demo and deterministic tests.
- `scripts/lint-interop.mjs`: lint using core's installed harness tooling.

## Invariants

- No model, credential, real process, DSH data or network access. The command
  preload rejects accidental network/process calls; it is not a security sandbox.
- Owner identities stay distinct. Same-owner social friendship is rejected;
  sending and executing require separate owner-bound mock decisions.
- Only selected task data reaches a typed untrusted mock input; there is no real
  prompt builder or tool executor here.
- Persist inbox/cursor, dedupe, work reservation and execution intent before
  advancing/dispatching. Ambiguous outcomes stay uncertain and are not retried.
- Cancel tombstones survive reopen; runtime stop must be observed separately.
  A returned result needs explicit requester acceptance and can be cancelled.
- Limits survive restart. The last allowed turn may finish; new turns are denied.
  The coordinator mirrors proposed host behavior without modifying `tasks.js`.
- Only explicit `RuntimeRecoveryError` transport/evidence failures become
  `uncertain`; assertion, storage and programming errors propagate. A cancellation
  racing completion records `stopped` without reviving execution.
- `result-ready` tasks do not occupy an execution slot while awaiting acceptance;
  they still count toward the journal's total task bound.

## Tests and gates

`npm run test:interop` covers the collaboration path, isolation, approvals,
revocation, malformed/out-of-order/duplicate messages, ambiguous recovery,
cancellation, budgets and journal ownership. `npm run lint:interop` lints the
harness. Root `npm run verify` includes both. Required CI runs the suite in the
`package` job and lint in the core test composite.

No real OpenCode API, Bot Social enrollment, model output, OS sandbox or human
acceptance is validated. These mock results satisfy none of the team-mode gates.
