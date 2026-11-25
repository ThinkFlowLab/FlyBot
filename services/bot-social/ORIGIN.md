# Origin

This directory is a **minimal, file-selected snapshot** of public
[Birfy/bot-social](https://github.com/Birfy/bot-social) commit
[`8706824f53f6cce8212470bc6b442f7271cccd3e`](https://github.com/Birfy/bot-social/commit/8706824f53f6cce8212470bc6b442f7271cccd3e)
(2026-11-16 07:41:41 UTC). It is **not** a whole-repository copy.

- **License:** MIT, Copyright (c) 2026 Birfy — [`LICENSE`](LICENSE).
- **This tree is not original OpenTeamily MIT work.** Keep the copyright notice.
- **Provenance:** [`docs/upstream/bot-social-files.json`](../../docs/upstream/bot-social-files.json). Selection: [`docs/upstream/SELECTION.md`](../../docs/upstream/SELECTION.md).
- **OpenTeamily overlays:** this file and [`OPENTEAMILY.md`](OPENTEAMILY.md).
- **Modifications:** `package.json` is not byte-identical to the pin: the `demo` script that pointed at excluded `scripts/demo.ts` was removed. Original and new hashes are in [`docs/upstream/migration-manifest.json`](../../docs/upstream/migration-manifest.json) under `modified_files`.

## Imported paths

| Path in this tree (upstream path is the same) | Source | Purpose | Related issues (does not close them) |
| --- | --- | --- | --- |
| `LICENSE` | bot-social `@8706824f53f6cce8212470bc6b442f7271cccd3e` | Binding MIT text, Copyright (c) 2026 Birfy | #3 |
| `package.json` | same commit, **modified** | Package manifest; `demo` script removed because `scripts/demo.ts` is not imported | #5 |
| `package-lock.json`, `tsconfig.json`, `.gitignore`, `.dockerignore` | same commit | Lockfile, TypeScript and ignore rules so the service can be installed from this snapshot | #5 |
| `README.md` | same commit | Upstream service overview (logo/banner links are omitted with the assets) | #5 |
| `botsocial.env.example` | same commit | Example env keys only; no secrets | #5 |
| `src/` | `src/` @ same commit | Service and protocols: HTTP API, onboard, auth, grants, approvals, rooms, policy, MCP, webhooks | #5, #10 |
| `test/` | `test/` @ same commit | Source tests for `src/` (no real tokens) | #5 |
| `public/` | `public/` @ same commit | Owner console and invite pages the server reads from disk (`src/server.ts`) | #5 |
| `docs/SETUP.md`, `docs/FACE_ROOMS.md`, `docs/AGENT_GUIDE.md` | same paths @ same commit | Setup, face-room protocol, and agent integration docs | #5 |
| `scripts/botctl.ts` | same path @ same commit | Operator CLI used by included tests and local ops | #5 |
| `Dockerfile`, `docker-compose.yml`, `start.sh` | same commit | Optional local/module deploy of this service. Not a required third production control plane. | #5 |

Excluded: `docs/assets/`, `docs/index.html`, `.github/`, `scripts/install.sh` (clones the full upstream repo), `scripts/demo.ts`, `scripts/mcp-smoke.ts`.
