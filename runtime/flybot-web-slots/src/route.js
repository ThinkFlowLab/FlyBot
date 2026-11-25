// Lease-less loopback is not used here: this is the authenticated dsh web
// fetch route (session cookie), parallel to ds-bot's POST /api/bot.
export const PATH = '/api/flybot'

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

export async function dispatch(flybot, endpoint, payload) {
  const name = String(endpoint ?? '')
  if (!name.startsWith('social/') && !name.startsWith('social.')) {
    return { ok: false, error: { code: 'bot/not-found', message: `Unknown FlyBot endpoint ${name}`, details: {} } }
  }
  try {
    const value = await flybot.api.call(name, payload ?? null)
    return { ok: true, value }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error?.code ?? 'bot/error',
        message: error?.message ?? 'Request failed',
        details: {},
      },
    }
  }
}

export function registerFlybotRoute(ctx, flybot) {
  if (!ctx?.connection?.fetch?.register || !ctx?.effect) {
    throw new Error('dsh connection fetch registry is required')
  }
  return ctx.effect(() => ctx.connection.fetch.register({
    path: PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try { body = await request.json() } catch { body = {} }
      return json(await dispatch(flybot, body?.endpoint, body?.payload))
    },
  }), 'flybot-workspace: flybot api route')
}
