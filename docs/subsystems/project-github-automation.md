---
subsystem: project-github-automation
owned_paths:
  - core/src/host/project-github-app.js
  - core/src/host/project-github-connections.js
  - core/test/project-github-app.test.js
  - core/test/project-github-connections.test.js
  - core/test/fixtures/github-app.mjs
  - docs/github-automation.md
  - docs/role-github-apps.md
  - core/src/host/project-role-github.js
  - core/src/host/project-role-github-runtime.mjs
  - core/src/host/project-role-github-channel.mjs
  - core/src/host/project-role-github-cli.mjs
  - core/src/host/project-role-github-cli-entry.mjs
  - core/src/host/project-github-role-artifacts.js
  - core/test/project-role-github.test.js
  - core/test/project-role-github-sdk.test.js
  - core/test/project-github-role-artifacts.test.js
---

# Project GitHub credential providers (#2311)

The App provider plugs into existing project GitHub read/publication/Release brokers;
no second workflow, client API, credential database or executor is introduced.
It signs RS256 JWTs with the existing private-file boundary, verifies current
installation/repository/permissions before each operation, and mints single-repo
short-lived Tokens with bounded/coalesced host-only caching and key rotation.
No Token/JWT/key enters persisted state, public responses or models. #2365 permits
a short Token only in dedicated helpers/gh child environment, never generic SDK env.

Human Owner/Maintainer selection uses v1 github.connection/configure, pre-provisioned
IDs and expected revisions. Persisted per-repository Project references carry an
original committed Effect proof. Explicit disable and removed scope fail closed;
no Owner/ambient or personal-user fallback. Identity changes stop outstanding
publication/release work; same-App key rotation preserves logical identity.
Shared App identity grants no independent GitHub Review or merge bypass.

Tests cover RSA and modern Token formats, scopes, expiry, refresh coalescing,
rotation/restart, malformed responses, native/FBA/human selection authority,
durable runtime receipts and restart. Existing broker suites exercise both
providers with deterministic GitHub responses and real local Git. See the
[operator and identity contract](../github-automation.md); live App acceptance is separate.

The same selected connection now exposes bounded merge-policy metadata and carries
host `github.merge` reads/writes. Every request revalidates current credentials and
original publisher identity; changing providers or installation scope stops the
intent. Merge policy never grants a personal agent configuration rights. See
[merge operations](../project-merge.md) and the opt-in disposable own-fork probe
`dev/demo/github-merge.mjs` (actual transport, no independent model review claim).


## Role execution (#2365)

Trusted repository `roleGithub` configuration binds roles to existing named App
connections, explicit base allowlists and revisions. Original installation validation,
least permissions and refresh apply. Every credential request fences current claim,
Task/Attempt/role, SDK/native worker, resource/lease/generation and connection scope.
Safe status exposes identity reuse, never a private path or grant. Dev/Reviewer require
explicit Apps; optional roles get no credential when unassigned. Same App is not
independent approval, even with distinct installation IDs.

Resource-local git/gh wrappers use a private FIFO and original worker stdin protocol;
auth frames bypass SDK history/event logs. Only helpers and gh children receive Tokens.
Concurrent executions have separate directories/config/author identities. Native roles
reuse shellEnv and withhold saved Owner secrets. This extends the earlier host-only
boundary by [Owner decision](../../decisions/2026-11-04-role-github-apps.md).

Artifact admission independently observes actual Git ancestry/cleanliness/author and
committer, remote repository/head/base/SHA/creator/marker. Review observations require
the exact current role Session marker and candidate; checks require the Tester scope.
Original candidate Effects retain SDK SHA and PR; no model URL or textual approval is
trusted. Merger identity is distinct from Dev creator identity and remains selected
host App policy. End/revoke/unknown execution stops renewal; expiry metadata does not
prove remote revocation. Wrappers are not branch-scoped GitHub credentials or a new
OS trust boundary. See [configuration and recovery](../role-github-apps.md).

## Reviewer Actions access (#2378)

Reviewer installation grants add actions:read only; workflows cannot be rerun, dispatched or edited through git/gh wrappers. gh run view/list and existing scoped gh api support autonomous evidence reads. Downloads outside the default GitHub hosts require an explicit bounded exact downloadHosts list under roleGithub. Provider/tool/network/permission failures have safe distinct diagnostics, with no personal-token fallback or provider stderr disclosure. Publication status distinguishes blocked-on-binding from the current candidate binding; metadata is not Review evidence.
