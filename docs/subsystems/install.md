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
- Repo-root `scripts/ds-bot-patches.mjs` (and other root `scripts/` patch tooling) → [ds-bot-core](ds-bot-core.md). This page's `core/scripts/` covers install/doctor/arch tooling and the dev-only replay script.

## Key files

| File | Role |
| --- | --- |
| `core/scripts/check-arch-docs.mjs` | owned_paths ↔ docs gate. Its refusal names both places a `Docs-not-needed:` trailer has to appear — the pull request body and the branch commit — because the gate reads `git log <base>..HEAD` and, on a merge-queue entry, that range is the squashed body (#1076). It hands git its arguments as a list (`execFileSync`), never a joined command line through a shell: on Windows that shell is cmd.exe, where `^` escapes the next character, so `origin/main^{commit}` reached git as `origin/main{commit}` and every scheduled windows-latest row reported `cannot diff against origin/main` on a checkout that had it (#1954). |
| `core/test/check-arch-docs.test.js` | Tests for the gate. |
| `core/test/install-doctor.test.js` | Install doctor tests. |
| `plugins/README.md` | Plugin list. |
| `core/scripts/install-doctor.mjs` | Install doctor: Node floor, the packages (`core`, `plugins/social`, `plugins/tree`, `plugins/workflow`, `plugins/timeline`) and the install commands (core, social, tree, workflow; `@flybot/timeline` is opt-in and not in the default commands, #281). |
| `core/scripts/local-ci.sh` | Local run of CI's steps, including each plugin's suite. |
| `core/scripts/replay.mjs` | Dev-only state-journal replay (#511): rebuilds `state.json` up to an entry from `<home>/journal/state.jsonl`; no network or process calls, output is a new 0600 file or stdout, a bad journal is refused whole. See [core-host](core-host.md). |
| `Dockerfile` | Packs `core` and the plugins (social, tree, workflow, timeline) with `check-pack.mjs` (the release tarballs), then a runtime with DSH (pinned like the README), pnpm and tini, as user `node`, one volume `/data`. |
| `compose.yaml` | One instance: host networking (`network_mode: host`), so the server's bind on the host's `127.0.0.1` is the same loopback-only exposure a published port gave before; volume `data`, `FLYBOT_PORT` and `DEEPSEEK_API_KEY` passed through only when set. |
| `docker/entrypoint.mjs`, `docker/profile.mjs` | Each start links the image's packages into `/data/profiles/web` (other plugins and `cordis.patch.yml` kept), `pnpm install`, then `dsh web` in `/data/workspace` on `FLYBOT_PORT` (default 3080). |
| `docker/web.patch.yml` | Container-only overlay: `webserver.host: 127.0.0.1`. DSH 0.2.1 refuses a wildcard host — `host "0.0.0.0" is an unspecified (wildcard) address, which is not supported` — so the container shares the host network instead; the CLI refuses `--host 0.0.0.0` for the same reason. |
| `docker/healthcheck.mjs` | Healthy when `GET /` answers on the host loopback (401 without the cookie), following `FLYBOT_PORT`. |

## Entry points

- `npm run arch-docs` (in `core/`) → `scripts/check-arch-docs.mjs`.

## Invariants

1. Owned-file changes require a matching subsystem doc in the same PR (or a `Docs-not-needed:` trailer).
2. Empty diff vs base passes.
3. A new peer plugin is added to the install doctor (and its test), `check-pack.mjs`, the CI plugin matrix, `local-ci.sh` and `plugins/README.md` in the same PR. `@flybot/workflow` is one of the default commands. `@flybot/timeline` stays opt-in.
4. The container image holds no key or token, runs as a normal user, and `compose.yaml` publishes the port on the host's `127.0.0.1` only. CI (`.github/workflows/docker.yml`) builds and start-checks it; nothing is pushed to a registry (owner decision on #352).

## Tests

`node --import ./test/harness-resolve.mjs --test test/check-arch-docs.test.js`. Container: `node --test .github/scripts/docker-profile.test.mjs` (repo root) and the Docker workflow.

## Common mistakes

- Changing an owned path without updating the subsystem page.
- Committing without regenerating patches when `core/` changes.
