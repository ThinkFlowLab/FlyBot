// GET /api/flybot-workspace/page?path=<page path>: the FlyBot pages, served by
// this user's own DS-Bot from the copy bundled into the image at
// <plugin>/pages (flybot_workspace/static at build time). The platform gateway maps
// a browser path such as /chat/ or /shell/app.css onto this route for the
// signed-in owner's runtime only.
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PAGE_PATH = '/api/flybot-workspace/page'
export const SERVED_BY_HEADER = 'x-flybot-workspace-served-by'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_PATH = 256
const REVALIDATE_ASSETS = new Set(['.css', '.mjs', '.js'])
// Native pages and their shared dependencies use the existing authenticated
// asset route. The manifest only indexes static files in these directories.
const PAGE_PACKAGE_ROOTS = [
  'agents', 'artifacts', 'automations', 'chat', 'contacts', 'discover', 'home', 'look',
  'meetings', 'members', 'memory', 'onboarding', 'profile', 'settings', 'shell', 'skills', 'team', 'team-runs',
]
const PAGE_MANIFEST = '.chat-assets-v1.json'
const PAGE_PACKAGE_PATH = /^\/chat\/assets\/([a-f0-9]{32})(\/[^?#]+)$/
const PAGE_ENTRY_RESOURCE = /((?:src|href)=")(\/[a-z][a-z-]*\/[A-Za-z0-9._-]+\.(?:css|mjs|js))"/g
const CHAT_STARTUP_ENTRY = '<script type="module" src="/chat/startup.mjs" async fetchpriority="high"></script>'

function matchesValidator(request, etag) {
  return (request.headers.get('if-none-match')?.split(',') ?? []).some(value => {
    const tag = value.trim()
    return tag === '*' || tag === etag || tag === 'W/' + etag
  })
}

const digestOf = data => createHash('sha256').update(data).digest('hex')

async function loadChatStartup(root) {
  const file = join(root, 'chat', 'startup.mjs')
  if (await realpath(file) !== file) return null
  const source = (await readFile(file, 'utf8')).replace(/\r\n?/g, '\n')
  if (/<\/script[\s/>]/i.test(source)) return null
  const hash = createHash('sha256').update(source).digest('base64')
  return {source, policy: `script-src 'self' 'sha256-${hash}'`}
}

async function scanPageAssets(root) {
  const hashes = []
  for (const directory of PAGE_PACKAGE_ROOTS) {
    const folder = await realpath(join(root, directory)).catch(() => null)
    if (!folder?.startsWith(root + sep)) continue
    const entries = await readdir(folder, {withFileTypes: true})
    const files = entries.filter(entry => entry.isFile() && SEGMENT.test(entry.name) && !entry.name.includes('..'))
      .map(entry => entry.name).sort()
    const snapshot = await Promise.all(files.map(async name => {
      const extension = extname(name).toLowerCase()
      if (!Object.hasOwn(TYPES, extension) || extension === '.html') return null
      const file = await realpath(join(folder, name))
      if (!file.startsWith(folder + sep)) return null
      return ['/' + directory + '/' + name, digestOf(await readFile(file))]
    }))
    hashes.push(...snapshot.filter(Boolean))
  }
  return hashes
}

export async function writeChatAssetManifest(pagesDir) {
  const root = await realpath(pagesDir)
  const hashes = await scanPageAssets(root)
  await writeFile(join(root, PAGE_MANIFEST), JSON.stringify(hashes) + '\n')
}

async function readPageManifest(root) {
  const file = join(root, PAGE_MANIFEST)
  if (await realpath(file) !== file) return null
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(manifest)) return null
  let previous = ''
  for (const entry of manifest) {
    if (!Array.isArray(entry) || entry.length !== 2) return null
    const [path, digest] = entry
    const parts = resolvePagePath(path)
    if (!parts) return null
    const extension = extname(path).toLowerCase()
    if (parts.length !== 2 || !PAGE_PACKAGE_ROOTS.includes(parts[0])
      || path !== '/' + parts.join('/') || path <= previous
      || !Object.hasOwn(TYPES, extension) || extension === '.html'
      || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return null
    previous = path
  }
  return manifest
}

async function loadPagePackage(root) {
  // The immutable image builds this catalogue once. Source checkouts and
  // older images can still calculate it from their own bundled pages.
  const hashes = await readPageManifest(root).catch(() => null) ?? await scanPageAssets(root)
  const assets = new Map()
  const release = createHash('sha256')
  for (const [path, digest] of hashes) {
    release.update(path + '\0' + digest + '\n')
    assets.set(path, {digest, type: TYPES[extname(path).toLowerCase()], etag: `"sha256-${digest}"`})
  }
  return {assets, base: '/chat/assets/' + release.digest('hex').slice(0, 32)}
}

// Resolve a browser page path to a file inside pagesDir, or null. Only plain
// segments are accepted: no dot segments, no encoded separators, no hidden files.
export function resolvePagePath(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH || !raw.startsWith('/')) return null
  if (raw === '/') return ['home', 'index.html']
  const trailing = raw.endsWith('/')
  const parts = raw.slice(1, trailing ? -1 : undefined).split('/')
  if (parts.some((part) => !SEGMENT.test(part) || part.includes('..'))) return null
  if (trailing) return [...parts, 'index.html']
  const ext = extname(parts.at(-1)).toLowerCase()
  if (Object.hasOwn(TYPES, ext)) return parts
  // Extensionless paths (/settings, /settings/connectors, /profile/edit) are
  // the section's index.html, matching SettingsPage on the platform. Unknown
  // extensions still 404. The file must exist; a missing index is 404 later.
  if (ext === '') return [parts[0], 'index.html']
  return null
}

const notFound = (identity) => new Response('not found', {
  status: 404,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    [SERVED_BY_HEADER]: `ds-bot; instance=${identity.instanceId}` },
})

export function markHtml(text, identity) {
  const meta = `<meta name="flybot-workspace-served-by" content="ds-bot">`
    + `<meta name="flybot-workspace-instance" content="${identity.instanceId}">`
  return /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, (head) => head + meta) : meta + text
}

