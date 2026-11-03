# Governance

How this project decides things, in the wording the repository actually uses today. It is the
operational form of the decision contract in
[#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550), applied to the Bots, groups, tasks and
GitHub settings that already exist. Where this page and [AGENTS.md](../AGENTS.md) disagree,
`AGENTS.md` wins and this page is the thing to fix.

Roles are described in [PROJECT.md](../PROJECT.md). Dated decisions are recorded in
[`decisions/`](../decisions/README.md); this page is the rule, a record is the instance.

## 1. Classify first

Every decision that is not already covered by a routine gets a class. **Chief** assigns it and writes
the class and one line of rationale where the work lives (the issue or the pull request), with its
`Written-by:` line. A classification is a routing label. It is never an authorization, and no label —
including a `risk:T*` label, a chat message or a `Written-by:` line — confers or bypasses a GitHub or
FlyBot permission.

| Class | What it covers | Who concludes it |
| --- | --- | --- |
| **Ordinary** | Work already inside an accepted routine: a fix for a reproducible defect, a tested change to one subsystem, a documentation correction, a routine release. Reversible, and the existing gates are enough | The routine's own gate (§2). No separate approval |
| **Major** | Roadmap or architecture change, a change to a governing document (`AGENTS.md`, `CONTRIBUTING.md`, this page, `PROJECT.md`, `ROADMAP.md`, `.github/agent/risk-rules.json`, review policy), a public API or multi-subsystem contract, a change of scope for a stage | A **human maintainer**, under the participation rule in §3, recorded in `decisions/` |
| **Severe** | Credible risk of secret or credential exposure, data loss, irreversible impact, loss of an authorization boundary, or a production deploy of Bot Social | The **owner** only, after the pause in §4 |

Ambiguity resolves **upward**: a Bot that cannot tell ordinary from major treats it as major; a human
maintainer that cannot tell major from severe asks the owner. Nothing becomes ordinary because the
change looks small.

## 2. Who concludes an ordinary decision

Ordinary work is concluded by the gate that already exists, and the tier is computed from the diff
by [`risk-gate.mjs`](../.github/scripts/risk-gate.mjs) — never read from a label:

- **T0 / T1:** `tests-ok` green at the tip, the pull request mergeable, design-conformant. No PASS and
  no approval click.
- **T2 / T3:** a **PASS at that tip** from a login in
  [`reviewers`](../.github/agent/review-policy.json), plus green CI. The Bot that gated it then
  enqueues it itself (owner decision 2026-10-21, "the Bot gates and merges its own PRs", including
  T2 and T3) — that self-gate is a review, not an approval click, and it never becomes an admin
  merge, a bypass, or a ruleset change.
- **Every tier:** the merge queue is the only route into `main`; `merge-gate` re-judges the head on
  the queue entry; `hold` is human-only and blocks mechanically; and the implementer never writes the
  verdict on its own change. One tip carries one conclusion — a second `Verdict:` at the same tip is
  an incident, and a correction reads `Correction from <Bot>: …`.

A routine decides **only** inside its own job ([Routines](../AGENTS.md#routines)). The self-test
routine files issues, never pull requests; the maintenance routine opens fix pull requests; the
release routine owns `CHANGELOG.md` and the version under the standing approval.

## 3. How a major decision is concluded

1. **Proposal.** The change is stated on an issue, with what it changes, what it costs, and what
   would count as evidence that it worked.
2. **Classification and research.** Chief classifies it major, writes the rationale, and gathers the
   facts the participants need (existing behaviour, the affected subsystems, prior decisions).
3. **Participation.** Everybody whose subsystem or routine the change touches is a required
   participant. A maintainer who has not been asked is not a participant, and silence is not consent.
4. **Discussion, not silent approval.** Objections are answered in the thread, not outvoted by
   silence. An unresolved objection keeps the decision open; it does not become an approval because
   a timer expired.
5. **Conclusion and record.** A human maintainer concludes it. The outcome is written to
   [`decisions/`](../decisions/README.md) — date, decision, evidence, participants, dissent, status,
   links to the tasks it produces — and the resulting work is filed as ordinary issues.
6. **Implementation.** The code still travels through the gates in §2. A major decision does not
   exempt its own pull request from `tests-ok`, the queue or the tier.

## 4. Severe decisions and the pause

When a proposed action carries a credible and irreversible risk, the decision is severe, and the
risky **action** pauses while the risk is reviewed:

- Any participant may raise the objection, and a substantive minority objection is enough to pause.
  This is minority protection **against the risky action**; it is not authority to impose an
  alternative course.
- Chief stops the action, records the objection verbatim, and escalates to the owner.
- The owner decides: proceed with stated mitigations, proceed differently, or stop. The decision and
  its reasoning are recorded in `decisions/`.
- A severe decision is never concluded by a Bot, a vote of Bots, or a green CI run.

## 5. Disagreement and reclassification

- **Challenging a class.** Any human maintainer may ask Chief to reclassify, in a comment on the
  issue or pull request. Chief answers with the new class and the reason, or keeps the class and says
  why. A challenge never blocks the safe part of the work and never authorizes the risky part.
- **Where it is recorded.** A challenge that changes the class is recorded in the decision record:
  the original classification stays visible, the new one is added as a line with its date and the
  person who raised it, and `Status` is updated. A disagreement that does not change the class is
  recorded in that record's `Dissent` field, verbatim and attributed.
- **Corrections are new text.** Nobody edits another writer's sentence to change what it said. A
  corrected record is a new file, or a new dated line in the same file, with `Status: superseded by
  …`; the old text stays readable.
- **Disagreement between Bots.** A cross-role disagreement that the roles cannot settle is escalated
  to Chief, who may convene a temporary discussion using an existing group. The meeting archives one
  decision and creates the linked tasks; it is not itself a new permanent workflow.
- **Nothing becomes true by repetition.** A verdict is never re-posted at the same tip to win an
  argument, and a second conclusion at one tip is treated as an incident, not a tie-breaker.

## 6. Escalation to the owner

Escalate, instead of deciding, when the matter is reserved to the owner (§1), when a maintainer
disagrees with a Bot's classification and no human maintainer can settle it, when a security or
data-loss risk appears, when a scope would grow beyond the approved stage, or when the same blocking
condition survives three attempts.

The escalation is one comment on the issue that says: the question, the options, the evidence, what
Chief recommends, what happens by default if nobody answers, and who must answer. It is labelled
`needs-human` so automation leaves the item alone. The owner answers on the issue; Chief records the
answer in `decisions/`, removes `needs-human`, and files the resulting tasks.

## 7. What is true today, and what is not yet

Stated plainly so nobody plans against a mechanism that does not exist:

- The Owner and the human **Maintainer** seats exist (see [PROJECT.md](../PROJECT.md)). There is no
  Maintainer console, no Member role and no Project Assistant; the multi-human authority contract in
  [subsystems/team.md](subsystems/team.md) is **planned, not shipped**.
- Classification is still written in issue and pull request comments; there is no engine that
  classifies. Meetings are convened and recorded through the host `meeting` tool (§8, Stage 4.1).
- **One reclassification case is recorded**, in
  [decisions/2026-10-29-stage-1-dogfood.md](../decisions/2026-10-29-stage-1-dogfood.md): Triage
  classified [#1550](https://github.com/ThinkFlowLab/FlyBot/issues/1550) `needs-human` on
  2026-10-28, and the owner reclassified it on 2026-10-29, which took the label off. That case is the
  triage label, not a challenge to an ordinary/major/severe class under §5; that challenge path is
  still unexercised.
- Every Bot writes as one shared `Birfy` identity, so a `Written-by:` line is a claim that the gates
  check for presence and name. Per-workstation signatures were declined by the owner on 2026-10-25;
  the residual risk is stated in [AGENTS.md](../AGENTS.md), not solved here.

## 8. Meetings (Stage 4.1)

A meeting is how an unresolved architecture conflict gets a record before it gets code. It runs
`open → deliberating → decided | blocked` and is refused a second open meeting on the same question.
A `decided` meeting passes the governance check in `core/src/host/meetings.js` as code — every invited
participant recorded a position (or is recorded as not answering), the decision names its owner, and
a dissent that still stands carries its own owner — and only then writes one
`decisions/<date>-<slug>.md` in the shape [`decisions/README.md`](../decisions/README.md) requires and
produces follow-up tasks carrying that file as evidence. `blocked` states the blocking question in one
sentence and writes nothing. A Project Assistant may take a position but never closes the meeting or
writes the decision; the Chief or the owner does. The meeting record itself stays in the existing
store, and the file it archives is the durable part.

## 9. Changing a gate needs a second person

The acceptance gates — `merge-gate`, `review-gate`, `pass-label`, `risk-gate`, the
`enqueue-guard` and `enqueue-rules` that decide the merge queue, `scripts/self-test-catalog.mjs`,
and the checker and workflow step that enforce this rule — are listed in
[`policy/gates.json`](../policy/gates.json). A pull request that edits one of them, or anything
under `policy/`, must carry one line in its body:

```
Policy-sign: <comment id or url>
```

The comment it names must be on that pull request, must have been written by someone other than the
pull request's author, and must name the tip it signs — the head sha, in full or abbreviated to at
least twelve characters. A GitHub bot account cannot sign. `Test`'s `Gate change signature` step runs
before the suite, so a missing line, a comment that is not on the pull request, a self-signature, or a
comment written for another tip fails the pull request. Anyone else with comment access can sign, and
editing the body is the whole ceremony: no new workflow, no threshold changes, no merge path.

A signature signs one head, not one pull request: every new tip needs a new comment and a new line.
That is the price of binding, and it is the point — a signature that survived a push would let an
author sign a reviewable change set and then push another one under it.

The cost is accepted and is real: a gate change — including our own Bots' pull requests — waits for a
second person to comment before it can merge, so the Lead of the round that owns the pull request asks
for the signature and adds the line. A line written into the body after the check went green starts no
new run; the step reads the body on the next push and on the queue entry. The step runs in the `test`
job of every pull request and fails closed when it cannot read the pull request at all, so a GitHub API
outage reddens `tests-ok` for every pull request, not only the ones that change a gate.
