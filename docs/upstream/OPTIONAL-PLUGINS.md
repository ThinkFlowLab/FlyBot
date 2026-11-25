# Optional plugins not in the first import

This is a **path and dependency record**, not a deletion of Teamily
requirements. Workspace, memory/todos, Studio, observability, multi-agent
delegation, and automation remain on the parent roadmap. These plugins are
not substitutes for those features, and they are not in this snapshot.

Related tracking: [issue #15](https://github.com/openTeamily/openTeamily/issues/15)
(Project / Timeline). Tree and workflow are recorded here the same way. This
document does not close those issues.

## Where the source remains

Public FlyBot commit
[`e26895e737b1218875aafa1f74ab1d3464f287d2`](https://github.com/ThinkFlowLab/FlyBot/commit/e26895e737b1218875aafa1f74ab1d3464f287d2):

| Plugin | Upstream path | License | Upstream default | Why it was not in the first import |
| --- | --- | --- | --- | --- |
| `@flybot/project` | `plugins/project/` (26 files) | Apache-2.0 under repo LICENSE+NOTICE; no per-plugin LICENSE | Install doctor includes it | Repository-oriented Project domain; not a Teamily workspace. Known static issues (wrong default GitHub repo, missing memory tool, hard-coded timezone, no owner transfer) must be fixed before default-on reuse. |
| `@flybot/timeline` | `plugins/timeline/` (38 files) | same; `private: true` | Opt-in, off by default | Local activity trace, not memory/calendar. |
| `@flybot/tree` | `plugins/tree/` | Apache-2.0, same NOTICE | Default-on in upstream doctor | Recursive bot delegation. Not imported by `core/`. Deferred so this slice stays a needed set; may be imported later for multi-agent (#6, #7). |
| `@flybot/workflow` | `plugins/workflow/` | Apache-2.0, `private: true` | Default-on in upstream doctor | Multi-bot workflow graphs. Core has a UI seam and a missing-plugin hint. Deferred the same way; may be imported later for automation. |

To import later: copy from **that same pin** (or re-audit a newer commit), keep
Apache-2.0 + NOTICE, add an `ORIGIN.md`, fix known Project issues if that
plugin is included, and land an independently reviewed PR. Do not use a dirty
working tree or a private fork.

## Dependencies if imported later

None of these plugins import one another or `@flybot/social`. All declare a
`ds-bot` peer and use `ctx.flybot`, so they would depend on
the upstream DS-Bot v0.3.6 baseline (PR #21) plus this customization layer and, to actually run, on DeepSeek Harness (still not
imported).

Additional Project seams in core (store, board UI, workflow/task hooks) already
live in the imported `core/` package. Importing the plugin later is not the
same as deleting those core seams, and hiding UI is not the same as removing
the model.

## What OpenTeamily must not claim today

- These plugins are **not present** under `runtime/flybot/plugins/`.
- They are **not** installed by any OpenTeamily pack or Compose file in this change.
- Absence is not a statement that Teamily workspaces, boards, memory, activity
  views, delegation, or automation are out of scope.
