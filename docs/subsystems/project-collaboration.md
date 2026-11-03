---
subsystem: project-collaboration
owned_paths:
  - core/src/host/project-rooms.js
  - core/src/client/workbench/conversation.js
  - dev/demo/collaboration-browser.mjs
---

# Project collaboration restoration (#40)

Project rooms are a FlyBot adapter over existing scoped Project agents, not raw DSH
rooms or a second Task engine. `projectRooms` stores durable Project identity,
participants, bounded messages and explicitly registered text documents. Every read,
post, document read and stop checks current Project membership and room participation.
Empty member routing means the whole current Project; a restricted room must include
its creator. Project ownership does not implicitly reveal another restricted room.
Rooms cannot select another human's private agent or carry its notes/transcript.

Each `(room, logical role)` has a distinct carrier Session. Human messages route through
the original `shared/mentions.js` parser (including code/link exclusions and @all).
Each target uses the current public role's persona/Skills/memory/model/Harness/resource
snapshot through existing delegated agent delivery. Ordinary room conversations are
read-only: they cannot publish Tasks, run code or claim independent Review. Code work
still enters the existing Task/pool/Attempt contract and is never reassigned by routing.
A busy participant reports its refusal in the room rather than silently dropping it.

Native public-text deltas use the existing documented `llm/stream` hook and a bounded
in-memory projection tied to the exact live delegation. Reasoning is excluded. Settled
native and SDK answers use the same scoped room transcript; SDK JSON action envelopes
are parsed by the host, never rendered as partial JSON. SDK partial-answer streaming is
not claimed. Tool activity exposes the current tool name, not raw arguments/results.
Logout, member removal and explicit stop fence late native/SDK callbacks. Polling is
reconnectable through durable messages; in-flight native text is process-local. The UI
fences both refreshes and action results after Project/route changes.

Documents are explicit text registrations, capped at 32,000 characters each and 100 per
room. There is no filesystem download or arbitrary URL proxy. A message must explicitly
select documents; its combined brief is capped before delivery. Document IDs cannot be
used across rooms or Projects. Binary upload/preview requires a separately bounded
storage adapter and remains unavailable rather than exposing host files.

## Capability inventory

| Capability | Existing source/loading | Shared-entry gap at base | Restoration / isolation |
| --- | --- | --- | --- |
| Rich chat | `client/cells.js`, `questions.js`, DSH `MarkdownText`; private Harness module loader | Standalone `workbench/app.js` rendered final plain paragraphs only; no DSH module loader | Bounded public text streaming, safe Markdown/code/list/link rendering, role identity and stop. The standalone renderer cannot import the shell-seeded React/Markdown modules; it uses DOM text nodes, never HTML or remote image loading. |
| Internal multi-Bot / @ / rooms | `groups.js`, `shared/mentions.js`, scoped `project-agents.js` | Only public Chief + own private agent exposed; global group APIs unsafe for shared members | Real room creation, member routing and all four role carriers; original mention parser reused. Native and SDK share host read models. No private histories forwarded. |
| Tree / routing | `plugins/tree`, `hooks.js` feature registration | Global plugin state denied by Project gateway | Public role topology and actual per-Bot pools use existing definitions and claims; room routing is independent of code dispatch. Global tree management remains operator-only rather than bypassing Project access. |
| Workflow / stage | `plugins/workflow`, `project-access.js`, delivery/pools | Workflow state available but fixed-role JSON obscured actual progress | Existing Project-filtered Workflow Runs, role snapshots, task phases and pools/Timeline shown. No new scheduler or forced DAG. Graph administration retains existing configure gate. |
| Questions / approvals / interruption | `questions.js`, task input service, `projectHarness.input`, scheduler stop | Task question and SDK controls existed but waiting/evidence cards used JSON | Existing question-id answer, generation-bound SDK input/permission and stop retained; scoped conversation stop added. An ordinary reply cannot approve a permission request. Raw DSH ask-user/approval channels remain denied. |
| Skills / memory / models | `project-agents.js`, `project-agent-skills.js`, runtime setup | Forms already existed; execution often showed IDs/JSON | Reuse current persona, Skills, memory and resource/Harness forms; show frozen role models and actual SDK model/version. Explicit verified-summary publication only; no automatic private memory sharing. |
| Schedules | `schedules.js`, `project-scheduled-tasks.js`, Chief control | Global schedule APIs denied; scoped Chief editor existed | Existing scoped cadence/prompt/pause/inspect controls retained; recent real runs join Timeline. No framework timer or implicit registration. |
| Timeline | `plugins/timeline`, Task collaboration history, Chief run history | Global timeline plugin unavailable to members | Project Timeline derives actual claim/handoff/return/completion-request/Chief records. No made-up stage times or duplicated history store. |
| Connectors / Social | `plugins/social`, explicit GitHub broker | Global connectors could cross human/Project credentials | Existing scoped GitHub reads/writes stay exact-credential checked. Cross-instance Social is deferred; ambient connectors, owner cookies and raw Session APIs stay unavailable. |

