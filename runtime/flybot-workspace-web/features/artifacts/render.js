// Rendering and export of artifacts (legacy artifacts.py render_*,
// sanitize_html, export_*): HTML/SVG generated inside the user's DS-Bot.
import { GLB_MIME, validGlb } from '../../lib/glb.js'
import { BODY_MAX, SAFE_FILENAME, emptyBoard, emptyDashboard, emptySlides, publicKind, unescapeHtml } from './model.js'
import {decodeWorkbook,emptyWorkbook} from './workbook.js'
import { decodeBoard, decodeDashboard, decodeSlides } from './structured.js'

export const escapeText = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

const ALLOWED = new Set(['p', 'br', 'hr', 'div', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'em', 'strong', 'b', 'i', 'u', 's', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'img'])
const VOID = new Set(['br', 'hr', 'img'])
const FORBIDDEN = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math', 'frame', 'frameset', 'applet', 'video', 'audio', 'source', 'track', 'template', 'noscript', 'canvas'])
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+=*$/i
const SAFE_FRAGMENT = /^#[A-Za-z0-9_-]{1,64}$/
const lower = (s) => String(s).toLocaleLowerCase('en-US')

export function safeHref(value) {
  const text = unescapeHtml(value || '').trim()
  if (!text || /[\x00-\x1f\x7f]/.test(text) || text.length > 2000) return null
  if (SAFE_FRAGMENT.test(text)) return text
  const lowered = lower(text).trimStart()
  if (/^(javascript:|vbscript:|data:)/.test(lowered)) return null
  for (const scheme of ['https://', 'http://', 'mailto:']) if (lowered.startsWith(scheme) && text.length > scheme.length) return text
  return null
}

export function safeImgSrc(value) {
  const text = unescapeHtml(value || '').trim().replace(/ /g, '')
  return DATA_IMAGE.test(text) && text.length <= BODY_MAX ? text : null
}

function okAttr(tag, rawName, value) {
  const name = lower(rawName)
  if (name.startsWith('on') || ['style', 'srcset', 'srcdoc', 'xlink:href', 'formaction'].includes(name)) return null
  if (tag === 'a' && (name === 'href' || name === 'title')) {
    if (name === 'title') return typeof value === 'string' && !/[\x00-\x1f]/.test(value) ? value.slice(0, 200) : null
    return safeHref(value)
  }
  if (tag === 'img' && ['src', 'alt', 'width', 'height'].includes(name)) {
    if (name === 'src') return safeImgSrc(value)
    if (name === 'alt') return typeof value === 'string' && !/[\x00-\x1f]/.test(value) ? value.slice(0, 200) : ''
    return /^[0-9]{1,4}$/.test(value) ? value : null
  }
  if ((tag === 'td' || tag === 'th') && (name === 'colspan' || name === 'rowspan') && /^[0-9]{1,2}$/.test(value)) return value
  return null
}

