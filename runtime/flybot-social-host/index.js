// FlyBot adapter: attach a FlyBot-shaped `flybot` service to an unmodified
// upstream DS-Bot runtime, then (optionally) start @flybot/social against it.
import { attachFlybot, createFlybotFacade, groupLedgerBook } from './src/facade.js'
import { apply as applySocial } from '../flybot/plugins/social/index.js'

export { attachFlybot, createFlybotFacade, groupLedgerBook }

/**
 * Attach the façade to an already-started upstream runtime (the usual path
 * after `createRuntime(ctx, config)`). Does not call `createRuntime` itself,
 * so it will not boot a second copy of ds-bot.
 */
export function applyOnRuntime(rt, ctx, socialConfig = {}) {
  const flybot = attachFlybot(rt, ctx)
  const result = applySocial(ctx, socialConfig)
  return { flybot, social: result }
}
