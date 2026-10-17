// flybot-social: a FlyBot plugin (Cordis plugin for DeepSeek Harness) that lets every
// local Bot chat with friends' Bots on a Bot Social server. Needs ds-bot with the
// FlyBot API (ctx.flybot). See README.md for the home / member model.
//
// Config:
//   server           Bot Social base URL
//   credentialsPath  where the one-call onboarding keeps { token, home } (default
//                    $DSH_HOME/bot/flybot-social.json, mode 600; never committed)
//   displayName      name for the home on first onboarding
//   webhookUrl       optional push webhook registered at onboarding
//   approval         { default: 'hold' | 'auto', homes: { '@bob.home': 'auto' } }
//   inboxPollMs      poll members' inboxes this often while idle; 0 = off (default 15000)
//   facePollMs       faster poll while a live face-to-face room is open (default 4000)
//   token / botId    legacy per-bot identity (no home): owner connector token + bot id
import { join } from 'node:path'
import { registerUnavailable, startFailureReason, startSocial } from './src/social.js'

export const name = 'flybot-social'
export const inject = ['flybot']

export function apply(ctx, config = {}) {
  let social
  let stopped = false
  let unavailableOff
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  const ready = startSocial(ctx.flybot, { inboxPollMs: 15_000, facePollMs: 4_000, credentialsPath: join(dshHome, 'bot', 'flybot-social.json'), ...config })
    .then((value) => {
      social = value
      if (stopped) social.dispose()
      return value
    })
    .catch((error) => {
      const reason = startFailureReason(error)
      console.warn('flybot-social: start failed:', reason)
      try { ctx.logger?.warn?.('flybot-social: start failed: %s', reason) } catch { /* the logger failed while reporting the failure */ }
      // Host diagnostics (Settings → Feedback). Optional on older cores without flybot.warn.
      try { ctx.flybot?.warn?.('flybot-social: start failed: %s', error) } catch { /* the optional channel itself failed */ }
      if (!stopped) unavailableOff = registerUnavailable(ctx.flybot, reason)
    })
  ctx.effect(() => () => {
    stopped = true
    unavailableOff?.()
    social?.dispose()
  }, 'flybot-social')
  return ready
}
