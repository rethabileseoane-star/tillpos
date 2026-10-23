import Papa from 'papaparse'
import { db } from '@/db'
import {
  CASH_REASON_LABEL,
  STOCK_REASON_LABEL,
  balanceSheet,
  incomeStatement,
} from './accounts'

/**
 * The rest of the export set: the raw ledgers an accountant can audit and a
 * small statements file with a P&L and a balance sheet. Sales & profit lives
 * in `exportCsv.ts` with the rest of the sales export.
 *
 * Everything is CSV so it drops straight into Excel or an accountant's
 * software. Figures are Maluti with two decimals, matching the sales export.
 */

/** Every drawer movement in the window, with a true running balance. */
export async function exportCashLedgerCsv(dates?: string[]): Promise<Blob> {
  // IndexedDB returns primary-key order within a millisecond; sort so equal
  // timestamps fall back to insertion order, keeping the running balance
  // stable across exports (same trick as the books pack).
  const all = (await db.cashMovements.orderBy('createdAt').toArray()).sort(
    (a, z) => a.createdAt - z.createdAt || a.id.localeCompare(z.id),
  )

  const rows: Record<string, string | number>[] = []
  let running: number = 0
  for (const m of all) {
    running += m.delta
    if (dates?.length && !dates.includes(m.businessDate)) continue
    rows.push({
      date: m.businessDate,
      time: new Date(m.createdAt).toISOString().slice(11, 19),
      type: CASH_REASON_LABEL[m.reason],
      note: m.note,
      amount_mwk: (m.delta / 100).toFixed(2),
      running_balance_mwk: (running / 100).toFixed(2),
    })
  }

  const header = ['date', 'time', 'type', 'note', 'amount_mwk', 'running_balance_mwk']
  const csv = Papa.unparse(rows, { columns: header })

  const footer = [
    '',
    `# Movements shown: ${rows.length} of ${all.length} (all time)`,
    `# Cash in drawer now (MWK): ${(all.reduce((s, m) => s + m.delta, 0) / 100).toFixed(2)}`,
    '# Types: Sale, Void, Opening float, Money in, Bought stock, Owner took, Paid out, Loan repaid',
  ].join('\n')

  return new Blob([csv + footer], { type: 'text/csv;charset=utf-8' })
}

/**
 * Every stock movement in the window (by creation time, since stock movements
 * carry timestamps, not business dates), plus the shop's current stock
 * valuation at the end so the accountant can see what the shelf is worth.
 */
export async function exportStockLedgerCsv(start?: number, end?: number): Promise<Blob> {
  const [products, moves] = await Promise.all([
    db.products.toArray(),
    db.stockMovements.orderBy('createdAt').toArray(),
  ])
  const byId = new Map(products.map((p) => [p.id, p]))
  const inRange = (t: number) =>
    (start === undefined || t >= start) && (end === undefined || t < end)

  const rows: Record<string, string | number>[] = []
  for (const m of moves) {
    if (!inRange(m.createdAt)) continue
    const p = byId.get(m.productId)
    const cost = p ? (p.cost ?? p.price) : 0
    rows.push({
      date: new Date(m.createdAt).toISOString().slice(0, 10),
      barcode: p?.barcode ?? '',
      product: p?.name ?? '',
      reason: STOCK_REASON_LABEL[m.reason],
      delta: m.delta,
      unit_cost_mwk: (cost / 100).toFixed(2),
      value_mwk: ((m.delta * cost) / 100).toFixed(2),
    })
  }

  const header = ['date', 'barcode', 'product', 'reason', 'delta', 'unit_cost_mwk', 'value_mwk']
  const csv = Papa.unparse(rows, { columns: header })

  const valued = products
    .filter((p) => p.stockQty !== 0)
    .map((p) => {
      const cost = p.cost ?? p.price ?? 0
      return {
        barcode: p.barcode,
        product: p.name,
        stock_qty: p.stockQty,
        unit_cost_mwk: (cost / 100).toFixed(2),
        value_mwk: ((p.stockQty * cost) / 100).toFixed(2),
      }
    })
  const totalValue = products.reduce((s, p) => s + p.stockQty * (p.cost ?? p.price ?? 0), 0)
  const valuationPapa = valued.length
    ? Papa.unparse(valued, {
        columns: ['barcode', 'product', 'stock_qty', 'unit_cost_mwk', 'value_mwk'],
      })
    : ''

  const footer = [
    '',
    `# STOCK IN THE SHOP NOW (${new Date().toISOString().slice(0, 10)})`,
    valuationPapa ? valuationPapa.split('\n').map((l) => `# ${l}`).join('\n') : '# (nothing on the shelf)',
    `# Total stock value (MWK): ${(totalValue / 100).toFixed(2)}`,
  ].join('\n')

  return new Blob([csv + footer], { type: 'text/csv;charset=utf-8' })
}

