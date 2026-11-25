// Shared helpers for feature modules: a legacy-shaped HTTP fault and payload
// guards. A fault becomes the same {error: {code, message, current?}} body and
// status the legacy Flask /v1 route answered, so pages keep working unchanged
// when the platform routes a moved /v1 path to this DS-Bot.
export class Fault extends Error {
  constructor(status, code, message, current) {
    super(message)
    this.status = status
    this.code = code
    if (current !== undefined) this.current = current
  }
}

export const fail = (status, code, message, current) => { throw new Fault(status, code, message, current) }

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Same contract as app.body(env, allowed): a JSON object whose keys are all allowed.
export function bodyOf(body, allowed) {
  if (body === undefined || body === null) body = {}
  if (!isObject(body)) fail(400, 'invalid', 'JSON object body required')
  for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(400, 'invalid', `Unknown field ${String(key).slice(0, 40)}`)
  return body
}

export const nowSeconds = () => Math.floor(Date.now() / 1000)