const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[^>]*>?|<\/([A-Za-z][^\s/>]*)[^>]*>|<([A-Za-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g

// Allow-list sanitizer with the legacy HTMLParser semantics: forbidden
// elements drop with their content, unknown tags drop but keep text, only
// listed attributes survive, links/images need a safe href/src.
export function sanitizeHtml(source) {
  const input = String(source ?? '')
  const parts = []
  const stack = []
  let skip = 0
  let last = 0
  const text = (chunk) => { if (!skip && chunk) parts.push(escapeText(unescapeHtml(chunk))) }
  for (const match of input.matchAll(TOKEN)) {
    text(input.slice(last, match.index))
    last = match.index + match[0].length
    if (match[1] !== undefined) {
      const tag = lower(match[1])
      if (FORBIDDEN.has(tag)) { if (!VOID.has(tag) && skip) skip -= 1; continue }
      if (skip || !ALLOWED.has(tag) || VOID.has(tag)) continue
      if (stack.includes(tag)) {
        while (stack.length) { const current = stack.pop(); parts.push('</' + current + '>'); if (current === tag) break }
      }
    } else if (match[2] !== undefined) {
      const tag = lower(match[2])
      if (FORBIDDEN.has(tag)) { if (!VOID.has(tag)) skip += 1; continue }
      if (skip || !ALLOWED.has(tag)) continue
      const pieces = [tag]
      const seen = new Set()
      for (const attr of (match[3] ?? '').matchAll(ATTR)) {
        const name = attr[1]
        if (name === '/') continue
        const value = attr[2] ?? attr[3] ?? attr[4] ?? ''
        const allowed = okAttr(tag, name, value)
        if (allowed !== null) { pieces.push(lower(name) + '="' + escapeAttr(allowed) + '"'); seen.add(lower(name)) }
      }
      if (tag === 'a' && !pieces.slice(1).some((p) => p.startsWith('href='))) continue
      if (tag === 'img' && !pieces.slice(1).some((p) => p.startsWith('src='))) continue
      parts.push('<' + pieces.join(' ') + (VOID.has(tag) ? ' />' : '>'))
      if (!VOID.has(tag)) stack.push(tag)
    }
  }
  text(input.slice(last))
  while (stack.length) parts.push('</' + stack.pop() + '>')
  return parts.join('')
}

const head = (heading, style) => '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>' + heading + '</title><style>' + style + '</style></head>'

export function renderDocumentPage(title, body) {
  const heading = escapeText(title || '文档')
  return head(heading, 'body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;line-height:1.5}pre{white-space:pre-wrap;word-break:break-word}')
    + '<body><article><h1>' + heading + '</h1><pre>' + escapeText(body || '') + '</pre></article></body></html>'
}

export function renderWebsitePage(title, body) {
  const heading = escapeText(title || '网站')
  return head(heading, 'body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;line-height:1.5}') + '<body>' + sanitizeHtml(body || '') + '</body></html>'
}

export function renderSlidesPage(title, deck) {
  const heading = escapeText(title || '幻灯片')
  const slides = deck?.slides ?? []
  const parts = ['<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>',
    '<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;padding:1.5rem}.deck{display:grid;gap:1rem;max-width:52rem;margin:0 auto}.slide{background:#fff;border:1px solid #d8dde6;border-radius:14px;padding:1.2rem 1.4rem;box-shadow:0 1px 2px rgba(0,0,0,.04)}.slide h2{margin:.2rem 0 .6rem;font-size:1.35rem}.slide .n{font-size:.75rem;color:#5b6472;letter-spacing:.08em}.slide ul{margin:0;padding-left:1.2rem;line-height:1.7}.slide li{margin:.15rem 0}.slide.empty .hint{color:#5b6472;font-size:.85rem}</style>',
    '</head><body><main class="deck">']
  if (!slides.length) parts.push('<section class="slide empty"><span class="n">1</span><h2>' + heading + '</h2><p class="hint">还没有幻灯片内容。</p></section>')
  slides.forEach((slide, i) => {
    parts.push('<section class="slide"><span class="n">' + (i + 1) + '</span><h2>' + escapeText(slide.title || '') + '</h2>')
    if (slide.bullets?.length) parts.push('<ul>' + slide.bullets.map((b) => '<li>' + escapeText(b) + '</li>').join('') + '</ul>')
    parts.push('</section>')
  })
  parts.push('</main></body></html>')
  return parts.join('')
}

const pyG = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(6))))

