# Resource SDK authentication feedback

- **Date:** 2026-11-04.
- **Decision maker:** fork Owner zy95-12, explicit instruction to fix and merge.
- **Class:** major documentation update, accepted for the delivery branch.
- **Decision:** bind existing readiness/setup/worker metadata to the actual resource
  profile; preserve known safe SDK authentication errors and existing authRequired.
  Keep existing generated directories and Task-role Session binding semantics.
- **Reason:** host and container can use independent login caches, while cached
  readiness and generic SDK failures conceal the actual authentication target/cause.
- **Boundary:** no OAuth refresh broker, automatic credential copy, new recovery
  routing or changed sandbox policy. Only existing authorized terminal administrators
  receive actual setup paths. Native SDK owns login/refresh and its persistent cache.
- **Validation:** deterministic model failures, actual SDK/CLI with an isolated
  provider, and real PTYs verify protocol/target behavior. They do not repair or
  establish validity of the live container OAuth cache; no login or deployment occurs.
