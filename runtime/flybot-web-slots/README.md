# FlyBot web slots for dsh web

FlyBot-authored adapter. Upstream DS-Bot v0.3.6 has no `globalThis.__flybot__`
slot host, so `@flybot/social`'s browser half cannot register its UI by itself.

This package:

- installs `globalThis.__flybot__` (slot registry, `call()`, `canRetry`, name helpers)
- posts social endpoints to `POST /api/flybot` (same JSON shape as `POST /api/bot`,
  session-cookie authenticated, social/* only)
- bridges component slots onto dsh-web-app regions (`settings.section`,
  `conversation.composer.dock`, `conversation.session.header`, and when the
  profile accepts it, `sidebar.footer.action`)

The official ds-bot client bundle is **not** loaded as a second profile plugin:
the runtime wrapper already runs `createRuntime()` once.

Composer `@` rows from `flybot.composer.mention` are registered on the official
DSH `inputTriggers.registerSource` seam (the same contract unmodified ds-bot
v0.3.6 uses in `src/client/at-menu.js`). Tests use an in-process fake
`registerSource` only; they are not a live dsh-web or Teamily comparison.

The official ds-bot v0.3.6 details drawer (`src/client/details-drawer.js`)
has no slot for `flybot.bot.details`. This adapter does not invent a drawer
slot or edit the vendored ds-bot tree. Instead it installs its own
FlyBot-branded details surface on the already-bridged dsh-web-app regions
`conversation.session.header`, `conversation.composer.dock` (reachable when
the host hides a blank session header), and `settings.section`. Opening that
surface renders components registered on `flybot.bot.details` (Bot Social
registers `BotSocialDetails`). Tests mount a fake dsh slot host and drive
the real social client; they are not a live dsh-web or Teamily comparison.

`@flybot-workspace/flybot-social-web` is a client-only DSH bundle that loads
`@flybot/social/client.js` after this host. Its server `apply()` is a no-op.

Not Teamily parity. Live Bot Social onboarding stays off (`onboard: false`).
