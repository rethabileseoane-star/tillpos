import type {
  CashMovement,
  CashReason,
  Product,
  Sale,
  SaleLine,
  StockMovement,
  StockReason,
  TabEntry,
} from '@/db/types'
import type { Cents } from '@/domain/money'
import { outstandingCredit } from '@/features/credit/credit'
import { ACCOUNT_NAMES, ACCOUNTS } from '@/features/ledger/chart'
import { buildJournal, journalBalances } from '@/features/ledger/journal'

export { ACCOUNT_NAMES, ACCOUNTS } from '@/features/ledger/chart'

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
  credit_payment: 'Credit payment',
  tab_credit: 'Tab credit (cash in)',
  tab_payout: 'Tab paid out',
}

export const STOCK_REASON_LABEL: Record<StockReason, string> = {
  sale: 'Sale',
  void: 'Void return',
  import: 'Import',
  adjust: 'Stock take',
  opening: 'Opening stock',
  purchase: 'Bought stock',
}

/** Keep a zero a plain 0, never the -0 that a negated balance can produce. */
function normalize(value: Cents): Cents {
  return value === 0 ? 0 : value
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
 * Account balances from the posting journal. Every event posts balanced legs,
 * so `difference` (the sum of all balances) is zero whenever every event is
 * linked. A non-zero difference is an orphan movement — for example a cash row
 * whose sale or tab entry is not on this device yet.
 */
export function trialBalances(
  sales: Sale[],
  lines: SaleLine[],
  cash: CashMovement[],
  products: Product[],
  stockMoves: StockMovement[],
  tabEntries: readonly TabEntry[] = [],
): { rows: TrialBalanceRow[]; difference: Cents } {
  const journal = buildJournal({ sales, lines, cash, products, stockMoves, tabEntries })
  const balances = journalBalances(journal.entries)

  const rows: TrialBalanceRow[] = []
  for (const [account, balance] of balances) {
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
  /** Cash left with the shop for customer tabs. */
  tabIn: Cents
  /** Cash returned to customers from tabs. */
  tabOut: Cents
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

  // Net cash from selling: a cash sale goes in, a credit collection goes in
  // when it is received, and a refund (void) comes straight back out. A credit
  // sale with no deposit contributes nothing here, because no cash moved.
  const salesIn = window
    .filter(
      (m) =>
        m.reason === 'sale' ||
        m.reason === 'void' ||
        m.reason === 'credit_payment',
    )
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
  const tabIn = window
    .filter((m) => m.reason === 'tab_credit')
    .reduce((s, m) => s + m.delta, 0)
  const tabOut = -(
    window
      .filter((m) => m.reason === 'tab_payout')
      .reduce((s, m) => s + m.delta, 0) || 0
  )

  const allTime = movements.reduce((s, m) => s + m.delta, 0)
  const opening = allTime - window.reduce((s, m) => s + m.delta, 0)
  const net = salesIn - operatingOut + financingIn - financingOut + tabIn - tabOut

  return {
    opening,
    operatingIn: salesIn,
    operatingOut,
    financingIn,
    financingOut,
    tabIn,
    tabOut,
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
   * Purchase price differences in the window. Positive when you paid less than
   * the stock was booked at (a bargain), negative when you paid more (a loss).
   */
  purchaseVariance: Cents
  /** Signed stock-take difference: positive = stock lost, negative = found. */
  stockAdjust: Cents
  expenses: Cents
  /** Unpaid credit balances written off in the window. */
  badDebts: Cents
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
  const windowed = dates?.length
    ? sales.filter((sale) => dates.includes(sale.businessDate))
    : sales
  const completed = windowed.filter((sale) => sale.status === 'completed')
  const saleIds = new Set(completed.map((sale) => sale.id))
  const used = lines.filter((line) => saleIds.has(line.saleId))

  // The P&L is a view of the same journal the trial balance uses, filtered by
  // business date. Nothing here re-derives revenue or cost from the rows.
  const journal = buildJournal({
    sales,
    lines,
    cash,
    products,
    stockMoves: stockMoves ?? [],
  })
  const windowedEntries = dates?.length
    ? journal.entries.filter((journalEntry) => dates.includes(journalEntry.date))
    : journal.entries

  const accountTotal = (account: number, entries = windowedEntries): Cents =>
    entries.reduce(
      (total, journalEntry) =>
        total +
        journalEntry.postings.reduce(
          (entryTotal, posting) =>
            posting.account === account ? entryTotal + posting.amount : entryTotal,
          0,
        ),
      0,
    )

  const revenue = normalize(-accountTotal(ACCOUNTS.SALES))
  const returns = normalize(accountTotal(ACCOUNTS.RETURNS))
  const cogs = normalize(accountTotal(ACCOUNTS.COGS))
  const expenses = normalize(accountTotal(ACCOUNTS.EXPENSES))
  const badDebts = normalize(accountTotal(ACCOUNTS.BAD_DEBTS))
  // The journal stores paid-minus-booked; the P&L reports the gain the other
  // way round, so a bargain is positive. Without stock movements there is no
  // booking to compare a payment against, so the variance stays zero.
  const purchaseVariance = stockMoves
    ? normalize(-accountTotal(ACCOUNTS.PURCHASE_VARIANCE))
    : 0
  // Stock takes are filtered by their source timestamp, matching the day the
  // adjustment was recorded even if its business date is edited.
  const stockAdjust = normalize(
    accountTotal(
      ACCOUNTS.STOCK_ADJUST,
      journal.entries.filter(
        (journalEntry) =>
          journalEntry.kind === 'stock' &&
          journalEntry.meta?.reason === 'adjust' &&
          inRange(journalEntry.createdAt, windowMillis(dates)),
      ),
    ),
  )

  const netRevenue = normalize(revenue - returns)
  const netProfit = normalize(
    netRevenue - cogs - expenses - badDebts + purchaseVariance - stockAdjust,
  )

  return {
    revenue,
    returns,
    netRevenue,
    cogs,
    grossProfit: netRevenue - cogs,
    purchaseVariance,
    stockAdjust,
    expenses,
    badDebts,
    netProfit,
    saleCount: completed.length,
    itemsSold: used.reduce((s, line) => s + line.qty, 0),
  }
}

export interface BalanceSheet {
  cash: Cents
  stockValue: Cents
  /** Credit sales still owed by customers, after payments and write-offs. */
  receivables: Cents
  totalAssets: Cents
  /** Outstanding loans: borrowed minus repaid. */
  loans: Cents
  /**
   * Cash held for customers after an overpayment, a late payment on a voided
   * sale, a payment that arrived before its sale, or a customer tab. Positive =
   * owed back.
   */
  customerCredits: Cents
  /** Net opening float + own money put in, all time. */
  capitalIn: Cents
  contributedStock: Cents
  /** All-time net profit, including purchase variance and stock adjustments. */
  retainedProfit: Cents
  drawings: Cents
  totalEquity: Cents
  /**
   * Assets minus (loans + customer credits + equity). Zero means the tin and
   * the shelf agree with the books to the tambala. A non-zero figure is
   * unposted movement — usually a cost revaluation made straight on a product.
   */
  check: Cents
}

/** The position right now: assets against liabilities and owner's equity. */
export function balanceSheet(
  cash: CashMovement[],
  products: Product[],
  stockMoves: StockMovement[],
  sales: Sale[],
  lines: SaleLine[],
  tabBalance: Cents = 0,
): BalanceSheet {
  // Read every balance from the same journal as the trial balance and P&L.
  // Stock value still comes from the shelf count because a cost edit made
  // straight on a product is exactly the unposted movement the `check` line is
  // there to expose.
  const journal = buildJournal({ sales, lines, cash, products, stockMoves })
  const balances = journalBalances(journal.entries)
  const balance = (account: number): Cents => balances.get(account) ?? 0

  const cashTotal = normalize(balance(ACCOUNTS.CASH))
  const stockValue = normalize(
    products.reduce((s, p) => s + p.stockQty * (p.cost ?? p.price), 0),
  )
  const receivables = normalize(balance(ACCOUNTS.RECEIVABLES))
  const loans = normalize(-balance(ACCOUNTS.LOANS))
  const capitalIn = normalize(-balance(ACCOUNTS.CAPITAL))
  const contributedStock = normalize(-balance(ACCOUNTS.CONTRIBUTED))
  const drawings = normalize(-balance(ACCOUNTS.DRAWINGS))
  const retainedProfit = normalize(
    -(
      balance(ACCOUNTS.SALES) +
      balance(ACCOUNTS.RETURNS) +
      balance(ACCOUNTS.COGS) +
      balance(ACCOUNTS.EXPENSES) +
      balance(ACCOUNTS.BAD_DEBTS) +
      balance(ACCOUNTS.PURCHASE_VARIANCE) +
      balance(ACCOUNTS.STOCK_ADJUST)
    ),
  )

  const totalEquity = normalize(
    capitalIn + contributedStock + retainedProfit + drawings,
  )
  const customerCredits = normalize(
    -balance(ACCOUNTS.CUSTOMER_CREDITS) + tabBalance,
  )

  return {
    cash: cashTotal,
    stockValue,
    receivables,
    totalAssets: normalize(cashTotal + stockValue + receivables),
    loans,
    customerCredits,
    capitalIn,
    contributedStock,
    retainedProfit,
    drawings,
    totalEquity,
    check: normalize(
      cashTotal +
        stockValue +
        receivables -
        (loans + customerCredits + totalEquity),
    ),
  }
}

/**
 * Credit still owed by customers: every completed credit sale's total, less
 * money received and less anything written off. Voided sales owe nothing.
 * This is the same figure the trial balance carries on account 1300.
 */
export function outstandingReceivables(sales: Sale[], cash: CashMovement[]): Cents {
  return outstandingCredit(sales, cash)
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