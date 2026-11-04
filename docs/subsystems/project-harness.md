---
subsystem: project-harness
owned_paths:
  - core/src/host/project-execution-authority.js
  - core/test/project-execution-authority.test.js
  - core/src/host/project-execution-exit.js
  - core/test/project-execution-exit.test.js
  - core/src/host/project-native-sessions.js
  - core/test/project-native-sessions.test.js
  - core/test/project-native-exit.test.js
  - core/src/host/project-session-continuation.js
  - core/test/project-session-continuation.test.js
  - core/src/host/project-task-sessions.js
  - core/test/project-task-sessions.test.js
  - core/src/host/project-git-sandbox.js
  - core/test/project-git-sandbox.test.js
  - core/src/host/project-harness.js
  - core/src/host/project-codex-config.js
  - core/test/project-codex-config.test.js
  - core/src/host/project-harness-turn.js
  - core/src/host/project-harness-worker.mjs
  - core/src/host/project-harness-deny-tool.mjs
  - core/test/project-harness.test.js
  - core/test/project-harness-turn.test.js
---

# Harness adapters (fork M7.3)

The existing Workflow retains dispatch/result/deadline/release behavior. Its host seam
`projects.execution` delegates configured SDK workers; native roles continue through the
existing Bot adapter. No duplicate scheduler, Task state machine or acceptance rule.

Pinned dependencies: @openai/codex-sdk 0.166.0 and @anthropic-ai/claude-agent-sdk 0.3.316.
Official interfaces: [Codex SDK](https://developers.openai.com/codex/sdk/),
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript).
The latter is the official Claude Code programmatic SDK, not the Messages SDK.

## Explicit identity and configuration

Each resource may define a principal/Harness profile under `profiles[ownerMemberId][harness]`:

```yaml
profiles:
  owner-1:
    codex:
      home: /srv/profiles/owner-1/codex-home
      configDir: /srv/profiles/owner-1/codex-config
      model: your-authorized-codex-model
      envRefs: {CODEX_API_KEY: FLYBOT_OWNER_CODEX_KEY}
    claude-agent:
      home: /srv/profiles/owner-1/claude-home
      configDir: /srv/profiles/owner-1/claude-config
      model: your-authorized-claude-model
      envRefs: {ANTHROPIC_API_KEY: FLYBOT_OWNER_CLAUDE_KEY}
      maxBudgetUsd: 1
```

Paths/models and env *reference names* are operator capability settings, not browser
supplied credentials. Values never enter saved worker/Task records. The worker receives
only a clean environment plus this selected profile over stdin, never process arguments.
No ambient HOME/CODEX_HOME/Claude login, external Codex conversation or model-route
fallback. Local selected resources are currently supported; remote Workspaces/SDK runtime
installation are the M7.5 boundary. Profile runtimeDir may explicitly locate the FlyBot
installation in the target environment. An environment probe is not an auth probe.

## Turn and process contract

One temporary SDK worker maps to one existing Workflow node and one resource lease.
Saved worker evidence names Project/Task/Attempt/role/Harness/version/resource/principal,
lease generation, cwd, backend Session/thread and event log. Input continuation resumes
that backend Session in the same bound cwd. New Attempts create fresh worker processes; compatible Task-role bindings retain the original backend thread.

Codex uses streamed events, read-only/workspace-write sandbox by role, external command network and web search
denied and approvalPolicy=never. The exec SDK does not provide an interactive approval
callback; denied actions must fail or be explained through a same-thread message. It does
not silently grant full host permissions. Claude uses explicit tools, settingSources=[]
and its permission callback. Permission requests appear as waiting-input and require a
current configuring human's decision; message continuation requires Task write rights.
Both are fenced by worker id/generation and current Project authorization.

A completed SDK turn must contain required OUTPUT ports before Workflow advances.
Otherwise its result is a waiting-input message, not a fabricated successful step. Truncated,
failed or aborted streams do not complete. Workflow still invokes host seal/test/Review/
PR-head/human gates. SDK completion is never acceptance.

The parent saves redacted JSONL events and usage, discards raw stderr except byte counts,
and persists no stdin or profile environment. Known credential values and common key tokens
are redacted. Worker shutdown confirms process exit before releasing its matching SDK lease.
Unknown/failed stop retains capacity; restart does not auto-launch or resume a worker.
Native release remains unchanged. Late callbacks require the same active lease generation.

