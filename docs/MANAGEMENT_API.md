# Management API — PR16 foundation snapshot

This document describes the frozen PR16 slice. The separate stacked lifecycle follow-up is documented in [RUNTIME_IMPLEMENTATION.md](RUNTIME_IMPLEMENTATION.md); statements below about absent lifecycle APIs refer to PR16, not that follow-up. Planner integration tests in the follow-up additionally require Node18+.

Related: #2 (lifecycle MVP, **not completed**) and #1 (full parity). This PR is a real authentication/workspace API, not a schema-only mock, but it does **not** run or manage containers yet.

## Stack and execution

Python 3.11+ standard library, SQLite, WSGI, unittest. No pip packages, copied upstream source or private control-plane implementation. POSIX file ownership/mode and `O_NOFOLLOW` support are required. Local tests use Python 3.13; CI exercises 3.11/3.13 separately.

```sh
python3 -m unittest discover -s tests -v
python3 -m compileall -q flybot-workspace tests
python3 -m flybot_workspace.server --help
# Optional local development, run by the operator; not started by tests:
python3 -m flybot_workspace.server --data-dir .state \
  --origin http://127.0.0.1:8080 --insecure-local --open-registration
```

The bundled runner binds **127.0.0.1 only**, has a five-second connection timeout, disables request logging, and is a development runner, **not an internet-facing production host**. This PR does not install a reverse proxy, expose a public port, modify firewall rules, or operate Docker. An audited WSGI host/TLS ingress, resource policy and deployment acceptance remain required before public use. Never mount a Docker socket in the Web process.

HTTPS origins use `__Host-ot_session` (Secure, HttpOnly, Path=/, SameSite=Strict, no Domain) and `__Host-ot_csrf` (same policy but readable by a same-origin client). Explicit `--insecure-local` uses differently named `ot_dev_*` cookies and is refused for non-loopback origins. It is a development-only downgrade, not a TLS substitute. Configure the exact lowercase origin without a trailing slash/path. Host is checked; untrusted forwarded headers are not accepted as identity or Origin evidence.

Registration defaults **closed**; `--open-registration` enables bounded public registration for bootstrapping/development. Close registration after initial accounts if not desired. No invitation-based registration, password recovery, MFA, email verification or account-administration UI is provided yet. Do not treat this as a production-ready identity provider.

## Implemented routes

