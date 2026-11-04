# Role-bound GitHub App execution

- **Date:** 2026-11-04.
- **Decision maker:** fork Owner zy95-12, #2365 and explicit instruction to implement it.
- **Class:** major, accepted for the delivery branch.
- **Decision:** Dev/Reviewer use explicitly configured installation Apps through a
  dedicated execution credential channel. SDK/native git/gh operate directly;
  the host admits actual artifacts through original Effects and preserves the SDK SHA.
- **Reason:** host-only publication attributed development to one automation/user
  identity and could replace the SDK's published commit before tests/review.
- **Boundary:** this narrowly extends #2311/#2331 host-only credentials. Private keys
  stay host-only; short Tokens reach only scoped helpers/gh children, never ordinary
  role environment/state/prompts. App-bound native roles withhold saved Owner keys.
  Same-App tokens/installations are not independent Review identities. Host merge
  retains explicit App/base/check policy; signed forge PASS and Chief closure stay separate.
- **Alternatives:** Owner/PAT fallback and a host business endpoint for each git/gh
  action were rejected. Branch-level security remains real repository policy;
  wrappers do not turn installation Tokens into branch-scoped credentials.
- **Rollout:** opt-in trusted configuration, no live migration/App registration or
  deployment. Source/fixture/actual SDK verification and authorized live App writes
  are reported separately. See [operator contract](../docs/role-github-apps.md).