## Acceptance still pending

Chief may also choose either SDK. Its stable public identity/history remain in FlyBot;
a turn allocates a temporary resource worker, with backend binding keyed by Harness,
resource, principal and definition revision. Idle Chief performs no inference. The SDK
receives public bounded context and proposes at most four typed task/run actions as JSON;
the host revalidates live delegation, human authority and Project scope before applying
each action, then appends host-confirmed results. Private content is never injected.
Runtime shell/image/app/MCP tools are disabled for Codex Chief and a PreToolUse deny hook
blocks generic calls; Claude Chief has no built-in tools and a deny hook. New configuration
rotates its backend binding; same binding resumes the public thread. Resource release still
requires worker exit. Real SDK Chief policy conformance remains part of live acceptance.

Remote SDK dispatch and the Owner setup UI/probes follow M7.4/M7.5. Authenticated real
SDK acceptance remains pending explicit credentials; this keeps #23 open/PR draft.

Unit tests inject SDK event iterators and a separate real Node JSONL contract worker to
check environment binding, continuation, failure/truncation, permission callbacks, evidence
redaction and exit-confirmed release. `node dev/demo/harnesses.mjs` invokes both installed
official SDKs with empty isolated profiles/unreachable loopback providers and confirms no
successful completion. These are negative/transport tests, not paid authenticated inference.
The three real-provider and mixed-role checks belong to the explicit M7 acceptance run;
missing credentials must remain Not run, not replaced with mocks.


### M7.4 — 2026-10-31

M7.4 profiles may be explicitly provisioned or generated under profileRoot per Project/principal/Harness, with private credential files or envRefs. SDK roles can set their own model. Controlled shutdown must settle SDK work and emit stopped before exit/lease release. Native setup needs its actual explicit DSH profile.


### M7.5 — 2026-10-31

M7.5 enables SDK workers on prepared Docker resource clones and remote Chief public-context directories. Resource physical binding hashes prevent silent configuration migration. Sealed completion-event prefixes bind role Session/resource/generation/context/result hashes; Workflow and acceptance verify them. A fenced stop acknowledgement is observed immediately to avoid callback-awaits-release deadlock; actual process exit remains required.
All Codex roles clear ambient MCP/plugin/app registries and disable automatic plugin/MCP
installation, not only Chief. An authorized model profile supplies inference identity;
it does not implicitly delegate extra connector tools or personal GitHub credentials.
Claude workers retain explicit tools, empty MCP servers and disabled settings inheritance.
Resource workers now report installed SDK package versions before receiving Task input or
credentials; parent dispatch waits for the selected pinned version. Missing/incompatible
bridges fail closed, invalidate that resource's readiness and release only a demonstrably
unstarted or acknowledged-stopped worker. Broken stdin channels are contained as execution
errors. Tests cover missing bridges, mismatched versions and the complete callback path.


