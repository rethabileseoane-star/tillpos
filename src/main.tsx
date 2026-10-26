import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Navigate, RouterProvider, createHashRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { AppLockProvider, useAppLock } from '@/features/security/LockContext'
import { SellScreen } from '@/features/sell/SellScreen'
import { CatalogScreen } from '@/features/catalog/CatalogScreen'
import { HistoryScreen } from '@/features/history/HistoryScreen'
import { MoneyScreen } from '@/features/money/MoneyScreen'
import { ReportsScreen } from '@/features/reports/ReportsScreen'
import { SettingsScreen } from '@/features/settings/SettingsScreen'
import './index.css'

/**
 * Owner-only route. The tab bar hides these links for a cashier, but the guard
 * is what makes a deep link, a browser back-stack entry, or a stale bookmark
 * fall back to Sell. A till with no staff roster is the legacy unlocked mode
 * and is treated as the owner.
 */
function OwnerOnly({ children }: { children: ReactNode }) {
  const { isOwner } = useAppLock()
  return isOwner ? <>{children}</> : <Navigate to="/" replace />
}

// hash routing keeps deep links working even from a static host with no
// server-side rewrite rules.
const router = createHashRouter([
  { path: '/', element: <App />, children: [
    { index: true, element: <SellScreen /> },
    { path: 'catalog', element: <CatalogScreen /> },
    { path: 'history', element: <OwnerOnly><HistoryScreen /></OwnerOnly> },
    { path: 'money', element: <OwnerOnly><MoneyScreen /></OwnerOnly> },
    { path: 'reports', element: <OwnerOnly><ReportsScreen /></OwnerOnly> },
    { path: 'settings', element: <OwnerOnly><SettingsScreen /></OwnerOnly> },
  ]},
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Above the router: a deep link must not render the till before the lock. */}
    <AppLockProvider>
      <RouterProvider router={router} />
    </AppLockProvider>
  </StrictMode>,
)

// Precache the whole app so it boots with no network. autoUpdate replaces the
// cache in the background rather than stranding the user on a stale version.
registerSW({ immediate: true })