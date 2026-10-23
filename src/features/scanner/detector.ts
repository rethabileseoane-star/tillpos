import type { ReadInputBarcodeFormat } from 'zxing-wasm/reader'
import { DETECTOR_FORMATS, normalizeBarcode } from '@/domain/barcode'

/**
 * Barcode decoding.
 *
 * Two paths, both fully on-device so the scanner works in airplane mode:
 *
 * 1. `BarcodeDetector` — native, fast, present in Chrome on Android and desktop.
 * 2. `zxing-wasm` — WebAssembly decoder bundled by the build. This is the
 *    fallback for Safari and Firefox, which have no native API.
 *
 * The WASM binary must be served from the app origin. Bundlers sometimes leave
 * the default fetch in place, which would reach for a CDN at runtime and break
 * offline, so the file path is set explicitly.
 */

export interface DecodedBarcode {
  code: string
  format: string
}

interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string; format: string }>>
}

type NativeDetectorCtor = {
  new (options?: { formats?: readonly string[] }): NativeBarcodeDetector
  getSupportedFormats?(): Promise<string[]>
}

function getNativeCtor(): NativeDetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: NativeDetectorCtor }
  return w.BarcodeDetector ?? null
}

export function hasNativeDetector(): boolean {
  return getNativeCtor() !== null
}

/**
 * Tell the decoder where the bundled `.wasm` lives.
 *
 * Without this the emscripten loader resolves `zxing_reader.wasm` relative to
 * the page, finds nothing, and falls back to a CDN. In airplane mode that is a
 * dead scanner, and the failure looks like "it just does not scan" rather than
 * a network error. Vite fingerprints the file into /assets, so we import its
 * URL rather than guessing a path.
 */
async function initWasm(): Promise<typeof import('zxing-wasm/reader')> {
  const [mod, wasmUrl] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ])
  mod.setZXingModuleOverrides?.({
    locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl.default : path),
  })
  return mod
}

let wasmReady: Promise<typeof import('zxing-wasm/reader')> | null = null

function getWasmReader() {
  wasmReady ??= initWasm()
  return wasmReady
}

/** Decode one video frame. Returns null when nothing is found. */
export async function decodeFrame(
  source: CanvasImageSource,
  formats: readonly string[],
): Promise<DecodedBarcode | null> {
  const Ctor = getNativeCtor()
  if (Ctor) {
    try {
      const detector = new Ctor({ formats: [...formats] })
      const found = await detector.detect(source)
      const hit = found.find((r) => r.rawValue)
      if (hit) return { code: normalizeBarcode(hit.rawValue), format: hit.format }
      return null
    } catch {
      // Some browsers expose the constructor but throw on unsupported formats.
      // Fall through to WASM rather than failing the scan.
    }
  }

  try {
    const canvas = source as HTMLCanvasElement
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const zxing = await getWasmReader()
    const results = await zxing.readBarcodesFromImageData(data, {
      tryHarder: true,
      formats: formats.map(mapFormatForZxing),
    })
    const hit = results.find((r) => r.text)
    if (hit) return { code: normalizeBarcode(hit.text), format: hit.format }
  } catch (err) {
    if (import.meta.env.DEV) console.warn('wasm decode failed', err)
  }
  return null
}

/** zxing-wasm format names differ from the native API's snake_case values. */
function mapFormatForZxing(format: string): ReadInputBarcodeFormat {
  switch (format) {
    case 'ean_13':
      return 'EAN-13'
    case 'ean_8':
      return 'EAN-8'
    case 'upc_a':
      return 'UPC-A'
    case 'upc_e':
      return 'UPC-E'
    case 'code_128':
      return 'Code128'
    case 'code_39':
      return 'Code39'
    case 'code_93':
      return 'Code93'
    case 'itf':
      return 'ITF'
    case 'codabar':
      return 'Codabar'
    case 'qr_code':
      return 'QRCode'
    case 'data_matrix':
      return 'DataMatrix'
    default:
      // Unknown format: let the decoder try everything it supports.
      return 'Any'
  }
}

export { DETECTOR_FORMATS }