export function renderDashboardPage(title, dashboard) {
  const heading = escapeText(title || '看板')
  const widgets = dashboard?.widgets ?? []
  const parts = ['<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer"><title>' + heading + '</title>',
    '<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;padding:1.5rem}.board{max-width:56rem;margin:0 auto;display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}.widget{background:#fff;border:1px solid #d8dde6;border-radius:14px;padding:1rem 1.2rem;box-shadow:0 1px 2px rgba(0,0,0,.04);grid-column:span 1}.widget.wide{grid-column:1/-1}.widget h2{margin:0 0 .6rem;font-size:.95rem;color:#3a4350}.metric{font-size:1.8rem;font-weight:700}.note{color:#5b6472;font-size:.85rem;margin:.25rem 0 0}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.35rem .5rem;border-bottom:1px solid #e6e9ef}.bar{display:grid;gap:.45rem}.bar-row{display:grid;grid-template-columns:6rem 1fr 4rem;gap:.5rem;align-items:center;font-size:.85rem}.bar-track{background:#eef2f8;border-radius:999px;height:.7rem;overflow:hidden}.bar-fill{background:#7aa2ff;height:100%}</style>',
    '</head><body><main class="board">']
  if (!widgets.length) parts.push('<section class="widget wide"><h2>' + heading + '</h2><p class="note">还没有看板组件。</p></section>')
  for (const widget of widgets) {
    const wide = widget.type === 'table' || widget.type === 'bar' ? ' wide' : ''
    parts.push('<section class="widget' + wide + '"><h2>' + escapeText(widget.title || '') + '</h2>')
    if (widget.type === 'metric') {
      parts.push('<p class="metric">' + escapeText(widget.value || '—') + '</p>')
      if (widget.note) parts.push('<p class="note">' + escapeText(widget.note) + '</p>')
    } else if (widget.type === 'table') {
      parts.push('<table><thead><tr>' + (widget.columns ?? []).map((c) => '<th>' + escapeText(c) + '</th>').join('') + '</tr></thead><tbody>')
      for (const row of widget.rows ?? []) parts.push('<tr>' + row.map((cell) => '<td>' + escapeText(cell) + '</td>').join('') + '</tr>')
      parts.push('</tbody></table>')
    } else if (widget.type === 'bar') {
      const values = widget.values ?? []
      const maximum = values.length ? Math.max(...values) : 0
      parts.push('<div class="bar">')
      ;(widget.labels ?? []).forEach((label, i) => {
        if (i >= values.length) return
        const width = maximum ? values[i] / maximum * 100 : 0
        parts.push('<div class="bar-row"><span>' + escapeText(label) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + width.toFixed(1) + '%"></span></span><span>' + escapeText(pyG(values[i])) + '</span></div>')
      })
      parts.push('</div>')
    }
    parts.push('</section>')
  }
  parts.push('</main></body></html>')
  return parts.join('')
}

export function renderBoardSvg(board) {
  const width = Math.trunc(board.width)
  const height = Math.trunc(board.height)
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`]
  for (const s of board.strokes) {
    if (s.type === 'path') {
      const d = s.points.map((p, i) => (i === 0 ? 'M' : 'L') + `${p[0]} ${p[1]}`).join(' ')
      parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-linecap="round" stroke-linejoin="round" />`)
    } else if (s.type === 'rect') {
      parts.push(`<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="none" stroke="${s.color}" stroke-width="2" />`)
    } else if (s.type === 'ellipse') {
      parts.push(`<ellipse cx="${s.x + s.width / 2}" cy="${s.y + s.height / 2}" rx="${s.width / 2}" ry="${s.height / 2}" fill="none" stroke="${s.color}" stroke-width="2" />`)
    } else {
      parts.push(`<text x="${s.x}" y="${s.y}" fill="${s.color}" font-size="${s.size}" font-family="system-ui,sans-serif">${escapeAttr(s.text)}</text>`)
    }
  }
  parts.push('</svg>')
  return parts.join('')
}

export function renderWhiteboardPage(title, board) {
  const heading = escapeText(title || '白板')
  return head(heading, 'body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;line-height:1.5}svg{max-width:100%;height:auto;border:1px solid #ccc;background:#fff}')
    + '<body><article><h1>' + heading + '</h1>' + renderBoardSvg(board) + '</article></body></html>'
}

export function renderMediaPage(row) {
  const heading = escapeText(row.title || '媒体')
  return head(heading, 'body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;line-height:1.5}')
    + '<body><article><h1>' + heading + '</h1><p>' + escapeText(row.media_filename || 'file') + ' · ' + escapeText(row.media_mime || '') + '</p></article></body></html>'
}

