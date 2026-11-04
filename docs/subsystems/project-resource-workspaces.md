---
subsystem: project-resource-workspaces
owned_paths:
  - core/src/host/project-resource-workspaces.js
---

# Cross-resource Git workspaces and sealed evidence (M7.5)

New delivery Attempts use project-delivery/v3. Historical v1/v2 Attempts retain their
snapshots and evidence. Native DSH workers execute on local resources; SDK workers may
execute in registered local or Docker environments. Each selected resource must contain
the prepared FlyBot runtime/SDK installation (runtimeDir) and its explicit private profile.
No resource provisioning, arbitrary SSH transport or production deployment is introduced.

## Workspace and Git boundaries

A resource-clone records Project/Attempt/role/resource/lease/root and remote path. Local
worktrees remain registered in the host Git repository. Resource commands use explicit
argv/cwd and captured binding hashes; changing a resource's configured type/target/root/
UID/runtime cannot silently migrate an existing execution. New configuration affects new
leases. Native Chief local pool leases last for its turn, not its durable logical Bot.

Remote roles receive a Git bundle containing only the explicit base commit and reachable
canonical history, through a temporary reference. SDK profiles, untracked host files,
raw private chats and .git/config are not bundle inputs. Bundle size is bounded at 128 MiB;
SHA256 is checked after transfer, Git verifies the bundle, and the expected commit object
must exist before checkout. Never interpret a host absolute path as a remote directory.
Docker transfer runs through the resource adapter, not a browser file-proxy API.

At Developer completion the trusted controller checks allowed final paths, resets the
index parent to the fixed base and creates one sealed final commit. Intermediate worker
commits do not become candidate ancestors. A remote candidate's bundle is hash-verified,
imported into the host repository and bound to the attempt branch. Publication uses only
that host repository and the explicit host GitHub credential; no GitHub token goes to the
worker resource. Reference worktree files remain unchanged.

Tester/Reviewer remote clones import and cleanly check out the same sealed SHA. Any remote
role additionally causes allocation of a separate registered host-verifier worktree. The
controller runs the provisioned test command there, preserving absolute host test fixtures
and independent-host evidence even when the model Tester runs remotely. Review must name
the exact candidate and inspect a clean checkout. Existing PR-head and human gates remain.
Transfer manifests record Project/Attempt/resource/commit/hash/time. Temporary bundle files
are deleted after import; history retains hashes and resulting Git objects/evidence.

## SDK event evidence

Completed SDK node output is sealed into a separate bounded JSONL artifact before Workflow
stepResult. The record binds worker/backend Session/resource/Harness/SDK version/lease
generation/context hash/result hash and complete event-file SHA256. Live shutdown events
may continue in a different log; they cannot mutate the sealed prefix. Every subsequent
gate checks already sealed SDK evidence, and human acceptance checks every SDK role again.
Missing, changed or foreign logs fail closed before publication/acceptance. Members can read
execution evidence only through the scoped attempt-log endpoint; physical paths/credentials
cannot select another artifact. Native roles keep the existing DSH/host evidence contract.

Stop acknowledgement is observed outside the serialized result callback: Workflow may
await that same worker's release from stepResult. Waiting to process stopped behind the
callback deadlocks shutdown and falsely retains capacity. Generation-fenced immediate
acknowledgement plus actual process exit is required. A regression reproduces the full
callback-awaits-release shape, not just a later independent remove call.

Cleanup refuses active native workers and all unconfirmed resource leases, even after a
terminal Run. Remote removal validates the registered resource/root/Attempt/role path;
local worktree cleanup checks its captured root and real path. Stop/unreachable states
retain occupied slots and evidence. There is no automatic in-flight host migration or
exact cross-host crash resume; unknown workers require confirmed operator reconciliation.

## Verification and remaining acceptance

- The opt-in node dev/demo/handoffs.mjs executes actual Docker Git/Node and independent
  host Git/Node: base checkout, candidate import, same-SHA Review checkout, host tests,
  unchanged reference files, corrupted-transfer rejection and complete owned cleanup.
- Unit/integration coverage reproduces intermediate history retention, missing/tampered SDK
  evidence, orphan-worker cleanup, physical binding change, HTTP misrouting and shutdown
  callback ordering. A three-process SDK **contract** fixture exercises the real Workflow
  seal/test/Review/accept path and releases every lease; its SDK messages are simulated.
- The actual two-account Chromium/unchanged-platform/DSH check now includes Owner Harness/
  resource configuration, target PTY command/close, Member denial and accurate unavailable
  SDK probe status. It uses a deterministic native model and unconfigured SDKs, not paid
  three-Harness inference. HTTP endpoints are tested through the channel, not only services.
- Official SDK negative probes use isolated empty profiles and unreachable loopback
  providers, including no-tools configuration. Authenticated Codex/Claude/native mixed
  delivery, real return/rework/PR acceptance at M7 code still needs dedicated authorized
  profiles. These remain Not run; #20/#23–#25 stay open and implementation PRs draft.

M6 real-provider evidence remains valid for its exact historical executable commit; it is
not borrowed to mark changed M7 code accepted. See docs/m7-acceptance.md for the current
replay commands and explicit validation boundary.


## Rework workspace continuity
SDK Task-role aliases may retain their confirmed idle cwd across Attempts. A new immutable Workspace record names reusesWorkspaceId and original storageAttemptId, while the former record becomes retained. Cross-resource checkout still imports only sealed Git objects and reset/clean remains candidate-bound. Cleanup validates against the original storageAttemptId path and never removes a path another allocated alias uses. Configuration/root/repository changes do not reuse an old path or backend binding.

An unsealed same-base Developer draft may also be retained after confirmed exit; it is explicitly marked retainedDraft and never reset to its seed. A changed sealed candidate, dirty read-only checkout, unexpected HEAD or incomplete allocation refuses reuse. Retained drafts remain unverified and subject to ordinary path/commit/test/Review gates.

## Workspace baseline and explicit inputs — #2325

#2325 adds ensureCommits over the existing hash-verified bundle transport. Reused resource clones receive exact missing base/seed/upstream commits before checkout; registered workspace ownership and release checks still precede reuse. Materialization metadata distinguishes base, seed, expected/actual checkout and retained draft. Only explicitly admitted operator inputs travel; host object presence alone is not an input grant. Existing candidate/sealing/transport byte bounds remain.
