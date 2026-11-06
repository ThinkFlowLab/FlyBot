#!/usr/bin/env node
// Cuts the community WeChat group QR code out of the owner's photo and writes
// docs/assets/wechat-group.png: the code, a white quiet zone on every side, and nothing
// else. The source photo is a DSH attachment on the Bot machine; the PNG is committed
// once and regenerated only when WeChat rotates the invite.
//
//   node scripts/community-qr.mjs [source] [out]
//
// Everything outside the code's quad is replaced with white, so no chat header, avatar,
// nickname or message preview from the photo can reach the committed file. pngjs writes
// no text chunks, so no EXIF or other metadata travels either.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import jpeg from 'jpeg-js'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'

const DEFAULT_SOURCE = '/data/dsh/attachments/v1/objects/bd/bdc77c709327f813556c2c685d907f351f16a624da9173ed90a06c698b9082df'
const DEFAULT_OUT = 'docs/assets/wechat-group.png'
const QUIET = 0.2 // white quiet zone per side, as a fraction of the code's edge length
const CODE_PX = 480 // the code's edge in the committed file; 794 px of photo modules does not decode in jsQR

const source = process.argv[2] || DEFAULT_SOURCE
const out = process.argv[3] || DEFAULT_OUT

const photo = jpeg.decode(readFileSync(source), { useTArray: true })
const code = jsQR(new Uint8ClampedArray(photo.data), photo.width, photo.height, { inversionAttempts: 'attemptBoth' })
if (!code) throw new Error(`no QR code found in ${source}`)

const { topLeftCorner: a, topRightCorner: b, bottomRightCorner: c, bottomLeftCorner: d } = code.location
const edge = (Math.hypot(b.x - a.x, b.y - a.y)
  + Math.hypot(c.x - b.x, c.y - b.y)
  + Math.hypot(d.x - c.x, d.y - c.y)
  + Math.hypot(a.x - d.x, a.y - d.y)) / 4
const margin = Math.round(edge * QUIET)

const left = Math.floor(Math.min(a.x, b.x, c.x, d.x))
const top = Math.floor(Math.min(a.y, b.y, c.y, d.y))
const right = Math.ceil(Math.max(a.x, b.x, c.x, d.x))
const bottom = Math.ceil(Math.max(a.y, b.y, c.y, d.y))
const cropW = right - left + 2 * margin
const cropH = bottom - top + 2 * margin

// Keep only pixels inside the code quad (grown by 1.5% so the outermost modules and the
// anti-aliasing on the edge survive); every other pixel of the box stays white.
const centre = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }
const quad = [a, b, c, d].map((p) => ({ x: p.x + (p.x - centre.x) * 0.015, y: p.y + (p.y - centre.y) * 0.015 }))
function inside(x, y) {
  let sign = 0
  for (let i = 0; i < 4; i += 1) {
    const p = quad[i]
    const q = quad[(i + 1) % 4]
    const cross = (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x)
    if (cross === 0) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}
const crop = new Uint8ClampedArray(cropW * cropH * 4)
crop.fill(255)
for (let y = 0; y < cropH; y += 1) {
  const sy = top - margin + y
  for (let x = 0; x < cropW; x += 1) {
    const sx = left - margin + x
    if (sx < 0 || sy < 0 || sx >= photo.width || sy >= photo.height) continue
    if (!inside(sx + 0.5, sy + 0.5)) continue
    const from = (sy * photo.width + sx) * 4
    const to = (y * cropW + x) * 4
    crop[to] = photo.data[from]
    crop[to + 1] = photo.data[from + 1]
    crop[to + 2] = photo.data[from + 2]
  }
}

// Box-filter down to a module size jsQR can still read (the 794 px crop does not decode at
// 1:1; 0.4x-0.6x does). A phone reads this size just as well and is the same code.
const scale = CODE_PX / edge
const width = Math.round(cropW * scale)
const height = Math.round(cropH * scale)
const png = new PNG({ width, height })
for (let y = 0; y < height; y += 1) {
  const y0 = Math.floor(y / scale)
  const y1 = Math.min(cropH, Math.ceil((y + 1) / scale))
  for (let x = 0; x < width; x += 1) {
    const x0 = Math.floor(x / scale)
    const x1 = Math.min(cropW, Math.ceil((x + 1) / scale))
    let r = 0
    let g = 0
    let bl = 0
    let n = 0
    for (let yy = y0; yy < y1; yy += 1) {
      for (let xx = x0; xx < x1; xx += 1) {
        const i = (yy * cropW + xx) * 4
        r += crop[i]
        g += crop[i + 1]
        bl += crop[i + 2]
        n += 1
      }
    }
    const to = (y * width + x) * 4
    png.data[to] = Math.round(r / n)
    png.data[to + 1] = Math.round(g / n)
    png.data[to + 2] = Math.round(bl / n)
    png.data[to + 3] = 255
  }
}

// The committed file must itself decode to the same invite, not only the photo it came from.
const check = jsQR(new Uint8ClampedArray(png.data), width, height, { inversionAttempts: 'attemptBoth' })
if (!check || check.data !== code.data) throw new Error('the cropped PNG does not decode to the same invite')

mkdirSync(dirname(out), { recursive: true })
const bytes = PNG.sync.write(png, { colorType: 6, inputColorType: 6 })
writeFileSync(out, bytes)

console.log(`payload: ${code.data}`)
console.log(`size: ${width}x${height}`)
console.log(`black modules per QR: decoded in jsQR at ${width}x${height} (code edge ${CODE_PX}px)`)
console.log(`sha256: ${createHash('sha256').update(bytes).digest('hex')}`)
