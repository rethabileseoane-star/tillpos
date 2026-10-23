import type { CartLine } from '@/features/cart/cartStore'
import { lineTotal, linesExceedingStock } from '@/features/cart/cartStore'
import { formatMaluti } from '@/domain/money'
import type { Product } from '@/db/types'

interface Props {
  lines: CartLine[]
  products: Product[]
  onChangeQty: (key: string, qty: number) => void
  onRemove: (key: string) => void
  onClear: () => void
}

export function CartPanel({ lines, products, onChangeQty, onRemove, onClear }: Props) {
  if (lines.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-slate-500">
          Scan a barcode to add an item
        </p>
      </div>
    )
  }

  const overStock = linesExceedingStock(lines)

  return (
    <div className="px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Cart
        </h2>
        <button onClick={onClear} className="text-xs text-slate-500 underline">
          Clear all
        </button>
      </div>

      <ul className="space-y-2">
        {lines.map((line) => {
          const product = products.find((p) => p.id === line.productId)
          // Stock is deducted at checkout, so the cart may exceed it mid-sale.
          const exceeds = line.stockAtAdd !== null && line.qty > line.stockAtAdd
          const low =
            !exceeds &&
            line.stockAtAdd !== null &&
            line.stockAtAdd - line.qty <= (product?.lowStockThreshold ?? 0)

          return (
            <li key={line.key} className="card flex items-center gap-3 !py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{line.name}</p>
                <p className="font-mono text-xs text-slate-400">
                  {formatMaluti(line.unitPrice)} each
                  {line.adHoc && (
                    <span className="chip ml-1.5 bg-indigo-500/20 text-indigo-300">ad-hoc</span>
                  )}
                </p>
                {exceeds && (
                  <p className="mt-0.5 text-[11px] text-amber-400">
                    Only {line.stockAtAdd} in stock
                  </p>
                )}
                {low && (
                  <p className="mt-0.5 text-[11px] text-slate-500">Low stock after this sale</p>
                )}
              </div>

              {/* Quantity stepper: 44px targets for gloved or fast tapping. */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onChangeQty(line.key, line.qty - 1)}
                  aria-label="Decrease quantity"
                  className="flex h-11 w-11 items-center justify-center rounded-lg bg-ink-700 text-lg active:bg-ink-600"
                >
                  −
                </button>
                <span className="w-8 text-center font-mono text-lg">{line.qty}</span>
                <button
                  onClick={() => onChangeQty(line.key, line.qty + 1)}
                  aria-label="Increase quantity"
                  className="flex h-11 w-11 items-center justify-center rounded-lg bg-ink-700 text-lg active:bg-ink-600"
                >
                  +
                </button>
              </div>

              <div className="w-24 shrink-0 text-right">
                <p className="font-mono font-semibold">{formatMaluti(lineTotal(line))}</p>
                <button
                  onClick={() => onRemove(line.key)}
                  className="text-[11px] text-slate-500 underline"
                >
                  remove
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      {overStock.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {overStock.length} line{overStock.length === 1 ? '' : 's'} exceed available stock.
          The sale will still go through and stock will go negative so you can
          reconcile later.
        </p>
      )}
    </div>
  )
}