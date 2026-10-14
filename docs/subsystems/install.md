---
subsystem: install
owned_paths:
  - core/scripts/
  - core/test/check-arch-docs.test.js
  - core/test/install-doctor.test.js
  - plugins/README.md
---

# install

Tooling for setup checks and the architecture-docs gate.

## Owns

- `core/scripts/` — helper scripts (e.g. `check-arch-docs.mjs`).
- Arch-doc unit test and install-doctor test.
- `plugins/README.md` — plugin inventory index.

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

## Entry points

- `npm run arch-docs` (in `core/`) → `scripts/check-arch-docs.mjs`.

## Invariants

1. Owned-file changes require a matching subsystem doc in the same PR (or a `Docs-not-needed:` trailer).
2. Empty diff vs base passes.

## Tests

`node --import ./test/harness-resolve.mjs --test test/check-arch-docs.test.js`.

## Common mistakes

- Changing an owned path without updating the subsystem page.
- Committing without regenerating patches when `core/` changes.
