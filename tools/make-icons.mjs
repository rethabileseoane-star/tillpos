/**
 * Generates the PWA icon PNGs from the same design as favicon.svg.
 *
 * Run with: node tools/make-icons.mjs
 *
 * These are committed to the repo, so this only needs running when the icon
 * design changes. Kept dependency-free so it does not pull a native image
 * library into the project just for two files.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const BG = [11, 17, 32] // ink-900
const GREEN = [16, 185, 129] // cash-500
const GREY = [71, 85, 105] // ink-500

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

function render(size) {
  const s = size
  const bar = (y0, h, colour) => (y, x) =>
    y >= y0 * s && y < (y0 + h) * s && x >= (0.16 * s) && x < 0.84 * s ? [...colour, 255] : null

  const bars = [bar(0.19, 0.125, GREEN), bar(0.44, 0.094, GREY), bar(0.67, 0.094, GREY)]

  return (x, y) => {
    // Rounded square background with a soft edge.
    const radius = s * 0.22
    const dx = Math.max(radius - x, 0, x - (s - radius))
    const dy = Math.max(radius - y, 0, y - (s - radius))
    if (Math.hypot(dx, dy) > radius) return [0, 0, 0, 0]

    for (const b of bars) {
      const hit = b(y, x)
      if (hit) return hit
    }
    return [...BG, 255]
  }
}

mkdirSync(OUT, { recursive: true })
for (const size of [192, 512]) {
  const file = join(OUT, `icon-${size}.png`)
  writeFileSync(file, png(size, size, render(size)))
  console.log(`wrote ${file}`)
}