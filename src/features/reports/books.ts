import { db } from '@/db'
import type {
  CashMovement,
  Product,
  Sale,
  SaleLine,
  StockMovement,
} from '@/db/types'
import type { Cents } from '@/domain/money'
import {
  CASH_REASON_LABEL,
  STOCK_REASON_LABEL,
  balanceSheet,
  cashFlow,
  fmt2,
  incomeStatement,
  trialBalances,
  windowMillis,
} from './accounts'

/**
 * The books pack: every record an accountant asks for, built as plain tables
 * so the PDF renderer and any future format share one source of truth.
 *
 *  - Sales journal            every sale line, posted to cash and sales
 *  - Cash receipts journal    money into the drawer (sales, floats, money in)
 *  - Payments journal         money out of the drawer (stock, expenses,
 *                             drawings, loan repayments)
 *  - Trial balance            every account with debits and credits
 *  - Profit & loss            sales, returns, cost of goods, expenses, profit
 *  - Cash flow statement      operating vs financing, opening to closing
 *  - Balance sheet            assets vs loans + owner's equity
 *  - Inventory                movement ledger and what the shelf is worth
 */

export interface BookTable {
  title: string
  subtitle: string
  columns: string[]
  rows: (string | number)[][]
  notes: string[]
}

export interface BooksData {
  sales: Sale[]
  lines: SaleLine[]
  cash: CashMovement[]
  products: Product[]
  stockMoves: StockMovement[]
}

export async function loadBooksData(): Promise<BooksData> {
  const [sales, lines, cash, products, stockMoves] = await Promise.all([
    db.sales.toArray(),
    db.saleLines.toArray(),
    db.cashMovements.toArray(),
    db.products.toArray(),
    db.stockMovements.toArray(),
  ])
  // Ledgers read in primary-key order by IndexedDB; journals must read in the
  // order money moved, or running balances come out differently each run.
  const byTime = <T extends { createdAt: number; id: string }>(rows: T[]): T[] =>
    rows.sort((a, z) => a.createdAt - z.createdAt || a.id.localeCompare(z.id))
  return { sales, lines, cash: byTime(cash), products, stockMoves: byTime(stockMoves) }
}

const inWindow = (dates: string[]) => (d: string) => dates.includes(d)

function runningBalances(cash: CashMovement[]): Map<string, Cents> {
  const map = new Map<string, Cents>()
  let running = 0
  for (const m of cash) {
    running += m.delta
    map.set(m.id, running)
  }
  return map
}

/** One row per sale line — the shape an accountant pivots. */
export function salesJournal(data: BooksData, dates: string[]): BookTable {
  const { sales, lines, cash } = data
  const window = inWindow(dates)
  const rows: (string | number)[][] = []
  let total: Cents = 0
  let count = 0
  for (const sale of sales) {
    if (sale.status !== 'completed' || !window(sale.businessDate)) continue
    const own = lines.filter((l) => l.saleId === sale.id)
    for (const l of own) {
      rows.push([
        sale.businessDate,
        sale.receiptNo,
        new Date(sale.createdAt).toISOString().slice(11, 19),
        l.name,
        l.qty,
        fmt2(l.unitPrice),
        fmt2(l.lineTotal),
      ])
      total += l.lineTotal
      count++
    }
  }
  rows.sort(
    (a, z) =>
      String(a[0]).localeCompare(String(z[0])) ||
      String(a[2]).localeCompare(String(z[2])) ||
      String(a[1]).localeCompare(String(z[1])),
  )
  const voided = cash
    .filter((m) => m.reason === 'void' && window(m.businessDate))
    .reduce((s, m) => s + m.delta, 0)
  return {
    title: 'Sales journal',
    subtitle: `Cash received and the items that paid for it · ${periodLabel(dates)}`,
    columns: ['Date', 'Receipt', 'Time', 'Item', 'Qty', 'Unit (M)', 'Amount (M)'],
    rows,
    notes: [
      `Total of ${count} lines (M): ${fmt2(total)}`,
      voided < 0 ? `Refunds handed back (M): ${fmt2(-voided)}` : 'No refunds in this period.',
    ],
  }
}

