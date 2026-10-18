# Deterministic same-room fixture (#219)

Run from `core/`, with the pinned test harness installed:

```sh
node --import ./test/harness-resolve.mjs --test test/room-collaboration.test.js
```

The fixture uses the real FlyBot `group_relay`, delivery/event handlers and task
channel, with scripted DSH session events. It makes no model or network calls.
The coordinator writes the synthetic implementation and represents the task
requester; this is not an autonomous model run, automatic task/exchange wiring,
or actual human review. No host runtime or permission behavior is changed.

## Scenario and evidence

`core/dev/room-collaboration/fixture.mjs` provides the requirement, clarification,
input rows and executable checks for a small `totalPaid(orders, region)` module.
All files live under a fresh temporary root and are removed after each case.

1. The requester creates and starts a task on Chief in the Pilot room.
2. Chief delegates with `@Writer`; Writer asks in the same room what omitted
   region means. No fixture edit has occurred yet.
3. Chief answers: include all regions. The coordinator explicitly records the
   question/answer through existing requester-only task actions.
4. Writer starts tool work. The existing grace timer yields the room; the
   finished result posts back as a late reply and starts a new round for Chief.
   This preserves the normal per-member/round bounds instead of expanding them
   to make the five-message workflow fit in one round.
5. The coordinator writes Writer's code and executes its two narrow self-checks.
   Chief's seven independent checks then run against a copy of the exact returned
   code bytes, verified by SHA-256, in a separate verifier directory. Writer's
   test/data files are not copied into the verifier directory.
6. The task remains `result-ready` until the simulated requester accepts or
   rejects it. Early acceptance is refused. A partial implementation passes the
   Writer check but fails independent verification and is rejected; a correct
   result can also be rejected by the requester.

The tests assert room message order and authorship, separate room Session IDs,
clarification provenance, background-result routing, actual subprocess exit
status, artifact digest and final task disposition. A printed success message
cannot substitute for executing either test suite.

## Execution limits

The Writer and verifier files have separate directories. Verification children
receive an environment containing only `TZ=UTC`, a five-second timeout, bounded
output, and Node's permission mode with read access to their own fixture directory
only; no filesystem writes, child processes or workers are granted. The code
under test is synthetic and supplied by this test.

These are test-process limits, **not** evidence of two isolated live Agents or
a full OS sandbox. Node's permission model is not a hostile-code security
boundary and this configuration does not enforce network isolation. The parent
test coordinator can access both directories. The fake Session controller does
not launch an actual DSH model/tool process. Do not use this runner to execute
untrusted returned code from a live peer without the separately validated
deployment boundary required by #198.

Current FlyBot `workDirOf` selects a room directory ahead of a Bot directory;
room members can therefore share a writable directory. Distinct room Sessions,
Cordis contexts, processes or directories do not establish isolation by
themselves. A live trial must explicitly enforce separate workspaces, private
data/credentials, OS process and network policy, and controlled artifact export.

## Remaining gates

The fixture is a deterministic DSH host baseline, not completion of #198's
DSH + DSH or DSH + OpenCode real-runtime acceptance. It does not cover parallel
task/session mappings, execution approval UI, deployment confinement, room
closure/revocation races, restart reconciliation, durable execution budgets,
OpenCode API compatibility or model performance. The existing focused suites
remain responsible for their own authorization/lifecycle cases; combining
those results is not proof of an integrated external-runtime workflow.

Keep these inputs/assertions when adding another runtime, while replacing the
scripted session driver with observed execution. Real-model trials still need
approved models and explicit time/request/usage/cost limits. Record mocked
execution, API connectivity, real-model completion and human acceptance as
different evidence levels.
