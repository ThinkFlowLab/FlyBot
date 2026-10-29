# Stage 1 dogfood: the #1550 classification, approval and reclassification

## Date

2026-10-29, 11:32Z (19:32 Asia/Shanghai) — the day the walk-through concluded. The classification
this record reclassifies was taken on 2026-10-28.

## Decision

Record the real walk-through of [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550) as Stage
1's worked example of the governance loop, including the reclassification, so the loop has a record
instead of a claim:

- [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550) was opened on 2026-10-28 at 03:53:30Z
  as a product and operating-contract proposal, not an implementation ticket.
- `Triage` classified it **`needs-human`** on 2026-10-28: label event at 13:46:33Z, comment
  `6470699727` at 13:46:34Z. No pull request and no agent queue until the owner set direction.
- The owner **changed that answer on 2026-10-29**: `needs-human` removed at 11:32:21Z, and `Chief`
  recorded the instruction in comment `6495508222` at 11:32:35Z. Stage 1 was approved and started.
- `Chief` filed the first slice as [#1680](https://github.com/ThinkFlowLab/FlyBot/issues/1680) at
  11:32:49Z; `Dev` implemented it as [#1682](https://github.com/ThinkFlowLab/FlyBot/pull/1682) and it
  merged at 12:12:23Z as `c5ed512d6731e6d30d93f32b8c19f04779b5f725`.
- This record and its issue [#1685](https://github.com/ThinkFlowLab/FlyBot/issues/1685) are the next
  Stage 1 slice.

The reclassification, stated explicitly: **what Triage decided** was that a proposal changing the
product and operating contract has no reproducible defect and no acceptance criteria, so the
admission line gives it no pull request and the owner's direction is required first. **Why** is that
rule itself ([AGENTS.md](../AGENTS.md#triage-when-an-issue-is-agent-ready),
[docs/governance.md](../docs/governance.md) §1 and §6). **Who changed it** was the owner, through the
instruction recorded in comment `6495508222`; the label removal at 11:32:21Z is the mechanical act of
that instruction, 14 seconds before the comment. **On what authority**: conclusion of a major
decision is reserved to the owner and human maintainers (governance §1, §3), and the owner's
direction is also the authorisation the admission line asks for. **What evidence changed the
answer**: direction and acceptance criteria now existed — the approval of the target model and the
five-stage sequence, Stage 1's scope fixed as written, and Stage 1 split into reviewable slices
(`#1680` and, after it, `#1685`) each carrying its own acceptance and the usual gates. The absence
that produced `needs-human` was not evidence that the proposal was wrong; it was evidence that the
owner had not yet decided, and the owner then did.

## Class

major — it records the stage-scope change approved on 2026-10-29 (the start of Stage 1), the same
class as [2026-10-29-stage-1-approved.md](2026-10-29-stage-1-approved.md), and
[governance §1](../docs/governance.md) classes a change of scope for a stage, and a roadmap change,
major. A record is required for it by [README](README.md#when-a-record-is-required).

## Evidence

- [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550) opened 2026-10-28 at 03:53:30Z; it
  describes itself as a design/roadmap proposal and asks that the shared data/runtime contract be
  resolved before development issues are split.
- `Triage`, 2026-10-28 13:46:34Z, comment `6470699727` on #1550, with the `needs-human` label added
  at 13:46:33Z: the proposal is a product and operating-contract change, not a reproducible defect,
  with no acceptance criteria — so no pull request, no agent queue, and the owner's direction is
  waited for. That comment objected to no part of the proposal.
- Owner instruction, 2026-10-29 11:32:35Z, comment `6495508222` on #1550, `Written-by: Chief`:
  the target product model and the five-stage sequence are approved, Stage 1 starts now,
  `needs-human` is removed on the owner's instruction, Stage 1's scope is unchanged (no new UI, no
  DAG-engine rewrite, no second board, no scheduler), Stage 5 stays gated by its own research
  proposal, Stage 1 is split into reviewable deliverables, and #1550 stays the umbrella and is not
  closed by a pull request. The `needs-human` label was removed at 11:32:21Z.
- [#1680](https://github.com/ThinkFlowLab/FlyBot/issues/1680) opened 2026-10-29 at 11:32:49Z, 14
  seconds after the instruction comment, for the minimal Project State (`PROJECT.md`, `ROADMAP.md`,
  `docs/governance.md`, `decisions/`).
- [#1682](https://github.com/ThinkFlowLab/FlyBot/pull/1682) opened 11:46:23Z, head
  `145ed2d95625b95771624c52e43d85223963c8f6`, base `11a4be75c5b6148d4a1b05fa308ecebe7e3a337f`, five
  added files (446 lines, 0 deleted), no code. Its tier was quoted at the tip as
  `risk-tier: T3; basis: decisions/2026-10-29-stage-1-approved.md=T2, decisions/README.md=T2,
  PROJECT.md=T2, ROADMAP.md=T2, docs/governance.md=T0` (comment `6495886898`, 11:51:19Z): the
  unnamed root and `decisions/` paths are `unknownPathTier` T2 and the 479-line diff exceeded the
  250-line T2 limit.
- `Reviewer` posted `Verdict: PASS at 145ed2d95625b95771624c52e43d85223963c8f6`, comment
  `6496127715`, 2026-10-29 12:03:25Z, with the commands it ran; the account `Birfy` merged the pull
  request at 12:12:23Z as `c5ed512d6731e6d30d93f32b8c19f04779b5f725`, which was the head of `main`
  when this record was written (read 2026-10-29 12:21Z).
- [#1685](https://github.com/ThinkFlowLab/FlyBot/issues/1685) opened 2026-10-29 at 12:15:23Z;
  `Triage` readied it at 12:19:49Z (comment `6496492231`), fixing the filename and the field set
  against [README](README.md) rather than leaving the implementer to guess.
- #1550 carries exactly two comments in total, `6470699727` and `6495508222`; nobody else wrote on
  the thread before or after the approval — the basis for `Dissent: none recorded` below.

## Participants

- **Human — the owner, Danyang (GitHub `Birfy`).** The only human input to this decision. The owner
  approved the target model and the five-stage sequence, set and kept Stage 1's scope, instructed
  that `needs-human` be removed, and supplied the admission-line authorisation recorded in comment
  `6495508222`. No other human maintainer joined, and no Maintainer seat was asked.
- **Automation — `Chief`.** Wrote and posted the owner-decision comment `6495508222`, removed the
  `needs-human` label at 11:32:21Z, split Stage 1 into reviewable slices and opened `#1680`. It did
  this on the owner's instruction, not on its own authority.
- **Automation — `Dev`, `Reviewer`, `Triage`.** `Dev` implemented `#1682` and pushed its tip
  `145ed2d9`; `Reviewer` wrote the PASS at that tip (`6496127715`); `Triage` classified `#1550` on
  2026-10-28 and re-read `#1685` as ready on 2026-10-29 (`6496492231`).
- **What automation could not do on its own.** It could not approve the direction, could not lift
  the `needs-human` hold without the instruction, and could not set the stage's scope: those are
  reserved to the owner and human maintainers by governance §1 and §3. The label change and the
  comment are the Bot's act on the instruction; the decision they carry is the owner's.

Attribution caveat, stated because it is true today: every Bot writes as the shared `Birfy`
identity, so "the owner instructed this" rests on the text of comment `6495508222` under
`Written-by: Chief`, not on a signature ([governance §7](../docs/governance.md)).

## Dissent

none recorded. The 2026-10-28 `needs-human` classification was a routing and escalation label under
the triage rule, not an objection to the proposal's content, and its comment `6470699727` disputes
no part of it. No participant recorded an objection to the approved direction; #1550's only other
comment is the approval itself, and silence is not counted as participation.

## Status

accepted — the walk-through is what happened on 2026-10-29; Stage 1 is the active stage.

## Links

- Proposal and approval: [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550); owner decision
  comment `6495508222`; Triage classification comment `6470699727`.
- Stage 1 deliverable that followed: [#1680](https://github.com/ThinkFlowLab/FlyBot/issues/1680), its
  pull request [#1682](https://github.com/ThinkFlowLab/FlyBot/pull/1682), merge
  `c5ed512d6731e6d30d93f32b8c19f04779b5f725`, and the Reviewer PASS `6496127715`.
- This record's own task: [#1685](https://github.com/ThinkFlowLab/FlyBot/issues/1685).
- Earlier record it builds on: [2026-10-29-stage-1-approved.md](2026-10-29-stage-1-approved.md).
- Rules applied: [docs/governance.md](../docs/governance.md) §1 (classify), §3 (major decisions),
  §5 (disagreement and reclassification), §6 (escalation) and §7 (what is not shipped).

## Consequences and open questions

- Stage 1's acceptance asks for a recorded reclassification case; this record is that case. Two
  sentences elsewhere still say no case exists — `ROADMAP.md` ("open — not yet recorded", line 33)
  and [governance §7](../docs/governance.md) — and this change deliberately does not edit either:
  the issue's scope is one record plus the README index, and a governing-document edit is its own
  major change. They stay wrong until that separate change lands, and that is recorded here rather
  than hidden.
- The reclassification here is the triage label (`needs-human`), not a challenge to an
  ordinary/major/severe class under governance §5; that challenge path is still unexercised.
- [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550) stays open as the umbrella. Stage 1
  continues with later slices, each needing green `tests-ok` at its tip and the usual gates.

Written-by: Dev
