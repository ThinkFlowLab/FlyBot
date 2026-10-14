---
subsystem: plugin-runtime
owned_paths:
  - core/src/host/hooks.js
  - core/src/client/flybot-slots.js
  - core/src/client/flybot-registry.js
  - core/types/flybot.d.ts
  - core/test/flybot.test.js
  - core/test/flybot-client.test.js
---

# plugin-runtime

FlyBot's plugin API surface on top of the patched core: host hooks, client slots/registry, and types.

## Owns

- `core/src/host/hooks.js` — host-side plugin hooks.
- `core/src/client/flybot-slots.js` — client slot registry.
- `core/src/client/flybot-registry.js` — plugin discovery/registration.
- `core/types/flybot.d.ts` — public types.
- Flybot unit tests (`flybot.test.js`, `flybot-client.test.js`).

## Does not own

- Generic host/client code under `core/src/` (→ [ds-bot-core](ds-bot-core.md)).
- Concrete plugins `plugins/tree/`, `plugins/social/`.

## Key files

| File | Role |
| --- | --- |
| `core/src/host/hooks.js` | Host hook points. |
| `core/src/client/flybot-slots.js` | Client slots. |
| `core/src/client/flybot-registry.js` | Registry. |
| `core/types/flybot.d.ts` | Types. |

## Entry points

- Host: `hooks.js` loaded by the core host.
- Client: slots/registry wired into the built client.

## Invariants

1. Hooks are the only sanctioned extension surface; never monkey-patch DSH.
2. Slots/registry must keep the client build green (`npm run build`).
3. Types in `flybot.d.ts` stay in sync with hooks/slots.

## Tests

`core/test/flybot.test.js`, `core/test/flybot-client.test.js` via `npm test`.

## Common mistakes

- Reaching into DSH internals instead of using hooks/slots.
- Changing slots without updating types or client tests.
