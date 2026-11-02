/**
 * The shapes of the two codes a shopkeeper sees.
 *
 * A licence key is not stored on the server in plaintext. The admin screen and
 * the Edge Function both reduce it to `compactLicenseKey` and hash that string,
 * so the same key typed with or without hyphens still matches.
 *
 * Device codes are deliberately short and non-secret. They are an allow-list
 * label: the customer reads one off the activation screen and the seller adds it
 * to the licence. The secret is the licence key plus the server's device check.
 */

export const LICENSE_PREFIX = 'TILL'
export const LICENSE_KEY_GROUPS = 4
export const LICENSE_KEY_GROUP_SIZE = 4
export const LICENSE_KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const DEVICE_PREFIX = 'D'
export const DEVICE_CODE_GROUPS = 2
export const DEVICE_CODE_GROUP_SIZE = 4

function clean(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function randomChars(count: number): string {
  const out: string[] = []
  const limit = 256 - (256 % LICENSE_KEY_ALPHABET.length)
  while (out.length < count) {
    const bytes = new Uint8Array(count * 2)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= limit) continue
      out.push(LICENSE_KEY_ALPHABET[byte % LICENSE_KEY_ALPHABET.length])
      if (out.length === count) break
    }
  }
  return out.join('')
}

function groups(value: string, size: number): string {
  const parts: string[] = []
  for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size))
  return parts.join('-')
}

/** `TILL-7K4P-92MX-...` with no ambiguous characters. */
export function generateLicenseKey(): string {
  const body = randomChars(LICENSE_KEY_GROUPS * LICENSE_KEY_GROUP_SIZE)
  return `${LICENSE_PREFIX}-${groups(body, LICENSE_KEY_GROUP_SIZE)}`
}

/** Letters and digits only, e.g. `TILL7K4P92MX...`. This is what gets hashed. */
export function compactLicenseKey(value: string): string {
  return clean(value)
}

/** Display form. Returns the compact form when it cannot be grouped safely. */
export function normalizeLicenseKey(value: string): string {
  const compact = compactLicenseKey(value)
  if (!isLicenseKey(compact)) return compact
  return `${LICENSE_PREFIX}-${groups(compact.slice(LICENSE_PREFIX.length), LICENSE_KEY_GROUP_SIZE)}`
}

export function isLicenseKey(value: string): boolean {
  const compact = compactLicenseKey(value)
  const expected = LICENSE_PREFIX.length + LICENSE_KEY_GROUPS * LICENSE_KEY_GROUP_SIZE
  if (compact.length !== expected) return false
  if (!compact.startsWith(LICENSE_PREFIX)) return false
  for (const char of compact.slice(LICENSE_PREFIX.length)) {
    if (!LICENSE_KEY_ALPHABET.includes(char)) return false
  }
  return true
}

/** `D-7F3A-92K1`. */
export function generateDeviceCode(): string {
  const body = randomChars(DEVICE_CODE_GROUPS * DEVICE_CODE_GROUP_SIZE)
  return `${DEVICE_PREFIX}-${groups(body, DEVICE_CODE_GROUP_SIZE)}`
}

/** Canonical device code, or the cleaned input when it does not fit the shape. */
export function normalizeDeviceCode(value: string): string {
  const compact = clean(value)
  if (!compact.startsWith(DEVICE_PREFIX)) return compact
  const body = compact.slice(DEVICE_PREFIX.length)
  const expected = DEVICE_CODE_GROUPS * DEVICE_CODE_GROUP_SIZE
  if (body.length !== expected) return compact
  for (const char of body) {
    if (!LICENSE_KEY_ALPHABET.includes(char)) return compact
  }
  return `${DEVICE_PREFIX}-${groups(body, DEVICE_CODE_GROUP_SIZE)}`
}

export function isDeviceCode(value: string): boolean {
  const normalized = normalizeDeviceCode(value)
  return (
    normalized.startsWith(`${DEVICE_PREFIX}-`) &&
    normalized.length === DEVICE_PREFIX.length + 1 + DEVICE_CODE_GROUPS * DEVICE_CODE_GROUP_SIZE + (DEVICE_CODE_GROUPS - 1)
  )
}

/** SHA-256, lowercase hex. Used for licence-key storage. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Hash the canonical key, never the raw typed text. */
export function hashLicenseKey(value: string): Promise<string> {
  return sha256Hex(compactLicenseKey(value))
}

/** Browser clipboard with a useful failure instead of silently doing nothing. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}
