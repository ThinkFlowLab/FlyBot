# Dev pipeline: from an agent-ready issue to a mergeable PR

Related #3393.

This document describes how one issue actually moves through the pipeline, what each step produces, and how failures are handled. Directory ownership and the per-area self-check commands are in
[UI_SURFACES.md](UI_SURFACES.md); the QA evidence format is in [qa-evidence-template.md](qa-evidence-template.md).

## 0. What the machines enforce today (status, not a plan)

| Item | Enforced by | Status |
|---|---|---|
| The 7 suite jobs in `tests.yml` + the aggregate gate `FlyBot required checks` | GitHub required check | the only required check; the name must not change |
| `risk-tier` (T0–T3 from the diff) | workflow | report-only; not required. A T3 PR is green here too |
| `silent-revert` (looks for silent reverts on a PR) | workflow | report-only; findings are always green (exit 0), only a fault in the script itself goes red |
| `audit-merges` (looks for commits on main that skipped the queue) | workflow | runs on the default branch via `schedule` only; no check appears on PRs |
| One comment per (object, marker) | `comment-guard.mjs` | the script exists, invoked by hand or by another script; no CI gate |
| Claim marker | convention | no machine check |
| Merge decision | FlyBot Lead | the Lead states it and records the head and the reason; the Tier is advisory, not a veto |

Conclusion: **only `FlyBot required checks` will stop a merge for you.** Everything else is evidence and
reminders, read by a human. Any claim in a document that something "will block" holds for this one check only.

## 1. State machine

Run the steps in order; each step leaves its output on GitHub (issue labels/comments, PR, check), never in private notes.

1. **Triage.** Only pick open issues labeled `agent-ready`. Do not touch `hold`; on `needs-human`, stop and
   report so a human decides. Before starting, confirm nobody else is already on it (no `agent-working`, no
   open PR pointing at it).
2. **Slice.** Split one issue into one reviewable slice: input, output, acceptance criteria, directories
   involved, which self-check to run. One PR carries one slice; two slices mean two branches and two PRs.
3. **Claim.** Add `agent-working`; write the branch name in a comment. Branch off `main` and name it
   `dev/<issue-number>-<short-description>`.
4. **Develop.** Assign the work per the directory boundaries in `UI_SURFACES.md`. After changing files, run
   the self-check from that table ("what to run locally") before pushing.
5. **QA evidence.** QA verifies against the exact head (not the author's working copy); the format is in
   `qa-evidence-template.md`. A new commit invalidates the earlier evidence.
6. **Review.** Look at four things: `Related #N`/`Refs #N` with no `Fixes`/`Closes`/`Resolves`; conclusions
   bound to the head SHA; one slice; local green and CI green reported separately. Review comments go on the PR.
7. **Risk labeling.** The tier produced by `risk-gate.mjs` is applied to the PR as a `risk:T*` label by a
   script (never by hand). The Tier is advisory and is not a merge gate: a T3 proceeds like any other, with
   no human-approval step (since 2026-11-26).
8. **Merge.** FlyBot Lead decides and performs the merge: `FlyBot required checks` all green and the evidence
   above on the PR; the merge note records the head and the reason. The Tier is advisory, not a veto.
   Do not claim parity; do not claim acceptance.

Any step that finds the record disagreeing with reality (the comment says A, the code does B) sends the work
back — that is the most common reason for sending work back in this pipeline.

## 2. Directory → who does it

| Directory | Member | Notes |
|---|---|---|
| `flybot_workspace/**` (including `static/**`) | UI Dev (pages) / Runtime Dev (Python server) | the two sides are not independent, see UI_SURFACES §4 |
| `runtime/flybot-workspace-web/**` | UI Dev | `npm test` |
| `runtime/flybot/**`, `.github/scripts/**`, `.github/workflows/**` | Runtime Dev | check the gate names before touching a workflow |
| `services/**`, `deploy/**`, `manager/**` | Services Dev | |
| `tests/**`, evidence | QA Engineer | |
| `docs/DEV_PIPELINE.md`, reviews, opening PRs | FlyBot Lead | writes are performed only by the Lead or by a token-bearing script |

`runtime/ds-bot-upstream/**` is a vendor tree and is never edited by hand (`scripts/ds-bot-upstream.mjs check`
fails); fixes go into the patch layer `runtime/flybot/patches/**`.

## 3. Templates

### 3.1 Slice (written by the Lead when assigning work)

```
Issue: #<n>  Title: <…>
Slice: <one sentence, one reviewable change>
Input: <current state/defect to read, with code locations>
Output: <which files are added/changed; branch name dev/<n>-<short-description>>
Acceptance: <verifiable items, one per line>
Self-check: <command + expected output>
Not doing: <related problems explicitly excluded, left for the next slice>
```

### 3.2 Claim comment

```
Claiming #<n>: <one-sentence scope>
Branch `dev/<n>-<short-description>`, branched from main `<main40>`.
Self-check plan: <command>.
```

### 3.3 QA evidence

Use `docs/qa-evidence-template.md`, fill all five sections, leave no `{{…}}` behind. Section 5, "this evidence
is not an acceptance", must not be removed.

### 3.4 Review comment

```
Review <head40> (PR #<n>)
Related/Refs: <present / absent Fixes|Closes|Resolves>
Slice: <single slice / mixed in X>
Binding: conclusions bound to head <head40>; local green <command and numbers>; CI green <as of UTC, which are success, which not yet finished>
Risk: script output <T*>, matches label <risk:T*> (the Tier is advisory, not a veto)
Send back / release: <what is missing, who must add it>
```
