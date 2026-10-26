import { useEffect, useState, type ReactNode } from 'react'
import { feedbackError, feedbackSuccess } from '@/ui/feedback'
import {
  biometricSupportNote,
  biometricsSupported,
  enrollBiometric,
  platformAuthenticatorAvailable,
} from './biometric'
import { removeBiometric, saveBiometric } from './credentialService'
import { useAppLock } from './LockContext'
import { PASSWORD_MIN, PIN_MAX, PIN_MIN, type SecretKind } from './secret'
import {
  STAFF_NAME_MAX,
  addCashier,
  changeStaffSecret,
  createOwner,
  removeAllStaff,
  removeCashier,
  type StaffSummary,
} from './staff'

interface CardMessage {
  text: string
  error?: boolean
}

type SheetState =
  | { kind: 'setupOwner' }
  | { kind: 'changeOwner' }
  | { kind: 'addCashier' }
  | { kind: 'resetCashier'; account: StaffSummary }
  | { kind: 'removeCashier'; account: StaffSummary }
  | { kind: 'turnOff' }
  | null

/**
 * Settings → Staff & app lock.
 *
 * The owner sees one account and every cashier on this phone. Cashiers never
 * reach this screen: their navigation has no Settings tab and the route guard
 * sends them back to Sell. That is the boundary that makes resetting a PIN and
 * seeing the whole ledger owner-only.
 *
 * The owner must use a password before a cashier can be added. A four-digit
 * owner PIN on a phone a cashier carries is both guessable and likely shared.
 * Existing PIN-only locks are migrated as-is and are upgraded here.
 */
