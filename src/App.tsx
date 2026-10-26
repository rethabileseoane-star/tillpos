import { NavLink, Outlet } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { CartProvider, useCart } from '@/features/cart/CartContext'
import { formatMaluti } from '@/domain/money'
import { db, repairStockCache } from '@/db'
import { primeAudio } from '@/ui/feedback'
import {
  promptInstall,
  requestPersistentStorage,
} from '@/features/install/install'
import { useInstall } from '@/features/install/useInstall'
import { useAppLock } from '@/features/security/LockContext'
import { startSync } from '@/sync/scheduler'

const NAV = [
  { to: '/', label: 'Sell', icon: 'M4 6h16M4 12h16M4 18h10' },
  { to: '/catalog', label: 'Catalog', icon: 'M3 7l9-4 9 4v10l-9 4-9-4V7z M3 7l9 4 9-4M12 11v10' },
  { to: '/history', label: 'History', icon: 'M12 8v5l3 2M21 12a9 9 0 11-3-6.7', ownerOnly: true },
  { to: '/money', label: 'Money', icon: 'M2 7h20v10H2z M2 10h20M6 14h4', ownerOnly: true },
  { to: '/reports', label: 'Z-Report', icon: 'M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3', ownerOnly: true },
  { to: '/settings', label: 'More', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1A1.7 1.7 0 004.6 8a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V2a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H22a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z', ownerOnly: true },
]

function TabBar() {
  const { count, subtotal } = useCart()
  const { isOwner } = useAppLock()
  // Cashiers get Sell and Catalog only. The route guard in main.tsx backs this
  // up, so a deep link or an old back-stack entry cannot open an owner screen.
  const items = NAV.filter((item) => isOwner || !item.ownerOnly)
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-800/95 backdrop-blur">
      {count > 0 && (
        <div className="flex items-center justify-between border-b border-ink-700 px-4 py-1.5 text-sm">
          <span className="text-slate-400">
            {count} item{count === 1 ? '' : 's'} in cart
          </span>
          <span className="font-mono font-semibold text-cash-400">
            {formatMaluti(subtotal)}
          </span>
        </div>
      )}
      <div className="mx-auto flex max-w-lg px-2">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className="flex flex-1 flex-col items-center py-1.5 text-[10px] font-medium"
          >
            {({ isActive }) => (
              <span
                className={`flex w-full flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 transition ${
                  isActive
                    ? 'bg-cash-500/15 text-cash-400'
                    : 'text-slate-400 active:bg-ink-700/70 active:text-slate-300'
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-6 w-6"
                >
                  <path d={item.icon} />
                </svg>
                {item.label}
              </span>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}

/**
 * Camera unavailable in a web page.
 *
 * Only some platforms need installing: Chrome on Android and Safari on iOS
 * withhold `navigator.mediaDevices` until the app is launched from the home
 * screen icon. Desktop Chrome and Safari expose the camera in an ordinary tab,
 * so warning there would be wrong and just noise. The banner therefore keys off
 * the missing API rather than off "not installed".
 */
function InstallBanner({ needed, canInstall }: { needed: boolean; canInstall: boolean }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  if (!needed && !canInstall) return null
  return (
    <div className="flex items-start gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="mt-0.5 h-4 w-4 shrink-0">
        <path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
      </svg>
      <p className="flex-1 leading-relaxed">
        <strong className="font-semibold">Install for the camera.</strong> Add this
        page to your home screen and open it from the icon, otherwise the browser
        blocks the scanner.
      </p>
      {canInstall && (
        <button
          onClick={() => void promptInstall()}
          className="shrink-0 rounded-lg bg-amber-400 px-3 py-1.5 font-semibold text-ink-900 active:bg-amber-300"
        >
          Install
        </button>
      )}
      <button onClick={() => setDismissed(true)} className="text-amber-300/70" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

/** True when this browser is hiding the camera from us. */
function cameraHidden(): boolean {
  return !navigator.mediaDevices?.getUserMedia
}

function Shell() {
  const [needsInstall, setNeedsInstall] = useState(false)
  const { canInstall } = useInstall()

  useEffect(() => {
    // Repair the cached stock balances from the movement ledger on boot.
    void repairStockCache()

    // Ask the browser to keep the ledger instead of evicting it under storage
    // pressure. Best-effort: a rejected request just means "not persisted yet".
    void requestPersistentStorage()

    const check = () => setNeedsInstall(cameraHidden())
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  // Warm the audio context so the first scan beep is not swallowed.
  useEffect(() => {
    const prime = () => primeAudio()
    window.addEventListener('pointerdown', prime, { once: true })
    return () => window.removeEventListener('pointerdown', prime)
  }, [])

  // Start the cloud sync loop. It does nothing until a project is configured in
  // Settings, and it is deliberately below the lock gate: nothing syncs until
  // the app has been unlocked.
  useEffect(() => startSync(), [])

  return (
    <div className="flex min-h-dvh flex-col bg-ink-900">
      <InstallBanner needed={needsInstall} canInstall={canInstall} />
      <main className="flex-1 pb-20">
        <Outlet />
      </main>
      <TabBar />
    </div>
  )
}

export function App() {
  return (
    <CartProvider>
      <Shell />
    </CartProvider>
  )
}

export { db }