import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { activateLicense, deactivateLicense, heartbeatLicense } from './api'
import { licenseConfig } from './config'
import { getDeviceCode } from './storage'
import {
  clearLicenseStorage,
  clearTokens,
  loadMeta,
  loadSavedKey,
  loadTokens,
  saveKey,
  saveMeta,
  saveTokens,
} from './storage'
import {
  LicenseTokenError,
  licenseExpiresAt,
  tokenExpiresAt,
  verifyLicenseToken,
  type LicenseClaims,
} from './token'

/**
 * The subscription gate above the till.
 *
 * A valid access token lets the app run offline for the licence's
 * `offline_hours` (24 by default). While online, the provider refreshes the
 * token on startup, when the phone comes back online, when the app returns to
 * the foreground, and every 15 minutes. A successful check replaces both
 * tokens. If the access token expires while offline, the till locks until the
 * server can be reached.
 *
 * Server rejection is different from a network failure:
 *  - network failure  -> keep using the current access token until it expires;
 *  - revoked/removed  -> clear the session and lock immediately;
 *  - subscription end -> lock, but keep the refresh token so renewing the
 *                        licence unlocks automatically at the next check.
 */
export type LicenseStatus = 'checking' | 'activation' | 'locked' | 'valid'

export interface LicenseValue {
  status: LicenseStatus
  claims: LicenseClaims | null
  deviceCode: string
  businessName: string | null
  lastCheckAt: number | null
  accessExpiresAt: number | null
  licenseExpiresAt: number | null
  remainingMs: number | null
  licenseRemainingMs: number | null
  online: boolean
  busy: boolean
  error: string | null
  activate: (key: string) => Promise<{ ok: boolean; error?: string }>
  checkNow: () => Promise<void>
  deactivate: () => Promise<{ ok: boolean; error?: string }>
  showActivation: () => void
}

const LicenseContext = createContext<LicenseValue | null>(null)

const HEARTBEAT_MS = 15 * 60 * 1000
const BOOTSTRAP_RETRY_MS = 1_000

function messageForTokenError(error: unknown): string {
  if (!(error instanceof LicenseTokenError)) return 'The licence token is not valid.'
  switch (error.code) {
    case 'TOKEN_EXPIRED':
      return 'The offline licence period has ended. Connect to the internet to check in.'
    case 'TOKEN_LICENSE_EXPIRED':
      return 'The subscription has ended. Contact your supplier to renew it.'
    case 'TOKEN_DEVICE':
      return 'This licence belongs to another device. Activate this phone again.'
    case 'TOKEN_SIGNATURE':
    case 'TOKEN_MALFORMED':
    case 'TOKEN_ISSUER':
    case 'TOKEN_TYPE':
    case 'TOKEN_KEY':
      return 'The stored licence is not valid. Activate this device again.'
    default:
      return 'The licence could not be checked.'
  }
}

function tokenErrorCode(error: unknown): string | null {
  return error instanceof LicenseTokenError ? error.code : null
}

export function useLicense(): LicenseValue {
  const value = useContext(LicenseContext)
  if (!value) throw new Error('useLicense must be used inside LicenseProvider')
  return value
}

