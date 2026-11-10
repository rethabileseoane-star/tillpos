import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getDeviceId, repairStockCache } from '@/db'
import { hasNativeDetector } from '@/features/scanner/detector'
import { feedbackSuccess } from '@/ui/feedback'
import {
  isStoragePersisted,
  promptInstall,
  requestPersistentStorage,
} from '@/features/install/install'
import { useInstall } from '@/features/install/useInstall'
import { SecurityCard } from '@/features/security/SecurityCard'
import { ShopCard } from '@/features/shops/ShopCard'
import { useTheme, type ThemePreference } from '@/ui/theme'
import { LicenseCard } from './LicenseCard'
import { loadShopName, saveShopName } from './shopName'
import { SyncCard } from './SyncCard'

export function SettingsScreen() {
  const products = useLiveQuery(() => db.products.count(), []) ?? 0
  const sales = useLiveQuery(() => db.sales.count(), []) ?? 0
  const movements = useLiveQuery(() => db.stockMovements.count(), []) ?? 0
  const cash = useLiveQuery(() => db.cashMovements.count(), []) ?? 0

  const [deviceId] = useState(getDeviceId)
  const [online, setOnline] = useState(navigator.onLine)
  const [storage, setStorage] = useState('measuring…')
  const [persisted, setPersisted] = useState(false)
  const { installed, canInstall } = useInstall()
  const cameraAvailable = Boolean(navigator.mediaDevices?.getUserMedia)

  const [shopName, setShopName] = useState('')
  const [shopSaved, setShopSaved] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    void loadShopName().then((n) => setShopName(n))
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)

    // Quota is how much headroom the ledger has before sales start failing.
    void navigator.storage?.estimate?.().then((e) => {
      if (!e.usage || !e.quota) return
      const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`
      setStorage(`${mb(e.usage)} of ${mb(e.quota)}`)
    })

    void isStoragePersisted().then(setPersisted)

    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  return (
    <div className="px-4 py-4">
      <h1 className="text-xl font-bold">Settings</h1>

      <AppearanceCard />

      <div className="card mt-3">
        <h2 className="text-sm font-semibold">Device</h2>
        <dl className="mt-2 space-y-1.5 text-sm">
          <Row label="Online" value={online ? 'yes' : 'no — working offline'} />
          <Row
            label="Camera available"
            value={cameraAvailable ? 'yes' : 'no — install the app'}
          />
          <Row label="Installed as app" value={installed ? 'yes' : 'no'} />
          <Row label="Camera API" value={hasNativeDetector() ? 'native' : 'wasm fallback'} />
          <Row label="Build" value={__BUILD_ID__} mono />
          <Row label="This device id" value={deviceId.slice(0, 8)} mono />
        </dl>
      </div>

      <SecurityCard />

      <div className="card mt-3">
        <h2 className="text-sm font-semibold">Install as an app</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          {installed
            ? 'Installed. You are running the app from your home screen, and your data is stored on this device.'
            : 'Add Till to your home screen so it opens full screen, works offline, and keeps its own data.'}
        </p>
        {!installed && (
          <button
            className="btn-primary mt-3 w-full !py-2.5 text-sm"
            disabled={!canInstall}
            onClick={async () => {
              const outcome = await promptInstall()
              if (outcome === 'unavailable') {
                setMessage(
                  'Your browser did not offer an install prompt — use the Chrome menu → “Add to Home screen”.',
                )
              }
            }}
          >
            {canInstall ? 'Install app' : 'Use Chrome menu → Add to Home screen'}
          </button>
        )}
      </div>

      {!cameraAvailable && (
        <div className="mt-3 rounded-xl bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
          <strong className="font-semibold">Camera is unavailable here.</strong>{' '}
          {installed
            ? 'This browser is withholding the camera from the installed app.'
            : 'Chrome on Android and Safari on iOS only expose the camera to an app ' +
              'launched from the home screen. Add to Home Screen and open it from the icon.'}{' '}
          Desktop browsers allow the camera in an ordinary tab, so this is expected
          on a phone only.
        </div>
      )}

      <div className="card mt-3">
        <h2 className="text-sm font-semibold">Business</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Printed on the report headers, so the PDF books carry your shop's name.
        </p>
        <div className="mt-2 flex gap-2">
          <input
            className="field !py-2.5 text-sm"
            value={shopName}
            onChange={(e) => {
              setShopName(e.target.value)
              setShopSaved(false)
            }}
            placeholder="e.g. Maluti Traders"
            maxLength={60}
          />
          <button
            className="btn-primary !py-2.5 text-sm"
            disabled={shopName.trim() === '' || shopSaved}
            onClick={async () => {
              await saveShopName(shopName)
              setShopSaved(true)
              feedbackSuccess()
            }}
          >
            Save
          </button>
        </div>
        {shopSaved && (
          <p className="mt-1 text-[11px] text-cash-400">Saved — appears on your next books PDF.</p>
        )}
      </div>

      <ShopCard />

      <LicenseCard />

      <div className="card mt-3">
        <h2 className="text-sm font-semibold">Data on this device</h2>
        <dl className="mt-2 space-y-1.5 text-sm">
          <Row label="Products" value={String(products)} mono />
          <Row label="Sales" value={String(sales)} mono />
          <Row label="Stock movements" value={String(movements)} mono />
          <Row label="Cash movements" value={String(cash)} mono />
        </dl>
        <button
          className="btn-ghost mt-3 w-full !py-2.5 text-sm"
          onClick={() => {
            void repairStockCache()
            feedbackSuccess()
            setMessage('Stock balances rebuilt from the ledger')
          }}
        >
          Rebuild stock balances
        </button>
      </div>

      <SyncCard />

      <div className="card mt-3">
        <h2 className="text-sm font-semibold">Storage</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">
          Sales and stock movements are never deleted, so the ledger stays
          auditable. Clearing this site data from your browser would erase
          everything, so export regularly if the numbers matter.
        </p>
        <dl className="mt-2 space-y-1.5 text-sm">
          <Row
            label="Protected from clearing"
            value={persisted ? 'yes' : 'not yet'}
          />
        </dl>
        <p className="mt-2 text-xs text-slate-500">Local use: {storage}</p>
        {!persisted && (
          <button
            className="btn-ghost mt-3 w-full !py-2.5 text-sm"
            onClick={async () => {
              const ok = await requestPersistentStorage()
              setPersisted(ok)
              setMessage(
                ok
                  ? 'This device will now keep your data instead of clearing it.'
                  : 'The browser declined. Data still saves, but the phone may clear it under storage pressure.',
              )
            }}
          >
            Keep data on this device
          </button>
        )}
      </div>

      {message && (
        <p className="mt-3 rounded-xl bg-ink-800 px-3 py-2 text-xs text-cash-400">
          {message}
        </p>
      )}

      <p className="mt-6 text-center text-[11px] text-slate-600">Till · offline first</p>
    </div>
  )
}

const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

function AppearanceCard() {
  const { preference, resolved, setPreference } = useTheme()
  const next = resolved === 'dark' ? 'light' : 'dark'

  return (
    <div className="card mt-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Appearance</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            {preference === 'system'
              ? `Following this device — currently ${resolved}.`
              : `Always ${preference}.`}{' '}
            This setting stays on this device.
          </p>
        </div>
        <button
          type="button"
          aria-label={next === 'dark' ? 'Switch to dark mode' : 'Switch to light mode'}
          title={next === 'dark' ? 'Switch to dark mode' : 'Switch to light mode'}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-ink-700 text-slate-200 active:bg-ink-600"
          onClick={() => setPreference(next)}
        >
          {next === 'dark' ? <MoonIcon /> : <SunIcon />}
        </button>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={preference === option.id}
            className={`btn !py-2.5 text-sm ${
              preference === option.id
                ? 'bg-cash-500 text-on-accent'
                : 'bg-ink-700 text-slate-200 hover:bg-ink-600'
            }`}
            onClick={() => setPreference(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5" aria-hidden>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5" aria-hidden>
      <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
    </svg>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-slate-400">{label}</dt>
      <dd className={`truncate ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  )
}