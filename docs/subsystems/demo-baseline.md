---
subsystem: demo-baseline
owned_paths:
  - dev/demo/
  - scripts/lint-demo.mjs
---

# demo-baseline

Fork M0 tooling, not a shipped runtime/platform service. Scope: [fork decision](../../decisions/2026-10-31-project-first-fork.md).

## Boundaries

- `run.mjs` uses pinned published DSH, core/Workflow, private temporary data and a
  deterministic loopback model. Actual bash writes/tests code; `artifact.mjs`
  independently verifies cwd, evidence and cases with distinct expected results.
  Child TMPDIR/TMP/TEMP live inside that private tree so spill/native-loader data
  is included in cleanup; the runtime test checks the enclosing temp directory.
- `control_plane.py` imports an explicitly selected external platform checkout with
  bytecode writes disabled and disposable SQLite settings. It reuses panel/auth APIs;
  it never starts the privileged manager or changes source, upgrade or deploy settings.
  CI pins the external revision and checks that its working tree remains unchanged.
- Existing multi-member write denials are asserted, not removed. Real-model PR delivery,
  identity mapping and per-run cwd are later work. No current UI structure is required.

## Tests

`npm run test:demo` covers missing/false artifacts, wrong cwd, failed tests, fabricated
results, constant output, missing exports, invalid platform paths and optimized-Python
refusal. `npm run test:demo:runtime` checks actual DSH/tool execution, ephemeral
owner/cleanup, cwd/member boundaries and temporary-data cleanup. Both and `lint:demo`
run in local verify and the required CI test job. That job separately exercises
real HTTP against unchanged pinned platform source. Layers are in `docs/testing-layers.json`.

Changes update this doc and regression cases, plus Project State/decisions when scope
changes. [Install](install.md) owns OCI/Compose; core-host/workflow own runtime features.

## Fork M1 — 2026-10-31

M1 extends the actual DSH runtime probe: create a Project Task, rebind its Bot, check
the original Project board, execute the Workflow and assert both plugin/host direct
projectId plus the terminal Run report. This runs via test:demo:runtime and verify.

## Fork M2 — 2026-10-31

M2 adds --shared-check to the external platform adapter and shared.mjs to the existing
actual DSH harness. Credentials travel over stdin. It checks two platform logins, invite/
shared Task/Workflow, member removal, platform suspension and logout; the required test
job executes it against unchanged pinned platform source. [Contract](project-access.md).

## Fork M3 — 2026-10-31

M3 adds the --delivery actual DSH probe and delivery.mjs fixture. The required runtime
test verifies role cwd, code edit, independent tests, commit-specific reviewer output,
missing-credential refusal and cleanup. --github-repo/--github-config-dir explicitly
enable remote draft publication outside routine CI; artifact #12 is deterministic-model
integration evidence, not independent Review or true-model acceptance. [Contract](project-delivery.md).

## Fork M4 — 2026-10-31

M4 adds --agents to actual DSH runtime verification: two private agent Sessions use
scoped tools; private proposal publication and public Chief Task creation retain the
requester; private memory and revoked old Session routes are checked. The required
runtime suite runs this fixture alongside M0/M3; no true-model/personal-GitHub claim.

M5 adds `node dev/demo/run.mjs --queue`: real DSH + deterministic model, three shared
Tasks with quota one, no allocation while waiting, automatic drain after Worker release,
duplicate request identity and cancellation after member removal. It is part of runtime
verify. This is not a real model or GitHub publication test.

M6 adds the optional browser development package (pinned Playwright), `browser-check.mjs`,
`workbench.mjs` and a foreground `serve.mjs` gateway launcher. CI installs Chromium and
runs `npm run test:demo:browser` against the same immutable control-plane checkout. Standard
verify retains the four key-free actual DSH probes and offline entry guards. Browser
acceptance requires explicit platform/Python/browser installations; it is not silently
skipped or replaced by DOM fixtures. Passwords enter the DSH runner via stdin; no browser
trace/HAR, cookies or model credentials are emitted. Failure diagnostics stay private.

