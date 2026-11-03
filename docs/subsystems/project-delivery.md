---
subsystem: project-delivery
owned_paths:
  - core/src/host/project-test-diagnostics.js
  - core/test/project-test-diagnostics.test.js
  - core/src/host/project-child-inputs.js
  - core/test/project-child-inputs.test.js
  - core/src/host/project-merge-heads.js
  - core/test/project-merge-heads.test.js
  - core/src/host/project-delivery.js
  - core/src/host/project-delivery-template.js
  - core/src/host/project-github.js
  - core/test/project-delivery.test.js
  - core/test/project-github-publish.test.js
---

# Project code delivery (fork M3)

One code-delivery entry uses the existing Workflow plugin. Project delivery owns
idempotent Attempts, Git worktrees and evidence; the plugin still owns node dispatch,
step deadlines, ephemeral lifecycle and Run state. There is no parallel workflow engine.
The versioned path is `project-delivery/v1`: Developer → Tester → Reviewer, followed by
explicit human acceptance. A node reply cannot mark a Task accepted.

## Provisioning

Pool receivers may use optional operator `workspacePrepareCommand: [node,
/operator/prepare-worktree.mjs]`. It is a fixed nonempty argv, not a shell string
or a Project/Task body field. The host runs it with the registered checkout as
cwd, on that workspace's bound resource, with a 30-second limit and bounded output, before
creating its role Session. Independent host testing runs preparation again after
its candidate reset/clean. No command means existing behavior; metadata preflight
never executes preparation. Commands must provision ignored dependencies without
changing tracked code or granting the role additional filesystem authority.
Receipts retain workspace/resource/role, command hash and time; a preparation
receipt is not test or inference success. Allocation, checkout and preparation
failures release only proven unbound reservations before external startup, retain
workspace cleanup intent/drafts and record the actual preparation failure.


The operator configures repository capabilities on the `bot` entry, outside Project
request bodies. Repository keys must match Project.repository:

```yaml
projectRepositories:
  owner/repository:
    path: /operator/provisioned/repository
    model: provider/model
    testCommand: [node, --test, code.test.mjs]
    allowedPaths: [code.mjs, code.test.mjs]
    github:
      credential: gh-cli
      configDir: /operator/github-automation-config
projectWorkspaceRoot: /operator/disposable/flybot-workspaces
```

`model` may use a served default resolved once at Attempt creation. Its resolved ref
and complete graph are pinned on the Attempt. `testCommand` is an argv array selected
by the operator, never a client shell string. Tests have bounded output and timeout
(default 120 seconds, ceiling 300 seconds). The small demo has no dependency install;
other repositories must provision a self-contained test command/environment.

The worktree root defaults to `flybot-workspaces` beside DSH_HOME. It must be outside
DSH's data directory: the existing DSH/FlyBot working-directory guard refuses execution
inside its data. Each workspace is registered to Project/Attempt/role before creation;
a partial allocation retains cleanup intent. Symlink roots are refused. Runtime
creation accepts only an allocated registered execution path. The ordinary operator
repository/worktree and its checkout are never edited by a delivery attempt.

GitHub automation is explicit. `gh-cli` obtains the existing operator-selected GitHub
credential in memory, using the provided config directory; it is never placed in Bot
context, test environment, command-line arguments or state.json. Push uses a fixed
HTTPS URL for the provisioned Project repository and an environment-only auth header.
Publish creates/reuses a draft PR for the unique Attempt branch. It never merges.
M4 adds the broader project-versus-personal credential/delegation contract. Missing
GitHub credentials fail delivery after preserving code/test/Review evidence.

## Attempt and execution lifecycle

`project-task-run {taskId,requestId}` checks authenticated Project create/task-write
rights, then reserves `(projectId,taskId,requestId)` before filesystem effects. A repeat
returns the same Attempt; a new retry needs a new requestId and preserves prior attempts.
One Task cannot have another running/waiting Attempt. The server creates the fixed graph
under Project authority; Member requests cannot use that authority to edit arbitrary
graphs. The actual initiating member and automation owner are separately recorded.

