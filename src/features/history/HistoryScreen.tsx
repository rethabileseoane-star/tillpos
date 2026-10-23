import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { formatMaluti } from '@/domain/money'
import { businessDate, voidSale } from '@/features/sales/salesService'
import { downloadBlob } from '@/features/catalog/csvImport'
import { exportSalesCsv } from '@/features/reports/exportCsv'

export function HistoryScreen() {
  const today = businessDate()
  const [date, setDate] = useState(today)
  const [openSaleId, setOpenSaleId] = useState<string | null>(null)

  const sales =
    useLiveQuery(async () => {
      const rows = await db.sales.where('businessDate').equals(date).toArray()
      // Newest first. `.reverse().sortBy()` does not do this: sortBy re-sorts
      // ascending after the cursor direction is applied.
      return rows.sort((a, b) => b.createdAt - a.createdAt)
    }, [date]) ?? []

  const totals = sales.reduce(
    (acc, s) => {
      if (s.status === 'completed') {
        acc.gross += s.total
        acc.net += s.total
        acc.count++
      } else {
        acc.voided += s.total
        acc.voidCount++
      }
      return acc
    },
    { gross: 0, net: 0, count: 0, voided: 0, voidCount: 0 },
  )

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Sales</h1>
        <button
          onClick={() => void exportSalesCsv([date])}
          className="text-xs text-slate-400 underline"
        >
          Export day
        </button>
      </div>

      <input
        type="date"
        value={date}
        max={today}
        onChange={(e) => setDate(e.target.value || today)}
        className="field mt-3 font-mono"
      />

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="card !p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Sales</p>
          <p className="font-mono text-lg font-semibold">{totals.count}</p>
        </div>
        <div className="card !p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Net</p>
          <p className="font-mono text-lg font-semibold text-cash-400">
            {formatMaluti(totals.net)}
          </p>
        </div>
        <div className="card !p-2.5">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Voided</p>
          <p className="font-mono text-lg font-semibold text-amber-400">{totals.voidCount}</p>
        </div>
      </div>

      <ul className="mt-3 space-y-2">
        {sales.map((sale) => (
          <li key={sale.id}>
            <button
              onClick={() => setOpenSaleId(openSaleId === sale.id ? null : sale.id)}
              className={`card w-full !py-3 text-left ${
                sale.status === 'voided' ? 'opacity-60' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-mono text-sm font-semibold">
                    #{sale.receiptNo}
                    {sale.status === 'voided' && (
                      <span className="chip ml-2 bg-amber-500/20 text-amber-300">
                        VOIDED
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-slate-400">
                    {new Date(sale.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' · '}
                    {sale.paymentMethod}
                  </p>
                </div>
                <p
                  className={`font-mono text-lg font-semibold ${
                    sale.status === 'voided'
                      ? 'text-slate-400 line-through'
                      : 'text-cash-400'
                  }`}
                >
                  {formatMaluti(sale.total)}
                </p>
              </div>
            </button>

            {openSaleId === sale.id && (
              <SaleDetail
                saleId={sale.id}
                onVoided={() => setOpenSaleId(null)}
              />
            )}
          </li>
        ))}
        {sales.length === 0 && (
          <li className="py-8 text-center text-sm text-slate-500">
            No sales on {date}
          </li>
        )}
      </ul>
    </div>
  )
}

function SaleDetail({ saleId, onVoided }: { saleId: string; onVoided: () => void }) {
  const sale = useLiveQuery(() => db.sales.get(saleId), [saleId])
  const lines = useLiveQuery(
    () => db.saleLines.where('saleId').equals(saleId).toArray(),
    [saleId],
  )

  if (!sale) return null

  return (
    <div className="mt-2 animate-slideUp rounded-xl border border-ink-700 bg-ink-800 p-3">
      <ul className="space-y-1.5 text-sm">
        {(lines ?? []).map((l) => (
          <li key={l.id} className="flex justify-between gap-2">
            <span className="min-w-0 flex-1 truncate text-slate-300">
              {l.qty} × {l.name}
            </span>
            <span className="font-mono text-slate-400">{formatMaluti(l.lineTotal)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-3 border-t border-ink-700 pt-2 text-sm">
        <div className="flex justify-between">
          <span className="text-slate-400">Subtotal</span>
          <span className="font-mono">{formatMaluti(sale.subtotal)}</span>
        </div>
        {sale.amountTendered !== null && (
          <>
            <div className="flex justify-between text-slate-400">
              <span>Cash received</span>
              <span className="font-mono">{formatMaluti(sale.amountTendered)}</span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Change</span>
              <span className="font-mono">{formatMaluti(sale.change ?? 0)}</span>
            </div>
          </>
        )}
        <div className="mt-1 flex justify-between font-semibold">
          <span>Total</span>
          <span className="font-mono text-cash-400">{formatMaluti(sale.total)}</span>
        </div>
      </div>

      {sale.note && <p className="mt-2 text-xs text-slate-500">{sale.note}</p>}

      {sale.status === 'completed' && (
        <button
          className="btn-danger mt-3 w-full !py-2.5 text-sm"
          onClick={async () => {
            const reason = window.prompt('Reason for voiding this sale')
            if (reason === null) return
            await voidSale(sale.id, reason)
            onVoided()
          }}
        >
          Void sale
        </button>
      )}
    </div>
  )
}

export { downloadBlob }