# Consolidated functional delivery and complete gap checklist

Related: #1 #4 #5 #6 #7 #8 #9 #10 #11 #12 #14 #86 #87 #88 #89 #90 #91 #130 #157.

This broad functional PR combines chat, search, discovery, media and profile persistence. It is
**not all-feature completion or Teamily + Impeccable acceptance**. The matrix retains every capability
area from the 2026-11-19 parity audit; external dependencies are not scope exclusions. A distinct UI
repair PR follows functional review; controls here use existing components/native controls, not a redesign.

## Implemented in this PR, end to end

- [x] Durable per-user human/social conversation unread counts, actual session badges, snapshot-bounded
  read acknowledgement. Own messages do not increment unread; retracted bodies are excluded.
- [x] Private social conversation pins and real loaded-list filters: all, groups, DMs, unread, read, pinned.
- [x] Author-only human message edit/retract with revision conflicts, inline editing, confirm retraction,
  erased searchable body and honest tombstones. Existing explicit group-agent reply protocol retained.
- [x] Social message image/audio/video upload → workspace-library artifact → message reference → authorized
  download, same-workspace validation and normal idempotency. Workspace visibility is explicitly warned.
- [x] Independent in-conversation search panel with real scope and cursor paging, separate from sidebar.
- [x] Authorized file/HTTP(S)-link resource search with sidebar tabs and paging. No server URL fetching.
- [x] Discover real type filters combined with search/cursors: website, image, audio, video, slides and API
  support for document, whiteboard, dashboard/media. Unsupported classifications are not fake filters.
- [x] Real idempotent like/unlike, collect/uncollect, author follow/unfollow; real counts and private flags.
- [x] Real following and collected-work feeds; private tab scope combines with search/types/pagination;
  unlisting hides the work from every feed. Self-follow is rejected; anonymous users see no private state.
- [x] Explicitly listed image/audio/video public view and byte download, native player, restrictive CSP,
  MIME sniffing and per-request revocation checks. Publishing warning states public media visibility.
- [x] Private three-section memory profile GET/save/reload per workspace and user, optimistic revisions.
  No invented generated text or silent injection into model prompts.
- [x] Search in-flight race regression and stale Discover-tab response protection.

## Complete remaining-domain matrix (not silently dropped)

