# @flybot/tree

Recursive bot tree plugin for FlyBot (built on ds-bot / DeepSeek Harness).

## English

### What it does
- **Chief is the root.** ds-bot's Main Bot (`BotView.isMain`, i.e. `state.mainBotIds`; the one named `Chief` if there are several) is adopted as the root with `treeRole: 'root'` (no `parent`); no bot is created. Every other tree bot has `parent` (its parent's id) and `treeRole` (its role). Adoption runs at startup, a few retries later and on every `bot.created`, so a Chief created after startup is picked up. Only if the team has bots but no Main Bot is a separate `Root` created. `config.rootBotId` picks the root explicitly.
- **Migration:** a separate `Root` auto-created by earlier versions (parent `null`, not a Main Bot) hands its children to Chief, loses its tree fields and tree prompt, and gets `fields['flybot-tree'].retired = true` so adoption skips it. The bot itself is **never** deleted (bot-im / the user decide). Idempotent.
- **Adoption (`adoptExisting`, default true):** every local bot with no tree fields that is not retired and not another Main Bot (e.g. existing 研究员, 数据分析师, 文案, 程序员) is placed in the tree at startup and on `bot.created` when the creator set no `parent` (core `create_bot`, the Bot list), at once, inside the create call. **Self-organization (#446, `src/organize.js`, `src/roles.js`)** obeys `maxChildren` and `maxDepth` like `create_child_bot` at every moment: the Bot goes into the group that matches its role (name, role label, description, own prompt, recent tools): its namesake, else the tree Bot that leads that group, else Chief. A full level is regrouped by role: related children move under a suitable existing member (already that group's lead, already coordinating it, or named for it / as a lead, e.g. "Kitchen Manager"), or under a new lead with a clear role ("FlyBot Lead", "Life Lead"); never under an unrelated Bot (no least-loaded fallback). A Bot that fits no group while every matching level is full stays outside, logged and tagged "outside the tree", and is retried on the next attempt. A daily tidy also groups related Bots, merges duplicates (the old Bot is archived, never deleted) and marks long-idle leaf Bots idle, archiving them after 30 days. Every change is journaled on Chief's `reorg` field and logged (`flybot-tree: reorganized (…): …`); the tree view shows the last run with Undo / Dismiss, and Chief's prompt names it. A freed slot does not pull anyone back up. Adopted bots keep their own prompt; the tree block is added. Message rules apply to them like any tree child (Chief ↔ them; they → only Chief and their own children).
- **Prompt injection:** the tree text sits in a marked block (`<!-- flybot-tree:start -->…<!-- flybot-tree:end -->`) inside each bot's `systemPrompt`; only that block is replaced, so Chief's own prompt text is never overwritten. Chief gets the coordinator rules for its direct children.
- `bot.send` middleware `tree`: inside the tree a bot may message only its parent and direct children (`deny` otherwise). A non-root tree bot may not message local bots outside the tree; the root (Chief) may message any local bot. Local bots outside the tree may message only the root. Remote targets and outside-to-outside sends get no opinion (`undefined`, social decides). **Granted Bots (#90):** a friend's (remote) sender reaches a tree bot only if the core says it has a person-grant (`flybot.bot.hasAnyGrant`): new and adopted bots and the Chief start with none. A granted bot is reached directly at any depth, never redirected through the root; an ungranted one is denied (`tree: this bot has not been granted…`). Granted bots on both sides are not the tree's call across trees or to non-tree bots (the core's owner policy decides); inside one tree the parent/child rule is unchanged, as are `stopped` / `report` notices. A granted child's prompt tells it to answer outside senders directly, without a trace line, and to delegate only to its own children. On a core without `hasAnyGrant`, the remote-sender rule gives no opinion.
- **Control notices bypass tree policy:** `role: 'stopped'` (stop_bot) and `role: 'report'` are never denied by the tree middleware, so a Main Bot can stop any tree bot.
- **Deleting a bot:** its children re-attach to its parent and every moved child (and its subtree) gets a fresh prompt/trace. No child is dropped. If that parent is now over `maxChildren`, it is regrouped by role automatically (#446), the same way as a full level, until it is within the limit. Each move is journaled and logged.
- **`create_child_bot` is serialized per parent:** parallel calls never exceed `maxChildren` or create duplicate-name siblings.
- Delegation is level by level: coordinators delegate to direct children whose scope fits and aggregate upward; a bot with no children does the work itself. A one-line trace like `Chief → Work → Dev` is added only to answers a tree bot sends to its parent tree bot; replies to the user or to a remote (friend's, Bot Social) bot never carry it, and the root (Chief) never adds one.
- Tools (visible to every tree bot, not only Main/root — #16 Option B): `list_children()` and `create_child_bot(name, role_description)`. The parent is always the calling bot. Limits: depth 5 (root = 1), 8 children per node; duplicate sibling names (case/space-insensitive) are rejected; names are 1–40 characters (ds-bot's roster limit). Every new child gets the same recursive system prompt template (`src/prompt.js`). A new child starts with no person-grant even if its parent is granted; sharing it still needs an independent Invite to this Bot (default deny).
- Frontend (`client.js`, bundle id `@flybot/tree`, injects `flybot`): the tree is drawn by ds-bot's own Bot list, so this plugin's separate "Tree" sidebar section is **off by default** (`sidebarSection: true` in the client config brings it back). It always exposes the synchronous helper `ctx.flybot.tree.forest(bots)` (also `globalThis.__flybot__.tree.forest(bots)`), see **Tree data** below. It also registers `flybot.sidebar.structure` (`{ parentOf(botId) }`, parents from `forestOf` over `ctx.flybot.bots()`, refreshed on field changes and every 10 s); ds-bot's sidebar uses it to draw its Bot list as one expandable tree with Chief on top. Retired, archived and outside Bots and other Main Bots have no parent there, so ds-bot shows them directly under Chief; the entry's `nodeActions` draws a tag after such a row ("archived", "archived · merged into …", "outside the tree") and after an idle Bot ("idle"), so the sidebar and the tree model agree. A `flybot.sidebar.section` entry `flybot-tree-reorg` shows the last reorganization (what moved) with Undo and Dismiss, through the host endpoints `tree/reorg`, `tree/undo`, `tree/dismiss`; it draws nothing when there is none in the last 7 days (`reorgNotice: false` in the client config hides it). The entry also has `menuItems({ bot })`, which ds-bot adds to each Bot's right-click menu: one item, `{ id: 'copy-invite', label: 'Copy invite link' }` (with `visible`, `run`); the invite with instructions is offered in the Bot's Sharing section only, so the menu does not list the same invite twice (#173). `visible` is `social.canInvite(bot.id) === true` (false without the social plugin); `run` calls `social.createInvite(botId)` (or `flybot.call('social.createInvite', { botId })`). **Copy invite link** copies only the bare URL (`link`); `copyInvite(flybot, botId, 'text')` copies the full message `text` for other callers; a missing field is an error, never swapped for the other. The clipboard write starts inside the click via `ClipboardItem` with the text as a promise, so it keeps the click's permission while the invite is created; `writeText` then a textarea are the fallbacks. It returns "Invite link for <name> copied", which ds-bot shows as a toast; a failure throws and shows as the error toast. Right-clicking never opens the Bot's chat.

### Config
```yaml
- id: tree
  name: "@flybot/tree"
  config:
    maxDepth: 5        # default from limits.json
    maxChildren: 8
    bypassSocial: false # true: allowed tree edges skip social friend/approval checks
    rootName: Root      # name of the fallback root, only when the team has no Main Bot
    rootBotId: ''       # optional: adopt this bot as the root instead of the Main Bot
    autoRoot: true      # false: do not adopt/create the root at startup
    adoptExisting: true # false: do not attach existing/new parentless bots to Chief
    dailyTidy: true     # false: no daily reorganization pass (#446)
    tidy:               # daily tidy thresholds (#446)
      idleDays: 14        # no activity this long: a leaf Bot is marked idle
      archiveIdleDays: 30 # idle this long: archived (never deleted)
      mergeGraceDays: 1   # Bots newer than this are not merged
      pinDays: 14         # after an undo, the tidy leaves restored Bots alone this long
    # classify: (profile) => ({ domain, project })  # programmatic only: a smarter role classifier
    # client side (browser plugin config): sidebarSection: false  # true: show the separate Tree section
    #                                       reorgNotice: true     # false: hide the reorganization notice
```

### Tree data (for ds-bot's sidebar)
Everything is synchronous.

**Fields** (per bot, `bot.fields['flybot-tree']`; also on every bot in the browser roster, which spreads the stored bot record including `fields` and `createdAt`):

| key | value |
|---|---|
| `treeRole` | `'root'` on the root (Chief); the role text (may be `''`) on other members |
| `parent` | parent bot id; absent on the root |
| `retired` | `true` on the old auto-created Root: not a member, never re-adopted |
| `lead` | `{ key, label }` on a group lead (#446), e.g. `{ key: 'project:flybot', label: 'FlyBot' }` |
| `archived` | `{ at, reason: 'merged' \| 'idle' \| 'undo', parent, treeRole, into?, intoName? }`: out of the tree, never deleted |
| `idle` | epoch ms since the Bot was marked idle |
| `activity` | `{ at, tools }`: last activity and up to 8 recent tool names (metadata only) |
| `reorg` | on the root: `{ runs, dismissed, dailyAt }`, the reorganization journal (last 5 runs) |

A bot is a tree member when it has `treeRole` or `parent` and is not `retired`.

**Helper:** `forest(bots)` turns bot records into nested nodes:
- browser: `ctx.flybot.tree.forest(roster.bots)` or `globalThis.__flybot__.tree.forest(roster.bots)`
- host: `apply(...).tree.forest()` (reads `bot.list()` and the scoped fields)
- module: `forestOf(bots)` from `src/forest.js`

```ts
type TreeNode = {
  id: string
  name: string
  role: string          // 'Main bot · root of the tree' for the root, else treeRole ('' allowed)
  root: boolean         // treeRole === 'root'
  createdAt: number | null  // the record's createdAt, null when absent
  children: TreeNode[]
}
forest(bots: Array<{ id: string, name: string, createdAt?: number, fields?: { 'flybot-tree'?: { parent?: string, treeRole?: string, retired?: boolean } } }>): TreeNode[]
```
Top level: roots first, then members whose parent is missing (orphans). Siblings are ordered by `createdAt`; records without it keep their input order; ties go by name. Cycles are cut. Non-members, retired bots and remote bots (never in the roster's `bots`) are left out, so ds-bot draws them as before.

### Plugin format (matches ds-bot)
`package.json` has `"type": "module"`, keyword `dsh-plugin`, `exports` `.` (host) and `./client` (browser), and `"dsh": { "client": { "platform": "web" } }`. The host entry exports `name`, `inject`, `apply(ctx, config)` (cordis style). `client.js` uses `window.__ModuleLoader__.load({ id, factory(require) })` with `react` provided by the shell; it exports `inject: ['flybot']` + `apply(ctx)` and registers its section via `ctx.flybot.slots.register`.

### Interface (ctx.flybot, finalized by bot-im 2026-10-14 — all in `src/adapter.js`)
| API | Shape |
|---|---|
| `ctx.flybot.scope('flybot-tree')` | every call below goes through this scoped handle, so fields land in `fields['flybot-tree']` (never `shared`) |
| `bot.list()` | `BotView[]` |
| `bot.create({ name, systemPrompt, fields })` | **async**, resolves to the new id (awaited; `create_child_bot` returns the id) |
| `bot.setSystemPrompt(id, text)` | text ds-bot appends to the bot's system prompt (`BotView.systemPrompt`); the tree only replaces its own marked block |
| `fields.get/set` | **sync**, namespaced by the scope; `null` removes a key |
| `on('change' \| 'bot.created' \| 'bot.removed', fn, { all? })` | `change`: `{ botId, plugin, key, value, prev }`, own plugin unless `{ all: true }`; `bot.removed`: `{ botId, bot }` after deletion, parent read from `bot.fields['flybot-tree'].parent`; children re-attach to it |
| `bot.send.use({ name, before, after, handle })` | tree bot → parent/direct child only; local non-tree bot → tree root only; non-root tree bot → local non-tree bot **deny**, root (Chief) → any local bot ok; `bypass:['social']` only if `bypassSocial: true` |
| `tools.register` | `visibleTo(botId)` sync; `execute(args, { botId })`. JSON Schema `minLength`/`maxLength` are dropped by register, so `execute` validates them (`validateArgs`) |
| browser | `ctx.flybot.bots()` items carry `fields: { [plugin]: {...} }` (read `fields['flybot-tree']`); tree built in-plugin |
| remote senders | `typeof from !== 'string'` or `bot.isRemote(from)`: denied toward an ungranted tree bot (`bot.hasAnyGrant(id) === false`), else no opinion; never redirected to the root |
| remote targets | `target.remote === true` (`{ handle, home }`), fallback `bot.isRemote(to)`; never tree members: passed to social |
| `bot.created` | handled by social; tree does not subscribe |
| root | ds-bot's Main Bot (Chief) adopted with `treeRole: 'root'` (`ensureRoot`, idempotent); fallback `Root` only without a Main Bot; earlier auto-created `Root` migrated, not deleted |

### Test
From `plugins/tree`: `npm test` (Node 24). It runs `test/tree.test.js` and `test/host.test.js`, which boots the real ds-bot core by its public entry (`import { apply } from 'ds-bot'`) in a plugin-local fake Cordis context (`test/fake-cordis.js`), loads tree with `ctx.plugin(tree, config)` and reaches the host only through `ctx.flybot`. `test/resolve.mjs` maps `ds-bot` to `FLYBOT_CORE`, else the repo-root `core/` (the patched core; `ds-bot/` is pristine upstream); the core's `@deepseek-ai/*` peers come from `DSH_HARNESS` or `<core>/dev/harness`. ds-bot's own `npm test` no longer runs tree's tests (#34). `test/mock-flybot.js` is an in-memory mock of `ctx.flybot`. This repo has no pnpm workspace, so there is no `pnpm --filter` command.

### ds-bot integration (already in place)
ds-bot needs no changes for this plugin. `src/host/hooks.js` is a module in ds-bot's `MODULES` list (`index.js`, after `dshUpdate`, before `remoteChat` and `channel`), and `index.js` `provideFlyBot()` exposes `rt.flybot` as the `flybot` service, so `inject: ['flybot']` resolves. `scripts/lint.mjs` lints `plugins/`, and `build-client.mjs --check` covers the client bundle.

### Cleanup
`apply()` registers its disposer with `ctx.effect(() => dispose, 'flybot-tree')`, so unloading the plugin removes the send middleware, tools, event listeners and root-adoption timers. On a host without `ctx.effect` it falls back to `ctx.on('dispose')`. `apply()` also returns `{ tree, dispose }`.
