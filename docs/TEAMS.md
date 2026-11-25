# Team wizard (create or convert)

Self-written for FlyBot. The first step typography follows the 2026-11-16 Teamily contrast at `/new/team`: name length (≤60), Team ID pattern (3–30 lowercase letters, digits or hyphens), and the choice between a new independent workspace and converting the current one. Name, Team ID, and both create-mode cards sit on that recorded first step; 继续 stays disabled until both fields are valid. Team roles and invites were not comparable on a free personal account and are not claimed as parity.

## Routes

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/teams` | `{name,slug,mode}` with `mode=new` or `mode=convert` plus `workspace_id`. Owner session, CSRF, exact Origin, and `Idempotency-Key` required |
| GET | `/v1/workspaces` / `{id}` | Now also returns `kind` (`workspace` or `team`), `slug`, `team_name`, and `converted` |
| GET | `/team` and `/new/team` | Same-origin wizard page. `/new/team` is the recorded Teamily path; `/team` is kept |

`slug` must match `[a-z0-9][a-z0-9-]{1,28}[a-z0-9]` and must not be a reserved path name (`settings`, `team`, `new`, `v1`, …). Convert is owner-only; members, instances and the workspace id stay in place. A converted workspace is renamed to the team name. Additive `workspace_teams` / `team_requests` tables on schema `user_version` 1.

The recorded first step is served on this page. Steps 2 and 3 were not recaptured, so after 继续 the page shows an honest unverified continuation that still posts to the existing `/v1/teams` API. That continuation is not a typography claim, and this is not a Teamily team-roles comparison. Unknown paths under `/new` return 404; `new` remains a reserved slug.
