/**
 * Licence-token verification.
 *
 * The seller's Edge Function signs short-lived access tokens and longer-lived
 * refresh tokens with an ES256 private key. The app only ever has the public
 * key, so a copied app cannot mint its own token.
 *
 * This module deliberately has no React, storage or network imports: the same
 * verifier is used by the licence provider and by the test runner.
 */

export const LICENSE_ISSUER = 'till-license'
export const ACCESS_TOKEN_TTL_HOURS = 24

export type LicenseTokenType = 'access' | 'refresh'

export interface LicenseClaims {
  /** Issuer, always till-license. */
  iss: string
  /** Licence id. */
  sub: string
  /** access or refresh. */
  typ: LicenseTokenType
  /** Canonical device code this token belongs to. */
  dev: string
  /** Licence id again, for readability in the app. */
  lic: string
  /** Business name shown in Settings and the lock screen. */
  name: string
  /** Number of shops this business may keep on one device. */
  maxShops: number
  /** Hours the access token may be used offline. */
  offlineHours: number
  /** Licence expiry, Unix seconds. */
  lexp: number
  /** Issued at, Unix seconds. */
  iat: number
  /** Access expiry, Unix seconds. */
  exp: number
  /** Token format version. */
  v: 1
}

export type LicenseTokenErrorCode =
  | 'TOKEN_MALFORMED'
  | 'TOKEN_SIGNATURE'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_DEVICE'
  | 'TOKEN_TYPE'
  | 'TOKEN_ISSUER'
  | 'TOKEN_LICENSE_EXPIRED'
  | 'TOKEN_KEY'

export class LicenseTokenError extends Error {
  readonly code: LicenseTokenErrorCode

  constructor(code: LicenseTokenErrorCode, message: string) {
    super(message)
    this.name = 'LicenseTokenError'
    this.code = code
  }
}

interface JwtHeader {
  alg?: unknown
  typ?: unknown
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeSegment(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

function decodeJsonSegment<T>(value: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T
  } catch {
    throw new LicenseTokenError('TOKEN_MALFORMED', 'The licence token is not valid JSON.')
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isClaims(value: unknown): value is LicenseClaims {
  if (!value || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  return (
    typeof c.iss === 'string' &&
    typeof c.sub === 'string' &&
    (c.typ === 'access' || c.typ === 'refresh') &&
    typeof c.dev === 'string' &&
    typeof c.lic === 'string' &&
    typeof c.name === 'string' &&
    isNumber(c.maxShops) &&
    isNumber(c.offlineHours) &&
    isNumber(c.lexp) &&
    isNumber(c.iat) &&
    isNumber(c.exp) &&
    c.v === 1
  )
}

async function importPublicKey(publicKey: JsonWebKey): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'jwk',
      publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  } catch {
    throw new LicenseTokenError('TOKEN_KEY', 'The licence verification key is invalid.')
  }
}

/** Sign a token. Exported for the test runner; production signing stays on the server. */
export async function signLicenseToken(claims: LicenseClaims, privateKey: JsonWebKey): Promise<string> {
  const header = { alg: 'ES256', typ: 'JWT' }
  const body = `${encodeSegment(header)}.${encodeSegment(claims)}`
  const key = await crypto.subtle.importKey(
    'jwk',
    privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(body),
  )
  return `${body}.${bytesToBase64Url(new Uint8Array(signature))}`
}

export interface VerifyLicenseTokenOptions {
  /** The device code on this installation. */
  expectedDevice: string
  /** Reject a refresh token where an access token is required, and vice versa. */
  expectedType?: LicenseTokenType
  now?: number
  /** Allow a small clock difference between the phone and the server. */
  clockSkewSeconds?: number
}

/**
 * Verify the signature, device binding, issuer, type, expiry and licence expiry.
 * Throws LicenseTokenError with a stable code that the UI can translate.
 */
export async function verifyLicenseToken(
  token: string,
  publicKey: JsonWebKey,
  options: VerifyLicenseTokenOptions,
): Promise<LicenseClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new LicenseTokenError('TOKEN_MALFORMED', 'The licence token is incomplete.')
  }

  const [headerPart, payloadPart, signaturePart] = parts
  const header = decodeJsonSegment<JwtHeader>(headerPart)
  if (header.alg !== 'ES256') {
    throw new LicenseTokenError('TOKEN_MALFORMED', 'The licence token uses an unsupported algorithm.')
  }

  const claims = decodeJsonSegment<unknown>(payloadPart)
  if (!isClaims(claims)) {
    throw new LicenseTokenError('TOKEN_MALFORMED', 'The licence token has missing fields.')
  }

  const key = await importPublicKey(publicKey)
  let valid = false
  try {
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlToBytes(signaturePart) as BufferSource,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    )
  } catch {
    valid = false
  }
  if (!valid) {
    throw new LicenseTokenError('TOKEN_SIGNATURE', 'The licence token signature is invalid.')
  }

  if (claims.iss !== LICENSE_ISSUER) {
    throw new LicenseTokenError('TOKEN_ISSUER', 'The licence token came from another issuer.')
  }
  if (options.expectedType && claims.typ !== options.expectedType) {
    throw new LicenseTokenError('TOKEN_TYPE', 'This is the wrong kind of licence token.')
  }
  if (claims.dev !== options.expectedDevice) {
    throw new LicenseTokenError('TOKEN_DEVICE', 'This licence token belongs to another device.')
  }

  const now = Math.floor((options.now ?? Date.now()) / 1000)
  const skew = options.clockSkewSeconds ?? 60
  if (claims.exp + skew <= now) {
    throw new LicenseTokenError('TOKEN_EXPIRED', 'The offline licence period has ended.')
  }
  if (claims.lexp + skew <= now) {
    throw new LicenseTokenError('TOKEN_LICENSE_EXPIRED', 'The subscription has ended.')
  }

  return claims
}

export function tokenExpiresAt(claims: LicenseClaims): number {
  return claims.exp * 1000
}

export function licenseExpiresAt(claims: LicenseClaims): number {
  return claims.lexp * 1000
}
