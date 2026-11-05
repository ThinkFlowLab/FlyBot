// Shared setup contract; the browser and server validate the same application and permission names.
export const APP_ID = /^cli_[0-9a-f]{16}$/i
export const BASE_SCOPES = ['im:message.group_at_msg:readonly', 'im:message.p2p_msg:readonly', 'im:message:send_as_bot', 'im:message.reactions:write_only', 'im:resource', 'im:message:readonly', 'im:chat:readonly', 'contact:contact.base:readonly', 'contact:user.base:readonly', 'im:message.group_msg.include_bot:read']
export const PRODUCTS = [
  { id: 'calendar', label: 'Calendar', scopes: ['calendar:calendar'] },
  { id: 'docs', label: 'Documents and wiki', scopes: ['docx:document', 'drive:drive', 'wiki:wiki'] },
  { id: 'bitable', label: 'Bitable', scopes: ['bitable:app'] },
  { id: 'sheets', label: 'Spreadsheets', scopes: ['sheets:spreadsheet'] },
  { id: 'meeting', label: 'Video meetings', scopes: ['vc:reserve'] },
  { id: 'task', label: 'Tasks', scopes: ['task:task:write'] },
]
export const STEPS = ['Create an app on Feishu Open Platform', 'Enter credentials and test connection', 'Subscribe to message events and card callbacks', 'Publish an app version', 'Choose the Bot represented by the robot', 'Try it in Feishu']
export const setupSteps = mode => mode === 'http' ? ['Prepare a public event address', ...STEPS] : [...STEPS]
export const permissionJSON = (selected = []) => JSON.stringify({ scopes: { tenant: [...new Set([...BASE_SCOPES, ...PRODUCTS.filter(p => selected.includes(p.id)).flatMap(p => p.scopes)])], user: [] } }, null, 2)
export function scopeGranted(scope, list = []) {
  if (scope === 'im:message:readonly') return ['im:message:readonly', 'im:message', 'im:message.history:readonly'].some(s => list.includes(s))
  if (scope === 'im:message.reactions:write_only') return list.includes(scope) || list.includes('im:message')
  return list.includes(scope)
}
export function productAccess(product, list = []) {
  if (product.scopes.every(s => list.includes(s))) return 'write'
  if (['meeting', 'task'].includes(product.id)) return 'disabled'
  return product.scopes.every(s => list.includes(s) || list.includes(`${s}:readonly`)) ? 'read' : 'disabled'
}
export function validateCredentials({ appId, appSecret, verificationToken }, mode) {
  if (!APP_ID.test(appId ?? '')) throw new Error('App ID must be cli_ followed by 16 hexadecimal characters')
  if (typeof appSecret !== 'string' || !appSecret.trim()) throw new Error('Enter the App Secret')
  if (!['socket', 'http'].includes(mode)) throw new Error('Choose a receiving method')
  if (mode === 'http' && !verificationToken?.trim()) throw new Error('Enter the Verification Token')
}
export function publicAddress(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search &&
      !/^(localhost$|127\.|10\.|0\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[|169\.254\.)/.test(u.hostname) && !u.hostname.endsWith('.local')
  } catch { return false }
}
