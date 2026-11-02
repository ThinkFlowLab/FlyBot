---
subsystem: project-context
owned_paths:
  - core/src/host/project-context-budget.js
  - core/src/host/project-context-memory.js
  - core/src/host/project-agent-context.js
  - core/test/project-context-budget.test.js
  - core/test/project-context-memory.test.js
---

# Scoped context, working summaries and memory

Project context separates fixed role conventions, retrieved long-term memory, working
summaries and original sources. It reuses role definitions, Task-role Sessions, public
role-memory records, Chief topic memory, original parts/steward and immutable context
archives. No second knowledge platform, executor or maintenance timer is installed.

## Configured budgets

The operator supplies `projectContext` beside the existing Project settings. Defaults
are overridden by Harness, then exact model/profile identifier. Example numbers below
are an operator's envelope, not a claim about a named model's actual capacity:

```json
{
  "projectContext": {
    "defaults": { "maxChars": 48000, "readChars": 6000, "toolOutputTokens": 2000 },
    "harnesses": { "codex": { "toolOutputTokens": 2000 } },
    "models": {
      "operator-model-id": {
        "windowTokens": 64000,
        "outputTokens": 4096,
        "toolTokens": 4096,
        "protocolTokens": 2048,
        "threshold": 0.8,
        "memoryTokens": 4096,
        "knowledgeTokens": 4096,
        "summaryTokens": 4096
      }
    }
  }
}
```

`inputTokens = floor(windowTokens * threshold) - outputTokens - toolTokens -
protocolTokens`. Optional fixed/current-input ceilings are `fixedTokens` and
`currentInputTokens`. Native model metadata may supply the window/output default;
a configured window cannot enlarge an observed provider window. SDK profile model
selection is resolved again on the actual chosen resource before dispatch. Unknown
capacity stays `capacitySource:unknown`, `windowTokens:null`, `withinBudget:null`;
the existing character cap and bounded reads still apply, without guessing a
universal model window. Invalid budgets fail before model input.

`estimator:utf8-upper-bound` counts UTF-8 text bytes as a conservative token ceiling.
`flybot-estimate` uses FlyBot's CJK/Latin estimate with a1.5 margin; it is an estimate,
not an exact tokenizer. Neither mode claims precise SDK history or multimodal usage.
Snapshot `budget/usage` and worker/native `inputUsage` expose configuration source,
layer counts, selected/omitted public sources and reservations without private text.
SDK aggregate turn usage is retained as usage, not mistaken for current window size.

Role context accounts for complete policy and fixed persona/skills, current user
constraints, working summary and retrieval. Optional retrieval yields first; required
rules/constraints never silently disappear to make a load succeed. Current Project
goal/scope and Task constraints remain explicit. SDK checks the actual final dispatch
text. Native Workflow supplies its exact serialized input to the host's generation,
authority, lease and durable-save check before sending it. Structured handoff/inbox
objects remain JSON rather than becoming `[object Object]`. Cancellation while saving
prevents delivery. The original native parts/steward still manages its full Session.

## Long-term facts and working summaries

Public role memory can have `factKey`, classification (`unclassified`, `fact`,
`inference`, `unresolved`, `conflict`), active/archived status and expectedRevision.
Repeated identical facts do not manufacture versions. Changes retain previous text,
classification, status, author/source and time. Human facts require current configure
authority; a memory note cannot change persona, collaboration rules or permissions.
Archives remain readable through explicit history pages, while ordinary retrieval
excludes archived records. Current default views omit nested version histories.

Active role executions may record at most300 characters of experience under their
current Project/Task/claim, using trusted `role.memory.record` or up to three optional
`memory:[{text,factKey?,classification?}]` notes in their handoff response. Such notes
are inference/unresolved/conflict, never self-certified facts. They cannot overwrite
human-controlled facts or revive an archive. They retain Task/claim/generation/request
provenance and are retrieved only for the same public role under its budget. A human
may explicitly review/update them. Private user notes never enter this public store.

A normal handoff stages a bounded Task-role working summary with its existing
handoff/Effects commit. It includes requirement hashes, role claims, unresolved refs,
next step and exact candidate/test/review references. A stale passing test stays stale;
a candidate recommendation is not a signed repository PASS. The next return to that
role loads its own summary, not another role's conversation. Previous versions remain
in the original role-memory record. Failed uncommitted staging rolls back only the
unchanged candidate and preserves concurrent updates/last valid summary.

Resident Chief decisions update separate Task topics on its existing public carrier.
Later turns retrieve relevant bounded topic summaries; all originals remain in scoped
summary archives. A failed summary update records `contextIssue` without erasing an
already applied Chief decision. Summary maintenance is deterministic at meaningful
handoff/Chief boundaries; ordinary reads do not ask a Bot to rewrite project position.

Private notes are retained independently of the default last100-item UI view. Existing
`project-agents` supports `privateMemoryOffset/privateMemoryLimit` and
`roleMemoryOffset/roleMemoryLimit`; limits are1–100. `roleMemoryId` with
`versionOffset/versionLimit` reads a same-Project memory history page. This changes
representation size, not ownership or publication rights.

## Retrieval and tool results

Relevant current facts/memory are ranked within per-layer budgets; exact duplicates
with the same provenance/classification may be represented once. Different uncertainty
or source metadata is not collapsed into a verified conclusion. Original rows remain
in the immutable archive. `contextRequests` supports knowledge/memory/repository/summary
sources and searchable index pages, with scope/hash/offset checks. Multiple reads
share the reserved tool result envelope; an insufficient envelope fails explicitly.

`project_agent_context` returns a bounded index instead of all Task/Run/private history.
Its `sourceRequest:{kind,id?,offset?,sha256?,query?,revision?}` reads exact authorized
project, task-index, task, private-memory, public-message, knowledge or role-memory
sources. Source pages retain hashes/cursors and reject changed sources. Private sources
always resolve through the current participation, and room sources through current
room access. Chief `memoryRequests` supports own-topic offset/limit and charOffset
pages; caller-supplied Bot/team scopes cannot retarget it. Check the result budget
before durable memory writes so an oversized response cannot conceal a mutation.

Codex receives a configured `tool_output_token_limit` for tool history; its own
compaction and backend Session identity remain managed by the SDK runtime. See the
[official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Claude continuation still uses its existing SDK adapter; generic Claude tool-output
limits remain runtime-managed rather than claimed equivalent to Codex's setting.
Harness capability inspection reports this distinction. Host scoped context tools
remain bounded for both. SDK compaction never substitutes for FlyBot evidence,
summary provenance, handoff receipts or current authorization.

## Acceptance boundary

Tests cover large history, required-rule failure, scoped pages, Task-role/Chief topic
summaries, fact updates/archive/version retention, handoff commit failure, active-role
experience, safe context reads, native input fences and SDK argument propagation.
Controlled SDK processes and deterministic DSH tests are not a new real-provider
long-task acceptance. Real-model verification is recorded separately by source hash.
Native Task-role physical Session restoration remains #2184; new process identity is
not called restored context merely because it shares a logical Task id. SQLite/delta
storage and archive normalization remain #2182; bounded model injection does not mean
the existing historical JSON store is already normalized or migrated.
