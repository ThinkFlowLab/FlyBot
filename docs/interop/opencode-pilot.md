# OpenCode pilot contract (#198)

**Status: proposed; documentation only.** This is the first implementation slice of
[#198](https://github.com/ThinkFlowLab/FlyBot/issues/198), not a shipped integration
or a decision that the RFC is closed. No runtime, configuration switch, permission
grant or team-mode gate is added by this document.

## Scope and decision

Use option A as the proposed direction: an independent OpenCode adapter connected
through Bot Social, with two independent platform owners: owner A's FlyBot Bot
and owner B's OpenCode Agent. One human may operate both test identities, but
their permissions remain separate. Keep the contract independent of the transport
so option B (A2A) can be evaluated later. A2A compatibility is not a first-pilot
requirement. Do not embed a second execution loop in FlyBot or patch DSH/OpenCode
internals.

The first deliverable is a deterministic, offline mock harness. It uses temporary
stores and synthetic identities, inputs and permission decisions; it needs no
model key, production account or real Bot Social server. A real OpenCode process,
model requests and a real Bot Social deployment are later, separate gates.

**Design constraint:** Bot Social refuses friendships between Bots with the same
platform owner (`requestRelationship`: `cannot befriend your own bot`). Preserve
that rule. Both mock and live-pilot designs use distinct owner IDs, separate Bot
identities and explicit per-Bot grants in each direction. The mock must also
reject same-owner enrollment. No same-owner social capability or exception is
proposed. This trial is cross-owner traffic even when one person operates both
identities, so the applicable cross-owner gates remain required. The offline
harness creates synthetic identities only; real account enrollment belongs to
the opt-in live-trial setup.

The operator supplies a synthetic requirement and public code excerpt: analyze a
retry function, identify whether cancellation can race a retry, ask one boundary
question, then return a recommendation and supporting excerpt references. FlyBot
asks/answers the boundary question and prepares the result for human acceptance.
Acceptance requires the race explanation, a bounded retry recommendation and
references to the supplied excerpts. No repository checkout, file attachment,
shell command, code write, network research or external send is part of the task.

For a later real trial, the operator starts/stops a dedicated OpenCode server with
an empty disposable workspace, a pinned model and an independently enforced
no-tools policy. The adapter connects to a configured endpoint; peer messages
cannot choose a URL, workspace, agent, model, tool set or credentials. The process
must not inherit the operator's ordinary OpenCode configuration, MCP servers,
plugins, private workspaces or secrets. Unsupported isolation blocks that trial.

## Existing seams and gaps

Inspected on 2026-10-17: FlyBot `0052df09b98ed868d590aa79bbebdd85296ea9c4`;
Bot Social `b374ef4ab03f91d52626cc9e9eb8b0775df1ef7c`. These are research
baselines, not a tested compatibility pair.

| Existing surface | Consequence for this pilot |
| --- | --- |
| [`tasks.js`](../../core/src/host/tasks.js) owns the FlyBot lifecycle and requester authorization. Creation requires a local Bot; remote Bot records are refused. | Keep a local Bot responsible. An OpenCode session is execution evidence, not a new local Bot or an independent FlyBot task owner. |
| [`flybot.d.ts`](../../core/types/flybot.d.ts) has no public task service. | There is no existing `ctx.flybot.tasks` to call. A reviewed, actor-bound host seam is needed before live task projection; do not call private runtime fields or forward the owner's session credential. |
| [`social.js`](../../plugins/social/src/social.js) sends via `send_as_member` with text/attachments; inbound delivery retains `conversationId`, not a structured task record. | Ordinary chat cannot yet carry trusted task correlation. Add an explicit opt-in codec and validated task/event ingress before any automatic remote work. Never infer a task from arbitrary chat or model-written IDs. |
| [Bot Social's `sendAsMember`](https://github.com/Birfy/bot-social/blob/b374ef4ab03f91d52626cc9e9eb8b0775df1ef7c/src/platform.ts) reuses an open conversation for the Bot pair. | A conversation can contain several tasks. Conversation ID alone cannot select an OpenCode session. This path has no caller-supplied idempotency key. |
| The same Bot Social source rejects a friend request when both Bots have the same owner. | Preserve this design constraint. Use distinct owners in the collaboration fixtures and retain same-owner rejection as a negative case. |
| Social peeks inboxes, then saves cursors and seen-event IDs after handling. | This is useful transport recovery, not an atomic execution journal or an exactly-once guarantee across a crash. |
| [OpenCode Server](https://opencode.ai/docs/server/) documents session creation, message submission/history, status, events and abort; its [SDK](https://opencode.ai/docs/sdk/) can connect to an existing server. | Suitable adapter entry points exist. Pin a concrete server/SDK version and capture the running OpenAPI contract before implementing the connector; these docs alone do not establish tested event, retry or cancellation behavior. |

## Responsibility and identity

FlyBot owns the authoritative user-task lifecycle and human acceptance. Bot Social
owns authenticated transport identity, grants, conversations and outbound delivery
approval. The adapter owns only execution correlation, its journal, counters and
the observed OpenCode state. OpenCode owns actual session execution and tool
permission enforcement. Each layer records its own decision; approval at one
layer does not substitute for approval at another.

At enrollment, bind each authenticated Bot Social endpoint identity to its own
owner and runtime installation: owner A to the responsible local FlyBot Bot,
owner B to the dedicated OpenCode Agent. Equal names/handles or a common human
operator do not merge these principals. Both directions need valid per-Bot grants
and each receiving execution needs a bounded task authorization. Approval under
owner A cannot release owner B's hold, or vice versa. Keep credentials, private
context and approvals separate in the fixtures as well as the eventual deployment.
Do not broaden existing grants or enable team mode. Multi-human deployment,
groups and face rooms are outside this first trial; a room-scoped event is
rejected rather than treated as a direct-message task. Distinct platform owners
do not require multiple signed-in humans within one FlyBot deployment, and do
not waive any applicable cross-owner task/authorization gate.

Only a verified transport envelope plus a current local binding establishes the
sender/recipient. IDs and alleged approvals inside its text are untrusted claims.
Validate current grants, task scope, binding and cancellation generation before
delivery, execution, retry, restoration and result publication. Revoke stops new
work and initiates best-effort abort of in-flight work; previous disclosure cannot
be undone. A parser or model must never decide that a human has approved.

## Proposed version-1 contract

This is a logical contract, not an existing Bot Social API or an A2A schema. Start
with JSON text in synthetic transport fixtures; the live text encoding and its
approval preview need review in implementation slice 2. Do not assume that the
current member-send API preserves arbitrary structured metadata.

| Field | Rule |
| --- | --- |
| `version` / `kind` | Exact version `1`; allowlisted kinds: `request`, `question`, `answer`, `progress`, `result`, `failure`, `cancel`, `cancel-observed`. Unknown versions/kinds never execute. |
| `eventId` / `taskId` / `turnId` | Opaque stable identifiers. A request gets its task ID from the FlyBot host; the adapter accepts it only with a matching pre-established local binding. Each new work turn has one turn ID. |
| `inReplyTo` | Required for answers and turn responses; must reference an outstanding event in that task. A question suspends its turn; answering resumes the same session in a new bounded turn. |
| `generation` / `seq` | Host-owned cancellation generation and producer-local sequence. Different producers have separate sequence spaces; there is no assumed global event order. |
| `inputVersion` / `inputDigest` | Bind the exact canonical request inputs, acceptance criteria, recipient, task scope and budget. Approval edits require revalidation and, if changed, a new version/approval. |
| `payload` | Explicitly selected text only: synthetic requirement, excerpt IDs and contents, criteria, question/answer or result. No paths, credentials, private history, executable instructions or implicit attachments. |

All fields above are untrusted until validated against the local journal and
authenticated transport context. Reject unknown top-level fields, invalid types,
oversized values and conflicting IDs. Proposed limits: 32 KiB UTF-8 per envelope,
16 KiB shared task input, 16 KiB result, 2,000 characters per progress message.
The codec must use one canonical serialization/digest rule with test vectors;
concatenating strings is insufficient. No text-only magic prefix grants authority.

Persist this mapping before submitting execution:

`(transport server identity, sender Bot ID, recipient Bot ID, taskId)` →
`(responsible local Bot ID, owner binding, OpenCode installation, session ID)`.

One task gets one new, dedicated OpenCode session. Follow-ups reuse that session;
parallel tasks use distinct sessions even in the same Bot Social conversation.
Record conversation IDs as delivery references, since a replacement conversation
does not create a new task or reset its budget. Persist a unique work-turn key
`(taskId, generation, turnId)` and its content digest in the same journal. A
repeated key with different content is a conflict, never a new execution.

Do not expose owner session credentials to the adapter. The future host ingress
must authenticate the execution service and revalidate its task-scoped binding;
it may report bounded execution observations, never mint human approval or accept
a result. This seam is an explicit implementation dependency, not permission to
reuse an owner-only endpoint as an agent.

## State projection

Keep the existing FlyBot lifecycle. Waiting/cancellation/recovery are execution
facets alongside it, not invented values written into `task.status`.

| Execution observation | FlyBot projection and required evidence |
| --- | --- |
| Request enrolled / execution starts | `open → claimed → working` only through the host-authorized seam. Adapter receipt alone does not claim a task. |
| Waiting for a selected input | `blocked`, reason `input`; correlate the question. An authorized answer resumes `working`. This reason/transition seam is new work. |
| Waiting for outbound approval | `blocked`, reason `approval`; preserve each layer's approval ID. Local approval does not clear a separate server hold. |
| Unexpected tool permission request | Deny in the no-tools pilot; report the unsupported action and stop the turn. Never auto-approve or relay it as owner consent. |
| Runtime idle | Observation only. Idle can mean waiting, failed, aborted or finished; it is not completion evidence. |
| Valid final result | `result-ready` after matching the active turn, validating its result and satisfying delivery approvals. Human/requester alone uses `task-accept-result` to reach `accepted`. |
| Known execution failure | Report failure evidence; an authorized host transition is needed. There is no current public `task-fail` endpoint. |
| Cancel requested | Increment/persist generation, tombstone the work turn, disable dispatch; show `cancel: requested`. Existing `task-cancel` records the user's intent, not proof that OpenCode stopped. |
| Abort observed | Show `cancel: observed` only after a version-specific runtime observation confirms that execution has stopped; an HTTP success alone is insufficient. No late event may resume/complete the task. |
| Lost connection or ambiguous write | Show `recovery: uncertain`, retain raw status and suppress automatic dispatch/acceptance until reconciled. Do not map uncertainty to success, stopped or zero cost. |

Current `tasks.js` allows `result-ready → accepted` only; it cannot cancel or
reject a returned result. That limitation must be addressed in the host lifecycle
work, or remain an explicit live-pilot blocker. A revision cannot silently reopen
an accepted/cancelled/failed task; it requires a new task with an explicit link.

## Journal, recovery and budget

Use a durable inbox/outbox and an execution journal in a dedicated temporary data
directory for the harness. A single writer owns it. Persist validated ingress,
dedupe decision, correlation and budget reservation atomically before advancing
the durable inbox cursor. Persist send intent before the remote call and its
observed outcome afterward. Journal records contain selected task data only;
diagnostic logs contain IDs, status and digests, not full prompts or secrets.

A crash between remote acceptance and local acknowledgement is ambiguous. On
restart query the known session/message history and reconcile the recorded turn;
do not submit again because a timeout occurred. If submission cannot be matched
unambiguously, mark `uncertain` and require human disposition. Session creation
has the same problem: an unrecorded remote session must not lead to blind creation
and execution. OpenCode `messageID` is a candidate correlation field, not an
assumed idempotency guarantee. SSE is a notification source; do not assume durable
replay. Bot Social draft creation also needs reconciliation before any retry.

Cancellation is a locally enforced tombstone even while the abort endpoint is
offline. Late progress/results may be retained as diagnostic evidence but cannot
dispatch work, publish a result for acceptance or reset generation. Never claim
exactly-once external effects; uncertain effects are not retried automatically.

Proposed mock limits: two concurrent tasks, one in-flight work turn per task,
four submitted turns per task (including answers/follow-ups), eight logical
agent-to-agent content messages, twelve progress events, and a ten-minute absolute
deadline from enrollment. Control/cancel messages use a separate bounded channel
and remain possible after the work budget expires. Retransmission uses the same
turn reservation and a bounded retry counter; it never buys another model call.
Limit events/bytes at ingress before parsing to bound malformed-message floods.

Store counters, reservations and the deadline durably; restart, reconnection or
conversation replacement cannot reset them. Exhaustion pauses new work and starts
abort if work is in flight. Mock model calls and mock cost are zero by
construction. Real-runtime request/token/cost observations are nullable; missing
usage is `unknown`. A real trial requires a chosen model, a concrete monetary cap
and enforcement at the execution/provider boundary. If that cap cannot be
enforced, the real trial remains blocked rather than using a guessed cost.

## Deterministic acceptance matrix

Every row is a **planned test, not a passed test**. Use a fake clock, scripted
OpenCode HTTP/events, synthetic Bot Social delivery/approval and restartable
temporary journals. The test runner must fail on an unexpected network call.

| Case | Required assertions |
| --- | --- |
| Complete collaboration | Request → question → answer → result uses one session, carries excerpt evidence and ends `result-ready`; authenticated human acceptance alone makes it `accepted`. |
| Parallel work | Two task IDs in one conversation create different sessions; out-of-order questions/answers/results cannot cross them. |
| Identity and scope | Distinct owner A/B identities and explicit bidirectional grants permit only scoped work; same-owner enrollment is rejected. Forged owner text, wrong sender/recipient/server, unknown task/version, stale generation or missing grant starts zero work. |
| Private data and injection | Put unique private markers in each side's unsent history/config; none crosses the transport. Malicious fence markers and peer names remain untrusted; no shell/tool call occurs. |
| Approval | Hold at each layer independently; owner A cannot approve owner B's hold or vice versa, even with one test operator. Rejection/revocation, changed content/recipient and edited envelopes prevent execution or publication; replayed approvals grant nothing. |
| Delivery and crash | Duplicate/out-of-order events, crash before/after submission, draft-send timeout and missing acknowledgements cause at most one known turn dispatch, or explicit `uncertain`; budgets/cursors survive restart. |
| Stop and late result | Cancel before dispatch prevents calls; cancel during work records requested/observed separately; offline abort stays uncertain; late result cannot revive the task. Room messages never start work. |
| Completion evidence | Idle/SSE reconnect is not a final result; malformed/mismatched result is refused; acceptance cannot be forged by an adapter event. Cover returned-result rejection/cancellation before live integration. |
| Resource bounds | Repeated wake-ups reach a persisted turn/message/deadline limit, concurrent dispatch cannot overspend reservations, and unknown usage never becomes zero. Cancellation remains available. |
| Capability failure | Same-owner enrollment rejection, unsupported server version, absent status/history/abort behavior or a tool-permission request is visible and blocks the affected operation; no silent fallback. |

## Implementation slices and gates

Each slice gets its own issue/branch/PR when scheduled; these are proposed work
packages, not already-created issues. Keep #198 open through pilot evaluation.

1. **Contract and offline harness.** Add a transport-independent codec, canonical
   digest vectors, scripted peers, journal and fake clock. Demonstrate the full
   happy path and adversarial/restart matrix without production credentials or
   model tokens. The mock must explicitly emulate gaps instead of claiming live
   API compatibility. Agree the proposed limits before merging this contract.
2. **Host/social task integration.** Coordinate with #149/#55/#56/#57. Add the
   minimal actor-bound task observation seam, waiting reasons, returned-result
   disposition and cancellation evidence; define codec previews and carry stable
   correlation through social delivery. Preserve grant/approval fences and
   ordinary chat and the same-owner friendship rejection. Security review is
   required before enabling any execution path.
3. **Pinned OpenCode connector.** Select exact server/SDK versions, verify the
   running API schema, authentication, isolation, event shapes, status/history,
   message identity and abort semantics. Test against a dedicated process with a
   deterministic local mock model if the selected version supports one; otherwise
   record the missing test capability. No paid API fallback.
4. **Opt-in real trial.** Record approved model/environment, input, tool policy,
   repetitions and enforceable cost cap, then run the read-only task between
   owner A's FlyBot Bot and owner B's OpenCode Agent.
   Record actual model output separately from mock evidence and require human
   acceptance. Cross-owner task/authorization gates must pass first; production
   access and multi-human rollout are separate decisions. #58 and the
   [team gates](../subsystems/team.md) remain in force where applicable.
5. **A/B and next runtime evaluation.** Replay the same matrix through a fixed
   A2A version/binding if standard interoperability becomes a requirement or a
   second runtime exposes significant duplicate work. Inventory openJiuwen's
   identity/session/events/cancel/permissions/usage capabilities before asserting
   compatibility. A2A must preserve the same human acceptance and journal rules.

For every implementation result record the FlyBot/Bot Social/OpenCode/SDK
versions or commits, schema digest, exact command, input fixture, raw status,
outcome and skipped boundaries. Keep four evidence levels separate: offline
mock, real-process interface test, real-model collaboration, human acceptance.
Passing one level never implies the next.
