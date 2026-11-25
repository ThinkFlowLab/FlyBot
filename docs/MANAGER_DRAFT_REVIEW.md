# Deployment draft integration review

Input: Deployment's standalone manager-compose-runtime draft and
API-COMPATIBILITY.md, based on8c95089, with **33 fake-only tests**. Reviewed as
implementation input, not runnable/container acceptance. No old/private control-plane
or upstream runtime source/assets were imported. This follow-up is new manager code
against fixed parent2729dc6; the contributor draft remains untouched.

| Draft gap verified in review | Follow-up treatment |
|---|---|
| Real HTTP/subprocess runners deliberately disabled; worker accepts fake only | Actual default-off direct local HTTP and bounded subprocess runner; explicit config + CLI opt-in. Tests execute real subprocesses against a temporary stub, not Docker. |
| Planning claim returns501 | Separate digest-pinned executable `compose` profile/grants/server flag; original planning mode still cannot execute. |
| create mapped to up/running | Create command only, require present/stopped engine state before receipt. |
| Restart identity uses container ID alone | Hash full ID + StartedAt, compare real before/after and server previous identity; one restart command; stopped existing restart supported. |
| Heartbeat after60s command, lease30s | Lease guard during child IO and readiness; lost renewal kills manager-owned subprocess and never sends observe. |
| Missing project labels inferred; running treated ready | Require exact project/service/image/volume/security metadata and actual healthy healthcheck; fail closed on absent metadata. |
| Registry image not tied to actual arbitrary Compose file | Canonical generated JSON from bounded operator-only fields; no arbitrary Compose path, env, image/command/mount override; revalidate content/path/permissions before use. |
| Spawn validation allows extra flags | Commands constructed from an exact internal mapping; no returned/user argv is accepted for execution. Private Unix Docker host and clean env. |
| Claim not bound to requested ID / complete operation | Validate requested target, mode, revision, operation ID/type/status/desired and previous process identity before executing. |
| Draft reads top-level error code/message but API errors nested | Read nested code only; never expose remote message/body/credentials. |
| Fake HTTP did not exercise real Host validation | Private configured server Host matches management origin while the socket target stays numeric loopback. No Origin/cookie bypass or weakened server validation. |
| Logs truncate before filtering, miss quoted passwords/API keys | Capture bounded whole text, fail on overflow; redact before output; known-secret + quoted-key + bearer/key/token filtering; operator-only, not a DLP guarantee. |
| Recovery has no API and always unsupported | Explicit scoped/CAS/idempotent recovery API queues a NEW STOP, with normal lease/observe. No unleased stop, DB bypass or uncertain operation replay; requires operator quiescence attestation. |

## Test and claim boundaries

New tests add actual loopback HTTP and subprocess/CLI-stub integration, alongside
focused schema/authorization/path/metadata/output/timeout/health/restart/recovery
and HTTP redirect/proxy/deadline defenses. They do not execute Docker, pull an
image, mount a real volume or establish application health/FlyBot compatibility.
The environment lacked the Docker binary/standard sockets. Real acceptance is a
separate gate, with a safe repeatable stub script and opt-in isolated-stage script.

See [COMPOSE_MANAGER.md](COMPOSE_MANAGER.md) for runnable-path setup, exact limits,
operator recovery semantics and the **remaining** real runtime/log API/supervisor/
licensing/Teamily comparison tasks. This is not overall issue2 completion.
