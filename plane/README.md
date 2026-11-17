# @flybot/plane — management-plane skeleton

**Three working defaults, all replaceable — none of them is an owner decision (#3113):**

1. **Granularity:** one FlyBot instance per **owner**, not per workspace or per Agent. The
   issue's body suggested this as the closest thing to today's "one instance per person"; split
   it further once the workspace product exists.
2. **Storage:** a single JSON document (`<dataDir>/plane.json`, `version: 1`) for accounts,
   workspaces and instance metadata. It is in the data directory, not the Agent container's
   volume, and the `version` field is there so a later slice can migrate it. No cloud database
   is bound.
3. **Backend:** compose is only the **first** lifecycle path. `LifecycleBackend` is the
   contract; `ComposeBackend` materializes a compose project and starts nothing. A cloud or
   other orchestrator is another backend, not a rewrite.

Everything below follows from those three; if the owner picks a different granularity, storage
or orchestrator, only the default changes.

## What this first slice does

- Records accounts, workspaces and instances (`plane/src/store.mjs`), atomically (temporary
  file + rename), file mode 0600, directory mode 0700.
- Splits the two credentials (`plane/src/credentials.mjs`): `op_<32 hex>` operator tokens for
  the API, `ctl_<32 hex>` instance control tokens. Only sha256 is stored; both are checked with
  `timingSafeEqual`; `redact()` is for logs. Neither token type verifies as the other.
- Creates, starts, stops and restarts an instance (`index.js`), with per-owner uniqueness on
  `(workspaceId, name)` and `DuplicateInstanceError` on a clash.
- Routes the HTTP surface as a pure function (`plane/src/server.mjs`): `POST/GET
  /api/instances`, `GET /api/instances/:id`, `POST /api/instances/:id/{start,stop}`. Every
  instance route checks the operator token first, then `instance.ownerId === token.accountId`.
- Materializes an instance's compose project (`plane/src/lifecycle.mjs`): `compose.yaml` plus
  `control.env` (0600), loopback port, project `flybot-<id>`. It does **not** run `docker
  compose up`; `runner` is an unused injection point for the next slice.
- `upgrade` and `recycle` are on the contract and throw `NotImplementedError`.

## API

```js
import { createPlane, ComposeBackend } from '@flybot/plane'

const plane = createPlane({ dataDir: '/var/lib/flybot/plane', backend: new ComposeBackend({ instancesDir: '/var/lib/flybot/plane/instances' }) })
const instance = await plane.createInstance({ workspaceId: 'ws-1', name: 'main', ownerId: 'acct-1' })
await plane.startInstance(instance.id)
await plane.stopInstance(instance.id)
```

`createInstance()` returns the instance and, exactly once, `controlToken`. `getInstance()` and
`listInstances()` never include the token or its hash. `createPlane` accepts `{ dataDir,
store, backend, clock }`; `clock` is injectable for deterministic tests.

## CLI

```sh
node plane/bin/plane.mjs token --data-dir /var/lib/flybot/plane [--account owner_local]
node plane/bin/plane.mjs serve --data-dir /var/lib/flybot/plane [--port 3090]
```

`token` prints the operator token once (only its sha256 is kept). `serve` binds
`127.0.0.1:<port>` and answers `401` to an unauthenticated `GET /api/instances`.

## Not in this slice

No container is started, stopped or upgraded for real; no management UI; no public gateway; no
backup/recovery; no Bot Social wiring (the instance's social connection is a later package). The
package does not ship in the FlyBot image and is not registered in `docker/profile.mjs`'s
bundles.

## Tests

```sh
npm --prefix plane test
```

20 cases: ownership/403, 401, per-owner listing, duplicate creation (409), persistence, 400s,
start/stop/restart, unknown id (404), credential separation and storage, compose materialization,
idempotency and the zero-spawn guarantee.
