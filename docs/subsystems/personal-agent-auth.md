---
subsystem: personal-agent-auth
owned_paths:
  - core/src/host/personal-agent-auth.js
  - core/test/personal-agent-auth.test.js
---

# Personal-agent connection authentication — #2183

A connection represents a registered personal agent and its actual human owner.
It is separate from browser authentication, Project membership, and the existing
persistent safe/watch delegation. Internal and external identities use the same
Project authority checks; provider names and body identity claims grant nothing.

## Credentials and scope

The user issues an opaque fba_ connection token for explicit active Project
participations. Only its SHA-256 hash is persisted, with credential ID, owner,
agent, Projects, issuer/subject binding, generation and expiry. The plaintext is
returned once. TTL defaults to seven days, bounded to 60 seconds–30 days. Public
credential lists omit hashes and paginate with limit/after. Unknown protocol or
malformed generation/expiry/scope records refuse authentication. Authentication uses the existing member-session
header on POST /api/bot, validates current agent/user/account binding and expiry,
and checks the operator's existing platform principal checker where configured.
It does not borrow a browser cookie. Platform deployments need the established
background principal-check contract; missing evidence refuses authentication.

The module installs after authz, wrapping authentication, Project permission,
principal validation and endpoint policy. Effective permission intersects current
human membership, credential Project scopes, active participation and current
safe/watch grant. It does not infer access from the default-agent selection.
Unknown host/private endpoints are denied. Project list/query results retain
scope filtering; native private-agent history/full context cannot be borrowed by
another agent connection. Summary public Chief metadata remains available.

## Safe/watch and closure

Safe connections may read scoped facts, create a private impactful Task proposal,
and suggest Project closure. Proposals use stable agent/Project/request identity;
a changed intent with the same key conflicts. They create no Task until the human
explicitly approves via the existing proposal publication path. Approved Tasks
retain the agent/connection/participation origin and approving user.

Watch uses the existing projectAgentGrants per carrier; no second delegation
engine is introduced. personal-agent-delegation-set selects the owned participation
explicitly, so granting one agent does not grant another. Task publication records
actual agent/credential/participation/grant provenance from authentication, not
body metadata. Current human Project rank still gates configuration and delivery.
Delegated connections cannot self-grant, publish a safe proposal as its human, or
perform Owner's personal closure confirmation. Legacy delete/archive routes are
not an alternative delegated closure path.

The native private-agent project_agent_suggest_closure tool also permits a reasoned
recommendation in safe mode without making a Task. The host derives its current
carrier/participation; only Owner can personally double-confirm closure. Public
Chief/read-only consultation sessions cannot impersonate a user's private agent.

Revoking a connection/logout rejects that token without revoking other tokens,
browser sessions or the separate watch mandate. Revoking watch removes future
write authority and uses existing cancellation handling. Retiring/leaving fences
participation and associated grants. Accepted Project Tasks are not silently
cancelled because a transport disconnected. Unknown worker exit is never declared
safe by a credential transition; execution lifecycle is #2184.

## Native endpoints

All use the existing authenticated endpoint/payload transport.

| Endpoint | Caller / payload | Result |
| --- | --- | --- |
| personal-agent-token-create | Human owner: agentId, projectIds, optional ttlSeconds | token once, public credential metadata |
| personal-agent-token-list | Human owner: agentId, optional limit/after | public credential page and next cursor |
| personal-agent-token-revoke | Human owner: credentialId | revoked metadata |
| personal-agent-delegation-set | Human owner: agentId, projectId, mode safe/watch | existing delegation view |
| personal-agent-propose-task | Agent connection: projectId, title, criteria, projectTaskKind, requestId | private proposal, publishRequired |

Writes refuse read-only hosts. Validation or failed issuance cannot return an
active uncommitted connection. Hash comparison rejects malformed stored hashes.
Task-origin records persist with the original Task snapshot; generalized operation
receipts/events remain #2185 and transaction migration/recovery #2182.

Tests cover in-process authenticated HTTP and a real loopback TCP HTTP client,
privacy/scopes, proposal approval/replay, watch transitions, credential revocation,
expiry/account changes, spoofing, malformed credentials and reload. This is not
an official grok-bot/dots adapter or provider login verification. External endpoint
descriptors remain unverified; no outbound provider network request is introduced.
README/API publication stays deferred to #2189 after backend convergence.
