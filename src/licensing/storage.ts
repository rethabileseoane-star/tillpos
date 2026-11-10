import { generateDeviceCode, normalizeDeviceCode } from './format'

/**
 * Local licence state. Nothing here is trusted: the access and refresh tokens
 * are signed and verified before use. Storage only makes offline operation
 * possible and gives the activation screen a stable device code.
 */
export const LICENSE_DEVICE_KEY = 'till.license.device.v1'
const DEVICE_KEY = LICENSE_DEVICE_KEY
const ACCESS_KEY = 'till.license.access.v1'
const REFRESH_KEY = 'till.license.refresh.v1'
const KEY_KEY = 'till.license.key.v1'
const META_KEY = 'till.license.meta.v1'

let memoryDeviceCode: string | null = null

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // A private-mode browser may refuse storage. The app still works for this
    // session; the licence gate will ask again next launch.
  }
}

export function getDeviceCode(): string {
  if (memoryDeviceCode) return memoryDeviceCode
  const existing = read(DEVICE_KEY)
  if (existing) {
    const normalized = normalizeDeviceCode(existing)
    if (normalized) {
      memoryDeviceCode = normalized
      return normalized
    }
  }
  const code = generateDeviceCode()
  memoryDeviceCode = code
  write(DEVICE_KEY, code)
  return code
}

export interface StoredLicenseTokens {
  accessToken: string | null
  refreshToken: string | null
}

export function loadTokens(): StoredLicenseTokens {
  return {
    accessToken: read(ACCESS_KEY),
    refreshToken: read(REFRESH_KEY),
  }
}

export function saveTokens(accessToken: string, refreshToken: string): void {
  write(ACCESS_KEY, accessToken)
  write(REFRESH_KEY, refreshToken)
}

export function clearTokens(): void {
  write(ACCESS_KEY, null)
  write(REFRESH_KEY, null)
}

/** Saved only so a phone can reactivate after a long offline period or renewal. */
export function loadSavedKey(): string | null {
  return read(KEY_KEY)
}

export function saveKey(key: string): void {
  write(KEY_KEY, key)
}

export function clearSavedKey(): void {
  write(KEY_KEY, null)
}

export interface StoredLicenseMeta {
  lastCheckAt: number | null
  businessName: string | null
  licenseExpiresAt: number | null
}

const EMPTY_META: StoredLicenseMeta = {
  lastCheckAt: null,
  businessName: null,
  licenseExpiresAt: null,
}

export function loadMeta(): StoredLicenseMeta {
  const raw = read(META_KEY)
  if (!raw) return EMPTY_META
  try {
    const value = JSON.parse(raw) as Partial<StoredLicenseMeta>
    return {
      lastCheckAt: typeof value.lastCheckAt === 'number' ? value.lastCheckAt : null,
      businessName: typeof value.businessName === 'string' ? value.businessName : null,
      licenseExpiresAt:
        typeof value.licenseExpiresAt === 'number' ? value.licenseExpiresAt : null,
    }
  } catch {
    return EMPTY_META
  }
}

export function saveMeta(meta: StoredLicenseMeta): void {
  write(META_KEY, JSON.stringify(meta))
}

/** Used by Deactivate this device and the factory reset path. */
export function clearLicenseStorage(): void {
  clearTokens()
  clearSavedKey()
  write(META_KEY, null)
  // Keep DEVICE_KEY: the device is still the same phone. If the owner reactivates
  // it, the seller should not have to add a different code.
}
