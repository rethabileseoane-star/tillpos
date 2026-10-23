import { useRef, useState } from 'react'
import { db, withSyncMeta } from '@/db'
import type { Product, StockMovement } from '@/db/types'
import { formatMaluti, parseAmount } from '@/domain/money'
import { isValidBarcode, normalizeBarcode } from '@/domain/barcode'
import { queueEntity } from '@/sync/outbox'
import { BarcodeScanSheet } from '@/features/scanner/BarcodeScanSheet'

interface Props {
  product: Product | null
  onClose: () => void
}

export function ProductEditor({ product, onClose }: Props) {
  const [barcodes, setBarcodes] = useState<string[]>(product?.barcodes ?? [product?.barcode ?? ''])
  const [name, setName] = useState(product?.name ?? '')
  const [details, setDetails] = useState(product?.details ?? '')
  const [price, setPrice] = useState(product ? String(product.price / 100) : '')
  const [cost, setCost] = useState(
    product ? String((product.cost ?? product.price) / 100) : '',
  )
  const [stock, setStock] = useState(product ? String(product.stockQty) : '0')
  const [threshold, setThreshold] = useState(
    product ? String(product.lowStockThreshold) : '0',
  )
  const [category, setCategory] = useState(product?.category ?? '')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)

  const parsedPrice = parseAmount(price)
  const parsedCost = parseAmount(cost)
  const profit = parsedPrice !== null && parsedCost !== null ? parsedPrice - parsedCost : null
  const allValid =
    name.trim().length > 0 &&
    parsedPrice !== null &&
    barcodes.some((b) => isValidBarcode(normalizeBarcode(b)))

  const addBarcode = () => {
    const next = [...barcodes, '']
    setBarcodes(next)
    setError(null)
  }

  const removeBarcode = (index: number) => {
    if (barcodes.length <= 1) {
      setError('A product needs at least one barcode')
      return
    }
    setBarcodes(barcodes.filter((_, i) => i !== index))
    setError(null)
  }

  const setBarcodeAt = (index: number, value: string) => {
    const next = [...barcodes]
    next[index] = value
    setBarcodes(next)
    setError(null)
  }

  const save = async () => {
    if (!allValid || parsedPrice === null) return
    setBusy(true)
    setError(null)
    try {
      await db.transaction('rw', db.products, db.stockMovements, db.outbox, async () => {
        const normalized = barcodes.map((b) => normalizeBarcode(b)).filter(Boolean)

        // No two products may share a barcode.
        const clash = await db.products
          .where('barcodes')
          .anyOf(...normalized)
          .first()
        if (clash && clash.id !== product?.id) {
          throw new Error('That barcode is already used by another item')
        }

        if (product) {
          const newStock = Number(stock) || 0
          const stockChanged = newStock !== product.stockQty
          const updated = withSyncMeta(product, {
            ...product,
            barcode: normalized[0] ?? '',
            barcodes: normalized,
            name: name.trim(),
            details: details.trim() || undefined,
            price: parsedPrice,
            cost: parsedCost ?? parsedPrice,
            lowStockThreshold: Math.max(0, Number(threshold) || 0),
            category: category.trim() || 'Uncategorised',
            stockQty: newStock,
          }) as Product
          await db.products.put(updated)
          await queueEntity('products', updated.id, 'upsert', updated)

          if (stockChanged) {
            const movement = withSyncMeta(undefined, {
              productId: product.id,
              delta: newStock - product.stockQty,
              reason: 'adjust' as const,
              refId: null,
              note: note.trim() || 'Manual edit',
            }) as StockMovement
            await db.stockMovements.put(movement)
            await queueEntity('stock_movements', movement.id, 'upsert', movement)
          }
        } else {
          const created = withSyncMeta(undefined, {
            barcode: normalized[0] ?? '',
            barcodes: normalized,
            name: name.trim(),
            details: details.trim() || undefined,
            price: parsedPrice,
            cost: parsedCost ?? parsedPrice,
            stockQty: Number(stock) || 0,
            lowStockThreshold: Math.max(0, Number(threshold) || 0),
            category: category.trim() || 'Uncategorised',
            active: true,
          }) as Product
          await db.products.put(created)
          await queueEntity('products', created.id, 'upsert', created)

          if (created.stockQty !== 0) {
            const movement = withSyncMeta(undefined, {
              productId: created.id,
              delta: created.stockQty,
              reason: 'opening' as const,
              refId: null,
              note: note.trim() || 'Opening stock',
            }) as StockMovement
            await db.stockMovements.put(movement)
            await queueEntity('stock_movements', movement.id, 'upsert', movement)
          }
        }
      })
      onClose()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not save. Is a barcode already used?',
      )
    } finally {
      setBusy(false)
    }
  }

  const onScanned = async (code: string) => {
    const normalized = normalizeBarcode(code)
    setScanOpen(false)
    if (!normalized) return

    // If this code is already on the product, just focus the name field.
    if (barcodes.map((b) => normalizeBarcode(b)).includes(normalized)) {
      setError(null)
      nameRef.current?.focus()
      return
    }

    const existing = await db.products.where('barcodes').anyOf(normalized).first()
    if (existing) {
      setError(`"${existing.name}" already uses that barcode — open it from the list and edit instead.`)
    } else if (barcodes.length === 0 || (barcodes.length === 1 && barcodes[0] === '')) {
      setBarcodes([normalized])
    } else {
      setBarcodes([...barcodes, normalized])
    }
    nameRef.current?.focus()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/75" onClick={onClose}>
      <div
        className="max-h-[92dvh] w-full animate-slideUp overflow-y-auto rounded-t-2xl bg-ink-800 p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />
        <h2 className="text-lg font-semibold">
          {product ? 'Edit item' : 'Add item'}
        </h2>

        <div className="mt-4 space-y-3">
          {/* Barcodes */}
          <div>
            <label className="label" htmlFor="pe-barcodes">Barcodes</label>
            <p className="text-[10px] text-slate-500 mb-1">
              Scan or type each barcode. The first one is the primary.
            </p>
            <div className="space-y-2">
              {barcodes.map((bc, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    id={`pe-barcode-${i}`}
                    className="field min-w-0 flex-1 font-mono"
                    inputMode="numeric"
                    value={bc}
                    onChange={(e) => setBarcodeAt(i, e.target.value)}
                    placeholder={`Barcode ${i + 1}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeBarcode(i)}
                    disabled={barcodes.length <= 1}
                    className="shrink-0 h-9 w-9 rounded-lg bg-ink-700 active:bg-ink-600 text-red-400"
                    aria-label="Remove barcode"
                  >
                    −
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addBarcode}
                className="w-fit text-xs text-cash-400 underline"
              >
                + Add another barcode
              </button>
              <button
                type="button"
                className="btn-ghost shrink-0"
                onClick={() => setScanOpen(true)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="mr-1 inline h-4 w-4">
                  <path d="M3 7V5a2 2 0 012-2h2m10 0h2a2 2 0 012 2v2m0 10v2a2 2 0 01-2 2h-2M7 20H5a2 2 0 01-2-2v-2M3 12h18" />
                </svg>
                Scan barcode
              </button>
              {barcodes.some((b) => b && !isValidBarcode(normalizeBarcode(b))) && (
                <p className="mt-1 text-xs text-red-400">One or more barcodes look invalid</p>
              )}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="pe-name">Name</label>
            <input
              id="pe-name"
              ref={nameRef}
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Item name"
            />
          </div>

          <div>
            <label className="label" htmlFor="pe-details">Product details</label>
            <textarea
              id="pe-details"
              className="field font-mono"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Description, size, variant, etc."
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="pe-price">Selling price (M)</label>
              <input
                id="pe-price"
                className="field font-mono"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0.00"
              />
              {parsedPrice !== null && (
                <p className="mt-1 text-xs text-cash-400">{formatMaluti(parsedPrice)}</p>
              )}
            </div>
            <div>
              <label className="label" htmlFor="pe-cost">Cost (M)</label>
              <input
                id="pe-cost"
                className="field font-mono"
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="Same as price"
              />
              {parsedCost !== null && (
                <p className="mt-1 text-xs text-slate-400">{formatMaluti(parsedCost)} each</p>
              )}
            </div>
          </div>

          {parsedPrice !== null && parsedCost !== null && (
            <div className="bg-ink-700/50 rounded-lg p-2">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Profit per unit</p>
              <p className={`font-mono text-sm font-semibold ${
                profit !== null && profit < 0 ? 'text-red-400' : 'text-cash-400'
              }`}>
                {formatMaluti(profit ?? 0)}
              </p>
            </div>
          )}

          <div>
            <label className="label" htmlFor="pe-cat">Category</label>
            <input
              id="pe-cat"
              className="field"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="pe-stock">Stock</label>
              <input
                id="pe-stock"
                className="field font-mono"
                inputMode="numeric"
                value={stock}
                onChange={(e) => setStock(e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="pe-threshold">Low-stock alert at</label>
              <input
                id="pe-threshold"
                className="field font-mono"
                inputMode="numeric"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </div>
          </div>

          {product && (
            <div>
              <label className="label" htmlFor="pe-note">Stock note</label>
              <input
                id="pe-note"
                className="field"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why is stock changing?"
              />
            </div>
          )}
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-red-500/15 px-3 py-2 text-xs text-red-300">{error}</p>
        )}

        <div className="mt-5 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary flex-1" onClick={() => void save()} disabled={!allValid || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {scanOpen && (
        <BarcodeScanSheet
          title="Scan the item's barcode"
          onDetected={(code) => void onScanned(code)}
          onClose={() => setScanOpen(false)}
        />
      )}
    </div>
  )
}
