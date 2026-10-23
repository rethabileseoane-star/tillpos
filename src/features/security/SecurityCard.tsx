import { useEffect, useState, type ReactNode } from 'react'
import { feedbackError, feedbackSuccess } from '@/ui/feedback'
import {
  biometricSupportNote,
  biometricsSupported,
  enrollBiometric,
  platformAuthenticatorAvailable,
} from './biometric'
import {
  removeBiometric,
  removeCredential,
  saveBiometric,
  saveCredential,
} from './credentialService'
import { useAppLock } from './LockContext'
import {
  PASSWORD_MIN,
  PIN_MAX,
  PIN_MIN,
  validateSecret,
  verifySecret,
  type SecretKind,
  type StoredCredential,
} from './secret'

type Mode = 'setup' | 'change' | 'disable'

interface CardMessage {
  text: string
  error?: boolean
}

/**
 * Settings → App lock.
 *
 * Changing or turning off the lock asks for the current secret so a cashier
 * with a momentarily open till cannot remove it. Adding or removing biometrics
 * does not: it only ever removes a convenience factor, and the PIN/password
 * stays in force.
 */
export function SecurityCard() {
  const { credential, biometric, refresh, lockNow } = useAppLock()
  const [mode, setMode] = useState<Mode | null>(null)
  const [message, setMessage] = useState<CardMessage | null>(null)
  const [busy, setBusy] = useState(false)
  const [authenticator, setAuthenticator] = useState(false)

  const supportNote = biometricSupportNote()
  const canUseBiometric = biometricsSupported()

  useEffect(() => {
    if (!canUseBiometric) return
    let alive = true
    void platformAuthenticatorAvailable().then((available) => {
      if (alive) setAuthenticator(available)
    })
    return () => {
      alive = false
    }
  }, [canUseBiometric])

  const toggleBiometric = async () => {
    setBusy(true)
    setMessage(null)
    try {
      if (biometric) {
        await removeBiometric()
        await refresh()
        setMessage({ text: 'Biometric unlock turned off. Your PIN or password still works.' })
        return
      }
      const result = await enrollBiometric()
      if (!result.ok) {
        feedbackError()
        setMessage({ text: result.message, error: true })
        return
      }
      await saveBiometric(result.record)
      await refresh()
      feedbackSuccess()
      setMessage({ text: 'Biometric unlock is on for this device.' })
    } catch (err) {
      feedbackError()
      setMessage({
        text: err instanceof Error ? err.message : 'Could not change biometric unlock.',
        error: true,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card mt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">App lock</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            {credential
              ? `On — ${
                  credential.kind === 'pin'
                    ? `PIN, ${credential.length} digits`
                    : 'password'
                }. Asked for when the app is launched or reloaded.`
              : 'Off — anyone who opens this app can use the till.'}
          </p>
        </div>
        <span
          className={`chip ${
            credential ? 'bg-cash-500/15 text-cash-400' : 'bg-ink-700 text-slate-400'
          }`}
        >
          {credential ? 'On' : 'Off'}
        </span>
      </div>

      {!credential ? (
        <button
          className="btn-primary mt-3 w-full !py-2.5 text-sm"
          onClick={() => {
            setMessage(null)
            setMode('setup')
          }}
        >
          Set up app lock
        </button>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            className="btn-ghost !py-2.5 text-sm"
            onClick={() => {
              setMessage(null)
              setMode('change')
            }}
          >
            Change
          </button>
          <button
            className="btn-ghost !py-2.5 text-sm"
            onClick={() => {
              setMessage(null)
              setMode('disable')
            }}
          >
            Turn off
          </button>
          <button className="btn-ghost !py-2.5 text-sm" onClick={lockNow}>
            Lock now
          </button>
          <button
            className="btn-ghost !py-2.5 text-sm"
            disabled={busy || (!canUseBiometric && !biometric) || (!authenticator && !biometric)}
            onClick={() => void toggleBiometric()}
          >
            {biometric ? 'Remove biometrics' : 'Add biometrics'}
          </button>
        </div>
      )}

      {biometric && (
        <p className="mt-2 text-[11px] leading-relaxed text-cash-400">
          Fingerprint or face unlock is on for this device. The PIN or password
          still works if it cannot read you.
        </p>
      )}

      {supportNote && (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{supportNote}</p>
      )}
      {!supportNote && !biometric && !authenticator && (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          No fingerprint or face is enrolled in this device's settings yet.
        </p>
      )}

      {message && (
        <p
          className={`mt-2 rounded-xl px-3 py-2 text-[11px] leading-relaxed ${
            message.error ? 'bg-red-500/10 text-red-200' : 'bg-cash-500/10 text-cash-400'
          }`}
        >
          {message.text}
        </p>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        This locks the screen; it does not encrypt the records already stored on
        this device. Use “Lock now” before leaving the counter.
      </p>

      {mode && (
        <SecretSheet
          mode={mode}
          credential={credential}
          refresh={refresh}
          onClose={() => setMode(null)}
          onSaved={(text) => setMessage({ text })}
        />
      )}
    </div>
  )
}

function SecretSheet({
  mode,
  credential,
  refresh,
  onClose,
  onSaved,
}: {
  mode: Mode
  credential: StoredCredential | null
  refresh: () => Promise<void>
  onClose: () => void
  onSaved: (message: string) => void
}) {
  const [kind, setKind] = useState<SecretKind>(credential?.kind ?? 'pin')
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const title =
    mode === 'setup' ? 'Set up app lock' : mode === 'change' ? 'Change app lock' : 'Turn off app lock'
  const subtitle =
    mode === 'setup'
      ? 'Choose a PIN for speed or a password for strength. You can add fingerprint or face unlock afterwards.'
      : mode === 'change'
        ? 'Enter the current secret, then choose a new one. Biometric unlock will need to be added again.'
        : 'Enter the current secret to remove the lock. The till will open without a password.'
  const needsCurrent = mode !== 'setup'
  const needsNew = mode !== 'disable'
  const newIsPin = kind === 'pin'

  const canSave =
    !busy &&
    (!needsCurrent || current.length > 0) &&
    (!needsNew || (next.length > 0 && confirm.length > 0))

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      if (needsCurrent) {
        const ok = credential ? await verifySecret(credential, current) : false
        if (!ok) {
          setError(
            `That is not the current ${
              credential?.kind === 'pin' ? 'PIN' : 'password'
            }.`,
          )
          return
        }
      }
      if (mode === 'disable') {
        await removeCredential()
        await refresh()
        onSaved('App lock turned off. The till now opens without a secret.')
        onClose()
        return
      }
      const problem = validateSecret(kind, next)
      if (problem) {
        setError(problem)
        return
      }
      if (next !== confirm) {
        setError('The two entries do not match.')
        return
      }
      await saveCredential(kind, next)
      await refresh()
      feedbackSuccess()
      onSaved(
        mode === 'setup'
          ? 'App lock is on. It will be asked for next time the till opens.'
          : 'Secret changed. Biometric unlock was turned off — add it again if you use it.',
      )
      onClose()
    } catch (err) {
      feedbackError()
      setError(err instanceof Error ? err.message : 'Could not save the lock.')
    } finally {
      setBusy(false)
    }
  }

  const fieldFor = (
    id: string,
    value: string,
    onChange: (value: string) => void,
    label: string,
    autoFocus = false,
  ) => (
    <input
      id={id}
      className={`field ${newIsPin ? 'text-center font-mono !text-xl tracking-[0.35em]' : ''}`}
      type="password"
      inputMode={newIsPin ? 'numeric' : 'text'}
      pattern={newIsPin ? '[0-9]*' : undefined}
      maxLength={newIsPin ? PIN_MAX : undefined}
      autoComplete="new-password"
      value={value}
      onChange={(e) =>
        onChange(newIsPin ? e.target.value.replace(/\D/g, '') : e.target.value)
      }
      aria-label={label}
      placeholder={newIsPin ? '••••' : 'At least 8 characters'}
      autoFocus={autoFocus}
    />
  )

  return (
    <Sheet title={title} subtitle={subtitle} onClose={onClose}>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {needsNew && (
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-ink-700 p-1">
            {(['pin', 'password'] as SecretKind[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setKind(option)
                  setNext('')
                  setConfirm('')
                  setError(null)
                }}
                className={`rounded-lg px-2 py-2 text-xs font-semibold ${
                  kind === option ? 'bg-ink-600 text-cash-400' : 'text-slate-400'
                }`}
              >
                {option === 'pin' ? 'PIN' : 'Password'}
                <span className="block text-[10px] font-normal text-slate-500">
                  {option === 'pin'
                    ? `${PIN_MIN}–${PIN_MAX} digits`
                    : `${PASSWORD_MIN}+ characters`}
                </span>
              </button>
            ))}
          </div>
        )}

        {needsCurrent && (
          <div>
            <label className="label" htmlFor="lock-current">
              Current {credential?.kind === 'pin' ? 'PIN' : 'password'}
            </label>
            <input
              id="lock-current"
              className="field text-center font-mono tracking-[0.2em]"
              type="password"
              inputMode={credential?.kind === 'pin' ? 'numeric' : 'text'}
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                setError(null)
              }}
              autoFocus
              autoComplete="off"
              enterKeyHint={needsNew ? 'next' : 'done'}
            />
          </div>
        )}

        {needsNew && (
          <>
            <div>
              <label className="label" htmlFor="lock-next">
                New {newIsPin ? 'PIN' : 'password'}
              </label>
              {fieldFor('lock-next', next, setNext, `New ${newIsPin ? 'PIN' : 'password'}`, mode === 'setup')}
            </div>
            <div>
              <label className="label" htmlFor="lock-confirm">
                Repeat it
              </label>
              {fieldFor('lock-confirm', confirm, setConfirm, 'Repeat the secret')}
            </div>
          </>
        )}

        {error && (
          <p className="rounded-xl bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200" aria-live="polite">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <button type="button" className="btn-ghost flex-1" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={mode === 'disable' ? 'btn-danger flex-1' : 'btn-primary flex-1'}
            disabled={!canSave}
          >
            {busy
              ? 'Saving…'
              : mode === 'disable'
                ? 'Turn off lock'
                : mode === 'change'
                  ? 'Change'
                  : 'Turn on lock'}
          </button>
        </div>
      </form>
    </Sheet>
  )
}

function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string
  subtitle: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92dvh] w-full max-w-md animate-slideUp overflow-y-auto rounded-t-2xl bg-ink-800 p-4 pb-6 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600 sm:hidden" />
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{subtitle}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 active:bg-ink-700"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
