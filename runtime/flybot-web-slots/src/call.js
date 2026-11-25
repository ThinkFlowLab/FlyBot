// Browser call() for the social client. Same JSON shape as upstream ds-bot's
// src/client/api.js, but posted to /api/flybot so social/* handlers do not
// collide with the unmodified createRuntime /api/bot switch.
export const ROUTE = 'api/flybot'

export async function callFlybot(endpoint, payload, signal, fetchImpl = globalThis.fetch) {
  let response
  try {
    response = await fetchImpl(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload: payload ?? null }),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    throw Object.assign(new Error('Could not reach the FlyBot API.'), { code: 'NETWORK', cause: error })
  }
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), { code: `HTTP_${response.status}` })
  }
  const result = await response.json()
  if (!result.ok) {
    const code = result.error?.code ?? 'bot/error'
    const message = result.error?.message ?? 'Request failed'
    throw Object.assign(new Error(message), { code })
  }
  return result.value
}
