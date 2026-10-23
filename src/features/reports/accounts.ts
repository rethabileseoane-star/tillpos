import type {
  CashMovement,
  CashReason,
  Product,
  Sale,
  SaleLine,
  StockMovement,
  StockReason,
} from '@/db/types'
import type { Cents } from '@/domain/money'

/**
 * The till's books engine — pure accounting maths with a chart of accounts and
 * a debit/credit posting model. No database here: every function takes rows and
 * returns figures, so the numbers can be unit-tested and the CSV, PDF, and
 * screen can never disagree about what "net profit" means.
 *
 * This is the part that makes the records proper: each event posts balanced
 * legs (debits equal credits per event, so the whole trial balance ties by
 * construction), and the figures that used to hide in a "check" line — a
 * bargain at the depot, a stock take that found less on the shelf — are
 * recorded as named purchases-variance and stock-adjustment lines on the P&L.
 *
 * Conventions:
 *  - Cost of goods sold uses each item's recorded cost (`p.cost ?? p.price`).
 *  - Buy-stock payments are posted to inventory at recorded cost; the
 *    difference between what you paid and what you booked is purchase variance
 *    (a gain when you paid less).
 *  - Money in is own money (capital) or borrowed (a loan liability). Drawings
 *    reduce equity, never profit. Expenses hit the P&L.
 *  - A voided sale is a refund: cash out, sales-returns in. Gross revenue
 *    bills every sale and the refunds line reverses voided ones, so a sale
 *    and its void net to zero on the P&L.
 */

export const CASH_REASON_LABEL: Record<CashReason, string> = {
  sale: 'Sale',
  void: 'Void',
  float: 'Opening float',
  cash_in: 'Money in',
  purchase: 'Bought stock',
  drawing: 'Owner took',
  expense: 'Paid out',
  loan_repay: 'Loan repaid',
}

export const STOCK_REASON_LABEL: Record<StockReason, string> = {
  sale: 'Sale',
  void: 'Void return',
  import: 'Import',
  adjust: 'Stock take',
  opening: 'Opening stock',
  purchase: 'Bought stock',
}

/** Chart of accounts. Debits are positive, credits negative. */
export const ACCOUNTS = {
  CASH: 1100,
  INVENTORY: 1200,
  LOANS: 2500,
  CAPITAL: 3100,
  CONTRIBUTED: 3110,
  DRAWINGS: 3200,
  SALES: 4100,
  RETURNS: 4200,
  COGS: 5100,
  EXPENSES: 6000,
  PURCHASE_VARIANCE: 7210,
  STOCK_ADJUST: 7300,
} as const

export const ACCOUNT_NAMES: Record<number, string> = {
  [ACCOUNTS.CASH]: 'Cash in drawer',
  [ACCOUNTS.INVENTORY]: 'Stock in the shop',
  [ACCOUNTS.LOANS]: 'Loans owed',
  [ACCOUNTS.CAPITAL]: 'Owner capital (cash put in)',
  [ACCOUNTS.CONTRIBUTED]: 'Stock brought in',
  [ACCOUNTS.DRAWINGS]: 'Owner drawings',
  [ACCOUNTS.SALES]: 'Sales revenue',
  [ACCOUNTS.RETURNS]: 'Sales returns (voids)',
  [ACCOUNTS.COGS]: 'Cost of goods sold',
  [ACCOUNTS.EXPENSES]: 'Expenses paid',
  [ACCOUNTS.PURCHASE_VARIANCE]: 'Purchase variance',
  [ACCOUNTS.STOCK_ADJUST]: 'Stock adjustments',
}

function costOf(products: Map<string, Product>, id: string, fallback: Cents): Cents {
  const p = products.get(id)
  return p ? (p.cost ?? p.price) : fallback
}

/** Two-decimal Maluti with thousands separators and a plain minus sign. */
export function fmt2(cents: number): string {
  const neg = cents < 0
  const s = (Math.round(Math.abs(cents)) / 100).toFixed(2)
  const [int, frac] = s.split('.')
  return `${neg ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`
}

export interface TrialBalanceRow {
  account: number
  name: string
  /** Signed balance: positive = debit balance, negative = credit balance. */
  balance: Cents
}

/**
 * Account balances from posting every event to the chart of accounts. Each
 * event posts balanced legs, so `difference` (the sum of all balances) is zero
 * whenever the ledger is complete. A non-zero difference is unposted movement —
 * almost always a cost revaluation made straight on a product, since cost edits
 * are recorded on the product but never as an entry.
 */
