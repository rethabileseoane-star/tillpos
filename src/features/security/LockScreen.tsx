import { useEffect, useState } from 'react'
import { loadShopName } from '@/features/settings/shopName'
import { feedbackError, feedbackSuccess } from '@/ui/feedback'
import { unlockWithBiometric } from './biometric'
import type { BiometricRecord } from './credentialService'
import { RecoverySheet } from './RecoverySheet'
import {
  PIN_MAX,
  PIN_MIN,
  clearAttempts,
  cooldownRemaining,
  readAttempts,
  recordFailure,
  verifySecret,
  type AttemptState,
  type StoredCredential,
} from './secret'

/**
 * Full-screen gate. Nothing from the till is mounted while this is visible.
 *
 * A wrong secret is refused without saying whether the length or kind was
 * close, and five failures in a row earn a cooldown persisted across reloads.
 * The biometric button is only an accelerator: it never replaces the PIN or
 * password, so a reset authenticator cannot lock the owner out for good.
 */
export function LockScreen({
  credential,
  biometric,
  onUnlock,
}: {
  credential: StoredCredential
  biometric: BiometricRecord | null
  onUnlock: () => void
}) {
  const [shop, setShop] = useState('')
  const [pin, setPin] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shake, setShake] = useState(0)
  const [attempts, setAttempts] = useState<AttemptState>(() => readAttempts())
  const [clock, setClock] = useState(() => Date.now())
  const [recoveryOpen, setRecoveryOpen] = useState(false)

  const isPin = credential.kind === 'pin'
  const pinLength =
    credential.length >= PIN_MIN && credential.length <= PIN_MAX
      ? credential.length
      : PIN_MIN
  const remaining = cooldownRemaining(attempts, clock)
  const cooling = remaining > 0
  const locked = busy || cooling

  useEffect(() => {
    // Cosmetic only: a missing shop name must not disturb the lock screen.
    void loadShopName()
      .then(setShop)
      .catch(() => undefined)
  }, [])

  // Tick only while a cooldown is running.
  useEffect(() => {
    if (!cooling) return
    const id = setInterval(() => setClock(Date.now()), 500)
    return () => clearInterval(id)
  }, [cooling, attempts])

  // Clear the failure message once the wait is over.
  useEffect(() => {
    if (!cooling) return
    return () => setError(null)
  }, [cooling])

  const submit = async (secret: string) => {
    if (busy || cooling) return
    setBusy(true)
    setError(null)
    const ok = await verifySecret(credential, secret)
    setBusy(false)

    if (ok) {
      clearAttempts()
      feedbackSuccess()
      onUnlock()
      return
    }

    const next = recordFailure()
    setAttempts(next)
    setClock(Date.now())
    setPin('')
    setPassword('')
    setShake((n) => n + 1)
    feedbackError()
    setError('Incorrect. Try again.')
  }

  // PIN entry submits itself at the stored length. `pin` is the only trigger
  // needed: `submit` reads the current render's state.
  useEffect(() => {
    if (!isPin || pin.length !== pinLength) return
    if (locked) return
    void submit(pin)
  }, [pin])

  const pressDigit = (digit: string) => {
    if (locked) return
    setError(null)
    setPin((current) => (current.length >= pinLength ? current : current + digit))
  }

  const backspace = () => {
    if (locked) return
    setError(null)
    setPin((current) => current.slice(0, -1))
  }

  const tryBiometric = async () => {
    if (!biometric || locked) return
    setBusy(true)
    setError(null)
    const result = await unlockWithBiometric(biometric)
    setBusy(false)
    if (result.ok) {
      clearAttempts()
      feedbackSuccess()
      onUnlock()
      return
    }
    feedbackError()
    if (result.reason !== 'cancelled') setError(result.message)
  }

  return (
    <div className="flex min-h-dvh flex-col bg-ink-900 px-5 py-8">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center">
        <header className="flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-cash-500/15 text-cash-400">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-7 w-7">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 118 0v3" />
            </svg>
          </div>
          {shop && (
            <p className="mt-4 text-[10px] uppercase tracking-[0.25em] text-slate-500">{shop}</p>
          )}
          <h1 className="mt-2 text-xl font-bold">Till locked</h1>
          <p className="mt-1 text-sm text-slate-400">
            {isPin
              ? 'Enter your PIN to open the till.'
              : 'Enter your password to open the till.'}
          </p>
        </header>

        <div className="mt-6">
          {isPin ? (
            <div key={shake} className={shake > 0 ? 'animate-shake' : undefined}>
              <div
                className="flex justify-center gap-2.5"
                role="status"
                aria-label={`${pin.length} of ${pinLength} digits entered`}
              >
                {Array.from({ length: pinLength }, (_, i) => (
                  <span
                    key={i}
                    className={`h-3.5 w-3.5 rounded-full border transition ${
                      i < pin.length
                        ? 'border-cash-500 bg-cash-500'
                        : 'border-ink-500 bg-transparent'
                    }`}
                  />
                ))}
              </div>

              <div className="keypad mx-auto mt-6 max-w-xs">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                  <button
                    key={digit}
                    type="button"
                    disabled={locked}
                    onClick={() => pressDigit(digit)}
                  >
                    {digit}
                  </button>
                ))}
                <span aria-hidden />
                <button type="button" disabled={locked} onClick={() => pressDigit('0')}>
                  0
                </button>
                <button
                  type="button"
                  disabled={locked || pin.length === 0}
                  onClick={backspace}
                  aria-label="Delete last digit"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-6 w-6">
                    <path d="M20 6H9l-6 6 6 6h11a1 1 0 001-1V7a1 1 0 00-1-1z" />
                    <path d="M13 10l4 4m0-4l-4 4" />
                  </svg>
                </button>
              </div>
            </div>
          ) : (
            <form
              key={shake}
              className={shake > 0 ? 'animate-shake' : undefined}
              onSubmit={(e) => {
                e.preventDefault()
                void submit(password)
              }}
            >
              <div className="relative">
                <input
                  className="field pr-16 text-center"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value)
                    setError(null)
                  }}
                  autoFocus
                  autoComplete="off"
                  enterKeyHint="go"
                  placeholder="Password"
                  aria-label="Password"
                  disabled={locked}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2 py-1 text-xs text-slate-400 active:bg-ink-700"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              <button
                type="submit"
                className="btn-primary mt-3 w-full"
                disabled={locked || password.length === 0}
              >
                {busy ? 'Checking…' : 'Unlock'}
              </button>
            </form>
          )}

          <div className="mt-4 min-h-[3rem]" aria-live="polite">
            {cooling ? (
              <p className="rounded-xl bg-red-500/10 px-3 py-2 text-center text-xs leading-relaxed text-red-200">
                Too many attempts. Try again in {formatDelay(remaining)}.
              </p>
            ) : error ? (
              <p className="rounded-xl bg-red-500/10 px-3 py-2 text-center text-xs leading-relaxed text-red-200">
                {error}
              </p>
            ) : null}
          </div>

          {biometric && (
            <button
              type="button"
              disabled={locked}
              onClick={() => void tryBiometric()}
              className="btn-ghost mt-1 w-full !py-2.5 text-sm"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
                <path d="M12 10a2 2 0 00-2 2c0 1.02-.1 2.51-.26 4" />
                <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
                <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
                <path d="M2 12a10 10 0 0118-6" />
                <path d="M2 16h.01" />
                <path d="M21.8 16c.2-2 .131-5.354 0-6" />
                <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 01.34-2" />
                <path d="M8.65 22c.21-.66.45-1.32.57-2" />
                <path d="M9 6.8a6 6 0 019 5.2v2" />
              </svg>
              Unlock with fingerprint or face
            </button>
          )}
        </div>

        <div className="mt-8 text-center">
          <button
            type="button"
            onClick={() => setRecoveryOpen(true)}
            className="text-xs text-slate-500 underline underline-offset-2"
          >
            Forgot {isPin ? 'PIN' : 'password'}?
          </button>
        </div>
      </div>

      {recoveryOpen && (
        <RecoverySheet kind={credential.kind} onClose={() => setRecoveryOpen(false)} />
      )}
    </div>
  )
}

function formatDelay(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return minutes > 0 ? `${minutes}:${seconds}` : `${seconds}s`
}