function markShellAppearance(html, values) {
  const appearance = ['light', 'dark', 'auto', 'system'].includes(values?.appearance) ? values.appearance : null
  if (!appearance) return html
  let attrs = ` data-shell-appearance="${appearance}"`
  if (appearance === 'light' || appearance === 'dark') attrs += ` data-theme-resolved="${appearance}"`
  if (values.language === 'zh-CN' || values.language === 'en') attrs += ` data-shell-language="${values.language}"`
  if (appearance === 'auto' && values.appearance_schedule === 'custom') {
    const time = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/
    const start = values.appearance_start
    const end = values.appearance_end
    if (time.test(start ?? '') && time.test(end ?? '')) attrs += ` data-shell-start="${start}" data-shell-end="${end}"`
  }
  return html.replace(/<html(?=[\s>])/i, match => match + attrs)
}

export function createPageHandler({ pagesDir, identity, getSystemLanguage, getShellSettings }) {
  let root, localeModule, chatMessages, pagePackage, chatStartup
  const packageFor = pageRoot => pagePackage ??= loadPagePackage(pageRoot).catch(() => {
    pagePackage = undefined
    return null
  })
  return async (request) => {
    const url = new URL(request.url)
    const path = url.searchParams.get('path')
    const parts = resolvePagePath(path)
    if (!parts) return notFound(identity)
    if (path === '/messenger' || path === '/messenger/' || path === '/messenger/index.html') {
      return new Response(null, { status: 302, headers: {
        location: '/chat', 'cache-control': 'no-store', [SERVED_BY_HEADER]: `ds-bot; instance=${identity.instanceId}`,
      } })
    }
    try {
      const pageRoot = root ??= await realpath(pagesDir)
      const packagedPath = PAGE_PACKAGE_PATH.exec(path)
      if (packagedPath) {
        const current = await packageFor(pageRoot)
        const asset = current?.assets.get(packagedPath[2])
        if (!asset) return notFound(identity)
        const resource = current.base + packagedPath[2]
        if (path !== resource) return new Response(null, {status: 302, headers: {location: resource, 'cache-control': 'no-store'}})
        const file = await realpath(join(pageRoot, packagedPath[2]))
        if (!file.startsWith(pageRoot + sep)) return notFound(identity)
        const data = await readFile(file)
        if (digestOf(data) !== asset.digest) return notFound(identity)
        const headers = {'content-type': asset.type, 'cache-control': 'private, max-age=31536000, immutable',
          etag: asset.etag, 'x-content-type-options': 'nosniff'}
        return matchesValidator(request, asset.etag) ? new Response(null, {status: 304, headers}) : new Response(data, {headers})
      }
      const file = await realpath(join(pageRoot, ...parts))
      if (!file.startsWith(pageRoot + sep)) return notFound(identity)
      if (!(await stat(file)).isFile()) return notFound(identity)
      const extension = extname(file).toLowerCase()
      const type = TYPES[extension] ?? 'application/octet-stream'
      const headers = {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
        [SERVED_BY_HEADER]: `ds-bot; instance=${identity.instanceId}`,
      }
      if (type.startsWith('text/html')) {
        headers['x-frame-options'] = 'DENY'
        const audioPage = parts.length === 2 && ['chat', 'meetings'].includes(parts[0]) && parts[1] === 'index.html'
        const microphone = audioPage ? '(self)' : '()'
        const camera = audioPage && parts[0] === 'chat' ? '(self)' : '()'
        headers['permissions-policy'] = `camera=${camera}, microphone=${microphone}, geolocation=()`
        let html = await readFile(file, 'utf8')
        const indexPage = parts.length === 2 && parts[1] === 'index.html'
        const shell = getShellSettings && indexPage
          ? await Promise.resolve().then(getShellSettings).catch(() => null) : null
        const earlyChat = parts[0] === 'chat' && indexPage && html.includes(CHAT_STARTUP_ENTRY)
          ? (chatStartup ??= loadChatStartup(pageRoot).catch(() => null)) : null
        const [current, startup] = await Promise.all([
          indexPage && PAGE_PACKAGE_ROOTS.includes(parts[0]) ? packageFor(pageRoot) : null, earlyChat,
        ])
        if (current) html = html.replace(PAGE_ENTRY_RESOURCE, (literal, prefix, asset) =>
          (startup && asset === '/chat/startup.mjs') || !current.assets.has(asset)
            ? literal : prefix + current.base + asset + '"')
        if (startup) {
          // Start the initial signed reads before the shell's module graph loads.
          html = html.replace(CHAT_STARTUP_ENTRY, () => `<script type="module" async>${startup.source}</script>`)
          headers['content-security-policy'] = startup.policy
        }
        if ((shell || getSystemLanguage) && indexPage && ['chat', 'settings'].includes(parts[0])) {
          localeModule ??= import(pathToFileURL(join(pageRoot, 'shell', 'system-locale.mjs')).href).catch(() => null)
          const renderer = await localeModule
          if (renderer) {
            const requested = shell?.language ?? await Promise.resolve().then(getSystemLanguage).catch(() => null)
            let locale = renderer.systemLocale(requested)
            let pageMessages
            if (locale === 'en' && parts[0] === 'chat') {
              chatMessages ??= import(pathToFileURL(join(pageRoot, 'shell', 'system-locale-chat.mjs')).href)
                .then(module => module.CHAT_MESSAGES).catch(() => undefined)
              pageMessages = await chatMessages
              if (!pageMessages) locale = 'zh-CN'
            }
            html = renderer.renderSystemLocale(html, locale, pageMessages)
            headers['content-language'] = locale
          }
        }
        if (shell) html = markShellAppearance(html, shell)
        return new Response(markHtml(html, identity), { status: 200, headers })
      }
      const data = await readFile(file)
      if (REVALIDATE_ASSETS.has(extension)) {
        const etag = `"sha256-${digestOf(data)}"`
        headers.etag = etag
        // Package assets contain no account data. The browser still checks
        // this authenticated runtime for access and release bytes on reuse.
        headers['cache-control'] = 'private, no-cache'
        if (matchesValidator(request, etag)) return new Response(null, { status: 304, headers })
      }
      return new Response(data, { status: 200, headers })
    } catch {
      root = undefined
      return notFound(identity)
    }
  }
}
