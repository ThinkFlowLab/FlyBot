# User-scenario matrix

One table that maps the real user journeys to what covers them **today** and what the
Nightly rewrite should cover next (#358). It is the map; the tests are elsewhere. The
journeys below are the draft from the issue, kept as the proposal; corrections belong in
review, not in a quiet edit.

Two things this page deliberately does **not** decide:

- **`Nightly target` is the owner's call.** Every cell reads `TBD (owner decides)`, with
  the proposal from [#358](https://github.com/ThinkFlowLab/FlyBot/issues/358) in
  parentheses where the issue made one, so the column can be signed off in one pass
  instead of reading a decision this PR invented.
- **Which journeys are in scope at all** is still the proposal in the issue body. A row is
  added or dropped by that discussion, not here.

Rules for the `Today` column: it must point at something concrete — a test file,
`.github/workflows/nightly.yml`, `.github/workflows/live-e2e.yml`, or
`core/dev/eval/specs.mjs` — or say `none`. A row may not claim coverage without a pointer.

| ID | Scenario | Persona | Surfaces | Plugins | Today | Nightly target | Blocked by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Cold start → first message sendable | personal solo | local Desktop, local web | core | none | TBD (owner decides); proposal: perf, #357 | #356, #357 |
| P2 | Single Bot chat with one tool call | personal solo | local web | core | `.github/workflows/live-e2e.yml`, `core/test/rounds.test.js` | TBD (owner decides); proposal: live E2E + E2E mock | — |
| P3 | Tree run: Chief → children → one combined answer | personal solo | local web | core, tree | `core/dev/eval/specs.mjs` (`P3-tree-split`), `core/test/bot-tree.test.js` | TBD (owner decides); proposal: live E2E | — |
| P4 | Invite a friend, message their Bot, approve the held reply | personal + friend | local web | social | `core/dev/eval/specs.mjs` (`P4-invite-approve`), `core/test/held-reply.test.js` | TBD (owner decides); proposal: live E2E | — |
| P5 | Face-to-face room: join, @Bot, leave | personal + friend | local web | social (face rooms) | `core/test/face-people.test.js` | TBD (owner decides) | — |
| P6 | Timeline: read swimlanes after a multi-Bot run | personal solo | local web | timeline | `core/dev/eval/specs.mjs` (`P6-timeline`) | TBD (owner decides); proposal: live E2E + perf | — |
| P7 | Long session: 500+ messages, scroll and reopen | personal solo | local web | core | none | TBD (owner decides); proposal: perf, #356/#357 | #356, #357 |
| P8 | Background tab hidden 5 min, then return | personal solo | local web | core | none | TBD (owner decides) | #259 |
| X1 | Slow or failing model API: waiting, timeout and retry are clear | any | local web | core | none | TBD (owner decides); proposal: E2E mock | — |
| X2 | Permission denied / no grant | team member | deployed instance (#352) | social, grants | `core/test/authz.test.js` | TBD (owner decides) | #51, #352 |
| T1 | Assign a task, the owner sees Needs you, approves | team | deployed instance (#352) | inbox, social | none | TBD (owner decides) | #349, #149, #352 |
| T2 | Approval latency across two instances | team | deployed instance (#352) | social | none | TBD (owner decides) | #352 |
| T3 | Reminder: an approval waits too long | personal, team | local web | reminders (#353) | none | TBD (owner decides) | #353 |
| T4 | Scheduled morning summary arrives | personal | local web | reminders (#354) | none | TBD (owner decides) | #354 |
| T5 | Reminder while the desktop app is closed (24/7) | personal | external channel (#355) | reminders, #352 | none | TBD (owner decides) | #355, #352 |

## How to use it

1. **A journey changes → the row changes the same day.** The ids are stable: `P*` are
   personal-mode journeys, `X*` cross-cutting failures, `T*` team-mode journeys.
2. **`core/dev/eval/specs.mjs` follows these ids.** Its `journey` field is the P-id of the
   row it scores (`P3`, `P4`, `P6` today), so a new P-row that gets a canonical rubric
   needs a spec with the same id — and the id in this table is what `run.mjs` reports.
3. **The Nightly rewrite reads the `Nightly target` column** once the owner signs it
   (#357 wires the metrics into it). Until then, `nightly.yml` stays as it is.

## Out of scope here

Rewriting `.github/workflows/nightly.yml` and implementing any missing test. This page is
signed first; the suites follow.