/**
 * One small file with two statements side by side, nothing fancier:
 *  - Income statement for the selected window (sales, cost of goods, expenses,
 *    net profit).
 *  - Balance sheet at this moment (cash + stock on one side; what the owner
 *    put in + profits − drawings on the other).
 * The last line is the check: assets minus equity should be zero.
 */
export async function exportStatementsCsv(dates: string[]): Promise<Blob> {
  const [cash, products, stockMoves, sales, lines] = await Promise.all([
    db.cashMovements.toArray(),
    db.products.toArray(),
    db.stockMovements.toArray(),
    db.sales.toArray(),
    db.saleLines.toArray(),
  ])

  const stmt = incomeStatement(sales, lines, products, cash, dates, stockMoves)
  const bs = balanceSheet(cash, products, stockMoves, sales, lines)

  const rows = [
    { item: 'Sales (gross)', amount_mwk: (stmt.revenue / 100).toFixed(2) },
    { item: 'Less: refunds (voided sales)', amount_mwk: (stmt.returns / 100).toFixed(2) },
    { item: 'Cost of goods sold (at recorded cost)', amount_mwk: (stmt.cogs / 100).toFixed(2) },
    { item: 'Gross profit', amount_mwk: (stmt.grossProfit / 100).toFixed(2) },
    { item: 'Expenses paid (rent, transport...)', amount_mwk: (stmt.expenses / 100).toFixed(2) },
    { item: 'NET PROFIT', amount_mwk: (stmt.netProfit / 100).toFixed(2) },
  ]
  const csv = Papa.unparse(rows, { columns: ['item', 'amount_mwk'] })

  const period = `${dates[0] ?? 'start'} to ${dates.at(-1) ?? 'now'}`
  const footer = [
    '',
    `# INCOME STATEMENT (${period})`,
    `# (${stmt.saleCount} sales, ${stmt.itemsSold} items)`,
    stmt.purchaseVariance !== 0 ? `# Purchase variance (MWK), ${(stmt.purchaseVariance / 100).toFixed(2)}` : '',
    '',
    '# BALANCE SHEET (today)',
    '# ASSETS',
    `# Cash in drawer (MWK), ${(bs.cash / 100).toFixed(2)}`,
    `# Stock in shop at cost (MWK), ${(bs.stockValue / 100).toFixed(2)}`,
    `# Total assets (MWK), ${(bs.totalAssets / 100).toFixed(2)}`,
    '',
    '# LIABILITIES',
    `# Loans owed (MWK), ${(bs.loans / 100).toFixed(2)}`,
    '',
    "# OWNER'S EQUITY",
    `# Owner capital in (float + money in) (MWK), ${(bs.capitalIn / 100).toFixed(2)}`,
    `# Stock brought in (opening/import) (MWK), ${(bs.contributedStock / 100).toFixed(2)}`,
    `# Retained profit, all time (MWK), ${(bs.retainedProfit / 100).toFixed(2)}`,
    `# Owner took (MWK), ${(bs.drawings / 100).toFixed(2)}`,
    `# Total owner's equity (MWK), ${(bs.totalEquity / 100).toFixed(2)}`,
    '',
    `# CHECK - assets minus (loans + equity) (MWK), ${(bs.check / 100).toFixed(2)}`,
    '# Zero means the books agree with the tin and the shelf. A non-zero figure',
    '# is unposted movement: usually a cost revaluation made straight on a product.',
  ].filter((l) => l !== '').join('\n')

  return new Blob([csv + footer], { type: 'text/csv;charset=utf-8' })
}