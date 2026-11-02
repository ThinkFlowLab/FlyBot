---
subsystem: project-delegations
owned_paths:
  - core/src/host/project-delegations.js
  - core/test/project-delegations.test.js
  - dev/demo/platform-principal.py
---

# Safe mode and persistent user watch delegation

`project-agent-mode {projectId,mode:safe|watch}` is a signed-in human operation.
The private Project agent defaults to safe mode: Task tools return private proposals
and publication needs explicit human approval. Public Chief likewise proposes
unless its current human request explicitly authorizes publication. Ordinary
queries stay conversation handoffs in both modes.

Watch mode records an independent, revocable grant for one human and Project.
It contains identity issuer/subject, logical agent ID and generation, never a
browser cookie, password or browser session proof. Signing out does not revoke
the grant; host restart does not erase it. Safe mode revokes it and stops the
matching personal-agent turn. Membership removal revokes it; account disable or
identity changes deny subsequent operations. Grant creation/revocation does not
require a live model or a surviving Bot carrier.

## Current human authority

Each tool derives its actor from the current own Session and host delegation.
A watch grant substitutes a persistent actor only after current account and
Project checks. The actor carries the exact grant/generation, and Project guards
recheck it synchronously at writes. Role labels never confer Owner rights.
Watch publication, run, configuration, Task operations, scoped GitHub comment and
resource/runtime operations use the same current human permission checks, with
no extra agent-only approval. Targets are forced to the delegated Project; Task,
Attempt and queue references are checked. Unsupported global/auth/merge/release
operations are not exposed by this Project agent interface. Existing repository
CI, independent review, secret and release gates continue to apply.

`project_agent_action` exposes the existing scoped human operations in watch mode.
Action audits bind human, agent, grant, endpoint, argument hash and confirmed
result. Task publication and personal GitHub writes also retain agent provenance.
The private prompt v3 reports safe/watch behavior. `wakeWatch` allows a trusted
host/schedule wake without a browser, after revalidation of the same grant.

## Platform account status without browser sessions

The current unchanged control-plane exposes active account state through browser
sessions or the admin user directory; it has no machine account-status endpoint.
Watch mode therefore requires operator configuration
`controlPlane.principalCheckCommand`, a fixed absolute argv, not model input.
The command gets a bounded subject/nonce request on stdin and must return matching
`platform-principal/v1`, subject, nonce and active status. The host clears inherited
credentials, bounds output/time and checks every operation without a positive
cache. Missing setup or failed/mismatched evidence denies watch execution.

FlyBot supplies `dev/demo/platform-principal.py` for the current SQLite deployment:
run a root-owned copy under the DB owner via an exact operator sudo command. It
opens the existing DB with `mode=ro` and `query_only`, reads only `users.status`
for the parameterized subject and returns active/unavailable. It reads fresh WAL
state; `immutable=1` would incorrectly ignore recent account revocation. No admin
password, password hash, email or full directory is returned. The control-plane
source/schema is not modified. This explicit adapter must be updated/verified if
the platform schema changes; a future supported platform directory API can replace
it without changing the grant contract.

Background Task handoffs also revalidate the initiating account and current
Project membership. With no principal checker, a nonpersistent Task may use its
still-live initiating platform session; that is not a watch grant. Revocation
fences claims before stopping workers and keeps unconfirmed capacity. Published
Task history and previous Attempts remain intact.

Repair R6 background Chief jobs use the explicitly configured current human and
fresh principal checks, separate from private watch grants and browser cookies.
Revoked authority or policy revision rejects late decisions.

## Independent agent participation

#2170 associates legacy private carriers with user-owned agents and isolated Project
participations. Grant validation rechecks active participation; leave/retire revokes
only matching carrier grants after persistence and uses existing stop handling.
Default-agent selection does not transfer a grant to a different carrier. Private
histories remain readable to their owner without reactivating execution authority.

## Scoped connection integration

personal-agent-delegation-set reuses mode() with an explicitly owned participation, rather than changing the default to borrow another carrier grant. Grant validation checks actor/carrier binding when supplied. Agent/delegated identities cannot change their own mode. Connection logout and mandate withdrawal remain distinct.
