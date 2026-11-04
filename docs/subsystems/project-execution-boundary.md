---
subsystem: project-execution-boundary
owned_paths:
  - core/src/host/project-execution-boundary.js
  - core/src/host/project-execution-profile.js
  - core/test/project-execution-boundary.test.js
---

# Trusted private execution boundary (S5)

The supported profile is `trusted-private-single-host/v1`. Omission selects this
compatibility default; an explicitly different value is refused by repository
preflight and resource access before execution. Existing deployments require no
account, credential, sandbox, resource or state migration for the default.

| Boundary | Authority/evidence |
| --- | --- |
| Human operation | Current Project role, Task requester and current delegation |
| Bot role | Persona, policy/memory and host-validated current claim/handoff |
| Harness capability | Explicit resource/profile/model, adapter and lease |
| OS security | Operator-managed account/container; shared UID/cwd wrappers do not isolate hostile code |

One dedicated non-root service account may run trusted local role Sessions.
Per-Task worktrees/branches and private scratch remain; per-Bot OS users or
containers are not required. Existing explicit Docker resources are optional.
The service observes its UID but cannot infer a dedicated account or the UID of
another transport. It does not provision or relax an OS/SDK sandbox.

Trusted means operator-approved code/dependencies can use that account's actual
capabilities. A shared UID cannot protect reachable files from arbitrary malicious
code. Prompts, cwd checks, path restrictions and SDK approvals retain their real
purposes, but do not constitute hostile multi-tenant isolation. Untrusted repositories
or mutually hostile tenants require separately scoped account/container/VM,
credential/filesystem/network boundaries. This profile cannot claim them through a
label or by silently disabling necessary tools.

## Query and preflight

`execution.boundary {taskId?}` returns read-only profile, current permission matrix,
this human's safe/watch configuration/effective grant, authorized resource IDs and
existing health observations, exact Project/current-human credential selection,
repository preflight and unchanged correctness invariants. It creates no Bot,
lease, workspace, account, login, approval or test evidence. Paths/secrets and other
humans' private profiles are omitted. It reads no private-memory contents.

Host UID does not prove dedication; resource health is an existing timestamped
observation, not a fresh SDK call. Credential presence is configuration only: the
broker verifies the selected identity at invocation. Tests/SDK are explicitly
not-run. Query output grants no operation. Current principal, Project and Task
bindings are checked again after asynchronous reads; revocation/movement withholds
the response. An old watch grant is ineffective when its human identity changes.

Original repository preflight checks registered repository, allowed paths, fixed
test argv/dependencies and writable storage before inference/allocation. Resources
retain current grants and environment/auth readiness. The trust-profile guard is
shared by both entrances and included in readiness cache identity. Unsupported
profiles do not silently fall back to trusted execution.

## Current rights, data and correctness

Safe mode proposes Tasks and requires human publication authorization. Watch mode
uses only that human's current rights; removal/demotion blocks new privileged work.
Background execution requires the existing supported local principal or configured
platform principal checker, not an expired browser cookie. API, tools, schedules,
Effects/retry and callbacks keep their current-identity, delegation, Task/resource,
generation and stop checks. Personal Chief, public agents and group contracts stay.

Project publication uses explicit Project automation. Personal comments select
exactly human×Project and verify login; SDK credentials come from the admitted
profile. Ambient/root/other-human login is not a fallback. Public role context
contains explicitly shared memory; private memory stays behind original current-user
APIs. The resource/profile owner and acting human are different reported identities.

Leases, physical bindings, generations, confirmed old-process exit and exclusive
registered workspace ownership remain mandatory even for trusted Bots. Neither
trust nor watch permits two writers, late stale results or fabricated verification.
Tests, independent role Review and PR head bind to one candidate; Chief adjudicates
completion. Capability metadata is not candidate acceptance.

Boundary tests cover local execution without per-Bot identity, current three-role
permissions, safe/watch/stale grants, removal/demotion, exact personal credential
selection, pre-allocation profile refusal and async revocation/binding changes.
Existing workspace/resource/Session/effect/delegation/credential/private-agent suites
retain double-writer, unknown-exit, stale-generation, revoked-retry and private-data
negatives. Actual dedicated-account queries and full validation are recorded
separately from SDK/transport mocks and complete application acceptance.

No live configuration migration is part of S5. Operator profile/resource/credential
changes use an idle, binding-aware deployment checkpoint. Do not change profiles
under active workers and expect cleanup to bypass their recorded protections;
preserve evidence and use supported exit reconciliation.

## GitHub App credential adaptation — #2311

Automation metadata now identifies gh-cli/App provider configuration without reading keys or probing GitHub; no credential source is inherited by role SDKs. See [GitHub providers](project-github-automation.md).