## Evidence and limits

`project-agents.test.js` covers actual service routing to three independent role carriers,
private member/Project/document boundaries, native stream fencing, SDK room contract and
read-only conversation effects. `project-access.test.js` checks authenticated HTTP dispatch;
`workbench-client.test.js` checks real DOM clicks, Markdown safety and route fencing.

`dev/demo/collaboration-browser.mjs` runs Chromium clicks through the actual gateway,
channel and service with Owner/Maintainer/Member, 390px viewport, refresh, documents and
cross-scope refusals. Its native/model transport is explicitly a deterministic fixture.
Run with `node --import ./core/test/harness-resolve.mjs dev/demo/collaboration-browser.mjs`;
`FLYBOT_BROWSER_TOOLS` selects a prepared Playwright package and `CHROME_BIN` can select
its browser. The current worker sandbox blocks loopback access, so that run
is blocked here, not passed. Operator deployed-service/browser/model acceptance remains
required by criterion 7; this candidate does not close the Task or issue.

Rework regression: the browser fixture authenticates the extracted session-token string,
matching channel.js. `--channel-only` checks Owner/Maintainer/Member plus invalid and
revoked tokens through the actual registered channel without sockets or Playwright.
It runs in `npm run test:demo`/verify and explicitly does not claim browser clicks.
The installation-order contract includes the Project native `llm/stream` observer.


The socket-free preflight now executes workbench-state, Project detail/resources/agents/members, scoped Workflow state, rooms and pools for Owner/Maintainer/Member. Fixture Bot creation calls runtime save, which owns Session indexing; no private index method is invented. This exercises lazy public/private role initialization before Chromium and does not replace browser assertions.

The visual rework adds desktop/narrow chat and board navigation checks to the existing
Chromium/backend fixture. `FLYBOT_SCREENSHOT_DIR` optionally captures desktop/narrow
Chief and board pages for comparison with the owner reference. These screenshots are
fixture evidence; real shared-service UI acceptance remains a separate operator step.
Role editing now lives at Settings, leaving the public conversation focused on chat.

Rework validation at inherited HEAD `f5eb916eb26171ae0cd21891e9c67370ac12d692`
with an unsealed working diff: `workbench-client.test.js` passes 9/9; the new
conversation-layout regression failed before implementation (7/8 passed). Workbench
build/check, original-client check, patch check/canonical, demo lint and focused client
lint pass (the existing terminal control-regex warning remains). Full `TZ=UTC npm run
verify` was attempted but has no completed result in this SDK sandbox; the independent
host command is required. A combined gateway/room test encountered blocked loopback.
Chromium execution failed at dependency loading (`playwright` absent), before clicks;
no screenshots or new browser acceptance are claimed. Tester should run the configured
host verification and the Chromium fixture with prepared `FLYBOT_BROWSER_TOOLS` and
`FLYBOT_SCREENSHOT_DIR`, then inspect desktop/narrow captures against the supplied
reference. Actual deployed three-account acceptance is still the operator's separate
step, followed by Chief judgement; this record does not close Task40.


#2171 rooms validate new participants against the committed Project role catalog, including approved custom roles. Retirement preserves room participants and messages for historical reads; new delivery to that role reports a retired-role error without moving its Task or Session.
