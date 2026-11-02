# LESSONS.md

Dated, short lessons from real FlyBot work. Agents read this **before coding**. Humans promote durable rules into [docs/code-standards.md](docs/code-standards.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## How to read and write

1. **Before a change:** skim every open lesson below. Treat them as hard constraints until promoted or retired.
2. **When something bites again:** add or bump a lesson the same day. Date it (`YYYY-MM-DD`). Keep the body to a few lines: trigger → wrong move → right move.
3. **Seen N×:** each recurrence increments `Seen`. First write-up is `Seen 1×`.
4. **Promote after ≥3 days:** if a lesson is still true and has been seen (or stayed relevant) for **at least three calendar days**, move the durable rule into `docs/code-standards.md` (and a one-line pointer in CONTRIBUTING if humans need it). Leave a short “Promoted → …” stub here, or delete the lesson once the standard covers it.
5. **Do not** paste proprietary process text from other products. Write FlyBot-specific facts only.
6. **Security lessons stay hot:** fence / display-name / claim-honesty themes stay in LESSONS until the matching tests and standards land, even after promote.

## Open lessons

### 2026-11-03 — Budget tool results and exact execution input

Seen 1× (large-history regression). A bounded initial context does not bound a
context tool returning every Task or note. Return a scoped index and hash/cursor
pages, preserve required constraints, and preflight the exact native/SDK input.
Aggregate SDK usage is not a measurement of current window occupancy. Structured
native handoff input must remain JSON rather than `[object Object]`.

### 2026-11-02 — Additional approved merge inputs need a host contract

Seen 1×. A published upstream already in the old candidate does not imply there
is no other MERGE_HEAD. SDK shared refs must stay restricted. Explicitly admit
operator-provisioned ref/SHA inputs under manager authority and durable save proof,
then let the host seal the resolved tree with trusted parents using Git's supported
reset lifecycle. Reject unknown/moved/conflicted input before index/branch writes;
a wrapper printf exit0 is not proof the nested git commit succeeded.


### 2026-11-02 — Prepared inbox is not an injected SDK turn

Seen 1× (queue regression). A safe-turn remaining count included batches already
injected earlier in the same claim. Count only sources not actually sent/observed,
excluding the current prepared batch. An unsent inbox remains eligible after a
concurrent manual answer or aborted dispatch; it cannot be treated as read.


### 2026-11-02 — Model input acknowledgement is not a Task acceptance receipt

Seen 1× (fault regression). Planning a Chief decision must not consume input if
its evidence or routing later fails. Validate a host-local receipt permit, recheck
new input/generation at closure, and save handling with acceptance. A model's read
declaration is distinct from transport/SDK output and independent verification.

### 2026-11-02 — Real SDK probes must use the real workspace contract

Seen 1× (isolated probe). An empty non-Git fixture failed Codex before thread start;
deterministic protocol workers had hidden that precondition. Initialize the bounded
Git fixture like the host allocator, keep failed evidence and diagnose without
printing raw SDK stderr or bypassing the repository check.


### 2026-11-01 — Awaited save is not proof an intent reached disk

Seen 1× (fault probe). A reading/no-op store save can resolve without committing,
while a journal error can reject after state rename already committed. Capture
intent generation/revision with the exact snapshot and acknowledge the rename;
only committed intents may dispatch. Preserve ambiguous remote receipts for
reconciliation, and never let an old callback commit a staged replacement.

### 2026-11-02 — Consumers must agree on host exit proof kinds

Seen 2×. Resource reconciliation correctly released workers after a prior systemd
invocation exited, while both workspace reuse and logical Session resumption still
accepted only SDK stop acknowledgements. Share a proof predicate and bind supervisor
proof to the exact released lease/generation/scope; never infer exit from status or
clear a workspace lock to compensate for a mismatched proof vocabulary.


### 2026-11-01 — Poll summaries, retrieve complete context on demand

Seen 1×. Actual Task40 accumulated25 Attempts and40MiB state; the legacy detail
response exceeded the unchanged8MiB gateway cap. Page Attempt summaries with
original context/policy hashes and hash-bound full retrieval. Keep all original
history; raising response limits or silently deleting archive text is not recovery.


### 2026-11-01 — A stored worker record is not a running turn

Seen 1×. Service status inspection found the old workbench projection treated any
stored native Bot as running. Derive status from current scoped SDK execution or
native live activity, retain starting/waiting states, and share one projection
between service/detail/workbench readers. Test stale records and wrong-Project
candidate/worker references; heartbeat alone is not meaningful progress.


### 2026-11-01 — Preparation belongs to every receiver, not one successful checkout

Seen 2×. The real Tester lacked native dependencies although Developer preparation
passed. Prepare each receiving checkout on its bound resource before inference,
and prepare host tests again after reset/clean. Keep the command operator-selected;
readiness only validates metadata. Wrap allocation and checkout in the same
unbound-reservation cleanup as context assembly, preserving failed work and evidence.

### 2026-11-01 — A wake burst is not concurrent permission to dispatch

Seen 1×. A deterministic slow-reconciliation probe reproduced overlapping resource
reads from repeated scheduler wakes. Coalesce the complete reconciliation/admission/
pool/schedule/Chief pass, retain one follow-up for in-flight events, and clear the
lock on failure. Persist handoff receipts before event wake; the timer is fallback.
Retry blocked provisioning explicitly on its original queue/principal, with fresh
manager/requester authority and preflight, never by rewriting live task records.


### 2026-11-01 — A browser cookie is not a persistent user grant

Seen 1×. Watch behavior cannot survive browser logout/restart by treating a
transient turn or old cookie as authority. Persist a revocable human/Project
grant, recheck current account and role, and fence revoked callbacks before
stopping workers. A read-only SQLite account projection must read fresh WAL
state; immutable mode can silently miss a recent account disable.


### 2026-11-01 — Questions need a scoped conversation route, not a Task

Seen 1×. A private assistant with only Task/run tools turned repository inquiries
into proposed work instead of consulting Chief. Supply an isolated Chief
conversation handoff and bounded GitHub read tools; return the answer to the
originating private chat without forwarding its memory. Enforce read-only query
actions in the host and distinguish publication, queueing and actual execution.


### 2026-11-01 — Transfer the Task after confirmed worker exit

Seen 1×. Pool dispatch must not reserve all downstream roles, replace a returned
Task or accept a retired worker result as fresh work. Keep stable Task identity,
version each claim/Attempt, retain unknown leases, and consume retired replies on
the original run surface. Revisited roles need per-Session sealed logs and archived
previous evidence; the old one-result-per-role guard otherwise rejects valid
follow-up review as a duplicate. Enforce the existing validator with trusted evidence;
model-supplied green checks or PASS text cannot satisfy admission.


### 2026-11-01 — Check complete conventions at the actual worker input

Seen 1×. Appending complete policy to a Workflow node passed metadata assertions
but node cleaning cut the final SDK prompt at 4000 characters. Assemble the pinned
policy at the host execution boundary after cleaning, check its hash, and test the
actual child-worker input with an end-of-policy sentinel. A candidate JSON approval
also cannot establish the separately signed repository Reviewer PASS.


### 2026-10-31 — Pin the browser runner to the locked Playwright platform

Seen 1×. GitHub ubuntu-latest moved to 26.04 while Playwright remains locked at 1.56.1;
Chromium installation failed before browser checks ran. Pin the browser-bearing Test
job to ubuntu-24.04 and keep every browser/required gate enabled. Test logs distinguish
an unsupported installer platform from a passing or failing product browser scenario.


### 2026-10-31 — Check context after the last prompt transformation

Seen 1×. M7.1 inspection found Workflow graph sanitization caps node prompts at 4,000
characters. Appending role memory there can silently hide it from the model. Snapshot
bounded public context at admission, inject it at host Session creation after that cap,
and assert actual DSH model requests contain published memory/repository instructions.


### 2026-10-31 — A Bot ID alone cannot authorize a private Project agent

Seen 1×. M4 boundary review found a group/old Session could map to the same Bot while
its own private Session held a live delegation. Bind scoped tools to the exact current
own Session, deny group seats centrally, and recheck the delegation after upstream auth.
Regression cases also verify revoked membership/session and no credential fallback.

### 2026-10-31 — Execution worktrees must live outside DSH data

Seen 1×. Actual M3 DSH startup refused worktrees beneath DSH_HOME/bot because they hold
Harness data. Allocate a registered root outside the data directory and pass each role
its explicit cwd. Keep cleanup intent before Git effects, and validate the owned root
before removing a worktree. Actual DSH and cleanup-boundary regressions guard this.

### 2026-10-31 — Scope alternate reads and Task detachment as well as writes

Seen 1×. M2 tests reproduced unscoped plugin reads and explicit-null Task detachment
bypassing intended Project boundaries. Scope/deny alternate entry points, derive actor
and Project at the host, and test stale sessions/pages after removal. A permissive old
plugin read cannot become the shared-workbench fallback.

### 2026-10-31 — Routing bindings cannot own historical work

Seen 1×. A regression test reproduced Task attribution changing with Bot rebinding.
Stamp direct projectId once, preserve explicit null and migration candidates, and import
legacy plugin links explicitly. Never repair identity as a side effect of reading a board.
Rebind/restart and ambiguous-run tests guard the M1 fix.

### 2026-10-31 — Persist fork boundaries and verify effects independently

- **Seen:** 1× (M0, fork #2 / PR #9).
- **Trigger:** Project-first scope and the requirement to leave control-plane unchanged were recorded in chat/issues but not Project State; M0 checks were manual-only.
- **Wrong:** inherited roadmap constraints stayed ambiguous. The smoke's single independent addition case let constant-five code pass; DSH scratch/native-loader directories also escaped the fixture's cleanup directory.
- **Right:** update PROJECT, ROADMAP, dated decisions and subsystem ownership with implementation; wire tests into verify/CI. Check files/cwd and distinct expected outputs; set the child TMPDIR/TMP/TEMP inside the private fixture directory. Keep platform adapters in FlyBot and distinguish deterministic execution from real-model acceptance.


### 2026-10-24 — A stale base reverts merged work while the PR page stays green

- **Seen:** 4× (#864, #876, #887; #907 re-uploaded an old copy of its branch twice, at `d6e143a8` and `b8b582bd`)
- **Trigger:** branching from a local `main`, or any `main` not fetched in this run, and opening a pull request from it.
- **Wrong:** reading the green pull request page as "the branch is fine"; the ghost files in the diff are the tell, and the branch quietly restores an old `main`. #887 removed the 84 test lines #869 had just merged, with every check green. #907 dropped #909's whole fix from both old tips (no `verifiedAuthor`, no `not-inviter` refusal) while its page stayed green.
- **Right:** `git diff origin/main...HEAD --stat` must list only your files. Anything else means a stale base: delete the branch and start again from the fetched tip. See [AGENTS.md step 2](AGENTS.md#pipeline-contract).

### 2026-10-24 — The merge decision is made on the merge tree

- **Seen:** 1× (#759)
- **Trigger:** deciding a pull request can merge from its own page.
- **Wrong:** 9/9 green on the head read as mergeable; the entry was kicked out of the queue twice and went red on `main` at `core/test/follow-through.test.js:264`.
- **Right:** read the queue entry — the pull request merged onto the current `main`. A red entry naming files you did not touch is the stale base above, not bad luck.

### 2026-10-24 — One conclusion per tip

- **Seen:** recurring; the team's highest incident rate, so no single issue to point at.
- **Trigger:** a Bot judging a tip that already carries a `Verdict:`.
- **Wrong:** posting a second `Verdict:` at the same SHA to "settle" the first, or editing the first when the answer changed.
- **Right:** one `Verdict:` per tip. A new commit voids the old one; a correction reads `Correction from <Bot>: …` and carries no `Verdict:`.

### 2026-10-24 — A `Docs-not-needed:` trailer only in a branch commit is gone after the squash

- **Seen:** 1× (the commit on `main` carries the pull request title and body, nothing else)
- **Trigger:** excusing an owned-path change with a trailer in a branch commit only.
- **Wrong:** green on the pull request and on the queue entry, then `arch-docs` fails on the push to `main`, where the branch commits no longer exist.
- **Right:** write the trailer in the pull request **body** as well (`check-arch-docs.mjs` reads `git log <base>..HEAD`).

### 2026-10-14 — Untrusted fence escape and remote display names

- **Seen:** 2× (from PR #2 review → issue #9; #98 non-face room ingest)
- **Trigger:** Remote message or file body, or a peer display name / handle, reaches model-visible text.
- **Wrong:** One-shot `replaceAll('</untrusted-…>', '')`; put peer-controlled names in trusted headers outside the fence.
- **Right:** Neutralize markers until stable (or escape `<` / reject `untrusted-` fragments); share one helper with the client parser. Sanitize remote strings (strip controls/newlines, cap length); fence where possible. Negative tests required (see #9 acceptance).
- **Promote path:** After ≥3 days and green tests → harden as a rule in [docs/code-standards.md](docs/code-standards.md#security-fences-and-remote-strings).

### 2026-10-15 — Generated gates run after the last edit

- **Seen:** 3× (#94, #99, #177) — all caught on packaging only. Dated 2026-10-15, so ≥3 days: promote the merge-gate rule into docs/code-standards.md.
- **Trigger:** any edit to `core/` after the last `ds-bot-patches generate`, or before a `check-arch-docs` run.
- **Wrong:** trusting an earlier green `check`/`arch-docs`; `check-arch-docs` diffs the base...HEAD and answers "0 changed" on uncommitted work.
- **Right:** final `core/` edit → `npm run build` in `core/` when `src/client/` changed → `node scripts/ds-bot-patches.mjs generate` (repo root) → commit → `ARCH_DOCS_BASE=upstream/main npm run verify`. New files under `core/` land whole in `patches/ds-bot/files/` (no `topics.json` row).
- **Promote path:** after ≥3 days → docs/code-standards.md (merge gate section).

### 2026-10-18 — `main` merges only through the merge queue

- **Seen:** 1× (#217, #222)
- **Trigger:** merging a green PR into `main`.
- **Wrong:** `gh pr merge <n> --squash`, reading `! The merge strategy for main is set by the merge queue` as a failure, then retrying or looking for a `--merge-queue` flag.
- **Right:** `gh pr merge <n> --auto --squash --match-head-commit <sha>` enqueues it; the queue runs `Test` on `merge_group` and squash-merges. Wait for MERGED (the merge starts the `push` run on `main`). See [merge plumbing](docs/autonomous-dev.md#merge-plumbing-merge_group-merge-queue-auto-merge).
- **Promote path:** after ≥3 days → docs/code-standards.md (merge gate section).

### 2026-10-18 — A mock answer must have the shape the real server sends

- **Seen:** 1× (#342: #228's `join_invite` mock returned a `bot` field the server never sends; #334 broke the real shape and stayed green)
- **Trigger:** a plugin test mocks a Bot Social tool answer.
- **Wrong:** invent a convenient field, or use a home-level `inviter` where the server sends the invited Bot, so the test passes while the real answer takes another path.
- **Right:** copy the answer from the server source or a read-only call, name the Bot Social commit in a comment, and keep one test on exactly that shape (`#342` in `plugins/social/test/social.test.js`).
- **Promote path:** after ≥3 days → [docs/code-standards.md](docs/code-standards.md#verifier-honesty).

### 2026-10-14 — Claim honesty (Verifier)

- **Seen:** 1× (PR #2 review / agent claim patterns)
- **Trigger:** Agent or PR claims “fixed”, “tested”, “secure”, or “ready to merge”.
- **Wrong:** Imply full validation when only part of the suite ran; omit tip SHA; treat author narrative as evidence.
- **Right:** Name the tip SHA. List commands run and their results. List **not run** explicitly. PASS only from the reviewer (the owner's reviewer Bot, self-PASS counts) at that tip. No “faster/safer” without a new Verifier PASS.
- **Promote path:** After ≥3 days → [docs/code-standards.md](docs/code-standards.md#verifier-honesty).

## 2026-10-31 — a member UI must not carry the Harness owner cookie (Seen 1×)

Project-scoped endpoints cannot protect raw Harness Session APIs if the shared browser
also receives the private runtime owner login. M5 uses a fixed-upstream endpoint-allowlist
gateway with the cookie held server-side. Test blocked raw/plugin routes and cookie
stripping alongside runtime membership. Repository name equality also does not grant
operator filesystem/GitHub capabilities: verify the provisioned Project owner.

## 2026-10-31 — test the fresh shared entry without private UI bootstrap (Seen 1×)

Old runtime probes called private `state`, which created a legacy Main Bot before any
Project delivery. The actual shared browser did not, exposing Workflow's `no-sender`
dependency. Resolve the dispatch sender from the durable Task Project's Chief and fail
if missing, never borrow an unrelated private main. Keep a fresh two-account browser
regression; DOM/API tests alone do not prove clean startup integration.

## 2026-10-31 — terminal supervision must await owned runtime cleanup (Seen 1×)

Python subprocess.run kills a child when KeyboardInterrupt unwinds, which can cut off
Node's DSH/data cleanup. The M6 foreground launcher uses an owned process session and
explicit graceful termination/wait. Node keeps shutdown handlers active during cleanup.
Test both ready-state Ctrl-C and interruption during startup with actual temporary data.

## 2026-10-31 — verify what the real model sees after a tool runs (Seen 1×)

An object under a string tool schema rendered as `[object Object]`; a real Chief retried
Task creation while deterministic fixtures only noticed that a tool ran. Serialize the
result as JSON, assert the rendered facts/ids, and deduplicate repeated mutations within
the exact live human delegation. Successful internal execution is not model-visible proof.

## 2026-10-31 — identity discriminators must survive host name truncation (Seen 1×)

The 40-character Bot name limit removed the member suffix from long Project agent names,
so a second member could not open the shared view. Put the logical identity digest first
and keep the total name within the host limit. Reproduce with real-length Project ids and
the host's truncation/uniqueness contract, not short unit-test ids.


### M7.2 — 2026-10-31

Seen 1× (2026-10-31, M7.2): a terminal Task/Run does not prove an external worker exited. Keep SDK/stopping/unreachable resource leases in Project occupancy, and release only with the bound worker handle and confirmed exit. Restart reconciliation must never silently free unknown processes.


### M7.3 checkpoint — 2026-10-31

Seen 1× (2026-10-31, M7.3): SDK turn-completed does not mean required outputs, committed code or delivery acceptance. Keep backend Session ids and required OUTPUT checks separate; truncated streams fail, questions remain waiting-input, and only confirmed worker exit releases capacity.


### M7.4 — 2026-10-31

Seen 1× (2026-10-31, M7.4): printing a hidden-input prompt before disabling OS echo lets immediate input leak to the PTY screen; suppress echo before the prompt, and test the actual screen. The same test found the clean setup PATH selected old system Node: use the execution runtime Node path in both SDK and setup terminal.


### M7.5 — 2026-10-31

Seen 1× (2026-10-31, M7.5): service-only tests missed terminal/runtime/input HTTP cases falling through to the resource read model. Test the actual channel and browser, not only direct service methods. SDK result callbacks also await release: process the fenced stop acknowledgement outside their serialized event queue or cleanup waits on itself. Red/green regressions cover both integration failures.

Seen 1× (2026-11-01, M7.5): a real DSH queue regression reached terminal Attempt status before asynchronous worker release finished. Wait for confirmed Bot and lease release before requesting workspace cleanup; retain the product guard that refuses cleanup of live workers. Local full verify passed while CI exposed this ordering race.

### M7 real SDK acceptance — 2026-11-01

A real SDK readiness reply proves inference only. Validate the full scoped Chief Task,
actual worktree changes, immutable host tests, exact-SHA Review/PR, requested-test rework
and confirmed worker release. The Codex-only run passed without native mock requests;
record its exact source and distinguish scripted owner acceptance from human review.

### 2026-11-01 — preflight the actual deployed delivery configuration

Seen 1×: the shared service omitted allowedPaths. Login, SDK code smoke and an independent verify passed, but actual Project execution failed after consuming Dev inference. Validate required repository policy before admission, share metadata readiness with the UI, and distinguish missing configuration, out-of-scope changes and no code change. Prove the configured Project path, not only an isolated SDK primitive.

### 2026-11-01 — credential masking must preserve Task identifiers (Seen 1×)

An unanchored `sk-...` secret pattern matched inside `task-UUID`, corrupting actual
Chief routing JSON. Match credential tokens at a word boundary and test both a
credential-shaped token and unchanged Task IDs through saved Harness events.

### 2026-11-01 — restart recovery needs supervisor scope evidence (Seen 1×)

A missing PID or terminal Task status does not prove external work exited. Record
the actual supervisor invocation/control group before starting execution. Only a
verified manager boundary with control-group termination can release old local
capacity; unknown/remote/different-boot evidence remains held.

### 2026-11-01 — an empty inbox is a valid native tool continuation (Seen 1×)

A schedule interceptor rejected empty pre-step messages even when it consumed no
reminder. Actual DSH executed the shell tool but never submitted the final Workflow
result. Reject only a consumed managed-only delivery, preserve ordinary empty
continuations, and verify the actual native runtime as well as fake schedule hooks.

### 2026-11-01 — test collaboration through the restricted gateway (Seen 1×)

Real shared-service Chief configuration returned HTTP 403: host endpoints were
registered but the gateway allowlist still lacked R3–R6 APIs. Exercise actual HTTP
forwarding with current member credentials and retain raw-owner API refusal.

The same live HTTP probe then caught a second missing registration: channel.js
needed explicit dispatcher cases. Gateway forwarding and direct service tests
alone cannot prove end-to-end reachability; cover the actual authenticated route.

### 2026-11-01 — supervisor reconciliation must fence concurrent release (Seen 1×)

During real issue #40, Dev and Chief exited correctly but the next Dev queued:
reconcile had captured an active lease, awaited supervisor metadata, then marked
the now-released lease unreachable. Recheck terminal lease status after the await
and skip currently controlled workers before supervisor I/O. A concurrent
release/reconcile regression reproduces this race; never edit live status by hand.

### 2026-11-01 — failed admission is not an active worker (Seen 1×)

After the real repair restart, an interrupted Attempt failed preparation but left
its claim active. Chief correctly refused blind retry because host facts conflicted.
Fence failed admission, retain unconfirmed occupancy, route the failure to Chief,
and include actual resource exit proof and handoff reason in judgement context.
A pre-candidate Chief retry may pin a fresh repaired base; keep the old Attempt.

Chief correctly held a legacy interrupted claim when its snapshot omitted whether
that Attempt had ever allocated execution. Expose the bind-before-start host
registration proof (with all lease/worker/session/workspace counts), not a missing
PID inference. Any registered/unknown record prevents the never-allocated claim.

### 2026-11-01 — a room needs its own scoped conversation carrier (Seen 1×)

The shared entry exposed only final Chief/private text, while global room APIs carried
owner-wide authority. Route internal roles through existing scoped delegation, bind each
room/role to an independent Session and check participants on documents as well as chat.
Exclude reasoning and raw tool arguments from public streams; fence action responses as
well as refreshes after route changes. Loopback-listen refusal is blocked browser evidence,
never an excuse to call a fixture the actual shared-service acceptance.

### 2026-11-01 — Browser fixtures must implement the channel token contract (Seen 1×)

The actual channel extracts the member-session header before calling authenticate.
A fixture expecting Headers failed before any UI assertion. Exercise the real route
with valid, invalid and revoked tokens before starting Chromium; keep these checks
in verify and report browser assertions separately. Update registration-order tests
when adding a native stream observer rather than removing the observer to satisfy them.


### 2026-11-01 — Bootstrap the full browser fixture before launching Chromium

Seen 2×. A rooms-only channel preflight missed lazy Project agent creation calling a nonexistent runtime index method. Use the actual save boundary to refresh indexes and exercise every rooms-page bootstrap endpoint for each human role before sockets. Keep one changelog entry per fragment; read the current complete verification log rather than attributing a new failure to the prior run.
### 2026-11-01 — SDK worktree writes need the registered Git index (Seen 1×)

Real Dev produced source/tests but sandboxed Git could not stage new canonical
files: a local worktree stores its index outside cwd. Select only that registered
worktree Git directory and the repository object store as Codex writable roots.
Shared refs/config and network remain outside the grant. Loopback/private host
verification remains a host testing operation; report sandbox Not run honestly.

A service restart also marked a paused, unsealed Attempt interrupted after Dev had
exited. Preserve the existing code on Chief route only when every recorded lease
and worker is released, no native worker remains, cancellation was not requested
and the registered workspace contains changes. Record a resumption with the old
failure and Chief decision. Unknown exits never permit working-directory reuse.

### 2026-11-01 — deny external network without breaking local process IPC (Seen 1×)

Actual CLI sandbox probes and strace showed Node spawnSync returning EPERM even
when Git exited 0: raw network denial also denied Unix setsockopt/shutdown/getsockname
used by libuv pipes. Node 22 and 24 both reproduced. A named constrained filesystem
profile plus the enabled limited proxy with an empty outbound allowlist restored
Node/Git children; actual proxy requests were 403 blocked-by-allowlist, direct DNS
failed and outside-workspace writes remained EROFS. Never call a Git grant alone
a proven remedy, or switch to unrestricted filesystem/network access.

Actual Tester correctly saw no candidate in its clean receiving checkout, but the
unfinished Developer source still existed elsewhere. Pass a labelled draft
reference with transfers; never equate clean recipient cwd with no implementation.
A valid raw JSON decision lacking only OUTPUT framing must not leave an idle SDK
Session waiting indefinitely; preserve its raw evidence and validate its meaning.

### 2026-11-01 — Chief recovery must be admitted before changing execution (Seen 1×)

Real Chief recovery prepared a new Run before a lifetime handoff counter refused it,
leaving the Task stopping and its Attempt running. Check routing admission before
fencing or rework. Audited Chief intervention starts a new bounded autonomous epoch,
retaining lifetime history and global quotas; it cannot bypass evidence or authority.
Failures after fencing need an explicit block and decision ID, never indefinite stopping.

### 2026-11-01 — read-only verification still needs writable temporary fixtures (Seen 1×)

Actual Reviewer twice returned INC: its source stayed read-only but temporary
fixtures failed EROFS. A real CLI probe reproduced failure with the :tmp alias and
success with an explicit scratch path, while source writes still failed. Bind a
unique host-created directory per command worker, set TMPDIR/npm cache to it and
clean only after confirmed exit. Prepare fixed dependencies outside the sandbox;
never turn source writable or waive independent checks to compensate for provisioning.

An idle tested pool waiting for Chief is not interrupted execution. Preserve that
checkpoint only with completed Chief judgement, released Chief lease and every
registered delivery worker/lease released, no native worker and no cancellation.
Unknown occupancy or an active claim must retain conservative interruption.

### 2026-11-01 — Attempt branches are not delivery PR identity (Seen 1×)

Actual PR48 maintenance was blocked because rework creates a fresh Attempt branch
and publication only searched that branch. Carry the host-verified PR binding across
rework/retry; validate it before mutation and again before/after publication. Keep
published candidates in Git ancestry while collapsing unpublished worker commits.
A normal fast-forward push must refuse concurrent contributors' commits. Never
create a replacement PR after a stale/closed binding or rewrite history to get green.

### 2026-11-01 — Preserve trusted upstream ancestry when sealing rework (Seen 1×)

The correct integration tree still conflicted after squash onto only the old
candidate. Resolve the actual PR target ref through the host credential broker,
pin it before rework, require resolved merge evidence and retain both public
parents while dropping private worker commits. Recheck target movement before
and after publication; a model-supplied parent or green test alone is insufficient.

Measure each context component before blaming public knowledge: full repository rules may already be separately injected. Remove only hash/commit-verified duplicate previews, retain all original rule text and audit facts, and release unbound reservations on preparation failure before any SDK starts. Preparation retries must preserve unsealed drafts.

A backend repair can advance the stacked PR target while an unstarted rework Attempt still pins the previous target. Re-read actual refs through the host broker before allocation; refresh only a verified descendant on a proven pre-execution boundary, audit both inputs, retain draft/seed/history, and keep later publication movement checks strict.

When browser acceptance stalls waiting for a side effect, inspect host proposals and authorization state before blaming model transport or retrying. A safe-mode proposal requires explicit human publication; align the real browser scenario with that contract and retain no-early-effect, cross-user and duplicate-publication assertions.

### 2026-11-01 — Functional chat checks do not establish visual acceptance

Seen 1×. Room routing passed while the main workspace still presented administrative
forms. Compare the actual desktop/narrow-screen pages with the owner's reference;
keep conversation/composer primary and configuration in Settings. Screenshots and
real-service clicks must name their source, independently of deterministic DOM tests.

Chief inspection may explicitly select one existing Task in its authorized Project. The host validates Project configuration authority and Task ownership before using the existing scoped snapshot mechanism. Other-Project/missing Tasks are rejected; unscoped inspection is unchanged. This reduces unrelated facts without dropping policy/knowledge or raising context limits.

Owner basic-CI policy is implemented on the existing PR47 local branch: default pinned install/lint/build/canonical/core and plugin unit checks; heavy browser/runtime/package checks explicit extended dispatch. Independent Review and actual UI acceptance remain. Publish only at a safe upstream-binding checkpoint; this local change does not claim live workflow activation.

### 2026-11-01 — Polling must let slow responses finish

Seen 1×. Refreshing every four seconds while aborting the prior same-route request starved the workbench on slow connections. Join the pending load, cancel only on scope changes/disposal, and test a response lasting beyond the poll interval. Keep board payloads separate from full execution/audit history and retain authorization on summary reads.


### 2026-11-01 — Update workflow contract regressions with the authorized CI split

Seen 1×. The basic/extended workflow and executable result gate were updated, but two historical shape tests still required unconditional jobs and the old shell expression. Read the actual host failure log, assert the new job/result wiring and preserve failure/cancellation tests; do not restore obsolete heavy-job policy just to satisfy stale assertions.

### 2026-11-01 — Mount the native component, not its imitation

Seen 1×. A safe scoped renderer still failed the requested native UI reuse contract.
Mount original components using actual member-visible identities and dispose roots on
route changes. Keep native dependency assets out of board startup; missing published
capabilities require explicit version guards, never invented Harness providers.


### 2026-11-01 — Mounting a component is not connecting its live source

Seen 1×. A constant snapshot mounted original reply bubbles while room streams still used a second renderer. Bind all Project conversation surfaces to the authenticated observable source, clear it on scope/revocation/logout, and test concurrent room streams plus actual component refresh. This is not proof of full native service or personal-space compatibility.

### 2026-11-01 — Personal groups retain membership history windows

Seen 1×. A personal-space adapter must not page a group's raw Session merely
because the caller currently belongs to the room. Reuse roomHistory's visible-line
projection; own-chat async reads must reauthenticate before returning after logout.

### 2026-11-01 — Bound generated-file diagnostics without hiding failures

Seen 1×. A minified native bundle made five whitespace findings produce over
8 MB of diagnostic output. Retain the full private output and actual exit code,
report bounded labels, then fix string generation and blank patch context.
Never strip whitespace from generated string values or waive the failing check.

### 2026-11-01 — Preserve native tree relationships in the scoped list

Seen 1×. Reusing BotRow alone flattened original personal parent relationships.
Mount the original TreeNode/botTree over the authorized roster and test actual
collapse/expansion and current-part selection, not merely presence of a Bot name.

### 2026-11-01 — A history cursor needs a reachable UI action

Seen 1×. Returning hasMore/beforeSeq alone left personal history capped at the
latest page. Wire the earlier-page control through the scoped source, retain
loaded pages during polling, and fence navigation/revocation before merging replies.

### 2026-11-01 — Append-only history must not become an unbounded prompt

Seen 1×. Actual41-entry shared knowledge blocked Developer before SDK registration
and Chief failed without execution evidence. Preserve source records/authors and
publish a current manager checkpoint bound to exact prior hashes. Project only
verified covered history to digests, retain newer facts, and reject stale references
without hiding originals. Do not raise caps, truncate criteria or blindly retry.

### 2026-11-01 — Native component styles must survive the shared CSP

Seen 1×. Mounting original components with an inline style silently lost mark dimensions under style-src self. Generate shared shell/conversation/sidebar rules into the same-origin asset, keep extracted animation dependencies explicit, and assert the generated asset. Logout must invalidate pending actions before awaiting remote revocation.

### 2026-11-01 — A failed-test hash alone cannot drive autonomous repair

Seen 1×. Actual UI64 failed a popup z-index test, but the host wrapper returned
only its log tail and Developer could not find the requested receipt. Preserve
early failure details in verifier output and feed a bounded, hash-verified excerpt
from the same Task/candidate into rework. Redact before truncating long lines;
retain full originals and never confuse diagnostic text with verification PASS.

### 2026-11-01 — Extracted styles keep their behavioral assertions

Seen 1×. Moving sidebar CSS to a shared same-origin module left the layering regression reading its former file and reporting NaN. Follow the canonical stylesheet and verify its consumer import; retain the z-index boundary assertion rather than weakening it.


Task #40 rework: the inherited candidate failed the fragment validator because
`40.fixed.md` contained multiple paragraphs. Keep one entry per fragment. The
native conversation script now uses production React configuration and full
minification, guarded by a 4.6 MB script budget (previous asset: 5.37 MB). This
is a bounded reduction, not completed weak-network acceptance: embedded math
fonts/CSS and the full native composer, tools, approval, stop/continue and
personal/group interaction integration still require work. Operator deployment,
three-account browser checks and actual screenshots remain pending.

### 2026-11-01 — Bundled font data can violate the serving CSP

Seen 1×. Native math CSS embedded all font formats as data URLs, adding roughly
1.5 MB while the shared gateway correctly allowed only same-origin fonts. Emit
byte-preserved same-origin font assets and retain the restrictive CSP; verify the
CSS budget, asset existence and bounded gateway paths rather than enabling data URLs.


### 2026-11-02 — Finish asynchronous preflight before staging a source batch

Seen 1× in S4's concurrent-save regression. An async principal check between event
insertion and input/cursor staging lets another host save commit a half-event;
restart deduplication would then skip undelivered feedback. Finish async preflight
first, recheck synchronous authority, stage the complete batch without a yield,
and obtain the existing save/rename proof. A deterministic unrelated-save regression
fails before the repair and preserves complete event/input/cursor binding after it.

### 2026-11-02 — Occupancy guards must bind to the current owner

Seen 1× during live operator-source admission. Seven released historical Chief
turns predated exit-proof recording and never owned the current workspace. A
Project-wide scan treated them as current occupancy and blocked recovery forever.
Require proof for this Attempt, the current Chief claim and all unreleased Chief
workers; retain unknown-current refusal and every historical record. Regression
tests must mix legacy released history with active, unreachable and current-claim
workers, rather than only using an empty history fixture.

### 2026-11-01 — Keep memory, logical Session and execution evidence separate
Seen 1×. A FlyBot48k role-admission cap precedes the SDK; Codex automatic compaction cannot fix inputs rejected before it starts. A1MiB event-size failure is transport, not model context. Use bounded current facts plus exact retrievable source snapshots, preserve full requirements and role rules, and let each Harness manage its own history. Task rework must not throw away its role thread/cwd; resumption requires matching Project/Task/role/principal/resource/profile/model/persona and confirmed process/lease exit. Never reuse a Developer thread for independent Review or carry a verdict across commits. Chief long-term facts reuse original own-memory topics/journal, with no private/team scope fallback.

### 2026-11-01 — Script readiness does not imply native style readiness

Seen 1×. A slow connection delivered native JS before its stylesheet and mounted
unstyled controls. Await both fixed same-origin assets, test script-first ordering
and stylesheet failure, and retain scope fences for late load callbacks.

### 2026-11-01 — Scope interactive controls to their displayed conversation

Seen 1×. Reusing a renderer without questions, approvals or live controls leaves native
behavior unavailable. Reuse the original cards with captured handles, match approval
and question IDs to the current owned Session, revalidate after awaits, and exclude
hidden exchange/tool data. A group seat cannot grant control of another owner's Bot.

### 2026-11-01 — Optional workbench observers must preserve legacy registration

Seen 1×. An always-installed pass-through stream listener shifted the legacy fixed
installation protocol and listener selections used by secrets/usage tests. Install
workbench-only observation only in explicitly configured shared mode and test both
modes, rather than weakening existing assertions or changing token accounting.

### 2026-11-01 — Current conversation parts are live routes

Seen 1×. Treating every part selection as historical left the current Session read-only.
Canonicalize current-part selections and deep links to the live Bot route; older parts
stay immutable. Native attachment-only messages also need recorded reference projection,
not text-only filtering or arbitrary object-ID reads.

### 2026-11-01 — Keep native input roots mounted across refresh

Seen 1×. Rebuilding a page every poll lost browser focus, cursor and component state
even when the draft text was restored. Update scoped native roots in place and retain
their ancestors; replace them on scope/source changes. Test mounted identity with a
boolean comparison: printing unequal React/DOM graphs can exhaust memory before the
failure is reported. Keep diagnostics bounded; do not raise execution resource limits.

### 2026-11-02 — Compact status adapters need the same runtime evidence

Seen 1×. Integrating S1's shared TaskView left the compact board calling its status
mapper without live activity, so actual native execution appeared as starting.
Supply the same activity snapshot to compact and full adapters. Test both an active
native claim and an idle stored Bot; never infer execution from Bot existence.


### 2026-11-02 — Deferral is responsibility, not a live execution claim

Seen 1× in real Source feedback recovery. Chief completed and released its SDK,
but arbitration continue left claim active while Task was blocked. Operator source
admission correctly refused. Mark only that completed Chief claim waiting-human;
retain actual exit/lease checks and every other claim. A regression reproduces the
old active label and verifies Task/Attempt/generation and blocked state survive.