export function trialBalances(
  sales: Sale[],
  lines: SaleLine[],
  cash: CashMovement[],
  products: Product[],
  stockMoves: StockMovement[],
): { rows: TrialBalanceRow[]; difference: Cents } {
  const byId = new Map(products.map((p) => [p.id, p]))
  const b = new Map<number, Cents>()
  const add = (acc: number, v: Cents) => b.set(acc, (b.get(acc) ?? 0) + v)

  for (const m of cash) {
    switch (m.reason) {
      case 'sale':
        add(ACCOUNTS.CASH, m.delta)
        add(ACCOUNTS.SALES, -m.delta)
        break
      case 'void':
        add(ACCOUNTS.CASH, m.delta)
        add(ACCOUNTS.RETURNS, -m.delta)
        break
      case 'float':
        add(ACCOUNTS.CASH, m.delta)
        add(ACCOUNTS.CAPITAL, -m.delta)
        break
      case 'cash_in':
        add(ACCOUNTS.CASH, m.delta)
        add(m.kind === 'loan' ? ACCOUNTS.LOANS : ACCOUNTS.CAPITAL, -m.delta)
        break
      case 'purchase':
        add(ACCOUNTS.CASH, m.delta)
        break
      case 'drawing':
        add(ACCOUNTS.CASH, m.delta)
        add(ACCOUNTS.DRAWINGS, -m.delta)
        break
      case 'expense':
        add(ACCOUNTS.CASH, m.delta)
        add(ACCOUNTS.EXPENSES, -m.delta)
        break
      case 'loan_repay':
        add(ACCOUNTS.CASH, m.delta)
        add(ACCOUNTS.LOANS, -m.delta)
        break
    }
  }

  // Completed sales consume inventory; each line depletes stock at cost.
  const completed = new Set(sales.filter((s) => s.status === 'completed').map((s) => s.id))
  for (const l of lines) {
    if (!completed.has(l.saleId)) continue
    const cost = costOf(byId, l.productId, l.unitPrice)
    add(ACCOUNTS.COGS, l.qty * cost)
    add(ACCOUNTS.INVENTORY, -(l.qty * cost))
  }

  // Every stock movement moves inventory value: purchases at cost with a
  // variance leg (paid vs booked), opening stock as a contribution, stock
  // takes as adjustments.
  const purchasePaid = new Map<string, Cents>()
  for (const m of cash) {
    if (m.reason === 'purchase') purchasePaid.set(m.id, Math.abs(m.delta))
  }
  const purchaseValue = new Map<string, Cents>()
  for (const sm of stockMoves) {
    if (sm.reason !== 'purchase' || !sm.refId) continue
    const cost = costOf(byId, sm.productId, 0)
    purchaseValue.set(sm.refId, (purchaseValue.get(sm.refId) ?? 0) + sm.delta * cost)
  }
  for (const [refId, paid] of purchasePaid) {
    const booked = purchaseValue.get(refId) ?? 0
    add(ACCOUNTS.INVENTORY, booked)
    // Positive when you paid more than you booked (a loss), negative when you
    // paid less (a bargain).
    add(ACCOUNTS.PURCHASE_VARIANCE, paid - booked)
  }

  for (const sm of stockMoves) {
    if (sm.reason === 'purchase') continue
    const cost = costOf(byId, sm.productId, 0)
    const w = sm.delta * cost
    if (sm.reason === 'import' || sm.reason === 'opening') {
      add(ACCOUNTS.INVENTORY, w)
      add(ACCOUNTS.CONTRIBUTED, -w)
    } else if (sm.reason === 'adjust') {
      add(ACCOUNTS.INVENTORY, w)
      add(ACCOUNTS.STOCK_ADJUST, -w)
    }
    // 'sale' and 'void' stock movements are the mirror of the cash columns;
    // inventory value is tracked through the completed-lines depletions above
    // and the products table, so they need no extra legs.
  }

  const rows: TrialBalanceRow[] = []
  for (const [account, balance] of b) {
    if (balance === 0) continue

    rows.push({ account, name: ACCOUNT_NAMES[account] ?? `Account ${account}`, balance })
  }
  rows.sort((a, z) => a.account - z.account)

  const difference = rows.reduce((s, r) => s + r.balance, 0)
  return { rows, difference }
}

