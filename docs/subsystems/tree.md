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
| `plugins/tree/src/roles.js` | Role profiles and similarity (name, role label, description, own prompt, recent tools; deterministic, `classify` hook; reads a stored `modelDomain`). |
| `plugins/tree/src/load.js` | Runtime load (#507) and how long a turn has been open (#624): pure `createLoadTracker`/`loadWord`/`loadLine` for the open turns each Bot runs, fed from the activity feed. A deletion drops the removed Bot's records (`clear(id)`, #732), so every record belongs to a live Bot. |
| `plugins/tree/src/classify-model.js` | Model-based clustering (#450 item 2): opt-in classification through the sanctioned plugin model call (#518). |

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

### Reorganising the tree: `move_bot` and adoption after a deletion (#635)

- **`move_bot(bot, parent)`** (root only) moves an existing Bot with its subtree under another parent, found by id or by unique name, and refreshes the prompt of every Bot whose trace changed. It refuses a cycle (`cannot move X under its own descendant Y`), a no-op (`already a child of`), a duplicate sibling name, `maxChildren` at the target, and a subtree that would end deeper than `maxDepth` — the same invariants `create_child_bot` keeps, applied to a move. It never creates a Bot: deletion already re-attaches a removed Bot's children to its parent, and this is the sideways counterpart.
- **A deletion re-runs adoption.** `onBotRemoved` re-attaches the deleted Bot's children first, then calls `adoptUnattached` on the current root: a Bot that stayed outside the tree only because a level was full joins as soon as the deletion frees a slot, instead of waiting for the next startup. A Bot that still fits nowhere stays outside, logged, and is retried on the next pass. Removing the **root** hands its children to the team's current Main (adopted as the root now), or to a fresh Root when there is no Main, so the team stays one tree instead of children left with `parent: null` that `isRoot` reads as extra roots.
- Tests: `test/tree.test.js` — `#635: move_bot moves a bot with its subtree and refreshes the prompts`, `#635: move_bot refuses cycles, overflow, duplicates and a too deep subtree`, `#635: move_bot refuses an overflowing parent and refreshes the subtree`, and `#635: a Bot left outside because the tree was full joins when a deletion frees a slot`.
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

- **Role profile** (`src/roles.js`, deterministic): name words (weighted most), the ds-bot role label, the tree role (description), the Bot's own prompt text (not the tree block) and the tools it used recently (`activity.tools`, from the `tool.start` feed; common tools such as `message_bot` ignored). They give group keys, most specific first: `project:<word>` (a name word that is not a domain word, e.g. "flybot"), `domain:<id>` (dev, life, writing, research, finance, design, business, learning; English stems and Chinese terms), `word:<w>` (a shared role word) and `area:<work|life|other>` (labels Work / Personal / General). `config.classify(profile)` may return `{ domain, project }` to override it. A stored model category (`modelDomain`, below) fills the domain only when the vocabulary found none.
- **Placement** of a Bot outside the tree: its namesake, else the tree Bot that leads a group it belongs to (most specific key first, then the shallower lead; an area only through a lead made for it, e.g. "Work Lead"), else the root. At the first of those with room it is placed. A full level is **regrouped**: the most specific group of two or more children (the newcomer counted) moves under a suitable existing member, or under a new lead. Inside a full lead of its own group with no finer group, the member closest to its role takes it (all members share the group). There is **no "least-loaded child" fallback**: a Bot that fits no group while every level it matches is full stays outside, a warning names it and the sidebar tags it "outside the tree"; the next attempt (any `bot.created`, startup) tries again.
- **Leads.** A suitable existing lead is a member already marked as that group's lead, already coordinating that group (it has children and the key, project and domain only), or named for it ("Life", "FlyBot Lead") or as a lead ("Kitchen Manager", 负责人). It gets `lead { key, label }`. Only when none fits a new lead is created with a clear role (`<Label> Lead`, role "Lead of the <Label> group: coordinates …"); its members move under it before it joins the level. A lead's own group key, and broad areas below any lead, are ignored inside it, so there is no second "Dev Lead" under "Dev Lead".
- **Repair**: a parent over `maxChildren` (after a deletion re-attached a deleted Bot's children) is regrouped the same way, at once when the lead exists, else in the queue.
- **Daily tidy** (checked hourly, runs once a day; the first check after install only records the time; `dailyTidy: false` turns it off): (1) leaf Bots with no activity for `tidy.idleDays` (14) get `idle` (any turn or tool call clears it) and are **archived** after `tidy.archiveIdleDays` (30) more days; Bots with children, granted Bots and the root are never idle; (2) duplicates: two Bots with essentially the same role (same name once generic words are dropped and no conflicting description, or near-identical descriptions in one domain), both at least `tidy.mergeGraceDays` (1) in the tree, are **merged**: the newer one's children move to the kept Bot, which lists it in `mergedFrom` and is told in its prompt; the old one is archived; (3) project and domain groups of three or more (or two with an existing lead) on every level, never a group of a whole level without a lead.
- **Archive, never delete**: an archived Bot leaves the tree (`archived { at, reason, parent, treeRole, into? }`, tree fields and block removed) but keeps its chat, memory and grants. It is **hidden from the default Bot list** (`bot.hidden` / structure `include`; Search still finds it) (#452). Deleting it stays the owner's own click. On a merge (#450 item 1), the archived Bot's own memory is carried into the kept Bot through `flybot.memory` (at most 20 entries, tagged `source: merged`), so a merge loses nothing; without the host's memory seam the merge still stands.
- **Move, never rename-to-归档 + recreate** (#452): grouping always reparents (`parent`); it never renames a Bot to `归档-…` / `Archive-…` and never creates a replacement with the old name. A one-shot repair strips those prefixes when the bare name is free, or archives+hides the prefixed Bot when a live Bot already has that name.
- **Journal and undo**: every move, new lead, lead mark, merge, archive and idle mark of a run is an action in the root's `reorg { runs (last 5), dismissed, dailyAt }` and a `flybot-tree: reorganized (<trigger>): …` log line. The tree view's notice (sidebar section `flybot-tree-reorg`, `reorgNotice: false` hides it) shows the last run with **Undo** and **Dismiss** (`tree/reorg`, `tree/undo`, `tree/dismiss`). Undo reverses the newest run: moves go back where the old parent has room and the Bot was not moved again, archived Bots come back, a lead the run created is archived once empty; what it cannot restore is listed as kept. Restored Bots are pinned for `tidy.pinDays` (14) so the daily tidy leaves them alone.
- **The owner is told afterwards**, no plan card first: the notice in the tree view, and the Main Bot's prompt names the last run (within 7 days, not undone) so Chief can say what moved.
- **No silent pull-up**: freeing a slot moves nobody up; the next new Bot takes it. Activity is metadata only (when, which tool names), never message text.

### Runtime load (#507)

A coordinator can see which of its children are busy right now, so it sends a new part to a free one instead of stacking work on a busy one.

- `src/load.js` (pure) counts the open turns per Bot from the core activity feed (`turn.start` / `turn.end`, ids and times only). `index.js` subscribes both events; nothing is persisted (a restart starts from zero). A removed Bot's turns can never end, so `onBotRemoved` calls `clear(id)` and the count for that id reads 0 again, while a live Bot keeps its own records (#732).
- The coordinator's prompt gains one line — `Child load right now — Work: busy (2 running), Travel: idle.` — and `list_children` carries a `load` count per child. A child's turn boundary rewrites its parent's prompt through `refreshPrompt` (the marked block only, and `writeBlock` skips an unchanged block), so the line stays current; `list_children` reads the tracker live. The same boundary (`turn.start` / `turn.end`) rewrites the running Bot's own prompt too, so a rename or role edit made in the core reaches its own prompt and, through the parent refresh, its coordinator's child list on the next turn instead of only after a restart.

#### How long a turn has been open (#624)

A count alone cannot tell a long turn from a stuck one: `load: 1` read the same for a turn three seconds in and for one that had been open 47 minutes without consuming its queue.

- The tracker keeps each open turn's start time, so `openFor(id)` answers the age of the **oldest** open turn and `0` when the Bot is idle. An end closes **its own** turn: `index.js` hands the feed's `turnId` to `end(id, turnId)`, because dropping whichever turn was oldest left the *newer* turn's age behind when a later turn ended first (#696). No match — an id never seen, or none at all — still drops exactly one turn, the oldest, so the count cannot drift.
- Past `STALLED_AFTER_MS` (12 minutes) the coordinator's line says the age instead of just the count — `Work: working (47 min, no turn ended)`, or `Work: busy (2 running, oldest open 47 min)`. `list_children` gains `openForMs` (and `stalled: true` past the threshold) only for a child with a turn open, so an idle child keeps exactly its old shape and every existing reader of `load` keeps a number. The tool's description names those fields too (#733): a model reads the description, not this code, and a coordinator that never learns `stalled` exists cannot route around it.
- **A hint for routing, never a gate.** The tree plugin cannot see a Bot's inbox, so a legitimately long turn ages too; nothing here refuses, ends or reassigns work. `loadLine`'s third argument is optional, so a caller that only has a count keeps the old line.

### Model-based clustering (#450 item 2)

The rules above place a Bot by the words in its name, role label and description. When those words say nothing (a job title the small vocabulary does not hold, a brief in another language), the Bot fits no group and stays outside. `src/classify-model.js` asks the sanctioned plugin model call (#518) for one category and remembers it.

- **Opt-in twice over.** It runs only when the tree config sets `modelClassify: true` AND the host allow-lists this plugin in `flybot.modelPlugins`. With either missing, `askModel` answers `no-api` / `not-allowed` and the Bot keeps its rules profile; nothing is asked.
- **One call per changed role.** For each non-root tree Bot, the classifier sends the name, role label and description and asks for one of the domain ids (or `none`). The answer is stored in the Bot's own field `modelDomain { domain, fp, at }`, keyed by a fingerprint of the role text, so an unchanged Bot is asked once. A refused or unparsable answer stores nothing and never clears a good label. The host's own caps (input, output, calls-per-minute) bound every call.
- **Rules first, model fills the gap.** `roles.js` reads the stored category and applies it only when the vocabulary found no domain, so the deterministic grouping stays primary and a model answer cannot override it.
- **Where it shows.** The richer category feeds `find_bots` (search by meaning) at once, and the next reorganization groups by it. It is a category id, never message text.
- Tests: `plugins/tree/test/classify-model.test.js`.

### Optional Tree section toggle

- The Bot list itself uses the core `.bt-tree-toggle` (see [core-client](core-client.md)). When `sidebarSection: true` brings this plugin's separate Tree section back, `.flybot-tree-toggle` matches that control: 28×28 hit target, 16px inner `.flybot-tree-caret`, hover, focus ring, and rotation of the glyph only. Leaf spacers (`.flybot-tree-dot`) keep the same 28px width. `aria-expanded` and Expand/Collapse `{name}` labels stay on the button.
- The right-click menu entry from `menuItems({ bot })` is a single **Copy invite link** (bare URL, shown when `social.canInvite(bot.id)`). The invite with instructions is offered only in the Bot's Sharing section, so the menu does not list the same invite twice (#173).

### Discarded promise `.catch` (#213)

The plugin's discarded `.catch(() => {})` calls carry a one-line reason comment or `void`; `check-empty-catch` enforces it (see `docs/code-standards.md`).

## Tests

Covered by the plugin's own tests under `plugins/tree/` / core test suite as wired. The `#447` tests cover reuse of a same-role Bot at depth 3 and `find_bots` (scope, fields, ranking), `create_child_bot(parent)` refusing a non-descendant (sibling, ancestor, outsider, unknown) and checking limits at the target under its lock, `create_team` (Chief → FlyBot Lead → four members, one slot; reuse of the lead and members; a flat member's slot at a full level, journal and undo), later Bots joining their group's lead (only down leads of groups they belong to), and orphan reattachment; `test/host.test.js` runs `find_bots`, `create_team` and `create_child_bot(parent)` on the real host. The `#446` tests in `test/tree.test.js` cover role grouping (Life Lead, FlyBot Lead), existing leads, no unrelated fallback, the cap at every step, the daily tidy (merge, idle, archive), journal, undo and the client notice; `test/host.test.js` runs `create_bot` and the `tree/reorg` / `tree/undo` endpoints on the real host. `#16 Option B` in `test/tree.test.js` (and the matching host test) asserts a non-Main tree Bot can create a child under itself, that `maxChildren`/depth still refuse, and that the child is not auto-granted. Runtime load (#507) is covered by `test/load.test.js` (pure) and a `test/tree.test.js` case: a child's running turns show in the coordinator's stored prompt and `list_children`, and drop to zero at `turn.end`. The age of an open turn (#624) is covered in both: `openFor` reads the oldest start and falls back to the newer turn once one ends, an end that names its turn closes that one and not the oldest (#696, unknown and missing ids included), the line names the age only past the threshold and never calls an idle child stalled, and `list_children` adds `openForMs`/`stalled` for an open turn while an idle child keeps the old shape.

## Common mistakes

- Placing tree logic in `core/` instead of `plugins/tree/`.
- Bypassing the plugin runtime for registration.
- Importing `../../../core/…` from plugin runtime sources (breaks a packaged install, #153).
