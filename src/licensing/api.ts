import { licenseConfig } from './config'

/**
 * Thin client for the seller's Edge Function.
 *
 * The app never has a service-role key. It sends the public anon key with the
 * request, and the function decides whether the licence and device are valid.
 */
export type LicenseApiCode =
  | 'NETWORK'
  | 'BAD_REQUEST'
  | 'LICENSE_NOT_FOUND'
  | 'LICENSE_EXPIRED'
  | 'LICENSE_SUSPENDED'
  | 'LICENSE_REVOKED'
  | 'DEVICE_NOT_ALLOWED'
  | 'DEVICE_LIMIT'
  | 'DEVICE_REVOKED'
  | 'REFRESH_INVALID'
  | 'REFRESH_EXPIRED'
  | 'TOO_MANY_ATTEMPTS'
  | 'NOT_CONFIGURED'
  | 'SERVER_ERROR'

export interface LicenseServerInfo {
  id: string
  businessName: string
  customerName: string | null
  maxShops: number
  offlineHours: number
  expiresAt: number
}

export interface LicenseTokens {
  accessToken: string
  refreshToken: string
  license: LicenseServerInfo
  serverTime: number
}

export type LicenseApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: LicenseApiCode; message: string; status?: number }

interface LicenseErrorBody {
  ok?: boolean
  error?: {
    code?: string
    message?: string
  }
}

const MESSAGES: Record<LicenseApiCode, string> = {
  NETWORK: 'Could not reach the licence server. Check the phone’s internet connection.',
  BAD_REQUEST: 'The licence details are not valid.',
  LICENSE_NOT_FOUND: 'That licence key was not found. Check it and try again.',
  LICENSE_EXPIRED: 'This subscription has ended. Contact your supplier to renew it.',
  LICENSE_SUSPENDED: 'This licence is suspended. Contact your supplier.',
  LICENSE_REVOKED: 'This licence has been cancelled. Contact your supplier.',
  DEVICE_NOT_ALLOWED:
    'This phone is not on the licence. Send the device code below to your supplier.',
  DEVICE_LIMIT: 'This licence has reached its device limit.',
  DEVICE_REVOKED: 'This device has been removed from the licence.',
  REFRESH_INVALID: 'The licence session is no longer valid. Activate this device again.',
  REFRESH_EXPIRED: 'The licence session has expired. Activate this device again.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Wait a few minutes and try again.',
  NOT_CONFIGURED: 'The licence server is not configured in this build.',
  SERVER_ERROR: 'The licence server returned an error. Try again shortly.',
}

function isApiCode(value: string | undefined): value is LicenseApiCode {
  return Boolean(value && value in MESSAGES)
}

function fromServerMessage(code: LicenseApiCode, message: string | undefined): string {
  // Keep the server's concrete wording when it is useful, but never show a raw
  // stack trace or database error.
  if (message && message.length <= 240) return message
  return MESSAGES[code]
}

async function callLicenseServer<T>(
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<LicenseApiResult<T>> {
  if (!licenseConfig.url || !licenseConfig.anonKey) {
    return { ok: false, code: 'NOT_CONFIGURED', message: MESSAGES.NOT_CONFIGURED }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(
      `${licenseConfig.url}/functions/v1/${licenseConfig.functionName}`,
      {
        method: 'POST',
        headers: {
          apikey: licenseConfig.anonKey,
          Authorization: `Bearer ${licenseConfig.anonKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    )

    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok) {
      const errorBody = (payload ?? {}) as LicenseErrorBody
      const rawCode = errorBody.error?.code
      const code: LicenseApiCode = isApiCode(rawCode) ? rawCode : 'SERVER_ERROR'
      return {
        ok: false,
        code,
        message: fromServerMessage(code, errorBody.error?.message),
        status: response.status,
      }
    }

    if (!payload || typeof payload !== 'object') {
      return { ok: false, code: 'SERVER_ERROR', message: MESSAGES.SERVER_ERROR }
    }
    return { ok: true, data: payload as T }
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    return {
      ok: false,
      code: 'NETWORK',
      message: aborted
        ? 'The licence server took too long to answer. Check the connection and try again.'
        : MESSAGES.NETWORK,
    }
  } finally {
    clearTimeout(timer)
  }
}

export function activateLicense(input: {
  licenseKey: string
  deviceCode: string
  deviceLabel?: string
  appVersion?: string
}): Promise<LicenseApiResult<LicenseTokens>> {
  return callLicenseServer<LicenseTokens>({
    action: 'activate',
    ...input,
  })
}

export function heartbeatLicense(input: {
  refreshToken: string
  deviceCode: string
  appVersion?: string
}): Promise<LicenseApiResult<LicenseTokens>> {
  return callLicenseServer<LicenseTokens>({
    action: 'heartbeat',
    ...input,
  })
}

export function deactivateLicense(input: {
  refreshToken: string
  deviceCode: string
}): Promise<LicenseApiResult<{ ok: true }>> {
  return callLicenseServer<{ ok: true }>({
    action: 'deactivate',
    ...input,
  })
}