export interface CashFlowStatement {
  /** Balance before the window (the ledger is one running figure). */
  opening: Cents
  /** Net cash received from sales in the window (refunds already taken out). */
  operatingIn: Cents
  operatingOut: Cents
  financingIn: Cents
  financingOut: Cents
  net: Cents
  /** Opening + net; must equal the drawer balance now. */
  closing: Cents
}

/**
 * The statement of cash flows for a window of business dates, classified the
 * standard way: selling stock and paying for it and expenses are operating;
 * putting money in, borrowing and repaying, and the owner taking cash are
 * financing.
 */
export function cashFlow(movements: CashMovement[], dates?: string[]): CashFlowStatement {
  const window = dates?.length
    ? movements.filter((m) => dates.includes(m.businessDate))
    : movements

  // Net cash from sales: a sale goes in, a refund (void) comes straight back
  // out, so a refunded sale contributes nothing here.
  const salesIn = window
    .filter((m) => m.reason === 'sale' || m.reason === 'void')
    .reduce((s, m) => s + m.delta, 0)
  const operatingOut = -(
    window.filter((m) => m.reason === 'purchase' || m.reason === 'expense').reduce((s, m) => s + m.delta, 0) || 0
  )
  const financingIn = window
    .filter((m) => m.reason === 'float' || m.reason === 'cash_in')
    .reduce((s, m) => s + m.delta, 0)
  const financingOut = -(
    window.filter((m) => m.reason === 'drawing' || m.reason === 'loan_repay').reduce((s, m) => s + m.delta, 0) || 0
  )

  const allTime = movements.reduce((s, m) => s + m.delta, 0)
  const opening = allTime - window.reduce((s, m) => s + m.delta, 0)
  const net = salesIn - operatingOut + financingIn - financingOut

  return {
    opening,
    operatingIn: salesIn,
    operatingOut,
    financingIn,
    financingOut,
    net,
    closing: opening + net,
  }
}

export interface IncomeStatement {
  /** Gross sales billed in the window, including sales later refunded. */
  revenue: Cents
  /** Absolute value of refunds handed back in the window (voided sales). */
  returns: Cents
  netRevenue: Cents
  cogs: Cents
  grossProfit: Cents
  /**
   * Purchase price differences in the window. Positive when you paid more than
   * you booked (a loss), negative when you paid less (a bargain).
   */
  purchaseVariance: Cents
  /** Signed stock-take difference: positive = stock lost, negative = found. */
  stockAdjust: Cents
  expenses: Cents
  netProfit: Cents
  saleCount: number
  itemsSold: number
}

/** The P&L for a window of business dates (or all time when none given). */
export function incomeStatement(
  sales: Sale[],
  lines: SaleLine[],
  products: Product[],
  cash: CashMovement[],
  dates?: string[],
  stockMoves?: StockMovement[],
): IncomeStatement {
  const inWindow = dates?.length ? (d: string) => dates.includes(d) : () => true
  const byId = new Map(products.map((p) => [p.id, p]))

  const windowed = sales.filter((s) => inWindow(s.businessDate))
  const completed = windowed.filter((s) => s.status === 'completed')
  const saleIds = new Set(completed.map((s) => s.id))
  const used = lines.filter((l) => saleIds.has(l.saleId))

  // Gross revenue bills every sale, including the ones later refunded; the
  // refunds line (from the cash void movements below) reverses them. That
  // mirrors the postings — a sale and its void cancel on the trial balance —
  // so a sale refunded in full nets to zero profit instead of a phantom loss.
  // Cost of goods sold and the item count only look at completed sales, whose
  // stock actually left the shelf and came back with the void.
  const revenue = windowed.reduce((s, x) => s + x.total, 0)
  const cogs = used.reduce(
    (s, l) => s + l.qty * costOf(byId, l.productId, l.unitPrice),
    0,
  )
  const returns = -(
    cash.filter((m) => m.reason === 'void' && inWindow(m.businessDate)).reduce((s, m) => s + m.delta, 0) || 0
  )
  const expenses = -(
    cash
      .filter((m) => m.reason === 'expense' && inWindow(m.businessDate))
      .reduce((s, m) => s + m.delta, 0) || 0
  )

  // Purchase variance: what each purchase payment booked minus what was paid.
  // Stock adjustments: signed shelf losses from stock takes.
  let purchaseVariance: Cents = 0
  let stockAdjust: Cents = 0
  if (stockMoves) {
    const range = windowMillis(dates)
    const paid = new Map<string, Cents>()
    const booked = new Map<string, Cents>()
    for (const m of cash) {
      if (m.reason === 'purchase' && inWindow(m.businessDate)) {
        paid.set(m.id, Math.abs(m.delta))
      }
    }
    for (const sm of stockMoves) {
      if (sm.reason !== 'purchase' || !sm.refId) continue
      booked.set(sm.refId, (booked.get(sm.refId) ?? 0) + sm.delta * costOf(byId, sm.productId, 0))
    }
    for (const [refId, p] of paid) {
      purchaseVariance += (booked.get(refId) ?? 0) - p
    }
    stockAdjust = stockMoves
      .filter((sm) => sm.reason === 'adjust' && inRange(sm.createdAt, range))
      .reduce((s, sm) => s - sm.delta * costOf(byId, sm.productId, 0), 0)
  }

  const netRevenue = revenue - returns
  const netProfit = netRevenue - cogs - expenses + purchaseVariance - stockAdjust

  return {
    revenue,
    returns,
    netRevenue,
    cogs,
    grossProfit: netRevenue - cogs,
    purchaseVariance,
    stockAdjust,
    expenses,
    netProfit,
    saleCount: completed.length,
    itemsSold: used.reduce((s, l) => s + l.qty, 0),
  }
}