| Domain / audit gap | Already usable / this delivery | Still pending; dependency or boundary |
|---|---|---|
| Chat #4 #86 | Human/agent/group messaging; this PR adds social unread, pins/filters, edit/retract, media | Reactions and the @mention center are usable. Round 3 adds user-agent conversation unread counts (acknowledged on open), group agent task-completion notifications in the same center (30 s polling while visible), message-level pin (limit 20, retraction-aware), multi-select forwarding (1–20, both-membership, idempotent, source author only). Still pending: server push/live delivery (polling only); translation and ask-AI (need a real vendor route, not faked); link-preview settings behavior; richer toolbar/agent attachment context |
| Access/collaboration #5 | Workspace membership and invitation-link APIs exist | Invite approval/freeze, in-chat invite links (with optional approval) and member suspension (owner any, admin members only, enforced centrally on workspace/conversation access and invite accept) are implemented. Still pending: comparison evidence |
| Agents/public conversation #6 #192 | Stored public starters can launch an authenticated member conversation (#206) | Anonymous typed public chat, external channels and full public composer; no unrequested model call |
| Teams/groups #7 #89 | Stored groups and explicit selected-agent runtime requests | Three self-written AI-team templates; round 3 adds an owner-listed public team directory with name/summary search, signed-in only, joining through the approval queue (uncompared functional flow). Still pending: a public AI-team (agent bundle) directory, complete collaboration execution; no import of competing #126/#131 protocol |
| Memory #8 #179 | Pages/actions/graph; private profile editing here | Dreaming/generated profiles, explicit prompt integration and comparison acceptance |
| Works/Studio #9 #90 | Existing supported artifacts; opt-in public works (#209); media content here | Remaining richer Studio workflows and same-state comparison, not a completeness claim from rendering |
| Meetings #9 #12 #157 | Manual meeting records with transcript/summary/action fields and Markdown export are stored through the existing meetings API | Live capture/consent, automatic transcription, summaries and action extraction; transport/runtime/storage design and tests first; live external service use/recording needs permission |
| Discover/profile #87 #12 #130 | Real public works, type/search/paging, likes/collections/follows here | Recommendations/ranking/comments, social profile avatar/posts/follower views, public agent-directory chat; no fabricated totals or recommendation data |
| Search #88 | Authorized messages, independent panel and media/link resources here | Arbitrary document extraction/indexing and broader attachment content; only supported data is searchable |
| Connectors/channels/MCP #10 | Composio account authorization/status/disconnect through each user's own key (fake-transport verified only); a read-only `/skills` catalogue lists ten self-written capability descriptions whose install choice is stored per account (`/v1/skills/installed`, `skill_installs` table) and survives reload (execution is still not connected) | Provider OAuth app registration/token lifecycle, actual account connection, real skill installation/execution and MCP scopes/audit; engineering is still needed. Connecting external accounts requires explicit permission, never credential discovery |
| Agent API/runtime #11 #2 | Existing management/runtime claim/model-access/result contracts | Round 3 adds an external gateway: per-agent invoke-scope keys (hash-only storage, shown once, revocable, 1–60/min fixed window, creator must stay owner/admin), Bearer-only `/v1/gateway/` invocation + status polling through the owner's runtime, idempotent, fixed error codes. Still pending: streaming, per-call audit UI, broader scopes; no production deployment permission |
| Onboarding/personal agent #130 #157 | Step 1 work context, stored assistants; the saved Personal Agent look now renders as an original CSS avatar in onboarding, `/agents` and `/chat` for its owner | Round 3 adds steps 2–4 as a functional flow not compared with Teamily: captured app list shown as not connected, picks of self-written suggestions stored (no automation created). Still pending: real app connection (OAuth), turning picks into routines, generated avatar images, layout comparison |
| Scheduling/automation #6 #91 | Existing schedules/edit/run history, readable schedule #211 | Recorded real scheduler → container/vendor/browser E2E; fake provider tests are not acceptance |
| Real-time voice/video/camera #12 #157 | Unconnected controls remain honestly marked | Runtime/media contracts, capture consent, WebRTC lifecycle, TURN/STUN/security, voice input and tests; actual external transport/recording needs permission, not excluded |
| Real vendor inference #91 #2 #11 | Fake provider/runtime protocol tests only | Safe owner-provided sandbox/provider configuration plus explicit permission, then actual recorded container/browser E2E; no discovery/use of credentials or production deployment |
| Settings/help/legal #4 #12 #128 | Existing settings persistence and Guide | Behavioral validation of saved toggles, help/legal pages with owner-supplied original text; never copy proprietary legal copy |
| Signed-in home #1 #14 | New `/` welcome page: Personal Agent look and conversation entry, real workspace totals, quick actions, recent conversations/works/meetings, onboarding and unread banners, workspace picker; read-only `overview` endpoint with no new table | No Teamily home comparison, generated recommendations, live push or home composer; not Impeccable acceptance |
| Full UI acceptance #14 | Existing read-only evidence available; no redesign in this PR | One comprehensive separate UI repair PR, followed by Teamily + Impeccable evaluation; no entire page currently accepted |

## Tests, privacy and migration

Additive SQLite tables retain `user_version=1`; no destructive migration or dependencies. Authenticated
writes retain exact Origin + session + CSRF; resource reads retain workspace/conversation membership.
Revision checks serialize within existing immediate transactions. UI uses `textContent` for user data.
Media uses existing sniff/size/path/digest checks; only explicit Discover publication exposes bytes.
No secrets/proprietary assets, vendor modifications, OAuth, inference calls or deployments are added.

Tests include temporary-DB permission/CSRF/revision/idempotency cases, media upload/download/revoke,
private profile/engagement isolation, mounted browser-controller actions and CI synthetic browser
profile persistence/Discover interactions. Test and CI evidence must be read at the exact PR head.
All umbrella/unaccepted issues remain open. CI is not vendor or visual parity acceptance.

Explicit exclusions remain credits/points/cash/rewards/usage/plans/upgrades, proprietary Teamily
assets/text/prompts, Teamily-hosted computer services and native clients. Project/Timeline is not a
substitute for core product scope. OAuth, A/V, social features and real inference are NOT excluded.

## Functional pass 6: current inventory and blockers (2026-11-19)

Supersedes stale implementation descriptions above; historical checkboxes do not
mean full acceptance. Related #1 #4 #8 #9 #10 #12 #14 #86 #90 #157 #231 #243 #264.

