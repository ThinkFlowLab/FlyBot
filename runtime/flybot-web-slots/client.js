// dsh web client entry. Installs globalThis.__flybot__ as soon as this module
// is evaluated, then (when DSH provides ctx.slots) bridges FlyBot slots into
// the official dsh-web-app regions. Composer @ rows use the official
// inputTriggers.registerSource seam (same as unmodified ds-bot v0.3.6).
// Do not edit the vendored ds-bot client.
import { attachBridge } from './src/bridge.js'
import { installFlybotHost } from './src/host.js'
import { watchMentionTriggers } from './src/mentions.js'
import { attachBotDetails } from './src/details.js'

installFlybotHost()

const attach = (ctx, host) => {
  const offs = []
  if (ctx?.slots) {
    const off = attachBridge(ctx.slots, host.slots)
    if (typeof off === 'function') offs.push(off)
    const details = attachBotDetails(ctx.slots, host.slots)
    if (typeof details === 'function') offs.push(details)
  }
  const mentions = watchMentionTriggers(ctx, host.slots)
  if (typeof mentions === 'function') offs.push(mentions)
  return () => { for (const off of offs) off() }
}

export const inject = ['slots']

export function apply(ctx) {
  return attach(ctx, installFlybotHost())
}

if (typeof globalThis !== 'undefined' && globalThis.__ModuleLoader__?.load) {
  globalThis.__ModuleLoader__.load({
    id: '@flybot-workspace/flybot-web-slots',
    inject: ['slots'],
    factory(_require, ctx) {
      const host = installFlybotHost()
      attach(ctx, host)
      return host
    },
  })
}
