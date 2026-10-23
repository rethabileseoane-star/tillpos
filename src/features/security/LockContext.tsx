import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  loadBiometric,
  loadCredential,
  type BiometricRecord,
} from './credentialService'
import { LockScreen } from './LockScreen'
import type { StoredCredential } from './secret'

/**
 * The gate above every route.
 *
 * Boot reads the credential before rendering anything, so a deep link cannot
 * flash the till for a frame. Unlocked state lives only in this component's
 * memory: persisting it to localStorage would make the launch lock pointless.
 *
 * There is no idle or background timer by design. The owner chose "lock on
 * launch", and a PWA can stay alive for days, so Settings offers a manual
 * "Lock now" for shift changes.
 */

type LockStatus = 'checking' | 'locked' | 'unlocked'

interface AppLockValue {
  credential: StoredCredential | null
  biometric: BiometricRecord | null
  status: LockStatus
  /** Called only after a secret or biometric has been verified. */
  unlock: () => void
  lockNow: () => void
  /** Re-read settings after the Security card changes them. */
  refresh: () => Promise<void>
}

const LockContext = createContext<AppLockValue | null>(null)

export function useAppLock(): AppLockValue {
  const value = useContext(LockContext)
  if (!value) throw new Error('useAppLock must be used inside AppLockProvider')
  return value
}

export function AppLockProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LockStatus>('checking')
  const [credential, setCredential] = useState<StoredCredential | null>(null)
  const [biometric, setBiometric] = useState<BiometricRecord | null>(null)

  const read = useCallback(async () => {
    const [cred, bio] = await Promise.all([loadCredential(), loadBiometric()])
    setCredential(cred)
    setBiometric(bio)
    return cred
  }, [])

  useEffect(() => {
    let alive = true
    void read()
      .then((cred) => {
        if (alive) setStatus(cred ? 'locked' : 'unlocked')
      })
      .catch(() => {
        // A storage failure must never brick the till. Opening is the safer
        // failure, and the data is local and unencrypted either way.
        if (alive) setStatus('unlocked')
      })
    return () => {
      alive = false
    }
  }, [read])

  const refresh = useCallback(async () => {
    await read()
  }, [read])

  const unlock = useCallback(() => setStatus('unlocked'), [])

  const lockNow = useCallback(() => {
    setStatus(credential ? 'locked' : 'unlocked')
  }, [credential])

  const value = useMemo<AppLockValue>(
    () => ({ credential, biometric, status, unlock, lockNow, refresh }),
    [credential, biometric, status, unlock, lockNow, refresh],
  )

  return (
    <LockContext.Provider value={value}>
      {status === 'checking' ? (
        <BootSplash />
      ) : status === 'locked' && credential ? (
        <LockScreen credential={credential} biometric={biometric} onUnlock={unlock} />
      ) : (
        children
      )}
    </LockContext.Provider>
  )
}

/** Shown for the few milliseconds the credential read takes. */
function BootSplash() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-900">
      <div className="flex flex-col items-center gap-4">
        <div className="h-12 w-12 animate-pulse rounded-2xl bg-cash-500/80" />
        <p className="text-xs uppercase tracking-[0.3em] text-slate-600">Till</p>
      </div>
    </div>
  )
}