Terminal lifecycle is covered by `serve_check.py`: it privately enters random passwords,
logs in through the real gateway, sends Ctrl-C after readiness and separately during
startup, and asserts the owned temporary tree is empty. The supervisor waits for Node's
graceful cleanup; it does not use subprocess.run's immediate kill-on-KeyboardInterrupt.

`--live-check` explicitly selects real DeepSeek and GitHub browser acceptance. It refuses
missing provider environment or fork/credential configuration, uses an immutable host
addition test outside model worktrees, runs actual scoped private/public agent tools,
returns a candidate through Alice's UI, checks new tests/commit and PR SHA on retry, then
accepts through Alice's UI. A second operator fixture forces host-test failure and checks
retry/queue/revocation. No mock-model request is permitted in this mode. The CLI supervisor
allows a bounded 20-minute live run; key-free regression timeouts are unchanged.

The real-provider run subsequently passed at `f126f8c`; [live acceptance](../live-acceptance.md)
and the committed JSON record preserve source/evidence/timing and distinguish human-role
browser automation from an independent human or repository review PASS.

### M7.1 context probe

The existing actual-DSH delivery probe explicitly publishes one memory per worker role
and configures its reference. For the marked local fixture, the deterministic model checks
its received system request contains published memory, repository instructions and context
version before issuing shell work. The host also verifies three distinct bound Sessions
reach released state. This validates real Harness transport/lifecycle, not real inference.


### M7.2 — 2026-10-31

M7.2 adds the explicitly invoked node dev/demo/resources.mjs test-host probe. It creates its own disposable Docker container, verifies distinct actual runtimes/filesystems and candidate-pool capacity/release, then cleans up. It needs Docker and is not part of key-free ordinary CI or proof of mixed-Harness Task delivery.


### M7.3 checkpoint — 2026-10-31

M7.3 adds an opt-in node dev/demo/harnesses.mjs negative probe using actual installed official SDKs, isolated empty profiles and unreachable loopback providers. It confirms refusal of successful completion, never authenticated inference; raw logs/credentials are not published.


### M7.4 — 2026-10-31

M7.4 adds dev/demo/runtime-setup.mjs: opt-in actual UID1000 Docker PTY/profile/cleanup probe with no paid provider. Unit integration uses real local Python PTYs and a hidden dummy credential, verifies no screen/audit leak and kills interactive background jobs. Browser/authenticated SDK acceptance remains separate.


### M7.5 — 2026-10-31

M7.5 adds dev/demo/handoffs.mjs for actual Docker→host Git candidate import, same-SHA review checkout, independent host tests and corrupted-bundle rejection/cleanup. Official SDK negative probes also validate no-tools configuration reaches SDK events. Existing browser demo adds Owner configuration/actual PTY/Member denial; still deterministic model, never a real SDK acceptance claim.

### M7 local Codex acceptance — 2026-11-01

The owner explicitly authorized this machine's existing Codex authentication and
zy95-12 GitHub account. `--codex-check` runs an opt-in real SDK path without a DeepSeek
key: an explicit private profile/model, local resource and verified GitHub login are
required. Public Chief proposes a scoped Task; three distinct SDK role threads use the
existing Workflow; immutable host tests and exact-SHA review/publication gate acceptance.
The owner-authorized scripted return/retry/accept sequence keeps both Attempts and cleans
only registered workspaces. It asserts zero calls to the deterministic native transport.
This API acceptance is separate from browser, Claude and multi-resource acceptance; none
is inferred from a Codex-only run. Routine verify remains key-free.

The M6 browser fixture exercises safe-mode proposals before Task publication: the native public Chief creates an unpublished proposal, even the Project owner cannot publish another member’s proposal, and the original member approves through the actual private-agent UI. Repeated approval reuses one Task, whose requester remains the original member. A missing unapproved Task is expected authorization behavior, not a timeout to bypass. Existing role/worktree/browser checks remain required.

## Development service (S1)

