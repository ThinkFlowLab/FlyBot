---
subsystem: personal-agents
owned_paths:
  - core/src/host/personal-agents.js
  - core/test/personal-agents.test.js
---

# User-owned personal agents — #2170

PersonalAgent is a user-owned identity independent of Project. Internal and external
registrations do not require a Project. A participation joins that identity to an
existing member's Project with a separate context scope and conversation carrier.
Membership grants no extra agent privilege; a user's own agent can join without a
second admission approval. A default participation selects exactly one private
recipient, never broadcasts work. Permissions remain scoped by the represented
human and current Project membership.

## State and migration

personalAgents holds stable identity, owner, kind/status and private memory scope.
personalAgentParticipations holds agent/owner/Project, status, carrierId and
contextScopeId. personalAgentDefaults selects a participation per user/Project.
Tables are read at call time. Load migration relates legacy private Project agents
to a stable user identity, preserving carrier, Bot, Session, notes, transcripts,
proposals and grants at their existing keys. It does not merge private histories.
Selecting another agent uses a separate carrier/context, not another user's notes.
Native carriers record personalAgentId and participationId; scoped tools recheck
active participation before and after asynchronous identity checks.

## Native endpoints

All use the existing authenticated POST /api/bot with endpoint/payload. The actual
user is from authentication; body owner/member fields cannot select another user.

| Endpoint | Payload | Result |
| --- | --- | --- |
| personal-agent-create | name, optional kind (internal/external); external provider and HTTPS endpoint | agent |
| personal-agent-read | agentId | own agent, including retired identity |
| personal-agent-list | optional limit 1–200, after | own agents, next cursor |
| personal-agent-join | agentId, projectId | agent and participation |
| personal-agent-default | agentId, projectId | selected active participation |
| personal-agent-participations | optional limit 1–200, after | own participation page |
| personal-agent-history | agentId, projectId, optional offset/limit 1–100 | own private transcript page, nextOffset |
| personal-agent-leave | agentId, projectId | inactive participation, retained history |
| personal-agent-retire | agentId | retired identity and participations, retained history |

Writes reject read-only hosts and require the current user, not a Bot/delegated
identity. Joining/default selection rechecks current Project rights. Leaving or
retiring fences its carriers, revokes only their watch grants and requests existing
watch cancellation; it never reports unknown workers exited. An ended default is
not silently rejoined by reading a legacy agent endpoint. Private transcript reads
remain available to their owner, without injecting them into shared context.

External registration stores a descriptor with status unverified. It performs no
network request, stores no credentials and does not imply grok-bot/dots login or
provider execution succeeded. Selecting an external identity cannot silently
instantiate a native model in its place. External authentication/transport is
separately delivered under #2183/#2185. Compatibility with existing personal Chief
carriers and broader migration remains #2186; runtime lifecycle remains #2184.

Tests distinguish local contract/HTTP and migration validation from actual model
and external-provider acceptance. The README/API publication stays deferred to
#2189 after final backend interfaces stabilize.