export function SecurityCard() {
  const { accounts, biometric, refresh, lockNow } = useAppLock()
  const [sheet, setSheet] = useState<SheetState>(null)
  const [message, setMessage] = useState<CardMessage | null>(null)
  const [busy, setBusy] = useState(false)
  const [authenticator, setAuthenticator] = useState(false)

  const owner = accounts.find((a) => a.role === 'owner')
  const cashiers = accounts.filter((a) => a.role === 'cashier')
  const ownerNeedsPassword = Boolean(owner && owner.kind !== 'password')
  const hasStaff = accounts.length > 0

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
        setMessage({ text: 'Biometric unlock turned off. The owner password still works.' })
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
      setMessage({ text: 'Biometric unlock is on for the owner account on this device.' })
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

  const saved = (text: string) => setMessage({ text })

  return (
    <div className="card mt-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Staff &amp; app lock</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            {hasStaff
              ? `On — ${cashiers.length} cashier${cashiers.length === 1 ? '' : 's'}. Every sale records who made it.`
              : 'Off — anyone who opens this app can use the till.'}
          </p>
        </div>
        <span
          className={`chip ${
            hasStaff ? 'bg-cash-500/15 text-cash-400' : 'bg-ink-700 text-slate-400'
          }`}
        >
          {hasStaff ? 'On' : 'Off'}
        </span>
      </div>

      {!hasStaff ? (
        <>
          <button
            className="btn-primary mt-3 w-full !py-2.5 text-sm"
            onClick={() => {
              setMessage(null)
              setSheet({ kind: 'setupOwner' })
            }}
          >
            Set up owner account
          </button>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            The owner sees every section and uses a password. Add a cashier
            afterwards for each person who sells on this phone.
          </p>
        </>
      ) : owner ? (
        <>
          <div className="mt-3 rounded-xl border border-ink-700 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{owner.name}</p>
                <p className="text-[11px] text-slate-400">
                  Owner ·{' '}
                  {owner.kind === 'pin'
                    ? `PIN, ${owner.length} digits`
                    : 'password'}
                </p>
              </div>
              <span className="chip shrink-0 bg-cash-500/15 text-cash-400">Owner</span>
            </div>

            {ownerNeedsPassword && (
              <p className="mt-2 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-amber-200">
                The owner still uses a PIN. Set a password before adding cashiers.
              </p>
            )}

            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                className="btn-ghost !py-2.5 text-sm"
                onClick={() => {
                  setMessage(null)
                  setSheet({ kind: 'changeOwner' })
                }}
              >
                {ownerNeedsPassword ? 'Set password' : 'Change password'}
              </button>
              <button className="btn-ghost !py-2.5 text-sm" onClick={lockNow}>
                Lock now
              </button>
            </div>
          </div>

          <div className="mt-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Cashiers</h3>
              <span className="text-[11px] text-slate-500">
                {cashiers.length} account{cashiers.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="mt-2 space-y-2">
              {cashiers.map((account) => (
                <div key={account.id} className="rounded-xl border border-ink-700 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{account.name}</p>
                      <p className="text-[11px] text-slate-400">
                        Cashier ·{' '}
                        {account.kind === 'pin'
                          ? `PIN, ${account.length} digits`
                          : 'password'}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        className="rounded-lg bg-ink-700 px-2.5 py-2 text-[11px] active:bg-ink-600"
                        onClick={() => {
                          setMessage(null)
                          setSheet({ kind: 'resetCashier', account })
                        }}
                      >
                        Reset
                      </button>
                      <button
                        className="rounded-lg bg-ink-700 px-2.5 py-2 text-[11px] text-red-300 active:bg-ink-600"
                        onClick={() => {
                          setMessage(null)
                          setSheet({ kind: 'removeCashier', account })
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {cashiers.length === 0 && (
                <p className="text-xs leading-relaxed text-slate-500">
                  No cashier accounts yet. Add one for each person who sells on
                  this phone.
                </p>
              )}
            </div>

            <button
              className="btn-primary mt-2 w-full !py-2.5 text-sm"
              disabled={ownerNeedsPassword}
              onClick={() => {
                setMessage(null)
                setSheet({ kind: 'addCashier' })
              }}
            >
              Add cashier
            </button>
            {ownerNeedsPassword && (
              <p className="mt-1 text-[11px] text-amber-200">
                Set the owner password above first.
              </p>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-ink-700 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Owner biometrics</h3>
                <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
                  Fingerprint or face unlock for the owner account on this
                  device. Cashiers always use their PIN or password.
                </p>
              </div>
              <span
                className={`chip shrink-0 ${
                  biometric
                    ? 'bg-cash-500/15 text-cash-400'
                    : 'bg-ink-700 text-slate-400'
                }`}
              >
                {biometric ? 'On' : 'Off'}
              </span>
            </div>
            <button
              className="btn-ghost mt-2 w-full !py-2.5 text-sm"
              disabled={
                busy ||
                (!canUseBiometric && !biometric) ||
                (!authenticator && !biometric)
              }
              onClick={() => void toggleBiometric()}
            >
              {biometric ? 'Remove biometrics' : 'Add biometrics'}
            </button>
            {(supportNote || (!biometric && !authenticator)) && (
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                {supportNote ||
                  "No fingerprint or face is enrolled in this device's settings yet."}
              </p>
            )}
          </div>

          {cashiers.length === 0 ? (
            <button
              className="btn-ghost mt-3 w-full !py-2.5 text-sm"
              onClick={() => {
                setMessage(null)
                setSheet({ kind: 'turnOff' })
              }}
            >
              Turn off app lock
            </button>
          ) : (
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
              Remove every cashier account before turning off the app lock.
            </p>
          )}
        </>
      ) : null}

      {message && (
        <p
          className={`mt-2 rounded-xl px-3 py-2 text-[11px] leading-relaxed ${
            message.error ? 'bg-red-500/10 text-red-200' : 'bg-cash-500/10 text-cash-400'
          }`}
        >
          {message.text}
        </p>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        This locks the screen and separates the owner's sections from a cashier's.
        It does not encrypt the records already stored on this device: a cashier
        phone still holds the local database. Use “Lock now” before leaving the
        counter.
      </p>

      {sheet?.kind === 'setupOwner' && (
        <OwnerSetupSheet
          onClose={() => setSheet(null)}
          onSaved={saved}
        />
      )}
      {sheet?.kind === 'changeOwner' && owner && (
        <OwnerChangeSheet
          owner={owner}
          onClose={() => setSheet(null)}
          onSaved={saved}
        />
      )}
      {sheet?.kind === 'addCashier' && (
        <CashierSheet
          mode="add"
          onClose={() => setSheet(null)}
          onSaved={saved}
        />
      )}
      {sheet?.kind === 'resetCashier' && (
        <CashierSheet
          mode="reset"
          account={sheet.account}
          onClose={() => setSheet(null)}
          onSaved={saved}
        />
      )}
      {sheet?.kind === 'removeCashier' && (
        <RemoveCashierSheet
          account={sheet.account}
          onClose={() => setSheet(null)}
          onSaved={saved}
        />
      )}
      {sheet?.kind === 'turnOff' && owner && (
        <TurnOffSheet
          owner={owner}
          onClose={() => setSheet(null)}
          onSaved={saved}
        />
      )}
    </div>
  )
}

function OwnerSetupSheet({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (text: string) => void
}) {
  const { refresh } = useAppLock()
  const [name, setName] = useState('Owner')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canSave = !busy && name.trim().length > 0 && next.length > 0 && confirm.length > 0

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      if (next !== confirm) {
        setError('The two entries do not match.')
        return
      }
      await createOwner(name, next)
      await refresh()
      feedbackSuccess()
      onSaved('Owner account created. This password is asked for when the till opens.')
      onClose()
    } catch (err) {
      feedbackError()
      setError(err instanceof Error ? err.message : 'Could not create the owner account.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title="Set up owner account"
      subtitle="The owner sees every section. Use a password, not a 4-digit PIN, because cashiers will use this phone."
      onClose={onClose}
    >
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <NameField value={name} onChange={setName} autoFocus />
        <SecretFields
          kind="password"
          next={next}
          setNext={setNext}
          confirm={confirm}
          setConfirm={setConfirm}
        />
        {error && <FormError text={error} />}
        <FormButtons
          busy={busy}
          canSave={canSave}
          submitLabel="Create owner"
          onCancel={onClose}
        />
      </form>
    </Sheet>
  )
}

function OwnerChangeSheet({
  owner,
  onClose,
  onSaved,
}: {
  owner: StaffSummary
  onClose: () => void
  onSaved: (text: string) => void
}) {
  const { refresh } = useAppLock()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const isPin = owner.kind === 'pin'

  const canSave =
    !busy && current.length > 0 && next.length > 0 && confirm.length > 0

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      if (next !== confirm) {
        setError('The two entries do not match.')
        return
      }
      await changeStaffSecret({
        accountId: owner.id,
        currentSecret: current,
        kind: 'password',
        secret: next,
      })
      await refresh()
      feedbackSuccess()
      onSaved('Owner password changed. Add biometrics again if you use them.')
      onClose()
    } catch (err) {
      feedbackError()
      setError(err instanceof Error ? err.message : 'Could not change the password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={isPin ? 'Set owner password' : 'Change owner password'}
      subtitle={
        isPin
          ? 'Enter the current owner PIN, then choose a password. Cashiers must not be able to guess the owner account.'
          : 'Enter the current password, then choose a new one. Biometric unlock will need to be added again.'
      }
      onClose={onClose}
    >
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div>
          <label className="label" htmlFor="owner-current">
            Current {isPin ? 'PIN' : 'password'}
          </label>
          <input
            id="owner-current"
            className="field text-center font-mono tracking-[0.2em]"
            type="password"
            inputMode={isPin ? 'numeric' : 'text'}
            maxLength={isPin ? PIN_MAX : undefined}
            value={current}
            onChange={(e) => {
              setCurrent(isPin ? e.target.value.replace(/\D/g, '') : e.target.value)
              setError(null)
            }}
            autoFocus
            autoComplete="off"
            enterKeyHint="next"
          />
        </div>
        <SecretFields
          kind="password"
          next={next}
          setNext={setNext}
          confirm={confirm}
          setConfirm={setConfirm}
        />
        {error && <FormError text={error} />}
        <FormButtons
          busy={busy}
          canSave={canSave}
          submitLabel="Change password"
          onCancel={onClose}
        />
      </form>
    </Sheet>
  )
}

function CashierSheet({
  mode,
  account,
  onClose,
  onSaved,
}: {
  mode: 'add' | 'reset'
  account?: StaffSummary
  onClose: () => void
  onSaved: (text: string) => void
}) {
  const { refresh } = useAppLock()
  const [name, setName] = useState(account?.name ?? '')
  const [kind, setKind] = useState<SecretKind>(account?.kind ?? 'pin')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const needsName = mode === 'add'
  const canSave =
    !busy &&
    (!needsName || name.trim().length > 0) &&
    next.length > 0 &&
    confirm.length > 0

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      if (next !== confirm) {
        setError('The two entries do not match.')
        return
      }
      if (mode === 'add') {
        await addCashier(name, kind, next)
      } else if (account) {
        await changeStaffSecret({ accountId: account.id, kind, secret: next })
      }
      await refresh()
      feedbackSuccess()
      onSaved(
        mode === 'add'
          ? `${name.trim()} can now sign in on this phone.`
          : `${account?.name ?? 'The cashier'}'s PIN was reset.`,
      )
      onClose()
    } catch (err) {
      feedbackError()
      setError(
        err instanceof Error
          ? err.message
          : mode === 'add'
            ? 'Could not add the cashier.'
            : 'Could not reset the PIN.',
      )
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'add' ? 'Add cashier' : `Reset ${account?.name ?? 'cashier'}`
  const subtitle =
    mode === 'add'
      ? 'Each cashier gets their own name and PIN on this phone. They will see Sell and Catalog only.'
      : 'Set a new PIN or password. The old one stops working immediately, and any lockout is cleared.'

  return (
    <Sheet title={title} subtitle={subtitle} onClose={onClose}>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {needsName ? (
          <NameField value={name} onChange={setName} autoFocus />
        ) : (
          <div className="rounded-xl bg-ink-700/50 px-3 py-2 text-sm">
            {account?.name}
          </div>
        )}
        <SecretFields
          kind={kind}
          onKindChange={(nextKind) => {
            setKind(nextKind)
            setNext('')
            setConfirm('')
            setError(null)
          }}
          allowPin
          next={next}
          setNext={setNext}
          confirm={confirm}
          setConfirm={setConfirm}
          autoFocus={!needsName}
        />
        {error && <FormError text={error} />}
        <FormButtons
          busy={busy}
          canSave={canSave}
          submitLabel={mode === 'add' ? 'Add cashier' : 'Reset secret'}
          onCancel={onClose}
        />
      </form>
    </Sheet>
  )
}

function RemoveCashierSheet({
  account,
  onClose,
  onSaved,
}: {
  account: StaffSummary
  onClose: () => void
  onSaved: (text: string) => void
}) {
  const { refresh } = useAppLock()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await removeCashier(account.id)
      await refresh()
      feedbackSuccess()
      onSaved(`${account.name} was removed. Past sales keep the name.`)
      onClose()
    } catch (err) {
      feedbackError()
      setError(err instanceof Error ? err.message : 'Could not remove the cashier.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={`Remove ${account.name}?`}
      subtitle="Past sales keep this cashier's name. The account can be added again later."
      onClose={onClose}
    >
      {error && <FormError text={error} />}
      <div className="mt-4 flex gap-2">
        <button className="btn-ghost flex-1" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn-danger flex-1"
          onClick={() => void remove()}
          disabled={busy}
        >
          {busy ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </Sheet>
  )
}

function TurnOffSheet({
  owner,
  onClose,
  onSaved,
}: {
  owner: StaffSummary
  onClose: () => void
  onSaved: (text: string) => void
}) {
  const { refresh } = useAppLock()
  const [current, setCurrent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const isPin = owner.kind === 'pin'

  const canSave = !busy && current.length > 0

  const save = async () => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await removeAllStaff(current)
      await refresh()
      feedbackSuccess()
      onSaved('App lock turned off. The till now opens without a secret.')
      onClose()
    } catch (err) {
      feedbackError()
      setError(err instanceof Error ? err.message : 'Could not turn off the app lock.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title="Turn off app lock?"
      subtitle="Enter the owner's current secret. The till will open without a login. You can set it up again later."
      onClose={onClose}
    >
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div>
          <label className="label" htmlFor="turn-off-current">
            Current {isPin ? 'PIN' : 'password'}
          </label>
          <input
            id="turn-off-current"
            className="field text-center font-mono tracking-[0.2em]"
            type="password"
            inputMode={isPin ? 'numeric' : 'text'}
            maxLength={isPin ? PIN_MAX : undefined}
            value={current}
            onChange={(e) => {
              setCurrent(isPin ? e.target.value.replace(/\D/g, '') : e.target.value)
              setError(null)
            }}
            autoFocus
            autoComplete="off"
          />
        </div>
        {error && <FormError text={error} />}
        <FormButtons
          busy={busy}
          canSave={canSave}
          submitLabel="Turn off lock"
          onCancel={onClose}
          danger
        />
      </form>
    </Sheet>
  )
}

function NameField({
  value,
  onChange,
  autoFocus,
}: {
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
}) {
  return (
    <div>
      <label className="label" htmlFor="staff-name">
        Name
      </label>
      <input
        id="staff-name"
        className="field"
        value={value}
        maxLength={STAFF_NAME_MAX}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Thabo"
        autoComplete="off"
        autoFocus={autoFocus}
      />
    </div>
  )
}

function SecretFields({
  kind,
  onKindChange,
  allowPin = false,
  next,
  setNext,
  confirm,
  setConfirm,
  autoFocus = false,
}: {
  kind: SecretKind
  onKindChange?: (kind: SecretKind) => void
  allowPin?: boolean
  next: string
  setNext: (value: string) => void
  confirm: string
  setConfirm: (value: string) => void
  autoFocus?: boolean
}) {
  const isPin = kind === 'pin'

  return (
    <>
      {allowPin && (
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-ink-700 p-1">
          {(['pin', 'password'] as SecretKind[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onKindChange?.(option)}
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

      <div>
        <label className="label" htmlFor="staff-secret">
          New {isPin ? 'PIN' : 'password'}
        </label>
        <input
          id="staff-secret"
          className={`field ${isPin ? 'text-center font-mono !text-xl tracking-[0.35em]' : ''}`}
          type="password"
          inputMode={isPin ? 'numeric' : 'text'}
          pattern={isPin ? '[0-9]*' : undefined}
          maxLength={isPin ? PIN_MAX : undefined}
          autoComplete="new-password"
          value={next}
          onChange={(e) =>
            setNext(isPin ? e.target.value.replace(/\D/g, '') : e.target.value)
          }
          aria-label={`New ${isPin ? 'PIN' : 'password'}`}
          placeholder={isPin ? '••••' : `At least ${PASSWORD_MIN} characters`}
          autoFocus={autoFocus}
        />
      </div>
      <div>
        <label className="label" htmlFor="staff-confirm">
          Repeat it
        </label>
        <input
          id="staff-confirm"
          className={`field ${isPin ? 'text-center font-mono !text-xl tracking-[0.35em]' : ''}`}
          type="password"
          inputMode={isPin ? 'numeric' : 'text'}
          pattern={isPin ? '[0-9]*' : undefined}
          maxLength={isPin ? PIN_MAX : undefined}
          autoComplete="new-password"
          value={confirm}
          onChange={(e) =>
            setConfirm(isPin ? e.target.value.replace(/\D/g, '') : e.target.value)
          }
          aria-label="Repeat the secret"
          placeholder={isPin ? '••••' : 'Repeat it'}
        />
      </div>
    </>
  )
}

function FormError({ text }: { text: string }) {
  return (
    <p
      className="rounded-xl bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200"
      aria-live="polite"
    >
      {text}
    </p>
  )
}

function FormButtons({
  busy,
  canSave,
  submitLabel,
  onCancel,
  danger = false,
}: {
  busy: boolean
  canSave: boolean
  submitLabel: string
  onCancel: () => void
  danger?: boolean
}) {
  return (
    <div className="flex gap-2 pt-1">
      <button type="button" className="btn-ghost flex-1" onClick={onCancel}>
        Cancel
      </button>
      <button
        type="submit"
        className={danger ? 'btn-danger flex-1' : 'btn-primary flex-1'}
        disabled={!canSave}
      >
        {busy ? 'Saving…' : submitLabel}
      </button>
    </div>
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