export function LicenseProvider({ children }: { children: ReactNode }) {
  const [deviceCode] = useState(getDeviceCode)
  const [status, setStatusState] = useState<LicenseStatus>('checking')
  const [claims, setClaimsState] = useState<LicenseClaims | null>(null)
  const [lastCheckAt, setLastCheckAt] = useState<number | null>(null)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nowTick, setNowTick] = useState(Date.now())

  const statusRef = useRef<LicenseStatus>('checking')
  const claimsRef = useRef<LicenseClaims | null>(null)
  const tokensRef = useRef<{ accessToken: string | null; refreshToken: string | null }>({
    accessToken: null,
    refreshToken: null,
  })
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const expiryTimerRef = useRef<number | null>(null)
  const checkRef = useRef<(() => Promise<void>) | null>(null)
  const scheduleExpiryRef = useRef<((nextClaims: LicenseClaims) => void) | null>(null)

  const setStatus = useCallback((next: LicenseStatus) => {
    statusRef.current = next
    if (mountedRef.current) setStatusState(next)
  }, [])

  const setClaims = useCallback((next: LicenseClaims | null) => {
    claimsRef.current = next
    if (mountedRef.current) setClaimsState(next)
  }, [])

  const clearExpiryTimer = useCallback(() => {
    if (expiryTimerRef.current !== null) {
      window.clearTimeout(expiryTimerRef.current)
      expiryTimerRef.current = null
    }
  }, [])

  const lock = useCallback(
    (message: string, options?: { clearSession?: boolean; keepError?: boolean }) => {
      clearExpiryTimer()
      if (options?.clearSession) {
        clearTokens()
        tokensRef.current = { accessToken: null, refreshToken: null }
      }
      setClaims(null)
      setStatus('locked')
      setError(message)
      setBusy(false)
      busyRef.current = false
    },
    [clearExpiryTimer, setClaims, setStatus],
  )

  const scheduleExpiry = useCallback(
    (nextClaims: LicenseClaims) => {
      clearExpiryTimer()
      const remaining = tokenExpiresAt(nextClaims) - Date.now()
      // Browser timers overflow above roughly 24.8 days. Check in chunks so an
      // admin who raises offline_hours to 30 days cannot make the timer fire
      // immediately (which would lock a healthy till).
      const delay = Math.min(Math.max(0, remaining) + 500, 12 * 60 * 60 * 1000)
      expiryTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current) return
        if (tokenExpiresAt(nextClaims) > Date.now()) {
          scheduleExpiryRef.current?.(nextClaims)
          return
        }
        lock('The offline licence period ended. Connect to the internet to check in.')
        void checkRef.current?.()
      }, delay)
    },
    [clearExpiryTimer, lock],
  )
  scheduleExpiryRef.current = scheduleExpiry

  const applyTokens = useCallback(
    async (accessToken: string, refreshToken: string) => {
      // A server response is still verified locally. This catches a wrong key,
      // a response for another device, or a proxy that mangled the body.
      const accessClaims = await verifyLicenseToken(accessToken, licenseConfig.publicKey, {
        expectedDevice: deviceCode,
        expectedType: 'access',
      })
      await verifyLicenseToken(refreshToken, licenseConfig.publicKey, {
        expectedDevice: deviceCode,
        expectedType: 'refresh',
      })

      saveTokens(accessToken, refreshToken)
      tokensRef.current = { accessToken, refreshToken }
      const checkedAt = Date.now()
      saveMeta({
        lastCheckAt: checkedAt,
        businessName: accessClaims.name,
        licenseExpiresAt: accessClaims.lexp * 1000,
      })

      if (!mountedRef.current) return
      setClaims(accessClaims)
      setStatus('valid')
      setLastCheckAt(checkedAt)
      setError(null)
      setBusy(false)
      busyRef.current = false
      scheduleExpiry(accessClaims)
    },
    [deviceCode, scheduleExpiry, setClaims, setStatus],
  )

  const recover = useCallback(async () => {
    if (busyRef.current || !mountedRef.current) return
    const { refreshToken } = tokensRef.current
    const savedKey = loadSavedKey()

    if (!refreshToken && !savedKey) {
      setStatus('activation')
      setBusy(false)
      busyRef.current = false
      return
    }

    busyRef.current = true
    setBusy(true)
    if (statusRef.current !== 'valid') setStatus('checking')
    setError(null)

    const result = refreshToken
      ? await heartbeatLicense({
          refreshToken,
          deviceCode,
          appVersion: __BUILD_ID__,
        })
      : await activateLicense({
          licenseKey: savedKey!,
          deviceCode,
          appVersion: __BUILD_ID__,
        })

    if (!mountedRef.current) return

    if (result.ok) {
      try {
        await applyTokens(result.data.accessToken, result.data.refreshToken)
      } catch (err) {
        lock(messageForTokenError(err))
      }
      return
    }

    const network = result.code === 'NETWORK' || result.code === 'SERVER_ERROR'
    if (network) {
      setOnline(false)
      const current = claimsRef.current
      if (statusRef.current === 'valid' && current && tokenExpiresAt(current) > Date.now()) {
        // A dropped connection must not stop a shop that still has offline time.
        setBusy(false)
        busyRef.current = false
        return
      }
      lock(result.message)
      return
    }

    setOnline(true)
    if (result.code === 'LICENSE_EXPIRED' || result.code === 'LICENSE_SUSPENDED') {
      // Keep the refresh token: when the seller renews or reactivates, the next
      // check can unlock the till without asking the shopkeeper to retype a key.
      lock(result.message)
      return
    }

    if (
      result.code === 'REFRESH_EXPIRED' ||
      result.code === 'REFRESH_INVALID' ||
      result.code === 'DEVICE_NOT_ALLOWED' ||
      result.code === 'DEVICE_REVOKED' ||
      result.code === 'LICENSE_REVOKED'
    ) {
      // The saved key lets the seller re-add a device and the app recover on a
      // later retry, but a copied install still has a different device code.
      lock(result.message, { clearSession: true })
      return
    }

    if (result.code === 'TOO_MANY_ATTEMPTS') {
      lock(result.message)
      return
    }

    lock(result.message)
  }, [applyTokens, deviceCode, lock, setStatus])

  const checkNow = useCallback(async () => {
    await recover()
  }, [recover])
  checkRef.current = checkNow

  const activate = useCallback(
    async (key: string) => {
      const trimmed = key.trim()
      if (!trimmed) {
        setError('Enter the licence key.')
        setStatus('activation')
        return { ok: false, error: 'Enter the licence key.' }
      }
      if (busyRef.current) return { ok: false, error: 'A check is already running.' }

      busyRef.current = true
      setBusy(true)
      setError(null)
      setStatus('activation')
      const result = await activateLicense({
        licenseKey: trimmed,
        deviceCode,
        appVersion: __BUILD_ID__,
      })
      if (!mountedRef.current) return { ok: false }

      if (!result.ok) {
        setBusy(false)
        busyRef.current = false
        setError(result.message)
        setStatus('activation')
        if (result.code === 'NETWORK') setOnline(false)
        else setOnline(true)
        return { ok: false, error: result.message }
      }

      try {
        await applyTokens(result.data.accessToken, result.data.refreshToken)
        saveKey(trimmed)
        return { ok: true }
      } catch (err) {
        const message = messageForTokenError(err)
        setBusy(false)
        busyRef.current = false
        setError(message)
        setStatus('activation')
        return { ok: false, error: message }
      }
    },
    [applyTokens, deviceCode, setStatus],
  )

  const deactivate = useCallback(async () => {
    const { refreshToken } = tokensRef.current
    if (!refreshToken) {
      clearLicenseStorage()
      setClaims(null)
      setStatus('activation')
      setError('This device has been removed from the licence.')
      return { ok: true }
    }
    if (busyRef.current) return { ok: false, error: 'A check is already running.' }

    busyRef.current = true
    setBusy(true)
    const result = await deactivateLicense({ refreshToken, deviceCode })
    if (!mountedRef.current) return { ok: false }

    if (!result.ok) {
      setBusy(false)
      busyRef.current = false
      setError(result.message)
      return { ok: false, error: result.message }
    }

    clearLicenseStorage()
    tokensRef.current = { accessToken: null, refreshToken: null }
    setClaims(null)
    setStatus('activation')
    setError('This device has been removed from the licence. Your data is still on the phone.')
    setBusy(false)
    busyRef.current = false
    return { ok: true }
  }, [deviceCode, setClaims, setStatus])

  const showActivation = useCallback(() => {
    clearExpiryTimer()
    setStatus('activation')
    setError(null)
  }, [clearExpiryTimer, setStatus])

  // Boot: use a valid access token immediately, otherwise try the refresh token
  // (or the saved key after a renewal) before deciding to lock.
  useEffect(() => {
    mountedRef.current = true
    const saved = loadTokens()
    const meta = loadMeta()
    tokensRef.current = saved
    setLastCheckAt(meta.lastCheckAt)

    void (async () => {
      if (saved.accessToken) {
        try {
          const next = await verifyLicenseToken(saved.accessToken, licenseConfig.publicKey, {
            expectedDevice: deviceCode,
            expectedType: 'access',
          })
          if (!mountedRef.current) return
          setClaims(next)
          setStatus('valid')
          scheduleExpiry(next)
          if (navigator.onLine) {
            // Refresh in the background; a failure leaves the valid token alone.
            window.setTimeout(() => void checkRef.current?.(), BOOTSTRAP_RETRY_MS)
          }
          return
        } catch (err) {
          const code = tokenErrorCode(err)
          if (code === 'TOKEN_LICENSE_EXPIRED' || code === 'TOKEN_EXPIRED') {
            // The access token has run out, but the refresh token may still be
            // good. Let the server decide; if the subscription was extended,
            // this recovers without retyping the key.
            if (!navigator.onLine) {
              lock('Connect this phone to the internet to verify the licence.')
              return
            }
            setStatus('checking')
            void checkRef.current?.()
            return
          }
          // Tampered, malformed or another device's token: do not open the till.
          clearTokens()
          tokensRef.current = { accessToken: null, refreshToken: saved.refreshToken }
        }
      }

      if (saved.refreshToken || loadSavedKey()) {
        setStatus(navigator.onLine ? 'checking' : 'locked')
        if (navigator.onLine) {
          void checkRef.current?.()
        } else if (saved.refreshToken) {
          lock('Connect this phone to the internet to verify the licence.')
        } else {
          lock('Connect this phone to the internet to activate the saved licence.')
        }
        return
      }

      setStatus('activation')
    })()

    return () => {
      mountedRef.current = false
      clearExpiryTimer()
    }
  }, [clearExpiryTimer, deviceCode, lock, scheduleExpiry, setClaims, setStatus])

  // Refresh in the background as soon as connectivity returns.
  useEffect(() => {
    const onOnline = () => {
      setOnline(true)
      void checkRef.current?.()
    }
    const onOffline = () => setOnline(false)
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      setOnline(navigator.onLine)
      if (navigator.onLine) void checkRef.current?.()
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisible)
    const interval = window.setInterval(() => {
      if (navigator.onLine) void checkRef.current?.()
    }, HEARTBEAT_MS)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearInterval(interval)
    }
  }, [])

  // Cheap tick so the Settings card and warning strip can show a countdown.
  useEffect(() => {
    const interval = window.setInterval(() => setNowTick(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])

  const value = useMemo<LicenseValue>(() => {
    const accessExpiresAt = claims ? tokenExpiresAt(claims) : null
    const licenseEndsAt = claims ? licenseExpiresAt(claims) : null
    return {
      status,
      claims,
      deviceCode,
      businessName: claims?.name ?? loadMeta().businessName,
      lastCheckAt,
      accessExpiresAt,
      licenseExpiresAt: licenseEndsAt,
      remainingMs: accessExpiresAt === null ? null : Math.max(0, accessExpiresAt - nowTick),
      licenseRemainingMs: licenseEndsAt === null ? null : Math.max(0, licenseEndsAt - nowTick),
      online,
      busy,
      error,
      activate,
      checkNow,
      deactivate,
      showActivation,
    }
  }, [
    activate,
    busy,
    checkNow,
    claims,
    deactivate,
    deviceCode,
    error,
    lastCheckAt,
    nowTick,
    online,
    showActivation,
    status,
  ])

  return <LicenseContext.Provider value={value}>{children}</LicenseContext.Provider>
}
