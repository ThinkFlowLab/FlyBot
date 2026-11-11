// Browser half of @flybot/project, in the dsh client loader format ds-bot uses
// (window.__ModuleLoader__.load, CJS factory, `require` resolves shell-provided react).
//
// Empty on purpose in this slice (#2684): the Project pages the core draws — the board overlay, the
// Project row in the header, the projects nav, the settings panels — are still `core/src/client/
// project-board.js` and its callers, because they read the core's own client context (the roster
// feed, the overlay stack, the api client) and are bundled by `core/scripts/build-client.mjs`.
// Moving them means turning those surfaces into flybot slots first; until that lands, the module
// exists so the package shape matches every other @flybot plugin and a profile that mounts it has
// a client entry to load. `src/client/` arrives with that follow-up.
window.__ModuleLoader__.load({
  id: '@flybot/project',
  factory: () => ({}),
})
