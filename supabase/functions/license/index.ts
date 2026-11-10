// Supabase Edge Function: licence activation and check-in.
//
// Deploy as the function named `license`. Secrets:
//   LICENSE_PRIVATE_JWK  (required, ES256 private JWK)
//   LICENSE_PUBLIC_JWK   (recommended, ES256 public JWK)
//   LICENSE_ISSUER       (optional, defaults to till-license)
//
// The function uses the service-role key only inside Supabase; the app sends
// the public anon key. Never put the service-role key in the app bundle.

import { createClient } from 'npm:@supabase/supabase-js@2.117.2'

const ISSUER = Deno.env.get('LICENSE_ISSUER') ?? 'till-license'
const REFRESH_DAYS = 730
const ATTEMPT_WINDOW_MINUTES = 10
const ATTEMPT_LIMIT = 20

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type Json = Record<string, unknown>

interface LicenseRow {
  id: string
  key_hash: string
  business_name: string
  customer_name: string | null
  status: string
  max_devices: number
  max_shops: number
  offline_hours: number
  expires_at: string
}

interface DeviceRow {
  id: string
  license_id: string
  device_code: string
  status: string
  activated_at: string | null
}

interface Claims {
  iss: string
  sub: string
  typ: 'access' | 'refresh'
  dev: string
  lic: string
  name: string
  maxShops: number
  offlineHours: number
  lexp: number
  iat: number
  exp: number
  v: 1
}

class ApiError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

function fail(error: ApiError): Response {
  return json({ ok: false, error: { code: error.code, message: error.message } }, error.status)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Input caps. Everything a caller sends is unbounded until it is bounded here:
 * a 10 MB licence key would be hashed and compared, and an unbounded `appVersion`
 * would end up in the audit table. Real values are far shorter than these.
 */
const MAX_KEY_CHARS = 64
const MAX_DEVICE_CHARS = 24
const MAX_TOKEN_CHARS = 4096
const MAX_APP_VERSION_CHARS = 64

function normalizeLicenseKey(value: unknown): string {
  return text(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, MAX_KEY_CHARS)
}

function normalizeDeviceCode(value: unknown): string {
  const compact = text(value).toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (compact.length > MAX_DEVICE_CHARS) return ''
  if (!compact.startsWith('D') || compact.length !== 9) return compact
  return `D-${compact.slice(1, 5)}-${compact.slice(5)}`
}

function boundedToken(value: unknown): string {
  const token = text(value)
  return token.length > MAX_TOKEN_CHARS ? '' : token
}

function appVersion(value: unknown): string {
  return text(value).slice(0, MAX_APP_VERSION_CHARS)
}

function sha256Hex(value: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then((digest) =>
    [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  )
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeSegment(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)))
}

function decodeSegment<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T
}

function readJwk(name: string): JsonWebKey {
  const raw = Deno.env.get(name)
  if (!raw) throw new ApiError('SERVER_ERROR', `Licence server secret ${name} is missing.`, 500)
  try {
    return JSON.parse(raw) as JsonWebKey
  } catch {
    throw new ApiError('SERVER_ERROR', `Licence server secret ${name} is not valid JSON.`, 500)
  }
}

function publicFromPrivate(privateJwk: JsonWebKey): JsonWebKey {
  const { d: _d, ...rest } = privateJwk as JsonWebKey & { d?: string }
  return { ...rest, key_ops: ['verify'] }
}

