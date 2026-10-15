// FlyBot product chrome: the mark from docs/images/logo.svg, the tab title, and the favicon.
// Paths stay here so tests can import them without React.

export const FLYBOT_WING = 'M150 238 C 96 200, 40 196, 22 214 C 8 230, 40 262, 150 300 Z'
export const FLYBOT_WING_LOW = 'M150 318 C 104 300, 62 306, 54 322 C 48 338, 84 352, 150 352 Z'
export const FLYBOT_BODY = 'M196 132 H316 A80 80 0 0 1 396 212 V300 A80 80 0 0 1 316 380 H250 L188 432 V374 A80 80 0 0 1 116 300 V212 A80 80 0 0 1 196 132 Z'

export function flybotMarkSvg({ wing = '#8FB2FF', brand = '#3B5BFD', face = '#FFFFFF' } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="32" height="32">`
    + `<g fill="${wing}"><path d="${FLYBOT_WING}"/><path d="${FLYBOT_WING_LOW}"/></g>`
    + `<g fill="${wing}" transform="translate(512 0) scale(-1 1)"><path d="${FLYBOT_WING}"/><path d="${FLYBOT_WING_LOW}"/></g>`
    + `<path d="${FLYBOT_BODY}" fill="${brand}"/>`
    + `<rect x="196" y="222" width="34" height="58" rx="17" fill="${face}"/>`
    + `<rect x="282" y="222" width="34" height="58" rx="17" fill="${face}"/>`
    + `<circle cx="256" cy="100" r="22" fill="${brand}"/>`
    + `<rect x="248" y="104" width="16" height="34" fill="${brand}"/></svg>`
}

export function brandTitle(title) {
  const text = String(title ?? '')
  if (text === 'DeepSeek Harness' || text === 'DS Bot') return 'FlyBot'
  if (text.endsWith(' — DeepSeek Harness')) return `${text.slice(0, -' — DeepSeek Harness'.length)} — FlyBot`
  if (/\bDS Bot\b/.test(text)) return text.replace(/\bDS Bot\b/g, 'FlyBot')
  return text
}

export function installBrandChrome() {
  if (typeof document === 'undefined') return () => {}
  const href = `data:image/svg+xml,${encodeURIComponent(flybotMarkSvg())}`
  let link = document.getElementById('flybot-favicon')
  if (!link) {
    link = document.createElement('link')
    link.id = 'flybot-favicon'
    link.rel = 'icon'
    link.type = 'image/svg+xml'
    document.head.appendChild(link)
  }
  link.href = href
  const retitle = () => {
    const next = brandTitle(document.title)
    if (next !== document.title) document.title = next
  }
  retitle()
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(retitle) : null
  const node = document.querySelector('title') ?? document.head
  observer?.observe(node, { childList: true, characterData: true, subtree: true })
  return () => {
    observer?.disconnect()
    link.remove()
  }
}