Repair R2 (#35): SDK delivery dispatch assembles complete pinned role conventions after Workflow node cleaning, alongside the bounded role context; Session policy hash verification precedes spawn. The SDK contract test checks the actual worker input beyond the old prompt limit. See [Project role conventions](project-agents.md).


Repair R3 (#36): A pool claim binds one actual receiving role Session/lease and routes its explicit handoff decision through the trusted host adapter. Resources are released only after confirmed worker exit. SDK timeout is configurable via `projectExecutionTimeoutMs`, separately from Chief scheduled inspection. See [pool contract](project-pools.md).


Repair R4 (#37): SDK Chief conversation turns use a read-only
action contract, with no filesystem/network/connector tools and no Task/run
actions. Each private inquiry has a separate carrier and SDK binding, and returns
to the originating private transcript. Private worker metadata is scoped to its
requester in workbench responses. See [conversation routing](project-agents.md).


Repair R5 (#38): SDK Chief action results support `$lastTask` only
after actual Task creation; private proposals never qualify. Existing SDK execution
and repository gates are unaffected by user watch mode. See [delegation contract](project-delegations.md).

Repair R6: Chief coordination results seal and hash SDK event logs with Run,
lease generation and carrier evidence. Event timestamps support heartbeat
inspection. Credential redaction uses token boundaries so Task UUIDs survive.
Current worker-controller lookup supports conservative resource reconciliation.

R7 conversation carriers may represent a room's Developer/Tester/Reviewer as well as
Chief. They reuse the existing no-tools, read-only conversation adapter and live human
delegation. SDK worker metadata records the actual selected model and room binding;
scoped resource projections omit other members' restricted-room workers. Host-parsed
SDK replies share the native transcript read model; partial SDK JSON is not displayed.
Local Codex developers receive host-derived writable roots for their registered
Git worktree directory and common object store, so staging new canonical files
works without access to shared refs/config. Reviewer/Tester/Chief get no extra
writable roots; outbound access remains denied. The pinned SDK supports
additionalDirectories (`--add-dir`); see [sandbox boundaries](https://learn.chatgpt.com/docs/sandboxing).
Actual SDK stop acknowledgement plus process exit is persisted as release proof.

CLI 0.166 raw network denial breaks Node/libuv Unix pipe lifecycle. Command roles
therefore use a named profile extending :workspace or :read-only, with scratch
write access and scoped Git roots only for Dev. The network proxy is mandatory,
limited, and has an empty allowlist; local binding and arbitrary Unix socket
destinations remain disabled. Legacy sandbox/network flags are omitted so they
cannot override the named policy. Chief retains no-tools/read-only/raw-deny mode.
See the [permission profile reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Real sandbox probes cover successful child processes, denied proxy/direct outbound
requests and EROFS outside the workspace. These are distinct from model acceptance.

SDK handoff ports also accept an entire valid JSON decision with the OUTPUT
framing omitted. The host preserves the raw hash and decision, adds only framing,
and applies the same admission/authority checks; arbitrary prose is never a decision.

## Temporary verification files

Command workers receive a unique host-created `.flybot-scratch-<worker-id>` directory
inside the selected resource root. TMPDIR and the offline npm cache point there;
the named Codex filesystem profile grants that exact path even for read-only roles.
Source/Git write grants remain Developer-only. Chief has no scratch/tool grant.
The same resource adapter provisions local/Docker directories. Confirmed SDK exit
precedes cleanup; changed bindings or cleanup failure retain explicit cleanup debt
without pretending an exited process still occupies capacity. Fixed dependencies
are provisioned by the host, rather than asking a read-only Reviewer to install them.


## Task-role SDK continuation and scoped context
`project-task-sessions.js` owns stable Project/Task/role logical IDs and binding checks; state.projectTaskSessions persists backend bindings through ordinary store snapshots. Worker records retain logicalSessionId, bindingKey, continuedFrom and an optional legacy-key migration marker. Same binding resumes a thread only after prior worker stop-ack/process-exit or an exact host-confirmed prior systemd invocation exit, with a matching released lease. Binding includes Harness/resource/principal/cwd/profile locations/baseURL/model/persona. An incompatible latest binding raises `bot/context-resume`; it cannot silently reset or select an older matching thread. No cwd or principal migration is implied. Worker/claim/generation/log identities remain distinct. Mandatory current candidate/criteria/context are supplied on every turn; a complete unchanged policy already in the resumed thread is referenced by verified digest instead of duplicated.

Codex exec/SDK retains its own automatic history compaction, with no custom compact threshold or second DSH engine. Native DSH retains original parts/steward behavior. Native per-execution carriers retain Task logical identity and source archives; this does not claim persistent native-carrier reuse across Attempts.

Public SDK Chief can return bounded contextRequests/memoryRequests; host revalidates current delegation and scope, returns bounded results, and continues the same worker/thread before final judgement. At most4 retrieval continuations; original execution deadline remains. Final memoryUpdates go through original own-Bot memory; read-only handoffs cannot write. Full archive files remain private host artifacts; command-enabled SDK roles receive a copy in their own scratch directory, cleaned after confirmed exit.

Conversation carriers for room Developer/Reviewer identities remain noTools/read-only just like Chief; a role label never turns an ordinary conversation into a development execution. Their optional role identity is retained in backend binding checks. Only the resident public Chief may use durable-memory exchange; room agents cannot target its write seam. Regression reproduces the old non-Chief carrier tool flag before the fix.


### Prior service invocation compatibility (#57)

`confirmedWorkerExit` is shared by logical Session and workspace reuse. Normal SDK
stop acknowledgement requires its current execution generation. Supervisor proof
requires the exact released lease to match worker Project, Attempt, role, resource,
handle and generation, plus a control-group process scope whose invocation matches
both worker and lease proofs. This consumes host-produced reconciliation evidence,
not role claims or an absent PID. Missing, mismatched and unknown exit proof stays
blocked. Original thread/cwd/profile and current Task-role authorization checks remain.


## Durable Task inbox integration (S3)

S3 observes actual SDK output separately from explicit read declarations. A completed SDK turn can receive at most4 bounded additional inbox turns in the same worker/thread/claim before its handoff is applied; original timeout and evidence budgets remain. No ordinary feedback interrupts a worker, answers a permission or creates a second Dev. Native dispatch/read guarantees remain explicitly distinct; real Codex receipt fixtures do not establish native/Claude acceptance. See [inputs](project-inputs.md).

S3 also wakes a current SDK message-wait at its safe idle boundary, revalidating the original Task principal, claim and lease before send. Permission waits remain untouched. Durable batches prepared but not written remain eligible for later delivery; remaining counts exclude earlier actually injected batches. SDK dispatch records its own adapter-write receipt; native dispatch records only its own adapter acceptance.


A late result-handler failure cannot overwrite a confirmed released SDK lifecycle.
Historical failed-status rows with a successful process exit may still prove exit
only when worker ID/generation, Project/Attempt/role/resource and both worker/lease
stop proofs match a released SDK lease exactly. Unknown/unreachable exits, missing
proofs and mismatched leases remain refused. This preserves historical failure
attribution without blocking every future integration admission for the same Task.


## Execution convergence — #2184

Task-role identity remains stable across Attempts. A content-addressed public
`projectRoleDefinitionSnapshots` record pins persona, resolved skills and execution
contract on first preparation; Session/Task records reference its id/hash/revision.
Dynamic memory and current Task feedback remain per-turn inputs. A failed preparation
without any prepared Session or observed worker drops only the unused pin; history
and shared snapshots are retained. Existing prepared Sessions keep their version.
Current role retirement, revoked shell permission, Harness change or removal of the
previous resource from the approved pool prevents further execution. Definition
changes appear in the returned Session context rather than replacing the persona.

`spawn` prepares a worker and records the exact Task/Attempt/role/logical Session,
resource/profile/Harness and lease generation. `dispatch` persists the running marker
before writing model input and rechecks cancellation/lease generation after saving.
A no-op save cannot authorize dispatch. The first observed backend Session is indexed,
including failed/partial turns; a later retry cannot fall back to older completed
context. If execution might have started but no backend id is known, recovery is
explicitly blocked. Only a proven unstarted, released process may be skipped.
Legacy prompt-based keys migrate only with matching environment and validated,
scoped original role context; original worker/binding proofs are preserved.

The existing service methods remain the lifecycle seam: delivery `preparePoolRole`,
Harness `spawn`/`dispatch`, `input`/`taskInputWake`, `release`, and existing query views.
`capabilities(harness)` reports implementation support independently of installation,
login or successful inference: Codex/Claude support same-binding SDK continuation,
between-turn input and abort/stop with acknowledged process exit. Native uses existing
Bot turns/removal; native Task-role restoration is not yet advertised. Cross-Harness
restoration is unsupported. An SDK capability declaration is not real-provider proof.

This stage has subprocess/SDK-adapter regression coverage, not a new real-model run.
Native Task-role continuation, unified public receipts/events (#2185), transactionally
committed Effects (#2182), parent resumption (#2179), and final real-task validation
remain explicit acceptance work. No second executor or scheduler is introduced.


#2177 resolves the actual selected resource/profile's context budget before dispatch,
checks full SDK input before its durable-start barrier, and records inputUsage.
Native Workflow checks its exact input text through optional execution.checkInput
before send, with current claim/role/lease/authority and post-save fences. Codex's
tool history limit is configured separately from SDK compaction; Claude generic
output control remains runtime-managed. These limits do not claim precise current
SDK-window occupancy from aggregate usage. See [context contract](project-context.md).

## Native physical Session binding and quiescence (#2184)

The original Workflow lifecycle still owns native Bot creation, dispatch and removal.
Its registered-Workspace host adapter now records `projectNativeWorkers` and a
`native-session/v1` binding on the existing Task-role logical Session. This is adapter
metadata, not a second executor. A fresh ephemeral Bot may bind only the latest exact
native physical Session after prior execution is quiescent, the old Bot is gone and
its resource lease is released. Project/Task/role, cwd, model, definition fingerprint
and resource must match. New native parts retain previous segments; tombstoned Bot
IDs are never resurrected. A saved legacy native Session without a trusted binding
fails with explicit recovery instead of silently starting over.

Removal first fences new input, requests cancellation through the existing resolved
DSH Agent, and awaits `whenIdle()` before recording `native-agent-quiescent` with
worker, latest physical Session, binding key and generation. Bot absence and a bare
`exited` flag are not proof. A stop failure keeps visible `stop-unconfirmed` state and
capacity held. A process-local host epoch prevents accidentally resuming an unknown
old-host worker merely to cancel it. Quiescence survives restart as a recorded fact;
unknown old-host executions still require actual prior-exit reconciliation. No timeout
fabricates exit. Stop acknowledgement alone cannot release a native lease.

Native continuation rechecks the live pool claim, initiating human/delegation, role
permissions and resource before and after asynchronous Session loading. Overlapping
binds for one Task-role cannot attach two carriers. Canonical pool rework may retain
the same physical worktree only after matching native quiescence and released leases;
legacy DAG workspace rules remain separate. Existing Task definitions remain pinned,
but a removed role or changed execution capability cannot restart under stale rights.
Approved custom role keys have distinct logical Session IDs; default-role fingerprints
remain compatible while a nondefault capability class participates in the fingerprint.

Actual DSH delivery acceptance checks all three native roles' quiescence proofs before
removal, actual code edits/host tests, and credential refusal; inference is deterministic.
Factory tests cover exact restoration/parts, concurrency, stale claims, model/cwd changes
and unknown exit. They do not establish a real-provider canonical pool return loop.
Custom-role artifact verification, native crash reconciliation, in-flight capability
revocation and the final composed service acceptance remain tracked under #2184.
The capability query now advertises native Task-role resume and native-agent-quiescence exit confirmation for exact supported bindings; unknown exit still refuses continuation.


Approved custom roles now pin `policyRole` on their Session and SDK worker record. Native/SDK Workspace ownership accepts an approved capability while preserving logical role identity. Codex writable roots and SDK readOnly derive from the pinned capability, not a literal Bot name. Repository source overrides prefer the logical role and otherwise inherit its capability's complete rules; the custom policy hash records both, while default policy bytes remain compatible. SDK subprocess contract tests inspect actual transmitted readOnly settings for a custom Developer and Reviewer; they are deterministic workers, not provider execution.


The actual DSH `--native-pools` probe now executes Developer → Tester return → original Developer → Tester → Chief inbox with one native resource. It verifies a fresh carrier restores the same physical Session/cwd and a marker present only in the prior conversation, two real code revisions, configured host tests and nonoverlapping released leases. Exact restoration explicitly unarchives the prior Session through the existing Workspace registry after the new binding is saved; DSH otherwise rejects archived Sessions before their first model step. The unused fresh carrier Session remains managed/tombstoned. Inference is deterministic; Chief closure/provider/forge completion are not claimed.


Native activation is separate from provisional binding. After the original Session bind
records the native resource worker, `native.activate` stages and persists an Effects
marker with the exact Task/Attempt/Session/binding/generation. Only confirmed commit
allows input or lifts archive admission. A resolving noncommitting save is not evidence;
its regression leaves the old Session archived and native input fenced. The existing
DSH pre-step hook also rejects unactivated, previous-host-epoch, stopping/released or
read-only native work, including startup/inbox paths that bypass ordinary delivery.
Unrelated personal Chief/group Bots retain their original admission behavior. No new
executor or polling timer is involved. Current-role in-flight abort/reconciliation and
unknown old-host exit remain separate tracked acceptance.


## Physical exit and host recovery (#2184)

The actual pool host adapter now asks the shared execution-exit checker after release;
a missing Bot/unknown worker alone cannot transfer execution authority. SDK facts use
the existing confirmed-worker-exit contract plus a released lease. Native facts use the
matching quiescence record and released lease, or a persisted verified supervisor
process-group exit for a legacy lease. Physical exit does not invent recoverable context.

New `project-native-worker/v2` records capture the existing host process scope even
without an explicit resource. Normal exit requests all registered work to stop, waits
for Agent idle, and checks Workspace activity for current/earlier context parts and
known subagent Sessions. Idle-child background jobs still block release. Native pre-step
admission follows durable subagent lineage and records its Session IDs; an obsolete or
unactivated ancestor cannot resume through a child. Missing legacy execution bindings
are fenced, while ordinary personal Chiefs/groups retain their original behavior.
Registered work still stopping leaves bounded kind/count facts and held capacity;
no timeout fabricates exit. The existing Task/Chief retry path can recheck after actual
work has settled. This is registered-platform work proof in the trusted host profile,
not a claim of adversarial OS isolation.

For a previous host epoch, native stop never resumes an old Agent to infer safety.
It reuses `priorScopeExited` with the exact recorded systemd control-group/invocation
and validates lease/worker/generation before and after inspection. Matching proof
preserves latest context parts and updates the exact Attempt role Session metadata.
Unknown/unmanaged groups, missing/latest context or changed binding remain held.
Capacity may be released from an actually verified legacy supervisor fact while
context restoration still refuses an unknown binding. Reconciliation respects actual
host epoch rather than PID equality and preserves an already confirmed nested release.
Tests inject manager observations; they do not claim a real systemd restart acceptance.


## In-flight authority (#2184)

Native bind/activate and canonical SDK start/input use the same current execution-authority check: exact Task/Attempt/claim/generation, current initiating human/delegation, committed role catalog and actual Resource binding. Frozen persona/Skills/model stay frozen; current capability/Harness/resource revocations limit that context. A removed role may finish only its exact retained active claim under archived conventions; it cannot acquire fresh work or borrow another retired identity. An implicit native host cannot bypass a newly explicit resource pool.

The existing serialized scheduler checks ongoing canonical role Sessions before resource reconciliation and new dispatch; no new timer is installed. Native pre-step also checks current authority for the bound Agent/child lineage and asynchronously requests the existing pool stop so it never waits for its own idle inside pre-step. SDK safe next-turn feedback and human input/permission responses revalidate before writing frames. Already running SDK operations stop cooperatively via the existing acknowledgement + process-exit contract; this does not assert retroactive prevention of an external operation already executed.

`projectPools.revokeExecution` is a private host seam, not a new public task endpoint. It fences the exact claim, persists a blocked reason, then invokes the same lifecycle release used for member revocation. Unknown exit keeps occupancy and prevents reassignment; a late result cannot move a revoked claim. Chief's configured inspection can observe and route the blocked Task after existing exit/authority gates; this path does not impersonate a human or automatically close a Task. Tests cover native step, existing scheduler wiring, stale claim, current catalog, prepared and live real SDK subprocesses using an explicit deterministic worker fixture. They do not imply a new real-provider workflow acceptance.

When a physical native Session is resumed under a fresh carrier, ongoing checks select only the current host/live bound record, never an earlier historical binding for that same Session ID. SDK human input checks both initiating authority and the sending actor again after any awaited validation. These two boundaries have failure regressions; the actual DSH return probe reproduced the former and passes after correction.

Current operator disabling of a Resource or removal of its Harness support also requests the same confirmed stop; it cannot be bypassed by a retained role grant. Live deterministic SDK subprocess regression covers both role-pool removal and operator disable.

Native input budgeting fences the actual `claim.workerId` against the temporary carrier; `claim.botId` identifies the logical role and is not a physical worker. This distinction is covered by both the scoped input regression and actual DSH native return probe.

#2292 current execution authority additionally validates an Attempt repository association and its operator capability. Removing/replacing the association or withdrawing provisioning cannot keep authorizing an old worker through a changed Project default. Unknown stop/exit still retains capacity.


#2328 extends the actual SDK protocol subprocess test: result completion alone retains project/resource capacity; only stop acknowledgement plus process exit releases the input wait. The fixture bridge is deterministic and does not perform vendor inference.


#2330 tags Chief workers with their host control invocation. Restart/deadline reconciliation cannot reuse a prior invocation's released SDK worker as proof that the current invocation exited. Backend thread/context restoration retains the original Harness binding gates.


Chief lease correlation is written on the canonical reservation, since reserve returns a copy. Its save remains inside the pre-dispatch cleanup boundary: a failed correlation save releases only the proven unbound reservation, preserving runtime capacity and the original failure.


#2336 wraps SDK profile/model/binding, registration, archive transfer and spawn
admission in one cleanup boundary. Before external spawn a durable resource.spawn
intent fences the exact lease/generation/worker. Registered-only failures roll back
through resource.reclaim; possibly spawned work retains occupancy until real exit.
The shared exit predicate accepts only the exact matching no-start proof, not missing
PID/workerId. This does not clear prior Task-role bindings or enable a fresh Session.

## Actual Codex configuration readiness (#2337)

Command roles grant `:tmpdir` and the resource-bound absolute scratch path. The
unsupported `:tmp` spelling is forbidden. Before creating/resuming a paid thread,
the worker resolves the CLI from the installed SDK dependency graph and passes
that same executable through the SDK public `codexPathOverride`. Its native helper
PATH is retained; a different global CLI cannot stand in for this check.

Supported CLI/SDK is 0.166.0. Offline `--version`, `app-server
--print-startup-config` and `config/read` validate the exact SDK config and raw
TOML entry points, in the selected cwd/profile/environment. Explicit loaded legacy
`sandbox_mode`/`sandbox_workspace_write` layers conflict with named role profiles:
fail with `bot/harness-capability`, never silently edit user config or relax policy.
Chief retains its explicit read-only SDK sandbox and denied tools. The probe creates
no thread/turn and logs no config, stderr or authentication values. There is no
cached readiness promise that can survive a configuration change.

Resource worker failure evidence and Harness health distinguish configuration
capability failure from code tests; no success, paid inference or exit proof follows
from configuration readiness. Unknown CLI versions fail before model work. Checks
are bounded, and subprocess exit precedes returning a result.

`FLYBOT_TEST_CODEX_EXECUTABLE=/absolute/resource/sdk/vendor/bin/codex node --test
core/test/project-codex-config.test.js` runs an opt-in offline actual-CLI fixture
with disposable HOME/CODEX_HOME/TMPDIR, valid/invalid profiles, legacy conflicts,
scratch writes and candidate write protection. Basic tests need no vendor install.
0.166 can silently accept unknown filesystem alias keys, so parser success alone
is insufficient: inspect resolved semantics and run isolated filesystem probes.
See [official permissions](https://learn.chatgpt.com/docs/permissions) and
[configuration read API](https://learn.chatgpt.com/docs/app-server).

#2334 consumes the exact workspace preparation receipt before worker admission. A declared warmed cache is copied to unique scratch; SDK command environment observations are bounded advisory facts, never independent test PASS. Configuration readiness (#2337) and dependency readiness remain separate. See [delivery environment contract](project-delivery.md#dependency-readiness-and-verification-outcomes-2334).

## Audited cwd restoration (#2346)

Logical Task-role identity remains stable; v3 physical binding still includes cwd,
resource, principal, profile, model and definition. A cwd-only change requires the
latest trusted context and confirmed old exit, current claim/generation, registered
new workspace and actual pinned checkout. Recompute the old full fingerprint using
only the old cwd; identity/profile changes cannot masquerade as directory migration.
Normal bindings and latest-worker recovery use the same gates. Missing bindings do
not erase context. Only exit-proven, never-started admissions can be skipped; unknown
latest work cannot be bypassed to select older history or open a fresh Session.

Pinned Codex0.166 resumes the exact original thread with the new workingDirectory.
Claude and native cwd changes use explicitly reconstructed physical Sessions with
hash-bound host archives of prior context/conclusions, tool/message facts, handoffs,
handled-input state and operation receipts. Old bindings/Sessions remain. Native
reconstruction verifies the new DSH header cwd and retains original parts as history;
it does not pretend the old physical Session moved. Read sources in bounded pages,
use current policy/claim, never replay historical receipts or unknown writes. Archives
remain private artifacts/scoped runtime files, not permanent Chief memory.

Persist mode/source/current physical identity, checkout and archive hash through
existing admission/activation fences. Context mismatch is structured feedback for
Chief; original context and unknown-exit capacity stay protected. Proven pre-start
failure reuses #2336 rollback. No automatic human escalation or business routing.
See [recovery details and validation boundaries](../task-session-recovery.md).

#2338 adds capability-advertised receipt-only continuation in the same SDK thread.
Correction turns disable tools while preserving the role filesystem profile;
sealed execution logs/result hashes remain original. Stale turn frames are ignored.
Native correction waits for the original Agent to idle and denies business tools.
See [receipt contract](project-inputs.md#invalid-receipt-correction-2338).

#2347 distinguishes in-process native-Chief host birth from independent SDK,
container and native-role tool lifecycles; host exit cannot release the latter.
Verification continuation still uses the original Task-role restoration gates.