async function signToken(claims: Claims): Promise<string> {
  const privateJwk = readJwk('LICENSE_PRIVATE_JWK')
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const header = { alg: 'ES256', typ: 'JWT' }
  const body = `${encodeSegment(header)}.${encodeSegment(claims)}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(body),
  )
  return `${body}.${bytesToBase64Url(new Uint8Array(signature))}`
}

async function verifyToken(token: string): Promise<Claims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new ApiError('REFRESH_INVALID', 'The licence session is incomplete.', 401)
  const [headerPart, payloadPart, signaturePart] = parts
  let header: { alg?: string }
  try {
    header = decodeSegment<{ alg?: string }>(headerPart)
  } catch {
    throw new ApiError('REFRESH_INVALID', 'The licence session is malformed.', 401)
  }
  if (header.alg !== 'ES256') {
    throw new ApiError('REFRESH_INVALID', 'The licence session uses an unsupported algorithm.', 401)
  }

  const configured = Deno.env.get('LICENSE_PUBLIC_JWK')
  const publicJwk = configured
    ? readJwk('LICENSE_PUBLIC_JWK')
    : publicFromPrivate(readJwk('LICENSE_PRIVATE_JWK'))
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
  } catch {
    throw new ApiError('SERVER_ERROR', 'The licence public key is invalid.', 500)
  }

  let valid = false
  try {
    valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlToBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    )
  } catch {
    valid = false
  }
  if (!valid) throw new ApiError('REFRESH_INVALID', 'The licence session signature is invalid.', 401)

  let claims: Claims
  try {
    claims = decodeSegment<Claims>(payloadPart)
  } catch {
    throw new ApiError('REFRESH_INVALID', 'The licence session is malformed.', 401)
  }
  if (
    !claims ||
    typeof claims !== 'object' ||
    claims.iss !== ISSUER ||
    claims.typ !== 'refresh' ||
    typeof claims.dev !== 'string' ||
    typeof claims.lic !== 'string' ||
    !Number.isFinite(claims.exp)
  ) {
    throw new ApiError('REFRESH_INVALID', 'The licence session is not a refresh token.', 401)
  }
  const now = Math.floor(Date.now() / 1000)
  if (claims.exp <= now) {
    throw new ApiError('REFRESH_EXPIRED', 'The licence session has expired.', 401)
  }
  return claims
}

function tokenClaims(license: LicenseRow, deviceCode: string, typ: 'access' | 'refresh'): Claims {
  const now = Math.floor(Date.now() / 1000)
  const licenseExpiry = Math.floor(new Date(license.expires_at).getTime() / 1000)
  const accessExpiry = Math.min(now + license.offline_hours * 3600, licenseExpiry)
  return {
    iss: ISSUER,
    sub: license.id,
    typ,
    dev: deviceCode,
    lic: license.id,
    name: license.business_name,
    maxShops: license.max_shops,
    offlineHours: license.offline_hours,
    lexp: licenseExpiry,
    iat: now,
    exp: typ === 'access' ? accessExpiry : now + REFRESH_DAYS * 86_400,
    v: 1,
  }
}

async function issueTokens(
  license: LicenseRow,
  deviceCode: string,
): Promise<{ accessToken: string; refreshToken: string; serverTime: number }> {
  const accessToken = await signToken(tokenClaims(license, deviceCode, 'access'))
  const refreshToken = await signToken(tokenClaims(license, deviceCode, 'refresh'))
  return { accessToken, refreshToken, serverTime: Date.now() }
}

function licenseInfo(license: LicenseRow) {
  return {
    id: license.id,
    businessName: license.business_name,
    customerName: license.customer_name,
    maxShops: license.max_shops,
    offlineHours: license.offline_hours,
    expiresAt: new Date(license.expires_at).getTime(),
  }
}

async function record(
  supabase: ReturnType<typeof createClient>,
  event: string,
  detail: Json,
  licenseId?: string | null,
  deviceCode?: string | null,
): Promise<void> {
  await supabase
    .from('license_events')
    .insert({
      license_id: licenseId ?? null,
      device_code: deviceCode ?? null,
      event,
      detail,
    })
    .then(() => undefined, () => undefined)
}

async function tooManyAttempts(
  supabase: ReturnType<typeof createClient>,
  deviceCode: string,
  licenseId: string,
): Promise<boolean> {
  if (!deviceCode || !licenseId) return false
  const since = new Date(Date.now() - ATTEMPT_WINDOW_MINUTES * 60_000).toISOString()
  const { count } = await supabase
    .from('license_events')
    .select('id', { count: 'exact', head: true })
    .eq('device_code', deviceCode)
    // Scoped to the licence the caller actually reached. Counting by device
    // alone let anyone with a key of their own lock a stranger's phone out by
    // replaying that key against a device code shown on its activation screen:
    // every denial was recorded, the device was throttled, and the real owner
    // could not check in. A wrong key is not counted at all (it has no licence
    // to scope to, and counting it would allow the same lockout); the key space
    // makes blind guessing impractical.
    .eq('license_id', licenseId)
    .in('event', ['activation_denied', 'check_denied'])
    .gte('created_at', since)
  return typeof count === 'number' && count >= ATTEMPT_LIMIT
}

async function loadLicense(
  supabase: ReturnType<typeof createClient>,
  id: string,
): Promise<LicenseRow | null> {
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new ApiError('SERVER_ERROR', 'Could not read the licence.', 500)
  return (data as LicenseRow | null) ?? null
}

async function loadDevice(
  supabase: ReturnType<typeof createClient>,
  licenseId: string,
  deviceCode: string,
): Promise<DeviceRow | null> {
  const { data, error } = await supabase
    .from('license_devices')
    .select('*')
    .eq('license_id', licenseId)
    .eq('device_code', deviceCode)
    .maybeSingle()
  if (error) throw new ApiError('SERVER_ERROR', 'Could not read the device.', 500)
  return (data as DeviceRow | null) ?? null
}

function assertUsable(license: LicenseRow, device: DeviceRow | null): void {
  if (license.status !== 'active') {
    throw new ApiError('LICENSE_SUSPENDED', 'This licence is suspended.', 403)
  }
  if (new Date(license.expires_at).getTime() <= Date.now()) {
    throw new ApiError('LICENSE_EXPIRED', 'This subscription has ended.', 403)
  }
  if (!device) {
    throw new ApiError('DEVICE_NOT_ALLOWED', 'This device is not on the licence.', 403)
  }
  if (device.status !== 'active') {
    throw new ApiError('DEVICE_REVOKED', 'This device has been removed from the licence.', 403)
  }
}

async function activate(
  supabase: ReturnType<typeof createClient>,
  body: Json,
): Promise<Response> {
  const key = normalizeLicenseKey(body.licenseKey)
  const deviceCode = normalizeDeviceCode(body.deviceCode)
  if (!key || !deviceCode) {
    throw new ApiError('BAD_REQUEST', 'Enter the licence key and device code.', 400)
  }

  const keyHash = await sha256Hex(key)
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('key_hash', keyHash)
    .maybeSingle()
  if (error) throw new ApiError('SERVER_ERROR', 'Could not read the licence.', 500)

  const license = (data as LicenseRow | null) ?? null
  if (!license) {
    // Deliberately not written to the audit table: this endpoint needs no
    // account, so logging every miss would let anyone grow the table without
    // limit. Real denials below still carry a licence id and are logged.
    throw new ApiError('LICENSE_NOT_FOUND', 'That licence key was not found.', 404)
  }

  if (await tooManyAttempts(supabase, deviceCode, license.id)) {
    throw new ApiError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.', 429)
  }

  const device = await loadDevice(supabase, license.id, deviceCode)
  try {
    assertUsable(license, device)
  } catch (error) {
    if (error instanceof ApiError) {
      await record(
        supabase,
        error.code === 'DEVICE_NOT_ALLOWED' || error.code === 'DEVICE_REVOKED'
          ? 'activation_denied'
          : 'check_denied',
        { reason: error.code },
        license.id,
        deviceCode,
      )
    }
    throw error
  }

  // The allow-list is the real limit. This guard catches an admin lowering the
  // cap below the number of devices already present.
  const { count } = await supabase
    .from('license_devices')
    .select('id', { count: 'exact', head: true })
    .eq('license_id', license.id)
    .eq('status', 'active')
  if (typeof count === 'number' && count > license.max_devices) {
    await record(supabase, 'check_denied', { reason: 'device_limit' }, license.id, deviceCode)
    throw new ApiError('DEVICE_LIMIT', 'This licence has reached its device limit.', 403)
  }

  const now = new Date().toISOString()
  await supabase
    .from('license_devices')
    .update({ activated_at: device?.activated_at ?? now, last_seen_at: now })
    .eq('id', device!.id)

  const tokens = await issueTokens(license, deviceCode)
  await record(supabase, 'activated', { appVersion: appVersion(body.appVersion) }, license.id, deviceCode)
  return json({ ok: true, ...tokens, license: licenseInfo(license) })
}

async function heartbeat(
  supabase: ReturnType<typeof createClient>,
  body: Json,
): Promise<Response> {
  const refreshToken = boundedToken(body.refreshToken)
  const deviceCode = normalizeDeviceCode(body.deviceCode)
  if (!refreshToken || !deviceCode) {
    throw new ApiError('BAD_REQUEST', 'The licence session is incomplete.', 400)
  }

  const claims = await verifyToken(refreshToken)
  if (claims.dev !== deviceCode) {
    throw new ApiError('REFRESH_INVALID', 'The licence session belongs to another device.', 401)
  }

  const license = await loadLicense(supabase, claims.lic)
  if (!license) {
    throw new ApiError('LICENSE_NOT_FOUND', 'The licence no longer exists.', 404)
  }
  if (await tooManyAttempts(supabase, deviceCode, license.id)) {
    throw new ApiError('TOO_MANY_ATTEMPTS', 'Too many attempts. Try again later.', 429)
  }
  const device = await loadDevice(supabase, license.id, deviceCode)
  try {
    assertUsable(license, device)
  } catch (error) {
    if (error instanceof ApiError) {
      await record(
        supabase,
        'check_denied',
        { reason: error.code },
        license.id,
        deviceCode,
      )
    }
    throw error
  }

  await supabase
    .from('license_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', device!.id)

  const tokens = await issueTokens(license, deviceCode)
  // A heartbeat every 15 minutes would add ~96 audit rows per device per day,
  // which is noise in the activity feed and grows the free-tier database for no
  // benefit. `last_seen_at` already proves liveness; keep one row every six
  // hours (and always the first one).
  const lastSeen = device?.last_seen_at ? Date.parse(device.last_seen_at) : 0
  const seenRecently = Number.isFinite(lastSeen) && Date.now() - lastSeen < 6 * 60 * 60 * 1000
  if (!seenRecently) {
    await record(supabase, 'checked_in', { appVersion: appVersion(body.appVersion) }, license.id, deviceCode)
  }
  return json({ ok: true, ...tokens, license: licenseInfo(license) })
}

async function deactivate(
  supabase: ReturnType<typeof createClient>,
  body: Json,
): Promise<Response> {
  const refreshToken = boundedToken(body.refreshToken)
  const deviceCode = normalizeDeviceCode(body.deviceCode)
  if (!refreshToken || !deviceCode) {
    throw new ApiError('BAD_REQUEST', 'The licence session is incomplete.', 400)
  }
  const claims = await verifyToken(refreshToken)
  if (claims.dev !== deviceCode) {
    throw new ApiError('REFRESH_INVALID', 'The licence session belongs to another device.', 401)
  }
  const device = await loadDevice(supabase, claims.lic, deviceCode)
  if (device) {
    await supabase
      .from('license_devices')
      .update({ status: 'revoked', revoked_at: new Date().toISOString() })
      .eq('id', device.id)
    await record(supabase, 'deactivated', {}, claims.lic, deviceCode)
  }
  return json({ ok: true })
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (request.method !== 'POST') return fail(new ApiError('BAD_REQUEST', 'Use POST.', 405))

  try {
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceKey) {
      throw new ApiError('SERVER_ERROR', 'The licence database is not configured.', 500)
    }
    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    let body: Json
    try {
      // Read as text so the size can be capped before JSON.parse. Real bodies
      // are a few hundred bytes; the refresh token is the largest field.
      const raw = await request.text()
      if (raw.length > 16_384) throw new Error('too large')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object')
      }
      body = parsed as Json
    } catch {
      throw new ApiError('BAD_REQUEST', 'Send a JSON object.', 400)
    }

    const action = text(body.action).slice(0, 32)
    if (action === 'activate') return await activate(supabase, body)
    if (action === 'heartbeat') return await heartbeat(supabase, body)
    if (action === 'deactivate') return await deactivate(supabase, body)
    if (action === 'ping') {
      // Keeps a free Supabase project from being paused for inactivity. A paused
      // project takes the whole licence server down, so every client would lock
      // out as soon as its offline token expires. JWT verification is on, so
      // this is not an open endpoint.
      const { error } = await supabase
        .from('licenses')
        .select('id', { count: 'exact', head: true })
      if (error) throw new ApiError('SERVER_ERROR', 'Could not reach the licence database.', 500)
      return json({ ok: true, serverTime: Date.now() })
    }
    throw new ApiError('BAD_REQUEST', 'Unknown licence action.', 400)
  } catch (error) {
    if (error instanceof ApiError) return fail(error)
    console.error('licence function failed', error)
    return fail(new ApiError('SERVER_ERROR', 'The licence server could not complete the request.', 500))
  }
})
