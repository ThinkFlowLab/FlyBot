// Bounded OOXML and text-PDF exporters (legacy office_exports.py), run inside
// this user's DS-Bot. No subprocess, URL fetch, macro or external relationship.
import { crc32, deflateRawSync } from 'node:zlib'
import {decodeWorkbook,spreadsheetCell} from './workbook.js'
import { publicKind } from './model.js'
import { decodeDashboard, decodeSlides, decodeStructured } from './structured.js'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types'
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const SHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const DRAW = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main'
export const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
}

export function clean(text) {
  let out = ''
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    if (ch === '\n' || ch === '\r' || ch === '\t' || (c >= 32 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff)) out += ch
  }
  return out
}

export const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }

// ZIP_DEFLATED packages with the same timestamps and Unix modes as the legacy exporter.
export function zipParts(input, main, contentTypes) {
  const parts = { ...input }
  parts['_rels/.rels'] = XML + `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}officeDocument" Target="${main}"/></Relationships>`
  parts['[Content_Types].xml'] = XML + `<Types xmlns="${TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` + Object.entries(contentTypes).map(([name, kind]) => `<Override PartName="/${name}" ContentType="${kind}"/>`).join('') + '</Types>'
  const chunks = []
  const central = []
  let offset = 0
  const dosDate = (1 << 5) | 1 // 1980-01-01
  for (const [name, value] of Object.entries(parts)) {
    const raw = Buffer.from(value, 'utf8')
    const compressed = deflateRawSync(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(raw)
    const local = Buffer.concat([
      Buffer.from('PK\x03\x04', 'binary'), u16(20), u16(0), u16(8), u16(0), u16(dosDate),
      u32(crc), u32(compressed.length), u32(raw.length), u16(nameBuf.length), u16(0), nameBuf, compressed,
    ])
    const dir = Buffer.concat([
      Buffer.from('PK\x01\x02', 'binary'), u16(0x0314), u16(20), u16(0), u16(8), u16(0), u16(dosDate),
      u32(crc), u32(compressed.length), u32(raw.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0o600 << 16), u32(offset), nameBuf,
    ])
    chunks.push(local)
    central.push(dir)
    offset += local.length
  }
  const cd = Buffer.concat(central)
  const eocd = Buffer.concat([
    Buffer.from('PK\x05\x06', 'binary'), u16(0), u16(0), u16(chunks.length), u16(chunks.length),
    u32(cd.length), u32(offset), u16(0),
  ])
  return Buffer.concat([...chunks, cd, eocd])
}

export function docx(title, body) {
  const paragraph = (text, style) => '<w:p>' + (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : '') + '<w:r><w:t xml:space="preserve">' + escapeXml(clean(text)) + '</w:t></w:r></w:p>'
  const paragraphs = [paragraph(title, 'Title')]
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^(#{1,3}) (.+)$/.exec(line)
    paragraphs.push(heading ? paragraph(heading[2], 'Heading' + heading[1].length) : paragraph(line))
  }
  const document = XML + `<w:document xmlns:w="${WORD}"><w:body>` + paragraphs.join('') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>'
  const styles = XML + `<w:styles xmlns:w="${WORD}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style>` + [['Title', '36'], ['Heading1', '32'], ['Heading2', '28'], ['Heading3', '24']].map(([name, size]) => '<w:style w:type="paragraph" w:styleId="' + name + '"><w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="' + size + '"/></w:rPr></w:style>').join('') + '</w:styles>'
  const rels = XML + `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}styles" Target="styles.xml"/></Relationships>`
  return zipParts(
    { 'word/document.xml': document, 'word/styles.xml': styles, 'word/_rels/document.xml.rels': rels },
    'word/document.xml',
    { 'word/document.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', 'word/styles.xml': 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml' },
  )
}

function column(index) {
  let value = ''
  while (index) {
    const rem = (index - 1) % 26
    index = Math.floor((index - 1) / 26)
    value = String.fromCharCode(65 + rem) + value
  }
  return value
}

export function xlsx(rows) {
  return workbookPackage([{name:'Data',rows}])
}

export function workbookPackage(sheets, typed = false) {
  const parts = {}
  const types = {'xl/workbook.xml':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'}
  const relationships = []
  const descriptors = []
  sheets.forEach(({name,rows},index) => {
    if (rows.length > 3000 || rows.some(row => row.length > 100)) throw new Error('Spreadsheet exceeds bounded export capacity')
    const part = 'worksheets/sheet' + (index + 1) + '.xml'
    const id = index + 1
    descriptors.push(`<sheet name="${escapeXml(clean(name)).replace(/"/g,'&quot;')}" sheetId="${id}" r:id="rId${id}"/>`)
    relationships.push(`<Relationship Id="rId${id}" Type="${OFFICE}worksheet" Target="${part}"/>`)
    const body = rows.map((row,r) => {
      const cells = row.map((value,c) => {
        const ref = column(c+1) + (r+1)
        const cell = typed ? spreadsheetCell(value) : {text:value}
        if (cell.formula) return `<c r="${ref}"><f>${cell.formula}</f></c>`
        if (cell.number !== undefined) return `<c r="${ref}"><v>${cell.number}</v></c>`
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(clean(cell.text))}</t></is></c>`
      }).join('')
      return `<row r="${r+1}">${cells}</row>`
    }).join('')
    parts['xl/'+part] = XML + `<worksheet xmlns="${SHEET}"><sheetData>${body}</sheetData></worksheet>`
    types['xl/'+part] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
  })
  parts['xl/workbook.xml'] = XML + `<workbook xmlns="${SHEET}" xmlns:r="${OFFICE.slice(0,-1)}"><sheets>${descriptors.join('')}</sheets>${typed ? '<calcPr calcId="0" fullCalcOnLoad="1"/>' : ''}</workbook>`
  parts['xl/_rels/workbook.xml.rels'] = XML + `<Relationships xmlns="${REL}">${relationships.join('')}</Relationships>`
  return zipParts(parts,'xl/workbook.xml',types)
}

// East Asian Width W/F ranges used to wrap PDF lines the same way as unicodedata.
function eastAsianWide(ch) {
  const c = ch.codePointAt(0)
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x231a && c <= 0x231b) || (c >= 0x2329 && c <= 0x232a)
    || (c >= 0x23e9 && c <= 0x23ec) || c === 0x23f0 || c === 0x23f3 || (c >= 0x25fd && c <= 0x25fe)
    || (c >= 0x2614 && c <= 0x2615) || (c >= 0x2648 && c <= 0x2653) || c === 0x267f || c === 0x2693
    || c === 0x26a1 || (c >= 0x26aa && c <= 0x26ab) || (c >= 0x26bd && c <= 0x26be) || (c >= 0x26c4 && c <= 0x26c5)
    || c === 0x26ce || c === 0x26d4 || c === 0x26ea || (c >= 0x26f2 && c <= 0x26f3) || c === 0x26f5 || c === 0x26fa
    || c === 0x26fd || c === 0x2705 || (c >= 0x270a && c <= 0x270b) || c === 0x2728 || c === 0x274c || c === 0x274e
    || (c >= 0x2753 && c <= 0x2755) || c === 0x2757 || (c >= 0x2795 && c <= 0x2797) || c === 0x27b0 || c === 0x27bf
    || (c >= 0x2b1b && c <= 0x2b1c) || c === 0x2b50 || c === 0x2b55 || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f)
    || (c >= 0xa960 && c <= 0xa97c) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe10 && c <= 0xfe19) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1b000 && c <= 0x1b12f) || (c >= 0x1f200 && c <= 0x1f2ff)
    || (c >= 0x20000 && c <= 0x2fffd) || (c >= 0x30000 && c <= 0x3fffd)
}

function utf16beHex(text) {
  const units = []
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if (c > 0xffff) {
      const u = c - 0x10000
      units.push(((u >> 10) + 0xd800), ((u & 0x3ff) + 0xdc00))
    } else units.push(c)
  }
  return units.map((c) => c.toString(16).toUpperCase().padStart(4, '0')).join('')
}

export function pdf(title, text) {
  const lines = []
  const source = (clean(title) + '\n\n' + clean(text)).replace(/\t/g, '    ').replace(/\r\n/g, '\n')
  for (const paragraph of source.split('\n')) {
    let line = '', width = 0
    for (const char of paragraph) {
      const size = eastAsianWide(char) ? 2 : 1
      if (width + size > 76) { lines.push(line); line = ''; width = 0 }
      line += char
      width += size
    }
    lines.push(line)
  }
  const pages = []
  for (let i = 0; i < lines.length; i += 42) pages.push(lines.slice(i, i + 42))
  if (!pages.length) pages.push([''])
  if (pages.length > 64) throw new Error('Text PDF exceeds 64 pages')
  const chars = [...new Set(lines.join(''))].sort()
  if (chars.some((c) => c.codePointAt(0) > 0xffff)) throw new Error('Text PDF currently supports BMP Unicode only; use DOCX for emoji/non-BMP text')
  let cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /FlyBotUnicode def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
  for (let start = 0; start < chars.length; start += 100) {
    const chunk = chars.slice(start, start + 100)
    cmap += chunk.length + ' beginbfchar\n' + chunk.map((c) => `<${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}> <${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}>\n`).join('') + 'endbfchar\n'
  }
  cmap += 'endcmap CMapName currentdict /CMap defineresource pop end end'
  const stream = (raw) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'ascii')
    return Buffer.concat([Buffer.from('<< /Length ' + buf.length + ' >>\nstream\n'), buf, Buffer.from('\nendstream')])
  }
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from(''),
    Buffer.from('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /W [1 95 500] /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 80 >> >>'),
    stream(cmap),
  ]
  const kids = []
  for (const page of pages) {
    const index = objects.length + 1
    kids.push(index + ' 0 R')
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${index + 1} 0 R >>`))
    const content = 'BT /F1 12 Tf 54 788 Td 17 TL\n' + page.map((line) => '<' + utf16beHex(line) + '> Tj T*').join('\n') + '\nET'
    objects.push(stream(content))
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`)
  let output = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'binary')
  const offsets = [0]
  for (const [i, obj] of objects.entries()) {
    offsets.push(output.length)
    output = Buffer.concat([output, Buffer.from(`${i + 1} 0 obj\n`), obj, Buffer.from('\nendobj\n')])
  }
  const xref = output.length
  output = Buffer.concat([output, Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`)])
  for (const offset of offsets.slice(1)) output = Buffer.concat([output, Buffer.from(offset.toString().padStart(10, '0') + ' 00000 n \n')])
  output = Buffer.concat([output, Buffer.from(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)])
  return output
}

export function structuredRows(title, dashboard) {
  const rows = [[title]]
  for (const widget of dashboard?.widgets ?? []) {
    rows.push([widget.title ?? ''])
    if (widget.type === 'table') rows.push(widget.columns ?? [], ...(widget.rows ?? []))
    else if (widget.type === 'bar') {
      const labels = widget.labels ?? [], values = widget.values ?? []
      for (let i = 0; i < labels.length; i++) rows.push([labels[i], String(values[i])])
    } else rows.push([widget.value ?? '', widget.note ?? ''])
    rows.push([])
  }
  return rows
}

// PresentationML theme, layout and master copied from the legacy exporter (no macros or external links).
const THEME = XML + `<a:theme xmlns:a="${DRAW}" name="FlyBot"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F4E79"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="5B9BD5"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="4472C4"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`
const LAYOUT = XML + `<p:sldLayout xmlns:a="${DRAW}" xmlns:r="${OFFICE.slice(0, -1)}" xmlns:p="${PML}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
const MASTER = XML + `<p:sldMaster xmlns:a="${DRAW}" xmlns:r="${OFFICE.slice(0, -1)}" xmlns:p="${PML}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="lt1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`

export function pptx(title, slides) {
  let deck = [...(slides || [])]
  if (!deck.length) deck = [{ title: title || '幻灯片', bullets: [] }]
  if (deck.length > 30) throw new Error('Presentation exceeds 30 slides')
  const tx = (text, size, bold = false) => {
    const run = '<a:r><a:rPr lang="zh-CN" sz="' + size + '"' + (bold ? ' b="1"' : '') + ' dirty="0"/><a:t>' + escapeXml(clean(text)) + '</a:t></a:r>'
    return '<a:p><a:pPr algn="l"/>' + run + '<a:endParaRPr lang="zh-CN" sz="' + size + '"/></a:p>'
  }
  const shape = (ident, name, x, y, cx, cy, paragraphs) => (
    '<p:sp><p:nvSpPr><p:cNvPr id="' + ident + '" name="' + name + '"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>'
    + '<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/>' + paragraphs + '</p:txBody></p:sp>'
  )
  const slideXml = (entry) => {
    const heading = entry.title || title || ''
    const bullets = (entry.bullets || []).filter((item) => String(item).trim())
    const body = bullets.map((item) => tx(item ? ('• ' + item) : '', 2000)).join('') || tx('', 2000)
    const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
      + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
      + shape(2, 'Title', 457200, 274638, 8229600, 1143000, tx(heading, 3200, true))
      + shape(3, 'Content', 457200, 1600200, 8229600, 3143250, body)
    return XML + `<p:sld xmlns:a="${DRAW}" xmlns:r="${OFFICE.slice(0, -1)}" xmlns:p="${PML}"><p:cSld><p:spTree>` + tree + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  }
  const parts = {
    'ppt/theme/theme1.xml': THEME,
    'ppt/slideLayouts/slideLayout1.xml': LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': XML + `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    'ppt/slideMasters/slideMaster1.xml': MASTER,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': XML + `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${OFFICE}theme" Target="../theme/theme1.xml"/></Relationships>`,
    'ppt/presProps.xml': XML + `<p:presentationPr xmlns:p="${PML}"/>`,
    'ppt/viewProps.xml': XML + `<p:viewPr xmlns:p="${PML}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr></p:viewPr>`,
    'ppt/tableStyles.xml': XML + `<a:tblStyleLst xmlns:a="${DRAW}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
  }
  const types = {
    'ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    'ppt/slideMasters/slideMaster1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
    'ppt/slideLayouts/slideLayout1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
    'ppt/theme/theme1.xml': 'application/vnd.openxmlformats-officedocument.theme+xml',
    'ppt/presProps.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
    'ppt/viewProps.xml': 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
    'ppt/tableStyles.xml': 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  }
  const slideRels = []
  deck.forEach((entry, i) => {
    const index = i + 1
    const name = `ppt/slides/slide${index}.xml`
    parts[name] = slideXml(entry)
    parts[`ppt/slides/_rels/slide${index}.xml.rels`] = XML + `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${OFFICE}slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`
    types[name] = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'
    slideRels.push(`<Relationship Id="rId${index}" Type="${OFFICE}slide" Target="slides/slide${index}.xml"/>`)
  })
  const base = deck.length
  parts['ppt/presentation.xml'] = XML + `<p:presentation xmlns:a="${DRAW}" xmlns:r="${OFFICE.slice(0, -1)}" xmlns:p="${PML}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${base + 1}"/></p:sldMasterIdLst><p:sldIdLst>` + deck.map((_, i) => `<p:sldId id="${255 + i + 1}" r:id="rId${i + 1}"/>`).join('') + `</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  parts['ppt/_rels/presentation.xml.rels'] = XML + `<Relationships xmlns="${REL}">` + slideRels.join('') + `<Relationship Id="rId${base + 1}" Type="${OFFICE}slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId${base + 2}" Type="${OFFICE}presProps" Target="presProps.xml"/><Relationship Id="rId${base + 3}" Type="${OFFICE}viewProps" Target="viewProps.xml"/><Relationship Id="rId${base + 4}" Type="${OFFICE}tableStyles" Target="tableStyles.xml"/></Relationships>`
  return zipParts(parts, 'ppt/presentation.xml', types)
}

export function exportOffice(row, format, fromVersion = false) {
  let kind = fromVersion ? row.kind : publicKind(row)
  let structured = null
  if (kind === 'dashboard') structured = decodeDashboard(row.dashboard_json)
  else if (kind === 'slides') structured = decodeSlides(row.slides_json)
  else if (kind === 'spreadsheet') structured = decodeWorkbook(row.spreadsheet_json)
  else if (kind === 'document') {
    const [detected, value] = decodeStructured(row.body)
    if (value) { kind = detected; structured = value }
  }
  let payload
  if (format === 'docx' && kind === 'document') payload = docx(row.title, row.body)
  else if (format === 'xlsx' && kind === 'spreadsheet' && structured) payload = workbookPackage(structured.sheets,true)
  else if (format === 'xlsx' && kind === 'dashboard') payload = xlsx(structuredRows(row.title, structured))
  else if (format === 'pptx' && kind === 'slides') payload = pptx(row.title, (structured || {}).slides || [])
  else if (format === 'pdf' && (kind === 'document' || kind === 'slides' || kind === 'dashboard')) {
    let text = row.body
    if (kind === 'slides') text = ((structured || {}).slides || []).map((s) => (s.title || '') + '\n' + (s.bullets || []).join('\n')).join('\n\n')
    if (kind === 'dashboard') text = structuredRows('', structured).map((r) => r.map(String).join(' | ')).join('\n')
    payload = pdf(row.title, text)
  } else throw new Error('Format is not supported for this artifact kind')
  return { payload, contentType: MIME[format], filename: `${kind}-r${row.revision}.${format}` }
}
