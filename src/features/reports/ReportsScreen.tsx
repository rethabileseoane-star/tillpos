import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { formatMaluti, type Cents } from '@/domain/money'
import { businessDate } from '@/features/sales/salesService'
import { summariseCash } from '@/features/cash/cashService'
import { creditTotals, customerCreditTotals } from '@/features/credit/credit'
import { buildTabRows, totalTabBalance } from '@/features/tabs/tabs'
import { exportSalesCsv } from './exportCsv'
import {
  exportCashLedgerCsv,
  exportCreditJournalCsv,
  exportCustomerTabsCsv,
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

  const reportData =
    useLiveQuery(
      async () => {
        const start = new Date()
        start.setDate(start.getDate() - (days - 1))
        const first = businessDate(start)
        const rows = await db.sales
          .where('businessDate')
          .between(first, today, true, true)
          .toArray()
        const ids = rows.map((sale) => sale.id)
        const lines = ids.length
          ? await db.saleLines.where('saleId').anyOf(ids).toArray()
          : []
        return { sales: rows, lines }
      },
      [days, today],
    ) ?? { sales: [], lines: [] }
  const sales = reportData.sales
  const lines = reportData.lines

  const cash = useLiveQuery(() => db.cashMovements.toArray(), []) ?? []

  const allSales = useLiveQuery(() => db.sales.toArray(), []) ?? []
  const tabs = useLiveQuery(() => db.customerTabs.toArray(), []) ?? []
  const tabEntries = useLiveQuery(() => db.tabEntries.toArray(), []) ?? []

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
  const tabsOwed = useMemo(() => totalTabBalance(tabEntries), [tabEntries])
  const openTabs = useMemo(
    () => buildTabRows(tabs, tabEntries).filter((row) => row.balance > 0).length,
    [tabs, tabEntries],
  )

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
    <div className="relative min-h-[calc(100dvh-84px)] overflow-hidden">
      {/* Background image — Reference Image 6 */}
      <div className="absolute inset-0 z-0 bg-ice-100 screen-bg bg-liquid-chrome">
        <div className="absolute inset-0 bg-ice-100/55" />
      </div>

      <div className="relative z-10 px-4 py-4">
        <h1 className="text-xl font-bold text-surface-900">Z-Report</h1>
        <p className="text-xs text-surface-600">
          Cash, sales, credit and customer tabs for the last {days} days
        </p>

        <div className="mt-3 flex gap-2">
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`btn flex-1 !py-2 text-sm ${
                days === d ? 'bg-cyan-400 text-white' : 'bg-surface-200 text-surface-900'
              }`}
            >
              {d} days
            </button>
          ))}
        </div>

        {/* The drawer, front and centre: this is the number that must match the tin. */}
        <div className="card mt-4 border-cyan-400/40 bg-cyan-400/10 shadow-lift">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-surface-600">
                Cash in the drawer
              </p>
              <p className="mt-1 font-mono text-3xl font-bold text-cyan-600">
                {formatMaluti(window.balance)}
              </p>
            </div>
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-400/20 text-cyan-600">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-6 w-6">
                <path d="M2 7h20v10H2z M2 10h20M6 14h4" />
              </svg>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-surface-600">
            Running total of every cash movement, from the opening float to now.
            Count the tin and compare.
          </p>
        </div>

        {/* Money in and out over the selected window */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Cash sales ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-cyan-600">
              {formatMaluti(window.sales)}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Credit collected ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-cyan-600">
              {formatMaluti(window.creditPayments)}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Opening float ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-surface-900">
              {formatMaluti(window.openingFloat)}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Money in ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-cyan-600">
              {formatMaluti(window.cashIn)}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Bought stock ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-surface-700">
              {formatMaluti(Math.abs(window.purchases))}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Owner took ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-surface-700">
              {formatMaluti(Math.abs(window.drawings))}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Paid out ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-surface-700">
              {formatMaluti(Math.abs(window.expenses))}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Loans owed (now)</p>
            <p className="font-mono text-lg font-semibold text-surface-700">
              {formatMaluti(window.loans)}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Loan repaid ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-surface-700">
              {formatMaluti(Math.abs(window.loanRepay))}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Tab cash in ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-cyan-600">
              {formatMaluti(window.tabCredits)}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Tab cash out ({days}d)</p>
            <p className="font-mono text-lg font-semibold text-surface-700">
              {formatMaluti(Math.abs(window.tabPayouts))}
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-surface-300 bg-ice-200/60 px-4 py-3 text-xs leading-relaxed text-surface-600">
          Recording money in, stock bought, or money out? That lives in the{' '}
          <span className="font-semibold text-surface-900">Money</span> tab — this
          report only looks at the ledger.
        </div>

        {/* Headline figures */}
        <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-surface-600">
          Sales
        </h2>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Net sales</p>
            <p className="font-mono text-2xl font-bold text-cyan-600">
              {formatMaluti(report.net)}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Sales</p>
            <p className="font-mono text-2xl font-bold">{report.saleCount}</p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Items sold</p>
            <p className="font-mono text-xl font-semibold">{report.itemsSold}</p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Voided</p>
            <p className="font-mono text-xl font-semibold text-surface-700">
              {report.voidCount} <span className="text-xs">({formatMaluti(report.voided)})</span>
            </p>
          </div>
        </div>

        {/* Credit book at a glance */}
        <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-surface-600">
          Credit
        </h2>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Credit sales ({days}d)</p>
            <p className="font-mono text-xl font-semibold">{formatMaluti(credit.creditSales)}</p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Owed now</p>
            <p className="font-mono text-xl font-semibold text-surface-700">
              {formatMaluti(credit.outstanding)}
            </p>
            <p className="text-[10px] text-surface-500">{credit.debtorCount} open</p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Collected ({days}d)</p>
            <p className="font-mono text-xl font-semibold text-cyan-600">
              {formatMaluti(credit.collected)}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Written off ({days}d)</p>
            <p className="font-mono text-xl font-semibold text-surface-700">
              {formatMaluti(credit.writtenOff)}
            </p>
          </div>
          <div className="card">
            <p className="text-[10px] uppercase tracking-wider text-surface-600">Shop owes on tabs (now)</p>
            <p className="font-mono text-xl font-semibold text-cyan-600">
              {formatMaluti(tabsOwed)}
            </p>
            <p className="text-[10px] text-surface-500">{openTabs} with a balance</p>
          </div>
          {customerCredits !== 0 && (
            <div className="card">
              <p className="text-[10px] uppercase tracking-wider text-surface-600">
                Customer credits (now)
              </p>
              <p className="font-mono text-xl font-semibold text-cyan-600">
                {formatMaluti(customerCredits)}
              </p>
              <p className="text-[10px] text-surface-500">
                {customerCredits > 0 ? 'Cash held for customers' : 'Customer owes an over-refund'}
              </p>
            </div>
          )}
        </div>

        {/* Daily bars */}
        <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-surface-600">
          Daily net sales
        </h2>
        <div className="mt-2 flex h-32 items-end gap-1">
          {trend.map((d) => (
            <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-t-md bg-cyan-400/80 transition-colors hover:bg-cyan-500"
                style={{ height: `${Math.max(d.pct, d.net > 0 ? 4 : 1)}%` }}
                title={`${d.date}: ${formatMaluti(d.net)}`}
              />
              <span className="text-[8px] text-surface-500">{d.date.slice(8)}</span>
            </div>
          ))}
        </div>

        {/* Per-day breakdown for counting the drawer */}
        <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-surface-600">
          Day by day
        </h2>
        <div className="mt-2 overflow-hidden rounded-xl border border-surface-300">
          <table className="w-full text-sm">
            <thead className="bg-surface-200 text-[10px] uppercase tracking-wider text-surface-600">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-2 py-2 text-right font-medium">Sales</th>
                <th className="px-2 py-2 text-right font-medium">Void</th>
                <th className="px-3 py-2 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {[...report.days].reverse().map((d) => (
                <tr key={d.date} className="border-t border-surface-300">
                  <td className="px-3 py-2 font-mono text-xs">{d.date}</td>
                  <td className="px-2 py-2 text-right font-mono">{d.saleCount}</td>
                  <td className="px-2 py-2 text-right font-mono text-surface-700">
                    {d.voidCount || ''}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-cyan-600">
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
            <h2 className="mt-5 text-xs font-semibold uppercase tracking-wider text-surface-600">
              Top items
            </h2>
            <ul className="mt-2 space-y-1.5">
              {report.topItems.map((item) => (
                <li key={item.name} className="card flex items-center justify-between !py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-surface-900">{item.name}</span>
                  <span className="font-mono text-xs text-surface-600">{item.qty}×</span>
                  <span className="w-24 text-right font-mono text-sm text-cyan-600">
                    {formatMaluti(item.total)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* The books, as one printable PDF */}
        <h2 className="mt-6 text-xs font-semibold uppercase tracking-wider text-surface-600">
          The books
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-surface-600">
          One PDF per period, ready for the accountant — follow the{' '}
          {days}-day window above.
        </p>
        <div className="mt-2 space-y-2">
          <button
            onClick={() => {
              void import('./pdfPack').then(({ exportBooksPdf }) =>
                exportFile(exportBooksPdf(rangeDates), `books-${range}.pdf`),
              )
            }}
            className="card w-full !border-cyan-400/40 !bg-cyan-400/10 !py-4 text-left active:scale-[0.98]"
          >
            <span className="flex items-center justify-between">
              <span className="text-sm font-bold text-cyan-600">
                Download the books (PDF)
              </span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                className="h-4 w-4 text-cyan-600"
              >
                <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 3v12m0 0l-4-4m4 4l4-4" />
              </svg>
            </span>
            <span className="mt-0.5 block text-[11px] text-surface-600">
              Sales · credit sales · customer tabs · tab transactions · receipts ·
              credit receipts · payments · bad debts · trial balance · P&L · cash
              flow · balance sheet · inventory
            </span>
          </button>
        </div>

        {/* PDF exports */}
        <h2 className="mt-6 text-xs font-semibold uppercase tracking-wider text-surface-600">
          PDF exports
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-surface-600">
          Each export follows the {days}-day window above and downloads as a PDF
          that opens on a phone. Statements carry the P&L for that window plus a
          balance sheet as of now.
        </p>
        <div className="mt-2 space-y-2">
          <ExportButton
            label="Sales & profit"
            sub="Each item with its cost, plus gross profit"
            onTap={() =>
              exportCsvPdf(
                exportSalesCsv(rangeDates),
                { title: 'Sales & profit', subtitle: `Period: ${range}` },
                `sales-${range}.pdf`,
              )
            }
          />
          <ExportButton
            label="Cash ledger"
            sub="Every drawer movement with a running balance"
            onTap={() =>
              exportCsvPdf(
                exportCashLedgerCsv(rangeDates),
                { title: 'Cash ledger', subtitle: `Period: ${range}` },
                `cash-ledger-${range}.pdf`,
              )
            }
          />
          <ExportButton
            label="Credit journal"
            sub="Credit sales, collections and bad debts"
            onTap={() =>
              exportCsvPdf(
                exportCreditJournalCsv(rangeDates),
                { title: 'Credit journal', subtitle: `Period: ${range}` },
                `credit-${range}.pdf`,
              )
            }
          />
          <ExportButton
            label="Customer tabs"
            sub="Money the shop owes, and every tab movement"
            onTap={() =>
              exportCsvPdf(
                exportCustomerTabsCsv(rangeDates),
                { title: 'Customer tabs', subtitle: `Period: ${range}` },
                `customer-tabs-${range}.pdf`,
              )
            }
          />
          <ExportButton
            label="Stock ledger"
            sub="Stock movements and what the shelf is worth"
            onTap={() =>
              exportCsvPdf(
                exportStockLedgerCsv(stockStart, stockEnd),
                { title: 'Stock ledger', subtitle: `Period: ${range}` },
                `stock-ledger-${range}.pdf`,
              )
            }
          />
          <ExportButton
            label="Statements"
            sub="Mini P&L and balance sheet, with the check"
            onTap={() =>
              exportCsvPdf(
                exportStatementsCsv(rangeDates),
                { title: 'Statements', subtitle: `Period: ${range}` },
                `statements-${range}.pdf`,
              )
            }
          />
        </div>
      </div>
    </div>
  )
}

function exportFile(promise: Promise<Blob>, filename: string): void {
  void promise
    .then((blob) => downloadBlob(blob, filename))
    .catch(() => feedbackError())
}

/**
 * The figure builders still produce CSV, because that is the format the tests
 * and any spreadsheet consumer expect, but the person at the till downloads a
 * PDF. The PDF builder is loaded only when a button is tapped.
 */
function exportCsvPdf(
  promise: Promise<Blob>,
  options: { title: string; subtitle?: string },
  filename: string,
): void {
  void promise
    .then(async (csv) => {
      const { csvBlobToPdf } = await import('./exportPdf')
      return csvBlobToPdf(csv, options)
    })
    .then((pdf) => downloadBlob(pdf, filename))
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
        <span className="text-sm font-semibold text-surface-900">{label}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="h-4 w-4 text-surface-600"
        >
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 3v12m0 0l-4-4m4 4l4-4" />
        </svg>
      </span>
      <span className="mt-0.5 block text-[11px] text-surface-500">{sub}</span>
    </button>
  )
}

export function buildReport(sales: Sale[], lines: SaleLine[], days: number) {
  const dayMap = new Map<string, DayReport & { items: Map<string, { qty: number; total: Cents }> }>()

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
