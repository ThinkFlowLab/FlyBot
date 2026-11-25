// Client-only companion bundle. The runtime wrapper already attaches @flybot/social
// on the server; this package exists so dsh web will also load that plugin's
// classic client script. Do not call applySocial here.
export const name = 'flybot-social'
export const inject = []
export function apply() {}
