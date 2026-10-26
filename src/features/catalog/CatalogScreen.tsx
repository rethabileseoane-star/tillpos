import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, withSyncMeta } from '@/db'
import type { Product } from '@/db/types'
import { formatMaluti } from '@/domain/money'
import { adjustStock } from '@/features/sales/salesService'
import { useAppLock } from '@/features/security/LockContext'
import { queueEntity } from '@/sync/outbox'
import {
  downloadBlob,
  exportProductsCsv,
  importProducts,
  type ImportResult,
} from './csvImport'
import { ProductEditor } from './ProductEditor'
import { exportCatalogPdf } from './exportCatalogPdf'

export function CatalogScreen() {
  const { isOwner } = useAppLock()
  // A cashier may look up a price or check stock, but the catalog is read-only:
  // no add/edit/import/export/stock adjustment, and no cost or profit figures.
  const readOnly = !isOwner
  const products =
    useLiveQuery(() => db.products.orderBy('name').toArray(), []) ?? []
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<Product | null>(null)
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [showDeleted, setShowDeleted] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // `== null` (loose) so a legacy row missing the column counts as live
  // rather than silently vanishing from the catalog.
  const activeProducts = products.filter((p) => p.deletedAt == null)
  const deletedProducts = products.filter((p) => p.deletedAt != null)

  // Deleted items are an owner-only recovery view. A cashier sees the live shelf.
  const visibleProducts = readOnly
    ? activeProducts
    : showDeleted
      ? products
      : activeProducts

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return visibleProducts
    return visibleProducts.filter((p) => {
      const barcodes = p.barcodes ?? [p.barcode]
      return (
        p.name.toLowerCase().includes(q) ||
        barcodes.some((b) => b.toLowerCase().includes(q)) ||
        p.category.toLowerCase().includes(q) ||
        (p.details ?? '').toLowerCase().includes(q)
      )
    })
  }, [visibleProducts, query])

  const lowStock = activeProducts.filter(
    (p) => p.stockQty <= p.lowStockThreshold && p.lowStockThreshold > 0,
  )

  const totalCost = useMemo(
    () =>
      activeProducts.reduce((sum, p) => sum + (p.cost ?? p.price) * p.stockQty, 0),
    [activeProducts],
  )
  const totalRetail = useMemo(
    () => activeProducts.reduce((sum, p) => sum + p.price * p.stockQty, 0),
    [activeProducts],
  )

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    try {
      setResult(await importProducts(file))
    } catch (err) {
      setResult({
        created: 0,
        updated: 0,
        skipped: 1,
        errors: [
          {
            row: 0,
            barcode: '',
            reason: err instanceof Error ? err.message : 'Import failed',
          },
        ],
        duplicates: [],
      })
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const stepStock = async (product: Product, delta: number) => {
    const next =
      delta < 0 && product.stockQty >= 0
        ? Math.max(0, product.stockQty + delta)
        : product.stockQty + delta
    try {
      await adjustStock(product.id, next, 'Catalog +/−')
    } catch {
      // A race with another write is not worth surfacing; the row simply
      // refreshes via the live query.
    }
  }

  const deleteProduct = async (product: Product) => {
    setDeleteConfirm({ id: product.id, name: product.name })
  }

  const confirmDelete = async () => {
    if (!deleteConfirm) return
    setBusy(true)
    try {
      await db.transaction('rw', db.products, db.outbox, async () => {
        const product = await db.products.get(deleteConfirm.id)
        if (!product) return
        const removed = withSyncMeta(product, {
          ...product,
          deletedAt: Date.now(),
          active: false,
        }) as Product
        await db.products.put(removed)
        await queueEntity('products', removed.id, 'upsert', removed)
      })
      setDeleteConfirm(null)
    } catch (err) {
      setDeleteConfirm(null)
      console.error('Delete failed', err)
    } finally {
      setBusy(false)
    }
  }

  const restoreProduct = async (product: Product) => {
    setBusy(true)
    try {
      await db.transaction('rw', db.products, db.outbox, async () => {
        const restored = withSyncMeta(product, {
          ...product,
          deletedAt: null,
          active: true,
        }) as Product
        await db.products.put(restored)
        await queueEntity('products', restored.id, 'upsert', restored)
      })
    } catch (err) {
      console.error('Restore failed', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Catalog</h1>
        <span className="text-xs text-slate-400">
          Showing {filtered.length} of {activeProducts.length} item{
            activeProducts.length === 1 ? '' : 's'
          }
          {!readOnly &&
            deletedProducts.length > 0 &&
            ` · ${deletedProducts.length} deleted`}
        </span>
      </div>

      <input
        className="field mt-3"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search name, barcode, or details"
      />

      {!readOnly && showDeleted && (
        <button
          className="mt-3 text-xs text-amber-400 underline hover:text-amber-300"
          onClick={() => setShowDeleted(false)}
        >
          ← Hide deleted items
        </button>
      )}
      {!readOnly && !showDeleted && deletedProducts.length > 0 && (
        <button
          className="mt-3 text-xs text-slate-400 underline hover:text-slate-300"
          onClick={() => setShowDeleted(true)}
        >
          {deletedProducts.length} deleted item{
            deletedProducts.length === 1 ? '' : 's'
          } — show
        </button>
      )}

      {!readOnly && (
        <>
          <div className="mt-3 flex gap-2 flex-wrap">
            <button className="btn-ghost flex-1 !py-2.5 text-sm" onClick={() => setCreating(true)}>
              Add item
            </button>
            <button
              className="btn-ghost flex-1 !py-2.5 text-sm"
              onClick={() => fileRef.current?.click()}
              disabled={busy}
            >
              {busy ? 'Importing…' : 'Import CSV'}
            </button>
            <button
              className="btn-ghost !px-3 !py-2.5 text-sm"
              aria-label="Export catalog CSV"
              onClick={async () =>
                downloadBlob(await exportProductsCsv(), `catalog-${today()}.csv`)
              }
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
                <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
              </svg>
            </button>
            <button
              className="btn-primary !px-3 !py-2.5 text-sm"
              aria-label="Export catalog PDF"
              onClick={async () => {
                const blob = await exportCatalogPdf(activeProducts)
                downloadBlob(blob, `catalog-${today()}.pdf`)
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-5 w-5">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                <path d="M14 2v6h6M16 13H8M16 17H8M14 15H8" />
              </svg>
              PDF
            </button>
          </div>

          {/* xlsx works too, so the accept list is broad. */}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            className="hidden"
            onChange={(e) => void handleFile(e.target.files?.[0])}
          />
        </>
      )}

      {!readOnly && result && (
        <div className="mt-3 rounded-xl border border-ink-700 bg-ink-800 p-3 text-xs">
          <div className="flex items-start justify-between gap-2">
            <p>
              <strong className="text-cash-400">{result.created} added</strong>,{' '}
              <strong className="text-slate-300">{result.updated} updated</strong>
              {result.skipped > 0 && (
                <>
                  , <span className="text-amber-400">{result.skipped} skipped</span>
                </>
              )}
            </p>
            <button onClick={() => setResult(null)} className="text-slate-500">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-4 w-4">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {result.errors.length > 0 && (
            <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-slate-400">
              {result.errors.slice(0, 20).map((e, i) => (
                <li key={i}>
                  Row {e.row || '?'}: {e.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {lowStock.length > 0 && (
        <div className="mt-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {lowStock.length} item{lowStock.length === 1 ? '' : 's'} at or below
          reorder level
        </div>
      )}

      <ul className="mt-3 space-y-2">
        {filtered.map((p) => (
          <li key={p.id} className="card flex items-center gap-3 !py-3">
            {readOnly ? (
              <div className="min-w-0 flex-1">
                <ProductInfo product={p} />
              </div>
            ) : (
              <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(p)}>
                <ProductInfo product={p} />
              </button>
            )}

            {!readOnly && p.deletedAt != null && (
              <button
                onClick={() => void restoreProduct(p)}
                aria-label="Restore item"
                className="h-10 w-10 rounded-lg bg-ink-700 active:bg-ink-600 text-cash-400"
              >
                ↻
              </button>
            )}

            {!readOnly && p.deletedAt == null && (
              <>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => void stepStock(p, -1)}
                    aria-label="Decrease stock"
                    className="h-10 w-10 rounded-lg bg-ink-700 active:bg-ink-600"
                  >
                    −
                  </button>
                  <button
                    onClick={() => void stepStock(p, 1)}
                    aria-label="Increase stock"
                    className="h-10 w-10 rounded-lg bg-ink-700 active:bg-ink-600"
                  >
                    +
                  </button>
                </div>

                <button
                  onClick={() => deleteProduct(p)}
                  aria-label="Delete item"
                  className="h-10 w-10 rounded-lg bg-ink-700 active:bg-ink-600 text-red-400"
                >
                  ×
                </button>
              </>
            )}

            <div className="w-24 text-right">
              <p
                className={`font-mono text-sm font-semibold ${
                  p.stockQty <= 0
                    ? 'text-red-400'
                    : p.lowStockThreshold > 0 && p.stockQty <= p.lowStockThreshold
                      ? 'text-amber-400'
                      : 'text-slate-300'
                }`}
              >
                {p.stockQty}
              </p>
              <p className="font-mono text-xs text-cash-400">{formatMaluti(p.price)}</p>
              {!readOnly && (
                <>
                  <p className="font-mono text-xs text-slate-400">
                    {formatMaluti(p.cost ?? p.price)}
                  </p>
                  {(() => {
                    const cost = p.cost ?? p.price
                    const unitProfit = p.price - cost
                    const totalProfit = unitProfit * p.stockQty
                    return (
                      <>
                        <p className="font-mono text-xs ${
                          unitProfit < 0 ? 'text-red-400' : 'text-cash-400'
                        }">M{u(unitProfit)} each</p>
                        <p className="font-mono text-xs text-slate-400">M{u(totalProfit)} total</p>
                      </>
                    )
                  })()}
                </>
              )}
            </div>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="py-8 text-center text-sm text-slate-500">
            {activeProducts.length === 0
              ? readOnly
                ? 'No products in the catalog yet.'
                : 'No products yet. Import a CSV or tap Add item.'
              : !readOnly && showDeleted
                ? 'No deleted items'
                : !readOnly && deletedProducts.length > 0
                  ? 'No matches — try showing deleted items'
                  : 'No matches for that search'}
          </li>
        )}
      </ul>

      {activeProducts.length > 0 && (
        <div className="mt-4 rounded-xl border border-ink-700 bg-ink-800/50 p-3 text-xs">
          <div className={`grid gap-4 text-center ${readOnly ? 'grid-cols-2' : 'grid-cols-3'}`}>
            <div>
              <p className="text-slate-400 uppercase text-[10px] tracking-wider">Stock on hand</p>
              <p className="font-mono text-sm font-semibold text-slate-300">
                {activeProducts.reduce((s, p) => s + p.stockQty, 0)} units
              </p>
            </div>
            {!readOnly && (
              <div>
                <p className="text-slate-400 uppercase text-[10px] tracking-wider">Cost value</p>
                <p className="font-mono text-sm font-semibold text-slate-400">{formatMaluti(totalCost)}</p>
              </div>
            )}
            <div>
              <p className="text-slate-400 uppercase text-[10px] tracking-wider">Retail value</p>
              <p className="font-mono text-sm font-semibold text-cash-400">{formatMaluti(totalRetail)}</p>
            </div>
            {!readOnly && (
              <div>
                <p className="text-slate-400 uppercase text-[10px] tracking-wider">Potential profit</p>
                <p className="font-mono text-sm font-semibold text-cash-400">
                  {formatMaluti(totalRetail - totalCost)}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {!readOnly && (creating || editing) && (
        <ProductEditor
          product={editing}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
        />
      )}

      {!readOnly && deleteConfirm && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/80" onClick={() => setDeleteConfirm(null)}>
          <div
            className="w-full max-w-md rounded-2xl bg-ink-800 p-5 border border-ink-700"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-1">Delete item?</h3>
            <p className="text-xs text-slate-400 mb-4">
              "{deleteConfirm.name}" will be removed from your catalogue. Past
              sales that used this product will still show in history.
            </p>
            <div className="flex gap-2">
              <button
                className="btn-ghost flex-1"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="btn-primary flex-1 text-red-400"
                onClick={confirmDelete}
                disabled={busy}
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ProductInfo({ product: p }: { product: Product }) {
  return (
    <>
      <p className="truncate font-medium">{p.name}</p>
      <p className="font-mono text-xs text-slate-400">
        {(p.barcodes ?? [p.barcode]).join(', ')}
      </p>
      {p.details && (
        <p className="text-[10px] text-slate-500 truncate max-w-[200px]">
          {p.details}
        </p>
      )}
      {p.deletedAt != null && (
        <p className="text-[10px] text-amber-400 mt-1">Deleted — tap to restore</p>
      )}
    </>
  )
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Format a cent value as Maluti without the "M" prefix for inline use. */
function u(cents: number): string {
  const whole = Math.floor(Math.abs(cents) / 100)
  const frac = Math.abs(cents) % 100
  const sign = cents < 0 ? '-' : ''
  const body = frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0')}`
  return `${sign}${body}`
}
