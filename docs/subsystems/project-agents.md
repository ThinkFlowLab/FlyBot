---
subsystem: project-agents
owned_paths:
  - core/src/host/project-consultations.js
  - core/src/host/project-agents.js
  - core/src/host/project-agent-skills.js
  - core/src/host/project-role-context.js
  - core/src/host/project-role-policy.js
  - core/test/project-role-policy.test.js
  - core/test/project-role-context.test.js
  - core/src/host/project-credentials.js
  - core/test/project-agents.test.js
  - core/test/project-credentials.test.js
---

# Public roles and private Project agents (fork M4)

Project has public Chief/Developer/Tester/Reviewer definitions and a separate private
agent identity for each `(host memberId, projectId)`. Human Project roles still decide
permissions; a Chief/Reviewer label grants no human authority. Current membership and
session validity are checked on every scoped tool operation.

## Identity and storage

`projectAgents` holds logical identities and current Bot/Session carriers. Private keys
are derived from Project/member IDs; replacing a missing Bot does not change the logical
identity, private notes or transcript key. Each private Bot has the human as owner and a
Project binding. Public Chief is a new shared Session. Existing owner-only Project Chief
sessions remain in `legacyChiefs`, with their original private context; they are never
silently promoted into public shared history. New workbench Projects create scoped
agents instead of scheduling legacy private-assistant digests.

| Data | Scope | Host storage |
| --- | --- | --- |
| Public role/persona/model/skill definitions | current Project members | projectAgentDefinitions |
| Shared facts/decisions with author | current Project members | projectKnowledge |
| Public Chief channel | current Project members | projectAgentTranscripts[public identity] |
| Private notes/conversation | one human in one Project | projectAgentMemory / projectAgentTranscripts[private identity] |
| Unpublished Task proposal | its proposing human only | projectAgentProposals |
| Code role instances/evidence | existing versioned Project Attempt | M3 workspace/Run/Attempt stores |
| GitHub write attribution | Project operation audit | projectGithubWrites / Attempt.pr |

`project-agents {projectId}` returns only the caller's private identity, notes and
proposals, plus the shared definitions/Chief/facts. Caller-supplied agentId/memberId
cannot select another private identity. `project-agent-history` similarly derives the
private identity from the actor. A public context tool never returns any private table.
A private context includes shared facts and that identity's own bounded notes/history.

`project-knowledge-write` records explicitly shared facts/decisions with their author.
Private notes use `project-agent-memory-write` or the private agent's memory tool; these
never write shared knowledge. Private Task proposals remain private until their human
calls `project-agent-proposal-apply`, an idempotent explicit publication of the displayed
fields. No private conversation is copied automatically to the public Chief or Task.
Existing authorized shared Tasks can be executed by a private agent without publishing
private content. The public Chief can create a Task from its current public requester.

## Delegated execution boundary

`project-agent-message {projectId,visibility,text}` derives the identity and records
explicit human input. One live human delegation per agent turn prevents another user's
request from overwriting the actor while a public Chief is answering. The delegation
contains the trusted session and definition revision, not body claims. A matching observed message/turn activates the delegation; the delivery layer checks its
ID before queuing, and cancellation removes that exact queued exchange. Busy agents
return bot/busy. A reply/transcript records the initiating human, actual Bot and definition
revision; public and private logs remain separate.

The model receives only `project_agent_context`, `project_agent_memory`,
`project_agent_task` and `project_agent_run`. Server guards refuse all other tools,
including filesystem, network, generic team and connector tools. Tool masks reflect this
when DSH can hide the tool; guards still refuse agent-local names that cannot be hidden.
The capability is bound to the current own Session. Group/historical Sessions cannot
reuse it, and Project agents cannot be added to groups through roster or participant APIs.
Public Chief is not reachable through the legacy private send/history API.

