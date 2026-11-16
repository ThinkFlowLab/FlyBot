// MOCK HOST ONLY. No transport is installed and unsupported calls reject visibly.
export async function call(method, body) {
  if (typeof globalThis.__fixtureCall === 'function') return globalThis.__fixtureCall(method, body)
  throw new Error(`Offline fixture: unsupported host call ${method}`)
}
