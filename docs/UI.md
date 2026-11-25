# UI refresh: design-system pass

Related: [#1](https://github.com/openTeamily/openTeamily/issues/1), [#14](https://github.com/openTeamily/openTeamily/issues/14).

This is a self-written visual refresh of the existing management pages. It does not change
routes, page structure, element IDs, APIs, permissions, or copy semantics. It is **not** Teamily
pixel parity and it is not browser acceptance; historical screenshots in the source repository use
synthetic fixtures on a throwaway loopback app.

## Audit findings (before)

- The shell already exposed `--ot-*` tokens, but the palette was warm beige + teal and the same
  values were duplicated across four theme blocks, so drift was likely.
- `body.app-workspace > .app-rail` used `background: var(--ot-ink)`. In dark mode `--ot-ink` is
  light, so the rail inverted to a light bar with dark text — the opposite of the intended chrome.
- Page CSS mixed undefined fallbacks (`--line`, `--surface`, `--muted`) and hard-coded radii,
  shadows and spacing. Cards, inputs and buttons had different heights and corner radii.
- Focus states existed but the ring was thin and inconsistent; hover states were mostly
  `filter: brightness()`, which makes text and surfaces shift together.
- Chat surfaces (session pane, bubbles, composer) were flat with little separation between the
  timeline and the composer.

## What changed

### Tokens (`flybot_workspace/static/shell/app.css`)

- Neutral cool-gray canvas (`#f6f7f9` light / `#0b1120` dark), crisp white/near-black surfaces,
  slate ink, and a single indigo accent (`#4f46e5` light / `#818cf8` dark).
- New semantic tokens: `--ot-surface-2`, `--ot-line-strong`, `--ot-on-accent`,
  `--ot-shadow-sm`, `--ot-shadow-lg`, `--ot-rail-bg`, `--ot-rail-ink`,
  `--ot-radius-sm`, `--ot-radius-lg`.
- All four theme blocks (system light, system dark, forced light, forced dark) carry the same
  values, including `--ot-on-accent` for readable text on the accent.
- The rail now uses `--ot-rail-bg`/`--ot-rail-ink`, so it stays dark in both themes; the active
  item is an accent pill and the brand mark is an accent→violet gradient.
- Buttons, inputs, selects, textareas, fieldsets, menus, status pills and empty states share one
  radius/shadow/focus system. Hover changes background and border instead of filtering the whole
  element. Inputs get a 3px accent focus halo.

### Chat (`flybot_workspace/static/chat/app.css`)

- Session pane uses the surface color with a hairline border; rows get 12px radii, a soft hover
  and an inset accent ring when selected. Avatars use a tinted accent instead of plain white.
- Message timeline: 1.25rem horizontal padding, 16px bubbles, subtle borders/shadows, accent
  bubbles for the current user (with `--ot-on-accent` text), dashed accent treatment for agent
  replies, and muted metadata.
- Composer is an elevated card; the textarea is borderless inside it and the send button is the
  accent. Tool buttons become quiet pill chips.
- Below 900px the session pane collapses so the conversation keeps the full width.

### Discover, memory, artifacts

- Discover cards lift on hover, use large radii and a soft shadow; the create button and active
  filters use the accent tokens.
- Memory panels, view pills and filter chips share the new radii and accent selection.
- Artifact rows, kind pills, menus, editor panels and slide/dashboard cards share the same
  surface/shadow/radius system.

## Accessibility and constraints

- Every interactive control keeps a visible `:focus-visible` ring; inputs also get a border/halo.
- Accent text uses `--ot-on-accent` for contrast in both themes.
- No new fonts, images, trademarks or third-party assets are introduced; the stack stays system
  fonts and self-written CSS.
- `prefers-reduced-motion` is not handled yet; transitions are short (≤160ms).
- A real browser/Teamily side-by-side and WCAG audit remain #14 work; these screenshots are
  synthetic review material, not acceptance.
