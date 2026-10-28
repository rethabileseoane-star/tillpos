import type { CashMovement, Sale } from '@/db/types'
import type { Cents } from '@/domain/money'

/**
 * Credit-sale arithmetic, kept pure so the till screen, the journals and the
 * trial balance all answer "what is still owed?" the same way.
 *
 * A credit sale is revenue when the goods leave. Money received later is a
 * `credit_payment` cash movement pointing at the sale; it reduces the
 * receivable but never adds revenue a second time. A write-off removes the
 * remaining balance as a bad-debt expense without touching the drawer.
 */

export type CreditState = 'open' | 'part-paid' | 'paid' | 'written-off' | 'voided'

export const CREDIT_STATE_LABEL: Record<CreditState, string> = {
  open: 'Open',
  'part-paid': 'Part-paid',
  paid: 'Paid',
  'written-off': 'Written off',
  voided: 'Voided',
}

/** Sum of every payment received against each credit sale. */
export function creditPaidMap(cash: readonly CashMovement[]): Map<string, Cents> {
  const paid = new Map<string, Cents>()
  for (const m of cash) {
    if (m.reason !== 'credit_payment' || !m.refId) continue
    paid.set(m.refId, (paid.get(m.refId) ?? 0) + m.delta)
  }
  return paid
}

/** What this sale still owes, never below zero. Voided debts owe nothing. */
export function creditBalance(sale: Sale, paid: Map<string, Cents>): Cents {
  if (sale.paymentMethod !== 'credit' || sale.status !== 'completed') return 0
  const received = paid.get(sale.id) ?? 0
  const written = sale.writtenOffAmount ?? 0
  return Math.max(0, sale.total - received - written)
}

/**
 * The bad-debt loss after every payment, including a payment that reaches this
 * device after another till wrote the sale off. The stored write-off amount is
 * the historical decision; payments can never make the loss bigger than the
 * money that was actually outstanding, so the books cap it here. This is what
 * keeps a late recovery from double-counting the loss and unbalancing the
 * balance sheet.
 */
export function effectiveWriteOffAmount(sale: Sale, paid: Cents): Cents {
  if (sale.paymentMethod !== 'credit' || sale.status !== 'completed') return 0
  const written = sale.writtenOffAmount ?? 0
  if (!(written > 0)) return 0
  return Math.min(written, Math.max(0, sale.total - paid))
}

export function creditState(sale: Sale, paid: Map<string, Cents>): CreditState {
  if (sale.status === 'voided') return 'voided'
  if (sale.paymentMethod !== 'credit') return 'paid'
  const received = paid.get(sale.id) ?? 0
  if (effectiveWriteOffAmount(sale, received) > 0 && creditBalance(sale, paid) === 0) {
    return 'written-off'
  }
  const balance = creditBalance(sale, paid)
  if (balance === 0) return 'paid'
  return received > 0 ? 'part-paid' : 'open'
}

export interface CreditRow {
  sale: Sale
  paid: Cents
  balance: Cents
  state: CreditState
}

/** Every credit sale with the figures the journals and the debt book need. */
export function creditRows(sales: readonly Sale[], cash: readonly CashMovement[]): CreditRow[] {
  const paid = creditPaidMap(cash)
  return sales
    .filter((sale) => sale.paymentMethod === 'credit')
    .map((sale) => ({
      sale,
      paid: paid.get(sale.id) ?? 0,
      balance: creditBalance(sale, paid),
      state: creditState(sale, paid),
    }))
}

/** Credit sales that still owe something, oldest first — the debt book. */
export function outstandingCreditRows(
  sales: readonly Sale[],
  cash: readonly CashMovement[],
): CreditRow[] {
  return creditRows(sales, cash)
    .filter((row) => row.balance > 0 && row.sale.status === 'completed')
    .sort(
      (a, b) =>
        a.sale.businessDate.localeCompare(b.sale.businessDate) ||
        a.sale.createdAt - b.sale.createdAt,
    )
}

/** The total owed by customers right now. */
export function outstandingCredit(
  sales: readonly Sale[],
  cash: readonly CashMovement[],
): Cents {
  return outstandingCreditRows(sales, cash).reduce((sum, row) => sum + row.balance, 0)
}

