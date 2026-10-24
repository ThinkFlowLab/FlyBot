# FlyBot patches on upstream ds-bot

FlyBot's core is **pristine upstream ds-bot plus this ordered patch series** (#34).

- `ds-bot/` is byte-identical to `Fei2411/DeepSeek-Bot` at the commit in `ds-bot.pin.json`
  (checked by git tree hash). Never edit it.
- `core/` is what ships and what the tests run on: `ds-bot/` with these patches applied in
  order. It is committed, so Git installs (`path:/core`; the plugins install from `path:/plugins/*`) need no build.
- CI (`Test` → `package` job) runs `node scripts/ds-bot-patches.mjs check`: `ds-bot/` matches
  the pin, `files/` and every patch apply cleanly in order, and the result equals the committed `core/`.

## Format (merge-friendly on purpose)

Two branches that edit the same `core/` file in different places must merge without a conflict in
the generated output. A stock `git diff` breaks that: `index <hash>` lines and `@@ … +<start>,<count> @@`
numbers change with every edit, and a new file is one hunk whose line count changes with every edit.
So `generate` writes:

- `files/<path>`: every file FlyBot adds (or replaces, when binary), **verbatim**. `apply` copies
  `files/` over `ds-bot/` first. A file here conflicts exactly when `core/<path>` does, and needs no
  entry in `topics.json`.
- `<topic>.patch`: edits to files that upstream has, as unified diffs with **no `index` lines**
  and each hunk's new-side start set to its old-side start (a position hint for `git apply`; the old
  side is fixed by the pristine upstream, the true new side moves with every hunk above it). The
  header line has no file count. `generate` applies each file's diff alone and compares it with
  `core/` before it writes anything, and falls back to the exact numbers for a file where the hint
  would not reproduce it.

What still conflicts, and should: two edits within the context of one hunk (about 6 lines of each
other), and the same file edited in the same place. Resolve by taking `main`'s `patches/ds-bot/` and
running `generate` (see the conflict recipe in [AGENTS.md](../../AGENTS.md)). `core/client.js` and its
patch `0008-client-bundle` are generated from `core/src/client/` and still conflict whenever two branches
change the client; that is a known follow-up (build the bundle instead of patching it).

### What `check` holds the series to (#978)

`scripts/ds-bot-patches.mjs check` applies the series with `git apply` where git exists, and with its own
applier where it does not (the machine the Bots work on has no `git`, and `github.com:443` does not
resolve there). Both hold the same rules, and a test runs both over every patch and compares the trees
byte for byte:

- a hunk body carries exactly the line counts its header declares on each side — that is `#934`'s extra
  blank context line;
- every hunk matches at the old-side line its header names. The applier never searches for the context
  nearby, so a header that is off by a line fails instead of writing the file one line off (`#966`);
- no hunk runs past the end of the file on either side;
- `\ No newline at end of file` is honoured on both sides, and a missing final newline survives;
- `-p1` strip, whole-file create/delete and `new file mode` work as with `git apply`.

The old-side start is exact because the pristine upstream fixes it; the new-side start is only a position
hint (see above) and is not used to place a hunk. On a machine without git the pin is skipped out loud
(`skipped pin (no git): the tree hash cannot be computed here`) instead of passing quietly, and `generate`
still refuses to run because it asks git for the diff. `apply` and `check` work either way.

| Patch | Topic |
|---|---|
| `0001-core-fixes` | Generic core fixes (diagnostics, memory, models, prompt, time context, turns, text, i18n, model menu); upstream candidates |
| `0002-flybot-api-host` | The `flybot` Cordis service (`src/host/hooks.js`, send middleware with priority bands) and its hook-in points (`index.js`, store, roster, tools) |
| `0003-flybot-api-client` | The browser `flybot` service and slots (`flybot-registry.js`, `flybot-slots.js`) and their render sites |
| `0004-flybot-api-types` | `types/flybot.d.ts`, the plugin contract (host and browser): a new file, so it lives in `files/` |
| `0005-social-seams` | Remote chats and the transport/delivery seams that `@flybot/social` uses |
| `0007-version-and-tooling` | Version `0.1.5-flybot.1`, `package.json`/lockfile, `scripts/local-ci.sh`, the install doctor (`scripts/install-doctor.mjs`) |
| `0008-client-bundle` | The generated `client.js` (rebuild with `npm run build` in `core/`) |
| `0009-identity-schema` | The state identity schema tests (team members, owner-bound Bots, #47) |
| `0013-published-reach` | `src/host/reach.js`, the owner policy that decides which Bots other owners and friends can reach (per-Bot grants, #90; the `published` flag is gone), and its tests |
| `0014-flybot-branding` | User-visible FlyBot chrome on upstream files (About, settings, diagnostics paste notes, update/secrets/parts/browser host copy). New files (`src/client/brand.js`, `test/branding.test.js`) live in `files/`. Header mark/name and i18n live in `0003` / `0001`. |

Topics that only add files (`0004`, `0010`, `0011`, `0013`, parts of `0002`, `0003`, `0005`, `0007`, `0009`, `0012`) have no `.patch` any more: their files are in `files/`. The table keeps the topic names as a map of what each change set is.

`0006` is retired: its files (`plugins/social` and its tests) moved out of `core/` to the peer plugin `plugins/social` (#34 PR 2), so no patch carries them. The numbers are not reused.

`topics.json` maps each edited upstream file to one patch (a file belongs to exactly one patch). Files that upstream does not have need no entry.

## Changing the core

1. Edit files in `core/` and test there (`cd core && npm test`).
2. `node scripts/ds-bot-patches.mjs generate` rewrites `patches/ds-bot/` from `core/` vs `ds-bot/`
   (a first edit to an upstream file needs a `topics.json` entry first; a new file does not).
3. `node scripts/ds-bot-patches.mjs check`, commit `core/` and `patches/` together.

## Bumping the upstream pin

1. Replace `ds-bot/` with upstream's `ds-bot/` at the new commit (`git archive <commit> ds-bot`
   from a clone of Fei2411/DeepSeek-Bot), and set `commit`, `tree`
   (`git rev-parse <commit>:ds-bot`) and `version` in `ds-bot.pin.json`.
2. `node scripts/ds-bot-patches.mjs apply`. When a patch fails, apply the rest by hand into
   `core/`, resolve, drop changes upstream already has, then `generate`.
3. Bump the FlyBot suffix (`<upstream version>-flybot.N`) in `core/package.json`, rebuild
   `client.js`, run all tests and `check`, add a CHANGELOG line, and open one PR per bump.