Every scoped operation checks the current delegation, human membership and session.
With platform identity, it revalidates the existing upstream session API; a revoked,
suspended or substituted subject fails closed. A changed delegation after an async
validation cannot be used. Local session revocation and Project member removal cancel
chat delegations immediately. Accepted code work remains under Project authority,
as defined in M2; chat revocation does not secretly cancel unrelated code workers.

Archive preserves existing historical read access but refuses new agents/shared Task
creation. Delete first archives/blocks new work, retires scoped agents and clears their
private notes/transcripts, while retaining the public discussion and role definitions
beside the Project tombstone. Partial deletion stays archived and can be retried. No
new agent can be recreated for a deleted Project. M1/M3 still refuse unfinished work.

## Role definitions and skills

Owner/Maintainer may configure a public role's persona, served model reference and skill
names. Built-in planning/code/testing/review skills have explicit instructions and hashes.
Existing capability-library skill content is reused only when the operator names it in
`projectSkillAllowlist`; private/global library contents are not enumerated or inherited
into shared context. Unavailable skill/config changes fail before mutating the definition.

M3 records the complete definition revision, role/model/persona and resolved skill content
on the next Attempt. Running Attempt definitions remain immutable. Persona/skill changes
do not change server permissions. Public Chief updates apply at its next message; the
core scoped instructions remain present. Worker role policy still uses the registered M3
cwd, independent tests and commit gates. It does not claim OS/container isolation.
Connector declarations stay refused; external writes use the explicit host broker below.

## GitHub identities

Project code publication uses `projectRepositories[repository].github` as explicit
Project automation. Personal comments use a different exact mapping:

```yaml
personalGithub:
  host-member-id:
    project-id:
      credential: gh-cli
      configDir: /operator/alice-project-gh
      login: alice-github-login
```

A credential source requires an explicit absolute config directory. Ambient GH_TOKEN /
GITHUB_TOKEN values are removed before looking it up. The selected token is verified
against GitHub /user and any configured login; push clears inherited auth headers before
supplying the selected credential. Tokens stay in host memory/environment for the narrow
operation, never Bot context, command arguments, persisted state or frontend responses.

`project-credential-status` reports only configuration status and the caller's personal
login; it does not claim a configured credential was verified. `project-github-comment`
uses only the authenticated caller's exact personal Project mapping. Body scope/user/
credential references cannot select Project automation or another person's credential,
and Owner authority cannot override this. Missing/mismatched credentials fail explicitly.
Immediately before posting, platform session and current Project write rights are checked
again. The audit records initiator, actual/selected GitHub login, scope, URL, body hash and
identity verification. A response mismatch is recorded for reconciliation and refused.
Project PR metadata similarly records the actual executor login and automation scope.
No personal GitHub write is exposed as an unrestricted model connector.

## API and verification

New APIs: project-agents, project-agent-message/history/memory-write/definition,
project-agent-proposal-apply, project-knowledge-write, project-credential-status and
project-github-comment. They are behind the explicit Project workbench mode and the
same platform/member authorization boundary. Existing legacy mode remains separate.

Agent tests cover private pair identity, cross-user/project reads, proposals and actor
attribution, busy/public delegation, member/session revocation, group/old Session denial,
carrier replacement, skill configuration and deletion privacy. Credential tests cover
exact human/Project selection, ambient-token refusal, actual-login binding, no fallback
and revocation before an external write. M3 tests continue to cover pinned role snapshots.

`npm run test:demo:runtime` includes an actual DSH `--agents` probe: two private agents
call real scoped tools, private notes remain separate, a private proposal is published by
its human, public Chief creates a Task as the current requester, and removal refuses old
Session/history access. It uses a deterministic model, not a real-model acceptance claim.
The selected real automation account was also read-only verified as zy95-12; tests do not
claim two real personal GitHub identities or personal writes were exercised. The unchanged
control-plane shared probe remains a separate integration check.

Privacy here is enforced on FlyBot's scoped API/tools. M3 code workers retain the existing
host execution preset and no OS sandbox is claimed. Shared browser delivery also needs a
restricted gateway that keeps the outer DSH owner credential and raw DSH Session APIs away
from members; M5/M6 implement/test that entry. This is a trusted-input collaboration demo,
not a claim of hardened hostile-code multi-tenancy or encrypted server-side storage.

