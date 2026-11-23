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
import { LicenseNotice } from '@/licensing/LicenseGate'
import { startSync } from '@/sync/scheduler'

const NAV = [
  { to: '/', label: 'Sell', icon: 'M4 6h16M4 12h16M4 18h10' },
  { to: '/catalog', label: 'Catalog', icon: 'M3 7l9-4 9 4v10l-9 4-9-4V7z M3 7l9 4 9-4M12 11v10' },
  { to: '/history', label: 'History', icon: 'M12 8v5l3 2M21 12a9 9 0 11-3-6.7' },
  { to: '/tabs', label: 'Tabs', icon: 'M4 5h16v14H4z M8 9h8M8 13h5' },
  { to: '/money', label: 'Money', icon: 'M2 7h20v10H2z M2 10h20M6 14h4', ownerOnly: true },
  { to: '/reports', label: 'Z-Report', icon: 'M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3', ownerOnly: true },
  { to: '/settings', label: 'More', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6z M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008 19.4a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1A1.7 1.7 0 004.6 8a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V2a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H22a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z', ownerOnly: true },
]

function TabBar() {
  const { count, subtotal } = useCart()
  const { isOwner } = useAppLock()
  const items = NAV.filter((item) => isOwner || !item.ownerOnly)
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-surface-300 bg-ice-200/90 backdrop-blur">
      {count > 0 && (
        <div className="flex items-center justify-between border-b border-surface-300 px-4 py-1.5 text-sm">
          <span className="text-surface-600">
            {count} item{count === 1 ? '' : 's'} in cart
          </span>
          <span className="font-mono font-semibold text-cyan-600">
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
                    ? 'bg-cyan-400/20 text-cyan-600'
                    : 'text-surface-600 active:bg-surface-200 active:text-surface-900'
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

function InstallBanner({ needed, canInstall }: { needed: boolean; canInstall: boolean }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  if (!needed && !canInstall) return null
  return (
    <div className="flex items-start gap-3 border-b border-cyan-400/30 bg-cyan-400/10 px-4 py-2.5 text-xs text-cyan-600">
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
          className="shrink-0 rounded-lg bg-cyan-400 px-3 py-1.5 font-semibold text-white active:bg-cyan-500"
        >
          Install
        </button>
      )}
      <button onClick={() => setDismissed(true)} className="text-cyan-400/70" aria-label="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

function cameraHidden(): boolean {
  return !navigator.mediaDevices?.getUserMedia
}

function Shell() {
  const [needsInstall, setNeedsInstall] = useState(false)
  const { canInstall } = useInstall()

  useEffect(() => {
    void repairStockCache()
    void requestPersistentStorage()
    const check = () => setNeedsInstall(cameraHidden())
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  useEffect(() => {
    const prime = () => primeAudio()
    window.addEventListener('pointerdown', prime, { once: true })
    return () => window.removeEventListener('pointerdown', prime)
  }, [])

  useEffect(() => startSync(), [])

  return (
    <div className="flex min-h-dvh flex-col bg-ice-100">
      <LicenseNotice />
      <InstallBanner needed={needsInstall} canInstall={canInstall} />

      {/* Top bar with TILL logo */}
      <header className="sticky top-0 z-50 border-b border-surface-300 bg-ice-200/80 backdrop-blur px-4 py-3">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="TILL" className="h-8 w-8 rounded-lg shadow-lg" />
          <span className="font-bold text-surface-900 text-lg tracking-tight">TILL</span>
        </div>
      </header>

      <main className="flex-1 pb-24">
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
