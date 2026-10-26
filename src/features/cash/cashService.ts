import { db, withSyncMeta } from '@/db'
import type { CashInKind, CashMovement, CashReason, Product, StockMovement } from '@/db/types'
import type { Cents } from '@/domain/money'
import { businessDate } from '@/features/sales/salesService'
import { queueEntity } from '@/sync/outbox'

/**
 * The cash drawer.
 *
 * Sales and voids already append their own rows from inside the sale
 * transaction (so a sale and its cash can never disagree). This module covers
 * the movements a person makes by hand: the opening float, money in (own money
 * or a loan), buying stock, the owner taking cash, paying an expense, and
 * repaying a loan. They stay separate types so the books can split them later.
 */

/** Append one drawer movement. A zero delta would be ledger noise, so skip it. */
async function append(
  reason: CashReason,
  delta: Cents,
  note: string,
  kind?: CashInKind,
): Promise<void> {
  if (delta === 0) return
  const movement = withSyncMeta(undefined, {
    reason,
    delta,
    refId: null,
    kind,
    businessDate: businessDate(),
    note,
  }) as CashMovement
  await db.transaction('rw', db.cashMovements, db.outbox, async () => {
    await db.cashMovements.put(movement)
    await queueEntity('cash_movements', movement.id, 'upsert', movement)
  })
}

/**
 * Extra cash put into the drawer: the owner's own money (capital) or borrowed
 * money (a loan). Own money grows equity; a loan grows the liability on the
 * balance sheet.
 */
export function recordCashIn(
  amount: Cents,
  note = 'Money in',
  kind: CashInKind = 'capital',
): Promise<void> {
  return append('cash_in', Math.abs(amount), note, kind)
}

/** The owner takes money out of the drawer, e.g. for home or to bank. */
export function recordDrawing(amount: Cents, note = 'Owner took'): Promise<void> {
  return append('drawing', -Math.abs(amount), note)
}

/** An expense paid from the drawer: rent, transport, electricity... */
export function recordExpense(amount: Cents, note = 'Paid out'): Promise<void> {
  return append('expense', -Math.abs(amount), note)
}

/**
 * Paying back a loan from the drawer. Refuses more than what is outstanding,
 * so the liability can never go negative.
 */
export async function recordLoanRepay(amount: Cents, note = 'Loan repaid'): Promise<void> {
  if (!(amount > 0)) throw new Error('Enter an amount greater than zero')
  const owed = await outstandingLoans()
  if (amount > owed) {
    throw new Error(`Only ${(owed / 100).toFixed(2)} Maluti of loans is outstanding`)
  }
  await append('loan_repay', -Math.abs(amount), note)
}

/** What the shop still owes: borrowed money in minus repayments. */
export async function outstandingLoans(): Promise<Cents> {
  const all = await db.cashMovements.toArray()
  const borrowed = all
    .filter((m) => m.reason === 'cash_in' && m.kind === 'loan')
    .reduce((s, m) => s + m.delta, 0)
  const repaid = all
    .filter((m) => m.reason === 'loan_repay')
    .reduce((s, m) => s + m.delta, 0)
  return borrowed + repaid
}

/**
 * Set the opening float to an exact figure.
 *
 * Recorded as a movement so the ledger still explains the balance, but adjusted
 * by the difference rather than appended blindly — setting M100 twice must not
 * invent a second M100.
 */
export async function setOpeningFloat(amount: Cents, note = 'Opening float'): Promise<void> {
  const floats = await db.cashMovements.where('reason').equals('float').toArray()
  const current = floats.reduce((s, m) => s + m.delta, 0)
  await append('float', amount - current, note)
}

/** Cash in the drawer right now: the sum of every movement, ever. */
export async function cashBalance(): Promise<Cents> {
  const all = await db.cashMovements.toArray()
  return all.reduce((s, m) => s + m.delta, 0)
}

export interface PurchaseItem {
  productId: string
  qty: number
}

/**
 * Buying stock: money leaves the drawer once and each product's quantity goes
 * up. One transaction, so the cash movement and every stock movement either
 * all land or none do. Each stock row points at the cash movement via `refId`,
 * which lets the Money tab show "Gum x10, bread x4" under the payment later.
 */
export async function buyStock(items: PurchaseItem[], amountPaid: Cents, note = ''): Promise<void> {
  const merged = new Map<string, number>()
  for (const item of items) {
    if (item.productId && item.qty > 0) merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.qty)
  }
  if (merged.size === 0) throw new Error('Add at least one item')
  if (!(amountPaid > 0)) throw new Error('Enter the amount you paid')

  await db.transaction('rw', [db.cashMovements, db.stockMovements, db.products, db.outbox], async () => {
    const text = note.trim() || 'Bought stock'
    const cash = withSyncMeta(undefined, {
      reason: 'purchase' as const,
      delta: -Math.abs(amountPaid),
      refId: null,
      businessDate: businessDate(),
      note: text,
    }) as CashMovement
    await db.cashMovements.put(cash)
    await queueEntity('cash_movements', cash.id, 'upsert', cash)

    for (const [productId, qty] of merged) {
      const product: Product | undefined = await db.products.get(productId)
      if (!product) continue
      const movement = withSyncMeta(undefined, {
        productId,
        delta: qty,
        reason: 'purchase' as const,
        refId: cash.id,
        note: text,
      }) as StockMovement
      await db.stockMovements.put(movement)
      await queueEntity('stock_movements', movement.id, 'upsert', movement)
      await db.products.update(productId, {
        stockQty: (product.stockQty ?? 0) + qty,
        updatedAt: Date.now(),
      })
    }
  })
}

export interface CashSummary {
  openingFloat: Cents
  /** Cash taken at the till on cash sales. */
  sales: Cents
  /** Cash collected against credit sales (deposits and later payments). */
  creditPayments: Cents
  voids: Cents
  cashIn: Cents
  purchases: Cents
  drawings: Cents
  expenses: Cents
  /** Cash leaving the drawer to repay loans, in the window. */
  loanRepay: Cents
  /** What the shop still owes, all time. */
  loans: Cents
  /** All-time drawer balance. The drawer is one running figure, not per-day. */
  balance: Cents
}

/** Money broken down for a report window of business dates. */
export function summariseCash(movements: CashMovement[], dates?: string[]): CashSummary {
  const window = dates?.length
    ? movements.filter((m) => dates.includes(m.businessDate))
    : movements
  const of = (reason: CashReason) =>
    window.filter((m) => m.reason === reason).reduce((s, m) => s + m.delta, 0)
  const loans = movements
    .filter((m) => (m.reason === 'cash_in' && m.kind === 'loan') || m.reason === 'loan_repay')
    .reduce((s, m) => s + m.delta, 0)

  return {
    openingFloat: of('float'),
    sales: of('sale'),
    creditPayments: of('credit_payment'),
    voids: of('void'),
    cashIn: of('cash_in'),
    purchases: of('purchase'),
    drawings: of('drawing'),
    expenses: of('expense'),
    loanRepay: of('loan_repay'),
    loans,
    balance: movements.reduce((s, m) => s + m.delta, 0),
  }
}