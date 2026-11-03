---
subsystem: project-github-automation
owned_paths:
  - core/src/host/project-github-app.js
  - core/src/host/project-github-connections.js
  - core/test/project-github-app.test.js
  - core/test/project-github-connections.test.js
  - core/test/fixtures/github-app.mjs
  - docs/github-automation.md
---

# Project GitHub credential providers (#2311)

The App provider plugs into existing project GitHub read/publication/Release brokers;
no second workflow, client API, credential database or executor is introduced.
It signs RS256 JWTs with the existing private-file boundary, verifies current
installation/repository/permissions before each operation, and mints single-repo
short-lived Tokens with bounded/coalesced host-only caching and key rotation.
No Token/JWT/key enters persisted state, public responses, models or SDK environments.

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