export interface BalanceSheet {
  cash: Cents
  stockValue: Cents
  totalAssets: Cents
  /** Outstanding loans: borrowed minus repaid. */
  loans: Cents
  /** Net opening float + own money put in, all time. */
  capitalIn: Cents
  contributedStock: Cents
  /** All-time net profit, including purchase variance and stock adjustments. */
  retainedProfit: Cents
  drawings: Cents
  totalEquity: Cents
  /**
   * Assets minus (loans + equity). Zero means the tin and the shelf agree with
   * the books to the tambala. A non-zero figure is unposted movement — usually
   * a cost revaluation made straight on a product.
   */
  check: Cents
}

/** The position right now: assets on one side, loans and equity on the other. */
export function balanceSheet(
  cash: CashMovement[],
  products: Product[],
  stockMoves: StockMovement[],
  sales: Sale[],
  lines: SaleLine[],
): BalanceSheet {
  const byId = new Map(products.map((p) => [p.id, p]))

  const cashTotal = cash.reduce((s, m) => s + m.delta, 0)
  const stockValue = products.reduce((s, p) => s + p.stockQty * (p.cost ?? p.price), 0)

  const loans = cash
    .filter((m) => (m.reason === 'cash_in' && m.kind === 'loan') || m.reason === 'loan_repay')
    .reduce((s, m) => s + m.delta, 0)

  const capitalIn = cash
    .filter(
      (m) =>
        (m.reason === 'float' ||
          (m.reason === 'cash_in' && m.kind !== 'loan')) ,
    )
    .reduce((s, m) => s + m.delta, 0)

  const contributedStock = stockMoves
    .filter((m) => m.reason === 'opening' || m.reason === 'import')
    .reduce((s, m) => s + m.delta * costOf(byId, m.productId, 0), 0)

  const allTime = incomeStatement(sales, lines, products, cash, undefined, stockMoves)
  const drawings = cash
    .filter((m) => m.reason === 'drawing')
    .reduce((s, m) => s + m.delta, 0)

  const totalEquity = capitalIn + contributedStock + allTime.netProfit + drawings

  return {
    cash: cashTotal,
    stockValue,
    totalAssets: cashTotal + stockValue,
    loans,
    capitalIn,
    contributedStock,
    retainedProfit: allTime.netProfit,
    drawings,
    totalEquity,
    check: cashTotal + stockValue - (loans + totalEquity),
  }
}

/** [start, end) milliseconds for a set of business dates, or null for all time. */
export function windowMillis(dates?: string[]): [number, number] | null {
  if (!dates?.length) return null
  const sorted = [...dates].sort()
  const start = new Date(`${sorted[0]}T00:00:00`).getTime()
  const end = new Date(`${sorted[sorted.length - 1]}T00:00:00`).getTime() + 86_400_000
  return [start, end]
}

function inRange(t: number, range: [number, number] | null): boolean {
  return range === null || (t >= range[0] && t < range[1])
}