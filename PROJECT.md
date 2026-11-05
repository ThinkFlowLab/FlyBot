# FlyBot — Project State

#2483 Chief may explicitly choose continue/latest through the existing successor contract. Latest uses the snapshotted host HEAD for clean unbound work; drafts and PR ancestry remain protected. No default baseline or role is inferred.

Earlier recovery checkpoints are [preserved verbatim](docs/history/2026-11-05-baseline-memory-checkpoints.md).
Current constraints remain: proven worker/lease exit; Chief owns recovery decisions;
no stale receipt/action replay or acceptance across unhandled input; no permission
from repository text. Isolated Dev Git capability never exposes shared metadata.
Refused durable reads prohibit writes. Provider merge notification is separate from
Chief acceptance; continuation retains Task-role context/drafts/history and exact
new evidence. Unknown exit/publication stays held. See owned subsystem contracts.

The single page that says what this project is, who decides what, and what automation must never
do. Operational rules live in [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md);
architecture lives in [docs/architecture.md](docs/architecture.md) and
[docs/subsystems/](docs/subsystems/README.md). This page links them and does not repeat them.

Current stage and priorities: [ROADMAP.md](ROADMAP.md). How decisions are made:
[docs/governance.md](docs/governance.md). Dated decisions: [decisions/](decisions/README.md).

## Current runtime and foundation boundaries