### Real-model integration findings

Scoped tools serialize their structured return as JSON under the declared string output
schema. Rendering an object with String(value) loses facts/Task ids as `[object Object]`;
real agents may retry an otherwise successful creation. Regression coverage checks the
model-visible render, not only the internal service result.

Within one live human delegation, repeated concurrent task-tool calls with the same
normalized title reuse the first Task/proposal and preserve its original criteria. The
key binds agent identity, delegation and title; a new human request can intentionally
create another Task. Authorization is rechecked inside the serialized mutation. Private
proposals remain private and still require separate human publication.

Carrier names place a digest of the logical identity before a short Project label, keeping
uniqueness within the host's 40-code-unit limit. Long equal Project names cannot truncate
away the human/Project discriminator; replacing a carrier preserves the logical identity.

The integrated [real-provider acceptance](../live-acceptance.md) confirms actual models read
their own JSON context, acknowledge private notes and create one shared Task as the current
human. It exposed and verifies the truncation/serialization/idempotence fixes above.


## M7.1 — persistent definitions and memory, replaceable execution Sessions

`projectAgentDefinitions` remains the public role registry. Each role now carries explicit
`memoryRefs` and `execution {harness, resourceIds}` references, including Chief. Existing
records without these fields retain native execution defaults. Non-native/unprovisioned
selection fails closed until the following resource/Harness phases implement dispatch.
No configuration field grants filesystem or human authority.

`projectRoleMemory` is public, explicitly published by a configuring human through
`project-role-memory-write`. A record is scoped to exactly one Project and role, with
revision, human source/reference and prior published versions. Cross-scope/missing refs
are refused before configuration changes. Private notes, transcripts and proposals are
never a source. No execution transcript is automatically promoted to long-term memory.
Owners can explicitly publish verified experience and cite its source.

A Chief turn freezes persona, Skills, referenced memory, public knowledge and registered
repository instruction excerpts into `lastRequest.context`. Its hash/version/source refs
remain with the request. Chief has no idle inference timer; incoming human messages use
the existing delegated inbox/turn machinery. Logical identity/history survive carrier
replacement. Completion is recorded, and late callbacks without an active matching
Session/delegation cannot append messages. New configuration affects the next turn.

Delivery snapshots use the same assembler, with Task criteria and prior Attempt feedback.
The context is capped at 48,000 characters and rejects overflow. Repository AGENTS,
PROJECT, ROADMAP and LESSONS are read from Git at an explicit commit, each capped at
6,000 characters with truncation flag, full-content hash and original size. Context is
JSON fenced with angle brackets escaped. Public inputs are task data, never permissions.
The host inserts the snapshot after the Workflow graph's 4,000-character prompt boundary;
actual DSH runtime assertions check the model request contains memory and repo content.


### M7.2 — 2026-10-31

M7.2 validates role resource references against operator grants before saving configuration. Optional maxConcurrent limits the configured role pool; new settings do not mutate saved Attempt/Session snapshots.


### M7.3 checkpoint — 2026-10-31

M7.3 temporary workers may select Codex/Claude Agent SDK with an admitted resource lease and explicit principal profile. Public Chief may use either SDK with generic runtime tools disabled and a bounded typed action proposal; the host rechecks current human/Project authority before creating Tasks or runs.


### M7.4 — 2026-10-31

M7.4 role execution adds an explicit SDK model alongside native served model; Owner UI edits multiple resource IDs, bounded concurrency and published memory refs. Saving checks each resource but cannot mutate already frozen contexts.


### M7.5 — 2026-10-31

M7.5 native Chief can also use an authorized local candidate pool with a per-turn lease; end/cancel releases execution occupancy while its logical Bot/history remains resident. SDK Chief may run on a prepared Docker resource with explicit profile and empty public cwd; no private content transfers.

