---
subsystem: tree
owned_paths:
  - plugins/tree/
---

# tree (`@flybot/tree`)

Recursive Bot hierarchy plugin (Chief as root, children, send middleware `tree`) lives entirely under `plugins/tree/`.

## Owns

Everything in `plugins/tree/` (entry `plugins/tree/index.js` and any helpers).

## Does not own

- Plugin runtime hooks/slots → [plugin-runtime](plugin-runtime.md).
- Core server/client → [ds-bot-core](ds-bot-core.md).
- Cross-owner authority policy → [team](team.md). Chief as tree root is the identity anchor for that contract; tree ownership itself stays on this page.

## Key files

| File | Role |
| --- | --- |
| `plugins/tree/index.js` | Plugin entry. |

## Entry points

- `plugins/tree/index.js` — loaded as `@flybot/tree`.

## Invariants

1. Tree code stays inside `plugins/tree/`; no edits to `ds-bot/` or `core/src/`.
2. Uses documented plugin APIs only (hooks/slots).
3. Reach (#90): tree never routes an outside sender through the root. A remote sender (friend's Bot) reaching a tree Bot is denied if `flybot.bot.hasAnyGrant` is false (new and adopted Bots, and the Chief, start with no grant) and is not the tree's call if it is granted, so a granted Bot is reached directly, at any depth. Granted Bots on both sides are not the tree's call across trees or to non-tree Bots (the core's owner policy decides); inside one tree the parent/child rule is unchanged, and `stopped` / `report` notices are unchanged. On a core without `hasAnyGrant` the remote-sender rule gives no opinion.

### Optional Tree section toggle

- The Bot list itself uses the core `.bt-tree-toggle` (see [core-client](core-client.md)). When `sidebarSection: true` brings this plugin's separate Tree section back, `.flybot-tree-toggle` matches that control: 28×28 hit target, 16px inner `.flybot-tree-caret`, hover, focus ring, and rotation of the glyph only. Leaf spacers (`.flybot-tree-dot`) keep the same 28px width. `aria-expanded` and Expand/Collapse `{name}` labels stay on the button.

## Tests

Covered by the plugin's own tests under `plugins/tree/` / core test suite as wired.

## Common mistakes

- Placing tree logic in `core/` instead of `plugins/tree/`.
- Bypassing the plugin runtime for registration.
