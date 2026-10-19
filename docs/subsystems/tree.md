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
| `plugins/tree/src/organize.js` | Self-organization (#446): placement by role, role groups and leads, repair (over-full parents, orphans), daily tidy (merge, idle, archive), journal and undo. Exposes the shared primitives (`shared`) allocation uses. |
| `plugins/tree/src/allocate.js` | Forward allocation (#447): `find_bots`, reuse before create, `create_child_bot(parent?)` placement, `create_team` (lead plus children), on `organize.js`'s shared primitives. |
| `plugins/tree/src/roles.js` | Role profiles and similarity (name, role label, description, own prompt, recent tools; deterministic, `classify` hook). |

## Entry points

- `plugins/tree/index.js` — loaded as `@flybot/tree`.

## Invariants

1. Tree code stays inside `plugins/tree/`; no edits to `ds-bot/` or `core/src/`. Runtime sources (`index.js`, `client.js`, `src/`) import only files in that package, Node builtins, or declared dependencies (`ds-bot`); they must not reach `core/` or `plugins/social/` by relative path (#153). Tests may import from `core/` for fixtures. `scripts/lint-plugins.mjs` fails the leak and packs the plugin then imports it.
2. Uses documented plugin APIs only (hooks/slots).
3. Reach (#90): tree never routes an outside sender through the root. A remote sender (friend's Bot) reaching a tree Bot is denied if `flybot.bot.hasAnyGrant` is false (new and adopted Bots, and the Chief, start with no grant) and is not the tree's call if it is granted, so a granted Bot is reached directly, at any depth. Granted Bots on both sides are not the tree's call across trees or to non-tree Bots (the core's owner policy decides); inside one tree the parent/child rule is unchanged, and `stopped` / `report` notices are unchanged. On a core without `hasAnyGrant` the remote-sender rule gives no opinion.

### Child creation (#16, Option B)

- Every tree member (not only the Main/root) may call `create_child_bot`. The new Bot goes under the caller or, with `parent` (#447), under one of the caller's descendants; never elsewhere (a Bot manages only its own downstream).
- `maxChildren` and depth limits stay, checked at the target parent. Parallel creates are serialized per (target) parent.
- `maxChildren` and `maxDepth` apply to **every** create path while the tree plugin is loaded (#446). A Bot made without tree fields (core `create_bot`, the Bot list) is placed by role by `src/organize.js` on `bot.created`: inside the create call when it fits a level or an existing lead, right after when a new lead has to be created first (it is marked `organizing` until then). No parent goes over `maxChildren` at any moment. `create_child_bot` keeps its limit contract (`limit reached` at a full target parent).
- A newly created child starts with no person-grant (`bot.hasAnyGrant` false, even when the parent is granted). Sharing with another person still needs an independent per-Bot grant (default deny). Tree never copies grants and never publishes.

### Placement rules: forward allocation (#447, owner decisions 2026-10-19 ~19:45 and 21:27)

Allocation puts a new Bot in a sensible place once; the self-organization below (#446) is the safety net that keeps the tree healthy afterwards. `src/allocate.js` uses `organize.js`'s shared primitives (`organizer.shared`: role profiles, homes, `fits`, `createLead`, `markLead`, `move`, journal, the reorganization queue), so explicit allocation and automatic reorganization have one set of limit checks and one prompt / trace refresh.

- **Reuse before create.** `find_bots(query?)` (read-only, every tree Bot) lists the Bots in the caller's branch (for Chief: the whole tree) with `id`, `name`, `role`, `parent`, `depth`, `path`, `children`, `lead` and `via` (the caller's direct child on the path, whom it delegates to). With a query, only matches, best first: same role (`sameRole`), the query in the name or role, shared role words (stems: "test" finds "Tester"), the same project, the same domain. Empty query: an overview (first 100). `create_child_bot` checks the whole branch first: a Bot with the same role at any depth is returned as `{ reused, note }` and nothing is created. A Bot outside the caller's branch is not looked at (the daily tidy merges duplicates across branches).
- **Placement-aware creation.** `create_child_bot(name, role_description, parent?)`: `parent` (id or unique name) must be the caller or a descendant, else `parent must be you or one of your descendants`. Limits, depth and the sibling-name check apply at the target, under that parent's lock. Without `parent`, a **marked group lead** in the caller's branch whose group the new Bot belongs to takes it (most specific group first, then the shallower lead, when it has room): "FlyBot Docs" goes under "FlyBot Lead". A Bot that could lead that group itself, or a namesake, never goes under it; with no such lead the caller is the parent. The result names the parent and the tree path.
- **Teams: lead plus children.** `create_team(team, members, parent?)` with `members` as `"Name: role"` strings (2 to `maxChildren`): `"<team> Lead"` (role "Lead of the <team> group: coordinates …", `lead { key, label }` from `roles.js`) under the caller or `parent`, and the members under it: `Chief → FlyBot Lead → {Dev, Test, Maintenance, Repo}`, one slot under Chief. An existing lead of that group in the caller's branch (marked for it, named "<team>" / "<team> Lead", or coordinating it) is reused and marked; a member with the same role already in the branch is reused, and moved under the lead when it sits flat next to it (that frees its slot, so a team fits at a full level when it reuses a flat member). Members that do not fit are listed as not created. A team that moves or marks existing Bots is a journaled run (trigger `team`, one-click undo); a fresh team is a plain create.
- **Plan card**: not built. The codebase has no chat card for a model-proposed plan (approval cards belong to social's message holds), so forward allocation proceeds and names the resulting paths; deferral recorded on #447. Automatic reorganization never asks first.
- **Prompts.** Chief (and every coordinator) is told: `find_bots` before creating and reuse what fits; a project with several roles is one lead with children (`create_team`); a new Bot of a group goes under its lead; at `maxChildren - 2` children or more, group related children under a lead instead of adding another flat one; name the tree path of every new Bot; a full level, orphans and duplicates are fixed by the automatic reorganization, without asking the owner first.
- **Over capacity and orphans → #446.** A full target refuses with `limit reached` (pass a fitting `parent`, or let the tree regroup the level by role). A Bot made outside `create_child_bot` is placed by role (below). An **orphan** (its `parent` no longer in the tree) is a reparent candidate, never parked outside for good: each repair pass (startup, every `bot.created`, after a deletion) moves it with its subtree to the home its role points to (its group's lead, else the root) where it fits; a journaled, undoable move. One that fits nowhere yet is retried on the next pass.

### Self-organization (#446, owner decision 2026-10-19 21:27)

The tree organizes itself by role instead of leaving Bots outside it or a parent over the limit. Forward allocation (above, #447) is built on these primitives.

- **Role profile** (`src/roles.js`, deterministic): name words (weighted most), the ds-bot role label, the tree role (description), the Bot's own prompt text (not the tree block) and the tools it used recently (`activity.tools`, from the `tool.start` feed; common tools such as `message_bot` ignored). They give group keys, most specific first: `project:<word>` (a name word that is not a domain word, e.g. "flybot"), `domain:<id>` (dev, life, writing, research, finance, design, business, learning; English stems and Chinese terms), `word:<w>` (a shared role word) and `area:<work|life|other>` (labels Work / Personal / General). The plugin has no model call (the codebase has no pattern for a plugin to call a Bot's model); `config.classify(profile)` may return `{ domain, project }` to override it.
- **Placement** of a Bot outside the tree: its namesake, else the tree Bot that leads a group it belongs to (most specific key first, then the shallower lead; an area only through a lead made for it, e.g. "Work Lead"), else the root. At the first of those with room it is placed. A full level is **regrouped**: the most specific group of two or more children (the newcomer counted) moves under a suitable existing member, or under a new lead. Inside a full lead of its own group with no finer group, the member closest to its role takes it (all members share the group). There is **no "least-loaded child" fallback**: a Bot that fits no group while every level it matches is full stays outside, a warning names it and the sidebar tags it "outside the tree"; the next attempt (any `bot.created`, startup) tries again.
- **Leads.** A suitable existing lead is a member already marked as that group's lead, already coordinating that group (it has children and the key, project and domain only), or named for it ("Life", "FlyBot Lead") or as a lead ("Kitchen Manager", 负责人). It gets `lead { key, label }`. Only when none fits a new lead is created with a clear role (`<Label> Lead`, role "Lead of the <Label> group: coordinates …"); its members move under it before it joins the level. A lead's own group key, and broad areas below any lead, are ignored inside it, so there is no second "Dev Lead" under "Dev Lead".
- **Repair**: a parent over `maxChildren` (after a deletion re-attached a deleted Bot's children) is regrouped the same way, at once when the lead exists, else in the queue.
- **Daily tidy** (checked hourly, runs once a day; the first check after install only records the time; `dailyTidy: false` turns it off): (1) leaf Bots with no activity for `tidy.idleDays` (14) get `idle` (any turn or tool call clears it) and are **archived** after `tidy.archiveIdleDays` (30) more days; Bots with children, granted Bots and the root are never idle; (2) duplicates: two Bots with essentially the same role (same name once generic words are dropped and no conflicting description, or near-identical descriptions in one domain), both at least `tidy.mergeGraceDays` (1) in the tree, are **merged**: the newer one's children move to the kept Bot, which lists it in `mergedFrom` and is told in its prompt; the old one is archived; (3) project and domain groups of three or more (or two with an existing lead) on every level, never a group of a whole level without a lead.
- **Archive, never delete**: an archived Bot leaves the tree (`archived { at, reason, parent, treeRole, into? }`, tree fields and block removed) but keeps its chat, memory and grants. It is **hidden from the default Bot list** (`bot.hidden` / structure `include`; Search still finds it) (#452). Deleting it stays the owner's own click. Moving conversation / memory references into the kept Bot on a merge needs a core API and is a follow-up (#450).
- **Move, never rename-to-归档 + recreate** (#452): grouping always reparents (`parent`); it never renames a Bot to `归档-…` / `Archive-…` and never creates a replacement with the old name. A one-shot repair strips those prefixes when the bare name is free, or archives+hides the prefixed Bot when a live Bot already has that name.
- **Journal and undo**: every move, new lead, lead mark, merge, archive and idle mark of a run is an action in the root's `reorg { runs (last 5), dismissed, dailyAt }` and a `flybot-tree: reorganized (<trigger>): …` log line. The tree view's notice (sidebar section `flybot-tree-reorg`, `reorgNotice: false` hides it) shows the last run with **Undo** and **Dismiss** (`tree/reorg`, `tree/undo`, `tree/dismiss`). Undo reverses the newest run: moves go back where the old parent has room and the Bot was not moved again, archived Bots come back, a lead the run created is archived once empty; what it cannot restore is listed as kept. Restored Bots are pinned for `tidy.pinDays` (14) so the daily tidy leaves them alone.
- **The owner is told afterwards**, no plan card first: the notice in the tree view, and the Main Bot's prompt names the last run (within 7 days, not undone) so Chief can say what moved.
- **No silent pull-up**: freeing a slot moves nobody up; the next new Bot takes it. Activity is metadata only (when, which tool names), never message text.

### Optional Tree section toggle

- The Bot list itself uses the core `.bt-tree-toggle` (see [core-client](core-client.md)). When `sidebarSection: true` brings this plugin's separate Tree section back, `.flybot-tree-toggle` matches that control: 28×28 hit target, 16px inner `.flybot-tree-caret`, hover, focus ring, and rotation of the glyph only. Leaf spacers (`.flybot-tree-dot`) keep the same 28px width. `aria-expanded` and Expand/Collapse `{name}` labels stay on the button.
- The right-click menu entry from `menuItems({ bot })` is a single **Copy invite link** (bare URL, shown when `social.canInvite(bot.id)`). The invite with instructions is offered only in the Bot's Sharing section, so the menu does not list the same invite twice (#173).

### Discarded promise `.catch` (#213)

The plugin's discarded `.catch(() => {})` calls carry a one-line reason comment or `void`; `check-empty-catch` enforces it (see `docs/code-standards.md`).

## Tests

Covered by the plugin's own tests under `plugins/tree/` / core test suite as wired. The `#447` tests cover reuse of a same-role Bot at depth 3 and `find_bots` (scope, fields, ranking), `create_child_bot(parent)` refusing a non-descendant (sibling, ancestor, outsider, unknown) and checking limits at the target under its lock, `create_team` (Chief → FlyBot Lead → four members, one slot; reuse of the lead and members; a flat member's slot at a full level, journal and undo), later Bots joining their group's lead (only down leads of groups they belong to), and orphan reattachment; `test/host.test.js` runs `find_bots`, `create_team` and `create_child_bot(parent)` on the real host. The `#446` tests in `test/tree.test.js` cover role grouping (Life Lead, FlyBot Lead), existing leads, no unrelated fallback, the cap at every step, the daily tidy (merge, idle, archive), journal, undo and the client notice; `test/host.test.js` runs `create_bot` and the `tree/reorg` / `tree/undo` endpoints on the real host. `#16 Option B` in `test/tree.test.js` (and the matching host test) asserts a non-Main tree Bot can create a child under itself, that `maxChildren`/depth still refuse, and that the child is not auto-granted.

## Common mistakes

- Placing tree logic in `core/` instead of `plugins/tree/`.
- Bypassing the plugin runtime for registration.
- Importing `../../../core/…` from plugin runtime sources (breaks a packaged install, #153).