## Complete role conventions (repair R2, issue #35)

Developer, Tester and Reviewer retain their repository work conventions. Built-in
Skills spell out reproduction, red/green evidence, memory/architecture/test updates,
canonical patches, exact-SHA checks, independent review and honest Ran/Not run.
Custom library Skills that exceed the supported size fail explicitly; no silent
truncation of governing rules is allowed. Owner decisions override historical
upstream identities, while execution and merge gates retain their authority.

Each new delivery Session stores `project-role-policy/v1`: complete public policy
files from its base commit, source SHA-256/byte counts, role conventions and a
bundle hash. The separate bounded context keeps summaries, persona, memory, Task
and policy references. Host native creation and SDK dispatch append the complete
policy **after** Workflow node cleaning, which otherwise truncates node prompts.
Policy hashes are checked at execution and subsequent delivery gates. Missing
required files or an oversized bundle blocks execution rather than dropping rules.
Policy content is escaped, fenced repository guidance and never adds tool authority.

Default sources include AGENTS, PROJECT, ROADMAP, LESSONS, CONTRIBUTING, code
standards, applicable fork decisions and role-specific fix-issue/review-pr/testing
protocols. An operator may configure `rolePolicySources[role]`,
`requiredRolePolicySources[role]` and `rolePolicyProfile`; sources must be regular
files in the pinned Git tree. FlyBot repositories require the common rules and
role protocol, and code sealing requires memory, regression tests and matching
architecture changes. Generic projects retain their own development conventions.

A delivery recommendation is recorded with exact candidate SHA, policy hash and
observed SDK command evidence. It explicitly reports repository review as INC:
JSON `approve` cannot establish the separately authorized signed forge Reviewer
PASS, identity/signature verification, merge authorization or human acceptance.
Existing host test and candidate-evidence checks still apply.


