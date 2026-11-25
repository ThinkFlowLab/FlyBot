# Reuse and provenance policy

This repository contains independently authored management code **and** isolated snapshots of related, publicly licensed upstream source. Imported trees keep their original licenses and must not be relicensed under the root MIT license. See [LICENSING.md](LICENSING.md).

Currently imported **needed sets** (public commits only; not whole repositories — see [docs/upstream/SELECTION.md](upstream/SELECTION.md)):

- FlyBot `@e26895e737b1218875aafa1f74ab1d3464f287d2` → `runtime/flybot/` (Apache-2.0 + NOTICE). First import excludes `plugins/project`, `plugins/timeline`, `plugins/tree`, `plugins/workflow`, unpatched `ds-bot/` + `patches/`, official Dockerfile/compose, process automation, and unverified brand/demo images.
- Bot Social `@8706824f53f6cce8212470bc6b442f7271cccd3e` → `services/bot-social/` (MIT). First import excludes `docs/assets/` brand/screenshot files, the marketing `docs/index.html`, upstream workflows, and `scripts/install.sh` (clones the full upstream repo).
- Upstream DS-Bot v0.3.10 `@d104d9ca18d69a35460f14e15dff4d553181433a` → `runtime/ds-bot-upstream/` (unmodified Apache-2.0 copy; LICENSE and NOTICE retained). Do not edit that tree; FlyBot changes live outside it.

Provenance manifests and the offline verifier live in [docs/upstream](upstream/MIGRATION.md) and `scripts/verify-upstream-migration.py`. Upstream git history, credentials, caches, and `node_modules` are not imported. `Birfy/flybot-control-plane` must not be copied.

Before importing **additional** source, an image, or a dependency:

1. Identify the exact repository/image, version, public/private status, owner and provenance.
2. Read the actual license and notices for that revision, including third-party and upstream runtime components.
3. Establish redistribution and modification rights. Public availability is not itself a license; organization membership is not permission to republish private material.
4. Record attribution, notice/source-distribution obligations, compatibility, image dependencies and security implications.
5. Choose an adapter or clean independent implementation when reuse is not justified. Do not relicense upstream work under this repository's MIT license.
6. Import only the agreed capability in an independently reviewed PR, with tests and an origin record.

DeepSeek Harness, container base images, and trademarked logos have not passed a complete redistribution audit and are not vendored here. `runtime/flybot-image/` is an FlyBot-authored build recipe whose CI job does not close that audit. Project/Timeline remain an optional later path, not a deletion of Teamily requirements. Keep secrets, logs, user content, caches and generated mock screenshots out of git.

The management slice uses the Python standard library and adds no third-party application package. Optional Bot Social tests install dependencies from that snapshot's lockfile in CI only; those packages are not committed.
