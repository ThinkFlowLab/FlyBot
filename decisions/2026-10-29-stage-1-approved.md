# Stage 1 approved, five-stage direction adopted

## Date

2026-10-29 (Asia/Shanghai).

## Decision

The owner approved the target product model and the five-stage sequence proposed in
[#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550), and **Stage 1 starts now**: FlyBot
development is run as an AI-governed Project, dogfooding the governance loop with the Bots, groups,
tasks and GitHub this repository already has.

Stage 1 begins with the minimal Project State — [PROJECT.md](../PROJECT.md),
[ROADMAP.md](../ROADMAP.md), [docs/governance.md](../docs/governance.md) and this
[`decisions/`](README.md) directory — filed as
[#1680](https://github.com/ThinkFlowLab/FlyBot/issues/1680).

Scope stays what Stage 1 itself says: no new UI, no rewrite of the DAG engine, no second board and no
scheduler.

## Class

major — the approved direction changes what the project is and what later work is in scope.

## Evidence

- [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550): proposal with the product model, the
  decision contract, the Project State file set and the five stages, including Stage 1's acceptance
  criteria and the Stage 5 gate.
- `Triage`, 2026-10-28 13:46:34Z on [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550):
  `needs-human` — the proposal is a product and operating-contract change with no reproducible defect
  and no acceptance criteria, so no pull request and no agent queue until the owner sets direction.
- `Chief`, 2026-10-29 11:32:35Z on [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550):
  records the owner's decision to approve the target model and the five-stage sequence, start Stage 1,
  remove `needs-human`, keep the Stage 1 scope as written, and keep Stage 5 gated by its own research
  proposal; splits Stage 1 into reviewable deliverables, the first being
  [#1680](https://github.com/ThinkFlowLab/FlyBot/issues/1680).

## Participants

- **Owner:** Danyang (`Birfy`) — concluded the decision and instructed the Stage 1 start.
- **Chief:** recorded the decision on the issue, split it into deliverables and opened
  [#1680](https://github.com/ThinkFlowLab/FlyBot/issues/1680).
- **Triage:** classified the proposal and held it for the owner on 2026-10-28; took no part in the
  approval itself.

No human maintainer other than the owner joined this decision.

## Dissent

none recorded. The 2026-10-28 `needs-human` classification was a routing decision, not an objection
to the content, and no participant recorded an objection to the approved direction.

## Status

accepted — in effect from 2026-10-29; Stage 1 is the active stage.

## Links

- Proposal and approval: [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550).
- Stage 1 deliverable this record was made for: [#1680](https://github.com/ThinkFlowLab/FlyBot/issues/1680).
- Project State published by that deliverable: [PROJECT.md](../PROJECT.md),
  [ROADMAP.md](../ROADMAP.md), [docs/governance.md](../docs/governance.md),
  [decisions/README.md](README.md).
- Governing rules it relies on: [AGENTS.md](../AGENTS.md) (including the owner decision of
  2026-10-21 that a Bot gates and merges its own pull requests, T2 and T3 included).

## Consequences and open questions

- Stage 1's acceptance still asks for a **recorded disagreement or reclassification case**, and for a
  written account of what Chief could automate and what needed a human. Neither exists yet; the
  roadmap lists both as open.
- The **Stage 5 gate is unchanged** by this decision: no Stage 5 development, no agent-queue
  assignment and no performance claim until a separate proposal defines its optimization objects,
  evaluation criteria, safety boundaries, experiments and measurable acceptance tests.
- The Maintainer console, the Member role and the Project Assistant described in
  [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550) are **not shipped**. Stage 1 runs on the
  existing Bots, groups, tasks and GitHub.