**Delivered here:** explicit social-text → versioned workspace document save with
sharing disclosure, membership/CSRF/revision checks and source idempotency;
private persisted library favorites and a real 收藏 filter; WYSIWYG new/existing
markdown documents with source mode and existing save/version/export contracts;
search-hit navigation, missing-window/empty states and scroll restoration; floating
message controls; group-agent removal confirmation; stale-workspace response repair;
semantic document thumbnails; removal of fake skill-install success.

| Domain | Usable today / this pass | Remaining functional gaps and blockers |
|---|---|---|
| Chat, DMs, groups | Persistent text, unread/pins, edit/retract, reactions, forwarding, uploads, explicit agent requests; text save and search navigation here | Server push (polling only); translate/ask-AI requires a real approved vendor route; agent-DM attachments; personal-only delete semantics; richer attachment search; reference operation acceptance. |
| Group collaboration | Existing membership/invites/approval and selected-agent reply protocol; removal confirmation here | Announcements, mute policy, auto-translation, proactive agent policy, multi-agent execution and full agent-bundle directory; no alternative group protocol imported. |
| Works / Studio | Documents/websites/boards/slides/dashboards/media, versions/export/shares; rich docs, private bookmarks and safe semantic thumbnails here | Full spreadsheet/image/table editors, live collaboration, arbitrary website execution, rendered screenshot thumbnails, non-media “send to chat”, generated image/video/music/3D flows. |
| Search | Authorized messages/resources with cursors; loaded-message jumps and explicit out-of-window status here | Automatic paging to old hit windows, document extraction/indexing, mixed attachment results/preview thumbnails and full same-state acceptance. |
| Memory | Pages, graph, actions, profiles/preferences and markdown-backed rich editor | Dreaming/generated profiles, safe explicit prompt integration, full rich-markdown subset and cross-surface parity. |
| Skills | Searchable self-written catalogue; private skill-secret management already exists | Install/uninstall API, signed/versioned skill files, permission grants, runtime loading/execution/audit. No fake “installed” state. |
| Connectors / runtime | Per-user Composio key and real authorization lifecycle code already merged, fake-transport tested | The **separate workstream** #267 is now included through an ordinary main merge: private management infer tasks have an owner-approved one-shot tool broker (synthetic tests only). Real project acceptance still needs an owner-provided key/authorization; group/automation/gateway personal tools, standalone DSH sessions, unsupported toolkits, broader MCP audit and channels remain open. No platform-default Composio key. |
| Meetings / media | Manual meeting CRUD, transcript/summary/action fields and existing media storage | Consent-aware live capture, external meeting transport, automatic transcription/summarization/extraction and voice/video/camera lifecycle. No fabricated generated result. |
| Agents / public | CRUD, owner profile, self-written templates, public starters, gateway runtime protocol | Anonymous public chat, complete external-channel composer, real runtime/provider acceptance, streaming and audit UI. Provider credentials/deployment are not discovered or used here. |
| Discover / social profile | Public opt-in works, types/search, real likes/collections/follows | Ranking/recommendations/comments, profile posts/avatar upload/follower feeds and full AI-team bundle directory. No invented counts or feed content. |
| Automation / onboarding | Persistent schedules/runs, work context and stored suggested-task selections | Actual scheduler-container-vendor-browser E2E, selections → routines, generated avatars. Separate contributor changes are not silently replaced. |
| Settings / help / legal | Existing persisted settings and original Guide content | Some toggles store preferences without behavior; honest disabled/未接通 states remain. Original owner-approved legal/help content and wider behavior tests needed; proprietary copy is not a substitute. |
| Visual acceptance | Existing private captures compared; targeted desktop/narrow after-renders and Impeccable scan | No page is fully accepted; exact operation evidence listed in PAGE_PARITY is still needed. CI only proves synthetic contracts. |

The overall tracking issues stay open. Credits/points/plans/rewards and copying
proprietary assets remain excluded by the owner; integrations, social capability,
real inference and live media are tracked gaps, not silently excluded scope.

## Visible-functions aggregate: skills-first correction (2026-11-19)

