# Aurora Glass: visual identity pass

Related: [#1](https://github.com/openTeamily/openTeamily/issues/1), [#14](https://github.com/openTeamily/openTeamily/issues/14).

This is a self-written visual identity layer over the existing management pages. It keeps routes,
IDs, APIs, permissions and copy semantics unchanged, and adds no external fonts, images, logos or
third-party CSS. It is **not** Teamily pixel parity and not browser acceptance.

## Concept

- **Aurora canvas**: fixed, blurred radial gradients (violet → magenta → cyan) plus a faint dot
  grid, animated slowly and disabled under `prefers-reduced-motion`.
- **Glass surfaces**: translucent panels with `backdrop-filter`, hairline borders, layered
  shadows and a single gradient accent (`#6d5cff → #8b5cf6 → #14c8d4` light, brighter in dark).
- **Editorial type**: system font stack, tighter heading tracking, gradient page titles.
- **Depth and motion**: 16–22rem radius scale, hover lift, focus halos, entrance rise for
  messages and the login card.

## Tokens

New tokens include `--ot-surface-solid`, `--ot-accent-2`, `--ot-on-accent`, `--ot-grad`,
`--ot-grad-soft`, `--ot-glow`, `--ot-radius-xl`, `--ot-ease`, `--ot-blur`. The four theme blocks
(system light/dark, forced light/dark) stay in sync. Existing tokens such as `--ot-measure`,
`--ot-rail-bg` and `--ot-line` remain so page tests keep working.

## Page coverage

- Shell: rail, brand mark, account menu, status pill, buttons, inputs, fieldsets, empty states,
  login hero, scrollbars and selection.
- `/chat`: glass session pane, gradient avatars, accent selection bar, gradient outgoing bubbles,
  glass incoming/agent bubbles, elevated composer and quiet tool chips.
- `/discover`, `/space`, `/memory`, `/settings`, `/profile`: glass cards, gradient hover borders,
  gradient avatars/create buttons and accent selections.

## Accessibility / limits

- Focus-visible rings remain (2px accent + offset); inputs add a 4px halo.
- Text on gradients is white; the `--ot-on-accent` token is kept for contrast.
- `prefers-reduced-motion` disables the aurora animation and shortens transitions.
- `backdrop-filter` degrades to opaque surfaces where unsupported.
- No external assets; CSP stays `default-src 'none'` + self scripts/styles.

## Screenshots

Historical screenshots remain in the source repository. They are synthetic review material; a real
browser/WCAG/Teamily side-by-side remains #14 work.
