# Earlier runtime and recovery checkpoints

Preserved verbatim from PROJECT.md; relative links retain their original repository-root context. Historical progress grants no new authority.

## SDK authentication — 2026-11-04

#2398 binds readiness and setup to the existing resource profile, preserving its
paths and Task-role context. Known SDK authentication failures reach authRequired
without becoming code verdicts. No OAuth broker, credential copying or live login.

## Role App delivery — 2026-11-04

#2365 opts Project roles into explicit App connections and dedicated short-lived
credential helpers. Original candidate Effects observe SDK commits/PRs without
resealing; actual App Review and host merge/Chief acceptance stay separate.
No Owner fallback or live migration. [Decision](decisions/2026-11-04-role-github-apps.md)
and [operator contract](docs/role-github-apps.md); live App acceptance requires authorized installations.

## Follow-up reliability delivery — 2026-11-04

Owner authorizes sequential #2336/#2337/#2334/#2346/#2338/#2347/#2331/#2342
implementation, one PR each, tests/memory/docs and validated merge to the delivery
branch. #2336 establishes owned reservation rollback and a durable pre-spawn fence;
unknown execution, workspace/context and current authority remain protected.
#2337 validates the actual SDK-resolved CLI and role profile before inference;
configuration readiness is separate from model/test/exit evidence.
#2334 separates executor dependency readiness from host test outcomes and preserves
same-candidate retry evidence; remote unknown exit retains preparation occupancy.
#2346 admits cwd-only Task-role restoration with current binding/exit proof and
explicit resumed/reconstructed identity; clearing bindings never resets context.
No live task/configuration/credential mutation or deployment is implied.

## Execution recovery — 2026-11-04

#2325 aligns actual reused SDK/resource checkouts with pinned baseline/seed facts,
preserves drafts and admits explicit inspect/integrate inputs through existing
Effects. Chief selects only approved repository sources. #2327 adds bounded, durable Chief protocol correction in the resident Session;
exhaustion retains incomplete judgement without automatic escalation. Follow-ups:
#2328 adds confirmed-idle wait suspension and FIFO continuation re-admission
through the original queue; exit-unknown capacity remains held. #2330 adds durable scheduled inspection reconciliation, configured deadlines,
exit-proven bounded recovery and health visibility; independent Task refusals do not
abort other decisions. No automatic business escalation or live rollout. See
[delivery contract](docs/subsystems/project-delivery.md). Live Task mutation and
deployment remain separate from source/test delivery.

