---
subsystem: install
owned_paths:
  - .dockerignore
  - Dockerfile
  - compose.yaml
  - docker/
  - core/scripts/
  - core/test/check-arch-docs.test.js
  - core/test/install-doctor.test.js
  - plugins/README.md
---

# install

Tooling for setup checks, the architecture-docs gate and the container image (#352).

## Owns

- `core/scripts/` — helper scripts (e.g. `check-arch-docs.mjs`).
- Arch-doc unit test and install-doctor test.
- `plugins/README.md` — plugin inventory index.
- The container image: `Dockerfile`, `compose.yaml`, `.dockerignore`, `docker/` ([guide](../docker.md)).

## Does not own

- `core/dev/` bench/smoke tooling → [ds-bot-core](ds-bot-core.md).
- Repo-root `scripts/ds-bot-patches.mjs` (and other root `scripts/` patch tooling) → [ds-bot-core](ds-bot-core.md). This page's `core/scripts/` covers install/doctor/arch tooling only.

## Key files

| File | Role |
| --- | --- |
| `core/scripts/check-arch-docs.mjs` | owned_paths ↔ docs gate. |
| `core/test/check-arch-docs.test.js` | Tests for the gate. |
| `core/test/install-doctor.test.js` | Install doctor tests. |
| `plugins/README.md` | Plugin list. |
| `core/scripts/install-doctor.mjs` | Install doctor: Node floor, the packages (`core`, `plugins/social`, `plugins/tree`, `plugins/timeline`) and the install commands (core, social, tree; `@flybot/timeline` is opt-in and not in the default commands, #281). |
| `core/scripts/local-ci.sh` | Local run of CI's steps, including each plugin's suite. |
| `Dockerfile` | Packs `core` and the plugins with `check-pack.mjs` (the release tarballs), then a runtime with DSH (pinned like the README), pnpm and tini, as user `node`, one volume `/data`. |
| `compose.yaml` | One instance: port on the host's `127.0.0.1`, volume `data`, `DEEPSEEK_API_KEY` passed through only when set. |
| `docker/entrypoint.mjs`, `docker/profile.mjs` | Each start links the image's packages into `/data/profiles/web` (other plugins and `cordis.patch.yml` kept), `pnpm install`, then `dsh web` in `/data/workspace`. |
| `docker/web.patch.yml` | Container-only overlay: `webserver.host: 0.0.0.0` (the CLI refuses `--host 0.0.0.0`; inside the container it reaches only the container's network). |
| `docker/healthcheck.mjs` | Healthy when `GET /` answers (401 without the cookie). |

## Entry points

- `npm run arch-docs` (in `core/`) → `scripts/check-arch-docs.mjs`.

## Invariants

1. Owned-file changes require a matching subsystem doc in the same PR (or a `Docs-not-needed:` trailer).
2. Empty diff vs base passes.
3. A new peer plugin is added to the install doctor (and its test), `check-pack.mjs`, the CI plugin matrix, `local-ci.sh` and `plugins/README.md` in the same PR.
4. The container image holds no key or token, runs as a normal user, and `compose.yaml` publishes the port on the host's `127.0.0.1` only. CI (`.github/workflows/docker.yml`) builds and start-checks it; nothing is pushed to a registry (owner decision on #352).

## Tests

`node --import ./test/harness-resolve.mjs --test test/check-arch-docs.test.js`. Container: `node --test .github/scripts/docker-profile.test.mjs` (repo root) and the Docker workflow.

## Common mistakes

- Changing an owned path without updating the subsystem page.
- Committing without regenerating patches when `core/` changes.