Earlier runtime, foundation and fork references are [preserved verbatim](docs/history/2026-11-05-attempt-settlement-memory-checkpoints.md#earlier-runtime-and-foundation-references).
Current profile/CLI identity, owned reservations, actual exit/occupancy, dependency
readiness and exact candidate evidence remain binding. Apps use explicit installations
and scoped credentials without Owner fallback. Native/external agents share current
principal/inbox contracts. Recovery preserves drafts, context, rights and original
queues/schedules; it never selects business escalation. Source/fixture success grants
no live App/provider/release/multi-repository/UI acceptance or deployment. Preserve
frontend Task40/PR48 and healthy schedules; current fork decisions govern inherited
roles and historical inventory. Canonical subsystem contracts remain active.

## Governing boundaries

Who decides what is written in [docs/governance.md](docs/governance.md), in the operational wording
this repository uses today. In short:

- **The owner** decides the mission, the governance policy, the roles and their membership, the
  autonomy boundaries, the security surface, and any matter reserved in that page.
- **A human maintainer** concludes major decisions, records a verdict, and can challenge any
  classification.
- **Chief** classifies decisions, routes work, records outcomes, and escalates what it may not
  conclude. A classification is a routing label, never an authorization.
- **A routine Bot** concludes only ordinary work inside its routine, through the gates in
  [AGENTS.md](AGENTS.md).

### What automation may never do

These hold for every Bot and every routine, whatever the CI state, the label or a chat message says:

1. **No production deploy** of Bot Social, and no change to the owner's own local instances, without
   the owner's explicit yes.
2. **No secrets** — never write, print, log or commit an API key, token, cookie or `DSH_HOME`
   contents. A withheld key is read from `DSH_SECRETS_WITHHELD` by name only.
3. **No touching the owner's DSH data** — never point a test or a run at `~/.dsh` or at a DSH the
   owner is using; the test bench keeps its own `.dsh-test-<name>/`.
4. **Never patch DSH** and never depend on files inside a DSH install. Build on the documented
   plugin APIs or stop and say what is missing.
5. **Never bypass a gate** — no admin merge, no force-push of `main`, no bypass of a required check,
   no change to a ruleset or to branch protection, and never remove a pull request the owner put in
   the merge queue.
6. **Never lift `hold`.** Only a person sets the label and only a person removes it.
7. **No version or changelog edits outside the release routine** — `CHANGELOG.md` and
   `core/package.json` belong to the daily release, not to a feature pull request.
8. **No issue on someone else's upstream**, and no design proposal filed as an issue: a proposal
   goes to the owner, who decides whether it becomes work.
9. **Never write a verdict on a change the same Bot implemented**, and never record a second
   conclusion at one tip to win a disagreement.
10. **Never edit another writer's text to change what it said** — a correction is a new comment, a
    new decision record or a `Correction from <Bot>:` line.

Changes to this page, to `ROADMAP.md`, to `docs/governance.md` or to `AGENTS.md` are **major**
decisions, concluded as [docs/governance.md](docs/governance.md) requires and recorded in
[`decisions/`](decisions/README.md).

M5/M6 and M7 implementation references are [preserved verbatim](docs/history/2026-11-05-review-evidence-memory-checkpoints.md#earlier-project-implementation-references).
Historical acceptance is not current acceptance. Preserve private credentials,
current authority/revocation, actual exit proof, independent same-SHA verification
and unchanged Control Plane reuse; live provider, mixed-resource and deployment
acceptance remain separate.

Earlier Codex acceptance is [preserved verbatim](docs/history/2026-11-05-warning-memory-checkpoints.md); it grants no new deployment, App or credential authority.

### Collaboration contract and earlier validation

Native multi-Bot UI, per-Bot handoff pools and complete pinned role conventions remain required. Ordinary Chief questions are conversations; safe/watch delegation uses current human permissions. Chief inspection uses the original DSH scheduled-task service with editable cadence/content/thresholds (the current template defaults to30 minutes), never a hardcoded framework workflow. Code changes retain required memory/tests/architecture evidence. Earlier R1–R7 implementation and runtime validation are [preserved verbatim](docs/history/2026-11-03-collaboration-repair-evidence.md). Current acceptance follows the convergence records above; no new deployment, Control Plane change or interruption of healthy frontend work is authorized.

### Collaboration execution invariants and historical evidence

Keep scoped Project/room role conversations and original native UI components;
private user material stays private. The dispatcher uses actual native activity,
not stored Bot existence. Chief inspection is a configured schedule; ordinary
questions do not create Tasks. Source admission, rework, scratch/workspace cleanup
and recovery require matching confirmed worker/lease exit. Unknown occupancy stays
held. Audited Chief intervention may reset a bounded routing epoch, preserving
history and global quotas. Preserve unsealed drafts and original Task/PR identity;
reuse verified PR bindings and pinned target/source ancestry, never replace a PR
or silently retarget recorded execution. Complete role rules and knowledge remain
available under explicit budgets; release only truly unbound failed preparations.
Safe-mode proposals require explicit requester approval; watch uses current grants.

Dated candidates, environment probes, schedule observations and historical check
counts are retained in [the implementation archive](docs/history/2026-11-02-collaboration-implementation.md).
Their results are not evidence for the current source or Owner visual acceptance.

### Current UI compatibility requirements

Frontend Task40/PR48 remains its original continuation; backend work does not take
it over or deploy it. Reuse original FlyBot conversation rendering, identity/parent
trees, personal Chief/Bots, native groups and shared rooms. Preserve scoped public
persona/memory inspection, earlier-part history paging, Markdown/math attachments,
composer, tools, approvals and stop/continue. Project rooms do not substitute for
native personal/group compatibility; partial restored components are not full parity.
Keep failed/blocked work visible, load Settings only when needed, coalesce route
loads and preserve current scoped polling/history. Native script budget is4.6MB;
same-origin math assets must respect CSP. Actual desktop/narrow/weak-network,
three-account screenshots and Owner visual acceptance remain separate evidence.

Chief may inspect one explicitly authorized Task without admitting foreign IDs or
dropping policy. Basic CI is the Owner-authorized default; extended browser/runtime
checks remain explicit. Publication recovery reuses original sealed evidence and
verified bindings; it is not overall Task acceptance. Resource views retain current
and unknown leases while digesting only proven released history. Dated UI drafts,
asset measurements and test reports remain in [the archive](docs/history/2026-11-02-collaboration-implementation.md).

### Current context and service boundaries

Earlier context/convergence implementation references are [preserved verbatim](docs/history/2026-11-05-attempt-settlement-memory-checkpoints.md).
Retain one logical Task-role Session, bounded resident Chief memory and Harness-owned
persistence/compaction; no second history engine. Resource/profile/model/persona,
current delegation and exact exit/binding proofs constrain continuation. Consultations
and initiative handoffs stay distinct; private context is not published automatically.
Task/dependency versions, original ACLs and committed Effects/publication approval
remain binding. History and memory are not current authorization or delivery proof.
Preserve frontend Task40/PR48 and original UI; backend source delivery grants no live
provider/App/release/multi-repository/UI acceptance, credentials or deployment.

### Current delivery guarantees

Tasks pin their associated repository and approved role/requirements revisions;
repository-free decisions do not invent code or tests. Release publication needs
explicit authority, observed Effects and Chief closure. Large histories use bounded
hash-bound pages. Missing runner/dependencies are environment failures, not assertion
failures. Receipts use same-context bounded correction and never acknowledge stale
inputs. Recovery preserves exact exit proof, candidate/Session/history and permits
evidence-supported verification continuation. Reviewer approve, host merge, signed
forge review, release/deployment and Chief acceptance remain distinct. Operations
consultation uses scoped personal agents; watch grants no host privileges.

Detailed dated implementation checkpoints are [preserved verbatim](docs/history/2026-11-04-reliability-memory-checkpoints.md); current contracts remain in the owned subsystem docs.

#2518: SDK/inspection/merge elapsed time produces evidence-bearing warnings through one progressive disclosure service. Chief chooses recovery; operational warnings reach existing personal/human inboxes. Unknown exit and current authority remain gates.

#2519: SDK Reviewer receives the complete hash-verified host log inline, without scratch access. Preserve exact candidate/current authority, artifact and execution-context budgets; persist only provenance metadata. Host output is data, never Review or CI approval.

#2526: Chief may accept a merged Attempt scope without closing its Task, then explicitly choose a fresh next delivery. Scoped prechecks are observations; Chief recommends and decides. Personal Agent assistance is the last resort, never a framework-selected escalation.
