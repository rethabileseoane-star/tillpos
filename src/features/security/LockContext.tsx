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
import { runSync } from '@/sync/scheduler'
import { loadBiometric, type BiometricRecord } from './credentialService'
import { LockScreen } from './LockScreen'
import {
  loadStaff,
  sessionFor,
  staffSummaries,
  type StaffAccount,
  type StaffRole,
  type StaffSession,
  type StaffSummary,
} from './staff'

/**
 * The gate above every route.
 *
 * Boot reads the staff roster before rendering anything, so a deep link cannot
 * flash the till for a frame. Unlocked state lives only in this component's
 * memory: persisting it to localStorage would make the launch lock pointless.
 *
 * A legacy device with an app lock but no roster is migrated automatically into
 * an owner account. A device with no lock at all stays unlocked and is treated
 * as the owner, which preserves the old single-user behaviour until the owner
 * sets up staff.
 *
 * There is no idle or background timer by design. The owner chose "lock on
 * launch", and a PWA can stay alive for days, so Settings offers a manual
 * "Lock now" for shift changes.
 */

type LockStatus = 'checking' | 'locked' | 'unlocked'

interface AppLockValue {
  biometric: BiometricRecord | null
  status: LockStatus
  accounts: StaffSummary[]
  session: StaffSession | null
  /** Owner when the till has no staff roster (legacy unlocked mode). */
  role: StaffRole
  isOwner: boolean
  /** Called only after a secret or biometric has been verified. */
  unlock: (account: StaffAccount) => void
  lockNow: () => void
  /** Re-read settings after the Staff card changes them. */
  refresh: () => Promise<void>
}

const LockContext = createContext<AppLockValue | null>(null)

/**
 * Read both halves of the gate without letting a damaged biometric record hide
 * a perfectly good staff roster. `loadBiometric` already treats a malformed
 * value as "no biometrics"; this also covers a storage read that fails outright.
 * A staff failure still propagates so boot can fall back to the safe open mode.
 */
async function readLockState(): Promise<{
  staff: StaffAccount[]
  bio: BiometricRecord | null
}> {
  const staff = await loadStaff()
  let bio: BiometricRecord | null = null
  try {
    bio = await loadBiometric()
  } catch {
    bio = null
  }
  return { staff, bio }
}

export function useAppLock(): AppLockValue {
  const value = useContext(LockContext)
  if (!value) throw new Error('useAppLock must be used inside AppLockProvider')
  return value
}

export function AppLockProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LockStatus>('checking')
  const [accounts, setAccounts] = useState<StaffAccount[]>([])
  const [session, setSession] = useState<StaffSession | null>(null)
  const [biometric, setBiometric] = useState<BiometricRecord | null>(null)
  const statusRef = useRef<LockStatus>('checking')
  statusRef.current = status

  useEffect(() => {
    let alive = true
    void readLockState()
      .then(({ staff, bio }) => {
        if (!alive) return
        setAccounts(staff)
        setBiometric(bio)
        setStatus(staff.length > 0 ? 'locked' : 'unlocked')
      })
      .catch(() => {
        // A storage failure must never brick the till. Opening is the safer
        // failure, and the data is local and unencrypted either way.
        if (alive) setStatus('unlocked')
      })
    return () => {
      alive = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const { staff, bio } = await readLockState()
    setAccounts(staff)
    setBiometric(bio)
    setStatus((current) => {
      if (current === 'unlocked') return 'unlocked'
      return staff.length > 0 ? 'locked' : 'unlocked'
    })
    setSession((current) => {
      if (current) {
        const match = staff.find((a) => a.id === current.id)
        return match ? sessionFor(match) : null
      }
      // The Staff card only runs while the app is unlocked. After it creates
      // the first owner, keep that owner signed in rather than dropping the
      // screen they are working on. A locked boot does not come through here.
      if (statusRef.current === 'unlocked') {
        const owner = staff.find((a) => a.role === 'owner')
        return owner ? sessionFor(owner) : null
      }
      return null
    })
  }, [])

  const unlock = useCallback((account: StaffAccount) => {
    setSession(sessionFor(account))
    setStatus('unlocked')
  }, [])

  const lockNow = useCallback(() => {
    // Best-effort flush of queued sales before the shell unmounts. The sync
    // engine reads IndexedDB directly, so it does not need the screen.
    void runSync().catch(() => undefined)
    setSession(null)
    setStatus(accounts.length > 0 ? 'locked' : 'unlocked')
  }, [accounts.length])

  const summaries = useMemo(() => staffSummaries(accounts), [accounts])
  const role: StaffRole =
    session?.role ?? (accounts.length === 0 ? 'owner' : 'cashier')
  const isOwner = role === 'owner'

  const value = useMemo<AppLockValue>(
    () => ({
      biometric,
      status,
      accounts: summaries,
      session,
      role,
      isOwner,
      unlock,
      lockNow,
      refresh,
    }),
    [biometric, status, summaries, session, role, isOwner, unlock, lockNow, refresh],
  )

  return (
    <LockContext.Provider value={value}>
      {status === 'checking' ? (
        <BootSplash />
      ) : status === 'locked' && accounts.length > 0 ? (
        <LockScreen
          accounts={accounts}
          biometric={biometric}
          onUnlock={unlock}
        />
      ) : (
        children
      )}
    </LockContext.Provider>
  )
}

/** Shown for the few milliseconds the staff read takes. */
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