export interface CustomerCreditTotals {
  /** Cash held because a completed credit sale was paid more than once. */
  overpayments: Cents
  /** Payments on voided sales that no refund has returned to the customer. */
  unrefundedVoids: Cents
  /** Credit payments that do not point at a known credit sale. */
  unattached: Cents
  /** Signed total: positive means the shop owes the customer. */
  total: Cents
}

/**
 * Cash the shop is holding for customers rather than for itself.
 *
 * Two tills can collect the same balance before they sync, a payment can reach
 * the till after another till voided the sale, and a pull can deliver a payment
 * before its sale. In each case the drawer has real cash but the customer is
 * owed it back. Calling this a negative receivable would make the balance sheet
 * lose the amount, so it is a customer-credit liability. A negative total is an
 * over-refund: the customer owes the shop instead.
 */
export function customerCreditTotals(
  sales: readonly Sale[],
  cash: readonly CashMovement[],
): CustomerCreditTotals {
  const saleById = new Map(sales.map((s) => [s.id, s]))
  const paid = creditPaidMap(cash)
  const refunded = new Map<string, Cents>()
  for (const m of cash) {
    if (m.reason !== 'void' || !m.refId) continue
    // Void movements are negative; store the refund as a positive amount.
    refunded.set(m.refId, (refunded.get(m.refId) ?? 0) - m.delta)
  }

  let overpayments: Cents = 0
  let unrefundedVoids: Cents = 0
  let unattached: Cents = 0
  for (const [saleId, received] of paid) {
    const sale = saleById.get(saleId)
    if (!sale || sale.paymentMethod !== 'credit') {
      unattached += received
      continue
    }
    if (sale.status === 'completed') {
      overpayments += Math.max(0, received - sale.total)
    } else if (sale.status === 'voided') {
      unrefundedVoids += received - (refunded.get(saleId) ?? 0)
    }
  }
  return {
    overpayments,
    unrefundedVoids,
    unattached,
    total: overpayments + unrefundedVoids + unattached,
  }
}

/** Local calendar day as YYYY-MM-DD, matching the till's business date. */
export function localBusinessDate(timestamp: number): string {
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** The day a write-off was posted, falling back to its timestamp. */
export function writeOffDate(sale: Sale): string | null {
  if (sale.writeOffDate) return sale.writeOffDate
  if (sale.writtenOffAt) return localBusinessDate(sale.writtenOffAt)
  return null
}

export interface CreditTotals {
  /** Credit sales billed in the window (completed only). */
  creditSales: Cents
  /** Cash collected against credit sales in the window, including deposits. */
  collected: Cents
  /** Bad debts written off in the window, net of later recoveries. */
  writtenOff: Cents
  /** All-time balance still owed by customers. */
  outstanding: Cents
  /** How many credit sales are still open or part-paid. */
  debtorCount: number
}

/**
 * The figures shared by the Z-report, the CSV export and the books pack.
 * `dates` filters sales by their business date and payments/write-offs by the
 * day they happened; outstanding is always the position right now.
 */
export function creditTotals(
  sales: readonly Sale[],
  cash: readonly CashMovement[],
  dates?: string[],
): CreditTotals {
  const inWindow = dates?.length ? (d: string) => dates.includes(d) : () => true
  const rows = creditRows(sales, cash)
  const outstandingRows = rows.filter(
    (row) => row.balance > 0 && row.sale.status === 'completed',
  )
  const writtenOff = rows
    .filter((row) => {
      const day = writeOffDate(row.sale)
      return (
        effectiveWriteOffAmount(row.sale, row.paid) > 0 &&
        day !== null &&
        inWindow(day)
      )
    })
    .reduce(
      (sum, row) => sum + effectiveWriteOffAmount(row.sale, row.paid),
      0,
    )

  return {
    creditSales: rows
      .filter(
        (row) => row.sale.status === 'completed' && inWindow(row.sale.businessDate),
      )
      .reduce((sum, row) => sum + row.sale.total, 0),
    collected: cash
      .filter((m) => m.reason === 'credit_payment' && inWindow(m.businessDate))
      .reduce((sum, m) => sum + m.delta, 0),
    writtenOff,
    outstanding: outstandingRows.reduce((sum, row) => sum + row.balance, 0),
    debtorCount: outstandingRows.length,
  }
}