An Attempt stores direct projectId/taskId, requirement/criteria snapshot, workflowVersion,
full immutable node/model graph, branch/base/candidate SHA, workspaces, Run id, initiating
member, execution owner and evidence. Developer gets a unique branch; Tester and
Reviewer get separate detached worktrees. Host execution context supplies exact cwd to
each ephemeral Bot. The Run records Attempt, Workflow and primary Workspace directly.
Managed graphs cannot be edited, reset, rebound or deleted through the general gateway;
pause/resume keep the same Run. Retry creates a new Attempt and new workspaces.

The host seals Developer's changes into a commit after checking the provisioned path
allowlist, and resets the independent Tester/Reviewer worktrees to that SHA. Tester
replies trigger a fresh reset/clean and the independent host-selected test command;
model assertions cannot manufacture passing evidence. Reviewer must return structured
`OUTPUT review: {"commit":"full SHA","verdict":"approve|request-changes","summary":"..."}`
from a clean worktree at the candidate SHA. A failed test, wrong SHA, missing verdict,
request-changes or failed node ends the Run; it does not merely emit a shadow warning.
Duplicate step results reuse sealed evidence and do not reset another active worktree.
Different Attempts have separate evidence locks and can execute concurrently within
Project quota. The existing plugin step deadlines bound model waits.

After matching tests/Review, publication must return the same PR head SHA. Only then
can the Task enter result-ready / Attempt waiting-acceptance. Generic task transitions
cannot accept provisioned code Tasks or bypass Attempt gates. Code Task records carrying
Attempts are protected from the legacy bounded Task pruning.

`project-task-accept {attemptId}` requires Owner/Maintainer and rechecks clean candidate,
unchanged title/criteria, canonical Run done, matching passing tests and approved Review,
test-log integrity and current open PR head. It records acceptedBy/time and transitions
Task to accepted. `project-task-reject {attemptId,reason}` preserves old evidence/PR and
marks the Attempt failed so a new retry can address feedback. Human acceptance here is
a runtime product action, not an independent GitHub code-review PASS or merge approval.

On startup, preparing/running Attempts become interrupted with an explicit failure;
canonical active Run/Task state is reconciled. Prior workspaces/evidence remain available
and a new Attempt may retry. This does not claim exact process-crash continuation or a
cross-store transaction. A push/PR response lost during a crash can leave a draft remote
artifact; its unique branch/SHA remain recorded for operator reconciliation. The GitHub
publisher checks for an existing PR before creating one, but no exactly-once network
transaction is promised.

## Read, retention and cleanup

- `project-task-detail {taskId}` returns the current Task and all its Attempts, guarded by
  current membership. `project-attempt-log {attemptId}` reads only the recorded test log
  and verifies its hash; arbitrary request paths cannot select files.
- Archive allows admitted work to finish but refuses new attempts. Delete refuses
  preparing/running/waiting delivery attempts and retains terminal attribution/history.
- `project-attempt-cleanup {attemptId}` requires an Owner/Maintainer, refuses active or
  waiting work and removes only registered worktrees inside the owned root. It updates
  both canonical Workspace metadata and Attempt history. It works after Project deletion
  through the retained authorized tombstone. Branches, PRs and evidence remain.
- Filesystem worktree separation and per-role sessions are demonstrated. This is not a
  container/OS security sandbox: the inherited Workflow Bot tool preset remains in use.
  A production service needs stronger execution isolation and credential/process fencing.

## Verification and evidence limits

Core delivery tests use actual Git repositories/worktrees and actual Node test processes.
They cover duplicate admission/step results, isolated Tasks/roles, matching test/Review/PR
SHA gates, failed tests/retries, stale candidate/head, cleanup bounds, recovery, path
policy and immutable role/model definitions. Publisher/network assertions are injected
fixtures in unit tests, not a claim of live GitHub or independent review.

The required actual DSH probe (`npm run test:demo:runtime`) additionally runs `--delivery`:
a deterministic model drives real shell edits, separate role cwd, independent tests and
commit-specific reviewer output. Missing GitHub credentials explicitly block publish and
acceptance, and registered worktrees are cleaned. It also retains the existing M0 probe.

An explicitly requested remote integration command is available:

```sh
node dev/demo/run.mjs --delivery --github-repo owner/repository --github-config-dir /operator/gh-config
```

It clones that repository into disposable data, commits the small fixture, publishes a
real draft PR, verifies its head against the tests/Review, exercises human acceptance and
cleans local registered worktrees. It writes GitHub and is not run in routine CI. The
local M3 implementation produced [artifact PR #12](https://github.com/zy95-12/FlyBot/pull/12),
head `d8371cbc797889340b602bf1352011a7c3fd7d7d`, through actual DSH/Git/GitHub with a deterministic
model. That draft is not the milestone implementation PR and is not independently reviewed.
True-model and browser acceptance remain pending M3/M6 until a model configuration is
available; the working conversation requests only its config name/path, not secret text.

## Fork M4 — 2026-10-31

M4 snapshots Project agent definitions/skill content on each new Attempt. GitHub
automation now verifies its actual login, strips ambient token overrides and records
executorLogin/credentialScope on PR metadata. Personal human/Project writes use a
separate broker with no fallback. [Contract](project-agents.md).

### M5 workbench integration

The [Project workbench](project-workbench.md) uses this domain through scoped endpoints.
Queue admission rechecks current membership, preserves immutable Task/Run ownership and
allocates worktrees only when quota permits. Explicit stop releases the existing single
Run; orphan Workers retain capacity. Shared Project creation cannot supply filesystem cwd,
and scoped agent/Worker identities cannot move to a different Project.

M6 adds return→retry→accept regression coverage: an authorized human return retains the
old Attempt/evidence, retry uses a new workspace/Attempt, and only that Attempt's current
verified commit can be accepted. The test uses the explicitly injected publisher fixture;
real GitHub and real-model acceptance are recorded independently. Actual shared browser
execution now uses the Project Chief sender without private `state` bootstrap.

Candidate implementation evidence also stores git's actual base→candidate diff statistics
and changed paths. The UI can show a change summary without fabricating one from a model's
completion sentence; old Attempts without this optional field retain their original evidence.

Real-model return validation found that the prior Attempt's human feedback was not in the
new work brief. A retry now snapshots the previous Attempt id, failure/return reason and
candidate SHA as task data. Human-return metadata remains on the old Attempt; a new human
request does not rewrite its evidence. The new worktree still starts from the configured
base, so the model must implement the current requirements plus supplied feedback. This
fix adds retry input data without changing saved role/graph definitions.

[Real-provider acceptance](../live-acceptance.md) passed for actual role execution and GitHub
artifact PR heads #18/#19, human-role browser return/follow-up/accept, immutable host test
failure and retry. This is integrated M6 evidence, not a claim of independent PR review.


## M7.1 execution-session snapshots

New Attempts use `project-delivery/v2`; saved v1 graphs/evidence remain readable. Each
Attempt has one `roleSessions[role]` descriptor with immutable Project/Task/Attempt,
definition revision, execution refs, context version/hash and generation. The existing
Workflow still owns spawning, pausing, dispatching and releasing Bots; no second scheduler
or task state machine is added. Pause/resume retains the same bound Bot/Session. A new
Attempt gets fresh descriptors and the existing explicit previous-failure/return feedback.

The host validates the registered Workspace before inserting its assembled system prompt,
binds the resulting Session once, rejects a conflicting/released binding and records
release only after deletion succeeds. Failed deletion keeps existing Worker quota occupied.
Necessary context/evidence survives temporary Bot removal. No raw temporary transcript
is copied into persistent role memory. The normal runtime check verifies three distinct
actual Sessions, model-visible published memory/repo instructions and confirmed release.
SDK/resource allocation and cross-resource workspace transfer follow in M7.2–M7.5.


### M7.2 — 2026-10-31

M7.2 reserves configured role resource leases before workspace allocation, binds native workers to the existing Session descriptor and confirms release after deletion. Native selected resources must be local and contain the registered worktree root; cross-resource Git transfer follows M7.5.


### M7.3 checkpoint — 2026-10-31

M7.3 temporary role Session binding records native Bot or SDK worker handles. SDK OUTPUTs still pass the same host Git/test/review/publish/acceptance gates. Local selected resources must contain worktree root; remote transfer remains deferred to M7.5.


### M7.5 — 2026-10-31

M7.5 new Attempts use project-delivery/v3. Remote resource-clone roles import the same sealed candidate through bounded hash-verified Git bundles; host publication never receives a remote cwd or sends credentials there. Any remote role gets a separate host-verifier worktree for configured independent tests. SDK event evidence is sealed and rechecked before subsequent gates/acceptance. Cleanup refuses orphan Bots/unknown leases. See [resource workspace contract](project-resource-workspaces.md).

## R1 admission and candidate failures

The repository preflight now runs before creating an Attempt/worktree/lease. Missing or malformed allowedPaths is a provisioning failure, not evidence that a worker wrote outside its workspace. Optional testDependencies names readable repository-relative prerequisites; metadata checks never install or execute them. testTimeoutMs must be a positive integer and retains the existing 300-second execution ceiling. Candidate sealing separately refuses no final code change, actual path-list violations and changed symbolic links that resolve outside the allocated workspace. Historical Attempt/graph versions are unchanged.

## Repair R2: versioned role policies

New Attempts use `project-delivery/v4`; v1–v3 records stay readable. All three
role Sessions pin a complete, hashed policy bundle at the base SHA. Host execution
assembles it after Workflow prompt cleaning; it does not rely on the node preview
for complete rules. See [role policy](project-agents.md#complete-role-conventions-repair-r2-issue-35).
Gate verification rejects changed bundles. FlyBot code candidates must include
repository memory, regression tests and architecture changes. Review evidence
distinguishes a candidate recommendation from a signed repository Reviewer PASS;
existing candidate tests and human acceptance remain mandatory.


Repair R3 (#36): New shared deliveries default to per-Bot pools with lazy single-role allocation and versioned Attempts. Fixed DAG requires `projectDispatch: workflow`; historical Attempts are unchanged. Returns to Dev create a successor Attempt seeded from the prior candidate. Chief arbitration is required before final acceptance. See [pool contract](project-pools.md).

Repair R6: Chief acceptance applies existing candidate/test/review/PR-head gates,
explicit Task requirements and actual Run/SDK evidence; it records Chief executor
and current human authority. Non-code decisions need hashed outputs; release
claims without trusted release evidence cannot close. Rework preserves Task and
prior Attempt evidence. Host testTimeoutMs now honors configured positive values
up to 1800000 ms instead of silently reducing a 600000-ms budget to 300000.

Receiving role context includes current handoff and bounded candidate/test/review
facts. Before any sealed candidate exists, an explicit Chief rework pins the new
Attempt to current repaired repository HEAD; the original base/evidence remain
immutable. Candidate-backed rework keeps its original base and seeds that candidate.

Host prompts distinguish SDK-local checks from the configured host verification:
blocked loopback/private log paths are Not run, and a testing handoff requests the
actual host command. Pre-candidate resume preserves uncommitted implementation.

Across restart, Chief route may resume an interrupted pre-candidate workspace
with changes after all bound workers/leases are released and no native worker
remains. Cancellation forbids resume. Resumptions retain old status, failure and
Chief decision; unknown occupancy creates isolated work rather than reusing it.

Interrupted preparation resume creates a new Run, retains the failed Run and
archives the prior Attempt failure on its resumption record; active failure state
clears only after the host validates safe workspace reuse.

Tester handoff/complete with outputs.tests requests actual host verification.
Local sandbox checks may be Not run; downstream admission still requires the real
registered command to pass. Arbitrate/transfer does not claim completed tests.

Transfer does not seal Developer changes. A receiving role gets an explicitly
unverified workspace reference only on the same resource; a clean recipient
checkout is not evidence that implementation is absent. Cross-resource drafts
require sealing before they can be verified. Developer handoff requests sealing
without asserting tests passed.

## Quiescent Chief checkpoints

On restart, a running pool Attempt with exact-SHA passing host tests may retain its
candidate and evidence while blocked on Chief/human input. This requires a completed
Chief Run, a waiting-human Chief claim, released Chief worker/lease, all recorded
delivery workers and leases released, no native worker and no cancellation. The host
records `quiescent-chief-wait` in restartCheckpoints. It does not execute, accept or
create a new candidate. Active/unknown execution still becomes interrupted. Normal
current-authority, generation, candidate and evidence checks apply before retry.

## Published delivery rework

A Chief return or human retry after publication retains a host-derived
publicationBinding: repository, PR number, its existing remote branch and the
previous published SHA. Separate worktrees keep distinct local Attempt branches.
Candidate sealing collapses only unpublished worker commits onto seedSha, retaining
the prior candidate as an ancestor instead of resetting all history to baseSha.
Path/evidence policy still compares the complete change against the original base.

Before advancing an existing PR, the publisher rechecks its repository, number,
open state, branch and expected head. It verifies candidate ancestry, uses only a
normal fast-forward push to the bound branch, then reads back the same PR/head.
Stale/closed/mismatched records, lost ancestry or concurrent remote commits stop
publication; there is no fallback PR creation and no force push. A response-loss
retry may reuse an already matching candidate head. Initial publication retains
the existing new-branch behavior. This is same-Task continuation, not permission
to attach another Task or take over another contributor's PR.

Regression coverage uses actual Git repositories and a local bare remote with a
mocked GitHub API/credential resolver; no live GitHub publication is claimed by
those tests. Existing live Attempts/evidence are not migrated or manually edited.
Actual PR48 conflict rework still needs Chief routing and fresh candidate tests/
independent Review after the repaired backend is verified and deployed.

### Trusted upstream integration

For an already published Task, admission/rework reads the existing PR and resolves
its actual target branch through the GitHub ref API, not the potentially cached
PR base.sha. Before allocating or changing the old Attempt, the host verifies the
open expected head, configured target and availability of that exact commit in the
registered repository. It records upstreamSha/upstreamRef on the PR binding. No
client or model argument selects those parents.

When upstream is not already an ancestor of seedSha, Developer must merge the
pinned upstream into the retained candidate and resolve/stage conflicts. Host
sealing requires either a matching MERGE_HEAD with no unresolved index entries or
a committed merge containing both trusted inputs. It creates one candidate with
seed and pinned upstream as parents, dropping unpublished intermediate commits.
The role context includes that required merge input; host tests and independent
Review must still verify actual merged content, not just graph reachability.

Publication checks both ancestors and resolves the live target again before and
after push. A moved target, missing object, wrong merge head or unresolved index
blocks delivery with no replacement PR. Existing candidates/receipts are not
migrated or overwritten. The implementation is tested with local Git conflict
resolution and a real service-credential read; actual Codex maintenance/publication
still requires verified integrated deployment and a Chief decision.

Before external execution, failed role-context admission releases only a proven unbound reservation through the resource lifecycle and records preparation failure. Existing developer drafts are never reset on preparation retry. Restart preserves a narrow rejected-admission checkpoint only with the host rejection receipt, completed Chief exit proof, no role Session/history/execution/native worker, and exclusively unbound reservations; unknown execution still interrupts. Resource reconciliation retains responsibility for release.

Before Developer allocation, bound rework revalidates the original PR head, target ref and provisioned target object through the selected host broker. A moved descendant target can refresh on the same Attempt only before any candidate, role Session/history, execution record or native/SDK worker and after every registered lease is released. Ref changes, unrelated or unavailable objects and recorded/unknown execution refuse admission. The host records both old/new bindings with claim/generation; seed, base, workspace and published candidate lineage stay intact. Publisher still rechecks target movement before and after publication.

## Existing-PR publication recovery

A push can succeed before the forge read reflects its new head. A Project manager
may call `project-attempt-publication-retry {attemptId}` for the current active
Attempt with an existing immutable PR binding. The host revalidates the clean
candidate, role policies, original role Sessions and sealed SDK logs, matching
passing tests and unchanged test log, independent approving Review, unchanged
requirements and confirmed worker/resource release. It then invokes the normal
same-PR publisher with its target/head/ancestry guards; no client supplies a verdict,
SHA or task state. Errors retain evidence without manufacturing a receipt.
Successful reconciliation stores the actual PR receipt and normal result-ready
transition, with a recovery audit entry. Repetition retains that entry and does not
repeat an invalid result-ready transition. Overall acceptance remains Chief/human
authority, and unfinished requirements still require normal same-Task rework.

Chief inspection keeps every current or uncertain resource record detailed. Historical
leases with confirmed release proofs may be represented by a count and content digest;
the complete original lease/worker state remains retained. This avoids expanding the
same released history on every inspection without raising context limits, truncating
policy/knowledge or treating an unproven release as execution exit evidence.

A successor without a new candidate retains previous.seedSha across another
rework/retry; published delivery prefers that inherited seed before falling back
to the published PR head. Old failed preparation records remain immutable. Fresh
receivers check out that sealed input and keep normal upstream integration/tests.

Pool role context includes testFailure diagnostics for a failed current candidate
or its exact inherited seed. The host verifies Project/Task lineage, candidate SHA
and original test-log hash before extracting bounded early-failure/tail facts.
Excerpts redact configured secrets before per-line/total truncation, retain source
Attempt/log hashes and do not grant authority or passing evidence. Stale/foreign
logs are refused; complete logs remain behind existing Project read authorization.


## Task-role Sessions (delivery/v5, pools-v2)
New definitions/Attempts use the bumped contract; historical versions and evidence stay unchanged. Each pool execution receives a distinct execution Session plus a stable logicalSessionId for its Task/role. SDK rework may reuse its previous registered cwd only for the same Project/Task/role/resource/root/repository, a terminal previous Attempt, clean exact prior candidate and confirmed released worker/lease. Unverified dirty drafts and unknown exits refuse reuse. New Workspace records retain reusesWorkspaceId/storageAttemptId rather than rewriting historical ownership. Developer gets a new Attempt branch; old commits/evidence remain immutable. Cleanup of an older alias cannot remove a currently allocated shared path. Native sources are also available in immutable host archive files; SDK sources are copied into private execution scratch.

A resumed Reviewer remains a separate role/thread from Dev and must inspect the new exact candidate with fresh evidence. Session continuity does not imply old Review/test validity.

An unsealed same-base Developer draft may also be retained after confirmed exit; it is explicitly marked retainedDraft and never reset to its seed. A changed sealed candidate, dirty read-only checkout, unexpected HEAD or incomplete allocation refuses reuse. Retained drafts remain unverified and subject to ordinary path/commit/test/Review gates.

Alias cleanup updates both the Attempt snapshot and workspace catalog after JSON reload; these records do not share object identity across a host restart. The resumed physical cwd remains protected.

## Development service compatibility (S1)

S1 routes legacy human delivery operations through the development service while retaining this module as the sole Attempt/evidence writer. Detail adds the shared TaskView; unchanged tests, publication and acceptance gates remain authoritative. See [service contract](project-development-service.md).

S1 shared detail now pages compact Attempt summaries and offers hash-bound context
retrieval through the service. The internal delivery records and full evidence remain
unchanged; the live25-Attempt Task previously exceeded the gateway8MiB cap.

## Durable effects and outbox (S2)

Sealed PR publication now saves a stable github.publish intent before I/O and records its receipt with delivery state. Recovery verifies current source, principal, exact tests/role evidence and confirmed exit, then reconciles the original PR/branch. First publication searches all PR states; closed/changed/ambiguous artifacts cannot cause replacement PRs. Unresolved prior publication blocks blind rework. Task closure remains Chief/human acceptance. See [effect contract](project-effects.md).


### Supervisor-confirmed workspace release (#57)

Workspace reuse uses the same `confirmedWorkerExit` predicate as logical Task-role
Session resumption. It accepts host-confirmed prior systemd invocation exit only
with the exact released lease/worker/generation/role/resource/process-scope binding.
The previous Attempt must still be terminal and match the same Project/Task;
checkpoint HEAD, clean sealed candidates, permitted unsealed Developer drafts and
all released leases remain required. No role output, task terminal flag or missing
PID proves exit. Historical workspace ownership and draft contents are retained.


## Durable Task inbox integration (S3)

S3 bumps new delivery contracts to v6/pools-v3; historical definitions/Attempts remain readable. Role handoff JSON may declare read/handled ids for exact injected batches. Completed-role gates precede handling, Chief/human acceptance refuses unresolved feedback, and successful closure commits Chief input receipts with Task acceptance. No inbox signal grants candidate/test/Review evidence. See [inputs](project-inputs.md).


## Explicit operator integration parents (#60)

Occupancy is scoped to this Attempt and the current Chief claim. Every unreleased
Project Chief still blocks; a current released Chief needs confirmed exit. A
released historical Chief turn that never owned this workspace does not block
admission solely because its old record predates exit-proof recording. Historical
records stay untouched; unknown exits belonging to this Attempt still block.

attempt.integrationInputs stores immutable versioned Project-repository/ref/SHA
pins with manager admission/audit records. Active/unknown leases/workers and native
carriers block admission; workspace snapshot CAS protects the existing staged
merge. A pinned ref is revalidated before preparation/sealing, and inputs cannot
be silently removed/replaced. New source registration requires actual Effect
intent-generation commit proof; failed/no-op saves roll back uncommitted metadata
and its generation without overriding a later cancellation. Historical replays
preserve the original receipt.

Developer context includes pins and explicitly leaves shared branch refs to the
host. Use exact SHAs with no-commit/no-ff; ref names are host provenance and need
not exist in a resource clone. Approved objects reach clones through the existing
verified Git bundle adapter, not network/credential fallback. The role still
returns its normal implementation handoff; admission itself is not execution.

Sealing examines all pending MERGE_HEAD/approved inputs even when the published
upstream is already an ancestor. Unknown/moved/unresolved inputs refuse before
index/ref writes. The host retains the exact resolved tree and explicitly trusted
previous candidate/upstream/operator parents using commit-tree plus supported
reset-hard merge completion; it never soft-resets an active merge or deletes merge
metadata by hand. Private worker history is still collapsed. Provenance is stored
separately in approvedIntegrations; code paths, policy, exact candidate tests,
independent role Review, same-PR publication and Chief acceptance remain mandatory.

The live staged UI integration is resumed on its original Task/Attempt/PR through
Chief after safe-checkpoint deployment and explicit manager admission. Additive
service releases can retain UI component hashes and validate the actual UI/backend
source pair; they do not require repeatedly restarting healthy frontend workers.


Chief route with rework=false resumes an interrupted allocated pre-candidate
Attempt after all role workers/leases/native occupancy are confirmed released,
whether its worktree is clean or dirty. A clean operator-restart checkpoint must
not manufacture a successor and discard its Attempt-scoped integration admission.
Explicit returns/rework and unknown worker occupancy retain existing isolation.


### Pinned Task-role definitions — #2184

Pool and legacy Workflow preparation pin public role definitions before resource
reservation, with shared content-addressed snapshots and scalar Session references.
Retries use the original persona/skills, current memory and explicit change metadata;
they still enforce current execution permission/resource availability. Preparation
failure clears an unused definition pin only if no Session/worker exists. Workspace
drafts, original prepared contexts and Attempt evidence remain untouched. SDK resume
and unknown-exit recovery follow [the Harness contract](project-harness.md).


#2177 builds role context with the actual resource/model budget, mandatory Project
and current Task constraints, the role's own working summary, and bounded relevant
memory. Fixed persona/skills remain pinned; summary/memory data cannot alter rights.
Task-role summary references and input-usage metadata survive returns. Native and
SDK input preflights fail before inference if required input cannot fit.

## Project Task lifecycle convergence (#2179)

New Project Tasks require accepted Chief admission before allocation. New-contract completion rejects human acceptance before changing Attempt state; legacy persisted Tasks retain human acceptance. Parent split waits preserve the active Attempt/workspace and role binding for later integration. Child candidate references are not automatically approved integration sources or evidence that their code was merged.

Attempts pin the complete Project requirements revision, including impact/scope. A scope-only change invalidates old completion evidence even if title and criteria are unchanged. Rework after a revision creates a successor with the new requirements snapshot, retaining the prior version and logical Task-role Session.

A failed Attempt leaves a new Project Task blocked with its source Attempt/reason; it does not close the commitment or erase Chief admission. A later active Attempt clears that execution block. Pre-contract legacy Task failure semantics remain unchanged.


## Accepted child sources (#2179)

A code parent resuming an adjudicated parallel wait obtains sources through the
host's private pre-input port, before resource reservation or worker registration.
It requires the exact current active, unstarted claim, live initiating authority,
confirmed exit of every related parent Attempt, and current Chief-accepted child
outcomes. Code evidence must name the same candidate in implementation, passing
host-test and approving Review records. Cross-repository results stay references;
only same-repository code is admitted for integration. Qualitative Chief waivers
remain judgements and cannot manufacture a candidate or passing test evidence.

`integration.child-refs` commits through the existing Effects outbox before creating
immutable, compare-and-set operator references to already registered Git objects.
`integration.admit` records the wait ID, source fingerprint and original result
references. The private port does not grant configure permission to public callers,
does not advance its own reserved claim generation and preserves the working tree
and index. Public operator admission retains its existing configure and writer-exit
gates. A failed durable intent cannot create source refs; a moved ref is never
silently overwritten. Inputs are bounded to twenty, accommodating sixteen child
sources plus existing operator inputs. No network fetch or ambient credential is
introduced by child admission.

A source reference is not merged code. Before sealing or acceptance, the parent
must retain current dependency outcomes and their committed source admission. The
actual staged tree must include every required input's ancestry. The host reads
**all** bounded MERGE_HEAD records, including octopus merges, from the registered
Git metadata; unknown additional parents, duplicate/malformed data, symlinks and
foreign worktree metadata are refused. Resource-clone inspection uses its live
resource binding. Git regression tests exercise actual multi-parent merges and
exact tree/parent sealing; their child acceptance records and publisher are explicit
deterministic fixtures, not a real-provider full collaboration claim.

#2185 integration admission commands now have operation-scoped application receipts. Retries preserve the exact original admission/result with replayed:true; distinct validation probes use distinct keys and still exercise current generation, source, workspace and exit fences. The original domain admission idempotency and exact staged-tree tests remain in place.

Native Sessions now use the existing Task-role binding service through projectDelivery.nativeSessions. Canonical pool worktrees can be retained across Attempts only after exact native quiescence and released leases; original DAG workspace behavior remains compatible. Definition capability changes and removed roles block stale restart instead of inheriting authority.


New v7/pools-v4 Attempts distinguish logical role keys from developer/tester/reviewer capability classes. `roleAssignments` maps each artifact responsibility to the actual logical producer; Workspaces, Sessions, leases and execution evidence remain keyed by that logical role. Implementation/test/review evidence records its producer and role Session. Artifact sealing, host tests, Review, publication/retry and SDK proof validation resolve those assignments; no duplicate Workspace aliases or rewritten historical records are introduced. Historical Attempts without assignments retain default-role behavior. A custom Developer gets its own local branch while the canonical publication branch remains stable. The artifact-controller regression uses actual Git edits, configured host tests and a labelled fixture publisher; it does not claim signed Review or a whole bot loop.


Native host creation now prepares the exact context binding, invokes the existing Session/resource bind, then activates through a committed native.activate Effects marker. This orders all lease/carrier/Session metadata before archive admission or model input. The existing pre-step middleware closes startup/inbox bypasses for uncommitted or obsolete native bindings; ordinary Bots are unaffected.


The pool host release adapter now delegates to one physical-exit query for SDK and native execution, requiring actual recorded proof and released leases before initiative can move. Native stop follows current parts and known subagent work, and supervisor recovery updates the exact historical/current role Session physical ID. Missing Bot records alone cannot advance a Task.


Current canonical execution is revalidated through one authority helper before new input and by the existing scheduler before resource reconciliation/new dispatch. Revocation reuses the pool lifecycle stop, with an exact claim fence, visible blocked reason and confirmed-exit requirement. Role snapshots retain conventions while current rights constrain their use.

Composed #2179 execution checks include the canonical Task requirement revision. Chief revision invalidates an old Attempt for further execution; the existing pool stop retains the logical Session and requires actual exit before routing a successor Attempt. This covers scope/impact changes as well as changed title/criteria, and complements existing stale-evidence checks at sealing/publication. Custom Developer-capability parent roles also use the existing child-source admission and workspace producer mapping.
