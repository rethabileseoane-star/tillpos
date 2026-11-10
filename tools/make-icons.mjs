/**
 * Generates the PWA icon PNGs.
 *
 * The mark is a glossy white T raised off an emerald gradient tile: a soft drop
 * shadow, a darker emerald extruded edge under the glyph, and a lit inner bevel
 * on the white face. Everything is drawn from signed distance fields so the
 * edges stay smooth at every size without an image library.
 *
 * Full-bleed with no baked corners: Android and iOS apply their own mask. Only
 * the maskable variant shrinks the glyph, so no crop shape can reach it.
 *
 * Run: node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

const EMERALD_LIGHT = [52, 211, 153] // #34d399
const EMERALD_DARK = [4, 120, 87] // #047857
const EMERALD_SIDE = [3, 84, 61] // the raised edge under the T
const SHADOW = [2, 44, 34] // #022c22
const WHITE = [255, 255, 255]
const WHITE_LOW = [232, 245, 239] // faint mint at the foot of the glyph

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

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}
const rgba = (c, a = 255) => [
  Math.max(0, Math.min(255, Math.round(c[0]))),
  Math.max(0, Math.min(255, Math.round(c[1]))),
  Math.max(0, Math.min(255, Math.round(c[2]))),
  a,
]

/** Signed distance to a rounded rectangle in normalised tile space. */
function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const hx = (x1 - x0) / 2 - r
  const hy = (y1 - y0) / 2 - r
  const qx = Math.abs(px - cx) - hx
  const qy = Math.abs(py - cy) - hy
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
  const inside = Math.min(Math.max(qx, qy), 0)
  return outside + inside - r
}

/**
 * The T as two overlapping bars. `scale` above 1 shrinks the glyph by mapping a
 * wider region of the tile onto the same silhouette.
 */
function sdT(px, py, scale = 1) {
  const x = 0.5 + (px - 0.5) / scale
  const y = 0.5 + (py - 0.5) / scale
  const bar = sdRoundRect(x, y, 0.2, 0.28, 0.8, 0.415, 0.02)
  const stem = sdRoundRect(x, y, 0.4375, 0.28, 0.5625, 0.72, 0.02)
  return Math.min(bar, stem)
}

/** Tile: diagonal emerald gradient, a soft top-left light, a slight vignette. */
function tile(x, y) {
  let c = mix(EMERALD_LIGHT, EMERALD_DARK, clamp01(x * 0.35 + y * 0.75))
  const glow = Math.max(0, 1 - Math.hypot(x - 0.26, y - 0.14) / 0.9)
  c = mix(c, WHITE, glow * glow * 0.11)
  const vignette = smoothstep(0.5, 1, y)
  return mix(c, SHADOW, vignette * 0.12)
}

function paint(x, y, { maskable = false, monochrome = false, rounded = false }) {
  const scale = maskable || monochrome ? 1.06 : 1
  const sd = sdT(x, y, scale)

  if (monochrome) {
    return sd <= 0 ? [...WHITE, 255] : [0, 0, 0, 0]
  }

  // Rounded tile for contexts that paint the icon as-is (desktop install,
  // browser UI, taskbar). Maskable and Apple touch stay full-bleed because the
  // platform applies its own shape and transparency would show as black corners.
  if (rounded && sdRoundRect(x, y, 0, 0, 1, 1, 0.225) > 0) {
    return [0, 0, 0, 0]
  }

  let c = tile(x, y)

  // Soft ambient shadow, cast down and slightly right.
  const shadow = smoothstep(0.032, -0.01, sdT(x - 0.008, y - 0.034, scale))
  c = mix(c, SHADOW, shadow * 0.42)

  // The raised dark edge: the same glyph offset down, peeking out beneath.
  const side = sdT(x - 0.005, y - 0.018, scale)
  if (side <= 0) {
    c = mix(EMERALD_SIDE, EMERALD_DARK, clamp01((y - 0.5) / 0.25))
  }

  if (sd <= 0) {
    // Glossy white face: bright at the top, faintly mint at the foot.
    const v = clamp01((y - 0.28) / 0.44)
    let face = mix(WHITE, WHITE_LOW, v * 0.9)

    // Lit inner bevel. Light from the top-left, using the SDF gradient as the
    // surface normal: the top edges catch the light, the underside falls away.
    const e = 0.004
    const dx = sdT(x + e, y, scale) - sd
    const dy = sdT(x, y + e, scale) - sd
    const len = Math.hypot(dx, dy) || 1
    const lambert = Math.max(0, -((dx / len) * 0.55 + (dy / len) * 0.83))
    const rim = 1 - smoothstep(0, 0.02, -sd)
    face = mix(face, WHITE, lambert * rim * 0.45)
    face = mix(face, [203, 228, 218], (1 - lambert) * rim * 0.22)

    // A soft specular band across the upper third.
    const gloss = Math.exp(-(((y - 0.33) / 0.06) ** 2)) * 0.12
    face = mix(face, WHITE, gloss)

    return rgba(face)
  }

  return rgba(c)
}

/** 4x4 supersampling, so the curves and the shadow are clean at 192 px. */
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
        const c = paint((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, options)
        // Premultiply so the transparent corners do not bleed dark fringes.
        const w = c[3]
        r += c[0] * w
        g += c[1] * w
        b += c[2] * w
        a += w
      }
    }
    return a === 0
      ? [0, 0, 0, 0]
      : [
          Math.round(r / a),
          Math.round(g / a),
          Math.round(b / a),
          Math.round(a / n),
        ]
  }
}

const files = [
  ['icon-192.png', 192, { rounded: true }],
  ['icon-512.png', 512, { rounded: true }],
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
