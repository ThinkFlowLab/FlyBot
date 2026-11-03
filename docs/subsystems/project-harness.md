---
subsystem: project-harness
owned_paths:
  - core/src/host/project-native-sessions.js
  - core/test/project-native-sessions.test.js
  - core/test/project-native-exit.test.js
  - core/src/host/project-task-sessions.js
  - core/test/project-task-sessions.test.js
  - core/src/host/project-git-sandbox.js
  - core/test/project-git-sandbox.test.js
  - core/src/host/project-harness.js
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
The public native-resume capability remains conservative until the whole loop is tested.


Approved custom roles now pin `policyRole` on their Session and SDK worker record. Native/SDK Workspace ownership accepts an approved capability while preserving logical role identity. Codex writable roots and SDK readOnly derive from the pinned capability, not a literal Bot name. Repository source overrides prefer the logical role and otherwise inherit its capability's complete rules; the custom policy hash records both, while default policy bytes remain compatible. SDK subprocess contract tests inspect actual transmitted readOnly settings for a custom Developer and Reviewer; they are deterministic workers, not provider execution.
