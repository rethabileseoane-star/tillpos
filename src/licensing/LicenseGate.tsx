import { useEffect, useState, type ReactNode } from 'react'
import { copyText, normalizeLicenseKey } from './format'
import { licenseDormant, licenseServerConfigured } from './config'
import { useLicense } from './LicenseContext'

/**
 * The full-screen gate. It sits above the staff lock and every route, so an
 * expired or removed licence cannot flash a Sell screen for one frame.
 *
 * A PWA cannot force-close itself. The closest enforceable behaviour is a
 * non-dismissible lock screen with no navigation, no sales and no sync.
 */
export function LicenseGate({ children }: { children: ReactNode }) {
  const license = useLicense()

  // Development only; see licenseDormant. A production build cannot reach this
  // branch, and the ribbon makes a dev session impossible to mistake for the
  // deployed app.
  if (licenseDormant) {
    return (
      <>
        {children}
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center">
          <div className="rounded-b-lg bg-amber-400 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-900 shadow-lg">
            Dev build · licence checks off
          </div>
        </div>
      </>
    )
  }

  if (license.status === 'checking') return <LicenseBoot />
  if (license.status === 'activation') return <ActivationScreen />
  if (license.status === 'locked') return <LicenseLockScreen />
  return <>{children}</>
}

function LicenseShell({
  children,
}: {
  children: ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-ink-900">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-8">
        <div className="mb-7 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cash-500 font-bold text-ink-900">
            T
          </div>
          <div>
            <p className="text-sm font-semibold tracking-wide">Till</p>
            <p className="text-[11px] text-slate-500">Licensed point of sale</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}

function LicenseBoot() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-900">
      <div className="flex flex-col items-center gap-4">
        <div className="h-12 w-12 animate-pulse rounded-2xl bg-cash-500/80" />
        <p className="text-xs uppercase tracking-[0.3em] text-slate-500">Checking licence</p>
      </div>
    </div>
  )
}

