// flybot-social: a FlyBot plugin (Cordis plugin for DeepSeek Harness) that lets every
// local Bot chat with friends' Bots on a Bot Social server. Needs ds-bot with the
// FlyBot API (ctx.flybot). See README.md for the home / member model.
//
// Config:
//   server           Bot Social base URL: the default. Settings → Bot Social can pick another one
//                    (kept in flybot-social-server.json beside the credentials, #337)
//   credentialsPath  where the one-call onboarding keeps { token, home } (default
//                    $DSH_HOME/bot/flybot-social.json, mode 600; never committed)
//   displayName      name for the home on first onboarding
//   webhookUrl       optional push webhook registered at onboarding
//   approval         { default: 'hold' | 'auto', homes: { '@bob.home': 'auto' } }
//   inboxPollMs      poll members' inboxes this often while idle; 0 = off (default 15000)
//   facePollMs       faster poll while a live face-to-face room is open (default 4000)
//   presence         false turns off "Name is thinking…" for friends' Bots (Bot Social presence signal, #297; default on)
//   token / botId    legacy per-bot identity (no home): owner connector token + bot id
import { join } from 'node:path'
import { dshHomeOf } from './src/dsh-home.js'
import { NS, registerUnavailable, startFailureReason, startSocial, unavailableError } from './src/social.js'
import { createServerController } from './src/server-config.js'

export const name = 'flybot-social'
export const inject = ['flybot']

export function apply(ctx, config = {}) {

  // Owner switch (#2564): off means this process registers none of the plugin's tools,
  // slots or endpoints. Read from FlyBot's state.json at start, so it applies next launch.
  if (ctx.flybot?.pluginEnabled?.('social') === false) return
  const dshHome = dshHomeOf()
  const base = { inboxPollMs: 15_000, facePollMs: 4_000, credentialsPath: join(dshHome, 'bot', 'flybot-social.json'), ...config }
  const flybot = typeof ctx.flybot.scope === 'function' ? ctx.flybot.scope(NS) : ctx.flybot
  const warn = (...args) => console.warn('flybot-social:', ...args)
  // The server comes from Settings when the owner picked one there, else from `config.server`
  // (#337); the controller starts the social layer and restarts it when the server changes.
  let controller
  try {
    controller = createServerController({
      base,
      flybot,
      start: settled => startSocial(ctx.flybot, settled),
      registerUnavailable,
      warn,
      onFailure(error) {
        const reason = startFailureReason(error)
        console.warn('flybot-social: start failed:', reason)
        try { ctx.logger?.warn?.('flybot-social: start failed: %s', reason) } catch { /* the logger failed while reporting the failure */ }
        // Host diagnostics (Settings → Feedback). Optional on older cores without flybot.warn.
        try { ctx.flybot?.warn?.('flybot-social: start failed: %s', error) } catch { /* the optional channel itself failed */ }
      },
    })
  } catch (failure) {
    // Building the controller reads the server choice in Settings, and a file that exists but
    // cannot be read or parsed refuses instead of counting as "nothing saved" (#2717). That throw
    // used to leave `apply` before any endpoint existed: the page could only say "the plugin did
    // not start" and Feedback got no line (#2945). The refusal stands — falling back to "never
    // configured" would hide the file a person has to move aside — and now reaches both channels
    // the plugin already has.
    if (failure?.code !== 'bot/refused') throw failure
    const message = startFailureReason(failure)
    const offs = [
      // The page's first request is `social/server`, which is not in SOCIAL_UI_ENDPOINTS: without
      // this line only Feedback would improve and the page would keep its old sentence.
      flybot.api.handle('social/server', async () => { throw unavailableError(message) }, { read: true }),
      // A check makes the host fetch an address the caller names, so it stays a write; so does a
      // switch. All three are the endpoints the ready path registers before a start, so no call
      // falls back to "Unknown FlyBot endpoint" and the misleading "did not start" sentence.
      flybot.api.handle('social/server-check', async () => { throw unavailableError(message) }),
      flybot.api.handle('social/server-set', async () => { throw unavailableError(message) }),
      registerUnavailable(flybot, message),
    ]
    ctx.effect(() => () => {
      for (const off of offs.splice(0).reverse()) off?.()
    }, 'flybot-social')
    // The same three channels onFailure uses, so the sentence reaches the process log, the host's
    // logger and Settings → Feedback alike; the last two are optional on older cores.
    console.warn('flybot-social: refused at start:', message)
    try { ctx.logger?.warn?.('flybot-social: %s', message) } catch { /* the logger failed while reporting the refusal */ }
    try { ctx.flybot?.warn?.('flybot-social: %s', message) } catch { /* the optional channel itself failed */ }
    return
  }
  const offs = [
    flybot.api.handle('social/server', async () => controller.status(), { read: true }),
    // A check makes the host fetch an address the caller names, so it is a write for the access rules (no read-only host, no team of several).
    flybot.api.handle('social/server-check', async payload => controller.check(payload ?? {})),
    flybot.api.handle('social/server-set', async payload => controller.set(payload ?? {})),
  ]
  const ready = controller.ready()
  ctx.effect(() => () => {
    for (const off of offs.splice(0).reverse()) off()
    controller.dispose()
  }, 'flybot-social')
  return ready
}
