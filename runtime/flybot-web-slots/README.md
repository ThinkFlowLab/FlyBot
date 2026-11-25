# FlyBot web slots for dsh web

The FlyBot web adapter provides the `globalThis.__flybot__` slot host
for the `@flybot/social` browser client.

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
DSH `inputTriggers.registerSource` interface. Tests use an in-process
`registerSource` fixture.

The upstream DS-Bot details drawer (`src/client/details-drawer.js`)
has no slot for `flybot.bot.details`. This adapter does not invent a drawer
slot or edit the vendored ds-bot tree. Instead it installs its own
FlyBot-branded details surface on the already-bridged dsh-web-app regions
`conversation.session.header`, `conversation.composer.dock` (reachable when
the host hides a blank session header), and `settings.section`. Opening that
surface renders components registered on `flybot.bot.details` (Bot Social
registers `BotSocialDetails`). Tests mount a fake dsh slot host and drive
the social client.

`@flybot-workspace/flybot-social-web` is a client-only DSH bundle that loads
`@flybot/social/client.js` after this host. Its server `apply()` is a no-op.

The browser bundle leaves Bot Social onboarding off (`onboard: false`).
