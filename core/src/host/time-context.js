import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const SOURCE = 'ds-bot-time-context'
// The host injects `SOURCE`; DSH injects 'time-context'. One home for both (#626).
export const CLOCK_KINDS = [SOURCE, 'time-context']
const isClock = source => CLOCK_KINDS.includes(source?.kind)

export function install(rt) {
  const { ctx, config } = rt
  const interval = config.timeRefreshIntervalMs ?? 600_000
  if (!Number.isSafeInteger(interval) || interval < 0) throw new TypeError('timeRefreshIntervalMs must be a non-negative safe integer')
  const formatter = new Intl.DateTimeFormat('en-CA', {
    ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
  const zone = formatter.resolvedOptions().timeZone

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    await rt.load()
    if (!rt.isBotSession(agent.id) || signal.aborted) return decision
    // A friend's Bot's chat runs on no model: a clock there only gets in the way of the relay.
    if (typeof rt.botOf?.(rt.selfOf?.(agent.id))?.remote?.handle === 'string') return decision
    // A loaded DSH clock covers every step itself. Its listener may run before or
    // after this one (a reload reorders them), so its presence is read from its
    // projection, not from the messages added so far.
    if (ctx.get?.('sessionProjections')?.stateOf(agent.session, 'timeContext') !== undefined) return decision
    if (decision.messages.some(message => isClock(message.source))) return decision
    const now = Date.now()
    for await (const event of rt.eventsBackwards(agent.id, signal, Infinity)) {
      if (event.type === 'user/message' && isClock(event.data.source)) {
        if (now >= event.time && now - event.time < interval) return decision
        break
      }
      if (event.time <= now - interval) break
    }
    if (signal.aborted) return decision
    const text = `Current time: ${formatter.format(now)} (${zone}).`
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: SOURCE, form: 'snapshot', sections: [{ name: SOURCE, text }] },
      })],
    }
  }, { prepend: true })
}
