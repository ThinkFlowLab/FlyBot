import assert from 'node:assert/strict'
import test from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { boot, key, WS } from './helpers.js'
import { docx, exportOffice, pdf, pptx, xlsx, zipParts } from '../features/artifacts/office.js'

const base = (rest = '', ws = WS) => `/v1/workspaces/${ws}/artifacts${rest}`

export function unzip(buf) {
  const files = {}
  let i = 0
  while (buf.subarray(i, i + 4).toString('binary') === 'PK\x03\x04') {
    const method = buf.readUInt16LE(i + 8)
    const crc = buf.readUInt32LE(i + 14)
    const compact = buf.readUInt32LE(i + 18)
    const rawLen = buf.readUInt32LE(i + 22)
    const nameLen = buf.readUInt16LE(i + 26)
    const extra = buf.readUInt16LE(i + 28)
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8')
    const start = i + 30 + nameLen + extra
    const data = buf.subarray(start, start + compact)
    const raw = method === 8 ? inflateRawSync(data) : Buffer.from(data)
    assert.equal(raw.length, rawLen, name)
    files[name] = raw
    i = start + compact
    void crc
  }
  return files
}

test('docx package is a real OOXML zip with escaped unicode text', () => {
  const payload = docx('中文 & Report', '# 原始标题\nA < B & x > y\nLiteral =SUM(A1)')
  assert.equal(payload.subarray(0, 2).toString(), 'PK')
  const files = unzip(payload)
  assert.ok(files['word/document.xml'])
  assert.ok(files['[Content_Types].xml'])
  const text = files['word/document.xml'].toString()
  assert.match(text, /原始标题/)
  assert.match(text, /A &lt; B &amp; x &gt; y/)
  assert.doesNotMatch(text, /TargetMode="External"/)
  assert.ok(!Object.keys(files).some((name) => name.toLowerCase().includes('vba')))
})

test('xlsx stores formula-like values as inline strings, never formulas', () => {
  const payload = xlsx([['Workbook'], ['=HYPERLINK("https://invalid.example")']])
  const sheet = unzip(payload)['xl/worksheets/sheet1.xml'].toString()
  assert.match(sheet, /=HYPERLINK\("https:\/\/invalid\.example"\)/)
  assert.doesNotMatch(sheet, /<\/?f[ >]/)
  assert.match(sheet, /t="inlineStr"/)
})

test('pdf is a real paginated Unicode file with a valid xref table', () => {
  const payload = pdf('中文证据', 'Hello evidence\n数字 123 与原文保持一致。\n' + 'Pagination text\n'.repeat(100))
  assert.ok(payload.toString('binary').startsWith('%PDF-1.7'))
  assert.ok(payload.toString('binary').trimEnd().endsWith('%%EOF'))
  assert.ok(payload.includes(Buffer.from(Buffer.from('中文证据', 'utf16le').swap16().toString('hex').toUpperCase())))
  assert.match(payload.toString('binary'), /\/Count 3 /)
  const start = Number(/startxref\n(\d+)\n/.exec(payload.toString('binary'))[1])
  assert.equal(payload.subarray(start, start + 4).toString(), 'xref')
  assert.ok(!['/JavaScript', '/URI', '/Launch', '/OpenAction', '/EmbeddedFile'].some((m) => payload.includes(Buffer.from(m))))
  assert.throws(() => pdf('emoji', 'Keep all Unicode 😀'), /BMP/)
})

test('pptx is a real PresentationML package without macros or external links', () => {
  const payload = pptx('路线 & 报告', [{ title: '目标', bullets: ['统一入口 < B & C'] }, { title: '下一步', bullets: ['接入运行时', 'Literal =CMD()'] }])
  const files = unzip(payload)
  const slide = files['ppt/slides/slide1.xml'].toString()
  assert.match(slide, /目标/)
  assert.match(slide, /统一入口 &lt; B &amp; C/)
  assert.match(files['ppt/slides/slide2.xml'].toString(), /Literal =CMD\(\)/)
  const types = files['[Content_Types].xml'].toString()
  assert.match(types, /PartName="\/ppt\/presentation.xml"/)
  assert.doesNotMatch(types, /vbaProject/)
})