The earlier skill “catalogue only / disabled” descriptions above are historical and superseded **only for the instruction-skill lifecycle now implemented**. The complete current route/control execution checklist and every unmet category are in [VISIBLE_FUNCTIONS_INVENTORY](VISIBLE_FUNCTIONS_INVENTORY.md) and the generated [source census](inventory/visible-controls.json). Neither is a blanket acceptance claim.

Actual additions:
- Ten original content/version/digest packages; account and per-agent SQLite bindings; explicit model-context permission; real Python/zipapp and container loading into actual model requests; compatibility handshake; verified loading acknowledgement; reload/restart persistence; scoped isolation; uninstall/revocation/cancellation. See [SKILLS](SKILLS.md) for the exact boundary. No archive extraction, installation scripts, arbitrary paths or fake installed booleans.
- On-demand private translation and ask-AI dispatch actual tasks through the requesting user's configured model or platform fallback and their own online runtime. Source revision, membership, CSRF, replay and errors are enforced; history persists; no automatic group message or connected-tools grant.
- Revisioned group announcement read/edit/unpublish with owner/admin membership and conflict handling.
- All six saved work kinds can be sent as actual authorized, revision-pinned chat exports; forwarding retains the same version. Stable replay does not duplicate a send after an intervening document edit. No public share is created by chat sending.
- Composer document/memory picker reads real workspace content and inserts it for review; emoji insertion does not send; skills/connectors navigate to their real management flows.
- Saved folding/document-card/link-preview preferences now affect rendering without changing original text. Link-address cards do not fetch external metadata. New active #320 owns chat-language prompt behavior; this aggregate does not duplicate it.

These do **not** complete all visible functionality. Automatic translation, complete locale/privacy/reminder consumers, delete/mute/voice/video/meeting/proactive/mode controls, agent binary attachments, advanced exports/collaboration/generation, push/delivery, executable/third-party/standalone-DSH/delegated skills, group/schedule tools and the explicitly listed contributor dependencies remain open. Real vendor/account validation still needs user-supplied configuration and is not replaced by synthetic tests. Credits remain excluded by owner instruction. #1/#14 and unverified tracking issues remain open.


### Consolidated skills/runtime closure follow-up

Real readiness/capability diagnosis, explicit isolated skill runs with durable proof and cancellation, result-to-document/editor navigation, and exclusively owned automation-scoped skill loading now extend #334. Fixes include ordinary-member account material loading and task-local cancellation races terminating both runtimes. Installed/advertised/acknowledged/succeeded/verified remain distinct states. External package/DSH/delegated integrations and other visible-function gaps remain engineering work, not universally blamed on credentials. Actual vendor/model quality and operator deployments still need configured services; controlled fixtures do not accept those scenarios. Complete controls and limits remain in VISIBLE_FUNCTIONS_INVENTORY.md.


The first342 screenshot acceptance identified a real saved-editor HTTP400. The follow-up adds the exact HTML ID-pair allowlist and raw HTTP/authentication/workspace-isolation regressions; it does not weaken record authorization or merely wait longer. Enabled run-button normal/hover states are explicitly opaque and have computed light/dark CI contrast checks. Node22's dismissal failure is covered by a deterministic timer-order reproduction and source-hash-guarded test-helper overlay (vendor bytes and assertions unchanged); management cancellation is confirmed by the five-minute job-deadline annotation, with every full-suite case retained in a bounded10m budget. Exact-head CI and actual editor/uninstall screenshots remain required. The complete owner-expanded continuation matrix, including all six gap categories and contributor/infrastructure boundaries, is [FUNCTIONAL_COMPLETION_PLAN.md](FUNCTIONAL_COMPLETION_PLAN.md).


#### Cross-realm completion correction
The intermediate314a582 head passed all screenshot/management/build checks, including actual rich-editor opening, reload-persistent uninstall and all four enabled button contrasts (5.55:1 normal,6.69:1 hover), but its host-microtask clock overlay was insufficient for the component's **separate VM Promise realm**. Both Node22/24 still observed dismissal0. This is not treated as flakiness or rerun permission. The corrected owned fixture observes the actual `dismiss` or `reportError` callback and awaits that completion; unresolved sends cannot become completed, and no number of microtasks or milliseconds is assumed. Tests execute the real pinned async-send code in a VM, reproduce BOTH old helper failures and cover delayed/normal/error/pending sends. All original assertion bytes and vendor source remain intact; only test-bench completion/wait wiring changes. Exact-head first-run CI remains mandatory; no old job/head is rerun.