/** Money into the drawer: sales, floats, and money in (own or borrowed). */
export function receiptsJournal(data: BooksData, dates: string[]): BookTable {
  const { cash } = data
  const window = inWindow(dates)
  const running = runningBalances(cash)
  const types = new Set(['sale', 'void', 'float', 'cash_in'])
  const rows: (string | number)[][] = []
  let inTotal: Cents = 0
  for (const m of cash) {
    if (!types.has(m.reason) || !window(m.businessDate)) continue
    const pos = Math.max(0, m.delta)
    const neg = Math.max(0, -m.delta)
    const label =
      m.reason === 'cash_in' && m.kind === 'loan' ? 'Money in (loan)' : CASH_REASON_LABEL[m.reason]
    rows.push([
      m.businessDate,
      new Date(m.createdAt).toISOString().slice(11, 19),
      label,
      m.note || label,
      fmt2(pos),
      neg > 0 ? fmt2(neg) : '',
      fmt2(running.get(m.id) ?? 0),
    ])
    inTotal += pos
  }
  return {
    title: 'Cash receipts journal',
    subtitle: `Money into the drawer · ${periodLabel(dates)}`,
    columns: ['Date', 'Time', 'Source', 'Note', 'In (M)', 'Out (M)', 'Balance (M)'],
    rows,
    notes: [`Total received (M): ${fmt2(inTotal)}`],
  }
}

/** Money out of the drawer: bought stock, expenses, drawings, loan repayments. */
export function paymentsJournal(data: BooksData, dates: string[]): BookTable {
  const { cash } = data
  const window = inWindow(dates)
  const running = runningBalances(cash)
  const types = new Set(['purchase', 'expense', 'drawing', 'loan_repay'])
  const rows: (string | number)[][] = []
  const byType = new Map<string, Cents>()
  for (const m of cash) {
    if (!types.has(m.reason) || !window(m.businessDate)) continue
    const label = CASH_REASON_LABEL[m.reason]
    rows.push([
      m.businessDate,
      new Date(m.createdAt).toISOString().slice(11, 19),
      label,
      m.note || label,
      fmt2(-m.delta),
      fmt2(running.get(m.id) ?? 0),
    ])
    byType.set(label, (byType.get(label) ?? 0) + -m.delta)
  }
  const notes = [...byType.entries()].map(([t, v]) => `${t} (M): ${fmt2(v)}`)
  notes.push(`Total paid out (M): ${fmt2([...byType.values()].reduce((s, v) => s + v, 0))}`)
  return {
    title: 'Payments journal',
    subtitle: `Money out of the drawer · ${periodLabel(dates)}`,
    columns: ['Date', 'Time', 'Type', 'Paid to / for', 'Amount (M)', 'Balance (M)'],
    rows,
    notes,
  }
}

/** Every account with debits and credits — the proof the books balance. */
export function trialBalanceTable(data: BooksData): BookTable {
  const tb = trialBalances(data.sales, data.lines, data.cash, data.products, data.stockMoves)
  const rows: (string | number)[][] = []
  let debit: Cents = 0
  let credit: Cents = 0
  for (const row of tb.rows) {
    if (row.balance > 0) {
      rows.push([String(row.account), row.name, fmt2(row.balance), ''])
      debit += row.balance
    } else {
      rows.push([String(row.account), row.name, '', fmt2(-row.balance)])
      credit += -row.balance
    }
  }
  rows.push(['', 'TOTAL', fmt2(debit), fmt2(credit)])
  const notes = [
    tb.difference === 0
      ? 'Debits equal credits — the books balance to the tambala.'
      : `Difference (M): ${fmt2(tb.difference)} — usually a cost revaluation made straight on a product.`,
  ]
  return {
    title: 'Trial balance',
    subtitle: `All accounts, as of today`,
    columns: ['Account', 'Name', 'Debit (M)', 'Credit (M)'],
    rows,
    notes,
  }
}

export function profitAndLossTable(data: BooksData, dates: string[]): BookTable {
  const stmt = incomeStatement(
    data.sales,
    data.lines,
    data.products,
    data.cash,
    dates,
    data.stockMoves,
  )
  const rows: (string | number)[][] = [
    ['Sales (gross, before refunds)', fmt2(stmt.revenue)],
    ['Less: refunds (voided sales)', fmt2(-stmt.returns)],
    ['NET REVENUE', fmt2(stmt.netRevenue)],
    ['Cost of goods sold', fmt2(-stmt.cogs)],
    ['GROSS PROFIT', fmt2(stmt.grossProfit)],
  ]
  if (stmt.purchaseVariance !== 0) {
    rows.push(['Purchase variance (depot price differences)', fmt2(stmt.purchaseVariance)])
  }
  if (stmt.stockAdjust !== 0) {
    rows.push(['Stock adjustments (stock takes)', fmt2(-stmt.stockAdjust)])
  }
  rows.push(
    ['Expenses paid', fmt2(-stmt.expenses)],
    ['NET PROFIT', fmt2(stmt.netProfit)],
  )
  return {
    title: 'Profit & loss statement',
    subtitle: `Income statement · ${periodLabel(dates)}`,
    columns: ['Item', 'Amount (M)'],
    rows,
    notes: [
      `${stmt.saleCount} sales, ${stmt.itemsSold} items sold.`,
      'Cost of goods sold is valued at each item\u2019s recorded cost.',
    ],
  }
}

