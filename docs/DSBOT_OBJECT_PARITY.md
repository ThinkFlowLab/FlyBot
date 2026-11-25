# Object identity, not route-only migration

Each account routes exclusively to its attested runtime. The agents feature's
`native_agent_objects` table binds each stable 32-hex legacy agent ID to one
actual DS-Bot roster Bot ID. `agents/reconcile` idempotently creates missing
native objects, recovering interrupted creates from native Bot metadata. It does
not send messages or greetings. Both IDs are returned by create/get/list.

Native name/instruction/hidden edits are pulled on platform reads (with revision
bumps); platform writes call the native roster APIs. Native deletion produces a
visible archived/tombstoned mapping, never silent recreation. The compatibility
SQLite holds workspace, category, quick-start and legacy history metadata; it is
not another execution engine. Native names have a 40-character constraint; long
or colliding legacy names use a deterministic ID suffix without changing the
legacy ID/title.

`native_agent_sessions` maps each logical agent conversation key to a real native
Session. New agent turns run on that mapped Bot and Session, not on the Main Bot
with a persona prompt. List/create returns native session IDs for inspection.

## Historical sessions increment (acceptance pending)

Main Bot thread chains are adopted by their original bridge key, including the
pre-plugin plain agent-conversation ID. Chains move to the mapped Bot without
copying native logs. A newer mapped thread is retained; both chains are scanned
before missing messages are appended. Durable Bot sessionKeys recover interrupted
create/map commits; native_agent_events maps source messages after native flush.
Source IDs recover the flush/ledger crash window. Original timestamps remain in
source metadata; native append sequence stays append-only. Failed historical
messages remain diagnostics, not fabricated assistant replies.

c3f226 functional/model/isolation acceptance passed. dd647 consumed all retained
agent/automation bundles but failed conversation creation with a ReferenceError.
#523 fixes it; historical native-view/dedup acceptance is still pending.

Outstanding: explicit workspace selection and reverse mapping on native creation,
complete historical ordering/native-view acceptance, remaining user administration
and profile/onboarding central paths, real skill-run abort, and Teamily reference
inspection (unverified, not claimed). These are gaps, not completed capabilities.

## Shared group increment

Bot Social conversation reads now reconcile a real native roster room/Session,
with `flybot-workspace.conversation_id` pointing to the canonical shared conversation.
The group exposes native_room_id/native_session_id. Local agent participants use
mapped native Bot IDs; human participants remain remote humans, never fake Bots.
Native room-chat reads Bot Social directly, including edits/retractions/history
paging. Native text send/title/agent membership/announcement changes are routed
to that same shared record. Native delete leaves the shared conversation for the
current member and archives its local room; it does not delete other people's
history. Unsupported native-only settings fail visibly instead of diverging.

Native remote-human editor is merged for the next deployment; acceptance pending.

Remaining: reverse native
creation requires explicit workspace selection; initial reconciliation still
requires a conversation read; historical event import/adoption still needs native-view evidence. Do not label full feature parity accepted until test-account
native-view consistency evidence exists after deployment.


## Current closeout: personal execution identity correction (acceptance pending)

Private `chat/*` now delegates creation, listing, messages and actual model execution to
its existing, explicitly scoped workspace-agent/native Bot mapping. It no longer executes
through Main Bot. Existing Bot IDs are retained; the native Main Bot remains a separate
native assistant, not falsely relabelled as the platform agent. No duplicate Bot is created.

Owner-filtered agents bundles carry the authoritative `personal_agents` binding. During
import, retained `chat.sqlite3` conversations/messages are copied by their original IDs
into canonical agent history; originals are retained. Conflicting workspace/agent/message
ownership is rejected. Chat feature loads before agent import so acceptance cannot precede
this adoption. All owned legacy `agent:...`, plain conversation and `plugin:...` Main Bot
Session parts are adopted; existing mapped parts are retained and scanned too. Historical
`otp:` user request IDs are matched before text matching. No historical turn is replayed.
The schema adapter is installed before core restoration; append-only old logs are not rewritten.

Deployment and real-model/native-history proof are still pending for this correction.
Private chat rename/remove via the old plugin API are explicitly rejected rather than
silently altering retained legacy rows; full native part deletion parity is not implemented.
Previously documented unrelated migration gaps and Teamily interaction verification remain open.


### Native persistence format defect found during restart acceptance

The first history importer produced incomplete native v4 envelopes (missing identified
user/assistant messages, nested model source, turn/step boundaries, and ignorable
status-record grammar). Earlier runtime-only stream normalization was insufficient.
The import writer now emits the complete native schema. Historical provider/model were
not retained: metadata explicitly says `flybot-workspace-history` / `historical-unknown`,
with `imported:true`, no API invocation and no invented token usage.