S1 extends the existing real-DSH queue probe to call the versioned Project service, compare the same Task view through legacy detail, start through the service facade, and verify revoked membership on the new HTTP endpoint. The transport and role execution are real DSH with the deterministic model, not paid real-model acceptance. See [service contract](project-development-service.md).

## Native workbench navigation (Task40)

`workbench.mjs` follows the Project workbench's separation of conversation and
configuration: Public Bots opens the public Chief conversation, while Settings
contains the Developer role form. After the private resource terminal closes and
its release is confirmed, the browser probe opens Settings before selecting the
role's execution Harness, SDK model and resource. It then checks the saved role
definition and the explicit unavailable result of an unconfigured SDK probe.
Changing this navigation does not grant a conversation configuration authority.

The fixture still uses separate Alice/Bob browser contexts through the restricted
gateway, with the Harness owner cookie retained server-side. Its existing private
notes, safe proposal publication, Task retry/history, narrow-screen, raw-API denial
and revocation assertions remain required. This two-account deterministic-model
probe does not establish full native personal/group interaction coverage or the
operator's deployed three-account, real-model and weak-network acceptance. The
native adapter and component contract lives in [Project workbench](project-workbench.md).

## Independent personal-agent identity

The deterministic agent fixture recognizes the v4 independent-personal-agent persona
and the legacy per-Project persona. It still exercises scoped context, private Task
proposal, explicit publication and revoked Session refusal through actual DSH. A
fixture regression pins both personas; this is model-transport compatibility, not
real external-provider or paid model acceptance.

## Admission and compatibility checks

Project delivery and quota probes now create proposed Tasks and exercise actual native Chief intake before any Attempt allocation. Deterministic model replies read the real scoped Task contract. Queue checks observe automatic Chief-admitted starts, duplicate queue requests and membership revocation; no test-only admission bypass is installed. The base Workflow probe waits for its persisted terminal checkpoint after asynchronous worker cleanup. These are real DSH runtime checks with deterministic inference, not real-provider Task judgement.

Quota assertions use an operator-owned verification gate in the disposable test directory. The host opens each gate only after observing the next admitted queue item; no framework scheduling delay, hardcoded model sleep or test-only admission bypass creates the overlap.


#2184 extends the original actual-DSH delivery probe to inspect persisted native-agent-quiescent proofs for Developer, Tester and Reviewer before removal. It keeps deterministic inference and the existing real code edit, configured host tests, missing-credential refusal and disposable cleanup assertions; this is not a real-provider or canonical return-loop acceptance.


`node dev/demo/run.mjs --native-pools` adds actual DSH single-resource Developer/Tester return/context restoration acceptance with a deterministic model. The marker is emitted only into the first Developer conversation outside the durable handoff JSON; the second request must find it in retained history, absent fresh system/input. It verifies fresh carriers, same physical Session/cwd, actual second code revision/host tests, lease intervals and Chief arbitration without fake closure; cleanup stops its disposable Attempt and removes worktrees. The required runtime suite now includes this fifth case. Initial failures exposed implicit [object Object] delivery deduplication and DSH archived-session admission; retained private evidence distinguishes both from the passing probe.

`run.mjs --native-pools --sqlite` runs the same canonical Chief/pool/context/exit scenario with the real transactional Store; `saved()` reads independent committed SQLite snapshots. Its sixth runtime regression verifies durable activation markers and cleans the disposable database and worktrees. Attempt chronology uses persisted predecessor references, not map key/insertion order. This is deterministic verification, not the backend deployment method.

## Persisted admission checkpoint (#2189 integration)

The actual native JSON/SQLite return probe waits through the original preparing Attempt reservation before asserting running pool protocol. SQL can expose this committed intermediate row before initialization finishes. A failed Attempt fails explicitly; the original protocol, running, context, single-resource, tests and cleanup assertions remain. The first full SQLite run reproduced this timing race; this is a deterministic-provider fixture correction, not a production delivery verdict.


#2327 adds optional correctOnce fault injection to the inbox fixture model: malformed requirement strings must receive host feedback and be corrected by the same Chief conversation. Production runtime tests assert both faults and both successful corrections.
