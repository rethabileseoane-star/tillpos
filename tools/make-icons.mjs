/**
 * Generates the PWA icon PNGs from the same design as favicon.svg.
 *
 * Run with: node tools/make-icons.mjs
 *
 * The mark is a bold ink "T" on the brand emerald tile. It is deliberately
 * full-bleed with no baked-in rounded corners: Android and iOS apply their own
 * mask, and an icon that rounds itself gets cropped twice (the old design lost
 * its corners on every launcher). The maskable variant only shrinks the glyph so
 * no crop shape can ever reach it.
 *
 * Icons are committed, so this only needs running when the design changes.
 * Kept dependency-free so the project does not need a native image library.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const EMERALD = [16, 185, 129] // cash-500
const INK = [11, 17, 32] // ink-900
const WHITE = [255, 255, 255]

/** Encode RGBA pixels as a PNG. */
function png(width, height, pixelAt) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y)
      raw[p++] = r
      raw[p++] = g
      raw[p++] = b
      raw[p++] = a
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

/** Point-in-rounded-rectangle, all values normalised to the 0..1 tile. */
function inRoundedRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false
  const cx = Math.min(Math.max(px, x0 + r), x1 - r)
  const cy = Math.min(Math.max(py, y0 + r), y1 - r)
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * The T, as two overlapping rounded bars. `scale` above 1 makes the glyph
 * smaller by mapping a wider region of the tile onto the same shape.
 */
function isGlyph(px, py, scale = 1) {
  const x = 0.5 + (px - 0.5) / scale
  const y = 0.5 + (py - 0.5) / scale
  const r = 0.018
  return (
    // crossbar
    inRoundedRect(x, y, 0.2, 0.28, 0.8, 0.415, r) ||
    // stem
    inRoundedRect(x, y, 0.4375, 0.28, 0.5625, 0.72, r)
  )
}

function sample(px, py, { maskable = false, monochrome = false }) {
  // The maskable safe zone is a circle of diameter 0.8. The plain glyph already
  // fits, but the extra 5% keeps it clear of aggressive squircle masks.
  const scale = maskable ? 1.05 : 1
  const hit = isGlyph(px, py, scale)
  if (monochrome) return hit ? [...WHITE, 255] : [0, 0, 0, 0]
  return hit ? [...INK, 255] : [...EMERALD, 255]
}

/** 4x4 supersampling, so the bar corners are not jagged at 192px. */
function antialiased(size, options) {
  const SS = 4
  const n = SS * SS
  return (x, y) => {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, options)
        r += c[0]
        g += c[1]
        b += c[2]
        a += c[3]
      }
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)]
  }
}

const files = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-512-maskable.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
  ['icon-monochrome.png', 512, { monochrome: true }],
]

mkdirSync(OUT, { recursive: true })
for (const [name, size, options] of files) {
  const file = join(OUT, name)
  writeFileSync(file, png(size, size, antialiased(size, options)))
  console.log(`wrote ${file}`)
}
