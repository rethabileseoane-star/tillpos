import { useState } from 'react'
import { feedbackError, feedbackSuccess } from '@/ui/feedback'
import { copyText } from '@/licensing/format'
import { useLicense } from '@/licensing/LicenseContext'

/**
 * Settings → Licence.
 *
 * Deliberately plain: the shopkeeper needs to answer "is this till licensed,
 * which phone is it, and when must it next see the internet". The seller's
 * admin screen is where keys and device allow-lists are managed.
 */
export function LicenseCard() {
  const license = useLicense()
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const deactivate = async () => {
    if (
      !window.confirm(
        'Deactivate this device?\n\nThe till will lock and this phone will be removed from the licence. Your sales and stock stay on the phone. To use it again, the supplier must add this device code back.',
      )
    ) {
      return
    }
    const result = await license.deactivate()
    if (result.ok) {
      feedbackSuccess()
      setNote('This device has been removed from the licence.')
    } else {
      feedbackError()
      setNote(result.error ?? 'Could not deactivate this device.')
    }
  }

  const copyDevice = async () => {
    const ok = await copyText(license.deviceCode)
    setCopied(ok)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const online = license.online
  const statusText = online ? 'Checked and active' : 'Active — working offline'

  return (
    <div className="card mt-3">
      <h2 className="text-sm font-semibold">Licence</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">
        One subscription covers this business. This phone must be on the
        licence’s device list, and the till checks in whenever it has internet.
      </p>

      <dl className="mt-2 space-y-1.5 text-sm">
        <Row label="Business" value={license.businessName ?? '—'} />
        <Row
          label="Status"
          value={statusText}
          tone={online ? 'good' : 'warn'}
        />
        <Row label="Device code" value={license.deviceCode} mono />
        <Row label="Last check" value={describe(license.lastCheckAt)} />
        <Row
          label="Offline until"
          value={
            license.accessExpiresAt
              ? `${formatDuration(license.remainingMs)} left`
              : '—'
          }
          tone={
            license.remainingMs !== null && license.remainingMs < 6 * 60 * 60 * 1000
              ? 'warn'
              : undefined
          }
        />
        <Row label="Subscription ends" value={formatDate(license.licenseExpiresAt)} />
      </dl>

      <div className="mt-3 flex gap-2">
        <button
          className="btn-primary flex-1 !py-2.5 text-sm"
          disabled={license.busy}
          onClick={() => void license.checkNow()}
        >
          {license.busy ? 'Checking…' : 'Check now'}
        </button>
        <button className="btn-ghost !py-2.5 text-sm" onClick={() => void copyDevice()}>
          {copied ? 'Copied' : 'Copy device code'}
        </button>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Activation and checks need internet. After a successful check, the till
        keeps working offline for the period set on the licence — 24 hours by
        default. If that runs out, the till locks until it can reach the licence
        server again.
      </p>

      <button
        className="btn-ghost mt-3 w-full !py-2.5 text-sm text-red-300"
        disabled={license.busy}
        onClick={() => void deactivate()}
      >
        Deactivate this device
      </button>

      {license.error && (
        <p className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
          {license.error}
        </p>
      )}
      {note && (
        <p className="mt-3 rounded-xl bg-ink-900 px-3 py-2 text-xs leading-relaxed text-slate-300">
          {note}
        </p>
      )}
    </div>
  )
}

function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string
  value: string
  mono?: boolean
  tone?: 'good' | 'warn'
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd
        className={`truncate ${mono ? 'font-mono text-xs' : ''} ${
          tone === 'good' ? 'text-cash-400' : tone === 'warn' ? 'text-amber-300' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  )
}

function describe(at: number | null): string {
  if (!at) return 'never'
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`
  return new Date(at).toLocaleString()
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms <= 0) return 'expired'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
  }
  return `${hours}h ${minutes}m`
}

function formatDate(at: number | null): string {
  if (!at) return '—'
  return new Date(at).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}
