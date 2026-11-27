# UI surfaces: page → feature map

Related: #3393. Part of [UI_SURFACES.md](UI_SURFACES.md). Measured on `34a80ca5a1`.

`node docs/ui-surfaces-map.mjs` → `15 features; 26 dirs`, then per static dir the owning feature(s)
or `(python only)`: 9 shared, 13 python-only, 4 aliased (`contacts→social`, `look→settings`,
`onboarding→settings`, `settings→connectors,model-api,settings`). `messenger` declares
`pages: ['messenger']` while `static/messenger` does not exist — stale doc, not a route.

What to run per change: [UI_SURFACES_DISPATCH.md](UI_SURFACES_DISPATCH.md).
