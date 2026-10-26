import { useEffect, useState } from 'react'
import { loadedShop } from '@/db'
import { feedbackError, feedbackSuccess } from '@/ui/feedback'
import {
  listShops,
  switchShopNow,
  updateShopName,
  type ShopProfile,
} from '@/shops/registry'
import { addShop, suggestShopCode } from './shopManager'
import { loadShopName } from '@/features/settings/shopName'
import { runSync } from '@/sync/scheduler'

/**
 * Settings → Shops.
 *
 * The owner can add another shop on this phone and switch between them. Each
 * shop is a separate local database and a separate cloud login. Switching
 * reloads the app because the Dexie connection is opened once at module load.
 */
export function ShopCard() {
  const [shops, setShops] = useState<ShopProfile[]>(() => listShops())
  const [active] = useState<ShopProfile>(() => loadedShop)
  const [sheet, setSheet] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    // The name is shop-wide and may have arrived from another till. Keep the
    // picker's label in step with the name printed on reports.
    void loadShopName()
      .then((name) => {
        if (!name) return
        updateShopName(active.id, name)
        setShops(listShops())
      })
      .catch(() => undefined)
  }, [active.id])

  const switchTo = async (shop: ShopProfile) => {
    if (shop.id === active.id || busy) return
    if (
      !window.confirm(
        `Switch to ${shop.name}? Any uncompleted sale in the current shop will be lost.`,
      )
    ) {
      return
    }
    setBusy(shop.id)
    // Best-effort flush before the module reload. The outbox is durable, so a
    // timeout here loses nothing and the next visit sends the remainder.
    await Promise.race([
      runSync().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_500)),
    ])
    switchShopNow(shop.id)
  }

  return (
    <div className="card mt-3">
      <h2 className="text-sm font-semibold">Shops</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-400">
        Each shop keeps its own catalog, sales, cash, staff and cloud sync. The
        shop code is permanent and is also used by that shop's Supabase login.
      </p>

      <div className="mt-3 space-y-2">
        {shops.map((shop) => {
          const current = shop.id === active.id
          return (
            <div
              key={shop.id}
              className={`rounded-xl border p-3 ${
                current ? 'border-cash-500/40 bg-cash-500/5' : 'border-ink-700 bg-ink-800/60'
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{shop.name}</span>
                    {current && (
                      <span className="rounded-full bg-cash-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-cash-400">
                        Current
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500">{shop.id}</p>
                </div>
                {!current && (
                  <button
                    type="button"
                    className="btn-ghost shrink-0 !px-3 !py-1.5 text-xs"
                    disabled={busy !== null}
                    onClick={() => void switchTo(shop)}
                  >
                    {busy === shop.id ? 'Opening…' : 'Switch'}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <button
        type="button"
        className="btn-ghost mt-3 w-full !py-2.5 text-sm"
        disabled={busy !== null}
        onClick={() => setSheet(true)}
      >
        Add another shop
      </button>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        A new shop starts with the owner account only. Its catalog is empty, and
        it uses its own Supabase login with the same shop code.
      </p>

      {sheet && (
        <AddShopSheet
          onClose={() => setSheet(false)}
          onAdded={(shop) => {
            setShops(listShops())
            feedbackSuccess()
            // Keep the sheet open so the success panel can offer to open it.
            return shop
          }}
          onOpen={(shop) => void switchTo(shop)}
        />
      )}
    </div>
  )
}

function AddShopSheet({
  onClose,
  onAdded,
  onOpen,
}: {
  onClose: () => void
  onAdded: (shop: ShopProfile) => ShopProfile
  /** Switch to the new shop; the parent asks for confirmation and flushes sync. */
  onOpen: (shop: ShopProfile) => void
}) {
  const [name, setName] = useState('')
  const [code, setCode] = useState(() => suggestShopCode())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<ShopProfile | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const shop = await addShop({ name, code })
      setAdded(onAdded(shop))
    } catch (err) {
      feedbackError()
      setError(err instanceof Error ? err.message : 'Could not add the shop.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92dvh] w-full max-w-md animate-slideUp overflow-y-auto rounded-t-2xl bg-ink-800 p-4 pb-6 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add a shop"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600 sm:hidden" />

        {added ? (
          <>
            <h2 className="text-lg font-semibold">{added.name} is ready</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">
              It has the owner account and an empty catalog. Open it now to add
              products, staff and its cloud sync login. Its shop code is{' '}
              <span className="font-mono text-cash-300">{added.id}</span>.
            </p>
            <button
              type="button"
              className="btn-primary mt-5 w-full"
              disabled={busy}
              onClick={() => onOpen(added)}
            >
              Open {added.name}
            </button>
            <button type="button" className="btn-ghost mt-2 w-full" onClick={onClose}>
              Stay in the current shop
            </button>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">Add a shop</h2>
            <p className="mt-1 text-sm leading-relaxed text-slate-400">
              The owner account is copied to the new shop with the same owner
              password. No products, sales or cashiers are copied.
            </p>

            <label className="mt-4 block text-xs font-medium text-slate-400" htmlFor="shop-name">
              Shop name
            </label>
            <input
              id="shop-name"
              className="field mt-1 !py-2.5 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Maluti Traders — Town"
              maxLength={60}
              autoFocus
            />

            <label className="mt-3 block text-xs font-medium text-slate-400" htmlFor="shop-code">
              Shop code
            </label>
            <input
              id="shop-code"
              className="field mt-1 font-mono !py-2.5 text-sm"
              value={code}
              onChange={(e) => setCode(e.target.value.toLowerCase())}
              placeholder="shop-b"
              maxLength={32}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              Permanent. It must match this shop's Supabase login claim{' '}
              <span className="font-mono">app_metadata.shop_id</span>. Lowercase
              letters, numbers and hyphens only.
            </p>

            {error && (
              <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-200">
                {error}
              </p>
            )}

            <button
              type="button"
              className="btn-primary mt-5 w-full"
              disabled={busy || !name.trim() || !code.trim()}
              onClick={() => void submit()}
            >
              {busy ? 'Creating…' : 'Create shop'}
            </button>
            <button type="button" className="btn-ghost mt-2 w-full" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  )
}
