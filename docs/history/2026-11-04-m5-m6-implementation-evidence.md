# Earlier M5/M6 implementation evidence

Archived verbatim from PROJECT.md to preserve the existing required-role policy
byte limit. Governing boundaries, authorization and pending acceptance stay active.

- M5 implements the standalone shared Project workbench, restricted gateway, durable
  quota admission and actual acceptance/resource metrics. It reuses unchanged platform
  services and the existing Workflow executor. See [M5 decision](decisions/2026-10-31-m5-project-workbench.md).
  Browser/live-model acceptance is tracked separately in M6; no deployment is implied.

- M5 ([PR #15](https://github.com/zy95-12/FlyBot/pull/15), full local verify passed) supplies
  the actual shared Project UI/gateway and quota admission. M6 adds a clean two-account
  Chromium/DSH/platform runner and foreground demo launcher, plus the Project Chief
  dispatch fix found through that fresh entry. See [shared demo](docs/shared-demo.md) and
  [M6 decision](decisions/2026-10-31-m6-shared-demo.md). True-model full delivery acceptance
  subsequently passed; see the [live acceptance record](docs/live-acceptance.md). Earlier deterministic evidence remains separately labeled.

- The owner supplied an official DeepSeek credential for live validation. Official model
  catalog, inference and full live browser/GitHub acceptance passed at `f126f8c`.
  Credentials are process-only and are never repository memory. Integration fixes include
  model-visible JSON tool results, same-request Task/proposal deduplication, bounded unique
  carrier names, and propagation of human-return feedback into retry snapshots.

- Real-provider acceptance completed with two platform accounts, real role worktrees,
  independent host tests/Review and GitHub artifact PRs #18/#19, browser return/follow-up/accept,
  failing tests/retry/queue/revocation and cleanup. [Evidence](docs/live-acceptance.md) and
  [owner decision](decisions/2026-10-31-real-provider-acceptance.md). Implementation PR #16
  contains the integration fixes and regressions; review/CI/merge remain separate.


