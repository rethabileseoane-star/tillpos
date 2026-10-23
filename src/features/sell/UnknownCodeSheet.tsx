import { useEffect, useState } from 'react'
import { parseAmount, formatMaluti } from '@/domain/money'
import { normalizeBarcode } from '@/domain/barcode'
import type { Cents } from '@/domain/money'

interface Props {
  code: string | null
  onClose: () => void
  onSave: (input: { barcode: string; name: string; unitPrice: Cents }) => void
}

/**
 * Unknown-barcode capture.
 *
 * Shown when a scanned code is not in the catalog. The seller names it and
 * prices it on the spot; the line is added ad-hoc and a real product is created
 * at checkout, so the next scan of the same label resolves instantly.
 */
export function UnknownCodeSheet({ code, onClose, onSave }: Props) {
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')

  useEffect(() => {
    if (code) {
      setName('')
      setPrice('')
    }
  }, [code])

  if (!code) return null
  const parsed = parseAmount(price)
  const valid = name.trim().length > 0 && parsed !== null

  const submit = () => {
    if (!valid) return
    onSave({ barcode: normalizeBarcode(code), name: name.trim(), unitPrice: parsed! })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/70" onClick={onClose}>
      <div
        className="w-full animate-slideUp rounded-t-2xl bg-ink-800 p-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-600" />

        <h2 className="text-lg font-semibold">New item</h2>
        <p className="mt-0.5 font-mono text-xs text-slate-400">
          {normalizeBarcode(code)}
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="label" htmlFor="adhoc-name">Item name</label>
            <input
              id="adhoc-name"
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sugar 1kg"
              autoFocus
            />
          </div>
          <div>
            <label className="label" htmlFor="adhoc-price">Price (Maluti)</label>
            <input
              id="adhoc-price"
              className="field font-mono"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
            />
            {parsed !== null && (
              <p className="mt-1 text-xs text-cash-400">{formatMaluti(parsed)}</p>
            )}
          </div>
        </div>

        <div className="mt-5 flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>
            Skip
          </button>
          <button className="btn-primary flex-1" onClick={submit} disabled={!valid}>
            Add to cart
          </button>
        </div>
      </div>
    </div>
  )
}