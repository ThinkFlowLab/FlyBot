# Functional completion batch: space actions, member DMs, home deep links, dark theme

Base: confirm live green main at branch creation (6bee24ca after #374+#125). `feat/functional-ui-completion` does not take contested `chat/*`, `settings_page.py`, or Deployment HTTP policy. `/messenger` remains a redirect to `/chat` because the page router is in-flight on contributor Discover PRs; this batch therefore does not advertise an independent-session entry that would bounce.

| Gap/control | Implementation and state | Automated proof | Acceptance still required |
|---|---|---|---|
| 让智能体搭建网站 / 保存聊天中的消息 | Empty CTAs and 新建 menu now create a real website artifact, open/create a same-workspace agent conversation, POST the brief, or save an existing completed social/agent message through current APIs. Honest copy if no agent, no runtime (`no_agent`), or no saveable message. `#artifact-notify` stays disabled with 未实现. | space_actions Node; test_artifacts_page entry/script; existing artifact/social save APIs unchanged | Controlled-model dispatch only; does not itself finish a built site; no vendor/Teamily acceptance |
| Members 发消息 | Other members get a working button that reuses existing DM create (idempotent/existing DM) and opens `/chat#workspace=&social=`. No self-message control. | members_page Node (create, Idempotency-Key, assign, error); test_members_page script | Browser/mobile on a deployed revision; does not add chat three-column or group-agent flows |
| Home recent artifacts | Rows deep-link `/space?workspace=&artifact=`; catalog shortcuts gain the workspace query. Action grid wraps with auto-fit instead of a fixed 7-column squash. | home_page Node; test_home script | Visual density on phone still needs screenshots after CI |
| Dark theme palette | shell dark theme keeps the green tokens already defined first; the later purple/cyan overwrite, glow, and low-contrast muted values are removed. | shell_page contrast plus explicit no `#8b7cff`/`#2ee6e9` assertion | Visual check in light and dark, desktop and mobile |
| Independent /messenger three-column | Static assets were prepared (list/thread/detail, hash, pane switch) but `/messenger` still 302s to `/chat`. Not counted as a usable entry. | Existing messenger redirect tests unchanged | Requires an uncontested router change later |

Remaining still not in this PR: auto-translate #320, notification consumers #284, old-message search load #271/#352/#354, social SSE auto-apply, likes/favorites visibility, semantic memory, team DAG, AV rooms, HTTP exact endpoint (Deployment branch), #197/#126/#131 as-is, #124 reply protocol. Controlled models are not vendor acceptance.

# Owned functional completion aggregate

Base: ef71b3d1, after merged342; ordinary-synced main54222f7 including contributors332,348,363 and340. Local branch: feat/functional-completion-big. Not a claim of Teamily parity or all controls complete.

| Gap/control | Implementation and state | Automated proof | Acceptance still required |
|---|---|---|---|
| Registration entry, policy, create, session, first-use | `/register` + links + GET auth policy; unchanged operator opt-in; actual session verification; first-home initialization ordering and 201 handling | test_registration_page (new account/settings/personal agent/actual controlled inference/restart/tenant isolation); registration_page Node; added real CI form/home/agent scenes | CI captures pending; Deployment owns actual HTTPS/Host/policy validation, not this worktree |
| Import private instruction / install / use / upgrade / revoke / history | imported_skill_versions/heads + existing scoped bindings/task material; v2 capability handshake in Python and container; immutable versions/digest/CAS/explicit consent; no file or shell hooks | test_imported_skills + existing skills/runtime suites, skill_imports Node, CI import/run/update/revoke scenes | Current own v2 runtime and configured model; real quality unverified; executable/signed remote registry/shared DSH absent |
| Live chat/notification/sidebar invalidation | authenticated SSE /workspaces/id/events, constant-memory fingerprints; 250ms query budget, 2s heartbeat/check, bounded20s connection, 2 streams/user/32 process, no write lock during waits | streamed WSGI tests, real persisted update/reconnect/session/member revoke/nonmember silence; JS connection epochs/visibility/fallback | Proxy must not buffer; current social-message refresh is explicit banner, private inference remains polling; not durable event replay/token streaming/webpush |
| Document version awareness / explicit latest read | real persisted revision invalidation; draft preserved; confirmed load; existing CAS writes unchanged | WSGI/JS plus added real CI revision-change/draft-retention scene | No CRDT/merge/presence or collaborative editor claim |
| Word / PDF / spreadsheet downloads | actual DOCX OPC/XML, Unicode text-PDF, dashboard data XLSX; current and historical auth/version checks; no renderer execution, network fetch, macro or formula | test_office_exports validates ZIP/XML/relationships/formula safety/history/xref; local independent Poppler extraction; CI actual downloads added | Text PDF only BMP Unicode/CJK viewer-font substitution; DOCX retains text/headings, not full Markdown/Office; XLSX all strings; full Office/PPTX/media/thumbnail editing still engineering |

## Contributor ownership refreshed before coding and again before publication (49 open before this aggregate)
Do not edit other branches or count these as landed:352/271 old search hit loading;349 reminders;345 mute/notification;346 agent proactivity;320 chat-language prompt;284 preference/notification consumers;309/340 notification writers;335 Discover author;299 memory share;315 composer;277/326 image;322 edit;330/310 automation;273 meeting works;289 action save;313/290 team/template;281 invite;293 email auth;282 runtime key;316 archive restore;298 profile;302 guide;317 docs;325 avatar;280 follow URL;197 preference honesty;294 onboarding;237 checklist. 283 boolean-only remains superseded. No124 reply-protocol changes.

## Remaining complete scope
See FUNCTIONAL_COMPLETION_PLAN.md and VISIBLE_FUNCTIONS_INVENTORY.md for all six categories and source census. None is silently hidden or called credential-blocked wholesale. No operator/model/Composio credentials discovered or reused; Composio remains each user's own key; model platform default+user override retained. No production, user computer, :3320 or :3786 changes. No npm installation, external invitations/sends/payments, cloud sessions, proprietary assets, or upstream vendor byte edits. All current tests/captures are synthetic, not real-vendor or Teamily acceptance.

Latest refresh additionally protects363 memory history84d3f736f,362 self-delete45765a294,361 memory preferencesd139d5dde,356 memory dream24a7590e4,358 unread dividercafded7a0,354 attachment search913480e28. Updated28449de89563 and34967691d71a remain separate;348e838eec41 is now landed via ordinary main sync. Registration293410c6a45c covers email-code identity, not this same-origin form for the existing username/password endpoint.

## Public HTTP model policy: reviewed, not integrated or enabled
The independent operator-policy draft is not production-ready. Python's
`ipaddress.is_global` alone also returns true for multicast (`224.0.0.1`,
`239.255.255.250`, `ff02::1`); the draft accepts these and issues grants. Its
11 helper tests pass but do not exercise this case, private-file loading, either
credential issuance route, authenticated grant provenance, or actual redirect
credential isolation. Do not infer application approval from those tests.

This aggregate does not enable public HTTP model endpoints, read/import any
provider key, or broaden shared `insecure_http_allowed`. Existing HTTPS and
local/private rules remain unchanged. A future complete operator-only,
default-disabled implementation needs strict public unicast IP/port/path
validation, private bounded no-symlink loading, both issuance paths rechecking
current policy, Python/container runtime grant checks, and denial of every HTTP
redirect with integration tests. No hostname/wildcard/global insecure bypass is
acceptable. Deployment must independently confirm its own concrete endpoint
and key authorization; another agent's report is not that authorization.

Contributor332 personal message hiding is now landed in the synced base. The
SSE fingerprint respects the current user's deletion rows; another member's
snapshot is unchanged. Overlapping session loads now commit one current
workspace/user/request snapshot only, including the per-agent fanout phase.

Publication ownership refresh: 49 open contributor PRs, including364 download
platform guidance112243da70 and365 attendee-name completion2925622bf9. Updated
358 unread-divider2b36a42e41 and354 attachment-searchee761c6233 remain separate.
Contributor348 run-detail UI is now in the synced main base, not implemented
again or counted from its formerly open PR state.

## First real CI capture and substantive follow-up
PR369 first head3c3aa76 captured visible registration on390/471/1280 widths;
username/password widths and backgrounds match, both are44px tall, and mobile
and desktop forms actually created accounts/session/personal workspaces. That
is not end-to-end normal-use acceptance: the run failed six strict scenes.

The new-account normal-use scene exposed a real existing agent-create defect:
DOM dispatch clears event.currentTarget while its async handler awaits the POST;
retaining the form before awaiting repairs the post201 reset/directory readback.
A real initial-SSE/directory race could supersede the first session snapshot
before deep-link resolution; subscription now starts after that snapshot
commits, with a deferred-directory regression. Permanently CLOSED handshakes
receive at most three bounded recovery attempts without relaxing server limits;
stale timers/close cannot reconnect. The private-import capture now identifies
the unique form's details summary rather than two ambiguous summaries. Existing
assertions/timeouts remain; exact new-head capture results are still required.
The first head's document live/export scene and older conversation scenes also
failed, so their acceptance remains blocked until the follow-up proves them.

Second headf92e39d strict CI passed registration/session/normal-use/reload on
both new accounts, existing conversation history/send, actual imported-v2 model
execution, document draft-preserving SSE and real DOCX/PDF downloads. Its sole
remaining failure was the capture parsing the version editor before its async
management read had filled the textarea. The follow-up waits for the actual
completed editor status (no assertion/timeout relaxation), and keeps the mobile
new-account agent-use/reload scene at471px rather than switching it to desktop.
The independent desktop account still exercises1280px. Latest-head CI remains
the merge authority; production and real-provider acceptance are not claimed.

## Exact red upstream check and independently reproduced cleanup repair
Head6be221e produced119 screenshots /153 strict passing checks, including the
full471px mobile and independent1280px desktop registration/session/normal-use
flows, imported-v2 run/version upgrade/revoke and real live-document exports.
It was NOT merged: push Node22 job135712288221 / run44567134948 failed the
pinned restart test's after hook at rounds.test.js:1488 with ENOTEMPTY.
All test assertions had completed; the fixture registered rmSync before its
restarted runtime's asynchronous stop hook. Actual Node hook-order reproduction
and execution of the exact pinned cleanup fragments demonstrate that ordering.

The owned test-only loader now hash-pins that one complete source file and
orders the same awaited restarted disposer before the same rmSync/options.
Every assertion byte is unchanged; source round-trip, unrelated-module no-op,
delayed-stop ordering and propagation of both stop/removal failures are tested.
No vendor bytes, test assertions, cleanup retries, gate requirements or runtime
production code are changed. The existing annotation completion overlay remains
intact. CI adds the lifecycle overlay's tests to the existing façade job.
The old red job was not rerun. A meaningful new fix head must independently pass
the original dual-event14-check gate. A local attempt at the actual pinned
restart test stopped during module loading because @deepseek-ai/dsh-llm is not
installed here; no dependency installation/workaround was attempted. That
actual upstream execution is therefore still pending the normal CI runner.

## Ordinary sync after the green functional head
Headc671e98 automatic upstream push and PR workflows both passed the actual
pinned Node22/24 suites after the independently reproduced lifecycle repair.
Its latest push UI also passed119 images /153 checks. Before merge, the shared
gate correctly blocked because main advanced with contributors363 memory
history/restore and340 followed-public-work notifications, conflicting in the
generated inventory. Those landed changes are ordinarily merged, not rebased,
force-pushed, duplicated or edited on their branches. The census is regenerated
from the combined source. The newly synchronized head requires the original
full gate again; a previously green parent is not sufficient.


## Follow-on aggregate after merged #369 / #373 / #277
Base: b8eacb1f (latest green main at branch open). This is not a claim of Teamily
parity or of all remaining matrix rows. Contributor heads were refreshed before
coding; moving files owned by #320, #284, #271, #352, #354, #326, #273, #299,
#356, #361, #313, #290, #281 and #289 were not duplicated.

| Gap/control | Implementation and state | Automated proof | Acceptance still required |
|---|---|---|---|
| PPTX slide export | Actual PresentationML package from persisted slide title/bullets; no macros, media, animations or external relationships; current and historical version checks reuse the existing export auth/format allowlist | test_office_exports reads ZIP/XML/content types, Unicode titles/bullets, formula-like text, history isolation and rejects PPTX on documents / DOCX-XLSX on slides; CI browser scene downloads a real PPTX | Not a full Office editor or rendered thumbnail; viewer font coverage unverified |
| Group/scheduled/DSH Composio principals | Explicit same-user principals with provenance; group attach only when the requester's own runtime runs the #124 reply; scheduled tools require a per-user opt-in; standalone/workspace DSH requires `connected_tools: true` or a session attach; skill material cannot grant tools; no admin/member fallback | test_composio_principals plus existing personal connected-tools regressions | Real toolkit authorization, operator DSH deployment and any external write still need separate approval |
| Public HTTP model policy | Still not integrated or enabled. The independent draft accepted multicast grants; this aggregate does not import it, relax `insecure_http_allowed`, or read provider keys | n/a (held) | A complete default-disabled operator policy with unicast/path checks, no-symlink private loading, both issuance paths, runtime grants, and denied HTTP redirects remains future work |

Automatic translation, older-message search auto-load, SSE social auto-apply,
likes/favorites visibility consumers, semantic memory, team DAG and audio/video
rooms remain unstarted here because of in-flight ownership or missing safe
infrastructure. #197 preference-honesty notes were not spent as a separate
repair; unwired consumers are still documented rather than given fake results.
