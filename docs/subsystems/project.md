---
subsystem: project
owned_paths:
  - plugins/project/
---

# project

The Project domain as a peer plugin: `plugins/project` (`@flybot/project`). The core keeps the
runtime and the Project *record* (`state.projects`, the `bot.projectId` / `room.projectId`
bindings, `state.projectRuns`, the memory table and the `project-*` endpoints in `store.js`); this
package owns everything that reads or acts on that record.

## Owns

- `plugins/project/index.js` — the Cordis plugin (`name = 'flybot-project'`, `inject = ['flybot']`).
  `apply()` returns before registering anything when `flybot.pluginEnabled('project')` is `false`,
  and otherwise binds the host helpers and installs the domain on the runtime the host hands over.
- `plugins/project/src/` — the domain: Project State (`project-state.js`), the board
  (`project-board.js`), the Project's own Chief (`project-chief.js`), the team dossier
  (`project-team.js`), the metrics (`project-metrics.js`) and the assistant (`project-assistant.js`),
  plus `host.js` (the helper binding) and `install.js` (which seam goes on the runtime, in the
  order the core used to install these modules).
- `plugins/project/test/` — the domain's tests, moved here from `core/test/project-*.test.js` when
  the code moved, plus `host.test.js` (the plugin's own apply(), the switch, and the seam).
- The two Project tools: `project_state` (#1702) and `project_digest` (#1712). They are
  registered by this plugin and nowhere else, so the plugin's switch turns them off with the rest.

## Does not own

- The Project record, its bindings and the `project-*` endpoints → [core-host](core-host.md)
  (`store.js`).
- The `project_state` / `project_digest` permission entries and endpoint dispatch → `authz.js`,
  `channel.js` ([core-host](core-host.md)).
- The browser half. The board overlay, the Project header row, the projects nav and the settings
  panels are still `core/src/client/project-board.js` and its callers: they read the core's own
  client context (the roster feed, the overlay stack, the api client) and are bundled by
  `core/scripts/build-client.mjs`, which cannot import a plugin bundle. `plugins/project/client.js`
  is therefore an empty module in this slice; turning those surfaces into flybot slots is the
  follow-up that moves `src/client/` here.
- `core/src/host/hooks.js` — the plugin API surface the seam hangs off → [plugin-runtime](plugin-runtime.md).

## Key files

| File | Role |
| --- | --- |
| `plugins/project/index.js` | Plugin entry: the owner switch (`flybot.pluginEnabled('project')`), `bindHost(seam.helpers)`, `installProjectDomain(seam.runtime)`. A core with no `flybot.projectHost()` is told once and nothing is registered; the host's own fallbacks answer instead. |
| `plugins/project/src/install.js` | Puts the seams on the runtime in the core's old `MODULES` order — state reader, Chief, board, dossier, assistant — and marks the runtime so a second `apply()` is a no-op (a second `ctx.tools.register` of the same name would fail the whole plugin). |
| `plugins/project/src/host.js` | The helpers this package takes from its host, read at call time so a module-scope arrow (`oneLine`, `capped`) sees the binding: `cut`, `codePoints`, `dirKind`, `defineTool`, `output`, `columnOf`, `priorityOf`, `advanceRefusal`, `workDirFor`, `dayKey`, `MAX_ENTRY`, `ASSISTANT_ROLE` and the quiet-hours reads. `REQUIRED` is the whole list; a host that binds a partial bag fails at `apply()` naming the missing helper. |
| `plugins/project/src/project-state.js` | The `project_state` tool: the Project State files of the Session working folder (`PROJECT.md`, `ROADMAP.md`, `docs/governance.md`, `decisions/*.md`, `LESSONS.md`), listed with byte size, a sha256 content hash and mtime, or one file whole up to 200,000 bytes. Answers `absent`, `too large`, `not a repository` or `unreadable: <path> (<reason>)` with the reason instead of an empty document; a decision name is one segment under `decisions/` ending in `.md` (`isDecisionPath`), read through `lstat` so a symlink answers absent, and `decisions/` itself must be a real directory (#2055, #2037, #2041, #2461). |
| `plugins/project/src/project-board.js` | The board read model (#1696): `state.tasks`, `state.meetings`, the `decisions/*.md` files and the Project bindings, with the workflow run refs read through the core's provider seam (`rt.onProjectProvider`). Read-only by construction; it writes nothing. Carries the role policy (`rolesOf`, `roleOf`, `roleChoices`, `changeRole` — one Owner, nobody promotes themselves, a Project always keeps its Owner), the queue/lease/blocked groups and the decision card (`decisionCardOf`, `advanceRefusal`). |
| `plugins/project/src/project-chief.js` | The Project Chief (#1859): one hidden Bot per Project, named `Project Chief (<name>)`, bound with `bindProject` and given instructions that name that one Project and forbid answering for any other; retired through the host's own `deleteBot` with the Project. `rt.projectChief` is `{ create, chiefOf, remove }`. |
| `plugins/project/src/project-team.js` | The team dossier (#1864), read-only: `rt.projectTeam(projectId)` answers `{ rows }` in the board's order — the Chief, the assistant, then `roles.maintainers` / `roles.members` — with persona (the Bot's instructions), the head and topic names of its own memory, its skills and only this Project's rooms. Every string and list is capped and a deleted Bot is a `null` row, never an error for the whole answer. |
| `plugins/project/src/project-metrics.js` | The board's seven numbers (#1829) read from GitHub REST and the local task store, with a five-minute cache and one honest failure answer: a missing credential or an unreadable source is `unavailable` and every value reads `null`, never `0`. The lists are followed page by page under a cap (#2650), a foreign host is never followed with the token, and the day boundary is the caller's zone (`resolveTimeZone`) rather than the host's UTC clock. Its day key is `core/src/host/day-key.js` since #2830. |
| `plugins/project/src/project-assistant.js` | The Project Assistant (#1712): one hidden Bot and Session per Project with exactly one 09:00 Asia/Shanghai `project_digest` task on that Session through the host's schedule path (never a cron in the plugin), per-owner memory in `state.projectMemory` behind the store's write door (600 code points), and a digest built only from board rows and Project State (what merged, what closed, what is in progress and on whom, the next slice; a day with no change is one line, a second build answers `skipped`). Its writes carry `Written-by: Project Assistant (<name>)` / `Posted-for: <login>`. |
| `plugins/project/client.js` | Empty in this slice: the browser half is still in the core, see **Does not own**. |

## Entry points

- `apply(ctx)` when a profile mounts `@flybot/project` (the owner switch is read there, so a flip
  applies at the next start).
- The seams it leaves on the runtime: `rt.projectBoard`, `rt.projectChief`, `rt.projectTeam`,
  `rt.projectAssistant` — the same names `store.js`, `meetings.js` and `channel.js` already call.

## Invariants

1. **Behavior parity.** Same input, same output as the core modules this moved out of: the same
   read shapes, the same refusals, the same strings. The tests moved with the code, so a change in
   behavior fails an existing case rather than passing in a new file.
2. **The switch is all-or-nothing.** `pluginEnabled('project') === false` registers no tool, no
   seam and no background work; a core with the plugin disabled keeps the store's documented
   fallbacks (a Project is created without a Chief or an assistant; the board and the dossier
   answer empty). The plugin reads the switch at `apply()`, like tree and social, so a flip lands
   at the next start.
3. **No copy of the core.** The plugin does not import `core/src/*`; the helpers it shares with the
   core come through `flybot.projectHost()` and are read at call time. `test/host.test.js` holds
   `src/host.js`'s `REQUIRED` list and the core's `HELPER_NAMES` to the same names.
4. **One install.** The domain installs once per runtime (`install.js` marks it), so a host that
   applies the plugin twice — or a test that applies it after the core — registers one set of
   tools.
5. **No timer.** The only background beat is the assistant's own DSH schedule; the plugin polls
   nothing.

## Tests

`cd plugins/project && npm test` (the suite applies the plugin to a real core runtime through
`ds-bot`, the way a profile mounts both). The core's own suite keeps the integration cases that
read a Project through the store, the channel and the board (`core/test/projects.test.js`,
`project-digest-authz`, `project-role-authz`, `project-owner-gate`, `project-run-seam`,
`project-board-panels`, `project-board-view`, `project-settings-page`, `projects-nav`,
`project-board-readonly`, `project-board-entry`, `project-board-levels`, `readonly-window-reads`);
they apply the domain with `core/test/project-domain.js`.
