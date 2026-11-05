# Retain current state when durable reads are refused

Date:2026-11-05 Asia/Shanghai. Class:ordinary reliability repair.

Owner authorized staged #2483 implementation into delivery/ai-centric-development-service. A regression on54a72ebf proves that failed SQLite refresh could clear live Task/Session references. Preserve them while denying writes. Add safe read-only verification through the existing private CLI and state-write readiness separate from liveness. No hash repair, new state authority, automatic Task progress, permissions expansion or live mutation.

New ops evidence separates historical revoked events from the current process and identifies current queued dispatch and unhandled-input refusal; these remain distinct follow-ups. This patch does not attribute the live hash error or treat readable raw SQL as proof of application integrity.

See [#2483](https://github.com/ThinkFlowLab/FlyBot/issues/2483), [storage](../docs/subsystems/project-state-storage.md).

Written-by: Codex
