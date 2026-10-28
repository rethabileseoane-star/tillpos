import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { formatMaluti, type Cents } from '@/domain/money'
import { businessDate } from '@/features/sales/salesService'
import { summariseCash } from '@/features/cash/cashService'
import { creditTotals, customerCreditTotals } from '@/features/credit/credit'
import { exportSalesCsv } from './exportCsv'
import {
  exportCashLedgerCsv,
  exportCreditJournalCsv,
  exportStatementsCsv,
  exportStockLedgerCsv,
} from './exportAccounts'
import { downloadBlob } from '@/features/catalog/csvImport'
import { feedbackError } from '@/ui/feedback'
import type { Sale, SaleLine } from '@/db/types'

export interface DayReport {
  date: string
  saleCount: number
  gross: Cents
  voidCount: number
  voided: Cents
  net: Cents
  itemsSold: number
  topItems: { name: string; qty: number; total: Cents }[]
}

export function ReportsScreen() {
  const [days, setDays] = useState(14)
  const today = businessDate()

  const sales =
    useLiveQuery(
      () => db.sales.orderBy('createdAt').reverse().limit(2000).toArray(),
      [],
    ) ?? []

  const lines =
    useLiveQuery(() => db.saleLines.limit(20000).toArray(), []) ?? []

  const cash = useLiveQuery(() => db.cashMovements.toArray(), []) ?? []

  // The Z-report's sales list is capped for speed; the debt position needs the
  // whole book, so read every sale for that one figure.
  const allSales = useLiveQuery(() => db.sales.toArray(), []) ?? []

  const report = useMemo(() => buildReport(sales, lines, days), [sales, lines, days])
  const window = useMemo(
    () => summariseCash(cash, report.days.map((d) => d.date)),
    [cash, report],
  )
  const credit = useMemo(
    () => creditTotals(allSales, cash, report.days.map((d) => d.date)),
    [allSales, cash, report],
  )
  const customerCredits = useMemo(
    () => customerCreditTotals(allSales, cash).total,
    [allSales, cash],
  )

  // Windows for the exports: the report's dates, plus a timestamp range for the
  // stock ledger (stock movements carry created-at times, not business dates).
  const rangeDates = report.days.map((d) => d.date)
  const range = `${rangeDates[0] ?? today}-to-${today}`
  const stockStart = rangeDates[0]
    ? new Date(`${rangeDates[0]}T00:00:00`).getTime()
    : undefined
  const stockEnd = new Date(`${today}T00:00:00`).getTime() + 86_400_000

  const trend = useMemo(() => {
    const max = Math.max(...report.trend.map((d) => d.net), 1)
    return report.trend.map((d) => ({ ...d, pct: (d.net / max) * 100 }))
  }, [report])

  return (
    <div className="px-4 py-4">
      <h1 className="text-xl font-bold">Z-Report</h1>
      <p className="text-xs text-slate-400">
        Cash, sales and credit for the last {days} days
      </p>

      <div className="mt-3 flex gap-2">
        {[7, 14, 30].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`btn flex-1 !py-2 text-sm ${
              days === d ? 'bg-cash-500 text-ink-900' : 'bg-ink-700'
            }`}
          >
            {d} days
          </button>
        ))}
      </div>

      {/* The drawer, front and centre: this is the number that must match the tin. */}
      <div className="card mt-4 border-cash-500/40 bg-cash-500/10 shadow-lift">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-slate-400">
              Cash in the drawer
            </p>
            <p className="mt-1 font-mono text-3xl font-bold text-cash-400">
              {formatMaluti(window.balance)}
            </p>
          </div>
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cash-500/20 text-cash-400">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-6 w-6">
              <path d="M2 7h20v10H2z M2 10h20M6 14h4" />
            </svg>
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Running total of every cash movement, from the opening float to now.
          Count the tin and compare.
        </p>
      </div>

      {/* Money in and out over the selected window */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Cash sales ({days}d)</p>
          <p className="font-mono text-lg font-semibold text-cash-400">
            {formatMaluti(window.sales)}
          </p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Credit collected ({days}d)</p>
          <p className="font-mono text-lg font-semibold text-cash-400">
            {formatMaluti(window.creditPayments)}
          </p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Opening float ({days}d)</p>
          <p className="font-mono text-lg font-semibold">{formatMaluti(window.openingFloat)}</p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Money in ({days}d)</p>
          <p className="font-mono text-lg font-semibold text-cash-400">
            {formatMaluti(window.cashIn)}
          </p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Bought stock ({days}d)</p>
          <p className="font-mono text-lg font-semibold text-amber-400">
            {formatMaluti(Math.abs(window.purchases))}
          </p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Owner took ({days}d)</p>
          <p className="font-mono text-lg font-semibold text-amber-400">
            {formatMaluti(Math.abs(window.drawings))}
          </p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Paid out ({days}d)</p>
          <p className="font-mono text-lg font-semibold text-amber-400">
            {formatMaluti(Math.abs(window.expenses))}
          </p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Loans owed (now)</p>
          <p className="font-mono text-lg font-semibold text-violet-300">
            {formatMaluti(window.loans)}
          </p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Loan repaid ({days}d)</p>
          <p className="font-mono text-lg font-semibold text-amber-400">
            {formatMaluti(Math.abs(window.loanRepay))}
          </p>
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-ink-700 bg-ink-800/60 px-4 py-3 text-xs leading-relaxed text-slate-400">
        Recording money in, stock bought, or money out? That lives in the{' '}
        <span className="font-semibold text-slate-200">Money</span> tab — this
        report only looks at the ledger.
      </div>

      {/* Headline figures */}
      <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Sales
      </h2>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Net sales</p>
          <p className="font-mono text-2xl font-bold text-cash-400">
            {formatMaluti(report.net)}
          </p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Sales</p>
          <p className="font-mono text-2xl font-bold">{report.saleCount}</p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Items sold</p>
          <p className="font-mono text-xl font-semibold">{report.itemsSold}</p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Voided</p>
          <p className="font-mono text-xl font-semibold text-amber-400">
            {report.voidCount} <span className="text-xs">({formatMaluti(report.voided)})</span>
          </p>
        </div>
      </div>

      {/* Credit book at a glance */}
      <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Credit
      </h2>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Credit sales ({days}d)</p>
          <p className="font-mono text-xl font-semibold">{formatMaluti(credit.creditSales)}</p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Owed now</p>
          <p className="font-mono text-xl font-semibold text-amber-400">
            {formatMaluti(credit.outstanding)}
          </p>
          <p className="text-[10px] text-slate-500">{credit.debtorCount} open</p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Collected ({days}d)</p>
          <p className="font-mono text-xl font-semibold text-cash-400">
            {formatMaluti(credit.collected)}
          </p>
        </div>
        <div className="card">
          <p className="text-[10px] uppercase tracking-wider text-slate-400">Written off ({days}d)</p>
          <p className="font-mono text-xl font-semibold text-rose-300">
            {formatMaluti(credit.writtenOff)}
          </p>
        </div>
        {customerCredits !== 0 && (
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">
              Customer credits (now)
            </p>
            <p className="font-mono text-xl font-semibold text-violet-300">
              {formatMaluti(customerCredits)}
            </p>
            <p className="text-[10px] text-slate-500">
              {customerCredits > 0 ? 'Cash held for customers' : 'Customer owes an over-refund'}
            </p>
          </div>
        )}
      </div>

      {/* Daily bars */}
      <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Daily net sales
      </h2>
      <div className="mt-2 flex h-32 items-end gap-1">
        {trend.map((d) => (
          <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-t-md bg-cash-500/80 transition-colors hover:bg-cash-400"
              style={{ height: `${Math.max(d.pct, d.net > 0 ? 4 : 1)}%` }}
              title={`${d.date}: ${formatMaluti(d.net)}`}
            />
            <span className="text-[8px] text-slate-500">{d.date.slice(8)}</span>
          </div>
        ))}
      </div>

      {/* Per-day breakdown for counting the drawer */}
      <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Day by day
      </h2>
      <div className="mt-2 overflow-hidden rounded-xl border border-ink-700">
        <table className="w-full text-sm">
          <thead className="bg-ink-800 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Date</th>
              <th className="px-2 py-2 text-right font-medium">Sales</th>
              <th className="px-2 py-2 text-right font-medium">Void</th>
              <th className="px-3 py-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {[...report.days].reverse().map((d) => (
              <tr key={d.date} className="border-t border-ink-700">
                <td className="px-3 py-2 font-mono text-xs">{d.date}</td>
                <td className="px-2 py-2 text-right font-mono">{d.saleCount}</td>
                <td className="px-2 py-2 text-right font-mono text-amber-400">
                  {d.voidCount || ''}
                </td>
                <td className="px-3 py-2 text-right font-mono text-cash-400">
                  {formatMaluti(d.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Best sellers */}
      {report.topItems.length > 0 && (
        <>
          <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            Top items
          </h2>
          <ul className="mt-2 space-y-1.5">
            {report.topItems.map((item) => (
              <li key={item.name} className="card flex items-center justify-between !py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                <span className="font-mono text-xs text-slate-400">{item.qty}×</span>
                <span className="w-24 text-right font-mono text-sm text-cash-400">
                  {formatMaluti(item.total)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* The books, as one printable PDF */}
      <h2 className="mt-6 text-xs font-semibold uppercase tracking-wider text-slate-400">
        The books
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
        One PDF per period, ready for the accountant — follow the{' '}
        {days}-day window above.
      </p>
      <div className="mt-2 space-y-2">
        <button
          onClick={() => {
            // jsPDF is big; load it only when the operator actually asks for
            // the books, so the till opens fast.
            void import('./pdfPack').then(({ exportBooksPdf }) =>
              exportFile(exportBooksPdf(rangeDates), `books-${range}.pdf`),
            )
          }}
          className="card w-full !border-cash-500/40 !bg-cash-500/10 !py-4 text-left active:scale-[0.98]"
        >
          <span className="flex items-center justify-between">
            <span className="text-sm font-bold text-cash-400">
              Download the books (PDF)
            </span>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              className="h-4 w-4 text-cash-400"
            >
              <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 3v12m0 0l-4-4m4 4l4-4" />
            </svg>
          </span>
          <span className="mt-0.5 block text-[11px] text-slate-400">
            Sales · credit sales · receipts · credit receipts · payments · bad
            debts · trial balance · P&L · cash flow · balance sheet · inventory
          </span>
        </button>
      </div>

      {/* Spreadsheet exports */}
      <h2 className="mt-6 text-xs font-semibold uppercase tracking-wider text-slate-400">
        Spreadsheet exports (CSV)
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
        Each export follows the {days}-day window above. Statements carry the P&L
        for that window plus a balance sheet as of now.
      </p>
      <div className="mt-2 space-y-2">
        <ExportButton
          label="Sales & profit"
          sub="Each item with its cost, plus gross profit"
          onTap={() =>
            exportFile(exportSalesCsv(rangeDates), `sales-${range}.csv`)
          }
        />
        <ExportButton
          label="Cash ledger"
          sub="Every drawer movement with a running balance"
          onTap={() =>
            exportFile(exportCashLedgerCsv(rangeDates), `cash-ledger-${range}.csv`)
          }
        />
        <ExportButton
          label="Credit journal"
          sub="Credit sales, collections and bad debts"
          onTap={() =>
            exportFile(exportCreditJournalCsv(rangeDates), `credit-${range}.csv`)
          }
        />
        <ExportButton
          label="Stock ledger"
          sub="Stock movements and what the shelf is worth"
          onTap={() =>
            exportFile(
              exportStockLedgerCsv(stockStart, stockEnd),
              `stock-ledger-${range}.csv`,
            )
          }
        />
        <ExportButton
          label="Statements"
          sub="Mini P&L and balance sheet, with the check"
          onTap={() =>
            exportFile(exportStatementsCsv(rangeDates), `statements-${range}.csv`)
          }
        />
      </div>
    </div>
  )
}

function exportFile(promise: Promise<Blob>, filename: string): void {
  void promise
    .then((blob) => downloadBlob(blob, filename))
    .catch(() => feedbackError())
}

function ExportButton({
  label,
  sub,
  onTap,
}: {
  label: string
  sub: string
  onTap: () => void
}) {
  return (
    <button
      onClick={onTap}
      className="card w-full !py-3 text-left active:scale-[0.98]"
    >
      <span className="flex items-center justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="h-4 w-4 text-slate-400"
        >
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 3v12m0 0l-4-4m4 4l4-4" />
        </svg>
      </span>
      <span className="mt-0.5 block text-[11px] text-slate-500">{sub}</span>
    </button>
  )
}

export function buildReport(sales: Sale[], lines: SaleLine[], days: number) {
  const dayMap = new Map<string, DayReport & { items: Map<string, { qty: number; total: Cents }> }>()

  // Seed every day in the window so gaps render as zero, not as missing rows.
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const date = businessDate(d)
    dayMap.set(date, {
      date,
      saleCount: 0,
      gross: 0,
      voidCount: 0,
      voided: 0,
      net: 0,
      itemsSold: 0,
      topItems: [],
      items: new Map(),
    })
  }

  const voidedSaleIds = new Set<string>()
  for (const sale of sales) {
    const day = dayMap.get(sale.businessDate)
    if (!day) continue
    if (sale.status === 'voided') {
      day.voidCount++
      day.voided += sale.total
      voidedSaleIds.add(sale.id)
      continue
    }
    day.saleCount++
    day.gross += sale.total
    day.net += sale.total
  }

  // Index the sales once. The previous `sales.find` was O(sales × lines) and
  // this screen renders up to 2,000 sales and 20,000 lines.
  const saleById = new Map(sales.map((s) => [s.id, s]))

  for (const line of lines) {
    if (voidedSaleIds.has(line.saleId)) continue
    const sale = saleById.get(line.saleId)
    if (!sale) continue
    const day = dayMap.get(sale.businessDate)
    if (!day) continue
    day.itemsSold += line.qty
    const entry = day.items.get(line.name) ?? { qty: 0, total: 0 }
    entry.qty += line.qty
    entry.total += line.lineTotal
    day.items.set(line.name, entry)
  }

  const allItems = new Map<string, { name: string; qty: number; total: Cents }>()
  for (const day of dayMap.values()) {
    for (const [name, entry] of day.items) {
      const agg = allItems.get(name) ?? { name, qty: 0, total: 0 }
      agg.qty += entry.qty
      agg.total += entry.total
      allItems.set(name, agg)
    }
    day.topItems = []
  }

  const dayList = [...dayMap.values()].map(({ items: _items, ...rest }) => rest)
  const topItems = [...allItems.values()]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 8)

  return {
    ...dayList.reduce(
      (acc, d) => ({
        saleCount: acc.saleCount + d.saleCount,
        gross: acc.gross + d.gross,
        voidCount: acc.voidCount + d.voidCount,
        voided: acc.voided + d.voided,
        net: acc.net + d.net,
        itemsSold: acc.itemsSold + d.itemsSold,
      }),
      { saleCount: 0, gross: 0, voidCount: 0, voided: 0, net: 0, itemsSold: 0 },
    ),
    days: dayList,
    trend: dayList,
    topItems,
  }
}