function renderWorkbookPage(title,workbook) {
  const heading = escapeText(title)
  const sheets = workbook.sheets.map(sheet => {
    const rows = sheet.rows.map(row => '<tr>'+row.map(cell=>'<td>'+escapeText(cell)+'</td>').join('')+'</tr>').join('')
    return '<section><h2>'+escapeText(sheet.name)+'</h2><table>'+rows+'</table></section>'
  }).join('')
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'
    + heading + '</title><style>body{margin:2rem;font:1rem system-ui}section{overflow:auto}table{border-collapse:collapse}td{border:1px solid #cfd9d4;padding:.4rem .65rem;white-space:pre-wrap}</style></head><body><h1>'
    + heading + '</h1>' + sheets + '</body></html>'
}

export function renderPage(row) {
  const kind = publicKind(row)
  if (kind === 'slides') return renderSlidesPage(row.title, decodeSlides(row.slides_json) ?? emptySlides())
  if (kind === 'dashboard') return renderDashboardPage(row.title, decodeDashboard(row.dashboard_json) ?? emptyDashboard())
  if (kind === 'spreadsheet') return renderWorkbookPage(row.title,decodeWorkbook(row.spreadsheet_json) ?? emptyWorkbook())
  if (kind === 'website') return renderWebsitePage(row.title, row.body)
  if (kind === 'whiteboard') return renderWhiteboardPage(row.title, decodeBoard(row.board_json) ?? emptyBoard())
  if (kind === 'media') return renderMediaPage(row)
  return renderDocumentPage(row.title, row.body)
}

export function cleanFilename(name) {
  if (typeof name !== 'string') return 'file'
  if (name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) return 'file'
  return SAFE_FILENAME.test(name) ? name : 'file'
}

export function savedMediaFilename(name) {
  const value = typeof name === 'string' ? name.trim().toWellFormed() : ''
  if (!value || value.length > 80 || value.startsWith('.') || value.includes('..') || /[\x00-\x1f\x7f<>:"/\\|?*]/.test(value)) return 'file'
  return value
}

export function exportFilename(title, kind, revision = null, mediaFilename = null) {
  if (kind === 'media') return savedMediaFilename(mediaFilename)
  const suffix = { document: '.txt', website: '.html', whiteboard: '.svg', slides: '.html', dashboard: '.html' }[kind] ?? '.txt'
  const base = kind + (revision ? `-${revision}` : '') + suffix
  return SAFE_FILENAME.test(base) ? base : 'artifact' + suffix
}

export function exportHeaders(contentType, filename, csp = null) {
  return {
    'content-type': contentType,
    'content-security-policy': csp || "default-src 'none'; sandbox; frame-ancestors 'none'; object-src 'none'",
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-disposition': `attachment; filename="${cleanFilename(filename)}"`,
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  }
}

export function sniffMime(data) {
  if (!data || data.length < 12) return null
  const at = (offset, text) => data.subarray(offset, offset + text.length).equals(Buffer.from(text, 'latin1'))
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png'
  if (at(0, '\xff\xd8\xff')) return 'image/jpeg'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  // MPEG Layer III frame sync, excluding the reserved MPEG version.
  if (at(0, 'ID3') || (data[0] === 0xff && (data[1] & 0xe6) === 0xe2 && (data[1] & 0x18) !== 0x08)) return 'audio/mpeg'
  if (at(0, 'glTF') && validGlb(data)) return GLB_MIME
  if (at(0, 'OggS')) return 'audio/ogg'
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'audio/wav'
  if (at(4, 'ftyp') && ['isom', 'iso2', 'mp41', 'mp42', 'M4A ', 'avc1'].some((brand) => at(8, brand))) return 'video/mp4'
  if (at(0, '\x1a\x45\xdf\xa3')) return 'video/webm'
  return null
}
