# Connected app tools in DS-Bot

Related #10, #6, #11. Status: implemented, with **synthetic/mock** tests only.
No real Composio key, real model or live provider mutation has been used to
verify this. CI passing is not Teamily parity or real-vendor verification.

Connected app tools run in the user's own DS-Bot. The FlyBot connectors feature exposes the native `ot-apps` capability and handles the owner's one-time approvals. See [the native tool server](../runtime/flybot-workspace-web/features/connectors/tool-server.js).

## Historical management task protocol

The following describes the retired polling architecture and its approval protocol.

1. Dispatch records the private conversation's initiating user. Only a runtime
   owned by that same user receives a connected-tools grant. An explicitly
   submitted `/v1/runtime/tasks` infer task without a workspace also qualifies.
2. On a claimed infer task, the model-access response indicates whether this
   task has a personal key/grant. No Composio key is sent to the runtime.
3. Runtime discovery asks management for tool schemas; management checks the
   task, ownership, deadline, membership and key, verifies each connected account
   is still ACTIVE at Composio, then retrieves featured tool schemas.
4. The model may propose a **discovered** tool and JSON arguments. The server
   captures an immutable proposal with a stable model call ID. It does not yet
   execute anything.
5. In another tab, the user opens **设置 › 应用连接器**. The new confirmation area
   shows the task prompt, exact toolkit/account ID, tool name and full JSON
   arguments. **Every call, including reads, needs an explicit one-shot owner
   approval.** Refusing, closing the page, model output, provider output and
   runtime credentials are not approval. CSRF/session authentication is required.
6. The agent polls (and heartbeats) for up to 40 seconds, within the task deadline.
   Once approved, management rechecks task/key/account state and calls Composio
   exactly once. The result feeds the next model round and ultimately the chat
   reply. At most 5 model rounds / 8 proposed calls per task are accepted.

Keep the settings tab visible while confirming; polling pauses on a hidden tab.
The current default task lifetime is 60 seconds, including discovery, model
calls and approval. Slow sign-off may expire the task. A human can start a new
request after checking the previous outcome, but nothing automatically retries
an execution.

## API and upstream choice

We use the supported REST v3.1 direct tools API, not an unrestricted MCP URL or
proxy, so management can enforce ownership and exact per-call approvals before
outbound execution. Discovery pins the **returned tool version**, not a floating
version, for each task grant:

- [GET /tools](https://docs.composio.dev/reference/api-reference/tools/getTools):
  `toolkit_slug`, `important=true` (or `query` on explicit discovery search),
  `limit=20`, `toolkit_versions=latest`. Only matching toolkit schemas are kept;
  `COMPOSIO_*` meta-tools, foreign/deprecated tools and oversized schemas are
  dropped. No provider logos are returned.
- [POST /tools/execute/{tool_slug}](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteByToolSlug):
  server-derived `user_id`, stored `connected_account_id`, the discovered exact
  `version`, and approved `arguments`. No `instant_account`, custom auth,
  model-selected credential identity, proxy target or fallback key is accepted.

Management APIs, bearer-only runtime authentication (no browser cookies):

| POST path | Body | Result |
| --- | --- | --- |
| `/v1/agent/tasks/{task}/tools` | `{}` or `{search}` | task-scoped schemas |
| `/v1/agent/tasks/{task}/tools/calls` | `{call_id,name,arguments}` | pending immutable call |
| `/v1/agent/tasks/{task}/tools/calls/{call}` | `{}` | poll; consume one approval and run if approved |

Owner APIs, signed-in session + CSRF on POST:

- `GET /v1/composio/approvals`: own recent proposals and outcomes only.
- `POST /v1/composio/approvals/{call}` with `{decision: "approve" | "deny"}`.

SQLite stores per-task owners, schema/connection/key-generation bindings, and
proposal/outcome records. It never persists plaintext Composio keys in these
records. The existing private wrapped key remains on the management server.
Use a project key that can read tools, execute tools, read connected accounts,
and create Connect Links (and delete accounts for disconnect). Refer to the
Composio scoped-project-key permissions for the current permission labels; the
existing project full-access key covers these operations.

## Revocation, timeouts and safety

- All broker requests authenticate an unrevoked runtime key and verify a live
  claimed task on that runtime. Owner decisions cannot approve another user's
  proposal. Workspace membership is rechecked before tool execution.
- Disconnect / key removal / key replacement invalidates old connection or
  generation bindings. Composio account status is checked again before execution.
  Remote revocation blocks the call even if the local badge was stale.
- An approval is atomically consumed to `executing` **before** external I/O.
  Concurrent or repeated requests cannot execute that proposal twice. Approval
  cannot be changed to approve after denial. A reused call ID with new arguments
  is rejected.
- If an upstream timeout/failure leaves the provider outcome uncertain, it is
  shown as `unknown`. No automatic retries. If the process dies after starting
  the call, it remains `executing`; the UI warns to check the provider before a
  new request. Disconnect cannot undo a request already accepted upstream.
- Composio HTTP has a finite timeout and 2 MiB response cap; redirects are refused
  so the key cannot be forwarded to another host. Proposed arguments and tool
  schemas/results are bounded. Our key and common credential fields are redacted
  from tool outputs. Arbitrary provider data may still be sensitive: it is passed
  only to the same user's runtime/model, not public feeds.
- Task/tool grants are **not** general shell, plugin or MCP execution permission.
  Per-call approvals are stricter than automatic read execution, and do not
  weaken any upstream DSH tool guard. Tool/provider descriptions and responses
  are data, not authorization. No changes to the #124 group reply protocol.

## Deliberate limits and remaining functional inventory

Checked against open [#10](https://github.com/openTeamily/openTeamily/issues/10),
current runtime code and the linked docs on 2026-11-19. These stay open/unverified:

| Flow | Current state / exact remaining gap |
| --- | --- |
| Per-user app key, Connect Link, account status/disconnect | Implemented in #258; still not tested against a real Composio project. |
| Private management chat → connected tools → model result | Implemented here in Python daemon/zipapp + container task loop, synthetic tests only. Runtime image must be rebuilt from this code; existing running images are not auto-upgraded. |
| Full catalogue discovery / choosing multiple accounts | Bounded featured discovery: first 4 ACTIVE accounts, 20 tools each, one account per tool name. Explicit broker search is available; dynamic in-model search, pagination and account picker remain. No claim of all app tools. |
| Group, automation, gateway and shared runtime personal tools | **Not granted.** Existing tasks can select a runtime owner different from the requester. A member/tenant consent model is still required; silently using the owner/admin key would violate isolation. |
| Standalone DSH sessions | Not wired to this broker; only management infer tasks use it. No blanket Composio MCP credential is injected. |
| Custom auth-config apps | PayPal/Vercel/Neon/Webflow/Wix UI path remains disabled; auth-config selection/setup not implemented. |
| No Composio toolkit / channel rows | Still 未接通, as in COMPOSIO.md. No Slack/WhatsApp/etc channel messaging is added by a tool connection. |
| Callback identity verification | Project-specific `complete_auth` flow remains pending. Current callback only navigates; it never accepts query strings as proof. |
| Skill library #261 | Disabled and labelled 未接通 by functional pass 6, **not a real install**. The vendored DSH has runtime filesystem/connector skill facilities, but management has no authenticated versioned package registry, per-user/agent binding, audited artifact/digest transport, permission review or install-result acknowledgement. Persisting an `installed=true` bit would fake installation. Not implemented here; no upstream files or arbitrary scripts are copied/executed. |
| Skill secrets | Private storage exists, but does not by itself install or execute a skill. |
| Long-running approvals, execution audit retention | Approval state is durable/bounded per task; resumable model sessions across task expiry and configurable retention/export still needed. |
| Translation / ask-AI / live inference | Real provider configuration and verification still required; this PR does not claim a vendor passed. |
| Server push, A/V, meetings, broad MCP/OAuth parity | Polling only; no unrelated live A/V/network work attempted in this connector PR. |

## Tests (synthetic, no live third-party mutations)

`python3 -m unittest tests.test_composio tests.test_connected_tools -v`
validates missing key, no admin fallback, per-user key/record separation,
CSRF/owner decisions, undiscovered/meta/foreign tools, pinned account/version,
per-call denial/expiry/cancellation, disconnect/key rotation/removal, revoked
runtime key, foreign Composio owner, ambiguous timeout without retry and
concurrent one-shot execution. The in-process management + Python fake-model
roundtrip demonstrates schema → proposal → synthetic owner approval → synthetic
Composio output → next model message. All credentials/data are test fixtures.

`node --test tests/agent_loop.test.mjs` covers container fake-model tool rounds,
request identity/call IDs, pending decisions, denial/unknown without retries and
hallucinated tool rejection. Full Python/Node suites are also required by CI.


## Group, scheduled and standalone DSH principals

Related #10, #6, #11. The private conversation path above is unchanged.

These scopes can use the same discovery/approval/execute broker only when an
**explicit same-user principal** is attached:

- Group agent replies (#124 protocol unchanged): if the requesting member's own
  runtime runs the infer task, that member's Composio tools are attached. A
  request that lands on another member's runtime does not inherit anyone else's
  key. Leaving the conversation fails closed.
- Scheduled automations: `GET`/`POST /v1/workspaces/{id}/automations/{id}/connected-tools`
  stores a per-user opt-in (`{enabled, revision}`). A tick attaches tools only
  when the selected runtime belongs to that same opted-in user. Skill bindings
  never create a Composio grant.
- Standalone or workspace-submitted infer tasks: pass `"connected_tools": true`
  on `POST /v1/runtime/tasks`, or `POST /v1/runtime/tasks/{id}/connected-tools`
  with `{action:"attach","scope":"dsh"}` from the signed-in session. The runtime
  bearer and Agent API gateway cannot mint this principal. `{action:"revoke"}`
  disables it. Workspace tasks without the flag still have no tools.

There is still no administrator Composio fallback. Every call still needs the
principal user's one-shot approval. Synthetic tests are not real-vendor
acceptance.

## Native DS-Bot and custom MCP

The image's in-plugin bridge now sends infer tasks to DS-Bot, rather than doing
its own model/tool rounds. Both Composio and user-configured MCP tools are
attached as the native `ot-tools` MCP capability. Settings → App connectors
supports up to four custom remote Streamable HTTP servers per user via
`GET/POST /v1/mcp/servers` and `DELETE /v1/mcp/servers/{id}`. Optional bearer
credentials and full URLs are wrapped at rest with `custom-mcp.wrap`; no
credentials or upstream URLs enter DS-Bot configuration. Public HTTPS:443 only,
no query/userinfo, no local commands, no redirects, no proxies. DNS results are
checked for non-public/special addresses and the request pins an approved IP
while verifying TLS against the original hostname. Model HTTP grants do not
apply to MCP. Responses, tool counts and call counts are bounded.

Tools use immutable task discovery grants; every call, including reads, uses
the existing one-shot owner approval UI. Changing/removing a server invalidates
outstanding grants. Credentials/ownership/task/runtime access are rechecked
before execution. An executing/ambiguous call is never automatically retried.
Only that user's authorized personal/tool-granted tasks can use these servers.

CI uses an explicitly labeled in-process MCP fixture to demonstrate native
DS-Bot tool visibility. This is NOT real Composio or real MCP-vendor acceptance.