A one-shot offline repair uses the published native strict format codec and JSONL
persistence provider, not ad-hoc binary edits. It rejects any affected suffix containing
unrecognized/unmarked events, surface replacements or sequence references. Original
compressed files and all source data are retained. A fsynced manifest records the exact
old/new event-sequence mapping before any replacement; the canonical message ledger is
remapped transactionally by message ID. Bot, Session, platform message IDs, content and
original timestamps are preserved. Native envelope events are inserted, explicitly marked
as imported transcript boundaries rather than newly executed model turns. Completion still
requires deployment, repair proof, restart, and test-account native/history acceptance.


### Bounded restoration follow-up (2026-11-20 Asia/Shanghai)

- Readiness: publish the native runtime handle only after bridge services exist; pending imports must not retain the early incomplete frozen handle.
- Native current-format validation also requires a protected system surface head. Source-marked imports made before the first actual native turn lacked that structural head. The narrowly scoped repair adds an **empty current initialization** (public `createSystemMessage('')`, lifecycle boundaries, no model call), not an inferred historical prompt, user message, assistant response, provider or usage. Every original message payload and original timestamp is retained, originals backed up byte-for-byte, typed native references and durable import mappings remapped. Strict published codec validation is required before replacement.
- New imports initialize the same empty native head before their first surface record. Actual execution replaces the empty head with its real scoped current prompt.
- Dedicated Social onboarding collision retries now send an explicit supported home handle whose suffix remains within the server's 20-character derived stem. Existing credentials/handles are untouched; HTTP 429 still terminates retry and no rate limit is relaxed or bypassed.
- Deployed **8ae31ec49ddce55c4ac487e7a30a364852e07731 / #538**, 2026-11-20 16:55–16:56 Asia/Shanghai, under `/srv/flybot-workspace/deploy.lock`, with fresh consistent DB/full-volume backups. No rollback, key rotation, owner rebind or state restore.
- Structural protected-head repair: 12 Sessions (older test 2, owner 1, canonical test 9), 43 existing ledger rows remapped. These are EMPTY present-time initialization records, not historical messages or inferred historical prompts; all original message payloads/timestamps remain exact. The prior #530 envelope repair and originals remain retained.
- Final strict published-codec validation (17:10 Asia/Shanghai): PASS on all 93 existing scoped native Sessions (51 older-test + 15 owner + 27 canonical-test). This is actual durable-format validation, not a softened reader.
- Functional test-account acceptance: **9/9 PASS** (Social connection, workspace creation, bidirectional native agent edits, shared group identity/edit, real agent model execution, skill save/bind/revoke, migrated overview/notifications/templates/members/announcement, isolation).
- Canonical test history: **35/35** source message mappings, repeat reconciliation identical, native chat renders existing events. Remote-human editor contract PASS only for self-membership/no-op; multi-human invitation/editing is not claimed.
- Retention verification against fresh backups: existing agent-message payloads 41/17/29 and legacy private-chat messages 38/0/0 unchanged across older-test/owner/canonical-test; all 39 preexisting mapped native Bot IDs, existing feature seal keys, existing personal/provision bindings and target runtime owners unchanged. Evidence: `data-retention-redacted.json`.
- **NOT COMPLETE:** one retained `d-personal-agents.bundle` remains on older test runtime `102cd697...`; owner `eb0e5e47...` and canonical test `48255cef...` have no pending bundles. Four legacy private conversation IDs already belong to agent `9fc97dde261f476ea5f07f24b4938630`, whereas the trusted current personal binding requests `908a96d0ac9e4bc78cfbbd6ea9607975`. The transaction correctly refuses reassignment. Original history and both existing objects remain unchanged/readable in their retained stores. Exact receipt: `retained-conflict-redacted.json`. Do not describe all history as imported.
- **Personal-chat actual-executor acceptance FAIL:** `social/team_not_found` blocks the call before model execution in the canonical test runtime's legacy personal workspace. The test account's two preserved runtimes have different Social homes; its old shared workspace remains owned by the earlier home. A separate optional-recall-off probe also failed (and restored the preference), so recall alone is NOT the root cause. Native-agent real model execution in a newly created test workspace passes, but this does not substitute for passing personal chat. No personal Main-Bot/native-Bot execution parity claim is made.
- Required ownership decision before further migration: which preserved test runtime/Social home is canonical, and should the four already-owned legacy private conversations remain with agent `9fc97...` or be explicitly reassigned/aliased to current personal agent `908a96...`? No guessing, key copying, destructive consolidation or forced receipt completion was performed.
- Evidence directory: `/srv/flybot-workspace/upgrades/8ae31ec49ddce55c4ac487e7a30a364852e07731/` (`acceptance-d-redacted.json`, `acceptance-personal-redacted.json`, `acceptance-personal-isolated-redacted.json`, `acceptance-history-redacted.json`, `native-final-*.out`, repair manifests/originals and backups). Overall history/personal acceptance remains FAIL despite the passed checks above.
- The bounded repair/check batch is stopped after this handoff. Teamily interaction parity, browser registration, real Composio, multi-user history/invitations, reverse native creation workspace mapping, native private rename/remove, and other previously listed administration/onboarding/provisioning/SSE gaps remain unverified or incomplete; no additional feature batch is started.
