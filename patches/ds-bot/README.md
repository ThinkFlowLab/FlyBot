# FlyBot patches on upstream ds-bot

FlyBot's core is **pristine upstream ds-bot plus this ordered patch series** (#34).

- `ds-bot/` is byte-identical to `Fei2411/DeepSeek-Bot` at the commit in `ds-bot.pin.json`
  (checked by git tree hash). Never edit it.
- `core/` is what ships and what the tests run on: `ds-bot/` with these patches applied in
  order. It is committed, so Git installs (`path:/core`; the plugins install from `path:/plugins/*`) need no build.
- CI (`Test` → `package` job) runs `node scripts/ds-bot-patches.mjs check`: `ds-bot/` matches
  the pin, every patch applies cleanly in order, and the result equals the committed `core/`.

| Patch | Topic |
|---|---|
| `0001-core-fixes` | Generic core fixes (diagnostics, memory, models, prompt, time context, turns, text, i18n, model menu); upstream candidates |
| `0002-flybot-api-host` | The `flybot` Cordis service (`src/host/hooks.js`, send middleware with priority bands) and its hook-in points (`index.js`, store, roster, tools) |
| `0003-flybot-api-client` | The browser `flybot` service and slots (`flybot-registry.js`, `flybot-slots.js`) and their render sites |
| `0004-flybot-api-types` | `types/flybot.d.ts`, the plugin contract (host and browser) |
| `0005-social-seams` | Remote chats and the transport/delivery seams that `@flybot/social` uses |
| `0007-version-and-tooling` | Version `0.1.5-flybot.1`, `package.json`/lockfile, `scripts/local-ci.sh`, the install doctor (`scripts/install-doctor.mjs`) |
| `0008-client-bundle` | The generated `client.js` (rebuild with `npm run build` in `core/`) |
| `0009-identity-schema` | The state identity schema tests (team members, owner-bound Bots, #47) |

`0006` is retired: its files (`plugins/social` and its tests) moved out of `core/` to the peer plugin `plugins/social` (#34 PR 2), so no patch carries them. The numbers are not reused.

`topics.json` maps each changed file to one patch (a file belongs to exactly one patch).

## Changing the core

1. Edit files in `core/` and test there (`cd core && npm test`).
2. `node scripts/ds-bot-patches.mjs generate` rewrites the patches from `core/` vs `ds-bot/`
   (add new files to `topics.json` first).
3. `node scripts/ds-bot-patches.mjs check`, commit `core/` and `patches/` together.

## Bumping the upstream pin

1. Replace `ds-bot/` with upstream's `ds-bot/` at the new commit (`git archive <commit> ds-bot`
   from a clone of Fei2411/DeepSeek-Bot), and set `commit`, `tree`
   (`git rev-parse <commit>:ds-bot`) and `version` in `ds-bot.pin.json`.
2. `node scripts/ds-bot-patches.mjs apply`. When a patch fails, apply the rest by hand into
   `core/`, resolve, drop changes upstream already has, then `generate`.
3. Bump the FlyBot suffix (`<upstream version>-flybot.N`) in `core/package.json`, rebuild
   `client.js`, run all tests and `check`, add a CHANGELOG line, and open one PR per bump.
