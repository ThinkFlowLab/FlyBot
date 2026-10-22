// @flybot/tree host plugin (dsh / cordis plugin shape, same as ds-bot: name + inject + apply).
// Everything FlyBot-specific goes through ctx.flybot (from @flybot/core) via src/adapter.js.
import { createAdapter } from './src/adapter.js'
import { resolveLimits } from './src/limits.js'
import { createTree } from './src/tree.js'
import { treeSendMiddleware } from './src/middleware.js'
import { registerTreeTools } from './src/tools.js'
import { createModelClassifier } from './src/classify-model.js'

export const name = 'flybot-tree'
export const inject = ['flybot']

export function apply(ctx, config = {}) {
  const fb = createAdapter(ctx.flybot)
  // Cordis gives ctx.logger as a factory; a host may give a ready logger object instead.
  const logger = typeof ctx.logger === 'function' ? ctx.logger('flybot-tree') : ctx.logger
  const warn = (...args) => (logger?.warn ?? console.warn)(...args)
  const tree = createTree(fb, { limits: resolveLimits(config), rootName: config.rootName, rootBotId: config.rootBotId, adoptExisting: config.adoptExisting !== false, warn, classify: config.classify, tidy: config.tidy, now: typeof config.now === 'function' ? config.now : undefined })
  // A child's turn boundary changes its load; rewrite its parent's prompt so the Child-load line a
  // coordinator reads is current (#507). writeBlock skips an unchanged block, so nothing churns.
  const refreshParentPrompt = (id) => {
    const parent = tree.parentOf(id)
    if (typeof parent === 'string' && tree.isMember(parent)) tree.refreshPrompt(parent)
  }
  const disposers = [
    fb.useSend('tree', treeSendMiddleware(tree, { bypassSocial: config.bypassSocial === true, isRemote: fb.isRemote, hasAnyGrant: fb.hasAnyGrant })),
    ...registerTreeTools(fb, tree),
    fb.onFieldChange(change => tree.onFieldChange(change)),
    fb.onBotRemoved(e => tree.onBotRemoved(e)),
    // Recent activity (when, which tools) feeds idle detection and role grouping (#446).
    fb.onFeed('turn.start', e => tree.noteActivity(e?.botId)),
    fb.onFeed('tool.start', e => tree.noteActivity(e?.botId, e?.name)),
    // Runtime load: how many turns each Bot runs now, so a coordinator routes to a free child (#507).
    // A change is also written into the child's parent prompt, so the Child-load line a coordinator
    // reads stays current (writeBlock only rewrites the block when the line really changed).
    // The feed names the turn it is about (turnId); dropping it made an end close whichever turn was
    // oldest, so with two open and the later one ending first, openFor reported the newer age (#696).
    fb.onFeed('turn.start', e => { tree.noteTurnStart(e?.botId, e?.turnId); refreshParentPrompt(e?.botId) }),
    fb.onFeed('turn.end', e => { tree.noteTurnEnd(e?.botId, e?.turnId); refreshParentPrompt(e?.botId) }),
    // The tree view: what the last reorganization did, one-click undo, dismiss.
    fb.handleApi('tree/reorg', () => tree.overview(), { read: true }),
    fb.handleApi('tree/undo', payload => tree.undo(typeof payload?.runId === 'string' ? payload.runId : undefined)),
    fb.handleApi('tree/dismiss', payload => tree.dismiss(String(payload?.runId ?? ''))),
  ]
  // Daily tidy (#446): checked every hour, runs when the last one is a day old. config.dailyTidy: false turns it off.
  if (config.dailyTidy !== false) {
    const check = () => { try { tree.maybeTidy()?.catch?.(error => warn('flybot-tree: daily tidy failed:', error?.message ?? error)) } catch (error) { warn('flybot-tree: daily tidy failed:', error?.message ?? error) } }
    const timer = setInterval(check, 60 * 60 * 1000)
    timer.unref?.()
    disposers.push(() => clearInterval(timer))
  }
  // The root is ds-bot's Main Bot (Chief). Adopt it once the team is loaded: right away, a few
  // retries later, and whenever a Bot is created (Chief may be created after startup).
  // Each attempt also places unattached local bots in the tree by role (config.adoptExisting) and
  // repairs over-full parents (#446). On bot.created it runs at once, inside the create call, so a
  // Bot made by core create_bot is placed when that tool answers, unless a new group lead has to be
  // created for it first (then right after, once the lead exists).
  // config.autoRoot: false turns this off; config.rootBotId picks the root explicitly.
  if (config.autoRoot !== false) {
    const failed = error => warn('flybot-tree: could not set up the root:', error?.message ?? error)
    const attempt = () => { try { tree.ensureRoot().catch(failed) } catch (error) { failed(error) } }
    const timers = [0, 1000, 5000, 15000].map(ms => setTimeout(attempt, ms))
    timers.forEach(t => t.unref?.())
    disposers.push(() => timers.forEach(clearTimeout))
    disposers.push(fb.onBotCreated(() => { attempt(); setTimeout(attempt, 0).unref?.() }))
  }
  // Model-based clustering (#450 item 2), opt-in: config.modelClassify: true AND the host
  // allow-lists this plugin in flybot.modelPlugins. It asks the sanctioned model call for a
  // category for each tree Bot whose role text changed, stores it on the Bot, and the tree's
  // rules read it at the next reorganization. Without the host seam it asks nothing.
  if (config.modelClassify === true) {
    const classifier = createModelClassifier({ fb })
    const run = async () => {
      try {
        for (const id of Object.keys(tree.snapshot())) {
          if (tree.isRoot(id)) continue
          await classifier.classifyBot(id)
        }
      } catch (error) { warn('flybot-tree: model classification failed:', error?.message ?? error) }
    }
    const timers = [3000, 20000].map(ms => setTimeout(() => { void run() }, ms))
    timers.forEach(t => t.unref?.())
    const interval = setInterval(() => { void run() }, 30 * 60 * 1000)
    interval.unref?.()
    disposers.push(() => { timers.forEach(clearTimeout); clearInterval(interval) })
    disposers.push(fb.onBotCreated(() => { setTimeout(() => { void run() }, 0).unref?.() }))
  }
  const dispose = () => { for (const d of disposers.splice(0)) d?.() }
  // Cordis-style cleanup: load with ctx.plugin(tree, config); ctx.effect runs the returned
  // disposer when the plugin's scope is disposed. (The ctx.on('dispose') branch is an internal
  // fallback for hosts without ctx.effect, not part of the public contract.)
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'flybot-tree')
  else ctx.on?.('dispose', dispose)
  return { tree, dispose }
}
