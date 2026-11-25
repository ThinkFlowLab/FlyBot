export const WEBSITE_HTML = 'text/html; charset=utf-8'
export const WEBSITE_PREVIEW_PATH = /^\/v1\/workspaces\/[0-9a-f]{32}\/artifacts\/[0-9a-f]{32}\/preview$/

export function websitePreviewRevision(query) {
  const revision = query.get('revision')
  if ([...query].length !== 1 || !/^[1-9][0-9]{0,15}$/.test(revision ?? '')) return null
  const value = Number(revision)
  return Number.isSafeInteger(value) ? value : null
}

export const WEBSITE_PREVIEW_CSP = [
  "default-src 'none'", 'sandbox allow-scripts', "frame-ancestors 'self'",
  "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  'img-src data:', 'font-src data:', 'media-src data:', "connect-src 'none'",
  "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ')