function ActivationScreen() {
  const license = useLicense()
  const [key, setKey] = useState('')
  const [copied, setCopied] = useState(false)
  const [shared, setShared] = useState(false)
  const [autoFilled, setAutoFilled] = useState(false)

  // A quick-activation link (see the seller admin screen) carries the licence
  // key in the URL so the customer does not have to type it. Read it once,
  // pre-fill the field, and remove it from the address bar immediately so it is
  // not left in history or shared by mistake.
  useEffect(() => {
    const hash = window.location.hash
    const query = hash.includes('?')
      ? hash.slice(hash.indexOf('?') + 1)
      : window.location.search.replace(/^\\?/, '')
    const params = new URLSearchParams(query)
    const fromUrl =
      params.get('key') ?? params.get('license') ?? params.get('licence')
    if (!fromUrl) return
    setKey(normalizeLicenseKey(fromUrl))
    setAutoFilled(true)
    try {
      const url = new URL(window.location.href)
      url.hash = '#/'
      url.search = ''
      window.history.replaceState({}, '', url.toString())
    } catch {
      // Older browsers: leaving the URL alone is harmless.
    }
  }, [])

  const submit = async () => {
    const result = await license.activate(key)
    if (result.ok) {
      setKey('')
      setAutoFilled(false)
    }
  }

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text.trim()) {
        setKey(normalizeLicenseKey(text))
        setAutoFilled(false)
      }
    } catch {
      // Clipboard access is optional; the manual field still works.
    }
  }

  const shareDeviceCode = async () => {
    const text = license.deviceCode
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Till device code',
          text: `Device code for Till activation: ${text}`,
        })
        setShared(true)
        window.setTimeout(() => setShared(false), 1500)
        return
      } catch {
        // Fall through to copying.
      }
    }
    const ok = await copyText(text)
    setShared(ok)
    window.setTimeout(() => setShared(false), 1500)
  }

  return (
    <LicenseShell>
      <h1 className="text-2xl font-bold">Activate this till</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        Enter the licence key supplied with your subscription. This phone must
        first be added to the licence by your supplier.
      </p>

      <div className="card mt-5">
        <p className="label">This device code</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-xl bg-ink-900 px-3 py-3 font-mono text-sm text-cash-300">
            {license.deviceCode}
          </code>
          <button
            type="button"
            className="btn-ghost !px-3 !py-3 text-xs"
            onClick={async () => {
              const ok = await copyText(license.deviceCode)
              setCopied(ok)
              window.setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            className="btn-ghost !px-3 !py-3 text-xs"
            onClick={() => void shareDeviceCode()}
          >
            {shared ? 'Shared' : 'Share'}
          </button>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Send this code to your supplier. It identifies this installation, not
          the person using it. Share or copy it in one tap.
        </p>
      </div>

      <div className="card mt-3">
        <label className="label" htmlFor="licence-key">
          Licence key
        </label>
        <input
          id="licence-key"
          className="field font-mono !py-3 text-sm uppercase"
          value={key}
          onChange={(e) => {
            setKey(e.target.value.toUpperCase())
            setAutoFilled(false)
          }}
          placeholder="TILL-XXXX-XXXX-XXXX-XXXX"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            className="btn-ghost !px-3 !py-2 text-xs"
            onClick={() => void pasteFromClipboard()}
          >
            Paste from clipboard
          </button>
          {autoFilled && (
            <span className="self-center text-[11px] text-cash-300">
              Filled from activation link
            </span>
          )}
        </div>
        <button
          className="btn-primary mt-3 w-full !py-3 text-sm"
          disabled={license.busy || key.trim() === '' || !licenseServerConfigured}
          onClick={() => void submit()}
        >
          {license.busy ? 'Activating…' : 'Activate this device'}
        </button>

        {!licenseServerConfigured && (
          <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200">
            This build has no licence server configured. Ask your supplier for a
            new build.
          </p>
        )}
        {license.error && (
          <p className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
            {license.error}
          </p>
        )}
      </div>

      <div className="mt-5 rounded-xl border border-ink-700 bg-ink-800/60 p-3 text-[11px] leading-relaxed text-slate-500">
        <strong className="font-semibold text-slate-300">Offline working.</strong>{' '}
        After activation this till works without internet between licence checks
        (24 hours by default; your supplier sets the exact period). Connect at
        least that often to keep it open. A licence check never deletes sales,
        stock or cash records.
      </div>
    </LicenseShell>
  )
}

function LicenseLockScreen() {
  const license = useLicense()

  return (
    <LicenseShell>
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-300">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-7 w-7">
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 018 0v3M12 14v2" />
        </svg>
      </div>
      <h1 className="mt-5 text-2xl font-bold">Licence check needed</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">
        {license.error ??
          'Connect this phone to the internet so the till can confirm its licence.'}
      </p>

      <dl className="mt-5 space-y-2 rounded-2xl border border-ink-700 bg-ink-800 p-4 text-sm">
        {license.businessName && (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-slate-400">Business</dt>
            <dd className="truncate font-medium">{license.businessName}</dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <dt className="text-slate-400">This device</dt>
          <dd className="truncate font-mono text-xs text-slate-200">{license.deviceCode}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-slate-400">Internet</dt>
          <dd className={license.online ? 'text-cash-400' : 'text-amber-300'}>
            {license.online ? 'connected' : 'not connected'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-slate-400">Last check</dt>
          <dd className="text-slate-300">{formatLastCheck(license.lastCheckAt)}</dd>
        </div>
      </dl>

      <button
        className="btn-primary mt-4 w-full !py-3 text-sm"
        disabled={license.busy}
        onClick={() => void license.checkNow()}
      >
        {license.busy ? 'Checking…' : 'Check licence now'}
      </button>
      <button
        className="btn-ghost mt-2 w-full !py-3 text-sm"
        disabled={license.busy}
        onClick={license.showActivation}
      >
        Enter a different licence key
      </button>

      <p className="mt-5 text-center text-[11px] leading-relaxed text-slate-500">
        Sales, stock and cash records are still on this phone. A locked licence
        never deletes them.
      </p>
    </LicenseShell>
  )
}

export function LicenseNotice() {
  const license = useLicense()
  if (license.status !== 'valid') return null

  const sixHours = 6 * 60 * 60 * 1000
  const twelveHours = 12 * 60 * 60 * 1000
  const lowOffline = license.remainingMs !== null && license.remainingMs < sixHours
  const staleOffline =
    !license.online && license.remainingMs !== null && license.remainingMs < twelveHours
  if (!lowOffline && !staleOffline) return null

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] leading-relaxed text-amber-200">
      {license.online
        ? 'Licence check due soon. Keep the phone online for a moment so it can refresh.'
        : `Working offline. Connect to the internet within ${formatRemaining(
            license.remainingMs,
          )} to keep the till open.`}
    </div>
  )
}

function formatLastCheck(at: number | null): string {
  if (!at) return 'never'
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`
  return new Date(at).toLocaleString()
}

function formatRemaining(ms: number | null): string {
  if (ms === null || ms <= 0) return 'less than an hour'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours >= 1) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
