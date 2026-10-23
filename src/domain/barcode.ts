/**
 * Barcode normalisation.
 *
 * Scanners differ in what they emit: some pad EAN-13 to 14 digits, some return
 * UPC-A as 12 digits where the leading zero was stripped, and the same physical
 * label can come back with a leading or trailing space. If we store codes
 * exactly as received, the same product ends up in the catalog two or three
 * times and the scanner "loses" products it already knows.
 *
 * The rules below are deliberately conservative: we only strip whitespace and
 * normalise known UPC/EAN padding, never re-encode or checksum-guess.
 */

/** Formats the native BarcodeDetector API can read. */
export const DETECTOR_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'itf',
  'codabar',
  'qr_code',
  'data_matrix',
] as const

/** Retail line labels, tried first. Far fewer false positives than QR. */
export const RETAIL_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
] as const

/**
 * Canonical form: 13-digit EAN codes that merely pad a UPC-A drop the padding
 * zero, so the same product scanned on hardware that reports 12 digits and on
 * hardware that reports 13 stores under one key.
 */
export function normalizeBarcode(raw: string): string {
  const code = raw.trim().replace(/\s+/g, '')
  if (/^\d{13}$/.test(code) && code.startsWith('0')) return code.slice(1)
  return code
}

/**
 * Every spelling of a barcode worth trying when looking a product up.
 *
 * Storage keeps the canonical form, but a catalog imported with 13-digit codes
 * and a scanner reporting 12 must still meet. Order matters: exact match first.
 */
export function barcodeVariants(raw: string): string[] {
  const code = normalizeBarcode(raw)
  if (!code) return []
  const variants = [code]
  if (/^\d{12}$/.test(code)) variants.push(`0${code}`)
  return variants
}

export function isValidBarcode(code: string): boolean {
  if (code.length < 4 || code.length > 64) return false
  // Alphanumeric covers Code128/Code39 payloads and QR text.
  return /^[0-9A-Za-z\-.$/+%]+$/.test(code)
}

/** EAN-13 check digit. Returns null when the code is not 13 digits. */
export function ean13CheckDigit(first12: string): number | null {
  if (!/^\d{12}$/.test(first12)) return null
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const d = first12.charCodeAt(i) - 48
    // Odd positions weigh 1, even weigh 3 in EAN-13.
    sum += i % 2 === 0 ? d : d * 3
  }
  return (10 - (sum % 10)) % 10
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false
  return ean13CheckDigit(code.slice(0, 12)) === code.charCodeAt(12) - 48
}

/**
 * How many characters a human must type before the scan is considered
 * unambiguous. Only used to decide whether to show a "did you mean" hint.
 */
export function isPrefixOf(typed: string, candidate: string): boolean {
  return candidate.startsWith(typed)
}