All responses are JSON and no-store. There is no CORS support. Errors are `{error:{code,message}}` without stack, SQL or private paths. `GET`/`POST` only.

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/auth/register` | `{username,password}`; creates a salted password hash and a new session, if registration is enabled |
| POST | `/v1/auth/login` | Same fields; new session, generic refusal for nonexistent/wrong credentials |
| GET | `/v1/auth/providers` | Enabled third-party login providers (no secrets); see [OIDC.md](OIDC.md) |
| GET/POST | `/v1/auth/oidc/*` | OAuth/OIDC start, callback and account linking; see [OIDC.md](OIDC.md) |
| GET | `/v1/auth/session` | Current user and expiry only; no session/CSRF secret in JSON |
| POST | `/v1/auth/logout` | `{}`; valid Origin and CSRF required; revokes the server-side session and clears cookies |
| POST | `/v1/teams` | Create a team as a new workspace or convert a current one; see [TEAMS.md](TEAMS.md) |
| POST | `/v1/workspaces` | `{name}`; owner is server-derived, never caller-selected; requires `Idempotency-Key` |
| GET | `/v1/workspaces` | Owner-only bounded page: `limit=1..100` (default20), optional UUID-hex `cursor` |
| GET | `/v1/workspaces/{id}` | Owner-only read; other owners and nonexistent records both get404 |
| GET/POST | `/v1/admin/model-api` | Platform default model API (operator bearer); see [MODEL_API.md](MODEL_API.md) |
| GET/POST | `/v1/model-api` | Account model API override and effective config; see [MODEL_API.md](MODEL_API.md) |
| GET/POST | `/v1/workspaces/{id}/model-api` | Optional workspace override; see [MODEL_API.md](MODEL_API.md) |
| GET/POST | `/v1/admin/bot-social` | Platform default Bot Social server URL (operator bearer); see [BOT_SOCIAL.md](BOT_SOCIAL.md) |
| GET/POST | `/v1/workspaces/{id}/bot-social` | Optional workspace Bot Social server URL; see [BOT_SOCIAL.md](BOT_SOCIAL.md) |
| GET/POST | `/v1/skill-secrets` | Write-only skill secrets for the signed-in account; see [SETTINGS.md](SETTINGS.md) |
| GET/POST | `/v1/settings` | Per-account interface preferences with revision check; added after PR16, see [SETTINGS.md](SETTINGS.md) |
| GET | `/v1/workspaces/{id}/overview` | Signed-in home summaries: real counts, recent own conversations, artifacts and meetings, unread notifications; no bodies, prompts or transcripts. See [HOME.md](HOME.md). A same-origin page is at `/` |
| GET/POST | `/v1/workspaces/{id}/members` | Membership and roles; added after PR16, see [MEMBERS.md](MEMBERS.md). List/get workspaces include membership, not only ownership. A same-origin page is at `/members` |
| GET/POST | `/v1/workspaces/{id}/invites` | Invite links; added after PR16, see [INVITES.md](INVITES.md) |
| POST | `/v1/invites/accept` | `{token}`; signed-in caller joins the workspace |
| GET/POST | `/v1/runtime-keys` | FlyBot connection keys and device ID; token shown once, lists are prefix-only, see [RUNTIME_KEYS.md](RUNTIME_KEYS.md) |
| GET/POST | `/v1/runtime/connections`, `/v1/runtime/tasks` | Own-machine connection status, echo/infer dispatch, cancel; see [RUNTIME_KEYS.md](RUNTIME_KEYS.md) |
| GET/POST | `/v1/agent/*` | Runtime-key agent connect, heartbeat, task transport and one-time model-access; Bearer only, cookies rejected |
| GET/POST | `/v1/workspaces/{id}/artifacts` | Workspace documents, static websites, media files, and whiteboards: list, create, read, edit, remove, preview, file download, revision history, attachment export, restore, and explicit revocable read-only shares. See [ARTIFACTS.md](ARTIFACTS.md) |
| GET/POST | `/v1/workspaces/{id}/memory` | Workspace memory pages, topics, relationship graph and next actions. See [MEMORY.md](MEMORY.md). A same-origin editor and overview are at `/memory` |
| GET/POST | `/v1/workspaces/{id}/automations` | Configuration, explicit or background tick, run records, cancel and durable results. See [AUTOMATIONS.md](AUTOMATIONS.md) |
| GET/POST | `/v1/workspaces/{id}/agents` | Workspace agent directory: create, list, read, edit, and archive records. Distinct from `/v1/agent/*` runtime transport. See [WORKSPACE_AGENTS.md](WORKSPACE_AGENTS.md). Conversations: [AGENT_CONVERSATIONS.md](AGENT_CONVERSATIONS.md). Public homepages: [AGENT_HOMEPAGES.md](AGENT_HOMEPAGES.md). Container binding: [AGENT_RUNTIME.md](AGENT_RUNTIME.md). A same-origin page is at `/agents` |

Register/login require exact `Origin` and reject cross-site Fetch Metadata even before any session exists. All authenticated POSTs require exact Origin, a readable CSRF cookie and the matching `X-CSRF-Token` header, both bound to the current session's stored digest. The session token is not accepted as CSRF or a bearer token. Old sessions are revoked on logout/expiry and the oldest are evicted when exceeding a per-user session cap.

Usernames: 3–64 ASCII letters/digits/underscore/dot/hyphen, first character alphanumeric, normalized lowercase. Passwords: 12–256 characters and at most256 UTF-8 bytes; never normalized or truncated. Scrypt-v1 uses N32768/r8/p3, independent random 16-byte salt, 64-byte output and 64MiB OpenSSL allocation ceiling. Password verification parameters cannot be chosen from the API or a corrupted hash record. Missing users still run one dummy KDF. This is implemented protection, not an independent security review.

Workspace names: 1–80 Unicode characters after trimming, no control characters. IDs are independent UUID hex strings. Responses contain `id,owner_id,name,created`. Memberships and roles were added after PR16; see [MEMBERS.md](MEMBERS.md). Creation requires a 16–64 character alphanumeric/underscore/hyphen `Idempotency-Key`. Same owner+key+normalized name returns the original workspace (200 vs initial201), including after restart. Different payload with the same key returns409. Another owner using the same key gets an independent record. Pagination is bounded keyset order by UUID, not chronological order or a frozen multi-page snapshot.

## Bounds and state

Defaults in `Config` are replaceable trusted-operator choices, not user-mandated architecture:

- Body16KiB; route256 and query512 characters; cookie4KiB; duplicate JSON/cookie keys, unexpected fields, transfer-encoding and malformed lengths are refused.
- Registration/login share persisted ten-minute buckets:20/peer address,10/username,100/global; at most4096 live buckets. Failed credentials count; expiry releases buckets. `Retry-After` is conservative. The direct WSGI peer is used; behind a proxy this may limit all callers together. Trusted proxy-aware/distributed limiting is not implemented.
- Maximum1000 accounts,8 sessions/account,8192 active stored sessions,12-hour expiry;20 workspaces/account and10000 global. Active state caps are not a hard filesystem-byte budget. Rate buckets and expired sessions are cleaned on authentication writes; offline maintenance/compaction is still operator work.
- SQLite transactions make workspace creation+idempotency atomic across threads/processes. Busy/error storage returns503; no success is invented. No external calls are made by this application.

The database directory must be owned by the process user and mode0700; DB regular file mode0600. Symlinked paths/database files, public permissions, unrecognized nonempty databases and unsupported schema versions fail closed. SQLite WAL/SHM state also belongs in this private directory. POSIX file permissions do not protect against a compromised process/OS account, root, malicious administrator or leaked filesystem backup.

Schema is **version1**. There is no upgrade/downgrade migration tooling or automatic backup/restore. Back up with an operator-reviewed SQLite online-backup procedure preserving private permissions, or stop **all** writers before an offline directory copy; do not copy only the DB while WAL writes are active. Runtime backup/upgrade/purge is a separate unimplemented capability. Do not put this data directory or cookie jars into git. At-rest encryption is not implemented.

## Explicit remaining work

Instance registration/lifecycle/jobs, desired/revision/operation_id, manager credentials/leases, fake backend, Compose CLI integration, logs and volume retention are **not implemented**. Authenticated requests to reserved runtime paths return501/unsupported; that is not a functioning manager endpoint. No launch-token or third-party Social integration is present. Existing user cookies do not become manager credentials.

The separate Compose planner may remain dependency-free Node code; no planner or command execution is duplicated in this Python Web layer. The next slice must wire durable jobs and test the revised target contract in `SERVER_CONTRACT.md` before any real execution. Backup/restore/upgrade/reclaim/purge remain unsupported.

## Acceptance and Teamily comparison

This PR's automated evidence is in-process WSGI + temporary SQLite, with no listening socket or container. Self-authored unit tests are not independent acceptance, browser verification, a fake-runtime pass, or a proof of Teamily parity.

| Capability | FlyBot evidence | Teamily evidence/status | Acceptance conclusion |
|---|---|---|---|
| Authentication/CSRF/private state | Executable local API/security tests | Same-role signup/login/logout and session behavior not compared in this PR | Self-hosting foundation only; product parity unverified |
| Workspace records/authorization | Real persistence, owner denial, concurrency and replay tests | Workspace UI seen historically; real creation/membership result not exercised here | Records only, not a full Teamily workspace |
| Runtime jobs/volumes/containers | Not implemented | Teamily internal infrastructure unknown; must not infer identical implementation | Pending self-hosting implementation/acceptance |
| Browser interaction and full13 domains | Not run | Same-role/page/input/results comparison required; guide-only/gray features pending verification | Not accepted |

The independent29-case runtime test draft is future input, not a passed suite here. Cross-user workspace records and request failure/isolation properties have analogous unit coverage, but runtime isolation, revision/restart, retention, replacement and deployment cases remain pending or out of this PR's scope — never counted as passes. Product acceptance must record the real Teamily page/role/operation/result, FlyBot revision/config and matching result. No screenshots or browser policy workaround were used.