test('office exports run through the artifacts /export route in this DS-Bot', async () => {
  const bot = await boot()
  const call = (...args) => bot.call('artifacts', ...args)
  const doc = (await call('POST', base(), { title: '中文 & Report', body: '# 原始标题\nA < B & x > y', kind: 'document' }, key())).body.artifact
  const exported = await call('GET', base(`/${doc.id}/export?format=docx`))
  assert.equal(exported.status, 200, JSON.stringify(exported.body))
  assert.match(exported.download.content_type, /wordprocessingml/)
  assert.equal(exported.download.filename, `document-r1.docx`)
  const files = unzip(Buffer.from(exported.download.data, 'base64'))
  assert.match(files['word/document.xml'].toString(), /原始标题/)
  await call('POST', base('/' + doc.id), { revision: 1, changes: { body: 'CHANGED VERSION ONLY' } })
  const old = await call('GET', base(`/${doc.id}/versions/1/export?format=docx`))
  assert.equal(old.status, 200)
  assert.match(unzip(Buffer.from(old.download.data, 'base64'))['word/document.xml'].toString(), /原始标题/)
  assert.doesNotMatch(unzip(Buffer.from(old.download.data, 'base64'))['word/document.xml'].toString(), /CHANGED VERSION ONLY/)
  const pdfDoc = await call('GET', base(`/${doc.id}/export?format=pdf`))
  assert.equal(pdfDoc.status, 200, JSON.stringify(pdfDoc.body))
  assert.match(pdfDoc.download.content_type, /pdf/)
  const pdfBytes = Buffer.from(pdfDoc.download.data, 'base64')
  assert.ok(pdfBytes.toString('binary').startsWith('%PDF-1.7'))
  const emoji = (await call('POST', base(), { title: 'emoji', body: 'Keep all Unicode 😀', kind: 'document' }, key())).body.artifact
  const bmp = await call('GET', base(`/${emoji.id}/export?format=pdf`))
  assert.equal(bmp.status, 400)
  assert.equal(bmp.body.error.code, 'unsupported_export')
  assert.match(bmp.body.error.message, /BMP/)
  assert.equal((await call('GET', base(`/${doc.id}/export?format=xlsx`))).status, 400)

  const slides = (await call('POST', base(), { title: '路线', kind: 'slides', slides: { schema: 'flybot-workspace.slides.v1', slides: [{ title: '目标', bullets: ['要点'] }] } }, key())).body.artifact
  const deck = await call('GET', base(`/${slides.id}/export?format=pptx`))
  assert.equal(deck.status, 200)
  assert.match(unzip(Buffer.from(deck.download.data, 'base64'))['ppt/slides/slide1.xml'].toString(), /目标/)
  assert.equal((await call('GET', base(`/${slides.id}/export?format=docx`))).status, 400)

  const dash = (await call('POST', base(), { title: 'Workbook', kind: 'dashboard', dashboard: { schema: 'flybot-workspace.dashboard.v1', widgets: [{ type: 'table', title: '表', columns: ['A', 'B'], rows: [['1', '=HYPERLINK("https://invalid.example")']] }] } }, key())).body.artifact
  const book = await call('GET', base(`/${dash.id}/export?format=xlsx`))
  assert.equal(book.status, 200)
  const sheet = unzip(Buffer.from(book.download.data, 'base64'))['xl/worksheets/sheet1.xml'].toString()
  assert.match(sheet, /=HYPERLINK/)
  assert.doesNotMatch(sheet, /<\/?f[ >]/)
})

test('exportOffice rejects formats that do not match the artifact kind', () => {
  assert.throws(() => exportOffice({ title: 'x', body: 'y', kind: 'document', revision: 1 }, 'pptx'), /not supported/)
  const zip = zipParts({ 'a.xml': '<ok/>' }, 'a.xml', { 'a.xml': 'application/xml' })
  assert.equal(zip.subarray(0, 2).toString(), 'PK')
})