export function cashFlowTable(data: BooksData, dates: string[]): BookTable {
  const cf = cashFlow(data.cash, dates)
  const rows: (string | number)[][] = [
    ['Cash in the drawer at the start', fmt2(cf.opening)],
    ['Cash received from sales', fmt2(cf.operatingIn)],
    ['Cash paid for stock and expenses (operating)', fmt2(-cf.operatingOut)],
    ['Cash put in by the owner and loans (financing)', fmt2(cf.financingIn)],
    ['Cash paid to the owner and loan repayments (financing)', fmt2(-cf.financingOut)],
    ['NET CHANGE IN CASH', fmt2(cf.net)],
    ['CASH IN THE DRAWER AT THE END', fmt2(cf.closing)],
  ]
  return {
    title: 'Cash flow statement',
    subtitle: `For ${periodLabel(dates)}`,
    columns: ['Item', 'Amount (M)'],
    rows,
    notes: ['Closing balance ties to the drawer ledger.'],
  }
}

export function balanceSheetTable(data: BooksData): BookTable {
  const bs = balanceSheet(data.cash, data.products, data.stockMoves, data.sales, data.lines)
  const rows: (string | number)[][] = [
    ['ASSETS'],
    ['  Cash in drawer', fmt2(bs.cash)],
    ['  Stock in the shop (at cost)', fmt2(bs.stockValue)],
    ['TOTAL ASSETS', fmt2(bs.totalAssets)],
    ['LIABILITIES'],
    ['  Loans owed', fmt2(bs.loans)],
    ['OWNER\u2019S EQUITY'],
    ['  Owner capital (cash put in)', fmt2(bs.capitalIn)],
    ['  Stock brought in', fmt2(bs.contributedStock)],
    ['  Retained profit', fmt2(bs.retainedProfit)],
    ['  Owner drawings', fmt2(bs.drawings)],
    ['TOTAL EQUITY', fmt2(bs.totalEquity)],
    ['LIABILITIES + EQUITY', fmt2(bs.loans + bs.totalEquity)],
  ]
  const notes = [
    bs.check === 0
      ? 'Assets equal loans plus equity — the books agree with the tin and the shelf.'
      : `Check (M): ${fmt2(bs.check)} — unposted movement, usually a cost revaluation.`,
  ]
  return {
    title: 'Balance sheet',
    subtitle: 'As of today',
    columns: ['Item', 'Amount (M)'],
    rows,
    notes,
  }
}

/** Stock movements for the window, then what remains on the shelf and what it is worth. */
export function inventoryTable(data: BooksData, dates: string[]): BookTable {
  const { stockMoves, products } = data
  const byId = new Map(products.map((p) => [p.id, p]))
  const range = windowMillis(dates)
  const costOf = (id: string) => byId.get(id)?.cost ?? byId.get(id)?.price ?? 0

  const rows: (string | number)[][] = []
  for (const sm of stockMoves) {
    if (range && (sm.createdAt < range[0] || sm.createdAt >= range[1])) continue
    const p = byId.get(sm.productId)
    rows.push([
      new Date(sm.createdAt).toISOString().slice(0, 10),
      p?.name ?? 'Item',
      STOCK_REASON_LABEL[sm.reason],
      sm.delta,
      fmt2(costOf(sm.productId)),
      fmt2(sm.delta * costOf(sm.productId)),
    ])
  }
  const priced = products.filter((p) => p.stockQty !== 0)
  for (const p of priced) {
    const name = p.name.length > 26 ? `${p.name.slice(0, 26)}…` : p.name
    rows.push([
      'NOW',
      name,
      'On the shelf',
      p.stockQty,
      fmt2(costOf(p.id)),
      fmt2(p.stockQty * costOf(p.id)),
    ])
  }
  const total = priced.reduce((s, p) => s + p.stockQty * costOf(p.id), 0)
  return {
    title: 'Inventory',
    subtitle: `Stock movements · ${periodLabel(dates)}, plus what is on the shelf now`,
    columns: ['Date', 'Item', 'Reason', 'Qty', 'Unit cost (M)', 'Value (M)'],
    rows,
    notes: [`Stock in the shop now is worth (M): ${fmt2(total)}`],
  }
}

export function buildBookPack(data: BooksData, dates: string[]): BookTable[] {
  return [
    salesJournal(data, dates),
    receiptsJournal(data, dates),
    paymentsJournal(data, dates),
    trialBalanceTable(data),
    profitAndLossTable(data, dates),
    cashFlowTable(data, dates),
    balanceSheetTable(data),
    inventoryTable(data, dates),
  ]
}

export function periodLabel(dates: string[]): string {
  if (!dates.length) return 'all time'
  const sorted = [...dates].sort()
  return `${sorted[0]} to ${sorted[sorted.length - 1]}`
}