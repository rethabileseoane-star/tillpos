import { useState } from 'react'
import { loadedShop } from '@/db'
import { listShops, switchShopNow, type ShopProfile } from '@/shops/registry'

/**
 * The shop picker shown on the lock screen.
 *
 * Switching shops does not require a password: the phone reloads and opens the
 * other shop's own lock screen. The owner's password (or a cashier's PIN) for
 * that shop is still required before any of its data appears.
 */
export function ShopSwitchSheet({
  onClose,
}: {
  onClose: () => void
}) {
  const [shops] = useState<ShopProfile[]>(() => listShops())
  const [active] = useState<ShopProfile>(() => loadedShop)
  const [busy, setBusy] = useState<string | null>(null)

  const choose = (shop: ShopProfile) => {
    if (shop.id === active.id) {
      onClose()
      return
    }
    setBusy(shop.id)
    switchShopNow(shop.id)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/80 sm:items-center sm:justify-center sm:p-4">
      <div className="max-h-[92dvh] w-full animate-slideUp overflow-y-auto rounded-t-2xl bg-ink-800 p-4 pb-6 sm:max-w-md sm:rounded-2xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600 sm:hidden" />
        <h2 className="text-lg font-semibold">Switch shop</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-400">
          Each shop has its own catalog, sales, cash drawer, staff and app lock.
        </p>

        <div className="mt-4 space-y-2">
          {shops.map((shop) => {
            const current = shop.id === active.id
            return (
              <button
                key={shop.id}
                type="button"
                disabled={busy !== null}
                onClick={() => choose(shop)}
                className={`card flex w-full items-center gap-3 !py-3 text-left active:bg-ink-700 ${
                  current ? 'border-cash-500/50' : ''
                }`}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ink-700 font-semibold text-cash-400">
                  {initials(shop.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{shop.name}</span>
                  <span className="block font-mono text-[11px] text-slate-500">{shop.id}</span>
                </span>
                {current ? (
                  <span className="rounded-full bg-cash-500/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-cash-400">
                    Current
                  </span>
                ) : (
                  <span className="text-xs text-slate-400">
                    {busy === shop.id ? 'Opening…' : 'Open'}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <button type="button" className="btn-ghost mt-4 w-full !py-2.5 text-sm" onClick={onClose}>
          Back to sign in
        </button>
      </div>
    </div>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] ?? ''}${parts.at(-1)![0] ?? ''}`.toUpperCase()
}
