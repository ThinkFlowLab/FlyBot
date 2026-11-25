# Model API configuration

Related: [#4](https://github.com/openTeamily/openTeamily/issues/4), [#6](https://github.com/openTeamily/openTeamily/issues/6), [#1](https://github.com/openTeamily/openTeamily/issues/1).

FlyBot does **not** implement Teamily account credits, billing or usage limits. A self-host operator configures a platform default model API; an account or workspace may optionally override it. The effective configuration is “override if a key is set, otherwise the platform default”. This is an FlyBot choice, not Teamily parity.

The API key is stored only as a wrapped blob next to the private management database. It is never returned in JSON, logs or run records. Runtime hooks receive the unwrapped key in-process. The compose manager fetches the already-resolved key over a lease-gated loopback endpoint (`POST /v1/internal/instances/{id}/runtime-secret`) and writes it to a private 0600 file that is bind-mounted read-only into the container. The key is not echoed on user HTTP APIs, claim receipts, observe payloads or operator logs; the lease-gated response is written to disk and not logged. The wrapping construction is a local HMAC-SHA256 keystream with an encrypt-then-MAC tag, using a 32-byte key in `model-api.wrap` (mode 0600). It is not a substitute for disk encryption or a cryptographic review.

## Routes

| Method | Path | Behavior |
|---|---|---|
| GET/POST | `/v1/admin/model-api` | Platform default. Loopback `Authorization: Bearer` using an operator credential hash from `--operator-admin`. No session cookies, no Origin header. POST `{revision, changes}` where `changes` may include write-only `api_key` (omit to leave, `null` to clear) |
| GET/POST | `/v1/model-api` | The signed-in account’s optional override. GET also returns `effective` (account if set, else platform). Session + exact Origin + CSRF on POST |
| GET/POST | `/v1/workspaces/{id}/model-api` | Optional workspace override. Any member may GET (metadata only); owner or admin may POST. Workspace-scoped work uses this override if it has a key, otherwise the platform default |

`changes` fields: `provider` (`openai`, `azure`, `anthropic`, `custom`), `base_url` (https, or http only on loopback), `model` (1–128 token characters), optional `api_key` (8–4096 characters). Revision conflicts return `409` with `error.current`.

For an automatically provisioned account, the manager mounts the operator default. The account’s DS-Bot applies its own saved override to requests and returns to the operator default when the account clears its key.

Instances include a redacted `model_api` object for the manager-supplied configuration on list, inspect, and create. Automations pass the same metadata to the dispatch hook; stored run records do not contain the key.

## Operator files

`--operator-admin` is a private JSON file `{"credential_hash":"<sha256 hex of the bearer token>"}`. The token itself is never stored. Disabled if the flag is omitted. Do not commit this file or put secrets in the repository.

## Not in this slice

No credits, no quotas, no live call to a model provider, no Teamily billing UI. Browser acceptance is not claimed. Live Docker create/start/stop of a real FlyBot container on an operator host is documented in `docs/COMPOSE_MANAGER.md` and is not proven by the unit tests in this repository (this box has no Docker engine).