Repair R4 (#37): Ordinary private questions use `project_agent_chief` or
`project-chief-question {projectId,text,requestId}`. A versioned conversation
handoff creates an isolated temporary Chief carrier and a separate delegation,
with only the explicit question and shared Project context. It never creates a
Task or forwards the parent private notes/history. Replies return to the original
private transcript with Chief attribution; no other member/public transcript gets
them. Duplicate question keys reuse the receipt; changed text with the same key
is refused. Native and SDK query turns cannot propose, publish or run Tasks, even
if a model asks. Native scoped tools and SDK host-read actions can inspect actual
GitHub facts. Carriers retire after completion and keep a private receipt.

Private-agent prompt v2 introduces this route for existing carriers. Impactful
Task proposals explicitly carry code/decision/release kinds, persisted on
publication and fixed at execution admission. Questions have no Task kind. Safe
proposal publication still does not imply assignment or execution; watch-mode
authority is completed by R5. See [GitHub reads](project-github-read.md).


Repair R5 (#38): Private agent prompt v3 and `project-agent-mode`
provide safe/watch modes. Safe task tools return proposals unless the current
human explicitly approved publication; watch publishes using a validated persistent
user grant. The query-only Chief contract still forbids Task/run actions in watch
mode. Full scoped human operations are exposed through `project_agent_action`
with current Project checks and audit. SDK Chief may reference `$lastTask` only
for the immediately preceding host-created Task; a proposal cannot be run.
See [delegation contract](project-delegations.md).

Repair R6: resident Chief runs bounded arbitration jobs through native or actual
SDK execution with complete pinned policy. Private tokens bind current Run and
policy revision; native job prompts restore after completion and new human turns
replace both instruction fields. Stale persisted inputs cannot reuse a revoked
delegation. Coordination jobs cannot authorize themselves or create arbitrary Tasks.

Chief coordination retains explicitly published shared Project knowledge alongside
its role memory; private human notes/history remain excluded.

R7 #40 extends existing delegated conversations to independent room/role carriers.
Room execution snapshots current public role definitions, Skills and published memory;
restricted room history never enters the public Chief or a human's private agent.
Conversation-only delegation rejects Task/run effects for native and SDK roles.
Native text streams are bounded, process-local and tied to the exact live delegation;
reasoning is excluded. Scoped stop fences callbacks before awaiting owned worker exit.
See [collaboration contract](project-collaboration.md).
Repository previews may reference the separately injected complete policy only after
verifying the policy hash, source commit, full source hash and preview prefix.
Unverified previews remain inline under the unchanged 48,000-character limit;
knowledge, memory and complete policy rules are preserved.

Board-only `project-agents {view: summary}` returns the current public Chief identity after the same membership checks; it neither creates a private carrier nor returns private notes/proposals or role-policy bodies. Full settings/conversation responses retain their existing ownership scope.


## Explicit knowledge checkpoints (R6 context recovery)

`project-knowledge-write {projectId,text,kind,supersedes:[{id,sha256}]}` optionally
publishes a manager-authored current summary. Ordinary append remains available
to current Project members; checkpoint publication additionally requires configure
permission. Each reference must name a distinct existing record in this Project
with SHA256 of its exact JSON representation. Missing/foreign/changed records,
malformed references or more than512 entries fail before appending. No record is
deleted, rewritten or attributed to a different human. The full public history
remains available in project-agents/context under existing Project authorization;
private memory is never a checkpoint source. A summary is human-published task
data, not proof or additional authority.

Role context verifies each checkpoint against earlier source records. Only valid
explicitly covered entries leave the inline view; checkpoint text and later facts
remain. The context carries covered-history count/digest/retention source and
bounded checkpoint reference metadata. Snapshot sources retain every input ID and
hash. Stale/invalid references retain original records and the existing48,000-char
limit still rejects overflow. Requirements, memory and full repository policy are
unchanged. No automatic lossy model summary or privilege widening is introduced.

Regressions cover actual API manager/member/Project boundaries, no side effects on
refusal, immutable history, invalid/forward/duplicate/tampered refs, subsequent facts
and both Developer/Chief admission below the unchanged cap. Live publication and
actual execution recovery are separate acceptance evidence.


## Resident Chief memory and context retrieval
Chief memory index/head comes from the original resident Bot's own MEMORY.md/topic files. Scoped project_agent_context accepts memoryRequests and memoryUpdates (topic, text, replace) only for the active public Chief; SDK uses the same host contextExchange. Normal platform/delegation and Project membership checks still run. No requested Bot ID, team scope, another Project or private agent can retarget the store; private/read-only conversations cannot publish shared memory. Source references name the actual Chief request and journal preserves replaced facts. SDK instructions request short durable public facts rather than execution logs, repository rules or credentials.

RoleContext retrieval mode retains the48k admission ceiling and all original requirements/persona. Recent public knowledge is inline within8k; older/large rows and oversized attached memory remain in a content-hashed immutable archive. Exact source IDs/hashes stay in evidence. Chief reads paginated index/source pages through contextRequests; command-enabled roles read only needed archive entries. Each page is6000characters, maximum4 per request. Unknown kinds/IDs, negative offsets and changed archives fail closed. This is source retrieval before execution, separate from model-history compaction. Legacy explicit checkpoint records remain valid and retained.

## Development service compatibility (S1)

Scoped agent run/watch actions retain their existing authorization and legacy endpoint calls, which now route to the development facade. No new agent tool authority or permission to submit raw role events is added. See [service contract](project-development-service.md).

## Durable effects and outbox (S2)

Personal public writes use a durable outbox when the effect host is installed. State retains immutable-body hashes/references, current human/grant provenance and verified public receipts; text remains a private0600 artifact and cookies/tokens/transient browser actors are not persisted. Background work rechecks current authority and never falls back to automation credentials. See [effect contract](project-effects.md).


S6 live recovery also fences SDK-owned Chief delegations before asynchronous worker
registration. Dormant native DSH turn/end events must not consume the scheduled SDK
job during that setup window; only its fenced SDK callback may finish it. The
regression injects that event before a worker ID exists, then requires exactly one
completion from the actual bound callback. Native-only execution retains its events.

## Independent personal-agent integration

Independent personal identities (#2170) now own per-Project participations/carriers. Legacy IDs and private memory/transcripts remain in place; privateIdentity resolves the selected participation. Native tools validate active participation before and after async authorization. See [personal agents](personal-agents.md).

## Scoped connection integration

Private-agent persona v5 describes an independent identity/isolated participation and adds project_agent_suggest_closure. Safe private agents can recommend closure without a Task; host-derived participation is required, and Owner confirmation stays personal. Approved external private proposals retain persisted origin/approval provenance.


## Consultation protocol — #2175

Ordinary questions are `project-consultation/v1` views over the original private
`conversation-handoff/v1` transcript records. `project-chief-question` remains a
compatible ask alias, including its old `handoff` response field. It now also
returns `consultation`; historical records remain readable without becoming Task
handoffs. A consultation never transfers Task initiative or creates a Task.

| Development operation | Native endpoint | Authority/result |
| --- | --- | --- |
| `consultation.ask` | `project-consultation-ask` | Current member/own scoped agent asks Chief |
| `consultation.get` | `project-consultation-get` | Own selected participation, bounded reply page |
| `consultation.list` | `project-consultation-list` | Own selected participation, receipt cursor |
| `consultation.reply` | `project-consultation-reply` | Reply to an incoming Chief question only |

Use `agentId` to select an owned participation; scoped connection credentials bind
that selection to their own agent. A missing mailbox read does not allocate a Bot.
External agents have transcript mailboxes, without pretending to log into a provider
or silently starting a native personal agent. Outgoing answers are accepted only
from the existing delegated Chief executor; callers cannot impersonate Chief through
the reply endpoint. Full private notes/other-agent transcripts are never forwarded.

Chief `needs-human` first addresses the initiating user's active default personal
agent, or the Task requester when no initiation binding exists. The durable incoming
question retains Task/decision/Chief-job ids in that participation's existing private
transcript. No valid agent means explicit human fallback. `requiresHuman` adds a
personal-only response boundary; Project closure still independently requires Owner
confirmation. A changed default does not transfer the old question, grant or context.

Safe replies remain private suggestions; an explicit current user publish is needed
to send their text to the Project. Watch replies intersect current user/participation
rights and the existing validated delegation. Published answers use the original
Task inbox/Effects admission, retain approval/proxy provenance in the private receipt,
and wake Chief through that inbox. Reply publication does not close/requeue a Task
itself; Chief decides the next action. Exact requestId/text replay reuses the answer
and Task-input record; altered text is refused. Stale decision replies are refused.

The existing Effects dispatcher sends notifications only after the question snapshot
commits. An already authorized native watch can be woken through `wakeWatch`; safe
and external agents consume their own mailbox without an invented provider transport.
`project_agent_consultations` is the native personal-agent tool for get/list/reply.
An Effects attempt or SDK send is not a read/handling receipt. External responses
still need a connected client; no official grok/dots integration is claimed.


#2177 routes native context tools through the shared [context budget and memory
contract](project-context.md). Public/private source reads are bounded, hash/cursor
bound and currently authorized. Public role facts support versioned dedupe/archive;
execution experience remains unverified and cannot overwrite human facts. Private
notes retain history while default views remain bounded. Native Chief topic memory
continues to use the original own-Bot store, with paged scoped adapter reads.

Native resident Chief jobs now send the current protocol and scoped facts in each turn request. They keep a stable role system definition instead of relying on replacement of a cached system prompt. The full native input is budget checked and actor/delegation authority is revalidated before dispatch; the same resident Session remains in use.

## Project Task lifecycle convergence (#2179)

Project Task proposals carry explicit impact and scope fields alongside title and criteria. Publishing authorized work does not itself admit it to execution: the resident Chief must validate its requirements first. Consultation remains outside Task creation.
