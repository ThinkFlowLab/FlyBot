# First-import selection (needed set, not whole repositories)

Date: 2026-11-16 (Asia/Shanghai).

Pins: ThinkFlowLab/FlyBot `@e26895e737b1218875aafa1f74ab1d3464f287d2`,
Birfy/bot-social `@8706824f53f6cce8212470bc6b442f7271cccd3e`.
OpenTeamily base: `main` `@402b5c907963389d020bf6dc064ee3f69b69f0d9`
(main after [PR #21](https://github.com/openTeamily/openTeamily/pull/21), which this import merged onto).
The first-import draft started from `main` `@2cbd0c1c0845338ded1d9c9455a6c9c2c40a4d52`.

**Runtime baseline:** OpenTeamily tracks upstream DS-Bot **v0.3.6** as the
runtime, in [PR #21](https://github.com/openTeamily/openTeamily/pull/21) (now on `main`)
(`runtime/ds-bot-upstream/`). This FlyBot import does **not** vendor
`runtime/flybot/core/` (the old v0.1.5 fork) or `ds-bot.pin.json`. The
historical FlyBot core pin `2b10c70b614e969117b68ddc6fd14e68968272f2` equals
upstream `0f130e7d134bf63e8988b2d53fd6846138ac3d73` (ds-bot tree
`5834c00d9c21b972e4b32ad90489443da2a10324`); see
[ds-bot-pin-equivalence.json](ds-bot-pin-equivalence.json). FlyBot
material kept here is the customization layer that will sit on that baseline.

Selection rule: take only source, protocols, tests, and docs required for
(1) the FlyBot **customization layer** (`plugins/social` + instance docker
helpers) and (2) Bot Social **collaboration protocols**. Keep each imported
package's internal layout. Do not copy the rest of either repository, and do
not keep a second, outdated runtime fork beside the upstream baseline.

Counts: **55** FlyBot files kept in this snapshot (**47** still byte-identical
to the pin, **8** documented modifications), **1677** FlyBot pin files
excluded; **440** Bot Social files kept (**439** identical, **1** documented
modification), **10** Bot Social pin files excluded. Overlays `ORIGIN.md` and
`OPENTEAMILY.md` in each tree are OpenTeamily-authored. Per-file hashes:
[flybot-files.json](flybot-files.json),
[bot-social-files.json](bot-social-files.json),
`modified_files` in [migration-manifest.json](migration-manifest.json).

## Included (FlyBot → `runtime/flybot/`)

| Path | Why it is needed |
| --- | --- |
| `LICENSE`, `NOTICE` | Apache-2.0 obligations |
| `README.md`, `README.zh.md` | Snapshot overview (modified: dropped broken full-product links after `core/` was removed) |
| `.gitignore`, `.dockerignore` | Package-tree ignore rules |
| `plugins/social/` | Only plugin on the FlyBot ↔ Bot Social protocol path (#5). Host-integration tests that imported the deleted `core/` were removed; plugin-only tests remain. `test/resolve.mjs` and `test/look.test.js` are documented modifications. |
| `docker/entrypoint.mjs`, `healthcheck.mjs`, `profile.mjs`, `web.patch.yml` | Instance start/health/profile/bind; profile linker is package-generic |
| `docs/docker.md`, `docs/docker.zh.md`, `docs/subsystems/social.md` | Docs for the imported docker helpers and social plugin (snapshot headers added) |

## Excluded (FlyBot) and why

| Path | Reason |
| --- | --- |
| `core/`, `ds-bot.pin.json` | Old DS-Bot v0.1.5 fork and its pin. OpenTeamily's runtime baseline is upstream v0.3.6 (PR #21), not this fork. |
| `ds-bot/`, `patches/` | Unpatched DS-Bot tree and the patch series that used to regenerate `core/`. |
| `plugins/project/`, `plugins/timeline/` | Not default core; not Teamily workspace/memory substitutes. Optional later path: [OPTIONAL-PLUGINS.md](OPTIONAL-PLUGINS.md) |
| `plugins/tree/`, `plugins/workflow/` | Default-on *upstream*, but not required for the social/protocol or container-lifecycle slice. Optional later, same doc. Workflow is not Teamily「自动化」. |
| `Dockerfile`, `compose.yaml` | Official recipes pack project/timeline/tree/workflow and `npm install -g` DSH. Misleading if copied verbatim. |
| `plugins/README.md` | Lists unimported plugins as part of a full install |
| `core/scripts/install-doctor.mjs`, `core/test/install-doctor.test.js` | Doctor requires the unimported plugins |
| `core/dev/**` | Benches, evals, and the DSH pin used only by the deleted fork |
| `.github/`, `.claude/`, `policy/`, `changelog.d/`, `decisions/`, `AGENTS.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `PROJECT.md`, `ROADMAP.md`, `LESSONS.md` | Upstream process, history, and product-planning files |
| `scripts/`, repo-root `dev/` (interop, live-e2e) | Repo helper and interop harness, not the customization layer |
| `docs/images/*`, `docs/assets/wechat-group.png` | Logos, demos, WeChat QR; trademark use unverified |
| `docs/architecture.md`, `reference.md`, `integrating.md`, `known-issues*`, `deepseek-api-key.md`, `subsystems/{README,core-host,core-client,ds-bot-core,install,plugin-runtime,team}.md` | Docs for the deleted `core/` fork or unimported plugins |
| `plugins/social/test/social.test.js`, `social-readonly.test.js`, `web-entry.test.js`, `zh-*.test.js` | Host-integration / i18n-dictionary tests that hard-imported the deleted `core/` |
| Any `Birfy/flybot-control-plane` file | Forbidden (no LICENSE) |
| DSH npm/git, Claude payloads, base images, `node_modules`, credentials, git history | Not in this repository |

## Included (Bot Social → `services/bot-social/`)

| Path | Why it is needed |
| --- | --- |
| `LICENSE`, `README.md`, manifests, lockfile, `tsconfig.json`, ignore files, `botsocial.env.example` | License, install, example env. `package.json` is a documented modification: the `demo` script (excluded `scripts/demo.ts`) was removed. |
| `src/` | Service and protocols |
| `test/` | Tests for `src/` |
| `public/` | Pages the server actually serves (`src/server.ts`) |
| `docs/SETUP.md`, `FACE_ROOMS.md`, `AGENT_GUIDE.md` | Setup and protocol docs |
| `scripts/botctl.ts` | Operator CLI; referenced by included tests |
| `Dockerfile`, `docker-compose.yml`, `start.sh` | Optional module deploy, not a required third control plane |

## Excluded (Bot Social) and why

| Path | Reason |
| --- | --- |
| `docs/assets/` | Banner, logo, UI screenshots; trademark use unverified |
| `docs/index.html` | Marketing site; depends on excluded assets |
| `.github/` | Upstream workflows; would not run from this nested path |
| `scripts/install.sh` | Clones the **full** upstream Bot Social repository |
| `scripts/demo.ts`, `scripts/mcp-smoke.ts` | Optional demos, not required by `src/` or `test/` |

## Dependency graph (needed set)

```
OpenTeamily management server (openteamily/, manager/)  — not wired in this change
        |
        v  (future) container from upstream DS-Bot v0.3.6 (PR #21)
                + FlyBot customization layer (runtime/flybot/plugins/social + docker/)
        |
        +-- plugins/social  --protocol-->  services/bot-social (optional module)
        |
        +-- peer, NOT imported here: @deepseek-ai/dsh* (PR #21's CI installs the
        |   pinned DSH to prove the upstream baseline)
        +-- optional, NOT imported: @flybot/{tree,workflow,project,timeline}
        +-- NOT imported: FlyBot core/ (v0.1.5 fork)
```

Plugins do not import one another. `plugins/social` production sources do not
import `core/`. If a later change needs tree or workflow, import from the same
pin (or re-audit a newer commit), keep Apache-2.0 + NOTICE, and add an origin
record.

Related issues #3, #5, #15 are referenced only. This document does not close
#1, #2, #3, #5, or #15. Old FlyBot #3110 / #3112 and bot-social #789 are not
modified.
